"""Search collected products and their current prices."""

from __future__ import annotations

import re
import sqlite3
from datetime import timedelta
from typing import Any

from . import config
from .timeutil import SYDNEY, iso, now_utc, parse_iso

# How long after we last saw a price we still treat it as current. Weekly chains are
# re-collected every cycle; ALDI Special Buys stay on shelves "while stocks last".
FRESH_DAYS = {"woolworths": 8, "coles": 8, "aldi": 21, "costco": 8, "chemistwarehouse": 8, "tongli": 21}
BASIS_LABEL = {"in_store": "in store", "online": "online", "online_incl_delivery": "online, incl. delivery"}


def fts_query(text: str) -> str | None:
    tokens = re.findall(r"[\w']+", text.lower())
    if not tokens:
        return None
    return " AND ".join(f'"{t}"*' for t in tokens)


def search(conn: sqlite3.Connection, text: str, *, chains: list[str] | None = None, specials_only: bool = True,
           sort: str = "relevance", limit: int = 50) -> list[dict[str, Any]]:
    match = fts_query(text)
    if not match:
        return []
    now = now_utc()
    fresh_case = " ".join(
        f"WHEN '{c}' THEN '{iso(now - timedelta(days=d))}'" for c, d in FRESH_DAYS.items()
    )
    where = ["l.rn = 1", f"l.observed_at >= CASE p.chain {fresh_case} ELSE '{iso(now - timedelta(days=8))}' END",
             "(l.valid_to IS NULL OR l.valid_to >= :now)"]
    params: dict[str, Any] = {"match": match, "now": iso(now), "limit": limit}
    if specials_only:
        where.append("l.is_special = 1")
    if chains:
        where.append("p.chain IN (%s)" % ",".join(f":c{i}" for i in range(len(chains))))
        params.update({f"c{i}": c for i, c in enumerate(chains)})
    order = {
        "relevance": "m.rank, l.price_cents",
        "price": "l.price_cents IS NULL, l.price_cents",
        "saving": "COALESCE(l.was_cents, l.rrp_cents, l.price_cents) - l.price_cents DESC",
    }.get(sort, "m.rank")
    sql = f"""
    WITH m AS (
      SELECT rowid AS product_id, rank FROM product_search WHERE product_search MATCH :match
    ),
    l AS (
      SELECT o.*, ROW_NUMBER() OVER (
        PARTITION BY o.retailer_product_id, o.store_id
        ORDER BY o.observed_at DESC, {"o.is_special DESC," if specials_only else ""}
                 CASE o.price_basis WHEN 'in_store' THEN 0 ELSE 1 END, o.id DESC
      ) AS rn
      FROM price_observations o JOIN m ON m.product_id = o.retailer_product_id
    )
    SELECT p.id AS product_id, p.chain, p.name, p.display_name, p.brand, p.size_text, p.url, p.image_url,
           s.name AS store_name, s.store_ref, s.price_scope,
           l.price_cents, l.was_cents, l.rrp_cents, l.price_per, l.price_basis, l.is_special, l.special_type,
           l.promo_text, l.multibuy_qty, l.multibuy_cents, l.member_only, l.member_price_cents,
           l.unit_price_text, l.valid_from, l.valid_to, l.valid_to_source, l.in_stock, l.observed_at,
           a.comparable, a.total_quantity, a.base_unit
    FROM l
    JOIN m ON m.product_id = l.retailer_product_id
    JOIN retailer_products p ON p.id = l.retailer_product_id
    JOIN stores s ON s.id = l.store_id
    LEFT JOIN product_attributes a ON a.retailer_product_id = p.id
    WHERE {" AND ".join(where)}
    ORDER BY {order}
    LIMIT :limit
    """
    rows = [dict(r) for r in conn.execute(sql, params)]
    for r in rows:
        r["store_label"] = _store_label(r)
        r["basis_label"] = BASIS_LABEL.get(r["price_basis"], r["price_basis"])
        r["ends_label"] = _ends_label(r)
        r["starts_label"] = _starts_label(r)
        r["saving_cents"] = (r["was_cents"] - r["price_cents"]) if r["was_cents"] and r["price_cents"] else None
    return rows


def status(conn: sqlite3.Connection) -> dict[str, Any]:
    runs = [dict(r) for r in conn.execute(
        """SELECT r.chain, r.kind, r.status, r.started_at, r.requests_made, r.items_seen, r.error
           FROM collection_runs r JOIN (SELECT chain, kind, MAX(id) id FROM collection_runs GROUP BY chain, kind) x
           ON x.id = r.id ORDER BY r.chain, r.kind""")]
    for r in runs:
        r["error"] = (r["error"] or "").splitlines()[0] if r["error"] else None
    counts = dict(conn.execute(
        """SELECT p.chain, COUNT(DISTINCT p.id) FROM retailer_products p GROUP BY p.chain""").fetchall())
    stores = {c: cfg["store"]["name"] for c, cfg in config.settings()["chains"].items()}
    return {"runs": runs, "products": counts, "stores": stores}


def _store_label(r: dict[str, Any]) -> str:
    names = {"woolworths": "Woolworths", "coles": "Coles", "aldi": "ALDI", "costco": "Costco",
             "chemistwarehouse": "Chemist Warehouse", "tongli": "Tong Li"}
    return names.get(r["chain"], r["chain"])


def _ends_label(r: dict[str, Any]) -> str | None:
    end = parse_iso(r.get("valid_to"))
    if not end:
        return None
    label = end.astimezone(SYDNEY).strftime("%a %-d %b")
    if r.get("valid_to_source") == "weekly_cycle_assumed":
        label += " (weekly cycle)"
    return label


def _starts_label(r: dict[str, Any]) -> str | None:
    start = parse_iso(r.get("valid_from"))
    if not start or start <= now_utc():
        return None
    return "from " + start.astimezone(SYDNEY).strftime("%a %-d %b")
