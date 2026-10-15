import pytest

from family_specials.parsing import (
    normalise_gtin,
    parse_multibuy,
    parse_size,
    parse_unit_price_text,
    to_cents,
)


@pytest.mark.parametrize(
    "size_text,name,total,base,pack,comparable",
    [
        ("2L", None, 2000, "ml", None, True),
        ("1 L", None, 1000, "ml", None, True),
        ("600mL", None, 600, "ml", None, True),
        ("24 x 600mL", None, 14400, "ml", 24, True),
        ("1,000 g", None, 1000, "g", None, True),          # ALDI writes thousands with a comma
        ("0.5 kg", None, 500, "g", None, True),
        ("380g", "Crinkle Cut Chips Lunchbox Multipack 20 Pack", 380, "g", None, True),
        ("36 pack", None, 36, "each", 36, True),
        (None, "Coca-Cola Classic Soft Drink Cans 375mL x 10 pack", 3750, "ml", 10, True),  # measure first
        (None, "S.Pellegrino Sparkling Water 330ml x 8pk", 2640, "ml", 8, True),
        (None, "Viva White Paper Towel 3 x 60 pack", 180, "each", 3, True),                  # 3 rolls of 60
        ("100 tablets", None, 100, "each", 100, True),
        (None, "Premier Protein Chocolate Protein Shakes 24 x 325ml", 7800, "ml", 24, True),  # Costco: size in name
        (None, "Quilton Toilet Tissue 36 Pack", 36, "each", 36, True),
        ("approx. 130g", "Coles Tomatoes Gourmet", None, None, None, False),  # sold by weight
        ("each", "Bananas", None, None, None, False),
        (None, None, None, None, None, False),
    ],
)
def test_parse_size(size_text, name, total, base, pack, comparable):
    s = parse_size(size_text, name)
    assert s.comparable is comparable
    if comparable:
        assert s.total_quantity == pytest.approx(total)
        assert s.base_unit == base
        assert s.pack_count == pack
    else:
        assert s.reason


def test_parse_size_never_guesses_conflicting_sizes():
    s = parse_size("500g 1kg")
    assert not s.comparable and "conflicting" in s.reason


@pytest.mark.parametrize(
    "raw,expected,is_global",
    [
        ("9310015231988", "09310015231988", True),   # Smith's chips (Coles product page)
        ("5998749109113", "05998749109113", True),   # Pedigree DentaStix (Woolworths listing)
        ("799366489184", "00799366489184", True),    # UPC-A (Costco)
        ("2000001234563", "02000001234563", False),  # in-store / variable-weight prefix 2
    ],
)
def test_normalise_gtin(raw, expected, is_global):
    g = normalise_gtin(raw)
    assert g.gtin14 == expected
    assert g.is_global is is_global


@pytest.mark.parametrize("raw", ["9310015231989", "12345", "", None, "abc"])
def test_invalid_gtins_rejected(raw):
    assert normalise_gtin(raw) is None


def test_money_and_offers():
    assert to_cents(12.99) == 1299
    assert to_cents("$1,299.50") == 129950
    assert to_cents(None) is None
    assert parse_multibuy("Buy 2 for $9.40") == (2, 940)
    assert parse_multibuy("Pick any 2 for $9") == (2, 900)
    assert parse_multibuy("2 for $3.00 - $1.50/1EA") == (2, 300)
    assert parse_multibuy("Save $2.50") is None
    assert parse_unit_price_text("$1.70/ 1kg") == (1.70, "1KG")
    assert parse_unit_price_text("$13.98 per 100 ml") == (13.98, "100ML")
    assert parse_unit_price_text("$0.77 / 100G") == (0.77, "100G")
