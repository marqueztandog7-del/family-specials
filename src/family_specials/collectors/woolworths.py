"""Woolworths: the JSON API the website itself calls (browse/category)."""

from __future__ import annotations

import json
import math
import re
from collections.abc import Iterator
from typing import Any

from ..models import GtinIn, NormalisedItem, Observation, ProductInfo
from ..parsing import parse_multibuy, to_cents
from ..timeutil import iso, weekly_cycle
from .base import CategoryInfo, Collector, Coverage, RawItem

BASE = "https://www.woolworths.com.au"
PAGE_SIZE = 36  # largest page the API accepts
SKIP_TREE_ROOTS = {"specialsgroup", "1_A363395", "1_F89E4BB"}  # specials, Everyday Market, Healthylife

# Fields that change on every request (ads, trolley state) or are prices: kept out of the
# descriptive snapshot so it only changes when the product itself changes.
VOLATILE = {
    "AdID", "AdIndex", "AdStatus", "IsSponsoredAd", "Diagnostics", "QuantityInTrolley", "IsInTrolley",
    "HasBeenBoughtBefore", "NextAvailabilityDate", "TileID", "Source", "DisplayQuantity",
    "IsPersonalisedByPurchaseHistory", "IsFromFacetedSearch", "SupplyLimitMessage",
    # Promotion and stock-limit flags that change week to week without the product changing.
    "OfferId", "MaxSupplyLimitMessage", "SupplyLimit", "ProductLimit", "SupplyLimitSource", "HasHeaderTag",
    "IsCentreTag", "IsFooterEnabled", "HasProductSubs", "NumberOfSubstitutes",
}
# Website navigation (which seasonal menus a product appears in) changes weekly; not product data.
VOLATILE_ATTRIBUTES = {"piesdepartmentnamesjson", "PiesProductDepartmentsjson", "piescategorynamesjson",
                       "piessubcategorynamesjson", "PiesProductDepartmentNodeId", "specialsgroupid"}
PRICE_KEYS = {
    "Price", "WasPrice", "InstorePrice", "InstoreWasPrice", "SavingsAmount", "InstoreSavingsAmount",
    "CupPrice", "InstoreCupPrice", "CupMeasure", "CupString", "InstoreCupString", "HasCupPrice",
    "InstoreHasCupPrice", "IsOnSpecial", "InstoreIsOnSpecial", "IsHalfPrice", "IsEdrSpecial", "IsOnlineOnly",
    "CentreTag", "ImageTag", "HeaderTag", "FooterTag", "Tags", "IsInStock", "IsAvailable", "InstoreIsAvailable",
    "IsPurchasable", "InstoreIsPurchasable", "FulfilmentStoreId", "IncrementalPrice", "IncrementalWasPrice",
    "MinWeightPrice", "MaxWeightPrice", "Unit", "PricePerKGLabel", "HideWasSavedPrice",
}


