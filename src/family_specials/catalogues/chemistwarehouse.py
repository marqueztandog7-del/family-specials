"""Chemist Warehouse's printed catalogue, read from its page images (approved 19 Oct 2026).

  1. The current catalogues come from the Nexus Publications viewer the site uses (client 3476): title, start and end
     dates, and one image per page.
  2. Each page image is read once with AI (Anthropic's API; the key is ANTHROPIC_API_KEY in .env). It's asked to
     copy what's printed, never to guess, and to say when something isn't clear. The answer is kept on the Mac
     (data/catalogue/chemistwarehouse/), so a page is never paid for twice.
  3. Each offer is matched to a product in Chemist Warehouse's range (our weekly read), by name and size.
  4. Our rule for Chemist Warehouse (19 Oct 2026): "$X off RRP" is everyday pricing, never a special. A catalogue
     price counts as a special only when it's lower than the price we recorded at Chemist Warehouse before the
     catalogue started (that price is shown as the was price), or when the catalogue says the saving is off its
     everyday price (the ▶ mark) and prints the amount.

Offers that can't be read clearly, or matched to one product with confidence, go on the review list. Offers for a
whole range ("1/2 price Maybelline range") have no single product or price, so they're not recorded.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import sqlite3
from datetime import datetime, timedelta
from typing import Any

import httpx

from .. import config, db
from ..collectors.base import Coverage
from ..http import Blocked, BudgetExceeded, RobotsDisallowed
from ..matching import name_score, normalise
from ..models import Observation
from ..parsing import parse_size
from ..timeutil import SYDNEY, iso, now_utc, parse_iso
from . import CACHE_DIR, add_observation, add_to_review

NEXUS = "https://node.nexuspublications.com.au"
API = "https://api.anthropic.com/v1/messages"
AUTO_SCORE = 0.86       # name match at or above this, with the same size, and clearly ahead of the next: matched
REVIEW_SCORE = 0.62     # between this and AUTO_SCORE: on the review list
CLEAR_LEAD = 0.06

PROMPT = """This is one page of a Chemist Warehouse (Australian pharmacy) catalogue. List every product offer printed on it.

