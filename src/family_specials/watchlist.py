"""The family watchlist: config/watchlist.yaml (names and rules, committed) plus the match
decisions in watchlist/decisions.csv (confirm/reject, committed). The database copies are
rebuilt from these files on every run, so the Mac and GitHub always agree.
"""

from __future__ import annotations

import csv
import json
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from . import config
from .parsing import to_cents
from .timeutil import now_iso

WATCHLIST = config.CONFIG_DIR / "watchlist.yaml"
DECISIONS = config.PROJECT_ROOT / "watchlist" / "decisions.csv"
DECISION_FIELDS = ["watch_item", "chain", "product_id", "decision", "decided_at", "note"]
LEVELS = ("exact", "same_product", "similar")
TIERS = {"core": 0, "regular": 1, "occasional": 2}


@dataclass
class WatchItem:
    key: str
    name: str
    tier: str
    level: str
    compare_per: str
    also_similar: bool = False
    target: str | None = None
    anchor: dict[str, Any] | None = None
    similar: dict[str, Any] | None = None
    categories: dict[str, list[Any]] = field(default_factory=dict)

    @property
    def target_cents(self) -> float | None:
        return to_cents(self.target) if self.target else None


def load(path: Path | None = None) -> list[WatchItem]:
    path = path or WATCHLIST
    data = yaml.safe_load(path.read_text(encoding="utf-8")) if path.exists() else {}
    items = []
    for raw in data.get("items") or []:
        item = WatchItem(
            key=raw["key"], name=raw["name"], tier=raw.get("tier", "regular"), level=raw["level"],
            compare_per=raw.get("compare_per", "item"), also_similar=bool(raw.get("also_similar")),
            target=raw.get("target"), anchor=raw.get("anchor"), similar=raw.get("similar"),
            categories={k: (v if isinstance(v, list) else [v]) for k, v in (raw.get("categories") or {}).items()},
        )
        for chain, values in item.categories.items():
            for v in values:
                if not isinstance(v, str):
                    raise ValueError(f"{item.key}: category {v!r} for {chain} must be in quotes in watchlist.yaml "
                                     "(YAML reads 1_4003688 as a number)")
        if item.level not in LEVELS:
            raise ValueError(f"{item.key}: level must be one of {LEVELS}")
        if item.level in ("exact", "same_product") and not item.anchor:
            raise ValueError(f"{item.key}: a {item.level} item needs an anchor")
        if item.level == "similar" and not item.similar:
            raise ValueError(f"{item.key}: a similar item needs a `similar` rule")
        items.append(item)
    keys = [i.key for i in items]
    if len(keys) != len(set(keys)):
        raise ValueError("Watch item keys must be unique")
    return items


def sync_to_db(conn: sqlite3.Connection, items: list[WatchItem], household_id: int = 1) -> dict[str, int]:
    """Make the database's watch_items match the YAML (active = in the file)."""
    ts = now_iso()
    keep = set()
    for i in items:
        rule = {"anchor": i.anchor, "similar": i.similar, "categories": i.categories}
        conn.execute(
            """INSERT INTO watch_items(household_id, key, name, tier, level, also_similar, compare_per, target_cents,
               rule_json, active, updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?)
               ON CONFLICT(household_id, key) DO UPDATE SET name = excluded.name, tier = excluded.tier,
               level = excluded.level, also_similar = excluded.also_similar, compare_per = excluded.compare_per,
               target_cents = excluded.target_cents, rule_json = excluded.rule_json, active = 1,
               updated_at = excluded.updated_at""",
            (household_id, i.key, i.name, i.tier, i.level, int(i.also_similar), i.compare_per, i.target_cents,
             json.dumps(rule, sort_keys=True), ts))
        keep.add(i.key)
    conn.execute(f"UPDATE watch_items SET active = 0 WHERE household_id = ? AND key NOT IN "
                 f"({','.join('?' * len(keep)) or 'NULL'})", (household_id, *keep))
    _load_decisions(conn, household_id)
    conn.commit()
    return {"items": len(items)}


def item_id(conn: sqlite3.Connection, key: str, household_id: int = 1) -> int | None:
    row = conn.execute("SELECT id FROM watch_items WHERE household_id = ? AND key = ?", (household_id, key)).fetchone()
    return row[0] if row else None


# --------------------------------------------------------------------------- decisions (confirm / reject)


def read_decisions(path: Path | None = None) -> list[dict[str, str]]:
    path = path or DECISIONS
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def add_decision(watch_key: str, chain: str, product_id: str, decision: str, note: str = "",
                 path: Path | None = None) -> None:
    path = path or DECISIONS
    if decision not in ("confirm", "reject"):
        raise ValueError("decision must be confirm or reject")
    rows = [r for r in read_decisions(path)
            if (r["watch_item"], r["chain"], r["product_id"]) != (watch_key, chain, product_id)]
    rows.append({"watch_item": watch_key, "chain": chain, "product_id": product_id, "decision": decision,
                 "decided_at": now_iso(), "note": note})
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=DECISION_FIELDS, lineterminator="\n")
        w.writeheader()
        for r in sorted(rows, key=lambda r: (r["watch_item"], r["chain"], r["product_id"])):
            w.writerow(r)


def _load_decisions(conn: sqlite3.Connection, household_id: int) -> None:
    conn.execute("DELETE FROM match_decisions WHERE watch_item_id IN (SELECT id FROM watch_items WHERE household_id = ?)",
                 (household_id,))
    for r in read_decisions():
        wid = item_id(conn, r["watch_item"], household_id)
        if wid is None:
            continue
        conn.execute(
            """INSERT OR REPLACE INTO match_decisions(watch_item_id, chain, store_product_id, decision, decided_at, note)
               VALUES (?,?,?,?,?,?)""",
            (wid, r["chain"], r["product_id"], r["decision"], r["decided_at"], r.get("note") or None))


# --------------------------------------------------------------------------- adding from search


def add_item_from_product(conn: sqlite3.Connection, chain: str, product_id: str, *, also_similar: bool = False,
                          tier: str = "regular", target: str | None = None, path: Path | None = None) -> str:
    """Add a watch item from a product (what "add from search" does): level same_product by default,
    optionally also watching similar items. Appends to watchlist.yaml, keeping its comments."""
    p = conn.execute("SELECT * FROM retailer_products WHERE chain = ? AND retailer_product_id = ?",
                     (chain, product_id)).fetchone()
    if p is None:
        raise ValueError(f"No {chain} product {product_id} in the database")
    path = path or WATCHLIST
    name = p["display_name"] or p["name"]
    key = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60]
    if any(i.key == key for i in load(path)):
        raise ValueError(f"'{key}' is already on the watchlist")
    attrs = conn.execute("SELECT base_unit FROM product_attributes WHERE retailer_product_id = ?", (p["id"],)).fetchone()
    per = {"g": "kg", "ml": "L"}.get(attrs["base_unit"] if attrs else None, "item")
    entry = {
        "key": key, "name": name, "tier": tier, "level": "same_product", "also_similar": also_similar,
        "compare_per": per, "target": target,
        "anchor": {"chain": chain, "product_id": product_id, "name": name},
        "categories": {},
    }
    block = yaml.safe_dump([entry], sort_keys=False, allow_unicode=True)
    with path.open("a", encoding="utf-8") as f:
        f.write("\n" + "\n".join("  " + line if line else line for line in block.splitlines()) + "\n")
    return key
