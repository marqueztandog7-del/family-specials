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
        sql(f"begin;\n{body}\ninsert into private.app_migrations (name) values ('{name}');\ncommit;")
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


def status() -> dict[str, Any]:
    """Counts only: never names, nicknames or emails."""
    rows = sql("select (select count(*) from public.families) as families, "
               "(select count(*) from public.family_members) as members, "
               "(select count(*) from auth.users) as accounts, "
               "(select coalesce(string_agg(name, ', ' order by name), '') from private.app_migrations) as migrations",
               read_only=True)
    return rows[0] if rows else {}
