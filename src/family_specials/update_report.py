"""A plain-English report each time the app's specials update (private: it names our Core and Regular items).

`specials update` writes one to data/reports/updates/ whenever the public specials changed or a store was read.
Each report has a .md (to read) and a .json (counts and special ids, so the next report can say what changed).
A scheduled task in the Claude app reads new reports and sends them on.

  uv run specials report            write (and print) a report on the latest update now
  uv run specials report --show     print the newest saved report
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import config
from .export import STORE_NAMES
from .runner import blocked_since_resume, is_paused_for_good
from .timeutil import SYDNEY, iso, now_utc, parse_iso, weekly_cycle

REPORTS = config.DATA_DIR / "reports" / "updates"
KIND_WORDS = {"specials": "specials", "range": "full range", "catalogue": "catalogue", "category": "categories"}
TYPE_WORDS = {"half_price": "half price", "multibuy": "multibuys", "online_only": "online-only", "special": "other specials",
              "special_buy": "Special Buys", "super_saver": "Super Savers", "costco_saving": "online savings",
              "costco_booklet": "warehouse booklet", "clearance": "clearance", "catalogue": "catalogue",
              "price_drop": "price drops"}


def _syd(ts: str | None) -> str:
    if not ts:
        return "never"
    d = parse_iso(ts).astimezone(SYDNEY)
    return d.strftime("%a %-d %b, %-I:%M%p").replace("AM", "am").replace("PM", "pm")


def _took(start: str, end: str | None) -> str:
    if not end:
        return "still running"
    s = int((parse_iso(end) - parse_iso(start)).total_seconds())
    return f"{s // 3600}h {s % 3600 // 60:02d}m" if s >= 3600 else f"{s // 60}m {s % 60:02d}s"


def _problem(conn: sqlite3.Connection, r: sqlite3.Row, cov: tuple) -> str:
    """One read that didn't finish, in plain words."""
    store, what = STORE_NAMES.get(r["chain"], r["chain"]), KIND_WORDS.get(r["kind"], r["kind"])
    why = (r["error"] or "").splitlines()[0] if r["error"] else ""
    if r["status"] == "blocked":
        return f"{store} {what}: the store REFUSED us ({why}). It's paused until you run `uv run specials resume {r['chain']}`."
    if r["status"] == "error":
        return f"{store} {what}: failed ({why[:120]}). The other stores weren't affected."
    out_of_requests = "budget" in why
    if r["chain"] == "woolworths" and r["kind"] == "range":
        skip = set((config.chain_config("woolworths").get("range") or {}).get("skip_departments") or [])
        aisles = sum(1 for (path,) in conn.execute(
            "SELECT path FROM store_categories WHERE chain = 'woolworths' AND path LIKE '%>%' AND path NOT LIKE '%>%>%'")
            if path.split(" > ")[0] not in skip)
        return (f"{store} {what}: partly done. It {'ran out of requests (' + format(r['requests_made'], ',') + ')' if out_of_requests else 'stopped'} "
                f"after {cov[1] or 0} of about {aisles} aisles, with {r['items_seen']:,} products read.")
    return (f"{store} {what}: partly done, {r['items_seen']:,} of {cov[3] or 0:,} products read"
            + (f" (it ran out of requests: {r['requests_made']:,})." if out_of_requests else "."))


def previous_snapshot() -> dict[str, Any] | None:
    files = sorted(REPORTS.glob("*.json"))
    return json.loads(files[-1].read_text(encoding="utf-8")) if files else None


