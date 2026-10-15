"""The matching accuracy report (Part 5). Private: it reads data/private and is written to
data/reports/ (never committed), because it shows receipt names."""

from __future__ import annotations

import csv
import sqlite3
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

from . import config
from .matching import AUTO, find_by_name, load_products, normalise, watch_item_for_name
from .runner import is_paused_for_good
from .timeutil import now_utc
from .watchlist import TIERS, WatchItem

STORES = ["woolworths", "coles", "aldi", "costco", "chemistwarehouse"]
STORE_NAMES = {"woolworths": "Woolworths", "coles": "Coles", "aldi": "ALDI", "costco": "Costco",
               "chemistwarehouse": "Chemist Warehouse"}
REPORTS = config.DATA_DIR / "reports"


@dataclass
class Cell:
    status: str          # anchor | same product | similar | review | not found | not collected | paused
    detail: str = ""


def store_cells(conn: sqlite3.Connection, items: list[WatchItem]) -> dict[str, dict[str, Cell]]:
    collected = {r[0] for r in conn.execute("SELECT DISTINCT chain FROM retailer_products")}
    rows = conn.execute(
        """SELECT w.key, p.chain, COALESCE(p.display_name, p.name) AS name, m.match_type, m.reason, m.confidence,
                  m.status FROM watch_matches m JOIN watch_items w ON w.id = m.watch_item_id
           JOIN retailer_products p ON p.id = m.retailer_product_id WHERE m.status != 'rejected'
           ORDER BY m.confidence DESC""").fetchall()
    by: dict[tuple[str, str], list[sqlite3.Row]] = defaultdict(list)
    for r in rows:
        by[(r["key"], r["chain"])].append(r)
    out: dict[str, dict[str, Cell]] = {}
    for item in items:
        out[item.key] = {}
        for chain in STORES:
            ms = by.get((item.key, chain), [])
            if is_paused_for_good(conn, chain) or not config.chain_config(chain).get("enabled", True):
                cell = Cell("paused")
            elif chain not in collected:
                cell = Cell("not collected")
            elif not ms:
                cell = Cell("not found")
            else:
                best = ms[0]
                kinds = {r["match_type"] for r in ms}
                if any(r["status"] in ("auto", "confirmed") for r in ms):
                    status = ("anchor" if "anchor" in kinds else "same product" if "same_product" in kinds
                              else "confirmed" if "confirmed" in kinds else "similar")
                else:
                    status = "review"
                n = len(ms)
                cell = Cell(status, f"{best['name']} ({best['reason']}, {best['confidence']:.2f})"
                            + (f" +{n - 1} more" if n > 1 else ""))
            out[item.key][chain] = cell
    return out


@dataclass
class ReceiptResult:
    channel: str
    receipt_name: str
    expected_item: str
    got_item: str | None
    expected_product: str
    got_product: str | None
    product_ok: bool | None   # None = expected product not collected yet, so it can't be tested
    item_ok: bool


