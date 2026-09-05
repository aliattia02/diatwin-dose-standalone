"""
watch_hr_autosegment.py — Swim-Lane HR Auto-Segmentation
===========================================================================
Converts a continuous all-day HR stream (e.g. from a smartwatch) into
discrete activity session records, using absolute BPM thresholds instead of
the per-session HR-reserve fraction used by the ODE model's intensity
classifier.

SWIM-LANE LOGIC
───────────────
  HR < hr_sedentary_max bpm               → SEDENTARY   (truly resting/sleeping)
  hr_sedentary_max ≤ HR < 100 bpm         → LIGHT session  (brisk walk, standing)
  100 ≤ HR ≤ 140 bpm                      → MODERATE session
  HR > 140 bpm                            → VIGOROUS session

  Default thresholds:
    hr_sedentary_max  =  50   (below resting: no session created)
    hr_moderate_low   = 100   (boundary between LIGHT and MODERATE)
    hr_moderate_high  = 140   (boundary between MODERATE and VIGOROUS)

HOUR-BOUNDARY SPLITTING
────────────────────────
  Active sessions are capped at max_session_minutes (default 15 min).
  When a session reaches the next full 15-min boundary it is closed and
  a new session of the same intensity opens at that boundary — so sessions
  always align to the clock (07:00, 08:00, 09:00 …).

  Example: activity from 07:42 → 10:15
    Session 1  07:42 → 08:00  (18 min, intensity X)
    Session 2  08:00 → 08:15  (15 min, intensity X)
    Session 3  08:15 → 08:30  (15 min, intensity X)
    Session 4  10:00 → 10:15  (15 min, intensity X)

  If intensity transitions (LIGHT ↔ MODERATE ↔ VIGOROUS) also occur, each
  transition additionally splits at the debounce boundary as before — the
  two splitting rules are independent and both applied.

DEBOUNCE RULES (prevents noise and transient spikes triggering sessions)
────────────────────────────────────────────────────────────────────────
  DEBOUNCE_START    (default 6)
      Must see 6+ consecutive readings above hr_sedentary_max before a
      session starts.  Session start time = first reading of that debounce
      window, so no real exercise time is lost.

  DEBOUNCE_END      (default 6)
      Must see 6+ consecutive readings below hr_sedentary_max before a
      session ends.  End time = first reading of the end-debounce window.

  DEBOUNCE_TRANSIT  (default 6)
      Must see 6+ consecutive readings in the new zone before switching
      intensity (LIGHT ↔ MODERATE ↔ VIGOROUS) within an active session.

WHY THIS IS SEPARATE FROM THE ODE CLASSIFIER
────────────────────────────────────────────
  The ODE model in activity_pharmacodynamics.py uses a relative HR-reserve
  fraction to classify intensity (0-50% = light, 50-70% = moderate,
  70-100% = vigorous).  That classification happens at SESSION level after
  all samples are collected.

  This module classifies at STREAM level using ABSOLUTE thresholds.
  The two are complementary:
    • swim-lane thresholds decide WHEN a session starts/ends/transitions
    • ODE model uses the actual HR trace to compute BG effect magnitude

OUTPUT
──────
  segment_hr_stream() returns a list of NormalisedSession dicts:
  {
    "start_time":       datetime   (session start — first confirmed active sample)
    "end_time":         datetime
    "duration_minutes": float
    "intensity":        "light" | "moderate" | "vigorous"
    "hr_trace":         [{t_min, hr_bpm}]  (per-minute averages, ODE-ready)
    "hr_trace_raw":     [{t_sec, hr_bpm}]  (per-second, vis-ready)
    "hr_base":          float | None   (session min HR — for display/debug only)
    "hr_max":           float | None   (session peak HR — for display/debug only)
    "sample_count":     int
  }

  NOTE: session_to_activity_doc() stores hr_base/hr_max under the keys
  session_hr_min / session_hr_peak in the mongo doc to prevent the ODE reader
  from treating them as patient-level resting/max HR inputs (fix H-2).

  Each dict is ready to be inserted into mongo.db.activities as a
  type="completed" record after enrichment with user_id / bg_direction.

CONFIGURABLE CONSTANTS
───────────────────────
  All thresholds live in SWIM_LANE_CONFIG so they can be overridden per-user
  (e.g. athlete with very low resting HR).

  Key              Default  Description
  ─────────────────────────────────────────────────────────────────────────
  hr_sedentary_max    50    HR below this = truly sedentary, no session.
  hr_moderate_low    100    LIGHT / MODERATE boundary.
  hr_moderate_high   140    MODERATE / VIGOROUS boundary.
  debounce_start       6    Consecutive readings needed to start a session.
  debounce_end         6    Consecutive readings needed to end a session.
  debounce_transit     6    Consecutive readings needed for zone transition.
  min_session_minutes  2.0  Shorter sessions are discarded as artefacts.
  max_session_minutes 15.0  Sessions are split at 15-min boundaries.

Author:  DiaTwin Team
Version: 2.1 (H-2: rename hr_base/hr_max → session_hr_min/session_hr_peak in session_to_activity_doc)
"""

