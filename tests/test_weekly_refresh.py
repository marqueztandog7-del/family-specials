"""The weekly refresh (19 Oct 2026): full ranges, catalogues, every store's specials in public, nothing about the
family in public, and a store that refuses us stays paused until you resume it."""

import json
from datetime import timedelta
from pathlib import Path

from family_specials import config, db, runner
from family_specials.catalogues import chemistwarehouse as cw
from family_specials.catalogues.costco_booklet import clean_name, parse_page
from family_specials.collectors.chemistwarehouse import ChemistWarehouseCollector
from family_specials.collectors.woolworths import WoolworthsCollector
from family_specials.export import build_products, export_site
from family_specials.models import NormalisedItem, Observation, ProductInfo
from family_specials.timeutil import iso, now_utc

FIXTURES = Path(__file__).parent / "fixtures"


# --------------------------------------------------------------------------- Costco's booklet


def test_booklet_page_reads_every_item_exactly():
    items, unclear = parse_page((FIXTURES / "costco_booklet" / "page-5.html").read_text())
    assert not unclear and len(items) == 9
    body_wash = next(i for i in items if i["item_numbers"] == ["187193"])
    assert body_wash["price_cents"] == 1199 and body_wash["saving_cents"] == 400
    assert body_wash["name"] == "Original Source Vanilla & Raspberry Body Wash 2 x 1L"
    assert body_wash["unit_text"] == "$0.60 per 100ml" and body_wash["unit_measure"] == "100ML"
    rexona = next(i for i in items if "Rexona" in i["name"])
    assert rexona["item_numbers"] == ["192893", "192894"]           # one price, two products


def test_booklet_online_only_page_is_left_out():
    items, unclear = parse_page((FIXTURES / "costco_booklet" / "page-11.html").read_text())
    assert items == [] and unclear == []


def test_booklet_names_are_tidied():
    assert clean_name("Johnson’ s Baby Bedtime Bath\n2 x 750ml\nItem 206359 | $ 0.87 per 100ml") == \
        "Johnson’s Baby Bedtime Bath 2 x 750ml"
    assert clean_name("Rexona Men and / or Women\nItem 192893 | Item 192894 * No rainchecks") == "Rexona Men and/or Women"


def test_booklet_item_that_doesnt_read_cleanly_goes_to_review():
    page = "<div> $ 9 99</div><div> After $ 2 off</div><div> Mystery item with no number</div>"
    items, unclear = parse_page(page)
    assert items == [] and len(unclear) == 1


# --------------------------------------------------------------------------- full-range reads record changes only


def _item(price, special=False, valid_to=None, chain="aldi", pid="1"):
    return NormalisedItem(
        product=ProductInfo(chain=chain, retailer_product_id=pid, name="Test Milk 2L", size_text="2L"),
        observations=[Observation(store_ref="G449", price_basis="in_store", price_cents=price, is_special=special,
                                  special_type="special_buy" if special else None, valid_to=valid_to)],
        raw_product={"n": 1}, raw_price={"p": price})


def test_range_read_records_a_price_only_when_it_changes(tmp_path):
    conn = db.connect(tmp_path / "a.db")
    run = db.start_run(conn, "aldi", "range")
    assert db.save_item(conn, run, _item(299), "range", only_changes=True) == 1
    assert db.save_item(conn, run, _item(299), "range", only_changes=True) == 0      # same price: not again
    assert db.save_item(conn, run, _item(279), "range", only_changes=True) == 1      # changed: recorded
    pid = conn.execute("SELECT id FROM retailer_products").fetchone()[0]
    assert db.save_item(conn, run, _item(279), "range", only_changes=True, keep={pid}) == 1   # watched: every week
    assert conn.execute("SELECT COUNT(*) FROM price_observations").fetchone()[0] == 3


def test_seen_products_stay_current_without_a_new_price_row(tmp_path):
    conn = db.connect(tmp_path / "a.db")
    run = db.start_run(conn, "aldi", "range")
    db.save_item(conn, run, _item(299), "range")
    db.finish_run(conn, run, "ok", 1, 1, 1)
    old = iso(now_utc() - timedelta(days=30))
    conn.execute("UPDATE price_observations SET observed_at = ?", (old,))
    conn.execute("UPDATE retailer_products SET last_seen_at = ?", (old,))
    assert build_products(conn) == []                                  # not seen for a month: not current
    db.mark_seen(conn, "aldi", "1")                                    # seen this week, same price
    assert [p["price_cents"] for p in build_products(conn)] == [299]


