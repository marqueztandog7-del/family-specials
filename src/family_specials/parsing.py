"""Parsing helpers: barcodes, money, and pack sizes.

Rule: if something can't be read reliably, say so (comparable=False with a reason).
Never guess a size or a price.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

PARSER_VERSION = 1

# --------------------------------------------------------------------------- barcodes


def gtin_check_digit_ok(digits: str) -> bool:
    if not digits.isdigit() or len(digits) < 8:
        return False
    body, check = digits[:-1], int(digits[-1])
    total = sum(int(d) * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(body)))
    return (10 - total % 10) % 10 == check


@dataclass(frozen=True)
class Gtin:
    gtin14: str
    raw: str
    is_global: bool  # False for in-store / variable-weight codes


def normalise_gtin(raw: str | int | None) -> Gtin | None:
    """Normalise to GTIN-14. Returns None if it isn't a valid GTIN-8/12/13/14."""
    if raw is None:
        return None
    digits = re.sub(r"\D", "", str(raw))
    if len(digits) not in (8, 12, 13, 14) or not gtin_check_digit_ok(digits):
        return None
    gtin14 = digits.zfill(14)
    return Gtin(gtin14=gtin14, raw=str(raw).strip(), is_global=_is_global(digits))


def _is_global(digits: str) -> bool:
    # Restricted-circulation prefixes: retailers use these for in-store and
    # variable-weight items (deli, meat). They mean nothing outside one store.
    if len(digits) == 13 and digits.startswith("2"):
        return False
    if len(digits) == 12 and digits[0] in "24":
        return False
    if len(digits) == 8 and digits[0] in "02":
        return False
    if len(digits) == 14 and digits[1] == "2" and digits[0] == "0":
        return False
    return True


# --------------------------------------------------------------------------- money


