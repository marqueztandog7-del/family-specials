"""Watchlist and matching commands (on the Mac; results are committed, the page is read-only).

  specials watch list                       the watchlist, core items first
  specials watch add woolworths 123456      add a product (same product, any store)
  specials watch add woolworths 123456 --similar   ...and also watch similar items
  specials match                            re-run matching and write the accuracy report
  specials review                           low-confidence matches waiting for you
  specials review confirm <watch-item> <store> <product id>
  specials review reject  <watch-item> <store> <product id>   (never comes back)
"""

from __future__ import annotations

from . import db, watchlist
from .matching import run_matching
from .watchlist import TIERS


def cmd_watch(args) -> int:
    conn = db.connect()
    if args.action == "add":
        key = watchlist.add_item_from_product(conn, args.chain, args.product_id, also_similar=args.similar,
                                              tier=args.tier, target=args.target)
        print(f"Added '{key}' (same product, any store{' + similar items' if args.similar else ''}). "
              "Commit config/watchlist.yaml to keep it.")
        return 0
    items = sorted(watchlist.load(), key=lambda i: (TIERS.get(i.tier, 9), i.name.lower()))
    for i in items:
        level = i.level.replace("_", " ") + (" + similar" if i.also_similar else "")
        target = f"  target {i.target}" if i.target else ""
        print(f"{i.tier:8} {i.name:34} {level:20} per {i.compare_per}{target}")
    print(f"\n{len(items)} items")
    return 0


def cmd_match(args) -> int:
    from .match_report import write_report

    conn = db.connect()
    reparsed = db.reparse_attributes(conn)
    if reparsed:
        print(f"Re-read sizes for {reparsed} products (parser updated)")
    items = watchlist.load()
    watchlist.sync_to_db(conn, items)
    counts = run_matching(conn, items)
    print(f"Matching: {counts['matched']} matched, {counts['review']} to review, {counts['confirmed']} confirmed, "
          f"{counts['rejected']} rejected")
    if args.report:
        path, s = write_report(conn, items)
        print(f"Receipt-name test: watch item {s['receipt_item_pass']}/{s['receipt_total']}, "
              f"product {s['receipt_product_pass']}/{s['receipt_product_testable']}")
        print(f"Report: {path}")
    return 0


def cmd_review(args) -> int:
    conn = db.connect()
    if args.action in ("confirm", "reject"):
        watchlist.add_decision(args.watch_item, args.chain, args.product_id, args.action, note=args.note or "")
        items = watchlist.load()
        watchlist.sync_to_db(conn, items)
        run_matching(conn, items)
        print(f"{args.action.title()}ed. Saved in watchlist/decisions.csv (commit it to keep it).")
        return 0
    rows = conn.execute(
        """SELECT w.key, w.name, p.chain, p.retailer_product_id, COALESCE(p.display_name, p.name) AS pname,
                  m.reason, m.confidence FROM watch_matches m JOIN watch_items w ON w.id = m.watch_item_id
           JOIN retailer_products p ON p.id = m.retailer_product_id
           WHERE m.status = 'review' ORDER BY w.key, m.confidence DESC""").fetchall()
    if not rows:
        print("Nothing to review.")
        return 0
    for r in rows:
        print(f"{r['key']:28} {r['chain']:17} {r['retailer_product_id']:>20}  {r['confidence']:.2f}  {r['pname']}"
              f"\n{'':28} {r['reason']}")
    print(f"\n{len(rows)} to review. Confirm or reject with:\n"
          "  uv run specials review confirm <watch-item> <store> <product id>\n"
          "  uv run specials review reject  <watch-item> <store> <product id>")
    return 0


def register(sub) -> None:
    p = sub.add_parser("watch", help="the watchlist: list, or add a product")
    p.add_argument("action", choices=["list", "add"], nargs="?", default="list")
    p.add_argument("chain", nargs="?")
    p.add_argument("product_id", nargs="?")
    p.add_argument("--similar", action="store_true", help="also watch similar items")
    p.add_argument("--tier", choices=["core", "regular", "occasional"], default="regular")
    p.add_argument("--target", help="target unit price, e.g. '$12/kg'")
    p.set_defaults(func=cmd_watch)

    p = sub.add_parser("match", help="re-run matching (and write the accuracy report)")
    p.add_argument("--no-report", dest="report", action="store_false")
    p.set_defaults(func=cmd_match)

    p = sub.add_parser("review", help="matches waiting for you to confirm or reject")
    p.add_argument("action", choices=["list", "confirm", "reject"], nargs="?", default="list")
    p.add_argument("watch_item", nargs="?")
    p.add_argument("chain", nargs="?")
    p.add_argument("product_id", nargs="?")
    p.add_argument("--note")
    p.set_defaults(func=cmd_review)
