"""The family backend (Supabase, free plan, Sydney): connect the project, apply the database migrations, and write
the app's settings.

  - `connect` uses your Supabase personal access token (from the clipboard) to find the project, read its keys and
    set up sign-in. The token, the secret key and the project details go in .env (readable only by you). The
    project address and its public key also go in GitHub secrets, so the publish workflows can give them to the
    app. The secret key is never printed and never committed.
  - `migrate` applies supabase/migrations/*.sql in order, once each (recorded in private.app_migrations).
  - The app reads site/app-config.json (project address + public key). It's written at publish time from GitHub
    secrets and locally by `specials serve`; it's never committed.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx

from . import config

API = "https://api.supabase.com"
MIGRATIONS = config.PROJECT_ROOT / "supabase" / "migrations"
APP_CONFIG = config.PROJECT_ROOT / "site" / "app-config.json"
PAGES_URL = "https://marqueztandog7-del.github.io/family-specials/"
LOCAL_URL = "http://localhost:8765/"
REGION = "ap-southeast-2"       # Sydney


class BackendError(RuntimeError):
    pass


def _api(method: str, path: str, token: str, **kw: Any) -> Any:
    try:
        r = httpx.request(method, API + path, headers={"Authorization": f"Bearer {token}"}, timeout=90, **kw)
    except httpx.HTTPError as e:
        raise BackendError(f"Couldn't reach Supabase: {e.__class__.__name__}") from e
    if r.status_code >= 400:
        try:
            msg = r.json().get("message") or r.text
        except ValueError:
            msg = r.text
        raise BackendError(f"Supabase said {r.status_code}: {str(msg)[:300]}")
    return r.json() if r.content else None


def pick_project(projects: list[dict[str, Any]], wanted: str | None) -> dict[str, Any]:
    if wanted:
        hits = [p for p in projects if wanted in (p.get("name"), p.get("ref"))]
    else:
        hits = [p for p in projects if p.get("name") == "family-specials"] or projects
    if len(hits) != 1:
        names = ", ".join(p.get("name", "?") for p in projects) or "none"
        raise BackendError(f"Pick the project with --project (your projects: {names})")
    return hits[0]


def pick_keys(keys: list[dict[str, Any]]) -> tuple[str, str]:
    """The public (publishable) key for the app and the secret key for GitHub and the Mac. New-style keys are
    preferred; older projects only have the legacy 'anon' and 'service_role' keys."""
    def first(kind: str, legacy: str) -> str | None:
        for k in keys:
            if k.get("type") == kind and k.get("api_key"):
                return k["api_key"]
        for k in keys:
            if k.get("type") in ("legacy", None) and k.get("name") == legacy and k.get("api_key"):
                return k["api_key"]
        return None
    public, secret = first("publishable", "anon"), first("secret", "service_role")
    if not public or not secret:
        raise BackendError("Couldn't find the project's publishable and secret keys")
    return public, secret


def token() -> str:
    config.load_dotenv()
    t = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
    if not t:
        raise BackendError("Not connected yet. Copy your Supabase access token, then: uv run specials backend connect")
    return t


def project_ref() -> str:
    config.load_dotenv()
    ref = os.environ.get("SUPABASE_PROJECT_REF", "")
    if not ref:
        raise BackendError("Not connected yet: uv run specials backend connect")
    return ref


def sql(query: str, read_only: bool = False) -> list[dict[str, Any]]:
    return _api("POST", f"/v1/projects/{project_ref()}/database/query", token(),
                json={"query": query, "read_only": read_only}) or []


def connect(access_token: str, wanted: str | None = None) -> dict[str, Any]:
    access_token = access_token.strip()
    if not access_token.startswith("sbp_"):
        raise BackendError("That isn't a Supabase access token (they start with sbp_). Copy it again and retry.")
    project = pick_project(_api("GET", "/v1/projects", access_token), wanted)
    ref = project["ref"]
    public, secret = pick_keys(_api("GET", f"/v1/projects/{ref}/api-keys", access_token, params={"reveal": "true"}))
    url = f"https://{ref}.supabase.co"
    for name, value in (("SUPABASE_ACCESS_TOKEN", access_token), ("SUPABASE_PROJECT_REF", ref),
                        ("SUPABASE_URL", url), ("SUPABASE_PUBLISHABLE_KEY", public), ("SUPABASE_SECRET_KEY", secret)):
        config.set_env(name, value)
    import subprocess

    try:
        for name, value in (("SUPABASE_URL", url), ("SUPABASE_PUBLISHABLE_KEY", public), ("SUPABASE_SECRET_KEY", secret)):
            config.set_github_secret(name, value)
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        raise BackendError("Saved to .env, but couldn't save the GitHub secrets. Check `gh auth status`, "
                           "then run this again.") from e
    configure_auth()
    applied = migrate()
    write_app_config()
    return {"name": project.get("name"), "region": project.get("region"), "applied": applied}


def configure_auth() -> None:
    """Email and password sign-in, no confirmation email (Supabase's built-in email only reaches the project's own
    team), passwords of at least 8 characters, and only our app's addresses allowed to come back from sign-in."""
    _api("PATCH", f"/v1/projects/{project_ref()}/config/auth", token(), json={
        "site_url": PAGES_URL,
        "uri_allow_list": f"{PAGES_URL}**,{LOCAL_URL}**",
        "external_email_enabled": True,
        "mailer_autoconfirm": True,
        "password_min_length": 8,
        "disable_signup": False,
    })


