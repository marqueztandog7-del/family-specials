"""Catalogue commands, on the Mac.

  specials catalogue key     save the AI reader's key (Anthropic API) for Chemist Warehouse's catalogue pages
                             (asks you to paste it; it isn't shown)
  specials catalogue review  go through catalogue offers that couldn't be read or matched with confidence
"""

from __future__ import annotations

import getpass
import subprocess
import sys

from . import config, db


def cmd_catalogue(args) -> int:
    if args.action == "key":
        if sys.stdin.isatty():
            key = getpass.getpass("Paste your Anthropic API key (it won't show as you paste), then press Return: ")
        else:
            key = sys.stdin.readline()
        key = key.strip()
        if not key.startswith("sk-ant-"):
            print("That doesn't look like an Anthropic API key (they start with sk-ant-). Copy it again and retry.")
            return 1
        config.set_env("ANTHROPIC_API_KEY", key)
        try:
            config.set_github_secret("ANTHROPIC_API_KEY", key)
        except (subprocess.CalledProcessError, FileNotFoundError):
            print("Saved on this Mac (.env), but the GitHub secret couldn't be saved. Check `gh auth status`.")
            return 1
        print("Saved: on this Mac (.env) and as the GitHub secret ANTHROPIC_API_KEY (not shown). "
              "Chemist Warehouse's catalogue is read at the next refresh.")
        return 0
    if args.action == "review":
        return cmd_review(args)
    return 1


def _show(entry: dict) -> None:
    o = entry.get("offer") or {}
    print("\n" + "-" * 70)
    print(f"{entry['chain']}  {entry.get('catalogue_title') or entry.get('catalogue')}  page {entry['page']}")
    print(f"Why it's here: {entry['reason']}")
    if o:
        print(f"Printed: {o.get('name')}  {o.get('size') or ''}")
        print(f"Price: ${o['price']:.2f}" if o.get("price") is not None else "Price: (none)")
        if o.get("saving_text"):
            print(f"Saving as printed: {o['saving_text']}")
    if entry.get("text"):
        print(f"Text: {entry['text']}")
    c = entry.get("candidate")
    if c:
        print(f"Best guess: {c['name']}  (match {c['score']:.0%})")


def cmd_review(args) -> int:
    from .catalogues import load_review, save_review
    from .catalogues.chemistwarehouse import apply_review, load_range
    from .matching import name_score, normalise

    items = load_review()
    pending = [i for i in items if i.get("status") == "pending"]
    if not pending:
        print("Nothing to review.")
        return 0
    print(f"{len(pending)} catalogue offer(s) to check. For each: y = yes, it's that product; n = no / not a special;"
          " p = pick the product; s = skip for now; q = stop.")
    conn = db.connect()
    products = load_range(conn)
    for entry in pending:
        _show(entry)
        if entry.get("image"):
            subprocess.run(["open", entry["image"]], check=False)       # the catalogue page, in Preview
        elif entry.get("booklet_url"):
            print(f"Booklet page: {entry['booklet_url']}")
        choice = input("y / n / p / s / q: ").strip().lower()
        if choice == "q":
            break
        if choice == "n":
            entry["status"] = "rejected"
        elif choice in ("y", "p") and entry["chain"] == "chemistwarehouse":
            store_id = (entry.get("candidate") or {}).get("store_id")
            if choice == "p" or not store_id:
                words = input("Search the range for (Return = the printed name): ").strip()
                offer = dict(entry["offer"], name=words or entry["offer"].get("name"))
                target = normalise(offer["name"])
                ranked = sorted(products, key=lambda p: -name_score(target, p["norm"]))[:5]
                for n, p in enumerate(ranked, 1):
                    print(f"  {n}. {p['name']}")
                pick = input("Which one (number, or Return for none)? ").strip()
                if not pick.isdigit() or not 1 <= int(pick) <= len(ranked):
                    continue
                store_id = ranked[int(pick) - 1]["store_id"]
            print(apply_review(conn, entry, store_id))
            entry["status"] = "accepted"
            entry["product"] = store_id
        elif choice == "y":
            print("Noted. (Costco items are recorded from the booklet's own item numbers, so there's nothing to add.)")
            entry["status"] = "accepted"
        save_review(items)
    left = sum(1 for i in items if i.get("status") == "pending")
    print(f"\n{left} left to review." if left else "\nAll done.")
    return 0


def register(sub) -> None:
    p = sub.add_parser("catalogue", help="catalogues: save the AI reader's key, or review offers that need a check")
    p.add_argument("action", choices=["key", "review"])
    p.set_defaults(func=cmd_catalogue)
