"""A store paused for good is never contacted, and the trial check works across time zones."""

import pytest

from family_specials import config, db
from family_specials.runner import PausedForGood, is_paused_for_good, make_client, run_chain


def test_coles_is_paused_for_good_and_never_contacted(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    assert is_paused_for_good(conn, "coles")
    assert is_paused_for_good(None, "coles")  # even without a database (config flag)
    with pytest.raises(PausedForGood):
        make_client("coles")
    with pytest.raises(PausedForGood):
        run_chain(conn, "coles", "specials")
    assert conn.execute("SELECT COUNT(*) FROM collection_runs").fetchone()[0] == 0


def test_trial_block_counts_in_sydney_time(tmp_path, monkeypatch):
    # 9:49am Sydney on 16 Oct is 22:49 UTC on 15 Oct: it must still count as during the trial.
    cfg = {**config.chain_config("coles")}
    cfg.pop("paused_for_good")
    monkeypatch.setattr(config, "chain_config", lambda chain: cfg)
    conn = db.connect(tmp_path / "t.db")
    assert not is_paused_for_good(conn, "coles")
    conn.execute("INSERT INTO collection_runs(chain, kind, started_at, status) "
                 "VALUES ('coles', 'specials', '2026-10-15T22:46:03Z', 'blocked')")
    assert is_paused_for_good(conn, "coles")
