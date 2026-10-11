"""The shared collector interface. One adapter per store; each is independent."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

from ..http import PoliteClient
from ..models import NormalisedItem


@dataclass
class Coverage:
    """What one specials group / category / promotion date actually covered in a run."""

    scope_type: str            # specials_group | category | promotion_date | manual_import
    scope_ref: str
    scope_name: str | None = None
    pages_read: int = 0
    pages_total: int | None = None
    items_seen: int = 0
    items_total: int | None = None
    complete: bool = False


@dataclass
class RawItem:
    """One item exactly as the store returned it, plus where we found it."""

    data: dict[str, Any]
    context: dict[str, Any] = field(default_factory=dict)  # group, special_type hint, dates...


@dataclass
class CategoryInfo:
    category_ref: str
    name: str
    path: str | None = None
    url_path: str | None = None
    product_count: int | None = None


class Collector(ABC):
    """fetch_specials() yields raw items; normalise(raw_item) turns one into a NormalisedItem."""

    chain: str

    def __init__(self, store_config: dict[str, Any], client: PoliteClient, max_pages: int | None = None):
        self.cfg = store_config
        self.client = client
        self.max_pages = max_pages          # for testing: cap pages per group/category
        self.coverage: list[Coverage] = []

    # Each run fetches either specials or tracked categories.
    @abstractmethod
    def fetch_specials(self) -> Iterator[RawItem]:
        ...

    def fetch_category(self, category: dict[str, Any]) -> Iterator[RawItem]:
        raise NotImplementedError(f"{self.chain} has no category reads yet")

    def discover_categories(self) -> list[CategoryInfo]:
        raise NotImplementedError(f"{self.chain} has no category discovery yet")

    @abstractmethod
    def normalise(self, raw: RawItem) -> NormalisedItem | None:
        """Return None for items that aren't real products we should record (ads, banners)."""

    # -- helpers ----------------------------------------------------------

    def pages_to_read(self, total_pages: int) -> int:
        return min(total_pages, self.max_pages) if self.max_pages else total_pages

    @property
    def store_ref(self) -> str:
        return str(self.cfg["store"]["ref"])
