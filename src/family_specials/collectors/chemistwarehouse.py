"""Chemist Warehouse: the Algolia search index its category pages use.

Approved 5 Oct 2026 for our categories, and 19 Oct 2026 for the full range once a week (marketplace sellers left
out). Chemist Warehouse shows "$X Off RRP" on nearly everything: that's everyday pricing, never a special. The
index's `in_catalogue` flag is NOT reliable (86% of items carry it, and product pages show no catalogue badge), so
the only specials recorded from product data are clearance items. Catalogue specials are read from the printed
catalogue's page images (catalogue_cw.py).
"""

from __future__ import annotations

import json
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
NOT_MARKETPLACE = 'NOT categoryKeys.en:"All Marketplace Lines"'   # third-party sellers, not Chemist Warehouse stock
# Price bands (cents) for reading the full range: the search only returns 1,000 products per query, so the range is
# read band by band, and a band with more than that is split in two.
MAX_SPLIT = 12          # at most this many categories when splitting one crowded price
PRICE_BANDS = [0, 500, 800, 1000, 1200, 1500, 1800, 2000, 2500, 3000, 3500, 4000, 5000, 6000, 7500, 10000, 15000,
               20000, 10**9]
PRICE_KEYS = {"prices", "pricesCustomFields", "calculatedPrice", "priceRangeFacetKeys", "isInStock"}


class ChemistWarehouseCollector(Collector):
    chain = "chemistwarehouse"
    specials_are_categories = True  # a category read records its clearance specials
    has_specials_read = False       # its specials (clearance) come from the weekly full-range read

    def _query(self, filters: str, page: int, hits_per_page: int | None = None,
               facets: list[str] | None = None) -> dict[str, Any]:
        a = self.cfg["algolia"]
        key = config.secret(a["search_key_env"])  # Chemist Warehouse's public search key, kept out of the repo
        url = (f"https://{a['app_id']}-dsn.algolia.net/1/indexes/*/queries?"
               + urlencode({"x-algolia-api-key": key, "x-algolia-application-id": a["app_id"]}))
        q = {"filters": filters, "hitsPerPage": hits_per_page if hits_per_page is not None else a.get("hits_per_page", 100),
             "page": page}
        if facets:
            q |= {"facets": json.dumps(facets), "maxValuesPerFacet": 100}
        params = urlencode(q)
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
                yield RawItem(hit, {"category": name, "category_ref": name})
            page += 1
            cov.pages_read = page
        cov.complete = cov.pages_read >= cov.pages_total

    def fetch_specials(self) -> Iterator[RawItem]:
        return iter(())   # see fetch_range

    def fetch_range(self) -> Iterator[RawItem]:
        """Chemist Warehouse's own range (not marketplace sellers), price band by price band."""
        hpp = int(self.cfg.get("range", {}).get("hits_per_page", 1000))
        cov = Coverage("range", "all", "Full range (Chemist Warehouse's own products)")
        self.coverage.append(cov)
        cov.items_total = self._query(NOT_MARKETPLACE, 0, 1).get("nbHits")
        bands = list(zip(PRICE_BANDS, PRICE_BANDS[1:]))[::-1]
        seen: set[str] = set()
        complete = True
        crowded: list[int] = []
        cov.pages_total = 0
        while bands:
            lo, hi = bands.pop()
            res = self._query(f"calculatedPrice >= {lo} AND calculatedPrice < {hi} AND {NOT_MARKETPLACE}", 0, hpp)
            cov.pages_total += 1
            cov.pages_read += 1
            hits = res.get("hits") or []
            if (res.get("nbHits") or 0) > hpp:
                if hi - lo > 1:
                    mid = (lo + hi) // 2
                    bands += [(mid, hi), (lo, mid)]
                    continue
                # More than a page of products at one exact price (e.g. $25.00): split it by category, at the end.
                crowded.append(lo)
                continue
            for hit in hits:
                if hit.get("sku") in seen:
                    continue
                seen.add(hit.get("sku"))
                cov.items_seen += 1
                yield RawItem(hit, {})
        for lo in crowded:
            hits, ok, used = self._by_category(
                f"calculatedPrice >= {lo} AND calculatedPrice < {lo + 1} AND {NOT_MARKETPLACE}", hpp)
            cov.pages_total += used
            cov.pages_read += used
            complete &= ok
            for hit in hits:
                if hit.get("sku") not in seen:
                    seen.add(hit.get("sku"))
                    cov.items_seen += 1
                    yield RawItem(hit, {})
        # Products with no price aren't in any band; they'd be skipped anyway (no single clear price).
        cov.complete = complete

    def _by_category(self, base: str, hpp: int) -> tuple[list[dict], bool, int]:
        """Every product matching `base` when there's more than a page of them (one exact price, e.g. $25.00): one
        look at how they spread over categories, then the biggest categories that fit on a page, one by one (each
        leaving those already read out), until what's left fits on a page too. Returns (hits, whether everything was
        read, requests used). On 21 Oct an earlier version asked twice per category and used up the read's requests."""
        res = self._query(base, 0, 0, facets=["categoryKeys.en"])
        total = res.get("nbHits") or 0
        counts = (res.get("facets") or {}).get("categoryKeys.en") or {}
        cats = [(c, n) for c, n in sorted(counts.items(), key=lambda kv: -kv[1]) if n <= hpp and '"' not in c]
        hits: list[dict] = []
        rest, used, taken = base, 1, 0
        for cat, n in cats[:MAX_SPLIT]:
            if total - taken <= hpp:
                break            # what's left should fit on a page now
            part = self._query(f'{rest} AND categoryKeys.en:"{cat}"', 0, hpp)
            used += 1
            got = part.get("nbHits") or 0
            if 0 < got <= hpp:
                hits += part.get("hits") or []
                rest = f'{rest} AND NOT categoryKeys.en:"{cat}"'
                taken += got
        left = self._query(rest, 0, hpp)
        return hits + (left.get("hits") or []), (left.get("nbHits") or 0) <= hpp, used + 1

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
        if not price_c or aud.get("max") != price_c:
            return None  # no single clear price ($0 = prescription-only items and samples: no shelf price)
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
