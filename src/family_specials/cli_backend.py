"""Family backend (Supabase) commands, on the Mac.

  specials backend connect [--project NAME]   connect the project (asks you to paste your access token; it isn't shown)
  specials backend migrate                     apply new database changes in supabase/migrations
  specials backend status                      what's applied, and how many families/accounts (counts only)
  specials backend test                        the database self-test (pretend people, rolled back: saves nothing)
"""

from __future__ import annotations

import getpass
import subprocess
import sys

from . import backend


def read_token(from_clipboard: bool) -> str:
    """The access token, pasted at a hidden prompt (nothing shows as you paste), or from the clipboard if asked."""
    if from_clipboard:
        return subprocess.run(["pbpaste"], capture_output=True, text=True).stdout
    if sys.stdin.isatty():
        return getpass.getpass("Paste your Supabase access token (it won't show as you paste), then press Return: ")
    return sys.stdin.readline()


def cmd_backend(args) -> int:
    try:
        if args.action == "connect":
            out = backend.connect(read_token(args.from_clipboard), args.project)
            region = "Sydney" if out["region"] == backend.REGION else f"{out['region']} (not Sydney!)"
            print(f"Connected '{out['name']}' in {region}. Keys saved in .env and GitHub secrets (not shown).")
            print(f"Database changes applied: {', '.join(out['applied']) or 'none new'}")
            print("Sign-in: email and password, no confirmation email, passwords of 8+ characters.")
            return 0
        if args.action == "migrate":
            applied = backend.migrate()
            print(f"Applied: {', '.join(applied)}" if applied else "Nothing new to apply.")
            return 0
        if args.action == "test":
            results = backend.selftest()
            for r in results:
                print(f"{'PASS' if r['ok'] else 'FAIL'}  {r['name']}" + ("" if r["ok"] else f"  ({r['detail']})"))
            passed = sum(1 for r in results if r["ok"])
            print(f"{passed}/{len(results)} passed")
            return 0 if results and passed == len(results) else 1
        s = backend.status()
        print(f"Accounts: {s.get('accounts')}, families: {s.get('families')}, members: {s.get('members')}")
        print(f"Applied: {s.get('migrations') or 'none'}")
        return 0
    except backend.BackendError as e:
        print(e)
        return 1


def register(sub) -> None:
    p = sub.add_parser("backend", help="the family backend (Supabase): connect, migrate, status")
    p.add_argument("action", choices=["connect", "migrate", "status", "test"])
    p.add_argument("--project", help="connect: the Supabase project's name or ref (if you have several)")
    p.add_argument("--from-clipboard", action="store_true", help="connect: read the token from the clipboard instead")
    p.set_defaults(func=cmd_backend)
