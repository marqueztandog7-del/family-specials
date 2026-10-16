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


def set_env(name: str, value: str, path: Path | None = None) -> None:
    """Set KEY=value in .env (replacing any old value), readable only by you. Never printed."""
    path = path or PROJECT_ROOT / ".env"
    lines = [ln for ln in (path.read_text(encoding="utf-8").splitlines() if path.exists() else [])
             if not ln.startswith(f"{name}=")]
    path.write_text("\n".join(lines + [f"{name}={value}"]) + "\n", encoding="utf-8")
    path.chmod(0o600)
    os.environ[name] = value


def set_github_secret(name: str, value: str) -> None:
    """Set a GitHub Actions secret for this repo. The value goes in on stdin, so it's never shown or logged."""
    import shutil
    import subprocess

    gh = shutil.which("gh") or str(Path.home() / ".local" / "bin" / "gh")
    subprocess.run([gh, "secret", "set", name], input=value, text=True, check=True, cwd=PROJECT_ROOT,
                   capture_output=True)


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
    """Categories whose regular prices we read each cycle: those of the watch items in
    config/watchlist.yaml, plus any extras in tracked_categories.yaml. Each is read once even
    if several watch items share it."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(entry: dict[str, Any]) -> None:
        ref = str(entry.get("id") or entry.get("key") or entry.get("slug") or entry.get("query")
                  or entry.get("code") or entry.get("category"))
        if ref not in seen:
            seen.add(ref)
            out.append(entry)

    for entry in load_yaml("tracked_categories.yaml").get("items") or []:
        ref = (entry.get("stores") or {}).get(chain)
        for cat in ref if isinstance(ref, list) else ([ref] if ref else []):
            add({"item": entry["item"], **cat})
    field = {"woolworths": "id", "aldi": "key", "coles": "slug", "costco": "query",
             "chemistwarehouse": "category"}.get(chain)
    for item in load_yaml("watchlist.yaml").get("items") or []:
        for value in (item.get("categories") or {}).get(chain) or []:
            add({"item": item["key"], field: str(value), "name": item["name"]})
    return out


def own_brands() -> dict[str, list[str]]:
    return load_yaml("own_brands.yaml").get("own_brands", {})