def test_an_ended_special_is_never_the_current_price(tmp_path):
    conn = db.connect(tmp_path / "a.db")
    run = db.start_run(conn, "aldi", "range")
    db.save_item(conn, run, _item(299), "range")
    db.finish_run(conn, run, "ok", 1, 1, 1)
    later = db.start_run(conn, "aldi", "specials")
    conn.execute("UPDATE collection_runs SET started_at = ? WHERE id = ?", (iso(now_utc() + timedelta(minutes=1)), later))
    db.save_item(conn, later, _item(199, special=True, valid_to=iso(now_utc() - timedelta(hours=1))), "specials")
    assert [(p["price_cents"], p["special"]) for p in build_products(conn)] == [(299, False)]


# --------------------------------------------------------------------------- Chemist Warehouse's catalogue rule


def _cw_product(conn, price, when):
    run = db.start_run(conn, "chemistwarehouse", "range")
    db.save_item(conn, run, NormalisedItem(
        product=ProductInfo(chain="chemistwarehouse", retailer_product_id="77", name="Voltaren Emulgel 150g"),
        observations=[Observation(store_ref="online", price_basis="online", price_cents=price, is_special=False)],
        raw_product={}, raw_price={}), "range")
    conn.execute("UPDATE price_observations SET observed_at = ?", (when,))
    return conn.execute("SELECT id FROM retailer_products").fetchone()[0]


def test_catalogue_price_counts_only_when_cheaper_than_before_the_catalogue(tmp_path):
    conn = db.connect(tmp_path / "a.db")
    cat = {"start": iso(now_utc() - timedelta(days=2)), "end": iso(now_utc() + timedelta(days=10))}
    pid = _cw_product(conn, 2999, iso(now_utc() - timedelta(days=5)))
    obs, why = cw.decide(conn, {"price": 24.99, "saving_basis": "rrp"}, pid, cat)
    assert obs and obs.was_cents == 2999 and obs.price_cents == 2499 and obs.valid_to_source == "catalogue"
    obs, why = cw.decide(conn, {"price": 29.99, "saving_basis": "rrp"}, pid, cat)
    assert obs is None and why.startswith("not cheaper")               # "$X off RRP" alone is never a special


def test_catalogue_offer_without_an_earlier_price_isnt_a_special(tmp_path):
    conn = db.connect(tmp_path / "a.db")
    cat = {"start": iso(now_utc() - timedelta(days=2)), "end": iso(now_utc() + timedelta(days=10))}
    pid = _cw_product(conn, 2999, iso(now_utc()))                       # only seen after it started
    obs, why = cw.decide(conn, {"price": 19.99, "saving_basis": "rrp", "saving_amount": 20.0}, pid, cat)
    assert obs is None and why == "no earlier price to compare"
    obs, why = cw.decide(conn, {"price": 19.99, "saving_basis": "everyday", "saving_amount": 5.0}, pid, cat)
    assert obs and obs.was_cents == 2499                                # off its everyday price: counts


def test_catalogue_offer_matching():
    products = [{"id": 1, "store_id": "a", "name": "Voltaren Emulgel Joint Pain Relief Gel 150g",
                 "norm": cw.normalise("Voltaren Emulgel Joint Pain Relief Gel 150g"), "total": 150.0, "base": "g"},
                {"id": 2, "store_id": "b", "name": "Panadol Rapid 20 Caplets",
                 "norm": cw.normalise("Panadol Rapid 20 Caplets"), "total": 20.0, "base": "each"}]
    p, score, verdict = cw.best_match({"name": "Voltaren Emulgel Joint Pain Relief Gel", "size": "150g"}, products)
    assert verdict == "matched" and p["store_id"] == "a"
    p, score, verdict = cw.best_match({"name": "Voltaren Emulgel Joint Pain Relief Gel", "size": "50g"}, products)
    assert verdict == "review"                                          # same name, different size: you check
    p, score, verdict = cw.best_match({"name": "Swisse Ultiboost Magnesium", "size": "120 tablets"}, products)
    assert verdict == "not found"


def test_catalogue_page_reader_parses_the_ai_answer():
    import httpx

    answer = {"content": [{"type": "tool_use", "name": "record_offers", "input": {"offers": [
        {"name": "L'Oreal Paris Infallible 3-Second Setting Mist 150ml", "size": "150ml", "price": 20.49,
         "is_range": False, "saving_text": "$20.51 OFF RRP†", "saving_basis": "rrp", "readable": True}]}}]}
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        seen["key"] = request.headers.get("x-api-key")
        return httpx.Response(200, json=answer)

    offers = cw.read_page_ai(b"jpeg", "not-a-real-key", "claude-sonnet-5-5", transport=httpx.MockTransport(handler))
    assert offers[0]["price"] == 20.49 and seen["key"] == "not-a-real-key"
    assert seen["body"]["tool_choice"] == {"type": "tool", "name": "record_offers"}
    assert seen["body"]["messages"][0]["content"][0]["type"] == "image"


