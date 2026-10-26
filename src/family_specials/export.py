"""Builds the public data files the family page reads: site/data/specials.json (every store's current specials,
whatever we watch) and site/data/status.json. Nothing about our family goes in them: the watchlist and its Core /
Regulars groups go only to the family's private row in Supabase, and every store's full range goes to Supabase for
search (backend.upload_products).

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
from .runner import blocked_since_resume, is_paused_for_good
from .search import FRESH_DAYS
from .timeutil import iso, now_utc, weekly_cycle

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


def build_products(conn: sqlite3.Connection, keep_internal_id: bool = False,
                   only: set[int] | None = None) -> list[dict[str, Any]]:
    """Every product with a current price, at every store (or just the products in `only`).

    Current means seen in the store's last read (within FRESH_DAYS), or a special with an end date from the store or
    its catalogue that hasn't passed yet: a special stays for as long as the store says it's on. A full-range read
    only records a price when it changes, so "seen" comes from the product's last_seen_at.
    """
    now = now_utc()
    fresh = {c: iso(now - timedelta(days=d)) for c, d in FRESH_DAYS.items()}
    where = f"AND o.retailer_product_id IN ({','.join('?' * len(only))})" if only is not None else ""
    if only is not None and not only:
        return []
    # Stores that are paused for good (Coles) or switched off are never shown, whatever data we still have.
    live = [c for c, cfg in config.settings()["chains"].items()
            if cfg.get("enabled", True) and not is_paused_for_good(conn, c)]
    rows = conn.execute(
        f"""
        WITH l AS (
          SELECT o.*, ROW_NUMBER() OVER (
            -- One row per product: its latest price. (Woolworths' anonymous default store changes
            -- from week to week, so an older store's price must not show as a second listing.)
            PARTITION BY o.retailer_product_id
            -- A catalogue special that's still on comes first (Costco's booklet is the warehouse price, not the
            -- online one); then the latest run; within a run, Woolworths' in-store price before its online one.
            ORDER BY CASE WHEN o.is_special = 1 AND o.valid_to_source = 'catalogue' THEN 1 ELSE 0 END DESC, r.started_at DESC,
                     o.is_special DESC, CASE o.price_basis WHEN 'in_store' THEN 0 ELSE 1 END, o.observed_at DESC,
                     o.id DESC
          ) AS rn
          FROM price_observations o JOIN collection_runs r ON r.id = o.run_id
          -- A special that has ended is never the current price.
          WHERE NOT (o.is_special = 1 AND o.valid_to IS NOT NULL AND o.valid_to < '{iso(now)}') {where}
        )
        SELECT l.*, p.chain, p.retailer_product_id AS store_product_id, p.name, p.display_name, p.brand,
               p.size_text, p.url, p.image_url, p.category_path, p.last_seen_at, s.store_ref, s.name AS store_name
        FROM l JOIN retailer_products p ON p.id = l.retailer_product_id JOIN stores s ON s.id = l.store_id
        WHERE l.rn = 1
        """, list(only or ())).fetchall()
    attrs = {r["retailer_product_id"]: r for r in conn.execute("SELECT * FROM product_attributes")}
    out = []
    for r in rows:
        if r["chain"] not in live or r["price_cents"] == 0:
            continue   # a $0 price is never a real shelf price (prescription-only items, samples)
        special = bool(r["is_special"])
        if special and r["valid_to"] and r["valid_to"] < iso(now):
            continue  # the special has ended and we don't know today's price yet: show nothing, not a guess
        seen = max(r["observed_at"], r["last_seen_at"] or "")
        dated = special and r["valid_to"] and r["valid_to_source"] in ("store", "catalogue")
        if seen < fresh.get(r["chain"], iso(now - timedelta(days=8))) and not dated:
            continue  # not seen recently: don't present an old price as current
        a = attrs.get(r["retailer_product_id"])
        multi = None
        if r["multibuy_qty"] and r["multibuy_cents"]:
            each = r["multibuy_cents"] / r["multibuy_qty"]
            multi = {"qty": r["multibuy_qty"], "cents": r["multibuy_cents"], "each_cents": round(each, 2),
                     "unit": normalised_unit_price(round(each), r["price_per"], a)}
        out.append({
            **({"_pid": r["retailer_product_id"]} if keep_internal_id else {}),
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
            "seen_at": seen,
        })
    out.sort(key=lambda x: (x["chain"], x["name"].lower()))
    return out


def saving_cents(p: dict[str, Any]) -> float | None:
    """The saving on one item from the store's own prices (was price, or the multibuy price per item)."""
    if p["price_cents"] is None:
        return None
    if p["was_cents"] and p["was_cents"] > p["price_cents"]:
        return p["was_cents"] - p["price_cents"]
    if p["multibuy"] and p["price_cents"] > p["multibuy"]["each_cents"]:
        return round(p["price_cents"] - p["multibuy"]["each_cents"], 2)
    return None


