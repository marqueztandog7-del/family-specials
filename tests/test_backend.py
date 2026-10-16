import json
import re

import pytest

from family_specials import backend, config


def test_picks_the_family_specials_project_or_asks():
    projects = [{"name": "other", "ref": "aaa"}, {"name": "family-specials", "ref": "bbb"}]
    assert backend.pick_project(projects, None)["ref"] == "bbb"
    assert backend.pick_project(projects, "aaa")["ref"] == "aaa"
    with pytest.raises(backend.BackendError):
        backend.pick_project([{"name": "one", "ref": "x"}, {"name": "two", "ref": "y"}], None)


def test_prefers_new_style_keys_and_falls_back_to_legacy():
    new = [{"type": "legacy", "name": "anon", "api_key": "old-anon"}, {"type": "publishable", "name": "default", "api_key": "sb_publishable_1"},
           {"type": "secret", "name": "default", "api_key": "sb_secret_1"}, {"type": "legacy", "name": "service_role", "api_key": "old-sr"}]
    assert backend.pick_keys(new) == ("sb_publishable_1", "sb_secret_1")
    legacy = [{"type": "legacy", "name": "anon", "api_key": "a"}, {"type": "legacy", "name": "service_role", "api_key": "s"}]
    assert backend.pick_keys(legacy) == ("a", "s")
    with pytest.raises(backend.BackendError):
        backend.pick_keys([{"type": "publishable", "name": "default", "api_key": "p"}])


def test_refuses_something_that_isnt_an_access_token():
    with pytest.raises(backend.BackendError):
        backend.connect("not-a-token")


def test_migrations_run_in_number_order():
    names = [f.name for f in backend.migration_files()]
    assert names == sorted(names) and names[0] == "001_families.sql"


def test_app_config_has_only_the_address_and_public_key(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://abc.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_x")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_never")
    out = tmp_path / "app-config.json"
    assert backend.write_app_config(out)
    data = json.loads(out.read_text())
    assert data == {"supabaseUrl": "https://abc.supabase.co", "supabaseKey": "sb_publishable_x"}
    assert "secret" not in out.read_text()


def test_set_env_replaces_one_line_and_is_private(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("CW_ALGOLIA_SEARCH_KEY=keep\nSUPABASE_URL=old\n")
    config.set_env("SUPABASE_URL", "new", env)
    assert env.read_text() == "CW_ALGOLIA_SEARCH_KEY=keep\nSUPABASE_URL=new\n"
    assert env.stat().st_mode & 0o077 == 0


def test_invite_codes_never_use_look_alikes():
    sql = (backend.MIGRATIONS / "001_families.sql").read_text()
    alphabet = re.search(r"alphabet constant text := '([^']+)'", sql).group(1)
    assert len(alphabet) == 31 and not set("01OIL") & set(alphabet)
    # The table's check matches the generator's alphabet exactly.
    check = re.search(r"code ~ '\^\[([^\]]+)\]\{6\}\$'", sql).group(1)
    expanded = re.sub(r"(.)-(.)", lambda m: "".join(chr(c) for c in range(ord(m[1]), ord(m[2]) + 1)), check)
    assert set(expanded) == set(alphabet)
    assert "248" in sql   # every character equally likely (8 x 31 = 248)


def test_connect_saves_keys_privately_and_sets_up_the_project(tmp_path, monkeypatch):
    """The whole connect flow against a pretend Supabase: nothing is printed or written outside .env and secrets."""
    env = tmp_path / ".env"
    calls, secrets = [], {}
    responses = {
        ("GET", "/v1/projects"): [{"name": "family-specials", "ref": "abcref", "region": "ap-southeast-2"}],
        ("GET", "/v1/projects/abcref/api-keys"): [{"type": "publishable", "name": "default", "api_key": "sb_publishable_t"},
                                                   {"type": "secret", "name": "default", "api_key": "sb_secret_t"}],
    }

    def fake_api(method, path, token, **kw):
        calls.append((method, path, kw.get("json")))
        if path.endswith("/database/query"):
            return [] if "select name" in kw["json"]["query"] else None
        return responses.get((method, path))

    real_set_env = config.set_env
    monkeypatch.setattr(backend, "_api", fake_api)
    monkeypatch.setattr(config, "set_env", lambda name, value, path=None: real_set_env(name, value, env))
    monkeypatch.setattr(config, "set_github_secret", lambda name, value: secrets.__setitem__(name, value))
    for name in ("SUPABASE_ACCESS_TOKEN", "SUPABASE_PROJECT_REF", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"):
        monkeypatch.delenv(name, raising=False)
    out_config = tmp_path / "app-config.json"
    monkeypatch.setattr(backend, "APP_CONFIG", out_config)

    out = backend.connect("  sbp_faketoken123\n")
    assert out == {"name": "family-specials", "region": "ap-southeast-2", "applied": [f.name for f in backend.migration_files()]}
    text = env.read_text()
    assert "SUPABASE_ACCESS_TOKEN=sbp_faketoken123\n" in text and "SUPABASE_SECRET_KEY=sb_secret_t" in text
    assert env.stat().st_mode & 0o077 == 0
    assert json.loads(out_config.read_text()) == {"supabaseUrl": "https://abcref.supabase.co", "supabaseKey": "sb_publishable_t"}
    assert secrets == {"SUPABASE_URL": "https://abcref.supabase.co", "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_t",
                       "SUPABASE_SECRET_KEY": "sb_secret_t"}
    auth = next(j for m, p, j in calls if m == "PATCH")
    assert auth["mailer_autoconfirm"] is True and auth["password_min_length"] == 8
    migrations = [j["query"] for m, p, j in calls if p.endswith("/database/query") and j["query"].startswith("begin;")]
    assert len(migrations) == len(backend.migration_files()) and all(q.rstrip().endswith("commit;") for q in migrations)