class WoolworthsCollector(Collector):
    chain = "woolworths"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._warmed = False
        self._tree: list[dict[str, Any]] | None = None

    # -- requests ---------------------------------------------------------

    def _warm_up(self) -> None:
        """One homepage visit to get the session cookies the API expects."""
        if not self._warmed:
            self.client.get(BASE + "/", expect="html", require="woolworths")
            self._warmed = True

    def _category_tree(self) -> list[dict[str, Any]]:
        if self._tree is None:
            self._warm_up()
            self._tree = self.client.get(BASE + "/apis/ui/PiesCategoriesWithSpecials").json()["Categories"]
        return self._tree

    def _browse(self, category_id: str, url_path: str, name: str, page: int) -> dict[str, Any]:
        location = url_path + (f"?pageNumber={page}" if page > 1 else "")
        body = {
            "categoryId": category_id, "pageNumber": page, "pageSize": PAGE_SIZE, "sortType": "TraderRelevance",
            "url": location, "location": location, "formatObject": json.dumps({"name": name}),
            "isSpecial": False, "isHideUnavailableProducts": False, "isBundle": False, "isMobile": False,
            "isRegisteredRewardCardPromotion": False, "isHideEverydayMarketProducts": False,
            "filters": [], "categoryVersion": "v2",
        }
        return self.client.post(
            BASE + "/apis/ui/browse/category", json=body,
            headers={"Origin": BASE, "Referer": BASE + location, "Accept": "application/json"},
        ).json()

    def _read_listing(self, scope_type: str, category_id: str, url_path: str, name: str,
                      context: dict[str, Any]) -> Iterator[RawItem]:
        cov = Coverage(scope_type, category_id, name)
        self.coverage.append(cov)
        page, total_pages = 1, 1
        seen: set[int] = set()
        while page <= self.pages_to_read(total_pages):
            data = self._browse(category_id, url_path, name, page)
            if page == 1:
                cov.items_total = data.get("TotalRecordCount") or 0
                total_pages = max(1, math.ceil(cov.items_total / PAGE_SIZE))
                cov.pages_total = total_pages
            for bundle in data.get("Bundles") or []:
                for prod in bundle.get("Products") or []:
                    code = prod.get("Stockcode")
                    # Sponsored ads are injected into pages; marketplace sellers aren't Woolworths stock.
                    if prod.get("IsSponsoredAd") or prod.get("IsMarketProduct") or code in seen:
                        continue
                    seen.add(code)
                    cov.items_seen += 1
                    yield RawItem(prod, context)
            cov.pages_read = page
            page += 1
        cov.complete = cov.pages_read >= (cov.pages_total or 0)

    # -- interface --------------------------------------------------------

    def fetch_specials(self) -> Iterator[RawItem]:
        slugs = {n["NodeId"]: n["UrlFriendlyName"] for n in self._specials_nodes()}
        for group in self.cfg["specials_groups"]:
            slug = slugs.get(group["id"])
            if not slug:
                # Group no longer exists on the site: record that it wasn't covered.
                self.coverage.append(Coverage("specials_group", group["id"], group["name"] + " (not on site)"))
                continue
            ctx = {"group": group["id"], "special_type": group["special_type"], "weekly": group.get("weekly")}
            yield from self._read_listing("specials_group", group["id"], f"/shop/browse/specials/{slug}",
                                          group["name"], ctx)

    def fetch_category(self, category: dict[str, Any]) -> Iterator[RawItem]:
        self._warm_up()
        yield from self._read_listing("category", category["id"], category["url"], category.get("name", ""), {})

    def fetch_range(self) -> Iterator[RawItem]:
        """Every aisle (the second level of the category tree) of every real department. Department pages
        themselves aren't read (a department-level read was refused on 19 Oct 2026, while aisles have always
        worked), and themed collections that only repeat other departments' products are skipped."""
        skip = set(self.cfg.get("range", {}).get("skip_departments") or [])
        seen: set[Any] = set()
        for top in self._category_tree():
            if top["NodeId"] in SKIP_TREE_ROOTS or top["Description"] in skip:
                continue
            for aisle in top.get("Children") or []:
                if aisle["NodeId"].endswith("_SPECIALS"):
                    continue
                url = f"/shop/browse/{top['UrlFriendlyName']}/{aisle['UrlFriendlyName']}"
                ctx = {"range_path": f"{top['Description']} > {aisle['Description']}"}
                for raw in self._read_listing("range", aisle["NodeId"], url, aisle["Description"], ctx):
                    code = raw.data.get("Stockcode")
                    if code not in seen:          # the same product can sit in two aisles
                        seen.add(code)
                        yield raw

    def discover_categories(self) -> list[CategoryInfo]:
        out: list[CategoryInfo] = []

        def walk(node: dict[str, Any], names: list[str], slugs: list[str]) -> None:
            names, slugs = names + [node["Description"]], slugs + [node["UrlFriendlyName"]]
            if not node["NodeId"].endswith("_SPECIALS"):
                out.append(CategoryInfo(node["NodeId"], node["Description"], " > ".join(names),
                                        "/shop/browse/" + "/".join(slugs), node.get("ProductCount") or None))
            for child in node.get("Children") or []:
                walk(child, names, slugs)

        for top in self._category_tree():
            if top["NodeId"] not in SKIP_TREE_ROOTS:
                walk(top, [], [])
        return out

    def _specials_nodes(self) -> list[dict[str, Any]]:
        for top in self._category_tree():
            if top["NodeId"] == "specialsgroup":
                return top.get("Children") or []
        return []

    # -- normalise --------------------------------------------------------

    def normalise(self, raw: RawItem) -> NormalisedItem | None:
        p, ctx = raw.data, raw.context
        code = p.get("Stockcode")
        if not code:
            return None
        attrs = p.get("AdditionalAttributes") or {}
        category = " > ".join(
            x for x in (attrs.get("sapdepartmentname"), attrs.get("sapcategoryname"), attrs.get("sapsubcategoryname")) if x
        ) or None
        product = ProductInfo(
            chain=self.chain,
            retailer_product_id=str(code),
            name=p.get("Name") or p.get("DisplayName") or "",
            display_name=p.get("DisplayName"),
            brand=p.get("Brand") or None,
            size_text=p.get("PackageSize") or None,
            url=f"{BASE}/shop/productdetails/{code}/{p.get('UrlFriendlyName') or ''}".rstrip("/"),
            image_url=p.get("MediumImageFile") or p.get("SmallImageFile"),
            category_path=category,
        )
        gtins = [GtinIn(raw=str(p["Barcode"]), source="listing")] if p.get("Barcode") else []

        store_ref = str(p.get("FulfilmentStoreId") or self.store_ref)
        price_per = "kg" if str(p.get("Unit") or "").strip().lower() in ("kg", "per kg") else "each"
        multibuy = _multibuy(p)
        member_only, member_price = _member_price(p)
        promo_label = _strip_html((p.get("ImageTag") or {}).get("FallbackText")
                                  or (p.get("HeaderTag") or {}).get("Content"))

        weekly = bool(ctx.get("weekly")) or bool(p.get("IsHalfPrice"))
        valid_from = valid_to = valid_src = None

        def make(basis: str, price, was, on_special, cup_price, cup_string, in_stock) -> Observation:
            nonlocal valid_from, valid_to, valid_src
            price_c, was_c = to_cents(price), to_cents(was)
            if was_c is not None and (price_c is None or was_c <= price_c):
                was_c = None  # Buy More Save More etc. report was == price; the deal is the multibuy
            # Pricing rules: member prices (Everyday Rewards / Extra) are recorded but never make a special.
            is_special = bool(on_special) or multibuy is not None
            special_type = None
            if is_special:
                special_type = ("half_price" if p.get("IsHalfPrice") else
                                "multibuy" if multibuy and not on_special else
                                ctx.get("special_type") or "special")
                if weekly and valid_to is None:
                    start, end = weekly_cycle(2)
                    valid_from, valid_to, valid_src = iso(start), iso(end), "weekly_cycle_assumed"
            elif ctx.get("special_type") in LABEL_ONLY_GROUPS:
                # e.g. "Lower shelf price": Woolworths doesn't call these specials and shows no was
                # price, so they're recorded as regular prices with the store's label.
                special_type = ctx["special_type"]
            return Observation(
                store_ref=store_ref, price_basis=basis, price_per=price_per,
                price_cents=price_c, was_cents=was_c, is_special=is_special, special_type=special_type,
                promo_text=(multibuy[2] if multibuy else promo_label) if special_type else None,
                multibuy_qty=multibuy[0] if multibuy else None, multibuy_cents=multibuy[1] if multibuy else None,
                member_only=member_only, member_price_cents=member_price,
                unit_price=float(cup_price) if cup_price else None,
                unit_measure=p.get("CupMeasure"), unit_price_text=cup_string or None,
                valid_from=valid_from if is_special else None, valid_to=valid_to if is_special else None,
                valid_to_source=valid_src if is_special else None, in_stock=in_stock,
            )

        observations = [
            make("in_store", p.get("InstorePrice"), p.get("InstoreWasPrice"), p.get("InstoreIsOnSpecial"),
                 p.get("InstoreCupPrice"), p.get("InstoreCupString"), None),
            make("online", p.get("Price"), p.get("WasPrice"), p.get("IsOnSpecial"),
                 p.get("CupPrice"), p.get("CupString"), p.get("IsInStock")),
        ]
        observations = [o for o in observations if o.price_cents is not None]
        if not observations:
            return None
        raw_product = {k: v for k, v in p.items() if k not in VOLATILE and k not in PRICE_KEYS}
        if isinstance(raw_product.get("AdditionalAttributes"), dict):
            raw_product["AdditionalAttributes"] = {k: v for k, v in raw_product["AdditionalAttributes"].items()
                                                   if k not in VOLATILE_ATTRIBUTES}
        raw_price = {k: p.get(k) for k in PRICE_KEYS if k in p}
        return NormalisedItem(product=product, gtins=gtins, observations=observations,
                              raw_product=raw_product, raw_price=raw_price)


