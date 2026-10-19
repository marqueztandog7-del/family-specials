"""A pretend family backend on this Mac, for testing the app's screens without touching Supabase.

    uv run python tests/fake_backend.py [--port 8765]

Serves site/ at http://localhost:PORT/ with an app-config.json that points the app at this server, and answers the
calls the app makes: sign up / sign in, the password reset (the "email" is written to data/logs/fake-emails.log
instead of being sent), the family, the family's watchlist (data/private/family-watchlist.json, built by
`specials update`), search over every store's current prices (from the local database), and the shared tables.
Accounts are kept in memory only, and nothing leaves this Mac. Live updates (Realtime) aren't pretended: the app
treats them as unavailable.
"""

from __future__ import annotations

import argparse
import http.server
import json
import re
import secrets
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from family_specials import config, db  # noqa: E402
from family_specials.backend import product_row  # noqa: E402
from family_specials.export import build_products  # noqa: E402

SITE = ROOT / "site"
EMAILS = config.DATA_DIR / "logs" / "fake-emails.log"
NO_FAMILY = config.DATA_DIR / "logs" / "fake-no-family"

# A pretend account that exists from the start (this server only; never a real account anywhere). Its password is
# made fresh each time the server starts and written to the pretend email log, so none is kept in the repo.
TEST_EMAIL = "tester@example.test"
USERS: dict[str, dict] = {TEST_EMAIL: {"id": str(uuid.uuid4()), "email": TEST_EMAIL,
                                       "password": secrets.token_urlsafe(12)}}
TOKENS: dict[str, str] = {}          # access or refresh token -> email
RESETS: dict[str, dict] = {}         # token_hash -> {email, expires, used}
FAMILY = {"id": str(uuid.uuid4()), "name": "Test Family"}
ROWS: dict[str, dict[str, dict]] = {"family_list_items": {}, "family_savings": {}, "family_watch_items": {}}
PRODUCTS: list[dict] = []


def load_products() -> None:
    conn = db.connect()
    PRODUCTS[:] = [product_row(p) for p in build_products(conn)]
    for p in PRODUCTS:
        p["_words"] = re.findall(r"[a-z0-9]+", f"{p['name']} {p['brand'] or ''} {p['size_text'] or ''} {p['chain']}".lower())


def user_json(u: dict) -> dict:
    return {"id": u["id"], "aud": "authenticated", "role": "authenticated", "email": u["email"],
            "app_metadata": {"provider": "email"}, "user_metadata": {}, "created_at": "2026-10-19T00:00:00Z",
            "email_confirmed_at": "2026-10-19T00:00:00Z"}


