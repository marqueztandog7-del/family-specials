"""SQLite access: schema setup and writing collected items."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import zlib
from importlib import resources
from pathlib import Path
from typing import Any

from . import config
from .models import NormalisedItem, Observation
from .parsing import PARSER_VERSION, is_own_brand, normalise_gtin, parse_size
from .timeutil import now_iso

SCHEMA_VERSION = 3


def connect(path: Path | None = None) -> sqlite3.Connection:
    path = Path(path or config.DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    init_schema(conn)
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    sql = resources.files("family_specials").joinpath("schema.sql").read_text(encoding="utf-8")
    conn.executescript(sql)
    row = conn.execute("SELECT version FROM schema_version").fetchone()
    if row is None:
        conn.execute("INSERT INTO schema_version(version) VALUES (?)", (SCHEMA_VERSION,))
    else:
        _migrate(conn, row["version"])
    if conn.execute("SELECT COUNT(*) FROM households").fetchone()[0] == 0:
        hh = config.settings().get("household", {})
        conn.execute(
            "INSERT INTO households(name, postcode, created_at) VALUES (?, ?, ?)",
            (hh.get("name", "Our household"), hh.get("postcode"), now_iso()),
        )
    conn.commit()


def _migrate(conn: sqlite3.Connection, version: int) -> None:
    """Upgrade an existing database in place. Never drops data."""
    if version < 2:
        # v2: compress the raw price JSON kept with each observation (about 5x smaller).
        conn.execute("ALTER TABLE price_observations RENAME COLUMN raw_price_json TO raw_price_z")
        rows = conn.execute("SELECT id, raw_price_z FROM price_observations").fetchall()
        conn.executemany(
            "UPDATE price_observations SET raw_price_z = ? WHERE id = ?",
            [(zlib.compress(r["raw_price_z"].encode(), 6), r["id"]) for r in rows if isinstance(r["raw_price_z"], str)],
        )
        conn.execute("UPDATE schema_version SET version = 2")
    if version < 3:
        # v3: where each run happened, and whether it's been written to the repo's history files.
        conn.execute("ALTER TABLE collection_runs ADD COLUMN run_where TEXT")
        conn.execute("ALTER TABLE collection_runs ADD COLUMN published INTEGER NOT NULL DEFAULT 0")
        conn.execute("UPDATE schema_version SET version = 3")
    conn.commit()


def load_raw_price(blob: bytes | None) -> dict[str, Any]:
    return json.loads(zlib.decompress(blob)) if blob else {}


# --------------------------------------------------------------------------- stores


def ensure_store(conn: sqlite3.Connection, chain: str, store_ref: str) -> int:
    row = conn.execute("SELECT id FROM stores WHERE chain = ? AND store_ref = ?", (chain, store_ref)).fetchone()
    if row:
        return row["id"]
    cfg = config.chain_config(chain).get("store", {})
    if str(cfg.get("ref")) == store_ref:
        name, suburb, postcode = cfg.get("name"), cfg.get("suburb"), cfg.get("postcode")
        scope, notes = cfg.get("price_scope", "store"), cfg.get("notes")
    elif cfg.get("price_scope") == "default_online_store":
        # Woolworths picks a default store for anonymous visitors, and it changes over time.
        name, suburb, postcode = f"Woolworths default online store (#{store_ref})", None, None
        scope, notes = "default_online_store", "Store Woolworths chose for anonymous visitors"
    else:
        # The store priced us at a different store than configured: record exactly that.
        name, suburb, postcode = f"{chain} store {store_ref}", None, None
        scope, notes = "store", "Reported by the store; differs from the configured store"
    cur = conn.execute(
        "INSERT INTO stores(chain, store_ref, name, suburb, postcode, price_scope, notes) VALUES (?,?,?,?,?,?,?)",
        (chain, store_ref, name or f"{chain} {store_ref}", suburb, postcode, scope, notes),
    )
    return cur.lastrowid


# --------------------------------------------------------------------------- runs


def start_run(conn: sqlite3.Connection, chain: str, kind: str) -> int:
    where = os.environ.get("SPECIALS_RUN_WHERE") or ("github" if os.environ.get("GITHUB_ACTIONS") else "mac")
    cur = conn.execute(
        "INSERT INTO collection_runs(chain, kind, started_at, status, run_where) VALUES (?, ?, ?, 'running', ?)",
        (chain, kind, now_iso(), where),
    )
    conn.commit()
    return cur.lastrowid


def finish_run(conn: sqlite3.Connection, run_id: int, status: str, requests_made: int,
               items_seen: int, observations_added: int, error: str | None = None) -> None:
    conn.execute(
        """UPDATE collection_runs SET finished_at = ?, status = ?, requests_made = ?,
           items_seen = ?, observations_added = ?, error = ? WHERE id = ?""",
        (now_iso(), status, requests_made, items_seen, observations_added, error, run_id),
    )
    conn.commit()


def add_coverage(conn: sqlite3.Connection, run_id: int, cov) -> None:
    conn.execute(
        """INSERT INTO run_coverage(run_id, scope_type, scope_ref, scope_name, pages_read, pages_total,
           items_seen, items_total, complete) VALUES (?,?,?,?,?,?,?,?,?)""",
        (run_id, cov.scope_type, cov.scope_ref, cov.scope_name, cov.pages_read, cov.pages_total,
         cov.items_seen, cov.items_total, int(cov.complete)),
    )


# --------------------------------------------------------------------------- items


def save_item(conn: sqlite3.Connection, run_id: int, item: NormalisedItem, source: str) -> int:
    """Upsert the product, its barcodes, raw snapshot and attributes; append observations.
    Returns the number of observations added."""
    ts = now_iso()
    p = item.product
    row = conn.execute(
        "SELECT id FROM retailer_products WHERE chain = ? AND retailer_product_id = ?",
        (p.chain, p.retailer_product_id),
    ).fetchone()
    if row:
        product_id = row["id"]
        conn.execute(
            """UPDATE retailer_products SET name = ?, display_name = ?, brand = ?, size_text = ?, url = ?,
               image_url = ?, category_path = COALESCE(?, category_path), last_seen_at = ? WHERE id = ?""",
            (p.name, p.display_name, p.brand, p.size_text, p.url, p.image_url, p.category_path, ts, product_id),
        )
    else:
        product_id = conn.execute(
            """INSERT INTO retailer_products(chain, retailer_product_id, name, display_name, brand, size_text,
               url, image_url, category_path, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (p.chain, p.retailer_product_id, p.name, p.display_name, p.brand, p.size_text, p.url,
             p.image_url, p.category_path, ts, ts),
        ).lastrowid

    for g in item.gtins:
        gt = normalise_gtin(g.raw)
        if gt:
            conn.execute(
                """INSERT OR IGNORE INTO retailer_product_gtins(retailer_product_id, gtin14, gtin_raw, is_global,
                   source, first_seen_at) VALUES (?,?,?,?,?,?)""",
                (product_id, gt.gtin14, gt.raw, int(gt.is_global), g.source, ts),
            )

    _save_snapshot(conn, product_id, item.raw_product, ts)
    save_attributes(conn, product_id, p.chain, p.brand, p.size_text, p.display_name or p.name, ts)

    raw_price = zlib.compress(json.dumps(item.raw_price, separators=(",", ":"), sort_keys=True,
                                         default=str).encode(), 6)
    for obs in item.observations:
        store_id = ensure_store(conn, p.chain, obs.store_ref)
        _insert_observation(conn, run_id, product_id, store_id, ts, source, obs, raw_price)
    return len(item.observations)