def receipt_test(conn: sqlite3.Connection, items: list[WatchItem],
                 path: Path = config.DATA_DIR / "private" / "woolworths_receipt_items.csv") -> list[ReceiptResult]:
    products = [p for p in load_products(conn) if p.chain == "woolworths"]
    by_name = {i.name: i for i in items}
    results = []
    seen = set()
    with path.open(newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            item = by_name.get(r["watch_item"])
            if item is None:
                continue
            key = (r["channel"], r["receipt_name"], r["product"])
            if key in seen:
                continue
            seen.add(key)
            expected = find_by_name(products, r["product"])
            got = find_by_name(products, r["receipt_name"])
            if expected is None or expected[1] < 0.70:   # short canonical names score lower; size must still agree
                product_ok, got_name = None, got[0].name if got else None
            else:
                product_ok = got is not None and got[0].id == expected[0].id
                got_name = got[0].name if got else None
            got_item = watch_item_for_name(r["receipt_name"], items, products)
            results.append(ReceiptResult(r["channel"], r["receipt_name"], item.key, got_item, r["product"],
                                         got_name, product_ok, got_item == item.key))
    return results


def build_report(conn: sqlite3.Connection, items: list[WatchItem]) -> tuple[str, dict]:
    items = sorted(items, key=lambda i: (TIERS.get(i.tier, 9), i.name.lower()))
    cells = store_cells(conn, items)
    receipts = receipt_test(conn, items)
    lines = [f"# Matching accuracy report ({now_utc().astimezone().strftime('%a %-d %b %Y, %-I:%M %p')})", ""]

    tally: Counter = Counter()
    lines += ["## Watch items by store", "",
              "| Watch item | Level | " + " | ".join(STORE_NAMES[s] for s in STORES) + " |",
              "|---|---|" + "---|" * len(STORES)]
    for it in items:
        row = [f"{it.name} ({it.tier})", it.level.replace("_", " ")]
        for s in STORES:
            c = cells[it.key][s]
            tally[(s, c.status)] += 1
            row.append(c.status)
        lines.append("| " + " | ".join(row) + " |")

    lines += ["", "## Per store", "", "| Store | anchor / same product | similar | review | not found | not collected / paused |",
              "|---|---|---|---|---|---|"]
    for s in STORES:
        lines.append(f"| {STORE_NAMES[s]} | {tally[(s, 'anchor')] + tally[(s, 'same product')] + tally[(s, 'confirmed')]} "
                     f"| {tally[(s, 'similar')]} | {tally[(s, 'review')]} | {tally[(s, 'not found')]} "
                     f"| {tally[(s, 'not collected')] + tally[(s, 'paused')]} |")

    lines += ["", "## Details (best match per store)", ""]
    for it in items:
        lines.append(f"**{it.name}** ({it.level.replace('_', ' ')})")
        for s in STORES:
            c = cells[it.key][s]
            lines.append(f"- {STORE_NAMES[s]}: {c.status}" + (f": {c.detail}" if c.detail else ""))
        lines.append("")

    testable = [r for r in receipts if r.product_ok is not None]
    prod_pass = sum(r.product_ok for r in testable)
    item_pass = sum(r.item_ok for r in receipts)
    by_channel = defaultdict(lambda: [0, 0, 0, 0])
    for r in receipts:
        c = by_channel[r.channel]
        c[0] += r.item_ok
        c[1] += 1
        if r.product_ok is not None:
            c[2] += r.product_ok
            c[3] += 1
    lines += ["## Receipt-name test", "",
              f"Distinct receipt names for the watch items: {len(receipts)}.", "",
              f"- **Receipt name → right watch item:** {item_pass}/{len(receipts)}",
              f"- **Receipt name → right Woolworths product:** {prod_pass}/{len(testable)} "
              f"({len(receipts) - len(testable)} not testable yet: the product hasn't been collected)", ""]
    for ch, (ip, it_, pp, pt) in sorted(by_channel.items()):
        lines.append(f"- {ch}: watch item {ip}/{it_}, product {pp}/{pt}")
    misses = [r for r in receipts if not r.item_ok or r.product_ok is False]
    lines += ["", "### Misses", ""]
    for r in misses:
        bits = []
        if not r.item_ok:
            bits.append(f"watch item: expected {r.expected_item}, got {r.got_item}")
        if r.product_ok is False:
            bits.append(f"product: expected '{r.expected_product}', got '{r.got_product}'")
        lines.append(f"- [{r.channel}] \"{r.receipt_name}\": " + "; ".join(bits))
    untestable = [r for r in receipts if r.product_ok is None]
    if untestable:
        lines += ["", "### Not testable yet (product not collected)", ""]
        lines += sorted({f"- {r.expected_product}" for r in untestable})

    summary = {
        "store_tally": {f"{s}:{k}": v for (s, k), v in tally.items()},
        "receipt_item_pass": item_pass, "receipt_total": len(receipts),
        "receipt_product_pass": prod_pass, "receipt_product_testable": len(testable),
    }
    return "\n".join(lines) + "\n", summary


def write_report(conn: sqlite3.Connection, items: list[WatchItem]) -> tuple[Path, dict]:
    text, summary = build_report(conn, items)
    REPORTS.mkdir(parents=True, exist_ok=True)
    path = REPORTS / f"match-report-{now_utc().astimezone().strftime('%Y-%m-%d')}.md"
    path.write_text(text, encoding="utf-8")
    return path, summary


# Keep AUTO and normalise importable for callers that format reports.
__all__ = ["AUTO", "build_report", "normalise", "write_report"]