# --------------------------------------------------------------------------- reading full ranges politely


class FakeClient:
    def __init__(self, handler):
        self.handler, self.calls, self.requests_made = handler, [], 0

    def post(self, url, json=None, headers=None):
        self.calls.append(json)
        self.requests_made += 1
        return self.handler(json)

    def get(self, url, **kw):
        self.requests_made += 1
        return self.handler(None)


class Resp:
    def __init__(self, data):
        self._data = data

    def json(self):
        return self._data


def test_chemist_warehouse_range_splits_busy_price_bands(monkeypatch):
    monkeypatch.setenv("CW_ALGOLIA_SEARCH_KEY", "test")
    import urllib.parse

    def handler(body):
        params = urllib.parse.parse_qs(body["requests"][0]["params"])
        f = params["filters"][0]
        if "calculatedPrice" not in f:
            return Resp({"results": [{"nbHits": 3}]})
        lo = int(f.split(">= ")[1].split(" ")[0])
        hi = int(f.split("< ")[1].split(" ")[0])
        hits = [{"sku": str(c)} for c in (450, 460, 1999) if lo <= c < hi]
        # Pretend the 0-500 band is too big for one page the first time.
        n = 2000 if (lo, hi) == (0, 500) else len(hits)
        return Resp({"results": [{"nbHits": n, "hits": hits}]})

    col = ChemistWarehouseCollector(config.chain_config("chemistwarehouse"), FakeClient(handler))
    skus = [r.data["sku"] for r in col.fetch_range()]
    assert sorted(skus) == ["1999", "450", "460"]
    assert all('NOT categoryKeys.en:"All Marketplace Lines"' in urllib.parse.parse_qs(c["requests"][0]["params"])["filters"][0]
               for c in col.client.calls)                               # never marketplace sellers
    assert col.coverage[0].complete and col.coverage[0].items_total == 3


def test_woolworths_range_reads_aisles_skips_themes_and_dedupes():
    tree = [
        {"NodeId": "1_A", "Description": "Pantry", "UrlFriendlyName": "pantry",
         "Children": [{"NodeId": "1_A1", "Description": "Rice", "UrlFriendlyName": "rice"},
                      {"NodeId": "1_A2", "Description": "Pasta", "UrlFriendlyName": "pasta"}]},
        {"NodeId": "1_H", "Description": "Halloween", "UrlFriendlyName": "halloween",
         "Children": [{"NodeId": "1_H1", "Description": "Lollies", "UrlFriendlyName": "lollies"}]},
        {"NodeId": "specialsgroup", "Description": "Specials", "UrlFriendlyName": "specials", "Children": []},
    ]
    pages = {"1_A1": [1, 2], "1_A2": [2, 3], "1_H1": [9]}

    def handler(body):
        codes = pages[body["categoryId"]]
        return Resp({"TotalRecordCount": len(codes),
                     "Bundles": [{"Products": [{"Stockcode": c} for c in codes]}]})

    col = WoolworthsCollector(config.chain_config("woolworths"), FakeClient(handler))
    col._warmed, col._tree = True, tree
    codes = [r.data["Stockcode"] for r in col.fetch_range()]
    assert codes == [1, 2, 3]                                           # aisles only, once each, no Halloween
    assert {c["categoryId"] for c in col.client.calls} == {"1_A1", "1_A2"}


# --------------------------------------------------------------------------- refusals, and what's public


def test_a_store_that_refuses_us_stays_paused_until_resumed(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "RESUMES_FILE", tmp_path / "resumes.json")
    conn = db.connect(tmp_path / "a.db")
    assert not runner.blocked_since_resume(conn, "woolworths")
    run = db.start_run(conn, "woolworths", "specials")
    db.finish_run(conn, run, "blocked", 1, 0, 0, "HTTP 401")
    assert runner.blocked_since_resume(conn, "woolworths")
    assert not runner.is_due(conn, "woolworths", "range", now_utc() + timedelta(days=8))   # even next week
    runner.resume("woolworths")
    assert not runner.blocked_since_resume(conn, "woolworths")


def test_public_files_hold_store_specials_only(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "a.db")
    run = db.start_run(conn, "aldi", "specials")
    db.save_item(conn, run, _item(199, special=True, pid="5"), "specials")
    db.save_item(conn, run, _item(299, pid="6"), "specials")
    db.finish_run(conn, run, "ok", 1, 2, 2)
    out = tmp_path / "site"
    out.mkdir()
    (out / "watchlist.json").write_text("{}")                           # the old public file
    export_site(conn, out)
    assert sorted(f.name for f in out.iterdir()) == ["specials.json", "status.json"]
    data = json.loads((out / "specials.json").read_text())
    assert [s["id"] for s in data["specials"]] == ["aldi:5"]
    text = (out / "specials.json").read_text() + (out / "status.json").read_text()
    for private in ("tier", "core", "regular", "watch", "family"):
        assert private not in text.lower()


