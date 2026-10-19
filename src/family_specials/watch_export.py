"""The family watchlist the app shows (This Week's Core Essentials and Regulars, the Watchlist tab, Home).
Private since 19 Oct 2026: sent to the family's row in Supabase, never published.

For every watch item: its current offers (matched products at each store), a unit price in the
item's own unit (per kg, per L, per can, per tea bag...), weekly price history for the chart, and
buy-now signals. Signals appear only when the data supports them (docs/app-plan.md):

  "Half price" / "Multibuy deal"  the store's own promo
  "Lowest in N weeks"            at least 4 weeks of history, and the lowest price seen; otherwise
                                 "Not enough history yet"
  "Below your target"            a target unit price is set and met
  "Was price looks inflated"     the was price is above every normal price we've recorded
  "Usually cheaper on special"   normal price now, but on special in the last 12 weeks
Nothing ever predicts when the next special will be.

For the Home screen, each special also says whether it is new this week (only when we read the product
in the week before, otherwise "can't tell"), and each offer carries the normal shelf price we've
recorded for it, with how many weeks we saw that price.
"""

from __future__ import annotations

import re
import sqlite3
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any

from . import config, watchlist
from .export import STORE_NAMES, build_products
from .matching import rule_summary
from .runner import is_paused_for_good
from .timeutil import SYDNEY, iso, now_utc, parse_iso, weekly_cycle
from .watchlist import TIERS, WatchItem

MIN_HISTORY_WEEKS = 4
USUAL_MIN_WEEKS = 2       # "usually $X" needs this many different weeks at that normal price
SPECIAL_LOOKBACK_WEEKS = 12
WEIGHT_RANGE = re.compile(r"(\d+(?:\.\d+)?)\s*(g|kg)\s*-\s*(\d+(?:\.\d+)?)\s*(g|kg)", re.I)
COUNT_UNITS = {"item", "can", "bag", "sheet", "wipe", "tea bag", "roll", "egg"}


def max_weight_kg(text: str) -> float | None:
    """'Pork Rashers 350g - 800g' -> 0.8. Woolworths prices weighed packs at the top of the range."""
    m = WEIGHT_RANGE.search(text or "")
    if not m:
        return None
    hi, unit = float(m.group(3)), m.group(4).lower()
    return hi / 1000 if unit == "g" else hi


def item_unit_cents(price_cents: float | None, price_per: str, attrs: sqlite3.Row | None, compare_per: str,
                    name: str) -> float | None:
    """Price per the watch item's unit. None when it can't be worked out reliably (never guessed)."""
    if price_cents is None:
        return None
    comparable = bool(attrs and attrs["comparable"] and attrs["total_quantity"])
    base = attrs["base_unit"] if attrs else None
    total = attrs["total_quantity"] if attrs else None
    if compare_per == "kg":
        if price_per == "kg":
            return float(price_cents)
        if comparable and base == "g":
            return price_cents * 1000 / total
        kg = max_weight_kg(name)
        return price_cents / kg if kg else None
    if compare_per == "L":
        return price_cents * 1000 / total if comparable and base == "ml" else None
    # Counted units: per can, bag, sheet, wipe, tea bag, roll or item.
    if comparable and base == "each":
        return price_cents / total
    if comparable and base in ("g", "ml") and attrs["pack_count"] and attrs["pack_count"] > 1:
        return price_cents / attrs["pack_count"]          # 24 x 375 mL cans -> per can
    if compare_per == "item" and re.search(r"\beach\b", name, re.I) and not comparable:
        return float(price_cents)                          # "Leek each": one item
    return None


def week_start(ts: str) -> str:
    d = parse_iso(ts).astimezone(SYDNEY).date()
    return (d - timedelta(days=d.weekday())).isoformat()


def special_status(rows: list[tuple], cycle_start: datetime) -> tuple[str | None, bool | None]:
    """When the current special started, and whether it is new this cycle.

    `rows` are (observed_at, price_cents, is_special, multibuy_cents) for one product at one chain, oldest
    first. New means: the special (at this price) was first seen this cycle, and we read the product in the
    week before and it wasn't on that special then. None when we can't tell (first time we've seen it, or
    no read in the week before).
    """
    if not rows or not rows[-1][2]:
        return None, None
    same = (rows[-1][1], rows[-1][3])
    i = len(rows) - 1
    while i > 0 and rows[i - 1][2] and (rows[i - 1][1], rows[i - 1][3]) == same:
        i -= 1
    since = rows[i][0]
    if parse_iso(since) < cycle_start:
        return since, False
    if i == 0 or parse_iso(rows[i - 1][0]) < cycle_start - timedelta(days=7):
        return since, None
    return since, True


