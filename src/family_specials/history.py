"""Price history kept in the repo as small, append-only CSV files.

GitHub's servers start empty on every run, so the repo is where history lives:

  history/runs/<chain>.csv               every collection run (where, when, status)
  history/products/<chain>.csv           product details and barcodes, one row per product
  history/observations/<chain>-<year>.csv  one row per price seen; rows are only ever appended

Only specials are written, at every store, whatever we watch (since 19 Oct 2026: which products we read or match
says what our family buys, so nothing chosen by the watchlist goes in the public repo). Regular prices, the full
ranges, member prices and raw store data stay in the local database on the Mac (backed up to iCloud).

Every update first imports these files into the (local or fresh) SQLite database, then
collects, then appends the new runs.
"""

from __future__ import annotations

import csv
import sqlite3
from datetime import timedelta
from pathlib import Path
from typing import Any

from . import config, db
from .parsing import normalise_gtin
from .timeutil import iso, now_utc

HISTORY_DIR = config.PROJECT_ROOT / "history"
SCOPE_WEEKS = 12

RUN_FIELDS = ["chain", "kind", "run_where", "started_at", "finished_at", "status", "requests_made",
              "items_seen", "observations_added", "error"]
PRODUCT_FIELDS = ["product_id", "name", "display_name", "brand", "size_text", "url", "image_url",
                  "category_path", "gtins", "first_seen_at", "last_seen_at", "categories"]
OBS_FIELDS = ["run_started_at", "run_kind", "observed_at", "store_ref", "product_id", "source", "price_basis",
              "price_per", "price_cents", "was_cents", "rrp_cents", "is_special", "special_type", "promo_text",
              "multibuy_qty", "multibuy_cents", "unit_price", "unit_measure", "unit_price_text", "valid_from",
              "valid_to", "valid_to_source", "in_stock"]


# --------------------------------------------------------------------------- scope


def scope_product_ids(conn: sqlite3.Connection) -> set[int]:
    """Products that have been on special at some point: the only ones whose prices go in the public history."""
    return {r[0] for r in conn.execute("SELECT DISTINCT retailer_product_id FROM price_observations WHERE is_special = 1")}


# --------------------------------------------------------------------------- publish (DB -> files)


def publish_new_runs(conn: sqlite3.Connection, history_dir: Path = HISTORY_DIR) -> dict[str, int]:
    """Append every finished, unpublished run (and its in-scope prices) to the history files."""
    scope = scope_product_ids(conn)
    runs = conn.execute(
        "SELECT * FROM collection_runs WHERE published = 0 AND status != 'running' ORDER BY id").fetchall()
    counts = {"runs": 0, "observations": 0}
    touched: dict[str, set[int]] = {}
    for run in runs:
        # One file per store, so a GitHub run and a Mac run never edit the same file.
        _append(history_dir / "runs" / f"{run['chain']}.csv", RUN_FIELDS, [{
            **{k: run[k] for k in RUN_FIELDS if k != "error"},
            "error": (run["error"] or "").splitlines()[0][:200] if run["error"] else "",
        }])
        rows = _publishable_observations(conn, run, scope)
        by_file: dict[Path, list[dict[str, Any]]] = {}
        for r in rows:
            by_file.setdefault(history_dir / "observations" / f"{run['chain']}-{r['observed_at'][:4]}.csv",
                               []).append(r)
            touched.setdefault(run["chain"], set()).add(r["_pid"])
        for path, file_rows in by_file.items():
            _append(path, OBS_FIELDS, file_rows)
        conn.execute("UPDATE collection_runs SET published = 1 WHERE id = ?", (run["id"],))
        counts["runs"] += 1
        counts["observations"] += len(rows)
    for chain, pids in touched.items():
        _write_products(conn, chain, pids, history_dir / "products" / f"{chain}.csv")
    conn.commit()
    return counts


