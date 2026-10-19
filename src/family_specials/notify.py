"""Phone notifications (Web Push), sent from the Mac after the weekly refresh. Free: Apple's and Google's push
services cost nothing. No other service or account.

  - Each phone opts in with the switch in Settings. The phone gets a subscription from its push service (Apple or
    Google) and shows it as a code. `specials notify add` (on the Mac) saves it in data/push/ (never in git) and
    copies the list to the PUSH_SUBSCRIPTIONS secret on GitHub.
  - After every data update, the Mac runs `specials notify run`: a notification when a watched item goes on
    special (at most one per item per specials week, Wednesday to Tuesday), plus a weekly digest once Woolworths has
    this week's prices. It reads the family watchlist built on the Mac (data/private/family-watchlist.json), because
    the watchlist is private since 19 Oct 2026. What was sent goes in data/private/notify-sent.csv (private too).
  - Notifications use shelf prices and the store's own was prices, like the app. They cover every store we have
    prices for (the store switches in Settings only change what the app shows on that phone).
"""

from __future__ import annotations

import base64
import csv
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from . import config
from .timeutil import SYDNEY, iso, now_utc, parse_iso, weekly_cycle

DEVICES_FILE = config.DATA_DIR / "push" / "devices.json"
SENT_FILE = config.PRIVATE_DIR / "notify-sent.csv"
WATCH_FILE = config.PRIVATE_DIR / "family-watchlist.json"   # written by `specials update` (watch_export)
PUBLIC_KEY_FILE = config.PROJECT_ROOT / "site" / "push.json"
SENT_FIELDS = ["sent_at", "cycle", "kind", "item_key", "chain", "alert_id"]
# Only the browsers' own push services. A code pointing anywhere else is refused.
PUSH_HOSTS = ("web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com", "notify.windows.com")
VAPID_SUBJECT = "https://marqueztandog7-del.github.io"   # who sends these pushes (our page; no email address)
MAX_SINGLE = 3              # more new items than this in one go -> one combined notification
TTL_SECONDS = 24 * 3600     # a phone that's off for longer than a day misses it (the app still shows it)
DIGEST_FALLBACK = timedelta(days=1, hours=18)   # Thursday 6pm: send the digest even if Woolworths hasn't updated


# ------------------------------------------------------------------ devices

def decode_code(code: str) -> dict[str, Any]:
    """The code a phone shows: base64url JSON {e: endpoint, k: {p256dh, auth}, n: name}."""
    text = "".join(code.split())
    try:
        raw = json.loads(base64.urlsafe_b64decode(text + "=" * (-len(text) % 4)))
    except ValueError as e:
        raise ValueError("That isn't a notification code from the app. Copy it again from Settings.") from e
    endpoint, keys = raw.get("e"), raw.get("k") or {}
    url = urlparse(endpoint or "")
    host = url.hostname or ""
    if url.scheme != "https" or not any(host == h or host.endswith("." + h) for h in PUSH_HOSTS):
        raise ValueError(f"Not a phone push service: {host or 'no address'}")
    if not (isinstance(keys.get("p256dh"), str) and isinstance(keys.get("auth"), str)):
        raise ValueError("The code is missing its keys. Copy it again from Settings.")
    name = str(raw.get("n") or "Phone").strip()[:40] or "Phone"
    return {"name": name, "endpoint": endpoint, "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]},
            "added": iso(now_utc())}


def service_name(endpoint: str) -> str:
    host = urlparse(endpoint).hostname or ""
    return "Apple" if "apple" in host else "Google" if "google" in host else "Mozilla" if "mozilla" in host else host


def load_devices() -> list[dict[str, Any]]:
    """On GitHub the list comes from the PUSH_SUBSCRIPTIONS secret; on the Mac from data/push/devices.json."""
    env = os.environ.get("PUSH_SUBSCRIPTIONS", "").strip()
    if env:
        return json.loads(env)
    if DEVICES_FILE.exists():
        return json.loads(DEVICES_FILE.read_text(encoding="utf-8"))
    return []