def migration_files() -> list[Path]:
    return sorted(MIGRATIONS.glob("[0-9][0-9][0-9]_*.sql"))


def migrate() -> list[str]:
    """Apply each migration once, in order. Each runs in a transaction with its record, so it's all or nothing."""
    sql("create schema if not exists private; "
        "create table if not exists private.app_migrations (name text primary key, applied_at timestamptz not null default now());")
    done = {r["name"] for r in sql("select name from private.app_migrations", read_only=True)}
    applied = []
    for f in migration_files():
        if f.name in done:
            continue
        body = f.read_text(encoding="utf-8")
        name = f.name.replace("'", "''")
        # A lock limit, so a busy table makes the migration fail clearly instead of hanging.
        sql(f"begin;\nset local lock_timeout = '20s';\n{body}\n"
            f"insert into private.app_migrations (name) values ('{name}');\ncommit;")
        applied.append(f.name)
    return applied


def write_app_config(path: Path | None = None) -> bool:
    """site/app-config.json for the app: the project address and its public key (designed to be public; the
    database's row-level security is what protects the data). Never committed."""
    config.load_dotenv()
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_PUBLISHABLE_KEY")
    if not (url and key):
        return False
    path = path or APP_CONFIG
    path.write_text(json.dumps({"supabaseUrl": url, "supabaseKey": key}) + "\n", encoding="utf-8")
    return True


# --------------------------------------------------------------------------- data the Mac sends each week


def _rest(method: str, path: str, **kw: Any) -> httpx.Response:
    """The project's data API with the secret key (Mac only; bypasses row-level security, so only store data and
    our own family's watchlist are ever sent with it). New-style keys go in the apikey header only."""
    config.load_dotenv()
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SECRET_KEY")
    if not (url and key):
        raise BackendError("Not connected yet: uv run specials backend connect")
    headers = {"apikey": key, "Content-Type": "application/json", **kw.pop("headers", {})}
    if not key.startswith("sb_"):
        headers["Authorization"] = f"Bearer {key}"     # legacy service_role key (a JWT)
    try:
        r = httpx.request(method, f"{url}/rest/v1/{path}", headers=headers, timeout=120, **kw)
    except httpx.HTTPError as e:
        raise BackendError(f"Couldn't reach Supabase: {e.__class__.__name__}") from e
    if r.status_code >= 400:
        raise BackendError(f"Supabase said {r.status_code}: {r.text[:300]}")
    return r