Copy exactly what is printed. Never guess: if a name, size or price is cut off, blurry or hidden, set "readable" to false.
For each offer give:
- name: the product's name as printed in the small caption under the photo if there is one (brand, product, size), otherwise as printed in the headline.
- size: the pack size if printed (e.g. "150ml", "100 tablets"), else null.
- price: the advertised price in dollars as a number (e.g. 20.49). Prices are often printed with small superscript cents ("$20" with "49" above) - read them as 20.49. null if there's no single price.
- price_words: any word printed with the price, e.g. "FROM", "ea", "each", or "".
- is_range: true if the offer is for a whole range or several products (e.g. "1/2 price off RRP Maybelline range", "FROM $9.99", "Selected ..."), else false.
- saving_text: the saving exactly as printed next to the price, e.g. "$20.51 OFF RRP†", "1/2 PRICE OFF RRP", "SAVE $5▶", "WAS $12.99", or "".
- saving_basis: "rrp" if the saving is off RRP (often marked †), "everyday" if it's off Chemist Warehouse's everyday price (marked ▶ or "off our EDLP"), "was" if a was price is printed, "none" if no saving is printed, "unclear" otherwise.
- saving_amount: the dollar amount of the saving if printed as a number (e.g. 20.51), else null.
- multibuy: e.g. "2 for $20" if printed, else null.
- readable: true only if the name and price are clearly legible.
Leave out pages' general banners that aren't offers for a product. If the page has no offers, return an empty list."""

TOOL = {
    "name": "record_offers",
    "description": "Record every product offer printed on the catalogue page.",
    "input_schema": {
        "type": "object",
        "properties": {"offers": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "name": {"type": "string"}, "size": {"type": ["string", "null"]},
                "price": {"type": ["number", "null"]}, "price_words": {"type": "string"},
                "is_range": {"type": "boolean"}, "saving_text": {"type": "string"},
                "saving_basis": {"type": "string", "enum": ["rrp", "everyday", "was", "none", "unclear"]},
                "saving_amount": {"type": ["number", "null"]}, "multibuy": {"type": ["string", "null"]},
                "readable": {"type": "boolean"},
            },
            "required": ["name", "price", "is_range", "saving_text", "saving_basis", "readable"],
        }}},
        "required": ["offers"],
    },
}


# --------------------------------------------------------------------------- the catalogue viewer


def current_catalogues(client, client_id: int, now: datetime | None = None) -> list[dict[str, Any]]:
    now = now or now_utc()
    out = []
    for c in client.get(f"{NEXUS}/client/{client_id}/catalogues/json").json():
        try:
            start = datetime.fromisoformat(c["start"]).replace(tzinfo=SYDNEY)
            end = datetime.fromisoformat(c["finish"]).replace(tzinfo=SYDNEY)
        except (KeyError, ValueError):
            continue
        if end >= now:
            out.append({"id": str(c["nid_1"]), "title": c.get("title") or "Catalogue", "start": iso(start),
                        "end": iso(end)})
    return out


def page_images(client, catalogue_id: str) -> list[dict[str, Any]]:
    pages = client.get(f"{NEXUS}/catalogue/{catalogue_id}/page-images/json").json()
    return [{"page": int(p["page"]), "image": p["image"]} for p in pages if p.get("image")]


# --------------------------------------------------------------------------- reading a page with AI


def read_page_ai(image: bytes, api_key: str, model: str, transport: httpx.BaseTransport | None = None) -> list[dict]:
    body = {
        "model": model, "max_tokens": 4096, "tools": [TOOL],
        "tool_choice": {"type": "tool", "name": "record_offers"},
        "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                         "data": base64.b64encode(image).decode()}},
            {"type": "text", "text": PROMPT}]}],
    }
    with httpx.Client(timeout=180, transport=transport) as http:
        r = http.post(API, json=body, headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"})
    if r.status_code >= 400:
        raise RuntimeError(f"The AI reader said {r.status_code}: {r.text[:200]}")
    for block in r.json().get("content") or []:
        if block.get("type") == "tool_use" and block.get("name") == "record_offers":
            return block["input"].get("offers") or []
    raise RuntimeError("The AI reader didn't return the offers")


# --------------------------------------------------------------------------- matching an offer to a product


def load_range(conn: sqlite3.Connection, days: int = 14) -> list[dict[str, Any]]:
    cutoff = iso(now_utc() - timedelta(days=days))
    rows = conn.execute(
        """SELECT p.id, p.retailer_product_id, COALESCE(p.display_name, p.name) AS name, p.brand,
                  a.total_quantity, a.base_unit, a.comparable
           FROM retailer_products p LEFT JOIN product_attributes a ON a.retailer_product_id = p.id
           WHERE p.chain = 'chemistwarehouse' AND p.last_seen_at >= ?""", (cutoff,)).fetchall()
    return [{"id": r["id"], "store_id": r["retailer_product_id"], "name": r["name"], "norm": normalise(r["name"]),
             "total": r["total_quantity"] if r["comparable"] else None, "base": r["base_unit"]} for r in rows]


def same_size(offer: dict[str, Any], product: dict[str, Any]) -> bool | None:
    """True / False when both sizes are known, None when either isn't."""
    s = parse_size(offer.get("size"), offer.get("name"))
    if not (s.comparable and s.total_quantity) or not product["total"]:
        return None
    return s.base_unit == product["base"] and abs(s.total_quantity - product["total"]) < 0.5


