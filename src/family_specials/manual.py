"""Manual entry for stores with no online data (Tong Li), from a CSV typed up from the flyer.

Columns (see config/tongli_template.csv):
  name, brand, size, price, was_price, special_text, valid_from, valid_to, product_code, notes
Dates are YYYY-MM-DD (Sydney). Prices like 4.99. Only `name` and `price` are required.
"""

from __future__ import annotations

import csv
import re
import sqlite3
from dataclasses import dataclass
from datetime import date

from . import config, db
from .models import NormalisedItem, Observation, ProductInfo
from .parsing import to_cents
from .timeutil import iso, sydney_end_of_day, sydney_midnight


@dataclass
class ImportResult:
    run_id: int
    status: str
    items: int
    observations: int


def import_tongli_csv(conn: sqlite3.Connection, path: str) -> ImportResult:
    chain = "tongli"
    store_ref = str(config.chain_config(chain)["store"]["ref"])
    run_id = db.start_run(conn, chain, "manual")
    items = obs_count = 0
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            row = {k.strip().lower(): (v or "").strip() for k, v in row.items() if k}
            if not row.get("name") or not row.get("price"):
                continue
            # Tong Li has no product ids online. Use the flyer/shelf code if given, otherwise a
            # stable manual id built from brand + name + size.
            pid = row.get("product_code") or "manual:" + _slug(row.get("brand", ""), row["name"], row.get("size", ""))
            price, was = to_cents(row["price"]), to_cents(row.get("was_price"))
            start = date.fromisoformat(row["valid_from"]) if row.get("valid_from") else None
            end = date.fromisoformat(row["valid_to"]) if row.get("valid_to") else None
            item = NormalisedItem(
                product=ProductInfo(chain=chain, retailer_product_id=pid, name=row["name"],
                                    display_name=" ".join(x for x in (row.get("brand"), row["name"]) if x),
                                    brand=row.get("brand") or None, size_text=row.get("size") or None),
                observations=[Observation(
                    store_ref=store_ref, price_basis="in_store", price_cents=price,
                    was_cents=was if was and price and was > price else None,
                    is_special=True, special_type="flyer", promo_text=row.get("special_text") or None,
                    valid_from=iso(sydney_midnight(start)) if start else None,
                    valid_to=iso(sydney_end_of_day(end)) if end else None,
                    valid_to_source="manual" if end else None,
                )],
                raw_product={"csv": {k: v for k, v in row.items() if k not in ("price", "was_price")}},
                raw_price={"price": row.get("price"), "was_price": row.get("was_price")},
            )
            obs_count += db.save_item(conn, run_id, item, "manual")
            items += 1
    db.finish_run(conn, run_id, "ok", 0, items, obs_count)
    return ImportResult(run_id, "ok", items, obs_count)


def _slug(*parts: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", " ".join(p for p in parts if p).lower()).strip("-")