PRODUCT_COLUMNS = ("chain", "product_id", "name", "brand", "size_text", "category", "url", "image", "price_cents",
                   "price_per", "unit_cents", "unit_per", "store_unit_text", "was_cents", "rrp_cents", "special",
                   "special_type", "promo", "multibuy", "valid_from", "valid_to", "valid_to_assumed", "basis",
                   "in_stock", "seen_at")


def product_row(p: dict[str, Any]) -> dict[str, Any]:
    """One product from export.build_products, as a store_products row."""
    unit = p.get("unit") or {}
    row = {
        "chain": p["chain"], "product_id": p["id"].split(":", 1)[1], "name": p["name"], "brand": p.get("brand"),
        "size_text": p.get("size"), "category": p.get("category"), "url": p.get("url"), "image": p.get("image"),
        "price_cents": p.get("price_cents"), "price_per": p.get("price_per") or "each",
        "unit_cents": unit.get("cents"), "unit_per": unit.get("per"), "store_unit_text": p.get("store_unit_text"),
        "was_cents": p.get("was_cents"), "rrp_cents": p.get("rrp_cents"), "special": bool(p.get("special")),
        "special_type": p.get("special_type"), "promo": p.get("promo"), "multibuy": p.get("multibuy"),
        "valid_from": p.get("valid_from"), "valid_to": p.get("valid_to"),
        "valid_to_assumed": bool(p.get("valid_to_assumed")), "basis": p.get("basis"), "in_stock": p.get("in_stock"),
        "seen_at": p["seen_at"],
    }
    return {k: row[k] for k in PRODUCT_COLUMNS}


def upload_products(products: list[dict[str, Any]], fresh_days: dict[str, int], batch: int = 1000) -> int:
    """Send every store's current range to store_products (once a week, after the refresh), then remove products
    that are no longer current (not seen within the store's fresh window, unless a special with a store end date
    that hasn't passed). Returns how many were sent."""
    from datetime import timedelta

    from .timeutil import iso, now_utc

    rows = [product_row(p) for p in products]
    for i in range(0, len(rows), batch):
        _rest("POST", "store_products?on_conflict=chain,product_id", json=rows[i:i + batch],
              headers={"Prefer": "resolution=merge-duplicates,return=minimal"})
    now = now_utc()
    for chain, days in fresh_days.items():
        cutoff = iso(now - timedelta(days=days))
        _rest("DELETE", f"store_products?chain=eq.{chain}&seen_at=lt.{cutoff}"
                        f"&or=(special.eq.false,valid_to.is.null,valid_to.lt.{iso(now)})")
    return len(rows)


def home_family_id() -> str:
    """Our family in Supabase (the one the private watchlist on this Mac belongs to). Found once and kept in .env.
    Never printed."""
    config.load_dotenv()
    fid = os.environ.get("SUPABASE_FAMILY_ID")
    if fid:
        return fid
    rows = sql("select id from public.families order by created_at", read_only=True)
    if len(rows) != 1:
        raise BackendError("There isn't exactly one family yet, so I can't tell which one the watchlist belongs to. "
                           "Start the family in the app first (or set SUPABASE_FAMILY_ID in .env).")
    config.set_env("SUPABASE_FAMILY_ID", rows[0]["id"])
    return rows[0]["id"]


def upload_watchlist(data: dict[str, Any]) -> None:
    """The family's watchlist (with its Core / Regulars groups) to its private row: only its members can read it."""
    _rest("POST", "family_watchlist?on_conflict=family_id",
          json={"family_id": home_family_id(), "data": data, "generated_at": data["generated_at"]},
          headers={"Prefer": "resolution=merge-duplicates,return=minimal"})


# --------------------------------------------------------------------------- password reset emails

RESET_SUBJECT = "Reset your Family Specials password"
# {{ .RedirectTo }} is the app's own address (checked against the allowed list; otherwise the Pages address). The
# link carries a one-time token that only the app uses, so it works in any browser, including mail apps' own.
RESET_TEMPLATE = """<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#2b2622;max-width:480px">
<h2 style="font-size:20px;margin:0 0 12px">Reset your password</h2>
<p style="margin:0 0 16px">Someone asked to reset the password for your Family Specials account. Tap the button to choose a new one.</p>
<p style="margin:0 0 20px"><a href="{{ .RedirectTo }}#/reset?token_hash={{ .TokenHash }}&type=recovery" style="display:inline-block;background:#b5532f;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px">Set a new password</a></p>
<p style="margin:0 0 8px;color:#6b625b;font-size:14px">The link works once and expires in an hour. If you didn't ask for this, you can ignore this email: your password stays the same.</p>
<p style="margin:16px 0 0;color:#6b625b;font-size:14px">Family Specials</p>
</div>"""


