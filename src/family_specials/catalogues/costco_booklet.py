"""Costco's In-Warehouse Savings booklet: warehouse shelf prices after the booklet's saving.

The booklet is linked from costco.com.au/warehouse-savings and hosted on Joomag (robots.txt allows it). Joomag's
viewer has a text-only version of each page, so every item is read as text:

    $ 11 99 / After $ 4 off / Original Source Vanilla & Raspberry Body Wash / 2 x 1L Item 187193 | $ 0.60 per 100ml

The item number is Costco's product code, so an item matches the same product online exactly. Pages come in pairs
(spreads), so repeated pages are read once. The "Online Only" page is left out: those are online prices that include
delivery, and the online read already has them. An item whose text doesn't read cleanly goes on the review list.
"""

from __future__ import annotations

import hashlib
import html
import re
import sqlite3
from datetime import date, timedelta
from typing import Any

from .. import config, db
from ..collectors.base import Coverage
from ..http import Blocked, BudgetExceeded, NotFound, RobotsDisallowed
from ..models import NormalisedItem, Observation, ProductInfo
from ..timeutil import iso, sydney_end_of_day, sydney_midnight, sydney_today
from . import add_observation, add_to_review, product_id

CMS = "https://www.costco.com.au/rest/v3/australia/cms/pages"
TEXT_PAGE = "https://app.joomag.com/Frontend/WebService/viewer_text_only_gateway.php"
BOOKLET_RE = re.compile(r"https://viewer\.joomag\.com/(in-warehouse-savings-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d))/(\d+)")
MAGAZINE_RE = re.compile(r"magazineID:\s*'(\d+)'")
DIV_RE = re.compile(r"<div>(.*?)</div>", re.S)
PRICE_START = r"\$\s*[\d,]+[\s.]+\d{2}\s*\n\s*After\s*\$"
ITEM_RE = re.compile(r"\$\s*([\d,]+)[\s.]+(\d{2})\s*\n\s*After\s*\$\s*([\d.,]+)\s*off\s*\n(.*?)(?=\n\s*" + PRICE_START + r"|\Z)",
                     re.S | re.I)
ITEM_NO_RE = re.compile(r"Item\s+(\d{3,8}(?:-[A-Z]+)?)")
UNIT_RE = re.compile(r"\$\s*([\d.]+)\s+per\s+(100\s?ml|100\s?g|100|kg|each|1\s?l|litre|sheet|roll)\b", re.I)
LEGAL_START = ("terms and conditions", "ouse.", "items shown", "shop on the go", "scan me", "costco mobile app")
UNIT_MEASURE = {"100ml": "100ML", "100g": "100G", "100": "100EA", "kg": "1KG", "each": "1EA", "1l": "1L", "litre": "1L",
                "sheet": "1EA", "roll": "1EA"}


def cents(dollars: str, cc: str = "00") -> int:
    return int(dollars.replace(",", "")) * 100 + int(cc)


def saving_cents(text: str) -> int:
    whole, _, frac = text.replace(",", "").partition(".")
    return int(whole) * 100 + int((frac + "00")[:2])


def clean_name(text: str) -> str:
    t = ITEM_NO_RE.sub(" ", text)
    t = UNIT_RE.sub(" ", t)
    t = re.sub(r"\*\s*No rainchecks", " ", t, flags=re.I)
    t = t.replace("|", " ")
    t = re.sub(r"([A-Za-z][’'])\s+(?=[a-z])", r"\1", t)     # "Johnson’ s" -> "Johnson’s", "L’ or" -> "L’or"
    t = re.sub(r"\s*/\s*", "/", t)                          # "and / or" -> "and/or"
    return re.sub(r"\s+", " ", t).strip()


def page_lines(page_html: str) -> list[str]:
    """The page's text lines, without the legal small print."""
    lines = []
    for raw in DIV_RE.findall(page_html):
        line = html.unescape(re.sub(r"<[^>]+>", " ", raw)).strip()
        if line and not line.lower().startswith(LEGAL_START) and len(line) < 160:
            lines.append(line)
    return lines


def parse_page(page_html: str) -> tuple[list[dict[str, Any]], list[str]]:
    """Items on one booklet page, and the text of any that didn't read cleanly (for review)."""
    text = "\n".join(page_lines(page_html))
    if "online only" in text.lower()[:200] or "ONLINE ONLY PROMOTIONS" in page_html:
        return [], []
    items, unclear = [], []
    for m in ITEM_RE.finditer(text):
        body = m.group(4)
        numbers = list(dict.fromkeys(ITEM_NO_RE.findall(body)))
        name = clean_name(body)
        unit = UNIT_RE.search(body)
        price, saving = cents(m.group(1), m.group(2)), saving_cents(m.group(3))
        if not numbers or not name or price <= 0 or saving <= 0:
            unclear.append(m.group(0).strip())
            continue
        items.append({
            "item_numbers": numbers, "name": name, "price_cents": price, "saving_cents": saving,
            "unit_price": float(unit.group(1)) if unit else None,
            "unit_text": f"${float(unit.group(1)):.2f} per {unit.group(2)}" if unit else None,
            "unit_measure": UNIT_MEASURE.get(re.sub(r"\s", "", unit.group(2).lower())) if unit else None,
        })
    # Anything priced on the page that the pattern above didn't take is shown for review, not dropped silently.
    priced = len(re.findall(PRICE_START, text, re.I))
    if priced > len(items) + len(unclear):
        unclear.append(f"{priced - len(items) - len(unclear)} priced item(s) on this page didn't read as items")
    return items, unclear