def _publishable_observations(conn, run, scope: set[int]) -> list[dict[str, Any]]:
    rows = conn.execute(
        """SELECT o.*, p.retailer_product_id AS store_product_id, s.store_ref
           FROM price_observations o JOIN retailer_products p ON p.id = o.retailer_product_id
           JOIN stores s ON s.id = o.store_id WHERE o.run_id = ? ORDER BY o.id""", (run["id"],)).fetchall()
    rows = [r for r in rows if r["retailer_product_id"] in scope and r["is_special"]]
    # Woolworths gives an in-store and an online price for every product. Keep the in-store one,
    # and the online one only when it actually differs (e.g. an online-only special).
    in_store = {r["retailer_product_id"]: r for r in rows if r["price_basis"] == "in_store"}
    out = []
    for r in rows:
        if r["price_basis"] == "online" and r["retailer_product_id"] in in_store:
            s = in_store[r["retailer_product_id"]]
            if (r["price_cents"], r["is_special"], r["multibuy_cents"]) == (s["price_cents"], s["is_special"],
                                                                           s["multibuy_cents"]):
                continue
        out.append({
            "_pid": r["retailer_product_id"],
            "run_started_at": run["started_at"], "run_kind": run["kind"], "observed_at": r["observed_at"],
            "store_ref": r["store_ref"], "product_id": r["store_product_id"],
            **{k: r[k] for k in OBS_FIELDS if k not in ("run_started_at", "run_kind", "observed_at", "store_ref",
                                                         "product_id")},
        })
    return out


def _write_products(conn, chain: str, pids: set[int], path: Path) -> None:
    existing = {row["product_id"]: row for row in _read(path)}
    for p in conn.execute(
        f"SELECT * FROM retailer_products WHERE id IN ({','.join('?' * len(pids))})", list(pids)
    ):
        gtins = "|".join(f"{g['gtin14']}:{g['source']}:{g['is_global']}" for g in conn.execute(
            "SELECT * FROM retailer_product_gtins WHERE retailer_product_id = ? ORDER BY gtin14", (p["id"],)))
        old = existing.get(p["retailer_product_id"], {})
        existing[p["retailer_product_id"]] = {
            "product_id": p["retailer_product_id"], "name": p["name"], "display_name": p["display_name"] or "",
            "brand": p["brand"] or "", "size_text": p["size_text"] or "", "url": p["url"] or "",
            "image_url": p["image_url"] or "", "category_path": p["category_path"] or "", "gtins": gtins,
            "first_seen_at": min(filter(None, [old.get("first_seen_at"), p["first_seen_at"]])),
            "last_seen_at": max(filter(None, [old.get("last_seen_at"), p["last_seen_at"]])),
            # Which of our tracked categories a product was read in says what we watch: not published.
            "categories": "",
        }
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=PRODUCT_FIELDS, lineterminator="\n")
        w.writeheader()
        for key in sorted(existing):
            w.writerow({k: existing[key].get(k, "") for k in PRODUCT_FIELDS})


# --------------------------------------------------------------------------- import (files -> DB)


def import_history(conn: sqlite3.Connection, history_dir: Path = HISTORY_DIR) -> dict[str, int]:
    """Load history files into the database, skipping runs it already has."""
    counts = {"products": 0, "runs": 0, "observations": 0}
    product_ids: dict[tuple[str, str], int] = {}
    for path in sorted((history_dir / "products").glob("*.csv")):
        chain = path.stem
        for row in _read(path):
            product_ids[(chain, row["product_id"])] = _upsert_product(conn, chain, row)
            counts["products"] += 1

    have = {(r["chain"], r["kind"], r["started_at"]) for r in conn.execute(
        "SELECT chain, kind, started_at FROM collection_runs")}
    new_runs: dict[tuple[str, str, str], int] = {}
    for row in (r for path in sorted((history_dir / "runs").glob("*.csv")) for r in _read(path)):
        key = (row["chain"], row["kind"], row["started_at"])
        if key in have:
            continue
        new_runs[key] = conn.execute(
            """INSERT INTO collection_runs(chain, kind, started_at, finished_at, status, requests_made, items_seen,
               observations_added, error, run_where, published) VALUES (?,?,?,?,?,?,?,?,?,?,1)""",
            (row["chain"], row["kind"], row["started_at"], row["finished_at"] or None, row["status"],
             _int(row["requests_made"]) or 0, _int(row["items_seen"]) or 0, _int(row["observations_added"]) or 0,
             row["error"] or None, row["run_where"] or None)).lastrowid
        counts["runs"] += 1

    for path in sorted((history_dir / "observations").glob("*.csv")):
        chain = path.stem.rsplit("-", 1)[0]
        for row in _read(path):
            run_id = new_runs.get((chain, row["run_kind"], row["run_started_at"]))
            pid = product_ids.get((chain, row["product_id"]))
            if run_id is None or pid is None:
                continue  # run already in this database, or product file missing (never fake one)
            store_id = db.ensure_store(conn, chain, row["store_ref"])
            conn.execute(
                """INSERT INTO price_observations(run_id, retailer_product_id, store_id, observed_at, source,
                   price_basis, price_per, price_cents, was_cents, rrp_cents, is_special, special_type, promo_text,
                   multibuy_qty, multibuy_cents, member_only, unit_price, unit_measure, unit_price_text, valid_from,
                   valid_to, valid_to_source, in_stock) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)""",
                (run_id, pid, store_id, row["observed_at"], row["source"], row["price_basis"], row["price_per"],
                 _int(row["price_cents"]), _int(row["was_cents"]), _int(row["rrp_cents"]), _int(row["is_special"]),
                 row["special_type"] or None, row["promo_text"] or None, _int(row["multibuy_qty"]),
                 _int(row["multibuy_cents"]), _float(row["unit_price"]), row["unit_measure"] or None,
                 row["unit_price_text"] or None, row["valid_from"] or None, row["valid_to"] or None,
                 row["valid_to_source"] or None, _int(row["in_stock"])))
            counts["observations"] += 1
    conn.commit()
    return counts


