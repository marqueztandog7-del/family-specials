"""Builds the data files the family page reads: site/data/products.json and site/data/status.json.

Only products related to what we buy are published (see history.scope_product_ids).
Prices follow the pricing rules in CLAUDE.md: shelf prices and specials only (no member prices),
multibuys shown as an effective price per item and per unit, and a normalised unit price
(per kg, per L or per item) worked out from the parsed pack size.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import timedelta
from pathlib import Path
from typing import Any

from . import config
from .history import scope_product_ids
from .runner import is_paused_for_good
from .search import FRESH_DAYS
from .timeutil import iso, now_utc

SITE_DATA = config.PROJECT_ROOT / "site" / "data"
STORE_NAMES = {"woolworths": "Woolworths", "coles": "Coles", "aldi": "ALDI", "costco": "Costco",
               "chemistwarehouse": "Chemist Warehouse"}
BASIS_LABEL = {"in_store": "in store", "online": "online", "online_incl_delivery": "online, incl. delivery"}


def normalised_unit_price(price_cents: int | None, price_per: str, attrs: sqlite3.Row | None) -> dict | None:
    """Price per kg, per L or per item, from our own parsed size. None if the size isn't reliable."""
    if price_cents is None:
        return None
    if price_per == "kg":
        return {"cents": float(price_cents), "per": "kg"}
    if not attrs or not attrs["comparable"] or not attrs["total_quantity"]:
        return None
    total, base = attrs["total_quantity"], attrs["base_unit"]
    if base == "g":
        return {"cents": round(price_cents * 1000 / total, 2), "per": "kg"}
    if base == "ml":
        return {"cents": round(price_cents * 1000 / total, 2), "per": "L"}
    if base == "each":
        noun = attrs["count_noun"]
        # "40 pack" means 40 items, so the unit is an item, not a pack.
        return {"cents": round(price_cents / total, 2), "per": noun if noun not in (None, "pack", "each") else "item"}
    return None


def build_products(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    scope = scope_product_ids(conn)
    if not scope:
        return []
    now = now_utc()
    fresh = {c: iso(now - timedelta(days=d)) for c, d in FRESH_DAYS.items()}
    rows = conn.execute(
        f"""
        WITH l AS (
          SELECT o.*, ROW_NUMBER() OVER (
            -- One row per product: its latest price. (Woolworths' anonymous default store changes
            -- from week to week, so an older store's price must not show as a second listing.)
            PARTITION BY o.retailer_product_id
            -- Latest run first; within a run, Woolworths' in-store price before its online one.
            ORDER BY r.started_at DESC, o.is_special DESC,
                     CASE o.price_basis WHEN 'in_store' THEN 0 ELSE 1 END, o.observed_at DESC, o.id DESC
          ) AS rn
          FROM price_observations o JOIN collection_runs r ON r.id = o.run_id
          WHERE o.retailer_product_id IN ({','.join('?' * len(scope))})
        )
        SELECT l.*, p.chain, p.retailer_product_id AS store_product_id, p.name, p.display_name, p.brand,
               p.size_text, p.url, p.image_url, p.category_path, s.store_ref, s.name AS store_name
        FROM l JOIN retailer_products p ON p.id = l.retailer_product_id JOIN stores s ON s.id = l.store_id
        WHERE l.rn = 1
        """, list(scope)).fetchall()
    attrs = {r["retailer_product_id"]: r for r in conn.execute("SELECT * FROM product_attributes")}
    out = []
    for r in rows:
        if r["observed_at"] < fresh.get(r["chain"], iso(now - timedelta(days=8))):
            continue  # not seen recently: don't present an old price as current
        special = bool(r["is_special"])
        if special and r["valid_to"] and r["valid_to"] < iso(now):
            continue  # the special has ended and we don't know today's price yet: show nothing, not a guess
        a = attrs.get(r["retailer_product_id"])
        multi = None
        if r["multibuy_qty"] and r["multibuy_cents"]:
            each = r["multibuy_cents"] / r["multibuy_qty"]
            multi = {"qty": r["multibuy_qty"], "cents": r["multibuy_cents"], "each_cents": round(each, 2),
                     "unit": normalised_unit_price(round(each), r["price_per"], a)}
        out.append({
            "id": f"{r['chain']}:{r['store_product_id']}",
            "chain": r["chain"],
            "store": STORE_NAMES.get(r["chain"], r["chain"]),
            "store_ref": r["store_ref"],
            "name": r["display_name"] or r["name"],
            "brand": r["brand"],
            "size": r["size_text"],
            "category": r["category_path"],
            "url": r["url"],
            "image": r["image_url"],
            "price_cents": r["price_cents"],
            "price_per": r["price_per"],
            "was_cents": r["was_cents"] if special else None,
            "rrp_cents": r["rrp_cents"],
            "basis": BASIS_LABEL.get(r["price_basis"], r["price_basis"]),
            "special": special,
            "special_type": r["special_type"],
            "promo": r["promo_text"],
            "multibuy": multi,
            "unit": normalised_unit_price(r["price_cents"], r["price_per"], a),
            "store_unit_text": r["unit_price_text"],
            "valid_from": r["valid_from"],
            "valid_to": r["valid_to"] if special else None,
            "valid_to_assumed": r["valid_to_source"] == "weekly_cycle_assumed",
            "in_stock": None if r["in_stock"] is None else bool(r["in_stock"]),
            "seen_at": r["observed_at"],
        })
    out.sort(key=lambda x: (x["chain"], x["name"].lower()))
    return out


def build_status(conn: sqlite3.Connection, product_counts: dict[str, int]) -> dict[str, Any]:
    chains = config.settings()["chains"]
    stores = []
    for chain, cfg in chains.items():
        last_ok = conn.execute(
            "SELECT MAX(finished_at) FROM collection_runs WHERE chain = ? AND status IN ('ok', 'partial')",
            (chain,)).fetchone()[0]
        last = conn.execute(
            "SELECT status, started_at, run_where FROM collection_runs WHERE chain = ? ORDER BY started_at DESC LIMIT 1",
            (chain,)).fetchone()
        latest_store = conn.execute(
            """SELECT s.name FROM price_observations o JOIN stores s ON s.id = o.store_id
               WHERE s.chain = ? ORDER BY o.observed_at DESC LIMIT 1""", (chain,)).fetchone()
        stores.append({
            "chain": chain,
            "name": STORE_NAMES.get(chain, chain),
            "store": latest_store["name"] if latest_store else cfg["store"]["name"],
            "updates_from": ("paused" if not cfg.get("enabled", True) or is_paused_for_good(conn, chain)
                             else cfg.get("run_on", "github")),
            "last_updated": last_ok,
            "last_attempt": dict(last) if last else None,
            "products": product_counts.get(chain, 0),
        })
    return {"generated_at": iso(now_utc()), "stores": stores}


def export_site(conn: sqlite3.Connection, out_dir: Path = SITE_DATA) -> dict[str, int]:
    products = build_products(conn)
    counts: dict[str, int] = {}
    for p in products:
        counts[p["chain"]] = counts.get(p["chain"], 0) + 1
    out_dir.mkdir(parents=True, exist_ok=True)
    _write_json(out_dir / "products.json", {"generated_at": iso(now_utc()), "products": products})
    _write_json(out_dir / "status.json", build_status(conn, counts))
    return counts


def _write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
