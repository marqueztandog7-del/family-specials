"""Chemist Warehouse: the Algolia search index its category pages use.

Approved 5 Oct 2026, limited to the categories in tracked_categories.yaml. Chemist
Warehouse shows "$X Off RRP" on nearly everything: that's everyday pricing, never a
special. The index's `in_catalogue` flag is NOT reliable (86% of items carry it, and
product pages show no catalogue badge), so the only specials recorded here are clearance
items. Real catalogue specials need the catalogue images (the "add flyer" path).
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from typing import Any
from urllib.parse import urlencode

from .. import config
from ..models import GtinIn, NormalisedItem, Observation, ProductInfo
from ..parsing import normalise_gtin
from .base import Collector, Coverage, RawItem

SITE = "https://www.chemistwarehouse.com.au"
# Supplier image URLs embed the barcode: richcontent.skulibrary.com/ABB/8427030007670/...
SKULIB_GTIN_RE = re.compile(r"skulibrary\.com/[A-Za-z0-9]+/(\d{8,14})/")
DROP = {"_highlightResult", "_snippetResult", "ranking", "searchableAttributes"}
PRICE_KEYS = {"prices", "pricesCustomFields", "calculatedPrice", "priceRangeFacetKeys", "isInStock"}


class ChemistWarehouseCollector(Collector):
    chain = "chemistwarehouse"
    specials_are_categories = True  # its specials run reads the tracked categories

    def _query(self, filters: str, page: int) -> dict[str, Any]:
        a = self.cfg["algolia"]
        key = config.secret(a["search_key_env"])  # Chemist Warehouse's public search key, kept out of the repo
        url = (f"https://{a['app_id']}-dsn.algolia.net/1/indexes/*/queries?"
               + urlencode({"x-algolia-api-key": key, "x-algolia-application-id": a["app_id"]}))
        params = urlencode({"filters": filters, "hitsPerPage": a.get("hits_per_page", 100), "page": page})
        body = {"requests": [{"indexName": a["index"], "params": params}]}
        resp = self.client.post(url, json=body, headers={"Origin": SITE, "Referer": SITE + "/"})
        return resp.json()["results"][0]

    def _read(self, category: dict[str, Any]) -> Iterator[RawItem]:
        name = category["category"]
        cov = Coverage("category", name, name)
        self.coverage.append(cov)
        filters = f'categoryKeys.en:"{name}"'
        page, total_pages = 0, 1
        while page < self.pages_to_read(total_pages):
            res = self._query(filters, page)
            total_pages = res.get("nbPages") or 1
            cov.items_total, cov.pages_total = res.get("nbHits"), total_pages
            for hit in res.get("hits") or []:
                cov.items_seen += 1
                yield RawItem(hit, {"category": name})
            page += 1
            cov.pages_read = page
        cov.complete = cov.pages_read >= cov.pages_total

    def fetch_specials(self) -> Iterator[RawItem]:
        for cat in config.tracked_categories(self.chain):
            yield from self._read(cat)

    def fetch_category(self, category: dict[str, Any]) -> Iterator[RawItem]:
        yield from self._read(category)

    def normalise(self, raw: RawItem) -> NormalisedItem | None:
        h = raw.data
        sku = h.get("sku")
        if not sku:
            return None
        attrs = h.get("attributes") or {}
        name = (h.get("name") or {}).get("en") or ""
        brand = ((attrs.get("cwr-brand") or {}).get("label") or {}).get("en")
        slug = (h.get("slug") or {}).get("en") or ""
        epid, _, rest = slug.partition("-")
        images = h.get("images") or []
        product = ProductInfo(
            chain=self.chain,
            retailer_product_id=str(sku),
            name=name,
            display_name=name,
            brand=brand,
            size_text=None,  # size is inside the name
            url=f"{SITE}/buy/{epid}/{rest}" if epid.isdigit() and rest else None,
            image_url=images[0] if images else None,
            category_path=raw.context.get("category"),
        )
        gtins = []
        supplier = ((attrs.get("cwr-supplier-content") or {}).get("en")) or ""
        for code in dict.fromkeys(SKULIB_GTIN_RE.findall(supplier)):
            if normalise_gtin(code):
                gtins.append(GtinIn(raw=code, source="supplier_content"))

        aud = (h.get("prices") or {}).get("AUD") or {}
        price_c = aud.get("min")
        if price_c is None or aud.get("max") != price_c:
            return None  # no single clear price
        rrp = (((h.get("pricesCustomFields") or {}).get("AUD") or {}).get("rrp") or {}).get("centAmount")
        flags = attrs.get("cwr-product-flags") or []
        clearance = "clearance" in flags
        obs = Observation(
            store_ref=self.store_ref,
            price_basis="online",
            price_cents=int(price_c),
            rrp_cents=int(rrp) if rrp and not attrs.get("cwr-hide-rrp") else None,
            is_special=clearance,
            special_type="clearance" if clearance else None,
            promo_text="Clearance" if clearance else None,
            in_stock=h.get("isInStock") if isinstance(h.get("isInStock"), bool) else None,
        )
        raw_product = {k: v for k, v in h.items() if k not in DROP and k not in PRICE_KEYS}
        raw_price = {k: h.get(k) for k in PRICE_KEYS if k in h} | {"flags": flags}
        return NormalisedItem(product=product, gtins=gtins, observations=[obs],
                              raw_product=raw_product, raw_price=raw_price)