def best_match(offer: dict[str, Any], products: list[dict[str, Any]]) -> tuple[dict | None, float, str]:
    """(product, score, verdict) where verdict is 'matched', 'review' or 'not found'."""
    target = normalise(" ".join(filter(None, [offer.get("name"), offer.get("size")])))
    scored = sorted(((name_score(target, p["norm"]), p) for p in products), key=lambda x: -x[0])[:2]
    if not scored or scored[0][0] < REVIEW_SCORE:
        return (scored[0][1] if scored else None), (scored[0][0] if scored else 0.0), "not found"
    score, product = scored[0]
    lead = score - (scored[1][0] if len(scored) > 1 else 0)
    size = same_size(offer, product)
    if score >= AUTO_SCORE and size is True and lead >= CLEAR_LEAD:
        return product, score, "matched"
    return product, score, "review"


def earlier_price(conn: sqlite3.Connection, pid: int, before: str) -> int | None:
    """Chemist Warehouse's own shelf price for the product before the catalogue started (the last one we saw)."""
    row = conn.execute(
        """SELECT price_cents FROM price_observations WHERE retailer_product_id = ? AND observed_at < ?
           AND price_cents IS NOT NULL AND source != 'catalogue' ORDER BY observed_at DESC LIMIT 1""",
        (pid, before)).fetchone()
    return row[0] if row else None


def decide(conn: sqlite3.Connection, offer: dict[str, Any], pid: int, cat: dict[str, Any]) -> tuple[Observation | None, str]:
    """Apply our Chemist Warehouse rule. Returns the observation to record (None if it isn't a special) and why."""
    price = round(offer["price"] * 100)
    store_ref = str(config.chain_config("chemistwarehouse")["store"]["ref"])
    common = dict(store_ref=store_ref, price_basis="online", price_cents=price, is_special=True,
                  special_type="catalogue", valid_from=cat["start"], valid_to=cat["end"], valid_to_source="catalogue")
    if offer.get("saving_basis") == "everyday" and offer.get("saving_amount"):
        save = round(offer["saving_amount"] * 100)
        return Observation(**common, was_cents=price + save,
                           promo_text=f"Catalogue: save ${save / 100:.2f} off the everyday price"), "everyday saving"
    before = earlier_price(conn, pid, cat["start"])
    if before is None:
        return None, "no earlier price to compare"
    if price < before:
        return Observation(**common, was_cents=before,
                           promo_text=f"Catalogue price (was ${before / 100:.2f} at Chemist Warehouse)"), "cheaper"
    return None, "not cheaper than its usual price"


# --------------------------------------------------------------------------- the run