def find_booklets(client) -> list[dict[str, Any]]:
    """The In-Warehouse Savings booklets linked from costco.com.au/warehouse-savings, with their dates."""
    r = client.get(CMS, params={"pageType": "ContentPage", "pageLabelOrId": "warehouse-savings",
                                "lang": "en_AU", "curr": "AUD"})
    out, seen = [], set()
    for m in BOOKLET_RE.finditer(r.text):
        if m.group(8) in seen:
            continue
        seen.add(m.group(8))
        d1, m1, y1, d2, m2, y2 = (int(x) for x in m.groups()[1:7])
        out.append({"slug": m.group(1), "context": m.group(8), "url": m.group(0),
                    "start": date(2000 + y1, m1, d1), "end": date(2000 + y2, m2, d2)})
    return out


def run(conn: sqlite3.Connection, max_pages: int | None = None):
    from ..runner import RunResult, make_client

    chain = "costco"
    cfg = config.chain_config(chain)["catalogue"]
    warehouse = str(cfg["warehouse"]["ref"])
    run_id = db.start_run(conn, chain, "catalogue")
    client = make_client(chain, "catalogue")
    coverage: list[Coverage] = []
    items_seen = observations = 0
    status, error = "ok", None
    review: list[dict[str, Any]] = []
    try:
        today = sydney_today()
        booklets = [b for b in find_booklets(client) if b["end"] >= today]
        if not booklets:
            coverage.append(Coverage("catalogue", "none", "No current In-Warehouse Savings booklet linked", complete=True))
        for b in booklets:
            viewer = client.get(b["url"], expect="html", require="joomag")
            mag = MAGAZINE_RE.search(viewer.text)
            if not mag:
                raise Blocked(f"{b['url']}: the booklet viewer didn't show its magazine number (page changed?)")
            valid_from = iso(sydney_midnight(b["start"]))
            valid_to = iso(sydney_end_of_day(b["end"]))
            seen_pages: set[str] = set()
            n = 0
            while max_pages is None or n < max_pages:
                n += 1
                try:
                    page = client.get(TEXT_PAGE, params={"id": mag.group(1), "number": str(n)}, expect="any")
                except NotFound:
                    break                    # past the last page
                digest = hashlib.sha256(page.text.encode()).hexdigest()
                cov = Coverage("catalogue_page", f"{b['slug']}:{n}", f"{b['slug']} page {n}", pages_read=1,
                               pages_total=1, complete=True)
                coverage.append(cov)
                if digest in seen_pages:
                    cov.scope_name += " (same as the page before)"
                    continue
                seen_pages.add(digest)
                items, unclear = parse_page(page.text)
                for u in unclear:
                    review.append({"id": f"costco:{b['slug']}:{n}:{hashlib.sha1(u.encode()).hexdigest()[:10]}",
                                   "chain": chain, "catalogue": b["slug"], "page": n, "text": u,
                                   "reason": "Didn't read cleanly", "booklet_url": f"{b['url']}/p{n}"})
                for it in items:
                    cov.items_seen += 1
                    items_seen += 1
                    for number in it["item_numbers"]:
                        obs = Observation(
                            store_ref=warehouse, price_basis="in_store", price_cents=it["price_cents"],
                            was_cents=it["price_cents"] + it["saving_cents"], is_special=True,
                            special_type="costco_booklet",
                            promo_text=f"In-warehouse saving: ${it['saving_cents'] / 100:.2f} off",
                            unit_price=it["unit_price"], unit_measure=it["unit_measure"],
                            unit_price_text=it["unit_text"], valid_from=valid_from, valid_to=valid_to,
                            valid_to_source="catalogue")
                        pid = product_id(conn, chain, number)
                        if pid is None:
                            # Not sold online: a new product, named as in the booklet.
                            db.save_item(conn, run_id, NormalisedItem(
                                product=ProductInfo(chain=chain, retailer_product_id=number, name=it["name"],
                                                    display_name=it["name"],
                                                    url=f"{b['url']}/p{n}"),
                                observations=[obs], raw_product={"booklet": b["slug"], "page": n, "text": it["name"]},
                                raw_price={"booklet": it}), "catalogue")
                        else:
                            add_observation(conn, run_id, pid, chain, obs)
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
    db.finish_run(conn, run_id, status, client.requests_made, items_seen, observations, error)
    return RunResult(chain, "catalogue", run_id, status, client.requests_made, items_seen, observations, error)