def specials_only(products: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every current special, biggest saving first. Sponsored items never get this far (collectors drop them)."""
    # Kept small for phones: no empty fields, and nothing the app doesn't show.
    drop = {"category", "seen_at", "store_ref"}
    out = []
    for p in products:
        if p["special"]:
            row = {k: v for k, v in p.items() if not k.startswith("_") and k not in drop and v is not None}
            row["saving_cents"] = saving_cents(p)
            out.append(row)
    out.sort(key=lambda p: (-(p.get("saving_cents") or 0), p["name"].lower()))
    return out


def build_status(conn: sqlite3.Connection, product_counts: dict[str, int],
                 special_counts: dict[str, int] | None = None) -> dict[str, Any]:
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
            # Stopped after the store refused us: its last prices still show until they run out.
            "stopped_after_block": bool(blocked_since_resume(conn, chain)),
            "last_updated": last_ok,
            "last_attempt": {k: last[k] for k in ("status", "started_at", "run_where")} if last else None,
            "products": product_counts.get(chain, 0),
            "specials": (special_counts or {}).get(chain, 0),
        })
    return {"generated_at": iso(now_utc()), "stores": stores}


def export_site(conn: sqlite3.Connection, out_dir: Path = SITE_DATA,
                products: list[dict[str, Any]] | None = None) -> dict[str, dict[str, int]]:
    """Write the public files. Returns per-store counts of products and specials."""
    products = build_products(conn) if products is None else products
    specials = specials_only(products)
    counts: dict[str, int] = {}
    special_counts: dict[str, int] = {}
    for p in products:
        counts[p["chain"]] = counts.get(p["chain"], 0) + 1
    for p in specials:
        special_counts[p["chain"]] = special_counts.get(p["chain"], 0) + 1
    out_dir.mkdir(parents=True, exist_ok=True)
    changed = _write_json(out_dir / "specials.json", {
        "generated_at": iso(now_utc()), "cycle_started": weekly_cycle(2, now_utc())[0].date().isoformat(),
        "stores": [{"chain": c, "name": STORE_NAMES.get(c, c)} for c in config.settings()["chains"]],
        "specials": specials})
    _write_json(out_dir / "status.json", build_status(conn, counts, special_counts))
    # Earlier versions published products.json and watchlist.json here: never again (watchlist is private).
    for old in ("products.json", "watchlist.json"):
        (out_dir / old).unlink(missing_ok=True)
    return {"products": counts, "specials": special_counts, "changed": changed}


def _write_json(path: Path, data: Any) -> bool:
    """Write the file only if something besides its date changed, so a check with nothing new commits nothing.
    Returns whether it was written."""
    try:
        old = json.loads(path.read_text(encoding="utf-8"))
        if {k: v for k, v in old.items() if k != "generated_at"} == {k: v for k, v in data.items() if k != "generated_at"}:
            return False
    except (OSError, ValueError, AttributeError):
        pass
    path.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    return True