def session(email: str) -> dict:
    access, refresh = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    TOKENS[access] = TOKENS[refresh] = email
    return {"access_token": access, "token_type": "bearer", "expires_in": 3600, "expires_at": int(time.time()) + 3600,
            "refresh_token": refresh, "user": user_json(USERS[email])}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(SITE), **kw)

    def log_message(self, fmt, *args):  # quiet: only errors
        if args and str(args[1]).startswith(("4", "5")) and "/realtime/" not in str(args[0]):
            super().log_message(fmt, *args)

    # -- helpers
    def _json(self, status: int, body) -> None:
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"null") if n else None

    def _me(self) -> dict | None:
        auth = self.headers.get("Authorization", "")
        email = TOKENS.get(auth.removeprefix("Bearer ").strip())
        return USERS.get(email) if email else None

    # -- routes
    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == "/app-config.json":
            return self._json(200, {"supabaseUrl": f"http://{self.headers['Host']}", "supabaseKey": "fake-key"})
        if url.path == "/auth/v1/user":
            me = self._me()
            return self._json(200, user_json(me)) if me else self._json(401, {"msg": "invalid JWT"})
        if url.path.startswith("/rest/v1/"):
            table = url.path.split("/")[-1]
            return self._json(200, list(ROWS.get(table, {}).values()))
        if url.path.startswith("/realtime/"):
            return self._json(404, {})
        return super().do_GET()

    def do_HEAD(self):
        return super().do_HEAD()

    def do_PUT(self):
        url = urlsplit(self.path)
        if url.path == "/auth/v1/user":
            me = self._me()
            if not me:
                return self._json(401, {"msg": "invalid JWT"})
            pw = (self._body() or {}).get("password") or ""
            if len(pw) < 8:
                return self._json(422, {"error_code": "weak_password", "msg": "Password should be at least 8 characters."})
            if pw == me["password"]:
                return self._json(422, {"error_code": "same_password",
                                        "msg": "New password should be different from the old password."})
            me["password"] = pw
            return self._json(200, user_json(me))
        return self._json(404, {})

    def do_POST(self):
        url = urlsplit(self.path)
        q = parse_qs(url.query)
        body = self._body() or {}
        if url.path == "/auth/v1/signup":
            email = body["email"].lower()
            if email in USERS:
                return self._json(422, {"error_code": "user_already_exists", "msg": "User already registered"})
            USERS[email] = {"id": str(uuid.uuid4()), "email": email, "password": body["password"]}
            return self._json(200, session(email))
        if url.path == "/auth/v1/token":
            if q.get("grant_type") == ["password"]:
                u = USERS.get(body.get("email", "").lower())
                if not u or u["password"] != body.get("password"):
                    return self._json(400, {"error": "invalid_grant", "error_description": "Invalid login credentials"})
                return self._json(200, session(u["email"]))
            email = TOKENS.get(body.get("refresh_token", ""))
            return self._json(200, session(email)) if email else self._json(400, {"error_description": "Invalid Refresh Token"})
        if url.path == "/auth/v1/recover":
            email = body.get("email", "").lower()
            if email in USERS:            # like Supabase: the same answer either way
                token = secrets.token_hex(28)
                RESETS[token] = {"email": email, "expires": time.time() + 3600, "used": False}
                link = f"{q.get('redirect_to', [''])[0]}#/reset?token_hash={token}&type=recovery"
                EMAILS.parent.mkdir(parents=True, exist_ok=True)
                with EMAILS.open("a") as f:
                    f.write(json.dumps({"to": email, "link": link, "at": time.time()}) + "\n")
            return self._json(200, {})
        if url.path == "/auth/v1/verify":
            r = RESETS.get(body.get("token_hash", ""))
            if not r or r["used"] or r["expires"] < time.time():
                return self._json(403, {"code": 403, "error_code": "otp_expired",
                                        "msg": "Email link is invalid or has expired"})
            r["used"] = True
            return self._json(200, session(r["email"]))
        if url.path == "/auth/v1/logout":
            self.send_response(204)
            self.end_headers()
            return None
        if url.path.startswith("/rest/v1/rpc/"):
            return self._rpc(url.path.rsplit("/", 1)[-1], body)
        if url.path.startswith("/rest/v1/"):
            table = url.path.split("/")[-1]
            rows = body if isinstance(body, list) else [body]
            key = {"family_list_items": "item_key", "family_savings": "entry_id", "family_watch_items": "watch_key"}.get(table)
            for r in rows:
                if key:
                    ROWS[table][r[key]] = {**ROWS[table].get(r[key], {}), **r, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ")}
            return self._json(201, [ROWS[table][r[key]] for r in rows] if key else rows)
        return self._json(404, {})

    def _rpc(self, name: str, args: dict):
        me = self._me()
        if name == "ping":
            return self._json(200, "ok")
        if not me:
            return self._json(401, {"message": "permission denied"})
        if name == "my_family":
            if NO_FAMILY.exists():           # touch this file to test someone who isn't in a family
                return self._json(200, None)
            return self._json(200, {"id": FAMILY["id"], "name": FAMILY["name"], "is_owner": True,
                                    "me": {"nickname": "Tester", "role": "owner", "user_id": me["id"]},
                                    "members": [{"nickname": "Tester", "role": "owner", "user_id": me["id"]}]})
        if name == "my_profile":
            return self._json(200, {"name": None})
        if name == "my_watchlist":
            f = config.PRIVATE_DIR / "family-watchlist.json"
            if not f.exists() or NO_FAMILY.exists():
                return self._json(200, None)
            data = json.loads(f.read_text())
            if args.get("p_since") and args["p_since"] >= data["generated_at"]:
                return self._json(200, {"generated_at": data["generated_at"], "unchanged": True})
            return self._json(200, {"generated_at": data["generated_at"], "data": data})
        if name == "search_products":
            words = [w for w in re.findall(r"[a-z0-9]+", (args.get("p_query") or "").lower())]
            chains = args.get("p_chains")
            hits = [p for p in PRODUCTS if (not chains or p["chain"] in chains)
                    and all(any(x.startswith(w) for x in p["_words"]) for w in words)] if words else []
            hits.sort(key=lambda p: (not p["special"], p["price_cents"] or 10**9))
            return self._json(200, [{k: v for k, v in p.items() if k != "_words"} for p in hits[: args.get("p_limit") or 40]])
        if name == "products_by_id":
            ids = set(args.get("p_ids") or [])
            return self._json(200, [{k: v for k, v in p.items() if k != "_words"} for p in PRODUCTS
                                    if f"{p['chain']}:{p['product_id']}" in ids])
        return self._json(200, None)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    load_products()
    EMAILS.parent.mkdir(parents=True, exist_ok=True)
    with EMAILS.open("a") as f:
        f.write(json.dumps({"pretend_account": TEST_EMAIL, "password": USERS[TEST_EMAIL]["password"]}) + "\n")
    print(f"Pretend backend with {len(PRODUCTS)} products: http://localhost:{args.port}/ "
          f"(pretend account: {TEST_EMAIL}; its password is in {EMAILS})", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