def build(conn: sqlite3.Connection, now: datetime | None = None) -> tuple[str, dict[str, Any]]:
    """The report (markdown) and its snapshot."""
    now = now or now_utc()
    site = json.loads((config.PROJECT_ROOT / "site" / "data" / "specials.json").read_text(encoding="utf-8"))
    specials = site["specials"]
    watch_file = config.PRIVATE_DIR / "family-watchlist.json"
    watch = json.loads(watch_file.read_text(encoding="utf-8")) if watch_file.exists() else {"items": []}
    chains = [c for c in config.settings()["chains"]]
    prev = previous_snapshot()

    by_chain: dict[str, list[dict]] = {c: [] for c in chains}
    for s in specials:
        by_chain.setdefault(s["chain"], []).append(s)
    ids = {s["id"] for s in specials}
    prev_ids = set(prev["special_ids"]) if prev else None

    # Subtabs: each special counts once, in the highest group of the items it matches (as the app does).
    order = {"core": 0, "regular": 1}
    best: dict[str, tuple[str, str]] = {}
    for item in watch["items"]:
        for o in item["offers"]:
            if o.get("special") and (o["id"] not in best or order.get(item["tier"], 2) < order.get(best[o["id"]][0], 2)):
                best[o["id"]] = (item["tier"], item["name"])
    on_special = {t: sorted({i["name"] for i in watch["items"] if i["tier"] == t
                             and any(o.get("special") for o in i["offers"])}) for t in ("core", "regular")}
    tier_total = {t: sum(1 for i in watch["items"] if i["tier"] == t) for t in ("core", "regular")}
    tab = {t: sum(1 for v in best.values() if v[0] == t) for t in ("core", "regular")}
    core_by_store: dict[str, dict[str, int]] = {}
    for sid, (tier, _) in best.items():
        if tier in order:
            core_by_store.setdefault(tier, {}).setdefault(sid.split(":")[0], 0)
            core_by_store[tier][sid.split(":")[0]] += 1

    # This week's reads, per store.
    week = iso(weekly_cycle(2, now)[0])
    runs = conn.execute(
        """SELECT * FROM collection_runs WHERE started_at >= ? ORDER BY started_at""", (week,)).fetchall()
    last_read = conn.execute("SELECT MAX(started_at) FROM collection_runs WHERE status != 'running'").fetchone()[0]

    lines = [f"# Specials update: {_syd(iso(now))}", ""]
    if prev:
        new, gone = len(ids - prev_ids), len(prev_ids - ids)
        lines.append(f"Since the last report ({_syd(prev['at'])}): **{new:,} new specials**, **{gone:,} ended**.")
    lines += ["", "## Specials and products per store", "",
              "| Store | Specials now | Change | Kinds | Products in search |", "|---|---|---|---|---|"]
    prev_counts = (prev or {}).get("specials", {})
    product_counts = {r[0]: r[1] for r in conn.execute(
        "SELECT chain, COUNT(*) FROM retailer_products WHERE last_seen_at >= ? GROUP BY chain",
        (iso(now - timedelta(days=8)),))}
    for c in chains:
        cfg = config.chain_config(c)
        name = STORE_NAMES.get(c, c)
        if is_paused_for_good(conn, c) or not cfg.get("enabled", True):
            lines.append(f"| {name} | paused | | | |")
            continue
        n = len(by_chain.get(c, []))
        change = n - prev_counts[c] if c in prev_counts else None
        kinds: dict[str, int] = {}
        for s in by_chain.get(c, []):
            k = TYPE_WORDS.get(s.get("special_type") or "special", s.get("special_type") or "other")
            kinds[k] = kinds.get(k, 0) + 1
        kind_text = ", ".join(f"{v:,} {k}" for k, v in sorted(kinds.items(), key=lambda kv: -kv[1]))
        lines.append(f"| {name} | {n:,} | {'' if change is None else f'{change:+,}'} | {kind_text} | "
                     f"{product_counts.get(c, 0):,} |")

    lines += ["", "## This Week's subtabs (your family)", "",
              f"- **All specials:** {len(specials):,}",
              f"- **Core Essentials:** {tab['core']:,} specials, covering {len(on_special['core'])} of your "
              f"{tier_total['core']} Core items" + (f" ({', '.join(on_special['core'])})" if on_special["core"] else ""),
              f"- **Regulars:** {tab['regular']:,} specials, covering {len(on_special['regular'])} of your "
              f"{tier_total['regular']} Regulars" + (f" ({', '.join(on_special['regular'])})" if on_special["regular"] else "")]
    for tier, label in (("core", "Core"), ("regular", "Regulars")):
        stores = core_by_store.get(tier)
        if stores:
            lines.append(f"  - {label} specials by store: " + ", ".join(
                f"{STORE_NAMES.get(c, c)} {n}" for c, n in sorted(stores.items(), key=lambda kv: -kv[1])))

    lines += ["", "## This week's reads", ""]
    problems: list[str] = []
    if not runs:
        lines.append("No store has been read yet this week (the refresh starts Wednesday morning).")
    else:
        lines += ["| Store | Read | When | Result | Requests | Products | Took |", "|---|---|---|---|---|---|---|"]
        for r in runs:
            cov = conn.execute("SELECT COUNT(*), SUM(complete), SUM(items_seen), SUM(items_total) FROM run_coverage "
                               "WHERE run_id = ?", (r["id"],)).fetchone()
            result = {"ok": "done", "partial": "partly done", "blocked": "REFUSED", "error": "failed",
                      "running": "running"}.get(r["status"], r["status"])
            lines.append(f"| {STORE_NAMES.get(r['chain'], r['chain'])} | {KIND_WORDS.get(r['kind'], r['kind'])} | "
                         f"{_syd(r['started_at'])} | {result} | {r['requests_made']:,} | {r['items_seen']:,} | "
                         f"{_took(r['started_at'], r['finished_at'])} |")
            if r["status"] in ("partial", "blocked", "error"):
                problems.append(_problem(conn, r, cov))
        first, last = runs[0]["started_at"], max((r["finished_at"] or r["started_at"]) for r in runs)
        lines.append(f"\nThe week's refresh ran from {_syd(first)} and took {_took(first, last)} in total.")

    lines += ["", "## Not collected, and why", ""]
    notes: list[str] = list(problems)
    for c in chains:
        when = blocked_since_resume(conn, c)
        if when:
            notes.append(f"{STORE_NAMES.get(c, c)} refused us at {_syd(when)}, so it's paused. Nothing contacts it "
                         f"until you run: `uv run specials resume {c}`")
        if is_paused_for_good(conn, c):
            notes.append(f"{STORE_NAMES.get(c, c)}: paused for good (as agreed).")
    import os

    config.load_dotenv()
    if not os.environ.get("ANTHROPIC_API_KEY"):
        notes.append("Chemist Warehouse catalogue: not read, because the AI reader's key isn't set up yet "
                     "(`uv run specials catalogue key`).")
    from .catalogues import pending_review

    pending = pending_review()
    if pending:
        notes.append(f"{len(pending)} catalogue offer(s) wait for your check: `uv run specials catalogue review`.")
    review = conn.execute("SELECT COUNT(*) FROM watch_matches WHERE status = 'review'").fetchone()[0]
    if review:
        notes.append(f"{review} watchlist match(es) wait for your check: `uv run specials review`.")
    lines += [f"- {n}" for n in notes] or ["- Nothing: every store was read in full."]
    lines += ["", f"Last store read: {_syd(last_read)}. App: https://marqueztandog7-del.github.io/family-specials/"]

    snapshot = {"at": iso(now), "specials": {c: len(v) for c, v in by_chain.items()},
                "subtabs": {"all": len(specials), **tab}, "special_ids": sorted(ids), "problems": problems}
    return "\n".join(lines) + "\n", snapshot


def save(conn: sqlite3.Connection, now: datetime | None = None) -> Path:
    now = now or now_utc()
    text, snap = build(conn, now)
    REPORTS.mkdir(parents=True, exist_ok=True)
    stem = now.astimezone(SYDNEY).strftime("%Y-%m-%d_%H%M")
    (REPORTS / f"{stem}.md").write_text(text, encoding="utf-8")
    (REPORTS / f"{stem}.json").write_text(json.dumps(snap), encoding="utf-8")
    return REPORTS / f"{stem}.md"


def newest() -> Path | None:
    files = sorted(REPORTS.glob("*.md"))
    return files[-1] if files else None

