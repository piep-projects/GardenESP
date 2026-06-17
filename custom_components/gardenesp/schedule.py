"""Pure schedule maths — FDS §4.4 / §5.6a (FR-A4).

Computes the next run datetime for a line's schedule entries. **No Home Assistant
imports** so it is unit-testable standalone. The actual firing (and DST handling
at fire time) is done by the coordinator via ``async_track_point_in_time``; here
we only compute the next matching wall-clock datetime.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Iterable, Protocol

# Monday .. Sunday — matches datetime.weekday() index.
WEEKDAY_KEYS: tuple[str, ...] = ("mo", "tu", "we", "th", "fr", "sa", "su")


class _ScheduleLike(Protocol):
    repeat: str
    time: str
    duration_min: int
    weekdays: list[str]
    monthdays: list[int]
    enabled: bool


def parse_hhmm(value: str) -> tuple[int, int]:
    """Parse ``"HH:MM"`` into ``(hour, minute)``."""
    hour, minute = value.split(":")
    return int(hour), int(minute)


def _day_matches(
    repeat: str, weekdays: Iterable[str], monthdays: Iterable[int], day
) -> bool:
    if repeat == "daily":
        return True
    if repeat == "weekly":
        return WEEKDAY_KEYS[day.weekday()] in weekdays
    if repeat == "monthly":
        return day.day in monthdays
    return False


def next_occurrence(
    repeat: str,
    times: Iterable[str],
    weekdays: Iterable[str] | None,
    monthdays: Iterable[int] | None,
    now: datetime,
    *,
    horizon_days: int = 366,
) -> datetime | None:
    """Next datetime strictly after ``now`` matching one entry, or ``None``."""
    parsed = sorted({parse_hhmm(t) for t in times})
    if not parsed:
        return None
    weekdays = tuple(weekdays or ())
    monthdays = tuple(monthdays or ())
    for offset in range(horizon_days + 1):
        day = (now + timedelta(days=offset)).date()
        if not _day_matches(repeat, weekdays, monthdays, day):
            continue
        for hour, minute in parsed:
            cand = now.replace(
                year=day.year,
                month=day.month,
                day=day.day,
                hour=hour,
                minute=minute,
                second=0,
                microsecond=0,
            )
            if cand > now:
                return cand
    return None


def next_run_for_schedule(
    entries: Iterable[_ScheduleLike], now: datetime
) -> tuple[datetime, int] | None:
    """Earliest next run across all entries as ``(datetime, duration_min)``.

    Each entry carries its own start ``time`` and ``duration_min``; the returned
    duration is that of the entry that fires first."""
    best: tuple[datetime, int] | None = None
    for e in entries:
        if not getattr(e, "enabled", True):
            continue  # disabled entries are kept but never fire (FR-S2a)
        nxt = next_occurrence(
            e.repeat,
            [e.time] if getattr(e, "time", "") else [],
            getattr(e, "weekdays", None),
            getattr(e, "monthdays", None),
            now,
        )
        if nxt is not None and (best is None or nxt < best[0]):
            best = (nxt, int(getattr(e, "duration_min", 0) or 0))
    return best
