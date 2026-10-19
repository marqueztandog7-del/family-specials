"""History files in the repo, the public-data scope, and the page data export."""

import json
from pathlib import Path

from family_specials import config, db
from family_specials.collectors import get_collector_class
from family_specials.collectors.base import RawItem
from family_specials.export import build_products, normalised_unit_price
from family_specials.history import import_history, publish_new_runs, scope_product_ids

FIXTURES = Path(__file__).parent / "fixtures"


def _run(conn, chain, kind, source, ctx=None):
    c = get_collector_class(chain)(config.chain_config(chain), client=None)
    run_id = db.start_run(conn, chain, kind)
    for raw in json.loads((FIXTURES / f"{chain}.json").read_text()):
        item = c.normalise(RawItem(raw, ctx or {}))
        if item:
            db.save_item(conn, run_id, item, source)
    db.finish_run(conn, run_id, "ok", 1, 0, 0)
    conn.commit()
    return run_id


HALF = {"special_type": "half_price", "weekly": True}


def test_history_holds_specials_only(tmp_path):
    """Since 19 Oct 2026 the public history holds specials at every store and nothing chosen by our watchlist:
    regular prices (from category or full-range reads) stay in the database on the Mac."""
    hist = tmp_path / "history"
    conn = db.connect(tmp_path / "a.db")
    _run(conn, "aldi", "category", "category")           # regular prices only
    assert scope_product_ids(conn) == set()
    assert publish_new_runs(conn, hist)["observations"] == 0
    _run(conn, "woolworths", "category", "category", HALF)
    assert len(scope_product_ids(conn)) > 0
    publish_new_runs(conn, hist)
    rows = [line for f in hist.glob("observations/*.csv") for line in f.read_text().splitlines()[1:]]
    assert rows and all(line.split(",")[11] == "1" for line in rows)          # is_special
    products = "".join(f.read_text() for f in hist.glob("products/*.csv"))
    assert "aldi" not in {f.stem for f in hist.glob("products/*.csv")}
    assert all(line.endswith(",") for line in products.splitlines()[1:])     # no tracked-category links


def test_history_round_trip_rebuilds_the_same_page_data(tmp_path):
    hist = tmp_path / "history"
    a = db.connect(tmp_path / "a.db")
    _run(a, "woolworths", "category", "category", HALF)
    _run(a, "aldi", "category", "category", {"special_type": "special_buy", "is_special": True})
    counts = publish_new_runs(a, hist)
    assert counts["runs"] == 2 and counts["observations"] > 0
    assert publish_new_runs(a, hist)["runs"] == 0    # nothing published twice

    b = db.connect(tmp_path / "b.db")                # a fresh database, like a GitHub run
    loaded = import_history(b, hist)
    assert loaded["runs"] == 2
    assert import_history(b, hist)["runs"] == 0      # importing twice adds nothing

    pa = {p["id"]: p for p in build_products(a) if p["special"]}     # the public history has the specials
    pb = {p["id"]: p for p in build_products(b)}
    assert pa and pa.keys() == pb.keys()
    for key in pa:
        assert pa[key]["price_cents"] == pb[key]["price_cents"]
        assert pa[key]["unit"] == pb[key]["unit"]


def test_history_keeps_woolworths_in_store_price_and_drops_identical_online_copy(tmp_path):
    hist = tmp_path / "history"
    a = db.connect(tmp_path / "a.db")
    _run(a, "woolworths", "category", "category", HALF)
    publish_new_runs(a, hist)
    rows = (hist / "observations").glob("woolworths-*.csv")
    lines = [line for f in rows for line in f.read_text().splitlines()[1:]]
    assert lines and all(",in_store," in line or ",online," in line for line in lines)
    assert sum(",in_store," in line for line in lines) >= sum(",online," in line for line in lines)


def test_no_member_prices_or_raw_data_in_history(tmp_path):
    hist = tmp_path / "history"
    a = db.connect(tmp_path / "a.db")
    _run(a, "woolworths", "category", "category", HALF)
    publish_new_runs(a, hist)
    text = "".join(f.read_text() for f in hist.rglob("*.csv"))
    header = (next(hist.glob("observations/*.csv"))).read_text().splitlines()[0]
    assert "member" not in header
    assert "AdditionalAttributes" not in text and "InstorePrice" not in text


class _Attrs(dict):
    def __getitem__(self, k):
        return self.get(k)


def test_normalised_unit_price():
    two_litres = _Attrs(comparable=1, total_quantity=2000, base_unit="ml")
    assert normalised_unit_price(310, "each", two_litres) == {"cents": 155.0, "per": "L"}
    five_kg = _Attrs(comparable=1, total_quantity=5000, base_unit="g")
    assert normalised_unit_price(1350, "each", five_kg) == {"cents": 270.0, "per": "kg"}
    rolls = _Attrs(comparable=1, total_quantity=36, base_unit="each", count_noun="roll")
    assert normalised_unit_price(1699, "each", rolls) == {"cents": 47.19, "per": "roll"}
    assert normalised_unit_price(1299, "kg", None) == {"cents": 1299.0, "per": "kg"}   # weighed: already per kg
    assert normalised_unit_price(400, "each", _Attrs(comparable=0)) is None           # never guess a size


def test_one_listing_per_product_even_if_the_store_changes(tmp_path):
    conn = db.connect(tmp_path / "a.db")
    _run(conn, "costco", "category", "category")
    pid, code = conn.execute("SELECT id, retailer_product_id FROM retailer_products LIMIT 1").fetchone()
    # A later run where the store priced us at a different store (as Woolworths did on 12 Oct).
    later = db.start_run(conn, "costco", "category")
    conn.execute("UPDATE collection_runs SET started_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','+1 hour') WHERE id = ?",
                 (later,))
    other = db.ensure_store(conn, "costco", "some-other-store")
    conn.execute(
        """INSERT INTO price_observations(run_id, retailer_product_id, store_id, observed_at, source, price_basis,
           price_per, price_cents, is_special) VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'),
           'category','online','each',123,0)""", (later, pid, other))
    conn.commit()
    listings = [p for p in build_products(conn) if p["id"] == f"costco:{code}"]
    assert len(listings) == 1
    assert listings[0]["store_ref"] == "some-other-store" and listings[0]["price_cents"] == 123  # latest run wins
