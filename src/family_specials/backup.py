"""Weekly backup of what only lives on this Mac: the price database and data/private.

- Copies the database with SQLite's own backup method (safe while it's in use), checks the copy
  passes PRAGMA integrity_check, then compresses it (xz).
- Copies data/private as it is. Never copies .env files, tokens or anything starting with a dot.
- Writes to iCloud Drive/family-specials-backups/<YYYY-MM-DD_HHMM>/, first as a ".partial" folder
  that's renamed only once everything is written and verified.
- Checks iCloud has room first, and never fills it: it fails (with a Mac notification) instead.
- Keeps the newest 8 backups and deletes older ones (only folders it created).
"""

from __future__ import annotations

import hashlib
import json
import lzma
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from . import config
from .timeutil import SYDNEY, iso, now_utc, weekly_cycle

ICLOUD = Path.home() / "Library" / "Mobile Documents" / "com~apple~CloudDocs"
BACKUP_DIR = ICLOUD / "family-specials-backups"
KEEP = 8
FOLDER_RE = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{4}$")
SAFETY_MARGIN = 50 * 1024 * 1024   # always leave at least 50 MB free in iCloud
NEVER_COPY = re.compile(r"(^\.|\.env$|token|secret|password|\.key$|\.pem$)", re.I)


class BackupError(Exception):
    pass


@dataclass
class BackupResult:
    folder: Path
    db_bytes: int
    compressed_bytes: int
    private_files: int
    deleted: list[str]


# --------------------------------------------------------------------------- backup


def backups(root: Path = BACKUP_DIR) -> list[Path]:
    """Completed backups, newest first."""
    if not root.exists():
        return []
    return sorted((p for p in root.iterdir() if p.is_dir() and FOLDER_RE.match(p.name)), reverse=True)


def is_due(root: Path = BACKUP_DIR, at: datetime | None = None) -> bool:
    """Weekly, after the Wednesday update: due if there's no backup since this week's Wednesday (Sydney)."""
    existing = backups(root)
    if not existing:
        return True
    last = datetime.strptime(existing[0].name, "%Y-%m-%d_%H%M").replace(tzinfo=SYDNEY)
    return last < weekly_cycle(2, at)[0]


