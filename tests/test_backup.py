"""Backup and restore, against temporary folders (never iCloud)."""

import sqlite3
import time

import pytest

from family_specials import db
from family_specials.backup import BackupError, backups, prune, restore, run_backup


def _setup(tmp_path):
    database = tmp_path / "live" / "specials.db"
    conn = db.connect(database)
    conn.execute("INSERT INTO retailer_products(chain, retailer_product_id, name, first_seen_at, last_seen_at) "
                 "VALUES ('aldi', '1', 'Milk 2L', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')")
    conn.commit()
    private = tmp_path / "live" / "private"
    private.mkdir()
    (private / "family_regular_items.csv").write_text("watch_item,tier\nMilk,Core\n")
    (private / ".env").write_text("SECRET=1\n")
    (private / "github_token.txt").write_text("ghp_x\n")
    return conn, database, private


def test_backup_copies_database_and_private_files_but_never_secrets(tmp_path):
    conn, database, private = _setup(tmp_path)  # conn stays open: backup must work on a live database
    root = tmp_path / "backups"
    r = run_backup(database, private, root=root)
    assert r.folder.parent == root and r.private_files == 1
    files = sorted(p.relative_to(r.folder).as_posix() for p in r.folder.rglob("*") if p.is_file())
    assert files == ["manifest.json", "private/family_regular_items.csv", "specials.db.xz"]
    assert not list(root.glob("*.partial"))


def test_restore_round_trip_keeps_existing_files_aside(tmp_path):
    conn, database, private = _setup(tmp_path)
    root = tmp_path / "backups"
    r = run_backup(database, private, root=root)
    target = tmp_path / "restored"
    target.mkdir()
    (target / "specials.db").write_text("old")
    out = restore(r.folder, target)
    assert out["counts"]["retailer_products"] == 1 and out["private"] == ["family_regular_items.csv"]
    assert sqlite3.connect(target / "specials.db").execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert list(target.glob("specials.db.before-restore-*"))  # the old file was kept, not overwritten


def test_keeps_only_the_newest_copies(tmp_path):
    conn, database, private = _setup(tmp_path)
    root = tmp_path / "backups"
    for name in ["2026-09-01_0800", "2026-09-08_0800", "2026-09-15_0800", "not-a-backup"]:
        (root / name).mkdir(parents=True)
    prune(root, keep=2)
    assert [p.name for p in backups(root)] == ["2026-09-15_0800", "2026-09-08_0800"]
    assert (root / "not-a-backup").exists()  # never touches folders it didn't create


def test_damaged_backup_is_refused(tmp_path):
    conn, database, private = _setup(tmp_path)
    r = run_backup(database, private, root=tmp_path / "backups")
    with (r.folder / "specials.db.xz").open("ab") as f:
        f.write(b"corrupt")
    with pytest.raises(BackupError):
        restore(r.folder, tmp_path / "restored")


def test_refuses_a_backup_folder_inside_the_project(tmp_path):
    from family_specials import config

    conn, database, private = _setup(tmp_path)
    with pytest.raises(BackupError):
        run_backup(database, private, root=config.PROJECT_ROOT / "data" / "backups")
