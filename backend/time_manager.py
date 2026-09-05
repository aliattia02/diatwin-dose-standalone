"""
============================================================================
TIME MANAGER - Python Backend Implementation (v4.3 - Timezone Support)
============================================================================

Centralized utility for ALL time-related operations in the backend.
Mirrors the JavaScript TimeManager.js for consistency.

KEY FEATURES:
- Timestamp normalization (millisecond, second, minute boundaries)
- Precision-aware time calculations
- UTC timezone handling
- Duration calculations
- 🆕 v4.3 - Timezone offset support for patient-specific daily reset
- User-configurable daily reset hour
- Consistent with frontend TimeManager.js

USAGE GUIDELINES:
1. ALWAYS use TimeManager for time operations
2. Use normalized timestamps for consistency
3. Store times in UTC (timezone-naive datetime objects)
4. Use second precision for pharmacodynamic calculations
5. Use minute boundary for user-facing timestamps
6. 🆕 Pass timezone_offset_minutes from patient_constants for reset calculations

VERSION HISTORY:
v4.3 - 🔧 TIMEZONE FIX: Added timezone_offset_minutes parameter for FE/BE alignment
v4.0 - Added user-configurable daily reset hour support
v3.1 - Backend Implementation - 7 AM Reset Alignment
v3.0 - Initial TimeManager implementation

Author: DiaTwin Team
Version: 4.3 (Timezone Alignment Fix)
============================================================================
"""

import calendar
from datetime import datetime, timedelta
from typing import Union, Optional, Literal
import logging

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# SIGN CONVENTION — timezone_offset_minutes
# ─────────────────────────────────────────────────────────────────────────────
# timezone_offset_minutes: patient's offset from UTC in minutes.
# Positive values = east of UTC (UTC+x).
#
#   Egypt   (UTC+2) → +120   ← data source / logging timezone
#   Germany (UTC+1) →  +60   ← viewer timezone
#   UTC             →    0
#
# Formula: UTC = local_time - offset_hours
# Code:    utc_dt = local_dt - timedelta(hours=timezone_offset_minutes / 60)
#
# This is the same convention used in libre_service._parse_libre_timestamp()
# and constants.ConstantConfig.timezone_offset_minutes.
# ─────────────────────────────────────────────────────────────────────────────


