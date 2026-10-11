"""Command line: `uv run specials <command>`."""

from __future__ import annotations

import argparse
import logging
import os
import sys

from . import config, db


def cmd_collect(args) -> int:
    from .collectors import get_collector_class, online_chains
    from .runner import is_due, run_chain

    chains = args.chain or [c for c in config.enabled_chains() if c in online_chains()]
    kinds = ["specials", "category"] if args.kind == "all" else [args.kind]
    conn = db.connect()
    failures = 0
    for chain in chains:
        blocked = False
        for kind in kinds:
            if blocked:
                break  # blocked once: leave this store alone for the rest of the run
            if kind == "category" and (not config.tracked_categories(chain)
                                       or getattr(get_collector_class(chain), "specials_are_categories", False)):
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

    conn = db.connect()
    if args.refresh:
        client = make_client(args.chain)
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


def cmd_import_tongli(args) -> int:
    from .manual import import_tongli_csv

    conn = db.connect()
    r = import_tongli_csv(conn, args.csv)
    print(f"Imported {r.items} Tong Li items ({r.observations} prices). Run {r.run_id}: {r.status}")
    return 0


def cmd_update(args) -> int:
    """Load history, collect what's due, append to history, rebuild the page's data files.
    Used by the GitHub Actions schedule (--where github) and the Mac command (--where mac)."""
    from .collectors import get_collector_class, online_chains
    from .export import export_site
    from .history import import_history, publish_new_runs
    from .runner import is_due, run_chain

    conn = db.connect()
    loaded = import_history(conn)
    print(f"History loaded: {loaded['runs']} runs, {loaded['observations']} prices, {loaded['products']} products")
    settings = config.settings()["chains"]
    chains = args.chain or [c for c in online_chains()
                            if settings[c].get("enabled", True) and settings[c].get("run_on", "github") == args.where]
    kinds = ["specials", "category"] if args.kind == "all" else [args.kind]
    problems = []
    for chain in chains if args.collect else []:
        for kind in kinds:
            if any(p.startswith(chain + " ") for p in problems):
                break  # blocked once: leave this store alone for the rest of the run
            if kind == "category" and (not config.tracked_categories(chain)
                                       or getattr(get_collector_class(chain), "specials_are_categories", False)):
                continue
            if not args.force and not is_due(conn, chain, kind):
                print(f"{chain:17} {kind:8} not due")
                continue
            r = run_chain(conn, chain, kind, max_pages=args.max_pages)
            print(f"{chain:17} {kind:8} {r.status:8} requests={r.requests:<4} items={r.items:<5}"
                  + (f"\n    {r.error.splitlines()[0]}" if r.error else ""))
            if r.status in ("blocked", "error"):
                problems.append(f"{chain} {kind}: {r.status}")
    if args.publish:
        pub = publish_new_runs(conn)
        print(f"History: appended {pub['runs']} runs and {pub['observations']} prices")
    counts = export_site(conn)
    print("Page data: " + ", ".join(f"{c} {n}" for c, n in sorted(counts.items())) if counts else "Page data: empty")
    if problems:
        print("PROBLEMS: " + "; ".join(problems))
        return 1
    return 0


def cmd_serve(args) -> int:
    """Serve the static family page locally (the same files GitHub Pages serves)."""
    import functools
    import http.server

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(config.PROJECT_ROOT / "site"))
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
    p.add_argument("--kind", choices=["specials", "category", "all"], default="all")
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

    p = sub.add_parser("import-tongli", help="import Tong Li specials from a CSV (see config/tongli_template.csv)")
    p.add_argument("csv")
    p.set_defaults(func=cmd_import_tongli)

    p = sub.add_parser("update", help="load history, collect what's due, append history, rebuild page data")
    p.add_argument("--where", choices=["github", "mac"],
                   default="github" if os.environ.get("GITHUB_ACTIONS") else "mac",
                   help="which stores to run: those set to run_on this place")
    p.add_argument("--chain", action="append", help="only this chain (repeatable; ignores run_on/enabled)")
    p.add_argument("--kind", choices=["specials", "category", "all"], default="all")
    p.add_argument("--force", action="store_true", help="run even if not due this cycle")
    p.add_argument("--max-pages", type=int, help="testing: at most N pages per group/category")
    p.add_argument("--no-publish", dest="publish", action="store_false", help="don't append to history files")
    p.add_argument("--no-collect", dest="collect", action="store_false",
                   help="only load history and rebuild the page data (after pulling)")
    p.set_defaults(func=cmd_update)

    p = sub.add_parser("serve", help="serve the family page locally")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.set_defaults(func=cmd_serve)

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
