"""ALDI: the public JSON API the website calls (asl.api.aldi.com.au)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import timedelta
from typing import Any

from ..models import NormalisedItem, Observation, ProductInfo
from ..parsing import parse_unit_price_text, to_cents
from ..timeutil import iso, sydney_midnight, sydney_today
from .base import CategoryInfo, Collector, Coverage, RawItem

API = "https://asl.api.aldi.com.au/commerce"
SITE = "https://www.aldi.com.au"
PAGE_SIZE = 60  # the API only accepts 12/16/24/30/32/48/60

# Category-tree keys for ALDI's own deal sections.
DEAL_CATEGORIES = [
    {"key": "1588161426952145", "name": "Super Savers", "special_type": "super_saver", "is_special": True},
    {"key": "1588161425841179", "name": "Lower Prices", "special_type": "lower_price", "is_special": False},
]
PRICE_KEYS = {"price", "notForSale", "notForSaleReason", "discontinued", "discontinuedNote", "badges"}


class AldiCollector(Collector):
    chain = "aldi"

    def _search(self, params: dict[str, Any]) -> dict[str, Any]:
        base = {"currency": "AUD", "serviceType": "walk-in", "servicePoint": self.store_ref,
                "limit": PAGE_SIZE, "sort": "relevance"}
        return self.client.get(f"{API}/v3/product-search", params={**base, **params}).json()

    def _read(self, scope_type: str, scope_ref: str, name: str, params: dict[str, Any],
              context: dict[str, Any]) -> Iterator[RawItem]:
        cov = Coverage(scope_type, scope_ref, name)
        self.coverage.append(cov)
        offset, total, page = 0, None, 0
        while total is None or (offset < total and page < self.pages_to_read(10_000)):
            data = self._search({**params, "offset": offset})
            total = data["meta"]["pagination"]["totalCount"]
            cov.items_total, cov.pages_total = total, max(1, -(-total // PAGE_SIZE))
            for item in data.get("data") or []:
                cov.items_seen += 1
                yield RawItem(item, context)
            page += 1
            cov.pages_read = page
            offset += PAGE_SIZE
            if not data.get("data"):
                break
        cov.complete = cov.pages_read >= cov.pages_total

    # -- interface --------------------------------------------------------

    def fetch_specials(self) -> Iterator[RawItem]:
        # Special Buys: one query per drop date (Wednesdays and Saturdays), recent and upcoming.
        sb = self.cfg.get("special_buys", {})
        today = sydney_today()
        for offset in range(-sb.get("days_back", 7), sb.get("days_ahead", 14) + 1):
            day = today + timedelta(days=offset)
            if day.weekday() not in (2, 5):
                continue
            key = day.isoformat()
            yield from self._read("promotion_date", key, f"Special Buys {key}", {"promotionKey": key},
                                  {"special_type": "special_buy", "is_special": True})
        # Super Savers (weekly grocery deals) and Lower Prices.
        for cat in DEAL_CATEGORIES:
            yield from self._read("specials_group", cat["key"], cat["name"], {"categoryTree": cat["key"]},
                                  {"special_type": cat["special_type"], "is_special": cat["is_special"]})

    def fetch_category(self, category: dict[str, Any]) -> Iterator[RawItem]:
        yield from self._read("category", str(category["key"]), category.get("name", ""),
                              {"categoryTree": category["key"]}, {})

    def discover_categories(self) -> list[CategoryInfo]:
        tree = self.client.get(f"{API}/v2/product-category-tree",
                               params={"serviceType": "walk-in", "servicePoint": self.store_ref}).json()["data"]
        out: list[CategoryInfo] = []

        def walk(node: dict[str, Any], names: list[str]) -> None:
            names = names + [node["name"]]
            out.append(CategoryInfo(node["key"], node["name"], " > ".join(names),
                                    f"/products/{node.get('urlSlugText', '')}"))
            for child in node.get("children") or []:
                walk(child, names)

        for node in tree:
            walk(node, [])
        return out

    # -- normalise --------------------------------------------------------

    def normalise(self, raw: RawItem) -> NormalisedItem | None:
        p, ctx = raw.data, raw.context
        pr = p.get("price") or {}
        sku = p.get("sku")
        if not sku:
            return None
        slug = p.get("urlSlugText") or ""
        assets = p.get("assets") or []
        image = assets[0]["url"].replace("{width}", "500").replace("{slug}", slug) if assets else None
        cats = p.get("categories") or []
        product = ProductInfo(
            chain=self.chain,
            retailer_product_id=str(sku),
            name=p.get("name") or "",
            display_name=" ".join(x for x in (p.get("brandName"), p.get("name")) if x),
            brand=(p.get("brandName") or "").title() or None,
            size_text=p.get("sellingSize") or None,
            url=f"{SITE}/product/{slug}-{sku}" if slug else None,
            image_url=image,
            category_path=" > ".join(c["name"] for c in cats) or None,
        )

        comparison = pr.get("comparisonDisplay")
        unit = parse_unit_price_text(comparison)
        weighed = str(p.get("weightType")) == "1"
        if weighed:
            # Sold by weight: ALDI's real price is the per-kg price; the pack price is an estimate.
            price_c = to_cents(unit[0]) if unit and unit[1] == "1KG" else None
            if price_c is None:
                return None  # can't read the per-kg price reliably: don't record a guess
        else:
            price_c = pr.get("amountRelevant") if pr.get("amountRelevant") is not None else pr.get("amount")
        was_c = to_cents(pr.get("wasPriceDisplay")) if pr.get("wasPriceDisplay") else None
        if was_c is not None and price_c is not None and was_c <= price_c:
            was_c = None
        is_special = bool(ctx.get("is_special")) or was_c is not None
        special_type = ctx.get("special_type") or ("price_drop" if was_c is not None else None)
        on_sale = p.get("onSaleDate")
        obs = Observation(
            store_ref=self.store_ref,
            price_basis="in_store",
            price_per="kg" if weighed else "each",
            price_cents=price_c,
            was_cents=was_c,
            is_special=is_special,
            special_type=special_type,
            promo_text=_promo_text(ctx, pr, on_sale, weighed, p),
            unit_price=unit[0] if unit else None,
            unit_measure=unit[1] if unit else None,
            unit_price_text=comparison,
            valid_from=iso(sydney_midnight(_date(on_sale))) if on_sale else None,
            valid_to=None,  # Special Buys are "while stocks last"; ALDI gives no end date
            valid_to_source=None,
            in_stock=None,  # ALDI doesn't say
        )
        raw_product = {k: v for k, v in p.items() if k not in PRICE_KEYS}
        raw_price = {k: p.get(k) for k in PRICE_KEYS if k in p}
        return NormalisedItem(product=product, gtins=[], observations=[obs],
                              raw_product=raw_product, raw_price=raw_price)


def _promo_text(ctx, pr, on_sale, weighed, p) -> str | None:
    bits = []
    if ctx.get("special_type") == "special_buy":
        bits.append(p.get("onSaleDateDisplay") or f"Special Buy from {on_sale}")
    elif ctx.get("special_type") == "super_saver":
        bits.append("Super Saver")
    elif ctx.get("special_type") == "lower_price":
        bits.append("Lower price")
    if pr.get("savingsDisplay"):
        bits.append(pr["savingsDisplay"])
    if weighed and pr.get("amountRelevantDisplay"):
        bits.append(f"approx. {pr['amountRelevantDisplay']} per pack")
    return " · ".join(bits) or None


def _date(value: str):
    from datetime import date

    return date.fromisoformat(value[:10])
