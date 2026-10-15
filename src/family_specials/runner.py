"""Runs collectors. Each chain runs independently: one store breaking never stops the others."""

from __future__ import annotations

import logging
import sqlite3
import traceback
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from . import config, db
from .collectors import get_collector_class
from .http import Blocked, BudgetExceeded, NotFound, PoliteClient, RobotsDisallowed
from .timeutil import iso, most_recent_weekday, now_utc, parse_iso, sydney_midnight, weekly_cycle

log = logging.getLogger(__name__)

WEEKDAYS = {"monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3, "friday": 4, "saturday": 5, "sunday": 6}


@dataclass
class RunResult:
    chain: str
    kind: str
    run_id: int
    status: str
    requests: int
    items: int
    observations: int
    error: str | None = None


def make_client(chain: str) -> PoliteClient:
    cfg = config.chain_config(chain)
    if cfg.get("paused_for_good"):
        # The one place every web request starts from: a store paused for good is never contacted.
        raise PausedForGood(f"{chain} is paused for good ({cfg['paused_for_good']}); nothing will contact it")
    pol = cfg.get("politeness", {})
    cookies = None
    if chain == "coles":
        # Pins prices to our Click & Collect store (no login needed).
        cookies = {"fulfillmentStoreId": str(cfg["store"]["ref"]), "shopping-method": "clickAndCollect"}
    return PoliteClient(
        chain,
        delay_seconds=tuple(pol.get("delay_seconds", (3, 6))),
        max_requests=pol.get("max_requests_per_run", 100),
        cookies=cookies,
    )


def run_chain(conn: sqlite3.Connection, chain: str, kind: str, max_pages: int | None = None) -> RunResult:
    """kind: 'specials' or 'category' (the tracked categories in tracked_categories.yaml)."""
    cfg = config.chain_config(chain)
    if is_paused_for_good(conn, chain):
        raise PausedForGood(f"{chain} is paused for good; not collecting")
    run_id = db.start_run(conn, chain, kind)
    items = observations = 0
    status, error = "ok", None
    client = make_client(chain)
    collector = get_collector_class(chain)(cfg, client, max_pages=max_pages)
    # Chemist Warehouse's specials run reads our tracked categories, so its prices are category prices.
    source = "category" if kind == "category" or getattr(collector, "specials_are_categories", False) else "specials"
    try:
        if kind == "specials":
            raw_items = collector.fetch_specials()
        else:
            raw_items = _category_items(collector, _with_category_details(conn, chain, config.tracked_categories(chain)))
        for raw in raw_items:
            item = collector.normalise(raw)
            if item is None:
                continue
            observations += db.save_item(conn, run_id, item, source)
            items += 1
            if items % 200 == 0:
                conn.commit()
    except (Blocked, RobotsDisallowed) as e:
        status, error = "blocked", str(e)
        log.warning("%s %s stopped: %s", chain, kind, e)
    except BudgetExceeded as e:
        status, error = "partial", str(e)
        log.warning("%s %s: %s", chain, kind, e)
    except Exception as e:  # noqa: BLE001 - one store's bug must not stop the others
        status, error = "error", f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=5)}"
        log.exception("%s %s failed", chain, kind)
    finally:
        client.close()
    for cov in collector.coverage:
        db.add_coverage(conn, run_id, cov)
    if status == "ok" and any(not c.complete for c in collector.coverage):
        status = "partial"
        error = error or "Some pages weren't read (see run_coverage)"
    db.finish_run(conn, run_id, status, client.requests_made, items, observations, error)
    return RunResult(chain, kind, run_id, status, client.requests_made, items, observations, error)


def _with_category_details(conn: sqlite3.Connection, chain: str, categories: list[dict]) -> list[dict]:
    """Woolworths needs each category's web path as well as its id: take it from the discovered tree."""
    if chain != "woolworths":
        return categories
    out = []
    for c in categories:
        if not c.get("url"):
            row = conn.execute("SELECT name, url_path FROM store_categories WHERE chain = ? AND category_ref = ?",
                               (chain, c["id"])).fetchone()
            if row is None:
                log.warning("woolworths category %s isn't in the discovered tree; skipped "
                            "(run: specials categories --chain woolworths --refresh)", c["id"])
                continue
            c = {**c, "url": row["url_path"], "name": row["name"]}
        out.append(c)
    return out


def _category_items(collector, categories):
    for cat in categories:
        try:
            yield from collector.fetch_category(cat)
        except NotFound as e:
            # A tracked category was renamed or removed: note it, carry on with the rest.
            log.warning("%s: tracked category not found (%s); update tracked_categories.yaml", collector.chain, e)
            if collector.coverage:
                collector.coverage[-1].scope_name = f"{collector.coverage[-1].scope_name} (not found)"


# --------------------------------------------------------------------------- scheduling


def cycle_start(chain: str, at: datetime | None = None) -> datetime | None:
    """When the chain's current specials cycle started (Sydney time). None for manual chains."""
    cyc = config.chain_config(chain).get("cycle", {})
    kind = cyc.get("type")
    if kind == "weekly":
        return weekly_cycle(WEEKDAYS[cyc["starts"]], at)[0]
    if kind == "twice_weekly":
        return most_recent_weekday([WEEKDAYS[d] for d in cyc["days"]], at)
    return None


class PausedForGood(Exception):
    """This store is paused for good. Nothing may contact it."""


def is_paused_for_good(conn: sqlite3.Connection | None, chain: str) -> bool:
    """True if the store is paused for good: marked so in config/stores.yaml (paused_for_good), or a
    trial store (pause_for_good_on_block) was blocked at any point since its trial started.
    trial_since is a Sydney date; run times are UTC, so it's converted before comparing."""
    cfg = config.chain_config(chain)
    if cfg.get("paused_for_good"):
        return True
    if not cfg.get("pause_for_good_on_block") or conn is None:
        return False
    since = iso(sydney_midnight(date.fromisoformat(str(cfg.get("trial_since", "1970-01-01")))))
    return conn.execute(
        "SELECT 1 FROM collection_runs WHERE chain = ? AND status = 'blocked' AND started_at >= ? LIMIT 1",
        (chain, since)).fetchone() is not None


def is_due(conn: sqlite3.Connection, chain: str, kind: str, at: datetime | None = None) -> bool:
    """Due if there's been no successful run of this kind since the current cycle started.
    This keeps us to at most one full run per cycle per store."""
    start = cycle_start(chain, at)
    if start is None:
        return False
    if is_paused_for_good(conn, chain):
        return False
    if kind == "category" and not config.tracked_categories(chain):
        return False
    row = conn.execute(
        """SELECT MAX(started_at) FROM collection_runs
           WHERE chain = ? AND kind = ? AND status IN ('ok', 'partial')""",
        (chain, kind),
    ).fetchone()[0]
    last = parse_iso(row)
    # A blocked run also counts for a day, so we don't knock again straight away.
    blocked = parse_iso(conn.execute(
        "SELECT MAX(started_at) FROM collection_runs WHERE chain = ? AND status = 'blocked'", (chain,)
    ).fetchone()[0])
    if blocked and blocked > (at or now_utc()) - timedelta(days=1):
        return False
    return last is None or last < start