class TimeManager:
    """
    Centralized time management utility for backend operations.
    Provides timestamp normalization and precision-aware calculations.

    🆕 v4.3 - Now includes timezone offset support for daily reset calculations
    """

    # ========================================================================
    # CONSTANTS
    # ========================================================================

    MILLISECONDS_PER_SECOND = 1000
    MILLISECONDS_PER_MINUTE = 60 * 1000
    MILLISECONDS_PER_HOUR = 60 * 60 * 1000
    MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

    SECONDS_PER_MINUTE = 60
    SECONDS_PER_HOUR = 3600
    MINUTES_PER_HOUR = 60
    HOURS_PER_DAY = 24

    # Daily reset hour - MUST match frontend TimeManager.js
    DAILY_RESET_HOUR = 7  # 7 AM (local time)

    # Precision levels
    PRECISION_MILLISECOND = 'millisecond'
    PRECISION_SECOND = 'second'
    PRECISION_MINUTE = 'minute'
    PRECISION_HOUR = 'hour'

    # ========================================================================
    # INTERNAL HELPER
    # ========================================================================

    @classmethod
    def _naive_utc_to_ms(cls, dt: datetime) -> int:
        """
        Convert a timezone-naive datetime that represents UTC to milliseconds.

        CRITICAL: Python's datetime.timestamp() treats naive datetimes as LOCAL
        time, which introduces a timezone offset on any server not running UTC.
        calendar.timegm() always treats its input as UTC, matching the intended
        behaviour of storing and comparing all times in UTC.
        """
        return calendar.timegm(dt.timetuple()) * cls.MILLISECONDS_PER_SECOND

    # ========================================================================
    # TIMESTAMP NORMALIZATION
    # ========================================================================

    @classmethod
    def normalize_to_millisecond_boundary(cls, timestamp: Union[datetime, int, float]) -> int:
        """Normalize timestamp to millisecond boundary (no change, just validation)"""
        if isinstance(timestamp, datetime):
            ts = cls._naive_utc_to_ms(timestamp)
        elif isinstance(timestamp, (int, float)):
            ts = int(timestamp)
        else:
            logger.warning(f"Invalid timestamp type for millisecond normalization: {type(timestamp)}")
            ts = cls._naive_utc_to_ms(datetime.utcnow())
        return ts

    @classmethod
    def normalize_to_second_boundary(cls, timestamp: Union[datetime, int, float]) -> int:
        """Normalize timestamp to second boundary (remove milliseconds)"""
        if isinstance(timestamp, datetime):
            ts = cls._naive_utc_to_ms(timestamp)
        elif isinstance(timestamp, (int, float)):
            ts = int(timestamp)
        else:
            logger.warning(f"Invalid timestamp type for second normalization: {type(timestamp)}")
            ts = cls._naive_utc_to_ms(datetime.utcnow())
        return (ts // cls.MILLISECONDS_PER_SECOND) * cls.MILLISECONDS_PER_SECOND

    @classmethod
    def normalize_to_minute_boundary(cls, timestamp: Union[datetime, int, float]) -> int:
        """Normalize timestamp to minute boundary (remove seconds and milliseconds)"""
        if isinstance(timestamp, datetime):
            ts = cls._naive_utc_to_ms(timestamp)
        elif isinstance(timestamp, (int, float)):
            ts = int(timestamp)
        else:
            logger.warning(f"Invalid timestamp type for minute normalization: {type(timestamp)}")
            ts = cls._naive_utc_to_ms(datetime.utcnow())
        return (ts // cls.MILLISECONDS_PER_MINUTE) * cls.MILLISECONDS_PER_MINUTE

    @classmethod
    def normalize_to_hour_boundary(cls, timestamp: Union[datetime, int, float]) -> int:
        """Normalize timestamp to hour boundary (remove minutes, seconds, milliseconds)"""
        if isinstance(timestamp, datetime):
            ts = cls._naive_utc_to_ms(timestamp)
        elif isinstance(timestamp, (int, float)):
            ts = int(timestamp)
        else:
            logger.warning(f"Invalid timestamp type for hour normalization: {type(timestamp)}")
            ts = cls._naive_utc_to_ms(datetime.utcnow())
        return (ts // cls.MILLISECONDS_PER_HOUR) * cls.MILLISECONDS_PER_HOUR

    @classmethod
    def normalize(
        cls,
        timestamp: Union[datetime, int, float],
        precision: Literal['millisecond', 'second', 'minute', 'hour'] = 'second'
    ) -> int:
        """Normalize timestamp using specified precision"""
        if precision == cls.PRECISION_MILLISECOND:
            return cls.normalize_to_millisecond_boundary(timestamp)
        elif precision == cls.PRECISION_SECOND:
            return cls.normalize_to_second_boundary(timestamp)
        elif precision == cls.PRECISION_MINUTE:
            return cls.normalize_to_minute_boundary(timestamp)
        elif precision == cls.PRECISION_HOUR:
            return cls.normalize_to_hour_boundary(timestamp)
        else:
            logger.warning(f"Unknown precision: {precision} - using SECOND")
            return cls.normalize_to_second_boundary(timestamp)

    # ========================================================================
    # DATETIME CONVERSION HELPERS
    # ========================================================================

    @classmethod
    def to_datetime(cls, timestamp: Union[datetime, int, float], precision: str = 'second') -> datetime:
        """Convert timestamp to datetime object with normalization"""
        normalized_ts = cls.normalize(timestamp, precision)
        return datetime.utcfromtimestamp(normalized_ts / cls.MILLISECONDS_PER_SECOND)

    @classmethod
    def to_milliseconds(cls, dt: datetime, precision: str = 'second') -> int:
        """Convert datetime to milliseconds with normalization"""
        # Strip tzinfo if present — we always treat stored datetimes as UTC-naive
        if dt.tzinfo is not None:
            dt = dt.replace(tzinfo=None)
        # Use _naive_utc_to_ms, NOT dt.timestamp(), which would apply the local
        # server offset and silently corrupt all pharmacodynamic calculations
        ts = cls._naive_utc_to_ms(dt)
        return cls.normalize(ts, precision)

    # ========================================================================
    # PRECISION-AWARE TIME DIFFERENCE CALCULATIONS
    # ========================================================================

    @classmethod
    def calculate_hours_since_with_second_precision(
        cls,
        current_time: Union[datetime, int, float],
        event_time: Union[datetime, int, float]
    ) -> float:
        """Calculate hours since event with SECOND precision (for pharmacodynamics)"""
        current_seconds = cls.normalize_to_second_boundary(current_time) // cls.MILLISECONDS_PER_SECOND
        event_seconds = cls.normalize_to_second_boundary(event_time) // cls.MILLISECONDS_PER_SECOND
        seconds_diff = current_seconds - event_seconds
        return seconds_diff / cls.SECONDS_PER_HOUR

    @classmethod
    def calculate_hours_since_with_minute_precision(
        cls,
        current_time: Union[datetime, int, float],
        event_time: Union[datetime, int, float]
    ) -> float:
        """Calculate hours since event with MINUTE precision (for user-facing displays)"""
        current_minutes = cls.normalize_to_minute_boundary(current_time) // cls.MILLISECONDS_PER_MINUTE
        event_minutes = cls.normalize_to_minute_boundary(event_time) // cls.MILLISECONDS_PER_MINUTE
        minutes_diff = current_minutes - event_minutes
        return minutes_diff / cls.MINUTES_PER_HOUR

    @classmethod
    def calculate_hours_since(
        cls,
        current_time: Union[datetime, int, float],
        event_time: Union[datetime, int, float],
        precision: str = 'second'
    ) -> float:
        """Calculate hours since event with specified precision"""
        if precision == cls.PRECISION_SECOND:
            return cls.calculate_hours_since_with_second_precision(current_time, event_time)
        elif precision == cls.PRECISION_MINUTE:
            return cls.calculate_hours_since_with_minute_precision(current_time, event_time)
        elif precision == cls.PRECISION_MILLISECOND:
            current_ms = cls.normalize_to_millisecond_boundary(current_time)
            event_ms = cls.normalize_to_millisecond_boundary(event_time)
            return (current_ms - event_ms) / cls.MILLISECONDS_PER_HOUR
        else:
            return cls.calculate_hours_since_with_second_precision(current_time, event_time)

    @classmethod
    def calculate_minutes_since(
        cls,
        current_time: Union[datetime, int, float],
        event_time: Union[datetime, int, float],
        precision: str = 'second'
    ) -> float:
        """Calculate minutes since event with specified precision"""
        return cls.calculate_hours_since(current_time, event_time, precision) * cls.MINUTES_PER_HOUR

    # ========================================================================
    # CURRENT TIME GETTERS
    # ========================================================================

    @classmethod
    def get_current_time(cls, precision: str = 'second') -> int:
        """Get current UTC time normalized to specified precision (in milliseconds)"""
        return cls.normalize(datetime.utcnow(), precision)

    @classmethod
    def get_current_datetime(cls, precision: str = 'second') -> datetime:
        """Get current UTC datetime normalized to specified precision"""
        return cls.to_datetime(cls.get_current_time(precision), precision)

    # ========================================================================
    # TIMESTAMP PARSING
    # ========================================================================

    @classmethod
    def parse_timestamp(
        cls,
        timestamp: Union[datetime, int, float, str],
        precision: str = 'second'
    ) -> int:
        """
        Parse timestamp safely with normalization.
        Handles datetime objects, integers (ms), floats (ms), and ISO strings.

        Returns: Normalized timestamp in milliseconds
        """
        if timestamp is None:
            return cls.get_current_time(precision)

        if isinstance(timestamp, datetime):
            return cls.to_milliseconds(timestamp, precision)

        if isinstance(timestamp, (int, float)):
            return cls.normalize(timestamp, precision)

        if isinstance(timestamp, str):
            try:
                # Try parsing as ISO string
                dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                if dt.tzinfo is not None:
                    # Convert to UTC and make naive
                    dt = dt.replace(tzinfo=None)
                return cls.to_milliseconds(dt, precision)
            except ValueError:
                logger.warning(f"Could not parse timestamp string: {timestamp}")
                return cls.get_current_time(precision)

        logger.warning(f"Unknown timestamp type: {type(timestamp)}")
        return cls.get_current_time(precision)

    # ========================================================================
    # DURATION CALCULATIONS
    # ========================================================================

    @classmethod
    def add_hours(cls, dt: datetime, hours: float) -> datetime:
        """Add hours to a datetime"""
        return dt + timedelta(hours=hours)

    @classmethod
    def add_minutes(cls, dt: datetime, minutes: float) -> datetime:
        """Add minutes to a datetime"""
        return dt + timedelta(minutes=minutes)

    @classmethod
    def add_days(cls, dt: datetime, days: int) -> datetime:
        """Add days to a datetime"""
        return dt + timedelta(days=days)

    # ========================================================================
    # DEBUGGING HELPERS
    # ========================================================================

    @classmethod
    def debug_timestamp(cls, timestamp: Union[datetime, int, float]) -> dict:
        """Get detailed timestamp info for debugging"""
        as_millisecond = cls.normalize_to_millisecond_boundary(timestamp)
        as_second = cls.normalize_to_second_boundary(timestamp)
        as_minute = cls.normalize_to_minute_boundary(timestamp)
        as_hour = cls.normalize_to_hour_boundary(timestamp)

        return {
            'original': timestamp,
            'normalized': {
                'millisecond': as_millisecond,
                'second': as_second,
                'minute': as_minute,
                'hour': as_hour
            },
            'formatted': {
                'millisecond': cls.to_datetime(as_millisecond, 'millisecond').isoformat(),
                'second': cls.to_datetime(as_second, 'second').isoformat(),
                'minute': cls.to_datetime(as_minute, 'minute').isoformat(),
                'hour': cls.to_datetime(as_hour, 'hour').isoformat()
            },
            'differences_ms': {
                'ms_to_second': as_millisecond - as_second,
                'second_to_minute': as_second - as_minute,
                'minute_to_hour': as_minute - as_hour
            }
        }

    @classmethod
    def log_normalization_comparison(cls, timestamp: Union[datetime, int, float]):
        """Log normalization comparison for debugging"""
        debug = cls.debug_timestamp(timestamp)
        logger.info(f"🕐 Timestamp Normalization Comparison:")
        logger.info(f"  Original: {debug['original']}")
        logger.info(f"  Normalized: {debug['formatted']}")
        logger.info(f"  Differences (ms): {debug['differences_ms']}")

    # ========================================================================
    # CUMULATIVE EFFECTS UTILITIES (🆕 v4.3 - TIMEZONE SUPPORT)
    # ========================================================================

    @classmethod
    def get_daily_reset_time(
        cls,
        current_timestamp: Union[datetime, int, float] = None,
        reset_hour: Optional[int] = None,
        timezone_offset_minutes: int = 0
    ) -> int:
        """
        Get the most recent daily reset time in UTC milliseconds.

        🆕 v4.3 - TIMEZONE FIX: Now accepts timezone_offset_minutes to correctly
                  apply reset_hour in the PATIENT'S local timezone.

        Args:
            current_timestamp: Current time (datetime=UTC-naive, int=UTC milliseconds)
                             If None, uses current UTC time
            reset_hour: Hour of day for reset (0-23) in PATIENT'S LOCAL TIME
                       If None, uses DAILY_RESET_HOUR (default 7)
            timezone_offset_minutes: Patient's timezone offset from UTC in minutes
                                   Examples: UTC+2 = 120, UTC-5 = -300, UTC = 0
                                   Default: 0 (UTC)

        Returns:
            int: Reset time in UTC milliseconds since epoch

        CRITICAL: Must match frontend TimeManager.js getDailyResetTime() logic exactly.

        Example:
            # Patient in UTC+2 (Egypt), reset_hour=7 (7 AM local)
            # current_timestamp = 2026-02-12 10:00:00 UTC (12:00 PM local)
            # timezone_offset_minutes = 120
            #
            # Result: 2026-02-12 05:00:00 UTC (7 AM local = 5 AM UTC)
            reset_ms = TimeManager.get_daily_reset_time(
                datetime(2026, 2, 12, 10, 0, 0),
                reset_hour=7,
                timezone_offset_minutes=120
            )
        """
        # Determine which reset hour to use
        if reset_hour is None:
            actual_reset_hour = cls.DAILY_RESET_HOUR
        else:
            if not isinstance(reset_hour, int) or not (0 <= reset_hour <= 23):
                logger.warning(
                    f"Invalid reset_hour {reset_hour} (must be int 0-23), "
                    f"using default {cls.DAILY_RESET_HOUR}"
                )
                actual_reset_hour = cls.DAILY_RESET_HOUR
            else:
                actual_reset_hour = reset_hour

        # Get current time as UTC datetime
        if current_timestamp is None:
            current_utc = datetime.utcnow()
        elif isinstance(current_timestamp, datetime):
            current_utc = current_timestamp
            if current_utc.tzinfo is not None:
                current_utc = current_utc.replace(tzinfo=None)
        else:
            # Integer/float milliseconds (UTC epoch)
            current_utc = datetime.utcfromtimestamp(int(current_timestamp) / cls.MILLISECONDS_PER_SECOND)

        # Convert current UTC time to patient's local time
        offset_delta = timedelta(minutes=timezone_offset_minutes)
        current_local = current_utc + offset_delta

        # Set to reset hour in patient's local time today
        reset_local = current_local.replace(
            hour=actual_reset_hour, minute=0, second=0, microsecond=0
        )

        # If current local time is before reset hour today, use yesterday's reset
        if current_local < reset_local:
            reset_local = reset_local - timedelta(days=1)

        # Convert back to UTC
        reset_utc = reset_local - offset_delta

        # Log for debugging
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(
                f"🕐 Daily Reset Calculation:\n"
                f"   Current UTC: {current_utc.isoformat()}\n"
                f"   Timezone Offset: UTC{timezone_offset_minutes:+d}min\n"
                f"   Current Local: {current_local.isoformat()}\n"
                f"   Reset Hour (Local): {actual_reset_hour}:00\n"
                f"   Reset Local: {reset_local.isoformat()}\n"
                f"   Reset UTC: {reset_utc.isoformat()}"
            )

        # Convert to milliseconds
        return cls._naive_utc_to_ms(reset_utc)

    @classmethod
    def is_within_current_day(
        cls,
        dose_timestamp: Union[datetime, int, float],
        current_timestamp: Union[datetime, int, float] = None,
        reset_hour: Optional[int] = None,
        timezone_offset_minutes: int = 0
    ) -> bool:
        """
        Check if a dose/meal is within current "day" (since daily reset).

        🆕 v4.3 - TIMEZONE FIX: Now accepts timezone_offset_minutes parameter

        Args:
            dose_timestamp: Timestamp of dose/meal
            current_timestamp: Current time (if None, uses current UTC time)
            reset_hour: Hour of day for reset (0-23) in LOCAL time
                       If None, uses DAILY_RESET_HOUR
            timezone_offset_minutes: Patient's timezone offset from UTC in minutes
                                   Default: 0 (UTC)

        Returns:
            bool: True if dose is after the most recent reset time (not AT reset time)

        CRITICAL: Must match frontend TimeManager.js isWithinCurrentDay() logic exactly.

        Doses exactly at reset hour (e.g., 7:00:00 AM) are EXCLUDED for clean reset.
        This ensures cumulative calculations start fresh each day.

        Example:
            # Meal at 8:00 AM, checked at 10:00 AM (reset at 7 AM) -> True
            # Meal at 6:00 AM, checked at 10:00 AM (reset at 7 AM) -> False
            # Meal at 7:00:00 AM exactly -> False (excluded for clean reset)
        """
        if current_timestamp is None:
            current_timestamp = datetime.utcnow()

        dose_ms = cls.parse_timestamp(dose_timestamp, cls.PRECISION_SECOND)
        current_ms = cls.parse_timestamp(current_timestamp, cls.PRECISION_SECOND)

        reset_time = cls.get_daily_reset_time(
            current_ms,
            reset_hour=reset_hour,
            timezone_offset_minutes=timezone_offset_minutes
        )

        # Use > instead of >= to exclude doses exactly at reset time
        return dose_ms > reset_time

    @classmethod
    def is_at_reset_time(
        cls,
        current_timestamp: Union[datetime, int, float] = None,
        reset_hour: Optional[int] = None,
        timezone_offset_minutes: int = 0
    ) -> bool:
        """
        Check if current time is at daily reset point (within 1 minute).

        🆕 v4.3 - TIMEZONE FIX: Now checks against patient's local time

        Args:
            current_timestamp: Current time (if None, uses current UTC time)
            reset_hour: Hour of day for reset (0-23) in LOCAL time
                       If None, uses DAILY_RESET_HOUR
            timezone_offset_minutes: Patient's timezone offset from UTC in minutes
                                   Default: 0 (UTC)

        Returns:
            bool: True if at reset time (within 1 minute)
        """
        if reset_hour is None:
            actual_reset_hour = cls.DAILY_RESET_HOUR
        else:
            if not isinstance(reset_hour, int) or not (0 <= reset_hour <= 23):
                actual_reset_hour = cls.DAILY_RESET_HOUR
            else:
                actual_reset_hour = reset_hour

        # Get current time as UTC datetime
        if current_timestamp is None:
            current_utc = datetime.utcnow()
        elif isinstance(current_timestamp, datetime):
            current_utc = current_timestamp
            if current_utc.tzinfo is not None:
                current_utc = current_utc.replace(tzinfo=None)
        else:
            current_utc = datetime.utcfromtimestamp(int(current_timestamp) / cls.MILLISECONDS_PER_SECOND)

        # Convert to patient's local time
        offset_delta = timedelta(minutes=timezone_offset_minutes)
        current_local = current_utc + offset_delta

        # Check if at reset hour (within 1 minute)
        return current_local.hour == actual_reset_hour and current_local.minute == 0

    # ========================================================================
    # PHARMACODYNAMICS UTILITIES
    # ========================================================================

    @classmethod
    def is_effect_active(cls, hours_since: float, profile: dict) -> bool:
        """Check if an effect (insulin or meal) is still active"""
        if not profile or 'duration_hours' not in profile:
            return False
        duration_hours = profile.get('duration_hours')
        if not isinstance(duration_hours, (int, float)):
            return False
        return 0 <= hours_since <= duration_hours

    @classmethod
    def get_profile_duration(cls, profile: dict) -> float:
        """Get duration from any pharmacodynamic profile"""
        if not profile:
            return 0
        return profile.get('duration_hours', 0)

    @classmethod
    def get_profile_peak_time(cls, profile: dict) -> float:
        """Get time to peak from any pharmacodynamic profile"""
        if not profile:
            return 0
        return profile.get('peak_hours', 0)