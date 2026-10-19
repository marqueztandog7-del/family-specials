"""Printed catalogues: Costco's In-Warehouse Savings booklet and Chemist Warehouse's catalogue.

  - Costco (costco_booklet.py): the booklet's viewer publishes a text version of every page, so prices, savings,
    names and Costco item numbers are read exactly. Item numbers are Costco's own product codes.
  - Chemist Warehouse (chemistwarehouse.py): the catalogue exists only as page images. Each page is read once with
    AI (Anthropic's API, key in .env), then every offer is matched to a product in Chemist Warehouse's range.

Anything that can't be read or matched reliably goes on the review list (data/catalogue-review.json, on the Mac
only), never into the prices. `specials review` goes through it.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from .. import config, db
from ..models import Observation
from ..timeutil import now_iso

REVIEW_FILE = config.DATA_DIR / "catalogue-review.json"
CACHE_DIR = config.DATA_DIR / "catalogue"


def run_catalogue(conn: sqlite3.Connection, chain: str, max_pages: int | None = None):
    if chain == "costco":
        from .costco_booklet import run

        return run(conn, max_pages=max_pages)
    if chain == "chemistwarehouse":
        from .chemistwarehouse import run

        return run(conn, max_pages=max_pages)
    raise NotImplementedError(f"{chain} has no catalogue reader")


def has_catalogue(chain: str) -> bool:
    return chain in ("costco", "chemistwarehouse") and bool(config.chain_config(chain).get("catalogue"))


# --------------------------------------------------------------------------- saving prices


def add_observation(conn: sqlite3.Connection, run_id: int, product_id: int, chain: str, obs: Observation) -> None:
    """A catalogue price for a product we already have (the product's own details are left as the store has them)."""
    store_id = db.ensure_store(conn, chain, obs.store_ref)
    db._insert_observation(conn, run_id, product_id, store_id, now_iso(), "catalogue", obs, None)


def product_id(conn: sqlite3.Connection, chain: str, store_product_id: str) -> int | None:
    row = conn.execute("SELECT id FROM retailer_products WHERE chain = ? AND retailer_product_id = ?",
                       (chain, store_product_id)).fetchone()
    return row["id"] if row else None


# --------------------------------------------------------------------------- review list


def load_review() -> list[dict[str, Any]]:
    try:
        return json.loads(REVIEW_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def save_review(items: list[dict[str, Any]]) -> None:
    REVIEW_FILE.parent.mkdir(parents=True, exist_ok=True)
    REVIEW_FILE.write_text(json.dumps(items, indent=1, ensure_ascii=False), encoding="utf-8")


def add_to_review(entries: list[dict[str, Any]]) -> int:
    """Add entries (each with a unique 'id') that aren't on the list yet. Returns how many were new."""
    items = load_review()
    have = {i["id"] for i in items}
    new = [e for e in entries if e["id"] not in have]
    for e in new:
        e.setdefault("status", "pending")
        e.setdefault("added_at", now_iso())
    save_review(items + new)
    return len(new)


def pending_review() -> list[dict[str, Any]]:
    return [i for i in load_review() if i.get("status") == "pending"]
