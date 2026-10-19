"""Command line: `uv run specials <command>`."""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from . import config, db


def cmd_collect(args) -> int:
    from .collectors import get_collector_class, online_chains
    from .runner import is_due, run_chain

    chains = args.chain or [c for c in config.enabled_chains() if c in online_chains()]
    kinds = ["specials", "range", "catalogue"] if args.kind == "all" else [args.kind]
    conn = db.connect()
    from .runner import is_paused_for_good

    failures = 0
    for chain in chains:
        if is_paused_for_good(conn, chain):
            print(f"{chain:17} paused for good; not collecting")
            continue
        blocked = False
        for kind in kinds:
            if blocked:
                break  # blocked once: leave this store alone for the rest of the run
            if kind == "category" and (not config.tracked_categories(chain)
                                       or getattr(get_collector_class(chain), "specials_are_categories", False)):
                continue
            if kind == "specials" and not get_collector_class(chain).has_specials_read:
                continue
            from .catalogues import has_catalogue

            if kind == "catalogue" and not has_catalogue(chain):
                continue
            if args.due and not is_due(conn, chain, kind):
                print(f"{chain:17} {kind:8} not due (already collected this cycle)")
                continue
            r = run_chain(conn, chain, kind, max_pages=args.max_pages)
            print(f"{chain:17} {kind:8} {r.status:8} requests={r.requests:<4} items={r.items:<5} "
                  f"observations={r.observations}" + (f"\n    {r.error.splitlines()[0]}" if r.error else ""))
            failures += r.status in ("blocked", "error")
            blocked = r.status == "blocked"
    return 1 if failures else 0


def cmd_categories(args) -> int:
    from .collectors import get_collector_class
    from .runner import make_client

    from .runner import PausedForGood

    conn = db.connect()
    if args.refresh:
        try:
            client = make_client(args.chain)
        except PausedForGood as e:
            print(e)
            return 1
        try:
            cats = get_collector_class(args.chain)(config.chain_config(args.chain), client).discover_categories()
        finally:
            client.close()
        print(f"Saved {db.save_categories(conn, args.chain, cats)} {args.chain} categories "
              f"({client.requests_made} requests)")
    where, params = "chain = ?", [args.chain]
    if args.find:
        where += " AND (name LIKE ? OR path LIKE ?)"
        params += [f"%{args.find}%"] * 2
    for row in conn.execute(f"SELECT * FROM store_categories WHERE {where} ORDER BY path LIMIT 200", params):
        count = f" ({row['product_count']})" if row["product_count"] else ""
        print(f"{row['category_ref']:28} {row['path']}{count}\n{'':28} {row['url_path'] or ''}")
    return 0


def cmd_status(args) -> int:
    conn = db.connect()
    print("Latest runs:")
    for row in conn.execute(
        """SELECT r.* FROM collection_runs r JOIN (SELECT chain, kind, MAX(id) id FROM collection_runs
           GROUP BY chain, kind) last ON last.id = r.id ORDER BY r.chain, r.kind"""
    ):
        print(f"  {row['chain']:17} {row['kind']:8} {row['status']:8} {row['started_at']} "
              f"requests={row['requests_made']} items={row['items_seen']}")
        if row["error"]:
            print(f"    {row['error'].splitlines()[0]}")
    print("\nDatabase:")
    for label, sql in [
        ("products", "SELECT COUNT(*) FROM retailer_products"),
        ("with barcode", "SELECT COUNT(DISTINCT retailer_product_id) FROM retailer_product_gtins"),
        ("price observations", "SELECT COUNT(*) FROM price_observations"),
        ("specials observations", "SELECT COUNT(*) FROM price_observations WHERE is_special = 1"),
    ]:
        print(f"  {label:22} {conn.execute(sql).fetchone()[0]}")
    return 0


