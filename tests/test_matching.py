"""Matching rules. Examples are made up (receipt lines are private and never committed)."""

from family_specials import db
from family_specials.matching import (
    Product,
    find_by_name,
    has_term,
    match_item,
    normalise,
    run_matching,
    watch_item_for_name,
)
from family_specials.parsing import parse_size
from family_specials.watchlist import WatchItem, add_decision, sync_to_db


def P(pid, chain, name, brand=None, gtins=(), category="", kg=False):
    s = parse_size(name)
    return Product(pid, chain, str(pid), name, normalise(name), normalise(brand) if brand else None, category.lower(),
                   set(gtins), s.total_quantity, s.base_unit, s.size_quantity, s.pack_count, s.comparable, kg)


MINCE = WatchItem("beef-mince", "Beef mince", "core", "similar", "kg", similar={
    "must": ["beef", "mince"], "exclude": ["pork", "burger", "plant"], "brands": "any",
    "size": {"min": "500 g", "max": "2 kg"}})
YOGHURT = WatchItem("greek-yoghurt", "Greek yoghurt", "core", "same_product", "kg",
                    anchor={"chain": "woolworths", "name": "Farmers Union Greek Style High Protein Yoghurt 500g"})
LEEK = WatchItem("leek", "Leek", "core", "same_product", "item",
                 anchor={"chain": "woolworths", "name": "Leek (each)", "generic": True})


def test_normalise_expands_receipt_shorthand():
    assert normalise("WW Beef Mince Bulk 1kg") == "woolworths beef mince bulk 1kg"
    assert normalise("Choc Disinf Wipes 80pk") == "choc disinfectant wipes 80pk"
    assert normalise("Carrots PeasCorn 500g P/P") == "carrots peas corn 500g"
    assert has_term(normalise("Tomato Roma 480g"), "tomatoes")


def test_similar_rule_checks_words_exclusions_and_size():
    products = [
        P(1, "woolworths", "Woolworths Beef Mince 1kg"),
        P(2, "coles", "Coles Beef Mince 500g"),
        P(3, "aldi", "Beef Mince 3kg"),                    # too big
        P(4, "aldi", "Beef And Pork Mince 1kg"),           # excluded word
        P(5, "coles", "Beef Mince Burger Patties 500g"),   # excluded word
        P(6, "coles", "Beef Mince"),                        # size unknown: review, not auto
    ]
    got = {m.product.id: m for m in match_item(MINCE, products)}
    assert set(got) == {1, 2, 6}
    assert got[1].confidence >= 0.85 and got[1].reason.startswith("similar: beef mince, any brand, 500 g to 2 kg")
    assert got[6].confidence < 0.85


def test_same_product_by_barcode_then_brand_and_size():
    products = [
        P(1, "woolworths", "Farmers Union Greek Style High Protein Yoghurt 500g", "Farmers Union", gtins={"09300000000001"}),
        P(2, "coles", "Farmers Union Greek Style Yogurt High Protein 500g", "Farmers Union", gtins={"09300000000001"}),
        P(3, "aldi", "Farmers Union Greek Style High Protein Yoghurt 500g", "Farmers Union"),
        P(4, "aldi", "Farmers Union Greek Style High Protein Yoghurt 1kg", "Farmers Union"),   # different size
        P(5, "coles", "Brooklea Greek Style Yoghurt 500g", "Brooklea"),                       # different brand
    ]
    got = {m.product.id: m for m in match_item(YOGHURT, products)}
    assert got[1].match_type == "anchor"
    assert got[2].reason == "same barcode" and got[2].confidence == 1.0
    assert got[3].reason == "same brand and size"
    assert 4 not in got and 5 not in got


def test_generic_produce_each():
    products = [P(1, "woolworths", "Leek each"), P(2, "coles", "Coles Leek Each"), P(3, "aldi", "Leeks 500g")]
    got = {m.product.id for m in match_item(LEEK, products)}
    assert got == {1, 2}


def test_receipt_style_names_find_the_product():
    products = [P(1, "woolworths", "Woolworths Sweet Corn Kernels 420g"),
                P(2, "woolworths", "Woolworths Corn Kernels No Added Salt 420g"),
                P(3, "woolworths", "Woolworths Sweet Corn Kernels 125g")]
    assert find_by_name(products, "WW Corn Kernels Sweet 420g")[0].id == 1
    assert watch_item_for_name("WW Beef Mince 1kg", [MINCE, YOGHURT], products) == "beef-mince"


def test_rejected_matches_never_come_back(tmp_path, monkeypatch):
    import family_specials.watchlist as wl

    monkeypatch.setattr(wl, "DECISIONS", tmp_path / "decisions.csv")
    conn = db.connect(tmp_path / "t.db")
    ts = "2099-01-01T00:00:00Z"
    for i, (chain, name) in enumerate([("woolworths", "Woolworths Beef Mince 1kg"), ("coles", "Coles Beef Mince 500g")], 1):
        conn.execute("INSERT INTO retailer_products(id, chain, retailer_product_id, name, first_seen_at, last_seen_at) "
                     "VALUES (?,?,?,?,?,?)", (i, chain, str(i), name, ts, ts))
        db.save_attributes(conn, i, chain, None, None, name, ts)
    add_decision("beef-mince", "coles", "2", "reject")
    for _ in range(2):  # and on every later run too
        sync_to_db(conn, [MINCE])
        run_matching(conn, [MINCE])
        status = dict(conn.execute("SELECT p.retailer_product_id, m.status FROM watch_matches m "
                                   "JOIN retailer_products p ON p.id = m.retailer_product_id").fetchall())
        assert status == {"1": "auto", "2": "rejected"}


def test_anchor_needs_the_distinctive_words_not_just_shared_ones():
    products = [P(1, "woolworths", "Farmers Union Greek Style Yogurt Light 500g", "Farmers Union"),
                P(2, "woolworths", "Farmers Union Greek Style High Protein Yoghurt 500g", "Farmers Union")]
    best = find_by_name(products, YOGHURT.anchor["name"])
    assert best[0].id == 2 and best[1] >= 0.85
    only_light = find_by_name(products[:1], YOGHURT.anchor["name"])
    assert only_light[1] < 0.85          # the Light one alone goes to review, not an automatic match


def test_similar_rule_respects_the_items_categories():
    ricotta = WatchItem("ricotta", "Ricotta", "regular", "similar", "kg",
                        similar={"must": ["ricotta"], "brands": "any"}, categories={"woolworths": ["cheese-cat"]})
    tub = P(1, "woolworths", "Perfect Italiano Ricotta Tub 500g")
    chips = P(2, "woolworths", "Kettle Potato Chips Hot Honey & Ricotta 165g")
    unknown = P(3, "aldi", "Ricotta Tub 375g")          # no category known for ALDI here: allowed
    tub.categories, chips.categories = frozenset({"cheese-cat"}), frozenset({"chips-cat"})
    got = {m.product.id for m in match_item(ricotta, [tub, chips, unknown])}
    assert got == {1, 3}