def _save_snapshot(conn: sqlite3.Connection, product_id: int, raw: dict[str, Any], ts: str) -> None:
    body = json.dumps(raw, separators=(",", ":"), sort_keys=True, default=str).encode()
    digest = hashlib.sha256(body).hexdigest()
    updated = conn.execute(
        "UPDATE raw_snapshots SET last_seen_at = ? WHERE retailer_product_id = ? AND content_hash = ?",
        (ts, product_id, digest),
    ).rowcount
    if not updated:
        conn.execute(
            """INSERT INTO raw_snapshots(retailer_product_id, content_hash, payload, first_seen_at, last_seen_at)
               VALUES (?,?,?,?,?)""",
            (product_id, digest, zlib.compress(body, 6), ts, ts),
        )


def save_attributes(conn: sqlite3.Connection, product_id: int, chain: str, brand: str | None,
                     size_text: str | None, name: str, ts: str) -> None:
    s = parse_size(size_text, name)
    own = is_own_brand(chain, brand, config.own_brands())
    conn.execute(
        """INSERT INTO product_attributes(retailer_product_id, parser_version, brand, own_brand, size_quantity,
           size_unit, pack_count, total_quantity, base_unit, count_noun, comparable, not_comparable_reason, parsed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(retailer_product_id) DO UPDATE SET parser_version = excluded.parser_version,
             brand = excluded.brand, own_brand = excluded.own_brand, size_quantity = excluded.size_quantity,
             size_unit = excluded.size_unit, pack_count = excluded.pack_count,
             total_quantity = excluded.total_quantity, base_unit = excluded.base_unit,
             count_noun = excluded.count_noun, comparable = excluded.comparable,
             not_comparable_reason = excluded.not_comparable_reason, parsed_at = excluded.parsed_at""",
        (product_id, PARSER_VERSION, brand, None if own is None else int(own), s.size_quantity, s.size_unit,
         s.pack_count, s.total_quantity, s.base_unit, s.count_noun, int(s.comparable), s.reason, ts),
    )


def _insert_observation(conn: sqlite3.Connection, run_id: int, product_id: int, store_id: int, ts: str,
                        source: str, o: Observation, raw_price: bytes) -> None:
    conn.execute(
        """INSERT INTO price_observations(run_id, retailer_product_id, store_id, observed_at, source, price_basis,
           price_per, price_cents, was_cents, rrp_cents, is_special, special_type, promo_text, multibuy_qty,
           multibuy_cents, member_only, member_price_cents, unit_price, unit_measure, unit_price_text,
           valid_from, valid_to, valid_to_source, in_stock, raw_price_z)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (run_id, product_id, store_id, ts, source, o.price_basis, o.price_per, o.price_cents, o.was_cents,
         o.rrp_cents, int(o.is_special), o.special_type, o.promo_text, o.multibuy_qty, o.multibuy_cents,
         int(o.member_only), o.member_price_cents, o.unit_price, o.unit_measure, o.unit_price_text,
         o.valid_from, o.valid_to, o.valid_to_source, None if o.in_stock is None else int(o.in_stock),
         raw_price),
    )


def save_categories(conn: sqlite3.Connection, chain: str, categories) -> int:
    ts = now_iso()
    for c in categories:
        conn.execute(
            """INSERT INTO store_categories(chain, category_ref, name, path, url_path, product_count, discovered_at)
               VALUES (?,?,?,?,?,?,?) ON CONFLICT(chain, category_ref) DO UPDATE SET name = excluded.name,
               path = excluded.path, url_path = excluded.url_path, product_count = excluded.product_count,
               discovered_at = excluded.discovered_at""",
            (chain, c.category_ref, c.name, c.path, c.url_path, c.product_count, ts),
        )
    conn.commit()
    return len(categories)