LABEL_ONLY_GROUPS = {"lower_shelf_price", "seasonal_price"}


def _strip_html(text: str | None) -> str | None:
    if not text:
        return None
    return re.sub(r"<[^>]+>", "", text).strip() or None


def _multibuy(p: dict[str, Any]) -> tuple[int, int, str] | None:
    """Buy More Save More: the deal is only in CentreTag.MultibuyData (e.g. 2 for $8)."""
    tag = p.get("CentreTag") or {}
    data = tag.get("MultibuyData") or {}
    qty, price = data.get("Quantity"), data.get("Price")
    if qty and price and int(qty) >= 2:
        text = f"{int(qty)} for ${float(price):.2f}"
        return int(qty), to_cents(price), text
    parsed = parse_multibuy(tag.get("TagContentText") or (p.get("HeaderTag") or {}).get("Content"))
    if parsed:
        return parsed[0], parsed[1], f"{parsed[0]} for ${parsed[1] / 100:.2f}"
    return None


def _member_price(p: dict[str, Any]) -> tuple[bool, int | None]:
    """Everyday Rewards member prices (only shown to members)."""
    for tag in (p.get("CentreTag") or {}, p.get("FooterTag") or {}):
        data = tag.get("MemberPriceData") or {}
        price = data.get("Price") or data.get("MemberPrice")
        if price:
            return True, to_cents(price)
    return bool(p.get("IsEdrSpecial")), None
