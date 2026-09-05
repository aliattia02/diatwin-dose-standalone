"""
The canonical time grid.

Every model — supervised or RL — consumes state sampled on one fixed axis.
Choosing that axis once, here, is what makes runs comparable across
experiments and what stops "which timestamp did this feature use?" from
becoming an unanswerable question six months in.

The step is 5 minutes because that is the LibreLinkUp sampling interval; a
finer grid would interpolate noise, a coarser one would discard real
excursions. Grid points are aligned to absolute UTC epoch multiples, not to
the first reading, so two patients' grids line up and a re-run over a longer
window reproduces the earlier window's points exactly.

Stdlib only.
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, List, Optional, Sequence, TypeVar

#: The sampling interval for all state and all targets.
STEP = timedelta(minutes=5)

#: Beyond this gap, a CGM stream is considered interrupted and points are
#: emitted as missing rather than interpolated. Twenty minutes is four
#: missed samples — long enough to be a real dropout, short enough that a
#: single dropped packet does not punch a hole in the dataset.
MAX_INTERPOLATION_GAP = timedelta(minutes=20)

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

T = TypeVar("T")


def floor_to_grid(t: datetime, step: timedelta = STEP) -> datetime:
    """Largest grid point ``<= t``, aligned to the UTC epoch."""
    if t.tzinfo is None:
        raise ValueError("floor_to_grid requires an aware datetime")
    t = t.astimezone(timezone.utc)
    elapsed = (t - _EPOCH) // step
    return _EPOCH + elapsed * step


def ceil_to_grid(t: datetime, step: timedelta = STEP) -> datetime:
    """Smallest grid point ``>= t``."""
    floored = floor_to_grid(t, step)
    return floored if floored == t else floored + step


def grid_range(start: datetime, end: datetime, step: timedelta = STEP) -> List[datetime]:
    """Every grid point in ``[start, end]``, inclusive of both ends when aligned."""
    if end < start:
        return []
    current, points = ceil_to_grid(start, step), []
    while current <= end:
        points.append(current)
        current += step
    return points


@dataclass(frozen=True)
class GridSeries:
    """
    A value sampled on the grid, with explicit missingness.

    ``values[i]`` is None where no observation supports that grid point.
    Missingness is carried rather than filled because "the sensor was off"
    and "glucose was 100" are different facts, and a model that cannot tell
    them apart will learn to predict the mean during dropouts.
    """

    times: List[datetime]
    values: List[Optional[float]]

    def __len__(self) -> int:
        return len(self.times)

    @property
    def coverage(self) -> float:
        """Fraction of grid points backed by an observation."""
        if not self.values:
            return 0.0
        return sum(v is not None for v in self.values) / len(self.values)

    def longest_gap(self) -> timedelta:
        """Longest run of missing points, as a duration."""
        longest = run = 0
        for value in self.values:
            run = run + 1 if value is None else 0
            longest = max(longest, run)
        return longest * STEP

    def lag(self, steps: int) -> List[Optional[float]]:
        """
        Values shifted ``steps`` grid points into the past.

        ``series.lag(1)[i]`` is the value 5 minutes before ``times[i]``.
        Positions with no history are None, never zero-filled — a lag of
        zero at the start of a series is a fabricated observation.
        """
        if steps <= 0:
            return list(self.values)
        return [None] * steps + self.values[:-steps]

    def lead(self, steps: int) -> List[Optional[float]]:
        """Values shifted ``steps`` grid points into the future — the target column."""
        if steps <= 0:
            return list(self.values)
        return self.values[steps:] + [None] * steps


def resample(
    times: Sequence[datetime],
    values: Sequence[float],
    grid: Sequence[datetime],
    *,
    max_gap: timedelta = MAX_INTERPOLATION_GAP,
) -> GridSeries:
    """
    Project an irregular series onto ``grid`` by linear interpolation.

    A grid point is filled only when it sits between two observations no
    further apart than ``max_gap``; otherwise it is left missing. Points
    outside the observed span are never extrapolated.

    Both inputs must be sorted by time and the same length.
    """
    if len(times) != len(values):
        raise ValueError(f"times/values length mismatch: {len(times)} vs {len(values)}")

    out: List[Optional[float]] = []
    if not times:
        return GridSeries(times=list(grid), values=[None] * len(grid))

    for point in grid:
        idx = bisect.bisect_left(times, point)

        if idx < len(times) and times[idx] == point:
            out.append(float(values[idx]))
            continue

        if idx == 0 or idx == len(times):
            out.append(None)          # before the first / after the last observation
            continue

        left_t, right_t = times[idx - 1], times[idx]
        if right_t - left_t > max_gap:
            out.append(None)          # dropout — do not invent a value across it
            continue

        span = (right_t - left_t).total_seconds()
        weight = (point - left_t).total_seconds() / span if span else 0.0
        out.append(float(values[idx - 1]) + weight * (float(values[idx]) - float(values[idx - 1])))

    return GridSeries(times=list(grid), values=out)


def accumulate(
    events: Sequence[T],
    grid: Sequence[datetime],
    *,
    time_of: Callable[[T], datetime],
    amount_of: Callable[[T], float],
) -> List[float]:
    """
    Total event amount falling in each grid bucket ``(t - STEP, t]``.

    Used for the "carbs eaten in this interval" and "units delivered in this
    interval" columns. Unlike :func:`resample` there is no missingness: no
    event genuinely means zero.
    """
    totals = [0.0] * len(grid)
    if not grid:
        return totals

    event_times = [time_of(e) for e in events]
    order = sorted(range(len(events)), key=lambda i: event_times[i])
    sorted_times = [event_times[i] for i in order]

    for slot, point in enumerate(grid):
        lo = bisect.bisect_right(sorted_times, point - STEP)
        hi = bisect.bisect_right(sorted_times, point)
        for j in range(lo, hi):
            totals[slot] += amount_of(events[order[j]])

    return totals


def build_grid(
    start: datetime,
    end: datetime,
    *,
    step: timedelta = STEP,
) -> List[datetime]:
    """Convenience wrapper naming the intent at call sites."""
    return grid_range(start, end, step)