def usual_price(rows: list[tuple]) -> tuple[int | None, int]:
    """The latest normal (not special) shelf price we've recorded, and in how many different weeks.

    `rows` are (observed_at, price_cents, is_special) for one product at one store, oldest first.
    """
    normal = [r for r in rows if not r[2] and r[1] is not None]
    if not normal:
        return None, 0
    price = normal[-1][1]
    return price, len({week_start(r[0]) for r in normal if r[1] == price})


def build_watchlist(conn: sqlite3.Connection, items: list[WatchItem] | None = None,
                    products: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """The family's watchlist as the app shows it. Private: it goes only to the family's row in Supabase (and a copy
    on the Mac for notifications), never into the public data."""
    items = items or watchlist.load()
    now = now_utc()
    if products is None:
        matched = {r[0] for r in conn.execute("SELECT retailer_product_id FROM watch_matches WHERE status IN ('auto', 'confirmed')")}
        products = build_products(conn, keep_internal_id=True, only=matched)
    offers_by_pid = {p["_pid"]: p for p in products}
    attrs = {r["retailer_product_id"]: r for r in conn.execute("SELECT * FROM product_attributes")}
    chains = list(config.settings()["chains"])
    first_obs = conn.execute("SELECT MIN(observed_at) FROM price_observations").fetchone()[0]
    cycle_start = weekly_cycle(2, now)[0]

    out_items = []
    for item in sorted(items, key=lambda i: (TIERS.get(i.tier, 9), i.name.lower())):
        row = conn.execute("SELECT id FROM watch_items WHERE household_id = 1 AND key = ?", (item.key,)).fetchone()
        if row is None:
            continue
        matches = conn.execute(
            """SELECT m.*, p.chain, p.retailer_product_id AS store_pid, COALESCE(p.display_name, p.name) AS pname
               FROM watch_matches m JOIN retailer_products p ON p.id = m.retailer_product_id
               WHERE m.watch_item_id = ? AND m.status IN ('auto', 'confirmed')""", (row["id"],)).fetchall()
        offers = []
        for m in matches:
            o = offers_by_pid.get(m["retailer_product_id"])
            if o is None:
                continue  # matched, but no current price (not seen recently, or its special ended)
            a = attrs.get(m["retailer_product_id"])
            unit = item_unit_cents(o["price_cents"], o["price_per"], a, item.compare_per, o["name"])
            mb_unit = None
            if o["multibuy"]:
                mb_unit = item_unit_cents(o["multibuy"]["each_cents"], o["price_per"], a, item.compare_per, o["name"])
            offer = {k: v for k, v in o.items() if not k.startswith("_") and k not in ("unit", "category")}
            offer.update({
                "unit_cents": round(unit, 2) if unit is not None else None,
                "multibuy_unit_cents": round(mb_unit, 2) if mb_unit is not None else None,
                "match": m["reason"], "match_type": m["match_type"],
            })
            offer["signals"] = _signals(conn, m["retailer_product_id"], o, item, unit, mb_unit, now)
            offer.update(_status(conn, m["retailer_product_id"], o, cycle_start))
            offers.append(offer)
        offers.sort(key=lambda x: (_best_unit(x) is None, _best_unit(x) or 0, not x["special"]))
        matched_chains = {o["chain"] for o in offers}
        stores_note = {}
        for chain in chains:
            if chain in matched_chains:
                continue
            cfg = config.chain_config(chain)
            if is_paused_for_good(conn, chain) or not cfg.get("enabled", True):
                stores_note[chain] = "paused"
            elif any(m["chain"] == chain for m in matches):
                stores_note[chain] = "no current price"
            else:
                stores_note[chain] = "not found"
        out_items.append({
            "key": item.key, "name": item.name, "tier": item.tier, "level": item.level,
            "compare_per": item.compare_per, "target_cents": item.target_cents,
            "rule": rule_summary(item) if item.level == "similar" else
            f"same product, any store: {item.anchor.get('name', '')}",
            "on_special": any(o["special"] for o in offers),
            "offers": offers,
            "stores_note": stores_note,
            "history": _history(conn, [m["retailer_product_id"] for m in matches], item, attrs),
        })
    return {"generated_at": iso(now), "history_started": first_obs[:10] if first_obs else None,
            "cycle_started": cycle_start.date().isoformat(), "min_history_weeks": MIN_HISTORY_WEEKS,
            "stores": [{"chain": c, "name": STORE_NAMES.get(c, c)} for c in chains], "items": out_items}


def _best_unit(o: dict[str, Any]) -> float | None:
    units = [u for u in (o.get("multibuy_unit_cents"), o.get("unit_cents")) if u is not None]
    return min(units) if units else None


def _status(conn: sqlite3.Connection, pid: int, o: dict[str, Any], cycle_start: datetime) -> dict[str, Any]:
    rows = conn.execute(
        """SELECT o.observed_at, o.price_cents, o.is_special, o.multibuy_cents, s.store_ref
           FROM price_observations o JOIN stores s ON s.id = o.store_id
           WHERE o.retailer_product_id = ? AND o.price_cents IS NOT NULL ORDER BY o.observed_at""", (pid,)).fetchall()
    since, new = special_status([(r[0], r[1], bool(r[2]), r[3]) for r in rows], cycle_start) if o["special"] else (None, None)
    usual, weeks = usual_price([(r[0], r[1], bool(r[2])) for r in rows if r[4] == o["store_ref"]])
    return {"special_since": since, "new_this_cycle": new,
            "usual_cents": usual if weeks >= USUAL_MIN_WEEKS else None, "usual_weeks": weeks if usual else 0}


def _signals(conn: sqlite3.Connection, pid: int, o: dict[str, Any], item: WatchItem, unit: float | None,
             mb_unit: float | None, now: datetime) -> list[dict[str, str]]:
    sig: list[dict[str, str]] = []
    # 1. The store's own promo.
    if o["special"]:
        if o["special_type"] == "half_price" or (o["was_cents"] and o["price_cents"]
                                                 and abs(o["price_cents"] * 2 - o["was_cents"]) <= 2):
            sig.append({"kind": "promo", "text": "Half price"})
        elif o["multibuy"]:
            sig.append({"kind": "promo", "text": f"Multibuy deal: {o['multibuy']['qty']} for "
                                                 f"${o['multibuy']['cents'] / 100:.2f}"})
    # 2. Target unit price.
    best = min([u for u in (unit, mb_unit) if u is not None], default=None)
    if item.target_cents and best is not None and best <= item.target_cents:
        sig.append({"kind": "target", "text": "Below your target"})
    # 3. History for this product at this store.
    rows = conn.execute(
        """SELECT o.observed_at, o.price_cents, o.is_special, o.was_cents FROM price_observations o
           JOIN stores s ON s.id = o.store_id WHERE o.retailer_product_id = ? AND o.price_cents IS NOT NULL
           AND s.store_ref = ? ORDER BY o.observed_at""", (pid, o["store_ref"])).fetchall()
    if rows:
        weeks = (parse_iso(rows[-1]["observed_at"]) - parse_iso(rows[0]["observed_at"])).days // 7
        if weeks < MIN_HISTORY_WEEKS:
            sig.append({"kind": "history", "text": "Not enough history yet"})
        elif o["price_cents"] is not None and o["price_cents"] <= min(r["price_cents"] for r in rows):
            sig.append({"kind": "history", "text": f"Lowest in {weeks} weeks"})
        normal = [r["price_cents"] for r in rows if not r["is_special"]]
        if o["was_cents"] and normal and o["was_cents"] > max(normal):
            sig.append({"kind": "warning", "text": "Was price looks inflated"})
        cutoff = iso(now - timedelta(weeks=SPECIAL_LOOKBACK_WEEKS))
        if not o["special"] and any(r["is_special"] and r["observed_at"] >= cutoff for r in rows):
            sig.append({"kind": "history", "text": "Usually cheaper on special"})
    return sig


def _history(conn: sqlite3.Connection, pids: list[int], item: WatchItem,
             attrs: dict[int, sqlite3.Row]) -> dict[str, Any]:
    """Weekly lowest unit price per store (in the item's unit), for the chart."""
    if not pids:
        return {"weeks": [], "series": {}, "specials": {}}
    rows = conn.execute(
        f"""SELECT o.observed_at, o.price_cents, o.price_per, o.is_special, p.chain, p.id AS pid,
                   COALESCE(p.display_name, p.name) AS name
            FROM price_observations o JOIN retailer_products p ON p.id = o.retailer_product_id
            WHERE o.retailer_product_id IN ({','.join('?' * len(pids))}) AND o.price_cents IS NOT NULL""",
        pids).fetchall()
    best: dict[tuple[str, str], tuple[float, bool]] = {}
    for r in rows:
        u = item_unit_cents(r["price_cents"], r["price_per"], attrs.get(r["pid"]), item.compare_per, r["name"])
        if u is None:
            continue
        key = (r["chain"], week_start(r["observed_at"]))
        if key not in best or u < best[key][0]:
            best[key] = (u, bool(r["is_special"]))
    weeks = sorted({w for _, w in best})
    series: dict[str, list] = defaultdict(list)
    specials: dict[str, list] = defaultdict(list)
    for chain in sorted({c for c, _ in best}):
        for w in weeks:
            v = best.get((chain, w))
            series[chain].append(round(v[0], 2) if v else None)
            specials[chain].append(bool(v and v[1]))
    return {"weeks": weeks, "series": dict(series), "specials": dict(specials)}
