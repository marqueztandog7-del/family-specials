"""Matching watch items to store products. Rules and fuzzy text only: free to run, no AI.

Levels (see data/private/watchlist.yaml):
  exact         the anchor product only
  same_product  the anchor at its store (by name and size), then the same product elsewhere:
                same barcode first, otherwise same brand + same size + a close name
  similar       the item's rule (must / any / exclude words, brands, size), any store, any brand

Every match stores a reason ("same barcode", "same brand and size", "similar: ...") and a
confidence. Below AUTO it goes to the review list; below REVIEW it's dropped. A rejected
match (data/private/watch-decisions.csv) never comes back; a confirmed one is always kept.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from rapidfuzz import fuzz

from .parsing import parse_size
from .timeutil import iso, now_iso, now_utc
from .watchlist import WatchItem

MATCHER_VERSION = 4
AUTO = 0.85      # at or above: matched automatically
REVIEW = 0.60    # between REVIEW and AUTO: goes to the review list
RECENT_WEEKS = 8

# Receipt and store shorthand -> words. Applied to whole words after lower-casing.
ABBREVIATIONS = {
    "ww": "woolworths", "disinf": "disinfectant", "dbl": "double", "lgth": "length", "lmn": "lemon",
    "gngr": "ginger", "tb": "tea bags", "ea": "each", "ec": "east coast", "pk": "pack", "pkt": "pack",
    "yogurt": "yoghurt", "s pellegrino": "san pellegrino", "spellegrino": "san pellegrino",
    "coca cola": "coca-cola", "cocacola": "coca-cola", "sanpellegrino": "san pellegrino", "spud lite": "spudlite", "choi": "choy", "bok": "pak",
    "buk": "pak", "strapz": "straps", "borgs": "borg's", "eastcoast": "east coast", "x-large": "extra large",
    "xl": "extra large",
}
NOISE = {"pdm", "pp", "p/p", "sts", "approx", "fresh"}


# --------------------------------------------------------------------------- text helpers


def normalise(text: str | None) -> str:
    """Lower-case words with receipt shorthand expanded: 'WW Corn Kernels Sweet 420g' ->
    'woolworths corn kernels sweet 420 g'. Used for every name we compare."""
    if not text:
        return ""
    t = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)            # "CucumbersPunnet" -> "Cucumbers Punnet"
    t = re.sub(r"([A-Za-z])(\d)", r"\1 \2", t)                 # "Baby750g" -> "Baby 750 g"
    t = t.lower().replace("&", " and ").replace("’", "'").replace("p/p", " ")
    t = re.sub(r"(?<!\d)\.|\.(?!\d)", " ", t)                   # keep decimal points only ("1.5 kg")
    t = re.sub(r"[()\[\],;:!+*/\\|]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    for short, full in sorted(ABBREVIATIONS.items(), key=lambda kv: -len(kv[0])):
        t = re.sub(rf"(?<![\w-]){re.escape(short)}(?![\w-])", full, t)
    return " ".join(w for w in t.split() if w not in NOISE)


def has_term(text_norm: str, term: str) -> bool:
    """Whole-word (or phrase) match; the last word matches singular or plural ('apple' ~ 'apples')."""
    term = normalise(term)
    if not term:
        return True
    head, _, last = term.rpartition(" ")
    forms = {last, last + "s", last + "es"}
    if last.endswith("es"):
        forms |= {last[:-2], last[:-1]}
    elif last.endswith("s"):
        forms.add(last[:-1])
    alts = "|".join(re.escape(f) for f in sorted(forms, key=len, reverse=True))
    prefix = re.escape(head + " ") if head else ""
    return re.search(rf"(?<![\w-]){prefix}(?:{alts})(?![\w-])", text_norm) is not None


def parse_amount(value: str) -> tuple[float, str] | None:
    """'500 g' -> (500, 'g'); '2 kg' -> (2000, 'g'); '2 L' -> (2000, 'ml')."""
    s = parse_size(str(value))
    if not s.comparable or s.base_unit not in ("g", "ml"):
        return None
    return s.total_quantity, s.base_unit


# --------------------------------------------------------------------------- products


@dataclass
class Product:
    id: int
    chain: str
    store_id: str
    name: str
    norm: str
    brand: str | None
    category: str
    gtins: set[str]
    total: float | None
    base: str | None
    each: float | None
    pack: int | None
    comparable: bool
    sold_by_kg: bool
    categories: frozenset = frozenset()   # store category refs this product was seen in
    variable_weight: bool = False         # e.g. "380g - 800g": weighed, priced per kg in store


def load_products(conn: sqlite3.Connection, weeks: int = RECENT_WEEKS) -> list[Product]:
    cutoff = iso(now_utc() - timedelta(weeks=weeks))
    gtins: dict[int, set[str]] = {}
    for r in conn.execute("SELECT retailer_product_id, gtin14 FROM retailer_product_gtins WHERE is_global = 1"):
        gtins.setdefault(r[0], set()).add(r[1])
    kg = {r[0] for r in conn.execute(
        "SELECT DISTINCT retailer_product_id FROM price_observations WHERE price_per = 'kg' AND observed_at >= ?",
        (cutoff,))}
    cats: dict[int, set[str]] = {}
    for pid, ref in conn.execute("SELECT retailer_product_id, category_ref FROM product_categories"):
        cats.setdefault(pid, set()).add(ref)
    rows = conn.execute(
        """SELECT p.*, a.total_quantity, a.base_unit, a.size_quantity, a.pack_count, a.comparable
           FROM retailer_products p LEFT JOIN product_attributes a ON a.retailer_product_id = p.id
           WHERE p.last_seen_at >= ?""", (cutoff,)).fetchall()
    out = []
    for r in rows:
        name = r["display_name"] or r["name"]
        if r["brand"] and not normalise(name).startswith(normalise(r["brand"])):
            name = f"{r['brand']} {name}"
        out.append(Product(
            id=r["id"], chain=r["chain"], store_id=r["retailer_product_id"], name=name, norm=normalise(name),
            brand=normalise(r["brand"]) if r["brand"] else None, category=(r["category_path"] or "").lower(),
            gtins=gtins.get(r["id"], set()), total=r["total_quantity"], base=r["base_unit"],
            each=r["size_quantity"], pack=r["pack_count"], comparable=bool(r["comparable"]),
            sold_by_kg=r["id"] in kg, categories=frozenset(cats.get(r["id"], ())),
            variable_weight=bool(WEIGHT_RANGE.search(f"{name} {r['size_text'] or ''}")),
        ))
    return out


# --------------------------------------------------------------------------- matches


@dataclass
class Match:
    product: Product
    match_type: str      # anchor | exact | same_product | similar
    reason: str
    confidence: float


WEIGHT_RANGE = re.compile(r"\d+(\.\d+)?\s*(g|kg)\s*-\s*\d+(\.\d+)?\s*(g|kg)", re.I)
STOP_WORDS = {"and", "the", "with", "of", "in", "a", "pack", "each", "per", "x", "approx", "punnet", "tub", "jar",
              "bag", "bottle", "can", "cans", "multipack"}
SIZE_TOKEN = re.compile(r"^\d+(\.\d+)?(g|kg|ml|l|lt|ltr|pk|pack|ea|x)?$")


def _singular(w: str) -> str:
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 4 and w.endswith("oes"):
        return w[:-2]
    if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


def content_words(norm: str) -> set[str]:
    """The words that identify a product: no sizes, no filler."""
    return {_singular(w) for w in norm.split() if w not in STOP_WORDS and not SIZE_TOKEN.match(w)}


def name_score(target_norm: str, product_norm: str) -> float:
    """0-1. Mostly: how many of the target's words the product has (coverage), less any extra words
    the product adds (so 'Greek Style High Protein Yoghurt' doesn't match 'Greek Style Yoghurt Light')."""
    t, p = content_words(target_norm), content_words(product_norm)
    if not t or not p:
        return 0.0
    coverage = len(t & p) / len(t)
    extra = len(p - t) / len(p)
    order = fuzz.token_sort_ratio(" ".join(sorted(t)), " ".join(sorted(p))) / 100
    return 0.55 * coverage + 0.25 * (1 - extra) + 0.20 * order


def find_by_name(products: list[Product], text: str, chain: str | None = None, sold_by: str | None = None,
                 generic: bool = False, categories: set[str] | None = None) -> tuple[Product, float] | None:
    """Best product for a name such as 'Guzzi's Pasta Linguine 375g' or a receipt line. Returns
    (product, confidence 0-1). Pack size must agree when both sides have one. If `categories` is
    given, only products seen in those store categories are considered (when any are known)."""
    target = normalise(text)
    target_size = parse_size(text)
    pool = [p for p in products if (not chain or p.chain == chain)
            and (sold_by != "kg" or p.sold_by_kg or p.variable_weight)]
    # Prefer products seen in the item's own categories; one listed elsewhere (Woolworths files the
    # Zanetti Parmigiano under Soft Cheese) still wins if its name fits clearly better (small penalty).
    in_cat = {p.id for p in pool if categories and p.categories & categories}
    best: tuple[Product, float] | None = None
    for p in pool:
        score = name_score(target, p.norm)
        if target_size.comparable and p.comparable and target_size.base_unit == p.base and p.total:
            if abs(target_size.total_quantity - p.total) > 0.02 * p.total:
                score -= 0.3          # different pack size: a different product
            elif target.split()[:1] == p.norm.split()[:1] and content_words(p.norm) <= content_words(target):
                # Same brand, exact same size, and the product's name only drops words (e.g. "Guzzi's
                # Linguine 375g" for "Guzzi's Pasta Linguine 375g"), never adds its own (like "Light").
                score += 0.08
        elif target_size.comparable and p.comparable and target_size.base_unit != p.base:
            score -= 0.2
        if generic:
            core = [w for w in target.split() if w not in ("each", "loose", "per", "kg")]
            if core and not all(has_term(p.norm, w) for w in core):
                continue
            if p.comparable and p.base in ("g", "ml"):
                score -= 0.15        # "Leek (each)" shouldn't match a 500 g bag of leeks
        if in_cat and p.id not in in_cat:
            score -= 0.05
        score = min(score, 1.0)
        if best is None or score > best[1]:
            best = (p, score)
    return best


def rule_summary(item: WatchItem) -> str:
    rule = item.similar or {}
    brands = rule.get("brands", "any")
    bits = [item.name.lower(), "any brand" if brands == "any" else " or ".join(brands)]
    size = rule.get("size") or {}
    if "min" in size or "max" in size:
        lo, hi = size.get("min"), size.get("max")
        bits.append(f"{lo}" if lo == hi else f"{lo} to {hi}" if lo and hi else f"from {lo}" if lo else f"up to {hi}")
    if "pack" in size:
        bits.append(f"{size['pack']} pack")
    if "each" in size:
        bits.append(f"{size['each']} x {size.get('pack_min')}-{size.get('pack_max')}")
    return "similar: " + ", ".join(str(b) for b in bits)


def similar_matches(item: WatchItem, products: list[Product]) -> list[Match]:
    rule = item.similar or {}
    must = rule.get("must") or []
    any_ = rule.get("any") or []
    exclude = rule.get("exclude") or []
    brands = rule.get("brands", "any")
    size = rule.get("size") or {}
    summary = rule_summary(item)
    out = []
    for p in products:
        allowed = {str(c) for c in item.categories.get(p.chain, [])}
        if allowed and p.categories and not (p.categories & allowed):
            continue   # seen only in other categories (e.g. "lime" chips in the snacks aisle)
        if not all(has_term(p.norm, w) for w in must):
            continue
        if any_ and not any(has_term(p.norm, w) for w in any_):
            continue
        if any(has_term(p.norm, w) for w in exclude):
            continue
        if brands != "any" and not any(has_term(p.norm, b) for b in brands):
            continue
        conf = 0.95
        # Fresh / frozen hints from the store's category (unknown category = less sure).
        if rule.get("fresh"):
            if any(w in p.category for w in ("frozen", "freezer", "canned", "pantry", "tinned")):
                continue
            if not any(w in p.category for w in ("fruit", "veg", "produce", "salad")):
                if p.category:
                    continue   # the store files it outside produce (e.g. baby wipes "cucumber & aloe")
                conf -= 0.15   # no category known: send to review
        if rule.get("frozen"):
            if not ("frozen" in p.category or "freezer" in p.category or has_term(p.norm, "frozen")):
                conf -= 0.2
        ok = _size_ok(size, p)
        if ok is False:
            continue
        if ok is None:
            conf -= 0.25     # the rule has a size but we couldn't read this product's size
        if conf >= REVIEW:
            out.append(Match(p, "similar", summary, round(conf, 2)))
    return out


def _size_ok(size: dict[str, Any], p: Product) -> bool | None:
    """True / False, or None when the rule needs a size we couldn't read."""
    if not size:
        return True
    if not p.comparable:
        return None
    if "min" in size or "max" in size:
        lo = parse_amount(size["min"]) if size.get("min") else None
        hi = parse_amount(size["max"]) if size.get("max") else None
        base = (lo or hi)[1]
        if p.base != base:
            return False
        if lo and p.total < lo[0] * 0.98:
            return False
        if hi and p.total > hi[0] * 1.02:
            return False
    if "pack" in size and (p.pack or 1) != int(size["pack"]):
        return False
    if "each" in size:
        each = parse_amount(size["each"])
        if not each or p.base != each[1] or not p.each or abs(p.each - each[0]) > 0.02 * each[0]:
            return False
        if not p.pack or not (int(size.get("pack_min", 1)) <= p.pack <= int(size.get("pack_max", 10_000))):
            return False
    return True


def same_product_matches(item: WatchItem, products: list[Product]) -> tuple[Match | None, list[Match]]:
    """(the anchor, the same product at other stores)."""
    a = item.anchor or {}
    anchor: Match | None = None
    if a.get("product_id"):
        p = next((x for x in products if x.chain == a["chain"] and x.store_id == str(a["product_id"])), None)
        if p:
            anchor = Match(p, "anchor", f"anchor: {p.chain} product {p.store_id}", 1.0)
    else:
        found = find_by_name([x for x in products if x.chain == a["chain"]], a["name"], sold_by=a.get("sold_by"),
                             generic=bool(a.get("generic")),
                             categories={str(c) for c in item.categories.get(a["chain"], [])})
        if found and found[1] >= REVIEW:
            anchor = Match(found[0], "anchor", f"anchor: {a['chain']} product named like '{a['name']}'",
                           round(min(found[1], 1.0), 2))
    if anchor is None or item.level == "exact":
        return anchor, []
    ap = anchor.product
    others: list[Match] = []
    for p in products:
        if p.chain == ap.chain:
            continue
        if ap.gtins and ap.gtins & p.gtins:
            others.append(Match(p, "same_product", "same barcode", 1.0))
            continue
        if a.get("generic"):
            core = [w for w in normalise(a["name"]).split() if w not in ("each", "loose", "per", "kg")]
            if core and all(has_term(p.norm, w) for w in core) and not (p.comparable and p.base in ("g", "ml")):
                others.append(Match(p, "same_product", f"same product: {' '.join(core)} (each)", 0.85))
            continue
        same_brand = ap.brand and (p.brand == ap.brand or has_term(p.norm, ap.brand))
        same_size = (ap.comparable and p.comparable and ap.base == p.base and ap.total and p.total
                     and abs(ap.total - p.total) <= 0.02 * ap.total)
        if not (same_brand and same_size):
            continue
        sim = fuzz.token_set_ratio(ap.norm, p.norm) / 100
        if sim < 0.8:
            continue
        conf = round(0.75 + 0.25 * (sim - 0.8) / 0.2, 2)
        others.append(Match(p, "same_product", "same brand and size", conf))
    return anchor, others


def match_item(item: WatchItem, products: list[Product]) -> list[Match]:
    out: list[Match] = []
    if item.level in ("exact", "same_product"):
        anchor, others = same_product_matches(item, products)
        if anchor:
            out.append(anchor)
        out += others
    if item.level == "similar" or (item.also_similar and item.similar):
        seen = {m.product.id for m in out}
        out += [m for m in similar_matches(item, products) if m.product.id not in seen]
    return out


def run_matching(conn: sqlite3.Connection, items: list[WatchItem], household_id: int = 1) -> dict[str, int]:
    """Recompute every watch item's matches. Decisions are applied on top: rejected stays rejected,
    confirmed stays confirmed."""
    products = load_products(conn)
    by_store_id = {(p.chain, p.store_id): p for p in products}
    ts = now_iso()
    counts = {"matched": 0, "review": 0, "rejected": 0, "confirmed": 0}
    conn.execute("DELETE FROM watch_matches WHERE watch_item_id IN (SELECT id FROM watch_items WHERE household_id = ?)",
                 (household_id,))
    for item in items:
        wid = conn.execute("SELECT id FROM watch_items WHERE household_id = ? AND key = ?",
                           (household_id, item.key)).fetchone()[0]
        decisions = {(r["chain"], r["store_product_id"]): r["decision"] for r in conn.execute(
            "SELECT * FROM match_decisions WHERE watch_item_id = ?", (wid,))}
        matches = {m.product.id: m for m in match_item(item, products)}
        for (chain, store_pid), decision in decisions.items():
            p = by_store_id.get((chain, store_pid))
            if p and decision == "confirm" and p.id not in matches:
                matches[p.id] = Match(p, "confirmed", "confirmed by you", 1.0)
        for m in matches.values():
            decision = decisions.get((m.product.chain, m.product.store_id))
            if decision == "reject":
                status, conf = "rejected", m.confidence
            elif decision == "confirm":
                status, conf = "confirmed", 1.0
            else:
                status, conf = ("auto" if m.confidence >= AUTO else "review"), m.confidence
            counts["matched" if status == "auto" else status] += 1
            conn.execute(
                """INSERT INTO watch_matches(watch_item_id, retailer_product_id, match_type, reason, confidence, status,
                   matcher_version, matched_at) VALUES (?,?,?,?,?,?,?,?)""",
                (wid, m.product.id, m.match_type, m.reason, conf, status, MATCHER_VERSION, ts))
    conn.commit()
    return counts


def match_receipt_name(name: str, products: list[Product]) -> tuple[Product, float] | None:
    """For the receipt-name test (and, later, receipt scanning): which Woolworths product is this line?"""
    sold_by = None
    return find_by_name([p for p in products if p.chain == "woolworths"], name, sold_by=sold_by)


def watch_item_for_name(name: str, items: list[WatchItem], products: list[Product]) -> str | None:
    """Which watch item does a product name belong to? (Rule items by their rule; same-product items
    by their anchor product.)"""
    norm = normalise(name)
    fake = Product(-1, "receipt", "", name, norm, None, "", set(), *_size_fields(name), False)
    for item in items:
        if item.level == "similar" and similar_matches(item, [fake]):
            return item.key
    best: tuple[str, float] | None = None
    for item in items:
        if item.level == "similar" or not item.anchor:
            continue
        score = fuzz.token_set_ratio(norm, normalise(item.anchor.get("name", ""))) / 100
        if best is None or score > best[1]:
            best = (item.key, score)
    return best[0] if best and best[1] >= 0.8 else None


def _size_fields(name: str):
    s = parse_size(name)
    return s.total_quantity, s.base_unit, s.size_quantity, s.pack_count, s.comparable


def matches_json(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        """SELECT w.key, w.name, p.chain, p.retailer_product_id, p.display_name, p.name AS pname, m.match_type,
                  m.reason, m.confidence, m.status
           FROM watch_matches m JOIN watch_items w ON w.id = m.watch_item_id
           JOIN retailer_products p ON p.id = m.retailer_product_id ORDER BY w.key, p.chain""").fetchall()
    return [dict(r) for r in rows]


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=1)
