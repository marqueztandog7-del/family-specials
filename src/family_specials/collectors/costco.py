"""Costco: the SAP Commerce REST API the website calls. Online prices only.

Online prices often include delivery, so they are NOT warehouse shelf prices; every
observation is labelled with its basis. Warehouse-only items show no price online.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from ..models import NormalisedItem, Observation, ProductInfo
from ..parsing import to_cents
from .base import Collector, Coverage, RawItem

BASE = "https://www.costco.com.au"
API = BASE + "/rest/v2/australia"
PAGE_SIZE = 48
# Costco reports unit prices as a value plus a unit type; the site shows "ML" as "per 100 ml".
UNIT_TYPES = {"ML": ("100ML", "100 ml")}
PRICE_KEYS = {"price", "basePrice", "discountPrice", "couponDiscount", "pricePerUnit", "unitType", "stock",
              "shippingIncluded", "displayShippingIncludedTag", "hidePriceValue", "warehouseHidePriceValue",
              "discountStartDate", "discountEndDate", "priceRange", "volumePricesFlag", "boostScore", "score",
              "lexicalScore", "vectorScore", "normalizedLexicalScore", "normalizedVectorScore", "inMyWishlist"}


class CostcoCollector(Collector):
    chain = "costco"

    def _read(self, scope_type: str, code: str | None, name: str, query: str = "") -> Iterator[RawItem]:
        cov = Coverage(scope_type, code or f"query:{query}", name)
        self.coverage.append(cov)
        page, total_pages = 0, 1
        while page < self.pages_to_read(total_pages):
            params = {"fields": "FULL", "query": query, "pageSize": PAGE_SIZE, "currentPage": page,
                      "lang": "en_AU", "curr": "AUD"}
            if code:
                params["category"] = code
            data = self.client.get(f"{API}/products/search", params=params).json()
            pag = data.get("pagination") or {}
            total_pages = pag.get("totalPages") or 1
            cov.items_total, cov.pages_total = pag.get("totalResults"), total_pages
            for item in data.get("products") or []:
                cov.items_seen += 1
                yield RawItem(item, {"category": code})
            page += 1
            cov.pages_read = page
        cov.complete = cov.pages_read >= cov.pages_total

    def fetch_specials(self) -> Iterator[RawItem]:
        for cat in self.cfg.get("specials_categories", []):
            yield from self._read("specials_group", cat["code"], cat["name"])

    def fetch_category(self, category: dict[str, Any]) -> Iterator[RawItem]:
        # Costco publishes no robots.txt and sells few groceries online, so a keyword search
        # ("jasmine rice") is used where a category would be too broad.
        yield from self._read("category", category.get("code"), category.get("name", ""),
                              category.get("query", ""))

    def normalise(self, raw: RawItem) -> NormalisedItem | None:
        p = raw.data
        code = p.get("code")
        if not code:
            return None
        images = p.get("images") or []
        product = ProductInfo(
            chain=self.chain,
            retailer_product_id=str(code),
            name=p.get("name") or "",
            display_name=p.get("name"),
            brand=None,  # Costco puts the brand inside the name
            size_text=None,
            url=BASE + p["url"] if p.get("url") else None,
            image_url=BASE + images[0]["url"] if images and images[0].get("url", "").startswith("/") else None,
            category_path=None,
        )
        hidden = p.get("hidePriceValue") or not p.get("price")
        price_c = None if hidden else to_cents((p.get("price") or {}).get("value"))
        base_c = to_cents((p.get("basePrice") or {}).get("value")) if not hidden else None
        coupon = p.get("couponDiscount") or {}
        discount = coupon.get("discountValue") or 0
        was_c = base_c if base_c and price_c and base_c > price_c else None
        is_special = bool(discount) or was_c is not None
        unit_type = p.get("unitType")
        ppu = (p.get("pricePerUnit") or {}).get("value")
        measure = UNIT_TYPES.get(unit_type or "", (unit_type, None))
        obs = Observation(
            store_ref=self.store_ref,
            price_basis="online_incl_delivery" if p.get("shippingIncluded") else "online",
            price_per="kg" if p.get("randomWeight") else "each",
            price_cents=price_c,
            was_cents=was_c,
            is_special=is_special,
            special_type="member_saving" if is_special else None,
            promo_text=f"Save {coupon['formattedDiscountValue']}" if discount and coupon.get("formattedDiscountValue") else None,
            unit_price=float(ppu) if ppu else None,
            unit_measure=measure[0] if ppu else None,
            unit_price_text=f"${float(ppu):.2f} per {measure[1]}" if ppu and measure[1] else None,
            valid_from=_z(coupon.get("discountStartDate")) if is_special else None,
            valid_to=_z(coupon.get("discountEndDate")) if is_special else None,
            valid_to_source="store" if is_special and coupon.get("discountEndDate") else None,
            in_stock=_stock(p.get("stock")),
        )
        raw_product = {k: v for k, v in p.items() if k not in PRICE_KEYS}
        raw_price = {k: p.get(k) for k in PRICE_KEYS if k in p}
        return NormalisedItem(product=product, gtins=[], observations=[obs],
                              raw_product=raw_product, raw_price=raw_price)


def _z(value: str | None) -> str | None:
    """'2026-10-25T12:59:59.999Z' -> '2026-10-25T12:59:59Z'."""
    return value[:19] + "Z" if value else None


def _stock(stock: dict[str, Any] | None) -> bool | None:
    status = (stock or {}).get("stockLevelStatus")
    if status in ("inStock", "lowStock"):
        return True
    if status == "outOfStock":
        return False
    return None