import logging
from datetime import datetime, timedelta
from collections import defaultdict
from typing import List, Optional, Dict, Any

logger = logging.getLogger(__name__)


# ─── Configuration ────────────────────────────────────────────────────────────

SWIM_LANE_CONFIG = {
    # Absolute BPM boundaries for zone classification
    "hr_sedentary_max":    50,    # below this → truly SEDENTARY (sleeping/resting)
    "hr_moderate_low":    100,    # below this (but above sedentary) → LIGHT
    "hr_moderate_high":   140,    # above this → VIGOROUS; within range → MODERATE

    # Debounce counts (number of CONSECUTIVE samples required)
    "debounce_start":       6,    # sedentary → active  (don't start on brief spike)
    "debounce_end":         6,    # active → sedentary  (don't end on brief dip)
    "debounce_transit":     6,    # LIGHT ↔ MODERATE ↔ VIGOROUS

    # Session length guards
    "min_session_minutes":  2.0,  # shorter sessions discarded as noise artefacts
    "max_session_minutes": 15.0,  # hard cap; split at 15-min boundaries
}

# All zones that represent active movement (non-sedentary)
_ACTIVE_ZONES = {"LIGHT", "MODERATE", "VIGOROUS"}

# Intensity label mapping (zone name → stored string)
_ZONE_TO_INTENSITY = {
    "LIGHT":    "light",
    "MODERATE": "moderate",
    "VIGOROUS": "vigorous",
}


# ─── Internal helpers ─────────────────────────────────────────────────────────

def _parse_sample_time(s: dict, base_time: Optional[datetime] = None) -> Optional[datetime]:
    """
    Resolve any timing field to an absolute datetime.
    Priority:  timestamp_iso  >  t_sec (+ base_time)  >  t_min (+ base_time)
    """
    if "timestamp_iso" in s:
        try:
            return datetime.fromisoformat(
                str(s["timestamp_iso"]).replace("Z", "+00:00")
            ).replace(tzinfo=None)
        except ValueError:
            pass

    if base_time is None:
        return None

    if "t_sec" in s:
        return base_time + timedelta(seconds=float(s["t_sec"]))
    if "t_min" in s:
        return base_time + timedelta(seconds=float(s["t_min"]) * 60.0)

    return None


def _classify_zone(hr: float, cfg: dict) -> str:
    """
    Return 'SEDENTARY', 'LIGHT', 'MODERATE', or 'VIGOROUS' for an absolute HR value.

    Zones:
        HR < hr_sedentary_max           → SEDENTARY  (resting / sleep)
        hr_sedentary_max ≤ HR < hr_moderate_low → LIGHT  (walking / standing)
        hr_moderate_low ≤ HR ≤ hr_moderate_high → MODERATE
        HR > hr_moderate_high           → VIGOROUS
    """
    if hr < cfg["hr_sedentary_max"]:
        return "SEDENTARY"
    if hr < cfg["hr_moderate_low"]:
        return "LIGHT"
    if hr <= cfg["hr_moderate_high"]:
        return "MODERATE"
    return "VIGOROUS"


