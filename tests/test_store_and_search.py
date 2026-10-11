"""Saving items (append-only history, barcodes, snapshots) and searching them."""

import json
from pathlib import Path

from family_specials import config, db
from family_specials.collectors import get_collector_class
from family_specials.collectors.base import RawItem
from family_specials.search import search

FIXTURES = Path(__file__).parent / "fixtures"


def _load(conn, chain, ctx=None):
    c = get_collector_class(chain)(config.chain_config(chain), client=None)
    run_id = db.start_run(conn, chain, "specials")
    for raw in json.loads((FIXTURES / f"{chain}.json").read_text()):
        item = c.normalise(RawItem(raw, ctx or {}))
        if item:
            db.save_item(conn, run_id, item, "specials")
    db.finish_run(conn, run_id, "ok", 0, 0, 0)
    conn.commit()


def test_history_is_append_only_and_snapshots_dedupe(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    _load(conn, "costco")
    _load(conn, "costco")  # same items seen again
    products = conn.execute("SELECT COUNT(*) FROM retailer_products").fetchone()[0]
    observations = conn.execute("SELECT COUNT(*) FROM price_observations").fetchone()[0]
    snapshots = conn.execute("SELECT COUNT(*) FROM raw_snapshots").fetchone()[0]
    assert observations == 2 * products      # every sighting kept
    assert snapshots == products             # unchanged product data stored once


def test_barcodes_saved_normalised(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    _load(conn, "woolworths", {"special_type": "half_price", "weekly": True})
    rows = conn.execute("SELECT gtin14, source FROM retailer_product_gtins").fetchall()
    assert rows and all(len(r["gtin14"]) == 14 and r["source"] == "listing" for r in rows)


def test_search_prefers_in_store_and_filters_specials(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    _load(conn, "woolworths", {"special_type": "half_price", "weekly": True})
    name = json.loads((FIXTURES / "woolworths.json").read_text())[0]["Name"]
    word = name.split()[0][:4].lower()  # prefix search: "easy" -> "Easy-Off"
    results = search(conn, word, specials_only=True)
    assert results, f"no results for {word!r}"
    assert all(r["is_special"] for r in results)
    assert all(r["price_basis"] == "in_store" for r in results if r["chain"] == "woolworths")
    # One row per product per store, even though Woolworths gives in-store and online prices.
    assert len({r["product_id"] for r in results}) == len(results)


def test_expired_specials_are_hidden(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    _load(conn, "costco")
    word = json.loads((FIXTURES / "costco.json").read_text())[0]["name"].split()[0].lower()
    assert search(conn, word, specials_only=True)
    conn.execute("UPDATE price_observations SET valid_to = '2020-01-01T00:00:00Z' WHERE is_special = 1")
    conn.commit()
    assert search(conn, word, specials_only=True) == []