def save_devices(devices: list[dict[str, Any]]) -> None:
    DEVICES_FILE.parent.mkdir(parents=True, exist_ok=True)
    DEVICES_FILE.write_text(json.dumps(devices, indent=1), encoding="utf-8")
    config.set_github_secret("PUSH_SUBSCRIPTIONS", json.dumps(devices, separators=(",", ":")))


# ------------------------------------------------------------------ keys

def create_keys(force: bool = False) -> str:
    """Make the VAPID key pair: private key to .env and the GitHub secret, public key to site/push.json."""
    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid02, b64urlencode

    config.load_dotenv()
    if os.environ.get("VAPID_PRIVATE_KEY") and PUBLIC_KEY_FILE.exists() and not force:
        return json.loads(PUBLIC_KEY_FILE.read_text())["vapid_public_key"]
    v = Vapid02()
    v.generate_keys()
    private = b64urlencode(v.private_key.private_numbers().private_value.to_bytes(32, "big"))
    public = b64urlencode(v.public_key.public_bytes(serialization.Encoding.X962,
                                                    serialization.PublicFormat.UncompressedPoint))
    config.set_env("VAPID_PRIVATE_KEY", private)
    config.set_github_secret("VAPID_PRIVATE_KEY", private)
    PUBLIC_KEY_FILE.write_text(json.dumps({"vapid_public_key": public}) + "\n")
    return public


# ------------------------------------------------------------------ what to send

def _best_unit(o: dict[str, Any]) -> float | None:
    units = [u for u in (o.get("multibuy_unit_cents"), o.get("unit_cents")) if u is not None]
    return min(units) if units else None


def _sort_key(o: dict[str, Any]) -> tuple:
    u = _best_unit(o)
    return (u is None, u or 0, o["price_cents"] if o["price_cents"] is not None else 10**9)


def saving_cents(o: dict[str, Any]) -> int | None:
    """The same saving the app shows: the store's was price minus the price, or the multibuy saving."""
    if o["price_cents"] is None or o["price_per"] == "kg":
        return None
    if o.get("was_cents") and o["was_cents"] > o["price_cents"]:
        return o["was_cents"] - o["price_cents"]
    mb = o.get("multibuy")
    if mb and o["price_cents"] > mb["each_cents"]:
        return round((o["price_cents"] - mb["each_cents"]) * mb["qty"])
    return None


def special_rows(watch: dict[str, Any], paused: set[str]) -> list[dict[str, Any]]:
    """Each watch item on special: its best special overall, and its best special at each store."""
    rows = []
    for item in watch["items"]:
        specials = sorted((o for o in item["offers"] if o["special"] and o["chain"] not in paused), key=_sort_key)
        if not specials:
            continue
        per_chain: dict[str, dict] = {}
        for o in specials:
            per_chain.setdefault(o["chain"], o)
        rows.append({"item": item, "best": specials[0], "per_chain": per_chain})
    return rows


def alert_id(item: dict[str, Any], o: dict[str, Any]) -> str:
    """Matches the alert ids the app makes on the phone: item, store, when the special started, unit price."""
    since = (o.get("special_since") or o.get("seen_at") or "")[:10]
    unit = _best_unit(o)
    return f"{item['key']}|{o['chain']}|{since}|{round(unit if unit is not None else o['price_cents'])}"


def money(cents: float) -> str:
    return f"${cents / 100:.2f}"


def _ends(o: dict[str, Any]) -> str:
    if not o.get("valid_to"):
        return ""
    d = parse_iso(o["valid_to"]).astimezone(SYDNEY)
    return f" {'Usually ends' if o.get('valid_to_assumed') else 'Ends'} {d:%a} {d.day} {d:%b}."