def run_backup(db_path: Path | None = None, private_dir: Path | None = None, root: Path = BACKUP_DIR,
               keep: int = KEEP) -> BackupResult:
    db_path = Path(db_path or config.DB_PATH)
    private_dir = Path(private_dir or config.DATA_DIR / "private")
    _check_destination(root)
    if not db_path.exists():
        raise BackupError(f"Database not found: {db_path}")

    stamp = now_utc().astimezone(SYDNEY).strftime("%Y-%m-%d_%H%M")
    with tempfile.TemporaryDirectory(prefix="specials-backup-") as tmp:
        tmp = Path(tmp)
        copy = tmp / "specials.db"
        # SQLite's own backup method: a consistent copy even while the database is being written.
        src = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        dst = sqlite3.connect(copy)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        counts = verify_database(copy)

        packed = tmp / "specials.db.xz"
        with copy.open("rb") as fin, lzma.open(packed, "wb", preset=6) as fout:
            shutil.copyfileobj(fin, fout, 1024 * 1024)

        private_files = [p for p in sorted(private_dir.rglob("*")) if p.is_file()
                         and not any(NEVER_COPY.search(part) for part in p.relative_to(private_dir).parts)]
        needed = packed.stat().st_size + sum(p.stat().st_size for p in private_files)
        # Make room first if we already have `keep` copies, so iCloud never has to hold keep + 1.
        deleted = prune(root, keep - 1) if len(backups(root)) >= keep else []
        _check_space(root, needed)

        root.mkdir(parents=True, exist_ok=True)
        partial = root / f"{stamp}.partial"
        if partial.exists():
            shutil.rmtree(partial)
        partial.mkdir()
        manifest = {
            "created_at": iso(now_utc()),
            "database": {"file": "specials.db.xz", "bytes": copy.stat().st_size,
                         "compressed_bytes": packed.stat().st_size, "sha256": _sha256(packed),
                         "integrity_check": "ok", "counts": counts},
            "private": [],
            "restore": "uv run specials restore --from <this folder> --to <folder>  (see README)",
        }
        shutil.copy2(packed, partial / "specials.db.xz")
        for p in private_files:
            rel = p.relative_to(private_dir)
            target = partial / "private" / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, target)
            manifest["private"].append({"file": str(rel), "bytes": p.stat().st_size, "sha256": _sha256(p)})
        (partial / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

        # Check what actually landed in iCloud before calling it done.
        if _sha256(partial / "specials.db.xz") != manifest["database"]["sha256"]:
            raise BackupError("The copy in iCloud doesn't match the original (checksum differs)")
        for f in manifest["private"]:
            if _sha256(partial / "private" / f["file"]) != f["sha256"]:
                raise BackupError(f"private/{f['file']} didn't copy correctly")
        final = root / stamp
        if final.exists():
            shutil.rmtree(final)
        partial.rename(final)

    deleted += prune(root, keep)
    return BackupResult(final, manifest["database"]["bytes"], manifest["database"]["compressed_bytes"],
                        len(manifest["private"]), deleted)


def prune(root: Path = BACKUP_DIR, keep: int = KEEP) -> list[str]:
    """Delete backups beyond the newest `keep`, and leftover .partial folders. Only our own folders."""
    deleted = []
    for old in backups(root)[keep:]:
        shutil.rmtree(old)
        deleted.append(old.name)
    for p in root.glob("*.partial"):
        if p.is_dir() and FOLDER_RE.match(p.name.removesuffix(".partial")):
            shutil.rmtree(p)
            deleted.append(p.name)
    return deleted


def verify_database(path: Path) -> dict[str, int]:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        result = conn.execute("PRAGMA integrity_check").fetchone()[0]
        if result != "ok":
            raise BackupError(f"Integrity check failed: {result}")
        return {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                for t in ("retailer_products", "price_observations", "collection_runs")}
    finally:
        conn.close()


# --------------------------------------------------------------------------- restore


def restore(backup_folder: Path, to_dir: Path) -> dict[str, object]:
    """Restore a backup into `to_dir` (specials.db + private/). Existing files there are moved aside
    as *.before-restore-<time>, never overwritten."""
    backup_folder, to_dir = Path(backup_folder), Path(to_dir)
    manifest = json.loads((backup_folder / "manifest.json").read_text(encoding="utf-8"))
    packed = backup_folder / manifest["database"]["file"]
    if _sha256(packed) != manifest["database"]["sha256"]:
        raise BackupError("Backup file is damaged (checksum differs)")
    to_dir.mkdir(parents=True, exist_ok=True)
    stamp = now_utc().strftime("%Y%m%d%H%M%S")
    db_target = to_dir / "specials.db"
    for f in (db_target, to_dir / "specials.db-wal", to_dir / "specials.db-shm"):
        if f.exists():
            f.rename(f.with_name(f.name + f".before-restore-{stamp}"))
    with lzma.open(packed, "rb") as fin, db_target.open("wb") as fout:
        shutil.copyfileobj(fin, fout, 1024 * 1024)
    counts = verify_database(db_target)
    restored = []
    for f in manifest["private"]:
        target = to_dir / "private" / f["file"]
        if target.exists():
            target.rename(target.with_name(target.name + f".before-restore-{stamp}"))
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(backup_folder / "private" / f["file"], target)
        if _sha256(target) != f["sha256"]:
            raise BackupError(f"private/{f['file']} didn't restore correctly")
        restored.append(f["file"])
    return {"database": str(db_target), "counts": counts, "private": restored}


# --------------------------------------------------------------------------- checks and helpers


def _check_destination(root: Path) -> None:
    if not ICLOUD.exists() and root.is_relative_to(ICLOUD):
        raise BackupError("iCloud Drive isn't turned on (no iCloud Drive folder on this Mac)")
    project = config.PROJECT_ROOT.resolve()
    r = root.resolve() if root.exists() else root
    if r.is_relative_to(project) or project.is_relative_to(r):
        raise BackupError("The backup folder must not be inside the project, or contain it")


def icloud_free_bytes() -> int | None:
    """Space left in the iCloud account (from `brctl quota`), or None if it can't be read."""
    try:
        out = subprocess.run(["brctl", "quota"], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = re.search(r"(\d+) bytes of quota remaining", out)
    return int(m.group(1)) if m else None


def _check_space(root: Path, needed: int) -> None:
    free_local = shutil.disk_usage(root if root.exists() else root.parent).free
    if free_local < needed + SAFETY_MARGIN:
        raise BackupError(f"Not enough disk space for the backup ({_mb(needed)} needed)")
    if str(root).startswith(str(ICLOUD)):
        free = icloud_free_bytes()
        if free is None:
            raise BackupError("Couldn't read how much iCloud space is left, so nothing was written")
        if free < needed + SAFETY_MARGIN:
            raise BackupError(f"Not enough iCloud space: {_mb(needed)} needed (plus a 50 MB margin), "
                              f"{_mb(free)} free. Free up space or upgrade iCloud storage.")


def _folder_bytes(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _mb(n: int) -> str:
    return f"{n / 1e6:.0f} MB"


def notify(message: str, title: str = "Family Specials") -> None:
    """Show a Mac notification (best effort)."""
    q = lambda s: json.dumps(s, ensure_ascii=False)  # AppleScript strings use the same quoting
    script = f"display notification {q(message)} with title {q(title)}"
    try:
        subprocess.run(["osascript", "-e", script], timeout=10, capture_output=True)
    except (OSError, subprocess.TimeoutExpired):
        pass
