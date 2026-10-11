"""Time helpers. Everything is stored in UTC; specials cycles follow Sydney time."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

SYDNEY = ZoneInfo("Australia/Sydney")


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def now_iso() -> str:
    return iso(now_utc())


def sydney_today(at: datetime | None = None) -> date:
    return (at or now_utc()).astimezone(SYDNEY).date()


def sydney_midnight(d: date) -> datetime:
    return datetime.combine(d, time(0, 0), tzinfo=SYDNEY)


def sydney_end_of_day(d: date) -> datetime:
    return datetime.combine(d, time(23, 59, 59), tzinfo=SYDNEY)


def weekly_cycle(start_weekday: int, at: datetime | None = None) -> tuple[datetime, datetime]:
    """Current weekly cycle that starts on `start_weekday` (Mon=0 .. Sun=6) in Sydney time.

    Woolworths and Coles weekly specials run Wednesday to Tuesday: weekly_cycle(2).
    """
    today = sydney_today(at)
    start = today - timedelta(days=(today.weekday() - start_weekday) % 7)
    return sydney_midnight(start), sydney_end_of_day(start + timedelta(days=6))


def most_recent_weekday(weekdays: list[int], at: datetime | None = None) -> datetime:
    """Midnight (Sydney) of the most recent day that falls on one of `weekdays`, today included."""
    today = sydney_today(at)
    for back in range(7):
        d = today - timedelta(days=back)
        if d.weekday() in weekdays:
            return sydney_midnight(d)
    raise ValueError("weekdays must not be empty")