def configure_email(sender: str, app_password: str) -> None:
    """Send sign-in emails (password resets) through a Gmail account made for the app, with its app password.
    The password is set in Supabase (which sends the emails) and kept in .env and the GitHub secret SMTP_PASSWORD;
    it's never printed or committed."""
    sender = sender.strip()
    app_password = app_password.replace(" ", "").strip()
    if not sender.lower().endswith("@gmail.com") or "@" not in sender:
        raise BackendError("That doesn't look like a Gmail address.")
    if len(app_password) != 16 or not app_password.isalpha():
        raise BackendError("A Google app password is 16 letters (it's shown in groups of four). Copy it again.")
    _api("PATCH", f"/v1/projects/{project_ref()}/config/auth", token(), json={
        "external_email_enabled": True,
        "smtp_admin_email": sender, "smtp_sender_name": "Family Specials",
        "smtp_host": "smtp.gmail.com", "smtp_port": "465", "smtp_user": sender, "smtp_pass": app_password,
        "rate_limit_email_sent": 30,
    })
    # The free plan only allows our own email wording once a custom sender is set, so this comes second.
    configure_reset_template()
    config.set_env("SMTP_SENDER", sender)
    config.set_env("SMTP_PASSWORD", app_password)
    try:
        config.set_github_secret("SMTP_PASSWORD", app_password)
    except Exception as e:  # noqa: BLE001 - Supabase is set up; only the backup copy failed
        raise BackendError("Emails are set up, but the GitHub secret couldn't be saved. Check `gh auth status`, "
                           "then run this again.") from e


def configure_reset_template() -> None:
    """The reset email's wording and link. Needs the custom sender first (the free plan doesn't allow changing
    the built-in sender's emails); until then Supabase's standard reset email is sent, and the app handles its
    link too."""
    _api("PATCH", f"/v1/projects/{project_ref()}/config/auth", token(), json={
        "mailer_otp_exp": 3600, "mailer_subjects_recovery": RESET_SUBJECT,
        "mailer_templates_recovery_content": RESET_TEMPLATE,
    })


def email_settings() -> dict[str, Any]:
    """What's set for emails, without the password."""
    cfg = _api("GET", f"/v1/projects/{project_ref()}/config/auth", token())
    return {"custom_sender": bool(cfg.get("smtp_host")), "sender": cfg.get("smtp_admin_email"),
            "per_hour": cfg.get("rate_limit_email_sent"), "site_url": cfg.get("site_url"),
            "allowed": cfg.get("uri_allow_list"), "subject": cfg.get("mailer_subjects_recovery"),
            "expires_seconds": cfg.get("mailer_otp_exp")}


TESTS = config.PROJECT_ROOT / "supabase" / "tests"


def selftest() -> list[dict[str, Any]]:
    """Run supabase/tests/*.sql against the project. Each file runs in a transaction that's rolled back, with
    pretend people, so nothing is saved. Returns each check's result."""
    results: list[dict[str, Any]] = []
    for f in sorted(TESTS.glob("*.sql")):
        for row in sql(f.read_text(encoding="utf-8")):
            results.append({"file": f.name, **row})
    return results


def status() -> dict[str, Any]:
    """Counts only: never names, nicknames or emails."""
    rows = sql("select (select count(*) from public.families) as families, "
               "(select count(*) from public.family_members) as members, "
               "(select count(*) from auth.users) as accounts, "
               "(select coalesce(string_agg(name, ', ' order by name), '') from private.app_migrations) as migrations",
               read_only=True)
    return rows[0] if rows else {}
