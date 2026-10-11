"""One adapter per store."""

from __future__ import annotations

from importlib import import_module

_ADAPTERS = {
    "woolworths": ("woolworths", "WoolworthsCollector"),
    "coles": ("coles", "ColesCollector"),
    "aldi": ("aldi", "AldiCollector"),
    "costco": ("costco", "CostcoCollector"),
    "chemistwarehouse": ("chemistwarehouse", "ChemistWarehouseCollector"),
}


def get_collector_class(chain: str):
    if chain not in _ADAPTERS:
        raise KeyError(f"No online collector for '{chain}'")
    module, cls = _ADAPTERS[chain]
    return getattr(import_module(f"{__name__}.{module}"), cls)


def online_chains() -> list[str]:
    return list(_ADAPTERS)
