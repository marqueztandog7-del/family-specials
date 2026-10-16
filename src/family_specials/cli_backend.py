"""Family backend (Supabase) commands, on the Mac.

  specials backend connect [--project NAME]   connect the project (reads your access token from the clipboard)
  specials backend migrate                     apply new database changes in supabase/migrations
  specials backend status                      what's applied, and how many families/accounts (counts only)
"""

from __future__ import annotations

import subprocess

from . import backend


def cmd_backend(args) -> int:
    try:
        if args.action == "connect":
            token = subprocess.run(["pbpaste"], capture_output=True, text=True).stdout
            out = backend.connect(token, args.project)
            region = "Sydney" if out["region"] == backend.REGION else f"{out['region']} (not Sydney!)"
            print(f"Connected '{out['name']}' in {region}. Keys saved in .env and GitHub secrets (not shown).")
            print(f"Database changes applied: {', '.join(out['applied']) or 'none new'}")
            print("Sign-in: email and password, no confirmation email, passwords of 8+ characters.")
            return 0
        if args.action == "migrate":
            applied = backend.migrate()
            print(f"Applied: {', '.join(applied)}" if applied else "Nothing new to apply.")
            return 0
        s = backend.status()
        print(f"Accounts: {s.get('accounts')}, families: {s.get('families')}, members: {s.get('members')}")
        print(f"Applied: {s.get('migrations') or 'none'}")
        return 0
    except backend.BackendError as e:
        print(e)
        return 1


def register(sub) -> None:
    p = sub.add_parser("backend", help="the family backend (Supabase): connect, migrate, status")
    p.add_argument("action", choices=["connect", "migrate", "status"])
    p.add_argument("--project", help="connect: the Supabase project's name or ref (if you have several)")
    p.set_defaults(func=cmd_backend)
