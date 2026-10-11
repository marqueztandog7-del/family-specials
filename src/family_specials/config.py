"""Paths and editable YAML config."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = PROJECT_ROOT / "config"
DATA_DIR = Path(os.environ.get("SPECIALS_DATA_DIR", PROJECT_ROOT / "data"))
DB_PATH = Path(os.environ.get("SPECIALS_DB", DATA_DIR / "specials.db"))


def load_dotenv(path: Path | None = None) -> None:
    """Read KEY=value lines from .env (not committed) into the environment, without overriding."""
    path = path or PROJECT_ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def secret(name: str) -> str:
    load_dotenv()
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} isn't set. Add it to .env (see .env.example) or the GitHub Actions secrets.")
    return value


@lru_cache
def load_yaml(name: str) -> dict[str, Any]:
    path = CONFIG_DIR / name
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def settings() -> dict[str, Any]:
    return load_yaml("stores.yaml")


def chain_config(chain: str) -> dict[str, Any]:
    chains = settings()["chains"]
    if chain not in chains:
        raise KeyError(f"Unknown chain '{chain}'. Known: {', '.join(chains)}")
    return chains[chain]


def enabled_chains() -> list[str]:
    return [c for c, cfg in settings()["chains"].items() if cfg.get("enabled", True)]


def tracked_categories(chain: str) -> list[dict[str, Any]]:
    """Categories whose regular prices we read each cycle (not just specials)."""
    out = []
    for entry in load_yaml("tracked_categories.yaml").get("items", []):
        ref = (entry.get("stores") or {}).get(chain)
        if not ref:
            continue
        for cat in ref if isinstance(ref, list) else [ref]:
            out.append({"item": entry["item"], **cat})
    return out


def own_brands() -> dict[str, list[str]]:
    return load_yaml("own_brands.yaml").get("own_brands", {})