def item_message(item: dict[str, Any], o: dict[str, Any]) -> dict[str, str]:
    kg = "/kg" if o["price_per"] == "kg" else ""
    promo = next((s["text"] for s in o.get("signals", []) if s["kind"] == "promo"), None) or o.get("promo")
    body = f"{o['store']}: {money(o['price_cents'])}{kg}"
    if o.get("was_cents"):
        body += f", was {money(o['was_cents'])}{kg}"
    if promo:
        body += f" ({promo})"
    return {"title": f"{item['name']} is on special", "body": body + "." + _ends(o),
            "url": f"#/watch/{item['key']}", "tag": f"item-{item['key']}"}


def _names(items: list[dict[str, Any]], limit: int = 4) -> str:
    names = [i["name"] for i in items]
    if len(names) <= limit:
        return ", ".join(names[:-1]) + (" and " if len(names) > 1 else "") + names[-1]
    return ", ".join(names[:limit]) + f" and {len(names) - limit} more"


def digest_message(rows: list[dict[str, Any]]) -> dict[str, str]:
    """The weekly summary: how many watched items are on special, the potential saving, the biggest savings."""
    if not rows:
        return {"title": "This week's specials", "body": "Nothing on your watchlist is on special this week.",
                "url": "#/home", "tag": "digest"}
    saved = sorted(((saving_cents(r["best"]), r["item"]) for r in rows if saving_cents(r["best"]) is not None),
                   key=lambda x: -x[0])
    body = f"{len(rows)} watched item{'s' if len(rows) != 1 else ''} on special"
    if saved:
        body += f", could save {money(sum(s for s, _ in saved))}. Biggest savings: "
        body += ", ".join(f"{i['name']} {money(s)}" for s, i in saved[:3])
    return {"title": "This week's specials", "body": body + ".", "url": "#/home", "tag": "digest"}


def plan(watch: dict[str, Any], status: dict[str, Any] | None, sent: list[dict[str, str]],
         now: datetime | None = None) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """What to send now, and the rows to add to sent.csv.

    One notification per watched item per specials week: the first time it goes on special that week. A special
    that was already told about (same store, start and price) never notifies again. Once a week, a digest; when it
    goes out with new items, it covers them instead of separate notifications.
    """
    now = now or now_utc()
    cycle_start = weekly_cycle(2, now)[0]
    cycle = cycle_start.date().isoformat()
    stores = {s["chain"]: s for s in (status or {}).get("stores", [])}
    paused = {c for c, s in stores.items() if s.get("updates_from") == "paused"}
    rows = special_rows(watch, paused)

    seen = {r["alert_id"] for r in sent}
    told_this_week = {r["item_key"] for r in sent if r["cycle"] == cycle and r["kind"] in ("item", "digest-item")}
    digest_sent = any(r["cycle"] == cycle and r["kind"] == "digest" for r in sent)
    stamp = iso(now)
    out_rows: list[dict[str, str]] = []
    to_tell: list[tuple[dict, dict]] = []
    for r in rows:
        item = r["item"]
        fresh = [o for o in r["per_chain"].values() if alert_id(item, o) not in seen]
        if not fresh:
            continue
        if item["key"] in told_this_week:      # already told this week: remember, but stay quiet
            out_rows += [_row(stamp, cycle, "seen", item, o) for o in fresh]
            continue
        fresh.sort(key=_sort_key)
        to_tell.append((item, fresh[0]))                      # its best new special
        out_rows += [_row(stamp, cycle, "seen", item, o) for o in fresh[1:]]

    woolworths = stores.get("woolworths", {}).get("last_updated")
    digest_due = not digest_sent and (
        (woolworths and parse_iso(woolworths) >= cycle_start) or now >= cycle_start + DIGEST_FALLBACK)

    messages: list[dict[str, str]] = []
    if digest_due:
        messages.append(digest_message(rows))
        out_rows.append({"sent_at": stamp, "cycle": cycle, "kind": "digest", "item_key": "", "chain": "", "alert_id": ""})
        out_rows += [_row(stamp, cycle, "digest-item", i, o) for i, o in to_tell]
    elif len(to_tell) > MAX_SINGLE:
        items = [i for i, _ in to_tell]
        messages.append({"title": f"{len(items)} watched items on special", "body": _names(items) + ".",
                         "url": "#/this-week", "tag": "specials"})
        out_rows += [_row(stamp, cycle, "item", i, o) for i, o in to_tell]
    else:
        for i, o in to_tell:
            messages.append(item_message(i, o))
            out_rows.append(_row(stamp, cycle, "item", i, o))
    return messages, out_rows