def _next_split_boundary(dt: datetime, interval_minutes: int = 15) -> datetime:
    """
    Return the next split boundary strictly after dt, aligned to
    interval_minutes-multiples within the hour.

    With the default interval_minutes=15 the boundaries are :00, :15, :30, :45.

    Examples (interval=15):
        07:00:00 → 07:15:00
        07:14:59 → 07:15:00
        07:15:00 → 07:30:00   (already on a boundary → advance by one interval)
        07:42:30 → 07:45:00
        07:59:01 → 08:00:00
    """
    total_minutes        = dt.hour * 60 + dt.minute
    current_boundary_min = (total_minutes // interval_minutes) * interval_minutes
    next_boundary_min    = current_boundary_min + interval_minutes
    base = dt.replace(hour=0, minute=0, second=0, microsecond=0)
    return base + timedelta(minutes=next_boundary_min)


# Alias — keep old name so any existing test imports still resolve
_next_full_hour = _next_split_boundary


def _downsample_raw_to_minutes(
    raw: List[Dict[str, float]],
    start_time: datetime,
) -> List[Dict[str, float]]:
    """
    Convert [{ts: datetime, hr: float}] → [{t_min, hr_bpm}] per-minute averages.
    This is the format the ODE pharmacodynamics model expects.
    """
    buckets: Dict[int, list] = defaultdict(list)
    for sample in raw:
        elapsed_sec = (sample["ts"] - start_time).total_seconds()
        if elapsed_sec < 0:
            continue
        bucket = int(elapsed_sec) // 60
        buckets[bucket].append(sample["hr"])

    return [
        {
            "t_min":  round(minute + 0.5, 2),
            "hr_bpm": round(sum(hrs) / len(hrs), 1),
        }
        for minute, hrs in sorted(buckets.items())
    ]


def _build_raw_trace(
    raw: List[Dict[str, float]],
    start_time: datetime,
) -> List[Dict[str, float]]:
    """
    Convert [{ts: datetime, hr: float}] → [{t_sec, hr_bpm}] for visualisation.
    """
    return [
        {
            "t_sec":  round((s["ts"] - start_time).total_seconds(), 1),
            "hr_bpm": round(s["hr"], 1),
        }
        for s in raw
        if (s["ts"] - start_time).total_seconds() >= 0
    ]


def _finalise_session(
    session_samples: List[Dict[str, Any]],
    intensity: str,
    cfg: dict,
    start_override: Optional[datetime] = None,
    end_override:   Optional[datetime] = None,
) -> Optional[Dict[str, Any]]:
    """
    Build the normalised session dict from a list of raw sample dicts.
    Returns None if the session is shorter than min_session_minutes.

    intensity should be the ZONE name (e.g. "LIGHT") — this function converts
    it to the lower-case label stored in the database ("light").
    """
    if not session_samples:
        return None

    start_time = start_override or session_samples[0]["ts"]
    end_time   = end_override   or session_samples[-1]["ts"]
    duration   = (end_time - start_time).total_seconds() / 60.0

    if duration < cfg["min_session_minutes"]:
        logger.debug(
            f"[autosegment] Discarding {intensity} session "
            f"({duration:.1f} min < min {cfg['min_session_minutes']} min)"
        )
        return None

    hr_values = [s["hr"] for s in session_samples]
    hr_base   = min(hr_values) if hr_values else None
    hr_max    = max(hr_values) if hr_values else None

    hr_trace_raw = _build_raw_trace(session_samples, start_time)
    hr_trace     = _downsample_raw_to_minutes(session_samples, start_time)

    # Convert zone name → stored intensity label
    intensity_label = _ZONE_TO_INTENSITY.get(intensity, intensity.lower())

    return {
        "start_time":       start_time,
        "end_time":         end_time,
        "duration_minutes": round(duration, 1),
        "intensity":        intensity_label,
        "hr_trace":         hr_trace,
        "hr_trace_raw":     hr_trace_raw,
        "hr_base":          round(hr_base, 1) if hr_base is not None else None,
        "hr_max":           round(hr_max,  1) if hr_max  is not None else None,
        "sample_count":     len(session_samples),
    }


def _split_at_hour_boundary(
    current_samples:  List[Dict[str, Any]],
    current_intensity: str,
    current_start:    datetime,
    split_time:       datetime,
    cfg:              dict,
) -> tuple:
    """
    Split current_samples at split_time (a 15-min boundary).

    Returns:
        (finished_session_or_None, remaining_samples, new_start_time)

    The finished session covers current_start → split_time.
    remaining_samples are those whose timestamp ≥ split_time, and they
    form the beginning of the next session which starts exactly at split_time.
    """
    pre_samples  = [s for s in current_samples if s["ts"] < split_time]
    post_samples = [s for s in current_samples if s["ts"] >= split_time]

    sess = _finalise_session(
        pre_samples, current_intensity, cfg,
        start_override=current_start, end_override=split_time
    )
    if sess:
        logger.debug(
            f"[autosegment] 15-min boundary split ({current_intensity}) "
            f"{current_start.strftime('%H:%M')} → {split_time.strftime('%H:%M')}  "
            f"({sess['duration_minutes']} min)"
        )

    return sess, post_samples, split_time


# ─── Main public function ─────────────────────────────────────────────────────

def segment_hr_stream(
    samples:         List[Dict[str, Any]],
    base_time:       Optional[datetime] = None,
    config_override: Optional[dict]     = None,
) -> List[Dict[str, Any]]:
    """
    Segment a continuous HR stream into discrete activity sessions using
    swim-lane threshold logic with debouncing and hour-boundary splitting.

    Parameters
    ──────────
    samples
        List of HR sample dicts.  Each sample must have hr_bpm plus ONE of:
          timestamp_iso — ISO-8601 wall-clock time      ← preferred for all-day data
          t_sec         — seconds elapsed since base_time
          t_min         — minutes elapsed since base_time

    base_time
        Required when samples use t_sec / t_min timing.  Ignored for timestamp_iso.

    config_override
        Optional dict to override fields in SWIM_LANE_CONFIG.
        e.g. {"hr_sedentary_max": 40, "max_session_minutes": 30}

    Returns
    ───────
    List of session dicts ready for insertion into mongo.db.activities.
    See module docstring for full schema.

    Debounce + splitting state machine
    ───────────────────────────────────
    States:   SEDENTARY  →  LIGHT  ↔  MODERATE  ↔  VIGOROUS
                         ←

    SEDENTARY:
        Accumulate pending_start.  When len >= debounce_start and all in
        an active zone:
            → start session, state = majority zone of pending samples.
        Any SEDENTARY reading resets pending_start.

    LIGHT / MODERATE / VIGOROUS:
        On each new sample:
          1. Check if current wall time crossed the next full-hour boundary.
             If so → close current session at that boundary, open new session
             of same intensity at that boundary, advance the boundary.
          2. If zone == SEDENTARY → accumulate pending_end.
             When len >= debounce_end → finalise session, state = SEDENTARY.
          3. If zone != state (different active zone) → accumulate pending_transit.
             When len >= debounce_transit → finalise current session at
             transition point, open new session at new zone.
          4. Same zone → clear debounce buffers, stay in current session.
    """
    cfg = {**SWIM_LANE_CONFIG, **(config_override or {})}

    # ── 1. Normalise samples → [{ts: datetime, hr: float}] ────────────────────
    normalised = []
    for raw in samples:
        hr = raw.get("hr_bpm")
        if hr is None:
            continue
        hr = float(hr)
        if hr < 20 or hr > 300:
            continue
        ts = _parse_sample_time(raw, base_time)
        if ts is None:
            logger.debug("[autosegment] Skipping sample with no parseable time")
            continue
        normalised.append({"ts": ts, "hr": hr})

    # Sort by timestamp to handle out-of-order batches
    normalised.sort(key=lambda s: s["ts"])

    if not normalised:
        logger.warning("[autosegment] No valid samples provided")
        return []

    # ── 2. State machine ───────────────────────────────────────────────────────
    state             = "SEDENTARY"
    pending_start     = []   # debounce buffer for sedentary→active
    pending_end       = []   # debounce buffer for active→sedentary
    pending_transit   = []   # debounce buffer for zone transitions
    current_samples   = []   # all samples for the current open session
    current_start     = None # confirmed start time of current session
    current_intensity = None # zone name of current session ("LIGHT", "MODERATE", …)
    next_hour_split   = None # next 15-min split boundary

    sessions: List[Dict[str, Any]] = []

    def _open_session(zone: str, start: datetime, initial_samples: list):
        """Initialise state variables for a freshly opened session."""
        nonlocal state, current_start, current_intensity, current_samples
        nonlocal next_hour_split, pending_start, pending_end, pending_transit
        state             = zone
        current_start     = start
        current_intensity = zone
        current_samples   = list(initial_samples)
        next_hour_split   = _next_full_hour(start)
        pending_start     = []
        pending_end       = []
        pending_transit   = []
        logger.debug(
            f"[autosegment] Session opened ({zone}) at {start.strftime('%H:%M:%S')}  "
            f"→ next hour split at {next_hour_split.strftime('%H:%M')}"
        )

    def _close_session(
        zone: str,
        start: datetime,
        samples: list,
        end: Optional[datetime] = None,
        label: str = "ended",
    ):
        """Finalise and append a session; return it (or None if too short)."""
        sess = _finalise_session(samples, zone, cfg, start_override=start, end_override=end)
        if sess:
            sessions.append(sess)
            logger.debug(
                f"[autosegment] Session {label} ({zone})  "
                f"{start.strftime('%H:%M')} → "
                f"{(end or (samples[-1]['ts'] if samples else start)).strftime('%H:%M')}  "
                f"({sess['duration_minutes']} min)"
            )
        return sess

    for sample in normalised:
        hr   = sample["hr"]
        ts   = sample["ts"]
        zone = _classify_zone(hr, cfg)

        # ── SEDENTARY state ───────────────────────────────────────────────────
        if state == "SEDENTARY":
            if zone in _ACTIVE_ZONES:
                pending_start.append(sample)
                if len(pending_start) >= cfg["debounce_start"]:
                    # Majority vote for starting intensity
                    zone_counts = defaultdict(int)
                    for p in pending_start:
                        zone_counts[_classify_zone(p["hr"], cfg)] += 1
                    start_zone = max(zone_counts, key=zone_counts.get)
                    _open_session(start_zone, pending_start[0]["ts"], pending_start)
            else:
                # SEDENTARY reading resets the start debounce
                if pending_start:
                    pending_start = []

        # ── Active state (LIGHT / MODERATE / VIGOROUS) ────────────────────────
        else:
            # ── A. Hour-boundary split check ──────────────────────────────────
            #    Apply BEFORE adding this sample so the boundary is respected
            #    even if the exact boundary timestamp has no sample.
            while next_hour_split and ts >= next_hour_split:
                sess, remaining, new_start = _split_at_hour_boundary(
                    current_samples, current_intensity,
                    current_start, next_hour_split, cfg
                )
                if sess:
                    sessions.append(sess)

                # Open continuation session at the exact hour boundary
                current_start    = new_start
                current_samples  = remaining
                next_hour_split  = _next_full_hour(new_start)
                # debounce buffers are irrelevant across a time split — clear them
                pending_end      = []
                pending_transit  = []

            # Add the current sample to the ongoing session
            current_samples.append(sample)

            # ── B. End-debounce (SEDENTARY reading) ───────────────────────────
            if zone == "SEDENTARY":
                pending_end.append(sample)
                pending_transit = []  # can't transit while heading to sedentary

                if len(pending_end) >= cfg["debounce_end"]:
                    # End the session — use the FIRST end-debounce sample as end time
                    end_ts = pending_end[0]["ts"]
                    # Strip the pending_end tail from current_samples
                    try:
                        tail_start_idx = current_samples.index(pending_end[0])
                    except ValueError:
                        tail_start_idx = max(0, len(current_samples) - len(pending_end))
                    active_samples = current_samples[:tail_start_idx]

                    _close_session(
                        current_intensity, current_start, active_samples,
                        end=end_ts, label="ended"
                    )

                    state             = "SEDENTARY"
                    current_samples   = []
                    current_start     = None
                    current_intensity = None
                    next_hour_split   = None
                    pending_start     = []
                    pending_end       = []
                    pending_transit   = []

            # ── C. Transit-debounce (zone change within active states) ─────────
            elif zone != state:
                pending_end = []  # not going sedentary — reset end debounce
                pending_transit.append(sample)

                if len(pending_transit) >= cfg["debounce_transit"]:
                    # Confirmed intensity transition
                    split_ts = pending_transit[0]["ts"]

                    try:
                        split_idx = current_samples.index(pending_transit[0])
                    except ValueError:
                        split_idx = max(0, len(current_samples) - len(pending_transit))

                    pre_samples  = current_samples[:split_idx]
                    post_samples = list(pending_transit)

                    _close_session(
                        current_intensity, current_start, pre_samples,
                        end=split_ts, label=f"→{zone} transition"
                    )

                    # Open new session at transition point (not necessarily an hour boundary)
                    _open_session(zone, split_ts, post_samples)

            # ── D. Same zone → stay in session, clear transit buffers ──────────
            else:
                pending_end     = []
                pending_transit = []

    # ── Close any session still open at end of stream ─────────────────────────
    if current_samples and current_intensity:
        _close_session(
            current_intensity, current_start, current_samples,
            label="stream-end close"
        )

    logger.info(
        f"[autosegment] Segmented {len(normalised)} samples → "
        f"{len(sessions)} sessions "
        f"({sum(1 for s in sessions if s['intensity'] == 'light')} light, "
        f"{sum(1 for s in sessions if s['intensity'] == 'moderate')} moderate, "
        f"{sum(1 for s in sessions if s['intensity'] == 'vigorous')} vigorous)"
    )
    return sessions


# ─── Convenience: build mongo doc from session dict ───────────────────────────

def session_to_activity_doc(
    session:      Dict[str, Any],
    user_id:      str,
    bg_direction: int = -1,
) -> Dict[str, Any]:
    """
    Convert a segment_hr_stream() result dict into a mongo.db.activities
    document ready for insert_one().  Schema-identical to watch_hr_routes.py
    completed records.

    Supports all three intensity labels: "light", "moderate", "vigorous".
    Level mapping:  light=0, moderate=1, vigorous=2
    """
    start  = session["start_time"]
    end    = session["end_time"]
    dur    = session["duration_minutes"]
    hours  = int(dur // 60)
    mins   = int(dur % 60)

    intensity = session["intensity"]
    level_map = {"light": 0, "moderate": 1, "vigorous": 2}

    doc = {
        "user_id":          user_id,
        "timestamp":        start,
        "startTime":        start,
        "endTime":          end,
        "completedTime":    end,
        "type":             "completed",
        "source":           "watch_continuous",
        "duration_minutes": dur,
        "duration":         f"{hours:02d}:{mins:02d}",
        "intensity":        intensity,
        "hr_trace":         session["hr_trace"],
        "hr_trace_raw":     session["hr_trace_raw"],
        "bg_direction":     bg_direction,
        "level":            level_map.get(intensity, 1),
        "impact":           1.0,
    }
    # H-2 FIX: store session HR stats under display-only keys.
    # The ODE reader (_get_trace_from_activity / normalize_activity_record) resolves
    # patient resting/max HR via activity.get("hr_base") / activity.get("hr_max").
    # The values computed here are min/max of THIS session's HR samples — NOT the
    # patient's true resting HR — so we must NOT write them under "hr_base"/"hr_max".
    # Without this rename, the ODE used, e.g., 62 bpm (lowest HR during a run) as
    # the resting-HR baseline, corrupting the HR-reserve fraction and
    # systematically underestimating exercise intensity.
    if session.get("hr_base") is not None:
        doc["session_hr_min"]  = session["hr_base"]   # display / debugging only
    if session.get("hr_max") is not None:
        doc["session_hr_peak"] = session["hr_max"]    # display / debugging only

    return doc