def test_chemist_warehouse_crowded_price_is_split_by_category(monkeypatch):
    """More than a page of products at one exact price ($25.00 on 19 Oct): read category by category."""
    monkeypatch.setenv("CW_ALGOLIA_SEARCH_KEY", "test")
    import urllib.parse

    products = [{"sku": f"a{i}", "cats": ["Vitamins"]} for i in range(3)] + \
               [{"sku": f"b{i}", "cats": ["Skin"]} for i in range(3)] + [{"sku": "c0", "cats": []}]

    def handler(body):
        params = urllib.parse.parse_qs(body["requests"][0]["params"])
        f = params["filters"][0]
        hpp = int(params["hitsPerPage"][0])
        if "calculatedPrice" not in f:
            return Resp({"results": [{"nbHits": len(products)}]})
        lo = int(f.split(">= ")[1].split(" ")[0])
        if lo != 2500 or int(f.split("< ")[1].split(" ")[0]) > 2501 and "categoryKeys.en:\"" not in f.replace("NOT categoryKeys.en:\"All Marketplace Lines\"", ""):
            if lo <= 2500 < int(f.split("< ")[1].split(" ")[0]):
                return Resp({"results": [{"nbHits": len(products), "hits": products[:hpp]}]})
            return Resp({"results": [{"nbHits": 0, "hits": []}]})
        rows = products
        for cat in ("Vitamins", "Skin"):
            if f'AND categoryKeys.en:"{cat}"' in f:
                rows = [p for p in rows if cat in p["cats"]]
            if f'AND NOT categoryKeys.en:"{cat}"' in f:
                rows = [p for p in rows if cat not in p["cats"]]
        out = {"nbHits": len(rows), "hits": rows[:hpp]}
        if "facets" in params:
            out["facets"] = {"categoryKeys.en": {"Vitamins": 3, "Skin": 3, "Categories": 7}}
        return Resp({"results": [out]})

    col = ChemistWarehouseCollector({**config.chain_config("chemistwarehouse"), "range": {"hits_per_page": 4}},
                                    FakeClient(handler))
    skus = sorted(r.data["sku"] for r in col.fetch_range())
    assert skus == sorted(p["sku"] for p in products)
    assert col.coverage[0].complete


def test_the_latest_special_wins_even_without_an_end_date(tmp_path):
    """A special read from a category page has no end date: it must still beat last week's normal price."""
    conn = db.connect(tmp_path / "a.db")
    first = db.start_run(conn, "aldi", "range")
    db.save_item(conn, first, _item(299), "range")
    db.finish_run(conn, first, "ok", 1, 1, 1)
    conn.execute("UPDATE collection_runs SET started_at = ? WHERE id = ?", (iso(now_utc() - timedelta(days=3)), first))
    later = db.start_run(conn, "aldi", "category")
    db.save_item(conn, later, _item(199, special=True), "category")      # no valid_to, no valid_to_source
    db.finish_run(conn, later, "ok", 1, 1, 1)
    assert [(p["price_cents"], p["special"]) for p in build_products(conn)] == [(199, True)]


def test_a_booklet_price_beats_a_later_online_price(tmp_path):
    conn = db.connect(tmp_path / "a.db")
    booklet = db.start_run(conn, "costco", "catalogue")
    db.save_item(conn, booklet, NormalisedItem(
        product=ProductInfo(chain="costco", retailer_product_id="187193", name="Body Wash 2 x 1L"),
        observations=[Observation(store_ref="warehouse", price_basis="in_store", price_cents=1199, was_cents=1599,
                                  is_special=True, special_type="costco_booklet", valid_to_source="catalogue",
                                  valid_to=iso(now_utc() + timedelta(days=5)))],
        raw_product={}, raw_price={}), "catalogue")
    db.finish_run(conn, booklet, "ok", 1, 1, 1)
    conn.execute("UPDATE collection_runs SET started_at = ? WHERE id = ?", (iso(now_utc() - timedelta(hours=1)), booklet))
    online = db.start_run(conn, "costco", "range")
    db.save_item(conn, online, NormalisedItem(
        product=ProductInfo(chain="costco", retailer_product_id="187193", name="Body Wash 2 x 1L"),
        observations=[Observation(store_ref="online", price_basis="online_incl_delivery", price_cents=1899,
                                  is_special=False)], raw_product={}, raw_price={}), "range")
    db.finish_run(conn, online, "ok", 1, 1, 1)
    [p] = build_products(conn)
    assert (p["price_cents"], p["basis"], p["store_ref"]) == (1199, "in store", "warehouse")