def _row(stamp: str, cycle: str, kind: str, item: dict[str, Any], o: dict[str, Any]) -> dict[str, str]:
    return {"sent_at": stamp, "cycle": cycle, "kind": kind, "item_key": item["key"], "chain": o["chain"],
            "alert_id": alert_id(item, o)}


def read_sent() -> list[dict[str, str]]:
    if not SENT_FILE.exists():
        return []
    with SENT_FILE.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def append_sent(rows: list[dict[str, str]]) -> None:
    if not rows:
        return
    SENT_FILE.parent.mkdir(parents=True, exist_ok=True)
    new = not SENT_FILE.exists()
    with SENT_FILE.open("a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=SENT_FIELDS)
        if new:
            w.writeheader()
        w.writerows(rows)


# ------------------------------------------------------------------ sending

def send(devices: list[dict[str, Any]], message: dict[str, str]) -> dict[str, list[dict[str, Any]]]:
    """Send one message to every phone. Returns which phones got it, which have gone (opted out), which failed."""
    from py_vapid import Vapid02
    from pywebpush import WebPushException, webpush

    vapid = Vapid02.from_raw(config.secret("VAPID_PRIVATE_KEY").encode())
    result: dict[str, list] = {"ok": [], "gone": [], "failed": []}
    payload = json.dumps(message, ensure_ascii=False)
    for d in devices:
        try:
            webpush({"endpoint": d["endpoint"], "keys": d["keys"]}, payload, vapid_private_key=vapid,
                    vapid_claims={"sub": VAPID_SUBJECT}, ttl=TTL_SECONDS, timeout=20, headers={"Urgency": "normal"})
            result["ok"].append(d)
        except WebPushException as e:
            code = e.response.status_code if e.response is not None else None
            result["gone" if code in (404, 410) else "failed"].append({**d, "error": f"{code or ''} {e.message}".strip()})
        except Exception as e:  # network trouble: try again next run
            result["failed"].append({**d, "error": str(e)})
    return result


def run(dry_run: bool = False) -> int:
    if not WATCH_FILE.exists():
        print("No family watchlist built yet (run: uv run specials update --no-collect).")
        return 0
    watch = json.loads(WATCH_FILE.read_text(encoding="utf-8"))
    status = json.loads((config.PROJECT_ROOT / "site" / "data" / "status.json").read_text(encoding="utf-8"))
    messages, rows = plan(watch, status, read_sent())
    if dry_run:
        for m in messages:
            print(f"Would send: {m['title']} | {m['body']}")
        print(f"{len(messages)} notification(s) due" if messages else "Nothing new to send.")
        return 0
    devices = load_devices()
    if not devices:
        print("No phones have turned on notifications yet, so nothing was sent (or recorded).")
        return 0
    if not messages:
        append_sent(rows)
        print("Nothing new to send.")
        return 0
    delivered = False
    gone: dict[str, str] = {}
    failed = 0
    for m in messages:
        r = send(devices, m)
        delivered |= bool(r["ok"])
        gone.update({d["endpoint"]: d["name"] for d in r["gone"]})
        failed += len(r["failed"])
        for d in r["failed"]:
            print(f"Couldn't reach {d['name']}: {d['error']}")
        print(f"Sent '{m['title']}' to {len(r['ok'])} of {len(devices)} phone(s)")
    if delivered or len(gone) == len(devices):
        append_sent(rows)          # recorded, so it's never sent twice
    for name in gone.values():
        print(f"{name} has turned notifications off. On the Mac: uv run specials notify devices, then remove it.")
    return 1 if failed and not delivered else 0