def to_cents(value) -> int | None:
    """12.99 / '12.99' / '$12.99' -> 1299. None/''/0-for-missing handled by caller."""
    if value is None or value == "":
        return None
    if isinstance(value, str):
        m = re.search(r"-?\d[\d,]*(?:\.\d+)?", value)
        if not m:
            return None
        value = m.group(0).replace(",", "")
    try:
        return int((Decimal(str(value)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except InvalidOperation:
        return None


MULTIBUY_RE = re.compile(
    r"(?:buy|any|pick any|mix\s*&?\s*match)?\s*(\d+)\s*(?:for|x)\s*\$\s*(\d+(?:\.\d{1,2})?)", re.I
)


def parse_multibuy(text: str | None) -> tuple[int, int] | None:
    """'Buy 2 for $9.40' / 'Pick any 2 for $9' / '2 for $8' -> (2, 940). None if not a clear N-for-$X."""
    if not text:
        return None
    m = MULTIBUY_RE.search(text)
    if not m:
        return None
    qty = int(m.group(1))
    if qty < 2:
        return None
    return qty, to_cents(m.group(2))


UNIT_PRICE_RE = re.compile(
    r"\$\s*(\d+(?:\.\d+)?)\s*(?:/|per)\s*(\d+(?:\.\d+)?)?\s*([a-zA-Z]+)", re.I
)


def parse_unit_price_text(text: str | None) -> tuple[float, str] | None:
    """'$1.70/ 1kg' / '$13.98 per 100 ml' / '$0.77 / 100G' -> (1.70, '1KG')."""
    if not text:
        return None
    m = UNIT_PRICE_RE.search(text)
    if not m:
        return None
    qty = m.group(2) or "1"
    qty = qty.rstrip("0").rstrip(".") if "." in qty else qty
    return float(m.group(1)), f"{qty}{m.group(3).upper()}"


# --------------------------------------------------------------------------- sizes

MASS = {"mg": 0.001, "g": 1.0, "gm": 1.0, "gram": 1.0, "grams": 1.0, "kg": 1000.0, "kilo": 1000.0, "kilogram": 1000.0}
VOLUME = {"ml": 1.0, "millilitre": 1.0, "milliliter": 1.0, "cl": 10.0, "l": 1000.0, "lt": 1000.0, "ltr": 1000.0,
          "litre": 1000.0, "liter": 1000.0, "litres": 1000.0, "liters": 1000.0}
# Count nouns: "36 rolls", "24 pack", "100 tablets". Mapped to a canonical singular.
COUNT_NOUNS = {
    "pack": "pack", "pk": "pack", "packs": "pack", "each": "each", "ea": "each",
    "roll": "roll", "rolls": "roll", "sheet": "sheet", "sheets": "sheet",
    "tablet": "tablet", "tablets": "tablet", "tabs": "tablet", "caplet": "caplet", "caplets": "caplet",
    "capsule": "capsule", "capsules": "capsule", "caps": "capsule", "softgel": "capsule", "softgels": "capsule",
    "egg": "egg", "eggs": "egg", "wipes": "wipe", "wipe": "wipe", "bags": "bag", "bag": "bag",
    "nappies": "nappy", "nappy": "nappy", "pods": "pod", "pod": "pod", "capsules.": "capsule",
    "pieces": "piece", "piece": "piece", "pce": "piece", "pcs": "piece", "sachets": "sachet", "sachet": "sachet",
    "serves": "serve", "pairs": "pair", "pair": "pair", "count": "each", "ct": "each",
}

_NUM = r"(\d{1,3}(?:,\d{3})+|\d+(?:[.,]\d+)?)"
_UNIT = r"([a-zA-Z]+\.?)"
MULTI_RE = re.compile(rf"(\d+)\s*[xX×]\s*{_NUM}\s*{_UNIT}\b")
SINGLE_RE = re.compile(rf"(?<![\w.]){_NUM}\s*{_UNIT}\b")
WEIGHED_RE = re.compile(r"\b(per\s*kg|/\s*kg|price per kg|approx\.?)\b", re.I)


@dataclass
class SizeInfo:
    size_quantity: float | None = None
    size_unit: str | None = None          # g | ml | each
    pack_count: int | None = None
    total_quantity: float | None = None
    base_unit: str | None = None          # g | ml | each
    count_noun: str | None = None
    comparable: bool = False
    reason: str | None = None


def _unit_kind(unit: str) -> tuple[str, float, str | None] | None:
    u = unit.lower().rstrip(".")
    if u in MASS:
        return "g", MASS[u], None
    if u in VOLUME:
        return "ml", VOLUME[u], None
    if u in COUNT_NOUNS:
        return "each", 1.0, COUNT_NOUNS[u]
    return None


def parse_size(size_text: str | None, name: str | None = None) -> SizeInfo:
    """Read the pack size from the store's size field, falling back to the name.

    '2L' -> 2000 ml; '24 x 600mL' -> 24 x 600 ml; '36 pack' -> 36 each (pack);
    '20 Pack' + '380g' -> 380 g (pack count 20). 'each' alone / 'per kg' -> not comparable.
    """
    texts = [t for t in (size_text, name) if t]
    if not texts:
        return SizeInfo(reason="no size given")

    for text in texts:
        if WEIGHED_RE.search(text):
            return SizeInfo(reason="sold by weight (price per kg); weight varies")

    for text in texts:
        m = MULTI_RE.search(text)
        if m:
            count, qty, unit = int(m.group(1)), _num(m.group(2)), m.group(3)
            kind = _unit_kind(unit)
            if kind and kind[0] != "each" and qty > 0:
                base, factor, _ = kind
                return SizeInfo(qty * factor, base, count, qty * factor * count, base, None, True)

    measures: list[tuple[str, float]] = []
    counts: list[tuple[str, float]] = []
    for text in texts:
        for m in SINGLE_RE.finditer(text):
            qty, unit = _num(m.group(1)), m.group(2)
            kind = _unit_kind(unit)
            if not kind or qty <= 0:
                continue
            base, factor, noun = kind
            if base == "each":
                if noun != "each" or qty > 1:
                    counts.append((noun, qty))
            else:
                measures.append((base, qty * factor))
        if measures or counts:
            break  # prefer the store's size field over the name

    distinct_measures = {m for m in measures}
    if len(distinct_measures) > 1:
        return SizeInfo(reason=f"conflicting sizes in '{' | '.join(texts)}'")

    pack = None
    pack_counts = [q for noun, q in counts if noun == "pack"]
    if pack_counts:
        pack = int(pack_counts[0])

    if measures:
        base, total = measures[0]
        # '20 Pack 380g': 380 g is the total; each item is 19 g.
        per_item = total / pack if pack else total
        return SizeInfo(per_item, base, pack, total, base, None, True)

    item_counts = [(noun, q) for noun, q in counts if noun not in ("pack", "each")]
    if len({n for n, _ in item_counts}) == 1:
        noun, qty = item_counts[0]
        return SizeInfo(1, "each", int(qty), qty, "each", noun, True)
    if len(item_counts) > 1:
        return SizeInfo(reason=f"several count units in '{' | '.join(texts)}'")
    if pack:
        return SizeInfo(1, "each", pack, pack, "each", "pack", True)
    return SizeInfo(reason=f"no readable size in '{' | '.join(texts)}'")


def _num(s: str) -> float:
    if re.fullmatch(r"\d{1,3}(?:,\d{3})+", s):  # "1,000" is a thousands separator
        return float(s.replace(",", ""))
    return float(s.replace(",", "."))


# --------------------------------------------------------------------------- brands


def is_own_brand(chain: str, brand: str | None, own_brands: dict[str, list[str]]) -> bool | None:
    if not brand:
        return None
    b = brand.strip().lower()
    names = [n.lower() for n in own_brands.get(chain, [])]
    if any(b == n or b.startswith(n + " ") for n in names):
        return True
    return False if names else None
