"""Coles: the Next.js page data behind /on-special and the category pages.

Prices are pinned to our Click & Collect store with the fulfillmentStoreId cookie (set in runner.py).
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Iterator
from typing import Any

from ..http import NotFound
from ..models import NormalisedItem, Observation, ProductInfo
from ..parsing import parse_multibuy, parse_unit_price_text, to_cents
from ..timeutil import iso, weekly_cycle
from .base import CategoryInfo, Collector, Coverage, RawItem

BASE = "https://www.coles.com.au"
IMAGE_BASE = "https://cdn.productimages.coles.com.au/productimages"
NEXT_DATA_RE = re.compile(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)
PRICE_KEYS = {"pricing", "availability", "availabilityType", "availableQuantity", "adId", "adSource", "featured",
              "locations"}


class ColesCollector(Collector):
    chain = "coles"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._build_id: str | None = None
        self._first_page: dict[str, Any] | None = None

    # -- requests ---------------------------------------------------------

    def _html_page_props(self, path: str, page: int = 1) -> dict[str, Any]:
        params = {"page": page} if page > 1 else None
        html = self.client.get(BASE + path, params=params, expect="html", require="__NEXT_DATA__").text
        data = json.loads(NEXT_DATA_RE.search(html).group(1))
        self._build_id = data["buildId"]  # changes on every Coles deploy
        return data["props"]["pageProps"]

    def _load_on_special_page(self) -> None:
        if self._build_id is None:
            self._first_page = self._html_page_props("/on-special")

    def _data(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        self._load_on_special_page()
        url = f"{BASE}/_next/data/{self._build_id}/en/{path}.json"
        resp = self.client.get(url, params=params, headers={"x-nextjs-data": "1", "Accept": "application/json"})
        return resp.json()["pageProps"]

    def _read(self, scope_type: str, scope_ref: str, name: str, path: str, slug_params: list[str],
              context: dict[str, Any]) -> Iterator[RawItem]:
        cov = Coverage(scope_type, scope_ref, name)
        self.coverage.append(cov)
        page, total_pages = 1, 1
        seen: set[int] = set()
        while page <= self.pages_to_read(total_pages):
            if path == "on-special":
                # robots.txt's "Disallow: /*/*/*/on-special*" also covers the lighter
                # /_next/data/.../on-special.json route, so specials use the normal web pages.
                if page == 1 and self._first_page is not None:
                    props = self._first_page
                else:
                    props = self._html_page_props("/on-special", page)
                    if page == 1:
                        self._first_page = props
            else:
                params = [("slug", s) for s in slug_params] + ([("page", page)] if page > 1 else [])
                props = self._data(path, params)
            sr = props.get("searchResults") or {}
            if page == 1:
                cov.items_total = sr.get("noOfResults") or 0
                total_pages = max(1, math.ceil(cov.items_total / (sr.get("pageSize") or 48)))
                cov.pages_total = total_pages
            store_ref = props.get("initStoreId")
            for item in sr.get("results") or []:
                # Skip banner tiles. Sponsored tiles on the specials list are real specials, but in
                # category reads they can be injected from elsewhere, so skip them there.
                if item.get("_type") != "PRODUCT" or item.get("id") in seen:
                    continue
                if item.get("adId") and scope_type == "category":
                    continue
                seen.add(item["id"])
                cov.items_seen += 1
                yield RawItem(item, {**context, "store_ref": store_ref})
            cov.pages_read = page
            page += 1
        cov.complete = cov.pages_read >= (cov.pages_total or 0)

    # -- interface --------------------------------------------------------

    def fetch_specials(self) -> Iterator[RawItem]:
        # Only the top-level /on-special list: robots.txt disallows category-level specials pages.
        yield from self._read("specials_group", "on-special", "On special", "on-special", [], {})

    def fetch_category(self, category: dict[str, Any]) -> Iterator[RawItem]:
        slugs = category["slug"].strip("/").split("/")
        yield from self._read("category", category["slug"], category.get("name", ""),
                              "browse/" + "/".join(slugs), slugs, {})

    def discover_categories(self) -> list[CategoryInfo]:
        """Top-level categories come from the specials page; their subcategories need one
        request per top-level category (about 20 requests)."""
        self._load_on_special_page()
        tops = (self._first_page.get("searchResults") or {}).get("catalogGroupView") or []
        out: list[CategoryInfo] = []
        for top in tops:
            out.append(CategoryInfo(top["seoToken"], top["name"], top["name"], f"/browse/{top['seoToken']}"))
            try:
                props = self._data(f"browse/{top['seoToken']}", {"slug": top["seoToken"]})
            except NotFound:
                continue  # some specials groupings (e.g. "Deliver More Range") aren't browse categories
            for sub in (props.get("searchResults") or {}).get("catalogGroupView") or []:
                self._add_tree(out, sub, [top["name"]], [top["seoToken"]])
        return out

    def _add_tree(self, out: list[CategoryInfo], node: dict[str, Any], names: list[str], slugs: list[str]) -> None:
        names, slugs = names + [node["name"]], slugs + [node["seoToken"]]
        slug = "/".join(slugs)
        out.append(CategoryInfo(slug, node["name"], " > ".join(names), f"/browse/{slug}", node.get("productCount")))
        for child in node.get("catalogGroupView") or []:
            self._add_tree(out, child, names, slugs)

    # -- normalise --------------------------------------------------------

    def normalise(self, raw: RawItem) -> NormalisedItem | None:
        p = raw.data
        pricing = p.get("pricing")
        if not pricing:
            return None  # listed without a price (e.g. unavailable at this store)
        brand, name, size = p.get("brand") or "", p.get("name") or "", p.get("size") or ""
        heir = p.get("merchandiseHeir") or {}
        images = p.get("imageUris") or []
        product = ProductInfo(
            chain=self.chain,
            retailer_product_id=str(p["id"]),
            name=name,
            display_name=" ".join(x for x in (brand, name, size) if x),
            brand=brand or None,
            size_text=size or None,
            url=f"{BASE}/product/{_slug(brand, name, size)}-{p['id']}",
            image_url=IMAGE_BASE + images[0]["uri"] if images else None,
            category_path=" > ".join(x for x in (heir.get("tradeProfitCentre"), heir.get("categoryGroup"),
                                                 heir.get("category"), heir.get("subCategory")) if x) or None,
        )

        now_c = to_cents(pricing.get("now"))
        was_c = to_cents(pricing.get("was")) or None
        if was_c is not None and now_c is not None and was_c <= now_c:
            was_c = None
        offer = pricing.get("offerDescription")
        multibuy = parse_multibuy(offer)
        promo_type = pricing.get("promotionType")
        is_special = promo_type == "SPECIAL" or was_c is not None or multibuy is not None
        unit = pricing.get("unit") or {}
        parsed_unit = parse_unit_price_text(pricing.get("comparable"))
        valid_from = valid_to = valid_src = None
        if is_special:
            start, end = weekly_cycle(2)  # Coles specials run Wednesday to Tuesday
            valid_from, valid_to, valid_src = iso(start), iso(end), "weekly_cycle_assumed"
        special_type = None
        if is_special:
            special_type = ("multibuy" if multibuy else
                            "half_price" if was_c and now_c and abs(now_c * 2 - was_c) <= 2 else
                            (pricing.get("specialType") or "special").lower())
        obs = Observation(
            store_ref=str(raw.context.get("store_ref") or self.store_ref),
            price_basis="online",
            price_per="kg" if unit.get("isWeighted") and str(unit.get("ofMeasureUnits", "")).lower() == "kg" else "each",
            price_cents=now_c,
            was_cents=was_c,
            is_special=is_special,
            special_type=special_type,
            promo_text=(offer or pricing.get("saveStatement") or pricing.get("priceDescription")) if is_special else None,
            multibuy_qty=multibuy[0] if multibuy else None,
            multibuy_cents=multibuy[1] if multibuy else None,
            unit_price=parsed_unit[0] if parsed_unit else unit.get("price"),
            unit_measure=parsed_unit[1] if parsed_unit else None,
            unit_price_text=pricing.get("comparable") or None,
            valid_from=valid_from, valid_to=valid_to, valid_to_source=valid_src,
            in_stock=p.get("availability") if isinstance(p.get("availability"), bool) else None,
        )
        raw_product = {k: v for k, v in p.items() if k not in PRICE_KEYS}
        raw_price = {k: p.get(k) for k in PRICE_KEYS if k in p}
        return NormalisedItem(product=product, gtins=[], observations=[obs],
                              raw_product=raw_product, raw_price=raw_price)


def _slug(*parts: str) -> str:
    """Coles product URLs keep apostrophes: "smith's-crinkle-cut-chips-...-380g"."""
    text = " ".join(p for p in parts if p).lower()
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9']+", "-", text)).strip("-")
