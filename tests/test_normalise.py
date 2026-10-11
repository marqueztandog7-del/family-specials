"""Each store's normaliser, run on real items saved from the 5 Oct 2026 collection."""

import json
from pathlib import Path

import pytest

from family_specials import config
from family_specials.collectors import get_collector_class
from family_specials.collectors.base import RawItem

FIXTURES = Path(__file__).parent / "fixtures"


def collector(chain):
    return get_collector_class(chain)(config.chain_config(chain), client=None)


def load(chain):
    return json.loads((FIXTURES / f"{chain}.json").read_text())


def test_woolworths():
    c = collector("woolworths")
    half, multi, lower, kg = load("woolworths")

    item = c.normalise(RawItem(half, {"special_type": "half_price", "weekly": True}))
    assert item.gtins and item.gtins[0].source == "listing"
    obs = {o.price_basis: o for o in item.observations}
    assert set(obs) == {"in_store", "online"}
    o = obs["in_store"]
    assert o.is_special and o.was_cents and o.was_cents > o.price_cents
    assert o.valid_to and o.valid_to_source == "weekly_cycle_assumed"

    o = c.normalise(RawItem(multi, {"special_type": "multibuy"})).observations[0]
    assert o.is_special and o.multibuy_qty >= 2 and o.multibuy_cents
    assert o.was_cents is None  # Buy More Save More reports was == price

    o = c.normalise(RawItem(lower, {"special_type": "lower_shelf_price"})).observations[0]
    assert not o.is_special and o.special_type == "lower_shelf_price"
    assert o.promo_text == "Lower shelf price"  # HTML stripped

    o = c.normalise(RawItem(kg, {})).observations[0]
    assert o.price_per == "kg"


def test_coles():
    c = collector("coles")
    multi, no_was = load("coles")
    o = c.normalise(RawItem(multi, {"store_ref": "0883"})).observations[0]
    assert o.store_ref == "0883" and o.is_special and o.special_type == "multibuy"
    assert multi["pricing"]["offerDescription"] == "Pick any 2 for $6.50"
    assert (o.multibuy_qty, o.multibuy_cents) == (2, 650)
    # Coles marks some items SPECIAL with no was price; we record exactly that.
    o = c.normalise(RawItem(no_was, {"store_ref": "0883"})).observations[0]
    assert o.is_special and o.was_cents is None and o.valid_to_source == "weekly_cycle_assumed"


def test_aldi():
    c = collector("aldi")
    special_buy, weighed, lower = load("aldi")
    o = c.normalise(RawItem(special_buy, {"special_type": "special_buy", "is_special": True})).observations[0]
    assert o.is_special and o.valid_from and o.valid_to is None  # while stocks last
    o = c.normalise(RawItem(weighed, {"special_type": "super_saver", "is_special": True})).observations[0]
    assert o.price_per == "kg" and o.unit_measure == "1KG"
    assert o.price_cents == round(o.unit_price * 100)  # the per-kg price, not the estimated pack price
    o = c.normalise(RawItem(lower, {"special_type": "lower_price", "is_special": False})).observations[0]
    assert not o.is_special and o.special_type == "lower_price"


def test_costco():
    c = collector("costco")
    discounted, regular = load("costco")
    o = c.normalise(RawItem(discounted, {})).observations[0]
    assert o.is_special and o.was_cents > o.price_cents
    assert o.valid_to_source == "store" and o.valid_to.endswith("Z")
    assert o.price_basis in ("online", "online_incl_delivery")
    assert not c.normalise(RawItem(regular, {})).observations[0].is_special


def test_chemistwarehouse():
    c = collector("chemistwarehouse")
    clearance, with_gtin = load("chemistwarehouse")
    o = c.normalise(RawItem(clearance, {})).observations[0]
    assert o.is_special and o.special_type == "clearance"
    item = c.normalise(RawItem(with_gtin, {}))
    assert item.gtins and all(g.source == "supplier_content" for g in item.gtins)
    o = item.observations[0]
    # "$X Off RRP" is everyday pricing: RRP kept, never a was price, never a special by itself.
    assert o.was_cents is None
    if "clearance" not in (with_gtin.get("attributes") or {}).get("cwr-product-flags", []):
        assert not o.is_special


@pytest.mark.parametrize("chain", ["woolworths", "coles", "aldi", "costco", "chemistwarehouse"])
def test_snapshots_exclude_prices(chain):
    c = collector(chain)
    for raw in load(chain):
        item = c.normalise(RawItem(raw, {}))
        if item is None:
            continue
        text = json.dumps(item.raw_product)
        for key in ("InstorePrice", '"pricing"', '"prices"', '"basePrice"'):
            assert key not in text
