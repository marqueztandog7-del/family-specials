"""The normalised shape every collector produces, whatever the store."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ProductInfo(BaseModel):
    chain: str
    retailer_product_id: str
    name: str                      # raw name as the store writes it
    display_name: str | None = None
    brand: str | None = None
    size_text: str | None = None
    url: str | None = None
    image_url: str | None = None
    category_path: str | None = None


class GtinIn(BaseModel):
    raw: str
    source: str                    # listing | product_page | supplier_content | manual


class Observation(BaseModel):
    store_ref: str                 # the store the price applies to, as the store reported it
    price_basis: str               # in_store | online | online_incl_delivery
    price_per: str = "each"        # each | kg
    price_cents: int | None
    was_cents: int | None = None
    rrp_cents: int | None = None
    is_special: bool
    special_type: str | None = None
    promo_text: str | None = None
    multibuy_qty: int | None = None
    multibuy_cents: int | None = None
    member_only: bool = False
    member_price_cents: int | None = None
    unit_price: float | None = None
    unit_measure: str | None = None
    unit_price_text: str | None = None
    valid_from: str | None = None
    valid_to: str | None = None
    valid_to_source: str | None = None
    in_stock: bool | None = None


class NormalisedItem(BaseModel):
    """What `Collector.normalise(raw_item)` returns: the store's item as a Special/price record."""

    product: ProductInfo
    gtins: list[GtinIn] = Field(default_factory=list)
    observations: list[Observation]
    raw_product: dict[str, Any]    # descriptive raw fields (deduplicated snapshot)
    raw_price: dict[str, Any]      # raw price/promo fields (kept with each observation)
