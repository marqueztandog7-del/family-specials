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


def test_scope_only_includes_tracked_category_products(tmp_path):
    conn = db.connect(tmp_path / "a.db")
    _run(conn, "costco", "specials", "specials")
    assert scope_product_ids(conn) == set()          # specials alone are never published
    _run(conn, "costco", "category", "category")
    assert len(scope_product_ids(conn)) > 0


def test_history_round_trip_rebuilds_the_same_page_data(tmp_path):
    hist = tmp_path / "history"
    a = db.connect(tmp_path / "a.db")
    _run(a, "woolworths", "category", "category", {"special_type": "half_price", "weekly": True})
    _run(a, "aldi", "category", "category")
    counts = publish_new_runs(a, hist)
    assert counts["runs"] == 2 and counts["observations"] > 0
    assert publish_new_runs(a, hist)["runs"] == 0    # nothing published twice

    b = db.connect(tmp_path / "b.db")                # a fresh database, like a GitHub run
    loaded = import_history(b, hist)
    assert loaded["runs"] == 2
    assert import_history(b, hist)["runs"] == 0      # importing twice adds nothing

    pa = {p["id"]: p for p in build_products(a)}
    pb = {p["id"]: p for p in build_products(b)}
    assert pa.keys() == pb.keys()
    for key in pa:
        assert pa[key]["price_cents"] == pb[key]["price_cents"]
        assert pa[key]["unit"] == pb[key]["unit"]


def test_history_keeps_woolworths_in_store_price_and_drops_identical_online_copy(tmp_path):
    hist = tmp_path / "history"
    a = db.connect(tmp_path / "a.db")
    _run(a, "woolworths", "category", "category")
    publish_new_runs(a, hist)
    rows = (hist / "observations").glob("woolworths-*.csv")
    lines = [line for f in rows for line in f.read_text().splitlines()[1:]]
    assert lines and all(",in_store," in line or ",online," in line for line in lines)
    assert sum(",in_store," in line for line in lines) >= sum(",online," in line for line in lines)


def test_no_member_prices_or_raw_data_in_history(tmp_path):
    hist = tmp_path / "history"
    a = db.connect(tmp_path / "a.db")
    _run(a, "woolworths", "category", "category")
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
    pid = conn.execute("SELECT id FROM retailer_products LIMIT 1").fetchone()[0]
    other = db.ensure_store(conn, "costco", "some-other-store")
    row = conn.execute("SELECT * FROM price_observations WHERE retailer_product_id = ?", (pid,)).fetchone()
    conn.execute(
        """INSERT INTO price_observations(run_id, retailer_product_id, store_id, observed_at, source, price_basis,
           price_per, price_cents, is_special) VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now','+1 minute'),
           'category','online','each',?,0)""", (row["run_id"], pid, other, (row["price_cents"] or 100) + 50))
    conn.commit()
    listings = [p for p in build_products(conn) if p["id"].endswith(":" + conn.execute(
        "SELECT retailer_product_id FROM retailer_products WHERE id = ?", (pid,)).fetchone()[0])]
    assert len(listings) == 1 and listings[0]["store_ref"] == "some-other-store"  # the latest price wins