def cmd_search(args) -> int:
    from .search import search

    conn = db.connect()
    results = search(conn, args.query, chains=args.chain, specials_only=not args.all, limit=args.limit,
                     sort=args.sort)
    if not results:
        print("No matches." + ("" if args.all else " Try --all to include items that aren't on special."))
        return 0
    for r in results:
        price = _money(r["price_cents"])
        was = f" (was {_money(r['was_cents'])})" if r["was_cents"] else ""
        rrp = f" (RRP {_money(r['rrp_cents'])})" if r["rrp_cents"] else ""
        per = " per kg" if r["price_per"] == "kg" else ""
        promo = f"  [{r['promo_text']}]" if r["promo_text"] else ""
        unit = f"  {r['unit_price_text']}" if r["unit_price_text"] else ""
        ends = f"  ends {r['ends_label']}" if r["ends_label"] else ""
        name = r["display_name"] or r["name"]
        size = r["size_text"] if r["size_text"] and r["size_text"].replace(" ", "").lower() not in \
            name.replace(" ", "").lower() else ""
        print(f"{r['store_label']:28} {price}{per}{was}{rrp}  {name}{' ' + size if size else ''}"
              f"{promo}{unit}{ends}")
    return 0


def cmd_update(args) -> int:
    """The refresh. Loads history, collects what's due (each store once a week, on Wednesday morning: its specials,
    its full range, then its printed catalogue), re-runs matching, appends specials to the public history, rebuilds
    the public page data (every store's specials), and sends every store's range (for search) and the family's
    private watchlist to Supabase. The Mac runs it, morning and evening; most runs just check that nothing is due."""
    import json
    import time

    from . import backend, watchlist
    from .catalogues import has_catalogue
    from .collectors import get_collector_class, online_chains
    from .export import build_products, export_site
    from .history import import_history, publish_new_runs
    from .matching import run_matching
    from .runner import blocked_since_resume, is_due, is_paused_for_good, run_chain
    from .search import FRESH_DAYS
    from .watch_export import build_watchlist

    began = time.monotonic()
    conn = db.connect()
    loaded = import_history(conn)
    print(f"History loaded: {loaded['runs']} runs, {loaded['observations']} prices, {loaded['products']} products")
    settings = config.settings()["chains"]
    chains = args.chain or [c for c in online_chains()
                            if settings[c].get("enabled", True) and settings[c].get("run_on", "github") == args.where]
    kinds = ["specials", "range", "catalogue"] if args.kind == "all" else [args.kind]
    problems: list[str] = []
    collected = False
    for chain in chains if args.collect else []:
        cls = get_collector_class(chain)
        for kind in kinds:
            if any(p.startswith(chain + " ") for p in problems):
                break  # refused once: leave this store alone for the rest of the run
            if kind == "specials" and not cls.has_specials_read:
                continue
            if kind == "catalogue" and not has_catalogue(chain):
                continue
            if kind == "category" and (not config.tracked_categories(chain)
                                       or getattr(cls, "specials_are_categories", False)):
                continue
            if is_paused_for_good(conn, chain):
                print(f"{chain:17} paused for good (challenged during its trial; see config/stores.yaml)")
                break
            stopped = blocked_since_resume(conn, chain)
            if stopped:
                print(f"{chain:17} stopped: it refused us at {stopped}. Nothing contacts it until you run: "
                      f"uv run specials resume {chain}")
                break
            if not args.force and not is_due(conn, chain, kind):
                print(f"{chain:17} {kind:9} not due")
                continue
            t0 = time.monotonic()
            r = run_chain(conn, chain, kind, max_pages=args.max_pages, only_categories=args.category)
            collected |= r.status in ("ok", "partial")
            print(f"{chain:17} {kind:9} {r.status:8} requests={r.requests:<4} items={r.items:<6}"
                  f"prices={r.observations:<6} {_took(time.monotonic() - t0)}"
                  + (f"\n    {r.error.splitlines()[0]}" if r.error else ""))
            if r.status == "blocked" and settings[chain].get("pause_on_block"):
                print(f"PAUSED: {chain} refused us, so nothing will contact it again until you run: "
                      f"uv run specials resume {chain}")
            if r.status in ("blocked", "error"):
                problems.append(f"{chain} {kind}: {r.status}")
    # Re-run matching after every data update, across every store.
    db.reparse_attributes(conn)
    items = watchlist.load()
    watchlist.sync_to_db(conn, items)
    m = run_matching(conn, items)
    print(f"Matching: {m['matched']} matched, {m['review']} to review, {m['confirmed']} confirmed")
    if args.publish:
        pub = publish_new_runs(conn)
        print(f"History (specials only): appended {pub['runs']} runs and {pub['observations']} prices")
    products = build_products(conn, keep_internal_id=True)
    counts = export_site(conn, products=products)
    print("Public specials: " + (", ".join(f"{c} {n}" for c, n in sorted(counts["specials"].items())) or "none"))
    print("Current prices: " + (", ".join(f"{c} {n}" for c, n in sorted(counts["products"].items())) or "none"))
    # The family's watchlist (private): a copy on the Mac for notifications, and the family's row in Supabase.
    watch = build_watchlist(conn, items, products=products)
    from .notify import WATCH_FILE

    WATCH_FILE.parent.mkdir(parents=True, exist_ok=True)
    WATCH_FILE.write_text(json.dumps(watch, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    if args.upload and _connected():
        try:
            if _changed(watch):
                backend.upload_watchlist(watch)
                print("Family watchlist: sent to the family's private row")
            if collected or args.upload_ranges:
                t0 = time.monotonic()
                sent = backend.upload_products(products, FRESH_DAYS)
                print(f"Product ranges: sent {sent} products for search ({_took(time.monotonic() - t0)})")
        except backend.BackendError as e:
            print(f"Supabase: {e}")
            problems.append("supabase: upload failed")
    if args.notify and collected:
        from .notify import run as notify_run

        notify_run()
    print(f"Done in {_took(time.monotonic() - began)}")
    if problems:
        print("PROBLEMS: " + "; ".join(problems))
        return 1
    return 0


def _took(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 60}m {s % 60:02d}s" if s >= 60 else f"{s}s"


def _connected() -> bool:
    config.load_dotenv()
    return bool(os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SECRET_KEY"))


WATCH_SENT = config.PRIVATE_DIR / ".family-watchlist-sent"


def _changed(watch: dict) -> bool:
    """Whether the watchlist differs from the copy last sent (ignoring when it was built). Remembers this one."""
    import hashlib
    import json

    body = json.dumps({k: v for k, v in watch.items() if k != "generated_at"}, sort_keys=True).encode()
    digest = hashlib.sha256(body).hexdigest()
    try:
        if WATCH_SENT.read_text().strip() == digest:
            return False
    except OSError:
        pass
    WATCH_SENT.write_text(digest + "\n")
    return True


def cmd_resume(args) -> int:
    from .runner import blocked_since_resume, resume

    conn = db.connect()
    when = blocked_since_resume(conn, args.chain)
    resume(args.chain)
    print(f"{args.chain}: will be read again at its next refresh" + (f" (it refused us at {when})." if when else "."))
    return 0


def cmd_backup(args) -> int:
    from .backup import BACKUP_DIR, BackupError, is_due, notify, run_backup

    root = Path(args.dest) if args.dest else BACKUP_DIR
    if args.if_due and not is_due(root):
        print("Backup: not due (already backed up since this Wednesday)")
        return 0
    try:
        r = run_backup(root=root, keep=args.keep)
    except Exception as e:  # noqa: BLE001 - any failure must be reported, never silent
        msg = f"Backup failed: {e}"
        print("BACKUP FAILED: " + str(e))
        notify(msg)
        return 1
    print(f"Backup OK: {r.folder}  database {r.db_bytes / 1e6:.0f} MB -> {r.compressed_bytes / 1e6:.0f} MB "
          f"compressed, {r.private_files} private files" + (f"; deleted old: {', '.join(r.deleted)}" if r.deleted else ""))
    return 0


def cmd_restore(args) -> int:
    from .backup import BACKUP_DIR, backups, restore

    folder = Path(args.from_) if args.from_ else (backups(BACKUP_DIR) or [None])[0]
    if folder is None:
        print("No backups found.")
        return 1
    r = restore(folder, Path(args.to))
    print(f"Restored {folder.name} to {args.to}: database OK ({r['counts']['price_observations']} prices, "
          f"{r['counts']['retailer_products']} products), private files: {', '.join(r['private']) or 'none'}")
    return 0


def cmd_serve(args) -> int:
    """Serve the static family page locally (the same files GitHub Pages serves)."""
    import functools
    import http.server

    from . import backend

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(config.PROJECT_ROOT / "site"))
    if backend.write_app_config():
        print("Accounts: on (site/app-config.json written from .env; it's never committed)")
    print(f"Family page: http://{args.host}:{args.port}/")
    http.server.ThreadingHTTPServer((args.host, args.port), handler).serve_forever()
    return 0


def _money(cents) -> str:
    return "  n/a " if cents is None else f"${cents / 100:,.2f}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="specials", description="Family Specials Finder")
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("collect", help="collect specials and tracked categories")
    p.add_argument("--chain", action="append", help="only this chain (repeatable)")
    p.add_argument("--kind", choices=["specials", "range", "catalogue", "category", "all"], default="all")
    p.add_argument("--due", action="store_true", help="only chains not yet collected this cycle")
    p.add_argument("--max-pages", type=int, help="testing: read at most N pages per group/category")
    p.set_defaults(func=cmd_collect)

    p = sub.add_parser("categories", help="list (or --refresh) a store's categories")
    p.add_argument("--chain", required=True)
    p.add_argument("--find", help="filter by name/path")
    p.add_argument("--refresh", action="store_true", help="re-read the category tree from the store")
    p.set_defaults(func=cmd_categories)

    p = sub.add_parser("search", help="search collected products")
    p.add_argument("query")
    p.add_argument("--chain", action="append")
    p.add_argument("--all", action="store_true", help="include items that aren't on special")
    p.add_argument("--sort", choices=["relevance", "price", "saving"], default="relevance")
    p.add_argument("--limit", type=int, default=40)
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("status", help="latest runs and database counts")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("update", help="load history, collect what's due, append history, rebuild page data")
    p.add_argument("--where", choices=["github", "mac"],
                   default="github" if os.environ.get("GITHUB_ACTIONS") else "mac",
                   help="which stores to run: those set to run_on this place")
    p.add_argument("--chain", action="append", help="only this chain (repeatable; ignores run_on/enabled)")
    p.add_argument("--kind", choices=["specials", "range", "catalogue", "category", "all"], default="all",
                   help="all = specials, full range and catalogue")
    p.add_argument("--force", action="store_true", help="run even if not due this cycle")
    p.add_argument("--max-pages", type=int, help="testing: at most N pages per group/category")
    p.add_argument("--no-publish", dest="publish", action="store_false", help="don't append to history files")
    p.add_argument("--category", action="append", help="category reads: only this category id (repeatable)")
    p.add_argument("--no-collect", dest="collect", action="store_false",
                   help="only load history and rebuild the page data (after pulling)")
    p.add_argument("--no-upload", dest="upload", action="store_false",
                   help="don't send anything to Supabase (the ranges and the family watchlist)")
    p.add_argument("--upload-ranges", action="store_true", help="send the product ranges even if nothing was collected")
    p.add_argument("--no-notify", dest="notify", action="store_false", help="don't send phone notifications")
    p.set_defaults(func=cmd_update)

    p = sub.add_parser("resume", help="read a store again after it refused us (it's paused until you do)")
    p.add_argument("chain")
    p.set_defaults(func=cmd_resume)

    p = sub.add_parser("backup", help="back up the database and data/private to iCloud Drive")
    p.add_argument("--if-due", action="store_true", help="only if no backup since this Wednesday")
    p.add_argument("--dest", help="backup folder (default: iCloud Drive/family-specials-backups)")
    p.add_argument("--keep", type=int, default=8, help="how many backups to keep (default 8)")
    p.set_defaults(func=cmd_backup)

    p = sub.add_parser("restore", help="restore a backup into a folder (default: the latest backup)")
    p.add_argument("--from", dest="from_", help="a backup folder (default: the newest)")
    p.add_argument("--to", required=True, help="folder to restore into, e.g. data (existing files are kept aside)")
    p.set_defaults(func=cmd_restore)

    p = sub.add_parser("serve", help="serve the family page locally")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.set_defaults(func=cmd_serve)

    from . import cli_backend, cli_catalogue, cli_notify, cli_watch

    cli_watch.register(sub)
    cli_notify.register(sub)
    cli_backend.register(sub)
    cli_catalogue.register(sub)

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
