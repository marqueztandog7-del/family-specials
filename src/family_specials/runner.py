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


def make_client(chain: str, kind: str = "specials") -> PoliteClient:
    cfg = config.chain_config(chain)
    if cfg.get("paused_for_good"):
        # The one place every web request starts from: a store paused for good is never contacted.
        raise PausedForGood(f"{chain} is paused for good ({cfg['paused_for_good']}); nothing will contact it")
    pol = cfg.get("politeness", {})
    # The weekly full-range and catalogue reads have their own (larger) request limits; the delays are the same.
    budget = (cfg.get(kind) or {}).get("max_requests") if kind in ("range", "catalogue") else None
    cookies = None
    if chain == "coles":
        # Pins prices to our Click & Collect store (no login needed).
        cookies = {"fulfillmentStoreId": str(cfg["store"]["ref"]), "shopping-method": "clickAndCollect"}
    return PoliteClient(
        chain,
        delay_seconds=tuple(pol.get("delay_seconds", (3, 6))),
        max_requests=budget or pol.get("max_requests_per_run", 100),
        cookies=cookies,
    )


def run_chain(conn: sqlite3.Connection, chain: str, kind: str, max_pages: int | None = None,
              only_categories: list[str] | None = None) -> RunResult:
    """kind: 'specials', 'range' (the store's full range, once a week), 'catalogue' (the printed catalogue) or
    'category' (the tracked categories, on request)."""
    cfg = config.chain_config(chain)
    if is_paused_for_good(conn, chain):
        raise PausedForGood(f"{chain} is paused for good; not collecting")
    if kind == "catalogue":
        from .catalogues import run_catalogue

        return run_catalogue(conn, chain, max_pages=max_pages)
    run_id = db.start_run(conn, chain, kind)
    items = observations = 0
    status, error = "ok", None
    client = make_client(chain, kind)
    collector = get_collector_class(chain)(cfg, client, max_pages=max_pages)
    # Chemist Warehouse's category reads record its clearance specials, so its prices are category prices.
    source = ("range" if kind == "range" else
              "category" if kind == "category" or getattr(collector, "specials_are_categories", False) else "specials")
    # A full-range read records a product's price only when it changed since we last recorded it (or a month has
    # passed), except for products matched to the watchlist, which get a price every week for their signals. The
    # product itself is marked as seen either way. Products already read in this week's specials read are skipped:
    # that read has their special (ALDI's Special Buys aren't marked as specials in its range listing).
    keep: set[int] = set()
    skip: set[str] = set()
    if kind == "range":
        keep = {r[0] for r in conn.execute("SELECT DISTINCT retailer_product_id FROM watch_matches "
                                           "WHERE status IN ('auto', 'confirmed')")}
        start = cycle_start(chain)
        if start is not None:
            skip = {r[0] for r in conn.execute(
                """SELECT DISTINCT p.retailer_product_id FROM price_observations o
                   JOIN retailer_products p ON p.id = o.retailer_product_id JOIN collection_runs r ON r.id = o.run_id
                   WHERE r.chain = ? AND r.kind = 'specials' AND r.started_at >= ?""", (chain, iso(start)))}
    try:
        if kind == "specials":
            raw_items = collector.fetch_specials()
        elif kind == "range":
            raw_items = collector.fetch_range()
        else:
            cats = config.tracked_categories(chain)
            if only_categories:
                cats = [c for c in cats if str(_ref(c)) in only_categories]
            raw_items = _category_items(collector, _with_category_details(conn, chain, cats))
        for raw in raw_items:
            item = collector.normalise(raw)
            if item is None:
                continue
            if kind == "range" and item.product.retailer_product_id in skip:
                db.mark_seen(conn, chain, item.product.retailer_product_id)
                items += 1
                continue
            observations += db.save_item(conn, run_id, item, source, raw.context.get("category_ref"),
                                         only_changes=kind == "range", keep=keep)
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


def _ref(c: dict) -> str:
    return str(c.get("id") or c.get("key") or c.get("slug") or c.get("query") or c.get("code") or c.get("category"))


def _category_items(collector, categories):
    for cat in categories:
        ref = _ref(cat)   # the same value as in the private watchlist.yaml (id, key, slug, search words, name)
        try:
            for raw in collector.fetch_category(cat):
                raw.context = {**raw.context, "category_ref": ref}
                yield raw
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


RESUMES_FILE = config.DATA_DIR / "store-resumes.json"


def resumed_at(chain: str) -> str | None:
    """When you last lifted a pause after a block (`specials resume <store>`)."""
    import json

    try:
        return json.loads(RESUMES_FILE.read_text(encoding="utf-8")).get(chain)
    except (OSError, ValueError):
        return None


def resume(chain: str) -> None:
    import json

    try:
        data = json.loads(RESUMES_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    data[chain] = iso(now_utc())
    RESUMES_FILE.parent.mkdir(parents=True, exist_ok=True)
    RESUMES_FILE.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")


def blocked_since_resume(conn: sqlite3.Connection | None, chain: str) -> str | None:
    """For stores set to pause_on_block: the time of the block that paused it (None when it isn't paused).
    Nothing contacts the store again until you run `specials resume <store>`."""
    cfg = config.chain_config(chain)
    if not cfg.get("pause_on_block") or conn is None:
        return None
    return conn.execute(
        "SELECT MAX(started_at) FROM collection_runs WHERE chain = ? AND status = 'blocked' AND started_at > ?",
        (chain, resumed_at(chain) or "")).fetchone()[0]


def is_due(conn: sqlite3.Connection, chain: str, kind: str, at: datetime | None = None) -> bool:
    """Due if there's been no successful run of this kind since the current cycle started.
    This keeps us to at most one full run per cycle per store."""
    start = cycle_start(chain, at)
    if start is None:
        return False
    if is_paused_for_good(conn, chain) or blocked_since_resume(conn, chain):
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