def run(conn: sqlite3.Connection, max_pages: int | None = None):
    from ..runner import RunResult, make_client

    chain = "chemistwarehouse"
    cfg = config.chain_config(chain)["catalogue"]
    config.load_dotenv()
    import os

    api_key = os.environ.get(cfg.get("api_key_env", "ANTHROPIC_API_KEY"))
    if not api_key:
        return RunResult(chain, "catalogue", 0, "skipped", 0, 0, 0,
                         "Not read yet: the AI reader's key isn't set up (uv run specials catalogue key)")
    run_id = db.start_run(conn, chain, "catalogue")
    client = make_client(chain, "catalogue")
    coverage: list[Coverage] = []
    seen = observations = 0
    status, error = "ok", None
    review: list[dict[str, Any]] = []
    notes = {"matched": 0, "special": 0, "not cheaper": 0, "no earlier price": 0, "review": 0, "range offer": 0,
             "not found": 0}
    products = load_range(conn)
    try:
        for cat in current_catalogues(client, int(cfg["nexus_client_id"])):
            folder = CACHE_DIR / chain / cat["id"]
            folder.mkdir(parents=True, exist_ok=True)
            pages = page_images(client, cat["id"])
            for pg in pages[: max_pages or len(pages)]:
                cov = Coverage("catalogue_page", f"{cat['id']}:{pg['page']}", f"{cat['title']} page {pg['page']}",
                               pages_read=1, pages_total=1)
                coverage.append(cov)
                cached = folder / f"page-{pg['page']:03d}.json"
                if cached.exists():
                    offers = json.loads(cached.read_text(encoding="utf-8"))["offers"]
                else:
                    img = client.get(pg["image"], expect="any")
                    if not img.headers.get("content-type", "").startswith("image/"):
                        raise Blocked(f"{pg['image']}: expected a page image, got something else")
                    (folder / f"page-{pg['page']:03d}.jpg").write_bytes(img.content)
                    offers = read_page_ai(img.content, api_key, cfg.get("model", "claude-sonnet-5-5"))
                    cached.write_text(json.dumps({"image": pg["image"], "read_at": iso(now_utc()),
                                                  "offers": offers}, indent=1, ensure_ascii=False), encoding="utf-8")
                cov.complete = True
                for offer in offers:
                    cov.items_seen += 1
                    seen += 1
                    oid = hashlib.sha1(json.dumps(offer, sort_keys=True).encode()).hexdigest()[:10]
                    entry = {"id": f"chemistwarehouse:{cat['id']}:{pg['page']}:{oid}", "chain": chain,
                             "catalogue": cat["id"], "catalogue_title": cat["title"], "page": pg["page"],
                             "image": str(folder / f"page-{pg['page']:03d}.jpg"), "offer": offer,
                             "valid_from": cat["start"], "valid_to": cat["end"]}
                    if offer.get("is_range") or offer.get("price") is None:
                        notes["range offer"] += 1
                        continue
                    product, score, verdict = best_match(offer, products)
                    if not offer.get("readable") or verdict == "review":
                        notes["review"] += 1
                        review.append({**entry, "reason": "Not clear enough to read" if not offer.get("readable")
                                       else "Not sure which product this is",
                                       "candidate": product and {"store_id": product["store_id"], "name": product["name"],
                                                                 "score": round(score, 2)}})
                        continue
                    if verdict == "not found":
                        notes["not found"] += 1
                        continue
                    notes["matched"] += 1
                    obs, why = decide(conn, offer, product["id"], cat)
                    if obs is None:
                        notes["not cheaper" if why.startswith("not cheaper") else "no earlier price"] += 1
                        continue
                    add_observation(conn, run_id, product["id"], chain, obs)
                    notes["special"] += 1
                    observations += 1
                conn.commit()
    except (Blocked, RobotsDisallowed) as e:
        status, error = "blocked", str(e)
    except BudgetExceeded as e:
        status, error = "partial", str(e)
    except Exception as e:  # noqa: BLE001 - one store's problem never stops the others
        import traceback

        status, error = "error", f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=5)}"
    finally:
        client.close()
    for cov in coverage:
        db.add_coverage(conn, run_id, cov)
    if review:
        add_to_review(review)
    summary = ", ".join(f"{k} {v}" for k, v in notes.items() if v)
    db.finish_run(conn, run_id, status, client.requests_made, seen, observations,
                  error or (f"Offers: {summary}" if summary else None))
    return RunResult(chain, "catalogue", run_id, status, client.requests_made, seen, observations,
                     error or (f"Offers: {summary}" if summary else None))


def apply_review(conn: sqlite3.Connection, entry: dict[str, Any], store_product_id: str) -> str:
    """You confirmed which product a catalogue offer is: apply the same rule as above. Returns what happened."""
    from . import product_id

    pid = product_id(conn, "chemistwarehouse", store_product_id)
    if pid is None:
        return "That product isn't in Chemist Warehouse's range we have."
    cat = {"start": entry["valid_from"], "end": entry["valid_to"]}
    if parse_iso(cat["end"]) < now_utc():
        return "That catalogue has ended."
    obs, why = decide(conn, entry["offer"], pid, cat)
    if obs is None:
        return f"Not recorded as a special: {why}."
    run_id = db.start_run(conn, "chemistwarehouse", "catalogue")
    add_observation(conn, run_id, pid, "chemistwarehouse", obs)
    db.finish_run(conn, run_id, "ok", 0, 1, 1, "Confirmed on the review list")
    return f"Recorded: {obs.promo_text}."