def _upsert_product(conn, chain: str, row: dict[str, str]) -> int:
    existing = conn.execute("SELECT id, last_seen_at FROM retailer_products WHERE chain = ? AND retailer_product_id = ?",
                            (chain, row["product_id"])).fetchone()
    if existing:
        pid = existing["id"]
        if (row["last_seen_at"] or "") > (existing["last_seen_at"] or ""):
            conn.execute(
                """UPDATE retailer_products SET name = ?, display_name = ?, brand = ?, size_text = ?, url = ?,
                   image_url = ?, category_path = ?, last_seen_at = ? WHERE id = ?""",
                (row["name"], row["display_name"] or None, row["brand"] or None, row["size_text"] or None,
                 row["url"] or None, row["image_url"] or None, row["category_path"] or None, row["last_seen_at"], pid))
    else:
        pid = conn.execute(
            """INSERT INTO retailer_products(chain, retailer_product_id, name, display_name, brand, size_text, url,
               image_url, category_path, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (chain, row["product_id"], row["name"], row["display_name"] or None, row["brand"] or None,
             row["size_text"] or None, row["url"] or None, row["image_url"] or None, row["category_path"] or None,
             row["first_seen_at"], row["last_seen_at"])).lastrowid
        db.save_attributes(conn, pid, chain, row["brand"] or None, row["size_text"] or None,
                           row["display_name"] or row["name"], row["last_seen_at"])
    for ref in filter(None, (row.get("categories") or "").split("|")):
        conn.execute(
            """INSERT OR IGNORE INTO product_categories(retailer_product_id, category_ref, first_seen_at, last_seen_at)
               VALUES (?,?,?,?)""", (pid, ref, row["first_seen_at"], row["last_seen_at"]))
    for part in filter(None, (row.get("gtins") or "").split("|")):
        gtin14, source, is_global = (part.split(":") + ["", ""])[:3]
        if normalise_gtin(gtin14):
            conn.execute(
                """INSERT OR IGNORE INTO retailer_product_gtins(retailer_product_id, gtin14, gtin_raw, is_global,
                   source, first_seen_at) VALUES (?,?,?,?,?,?)""",
                (pid, gtin14, gtin14, int(is_global or 1), source or "history", row["first_seen_at"]))
    return pid


# --------------------------------------------------------------------------- csv helpers


def _append(path: Path, fields: list[str], rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore", lineterminator="\n")
        if new:
            w.writeheader()
        for r in rows:
            w.writerow({k: _cell(r.get(k)) for k in fields})


def _read(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _cell(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float):
        return f"{v:g}"
    return str(v)


def _int(v: str | None) -> int | None:
    return int(v) if v not in (None, "") else None


def _float(v: str | None) -> float | None:
    return float(v) if v not in (None, "") else None


def specials_only(history_dir: Path = HISTORY_DIR) -> dict[str, int]:
    """Rewrite the history files to hold specials only (19 Oct 2026): drops every regular-price row, and every
    product that has never been on special. The full history stays in the database on the Mac."""
    kept = {"observations": 0, "dropped": 0, "products": 0}
    special_ids: dict[str, set[str]] = {}
    for path in sorted((history_dir / "observations").glob("*.csv")):
        chain = path.stem.rsplit("-", 1)[0]
        rows = _read(path)
        keep = [r for r in rows if r.get("is_special") == "1"]
        kept["observations"] += len(keep)
        kept["dropped"] += len(rows) - len(keep)
        special_ids.setdefault(chain, set()).update(r["product_id"] for r in keep)
        _rewrite(path, OBS_FIELDS, keep)
    for path in sorted((history_dir / "products").glob("*.csv")):
        keep = [{**r, "categories": ""} for r in _read(path) if r["product_id"] in special_ids.get(path.stem, set())]
        kept["products"] += len(keep)
        _rewrite(path, PRODUCT_FIELDS, keep)
    return kept


def rebuild_from_db(conn: sqlite3.Connection, history_dir: Path = HISTORY_DIR) -> dict[str, int]:
    """Rewrite the history files from the database: every run, and every special it has, at every store, with no
    selection by what we watch (19 Oct 2026). Earlier files only kept products in the categories we tracked."""
    for sub in ("runs", "observations", "products"):
        for f in (history_dir / sub).glob("*.csv"):
            f.unlink()
    conn.execute("UPDATE collection_runs SET published = 0 WHERE status != 'running'")
    return publish_new_runs(conn, history_dir)


def _rewrite(path: Path, fields: list[str], rows: list[dict[str, str]]) -> None:
    if not rows:
        path.unlink(missing_ok=True)
        return
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in fields})


def rewrite_products(conn: sqlite3.Connection, history_dir: Path = HISTORY_DIR) -> int:
    """Rewrite every store's product file for all in-scope products (e.g. after a backfill)."""
    scope = scope_product_ids(conn)
    by_chain: dict[str, set[int]] = {}
    for pid, chain in conn.execute("SELECT id, chain FROM retailer_products"):
        if pid in scope:
            by_chain.setdefault(chain, set()).add(pid)
    for chain, pids in by_chain.items():
        _write_products(conn, chain, pids, history_dir / "products" / f"{chain}.csv")
    return sum(len(p) for p in by_chain.values())


def backfill_category_links(conn: sqlite3.Connection) -> dict[str, int]:
    """Rebuild which category each product came from, for category runs made before categories were
    recorded (16 Oct 2026). Only where it's exact: products are saved in the order they're read and
    each category's count is in run_coverage, so if every item read was saved, the order lines up.
    Runs where some items weren't saved (Woolworths items with no price) are skipped, never guessed."""
    done = {"exact_runs": 0, "skipped_runs": 0, "links": 0}
    runs = conn.execute("""SELECT id, chain FROM collection_runs WHERE status IN ('ok', 'partial')
                           AND (kind = 'category' OR chain = 'chemistwarehouse') ORDER BY id""").fetchall()
    for run in runs:
        cov = conn.execute("SELECT scope_ref, items_seen FROM run_coverage WHERE run_id = ? ORDER BY id",
                           (run["id"],)).fetchall()
        groups: list[tuple[int, str]] = []
        prev = None
        for pid, ts in conn.execute("SELECT retailer_product_id, observed_at FROM price_observations WHERE run_id = ? "
                                    "ORDER BY id", (run["id"],)):
            if pid != prev:
                groups.append((pid, ts))
                prev = pid
        if not cov or sum(c["items_seen"] for c in cov) != len(groups):
            done["skipped_runs"] += 1
            continue
        i = 0
        for c in cov:
            ref = c["scope_ref"].removeprefix("query:")
            for pid, ts in groups[i:i + c["items_seen"]]:
                conn.execute(
                    """INSERT INTO product_categories(retailer_product_id, category_ref, first_seen_at, last_seen_at)
                       VALUES (?,?,?,?) ON CONFLICT(retailer_product_id, category_ref) DO UPDATE SET
                       last_seen_at = MAX(last_seen_at, excluded.last_seen_at)""", (pid, ref, ts, ts))
                done["links"] += 1
            i += c["items_seen"]
        done["exact_runs"] += 1
    conn.commit()
    return done
