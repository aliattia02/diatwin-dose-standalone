/**
 * Time Manager - Comprehensive Time Normalization Utilities
 * Location: mobile/utils/time/TimeManager.ts
 *
 * Main Export: TimeManager (default object with all time utilities)
 * Description: Centralized utility for ALL time-related operations across the application
 *              with timestamp normalization, timezone conversion, and pharmacodynamic calculations
 *
 * Features:
 * - Timestamp normalization (millisecond, second, minute, hour boundaries)
 * - Precision-aware time calculations (IOB/MOB compatible)
 * - UTC/Local timezone conversions
 * - Time formatting and parsing (multiple formats)
 * - Duration calculations and formatting
 * - Relative time formatting (e.g., "2 hours ago")
 * - Display-friendly datetime formatting (formatDateTimeDisplay)
 * - Daily reset logic for cumulative effects (7 AM baseline)
 * - Pharmacodynamics utilities (effect active checks, profile parsing)
 * - Chart and timeline generation utilities
 *
 * Usage Guidelines:
 * 1. ALWAYS use TimeManager for time operations - DO NOT use Date directly
 * 2. Use normalized timestamps for consistency across calculations
 * 3. Store times in UTC, display in local timezone
 * 4. Use second precision for pharmacodynamic calculations
 * 5. Use minute boundary for user-facing timestamps
 * 6. Use cumulative utilities for daily baseline reset logic
 *
 * Import Patterns:
 * ```typescript
 * // Recommended: Named import for the TimeManager object
 * import { TimeManager } from '@/utils/time';
 * const now = TimeManager.getCurrentTimeISOString();
 *
 * // Alternative: Import specific functions
 * import { normalizeToSecondBoundary, calculateHoursSince } from '@/utils/time';
 *
 * // Legacy: Default import
 * import TimeManager from '@/utils/time/TimeManager';
 * ```
 *
 * Version: 4.3-TIMEZONE-FIX (Added timezone support to getDailyResetTime, isWithinCurrentDay, isAtResetTime)
 * Previous Versions:
 * - v4.1: Added formatDateTimeDisplay
 * - v4.0: TypeScript Migration with Named Exports
 * - v3.3: Fixed parseTimestamp shadowing, renamed to parseTimestampRaw
 * - v3.2: Added pharmacodynamics utilities
 * - v3.1: Added cumulative effects utilities
 * - v3.0: Enhanced normalization support
 */

/**
 * ========================================================================
 * TYPE DEFINITIONS
 * ========================================================================
 */

/**
 * Pharmacodynamic profile for TimeManager utilities
 * Uses snake_case to match backend API format
 */
export interface PharmacodynamicProfile {
  duration_hours?: number;
  peak_hours?: number;
}

export interface DurationResult {
  hours: number;
  minutes: number;
  totalHours: number;
  formatted: string;
}

export interface TimeScaleSettings {
  start: number;
  end: number;
  tickInterval: number;
  tickFormat: string;
}

export interface TimestampDebugInfo {
  original: number;
  normalized: {
    millisecond: number;
    second: number;
    minute: number;
    hour: number;
  };
  formatted: {
    millisecond: string;
    second: string;
    minute: string;
    hour: string;
  };
  differences: {
    ms_to_second: number;
    second_to_minute: number;
    minute_to_hour: number;
  };
}

export type TimeInput = string | Date | number;

/**
 * ========================================================================
 * CONSTANTS
 * ========================================================================
 */

export const TimeFormats = {
  DATE: 'YYYY-MM-DD',
  TIME: 'HH:mm',
  DATETIME: 'YYYY-MM-DD HH:mm',
  DATETIME_DISPLAY: 'MM/DD/YYYY, HH:mm',
  DATETIME_FULL: 'YYYY-MM-DD HH:mm:ss',
  DATETIME_ISO: 'YYYY-MM-DDTHH:mm',
  DATETIME_ISO_SECONDS: 'YYYY-MM-DDTHH:mm:ss',
  CHART_TICKS_SHORT: 'HH:mm',
  CHART_TICKS_MEDIUM: 'DD/MM HH:mm',
  CHART_TICKS_LONG: 'MM/DD',
  SYSTEM_TIME: 'YYYY-MM-DD HH:mm:ss'
} as const;

// Alias for backward compatibility
export const formats = TimeFormats;

export type TimeFormat = typeof TimeFormats[keyof typeof TimeFormats];

export const TimeConstants = {
  MILLISECONDS_PER_SECOND: 1000,
  MILLISECONDS_PER_MINUTE: 60 * 1000,
  MILLISECONDS_PER_HOUR: 60 * 60 * 1000,
  MILLISECONDS_PER_DAY: 24 * 60 * 60 * 1000,
  SECONDS_PER_MINUTE: 60,
  SECONDS_PER_HOUR: 3600,
  MINUTES_PER_HOUR: 60,
  HOURS_PER_DAY: 24
} as const;

// Alias for backward compatibility
export const constants = TimeConstants;

export const precision = {
  MILLISECOND: 'millisecond',
  SECOND: 'second',
  MINUTE: 'minute',
  HOUR: 'hour'
} as const;

export type PrecisionLevel = typeof precision[keyof typeof precision];

export interface TimeScale {
  unit: 'hour' | 'day' | 'week' | 'month';
  interval: number;
  format: string;
}

/**
 * ========================================================================
 * TIMESTAMP NORMALIZATION
 * ========================================================================
 */

/**
 * Normalize timestamp to millisecond boundary (no change, just validation)
 * Use this when you need full precision (rare in diabetes management)
 */
export function normalizeToMillisecondBoundary(timestamp: TimeInput): number {
  const ts = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();

  if (isNaN(ts)) {
    console.warn('Invalid timestamp for millisecond normalization:', timestamp);
    return Date.now();
  }

  return ts;
}

/**
 * Normalize timestamp to second boundary (remove milliseconds)
 * Use this for pharmacodynamic calculations (IOB, MOB)
 */
export function normalizeToSecondBoundary(timestamp: TimeInput): number {
  const ts = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();

  if (isNaN(ts)) {
    console.warn('Invalid timestamp for second normalization:', timestamp);
    return Math.floor(Date.now() / constants.MILLISECONDS_PER_SECOND) * constants.MILLISECONDS_PER_SECOND;
  }

  // Remove milliseconds by flooring to seconds then converting back
  return Math.floor(ts / constants.MILLISECONDS_PER_SECOND) * constants.MILLISECONDS_PER_SECOND;
}

/**
 * Normalize timestamp to minute boundary (remove seconds and milliseconds)
 * Use this for user-facing timestamps, baseline calculations
 */
export function normalizeToMinuteBoundary(timestamp: TimeInput): number {
  const ts = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();

  if (isNaN(ts)) {
    console.warn('Invalid timestamp for minute normalization:', timestamp);
    const now = Date.now();
    return Math.floor(now / constants.MILLISECONDS_PER_MINUTE) * constants.MILLISECONDS_PER_MINUTE;
  }

  // Remove seconds and milliseconds
  return Math.floor(ts / constants.MILLISECONDS_PER_MINUTE) * constants.MILLISECONDS_PER_MINUTE;
}

/**
 * Normalize timestamp to hour boundary (remove minutes, seconds, milliseconds)
 * Use this for hourly aggregations, long-term trends
 */
export function normalizeToHourBoundary(timestamp: TimeInput): number {
  const ts = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();

  if (isNaN(ts)) {
    console.warn('Invalid timestamp for hour normalization:', timestamp);
    const now = Date.now();
    return Math.floor(now / constants.MILLISECONDS_PER_HOUR) * constants.MILLISECONDS_PER_HOUR;
  }

  // Remove minutes, seconds, and milliseconds
  return Math.floor(ts / constants.MILLISECONDS_PER_HOUR) * constants.MILLISECONDS_PER_HOUR;
}

/**
 * Normalize timestamp using specified precision
 */
export function normalize(timestamp: TimeInput, precisionLevel: PrecisionLevel = precision.SECOND): number {
  switch (precisionLevel) {
    case precision.MILLISECOND:
      return normalizeToMillisecondBoundary(timestamp);
    case precision.SECOND:
      return normalizeToSecondBoundary(timestamp);
    case precision.MINUTE:
      return normalizeToMinuteBoundary(timestamp);
    case precision.HOUR:
      return normalizeToHourBoundary(timestamp);
    default:
      console.warn('Unknown precision:', precisionLevel, '- using SECOND');
      return normalizeToSecondBoundary(timestamp);
  }
}

/**
 * ========================================================================
 * PRECISION-AWARE TIME DIFFERENCE CALCULATIONS
 * ========================================================================
 */

/**
 * Calculate hours since event with SECOND precision (not millisecond)
 * USE THIS for all pharmacodynamic calculations (IOB, MOB)
 */
export function calculateHoursSinceWithSecondPrecision(currentTime: number, eventTime: number): number {
  const currentSeconds = Math.floor(currentTime / constants.MILLISECONDS_PER_SECOND);
  const eventSeconds = Math.floor(eventTime / constants.MILLISECONDS_PER_SECOND);
  const secondsDiff = currentSeconds - eventSeconds;

  return secondsDiff / constants.SECONDS_PER_HOUR;
}

/**
 * Calculate hours since event with MINUTE precision
 * USE THIS for user-facing displays
 */
export function calculateHoursSinceWithMinutePrecision(currentTime: number, eventTime: number): number {
  const currentMinutes = Math.floor(currentTime / constants.MILLISECONDS_PER_MINUTE);
  const eventMinutes = Math.floor(eventTime / constants.MILLISECONDS_PER_MINUTE);
  const minutesDiff = currentMinutes - eventMinutes;

  return minutesDiff / constants.MINUTES_PER_HOUR;
}

/**
 * Calculate hours since event with specified precision
 */
export function calculateHoursSince(
  currentTime: number,
  eventTime: number,
  precisionLevel: PrecisionLevel = precision.SECOND
): number {
  switch (precisionLevel) {
    case precision.SECOND:
      return calculateHoursSinceWithSecondPrecision(currentTime, eventTime);
    case precision.MINUTE:
      return calculateHoursSinceWithMinutePrecision(currentTime, eventTime);
    case precision.MILLISECOND:
      return (currentTime - eventTime) / constants.MILLISECONDS_PER_HOUR;
    default:
      return calculateHoursSinceWithSecondPrecision(currentTime, eventTime);
  }
}

/**
 * Calculate minutes since event with specified precision
 */
export function calculateMinutesSince(
  currentTime: number,
  eventTime: number,
  precisionLevel: PrecisionLevel = precision.SECOND
): number {
  return calculateHoursSince(currentTime, eventTime, precisionLevel) * constants.MINUTES_PER_HOUR;
}

/**
 * ========================================================================
 * CURRENT TIME GETTERS (WITH NORMALIZATION)
 * ========================================================================
 */

/**
 * Get current time normalized to specified precision
 */
export function getCurrentTime(precisionLevel: PrecisionLevel = precision.SECOND): number {
  return normalize(Date.now(), precisionLevel);
}

/**
 * Get current time as ISO string for datetime-local input
 * Format: YYYY-MM-DDTHH:MM in local timezone
 */
export function getCurrentTimeISOString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/**
 * Get current time normalized to minute boundary as ISO string
 */
export function getCurrentTimeNormalizedISO(): string {
  const normalized = normalizeToMinuteBoundary(Date.now());
  return formatDateTimeLocal(new Date(normalized));
}

/**
 * ========================================================================
 * TIMESTAMP PARSING AND VALIDATION
 * ========================================================================
 *
 * CRITICAL FIX v3.3: This is the SINGLE parseTimestamp method.
 * The previous v3.2 had a second parseTimestamp in the "Pharmacodynamics
 * Utilities" section that silently shadowed this one, causing the
 * `precision` parameter to be ignored for all callers.
 *
 * The simple type-coercion parser is now named parseTimestampRaw().
 */

/**
 * Parse timestamp safely with normalization
 *
 * Handles all input types (number, string, Date) and normalizes
 * to the requested precision. This is the PRIMARY parsing method
 * and should be used throughout the application.
 */
export function parseTimestamp(timestamp: TimeInput | null | undefined, precisionLevel: PrecisionLevel = precision.SECOND): number {
  if (!timestamp) {
    return getCurrentTime(precisionLevel);
  }

  if (timestamp instanceof Date) {
    return normalize(timestamp.getTime(), precisionLevel);
  }

  if (typeof timestamp === 'number') {
    return normalize(timestamp, precisionLevel);
  }

  try {
    // Handle ISO strings with timezone info
    if (typeof timestamp === 'string') {
      if (timestamp.endsWith('Z') || timestamp.includes('+') || timestamp.includes('-', 10)) {
        return normalize(new Date(timestamp).getTime(), precisionLevel);
      } else {
        // No timezone info - treat as UTC
        const [datePart, timePart] = timestamp.includes('T')
          ? timestamp.split('T')
          : [timestamp.split(' ')[0], timestamp.split(' ')[1] || '00:00:00'];

        if (!datePart) {
          return getCurrentTime(precisionLevel);
        }

        const [year, month, day] = datePart.split('-').map(num => parseInt(num, 10));
        const [hours, minutes, seconds] = (timePart || '00:00:00').split(':').map(num => parseInt(num, 10));

        const date = new Date(Date.UTC(
          year,
          month - 1,
          day,
          hours || 0,
          minutes || 0,
          seconds || 0
        ));

        return normalize(date.getTime(), precisionLevel);
      }
    }

    return normalize(new Date(timestamp).getTime(), precisionLevel);
  } catch (error) {
    console.error('Error parsing timestamp:', error, timestamp);
    return getCurrentTime(precisionLevel);
  }
}

/**
 * Validate timestamp
 */
export function isValidTimestamp(timestamp: any): boolean {
  if (!timestamp) return false;

  try {
    const ts = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
    return !isNaN(ts) && ts > 0;
  } catch {
    return false;
  }
}

/**
 * ========================================================================
 * FORMATTING
 * ========================================================================
 */

/**
 * Format a date for datetime-local input (YYYY-MM-DDTHH:mm)
 */
export function formatDateTimeLocal(date: TimeInput | null | undefined): string {
  if (!date) date = new Date();

  const d = date instanceof Date ? date : new Date(date);

  if (isNaN(d.getTime())) {
    console.warn('Invalid date for formatDateTimeLocal:', date);
    return getCurrentTimeISOString();
  }

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/**
 * Format a date using specified format
 */
export function formatDate(date: TimeInput | null | undefined, format?: string): string {
  if (!date) return '';
  if (!format) format = formats.DATETIME_DISPLAY;

  const d = date instanceof Date ? date : new Date(date);

  if (isNaN(d.getTime())) {
    console.warn('Invalid date for formatting:', date);
    return '';
  }

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');

  const displayMonth = (d.getMonth() + 1).toString();
  const displayDay = d.getDate().toString();

  return format
    .replace('YYYY', year.toString())
    .replace('MM', month)
    .replace('DD', day)
    .replace('HH', hours)
    .replace('mm', minutes)
    .replace('ss', seconds)
    .replace('M', displayMonth)
    .replace('D', displayDay);
}

/**
 * Format timestamp as time only (HH:MM)
 */
export function formatTime(timestamp: TimeInput | null | undefined): string {
  if (!timestamp) return '';

  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '';

    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');

    return `${hours}:${minutes}`;
  } catch (error) {
    console.error('Error formatting time:', error);
    return '';
  }
}

/**
 * Format timestamp as relative time (e.g., "5 minutes ago")
 */
export function formatRelativeTime(timestamp: TimeInput | null | undefined): string {
  if (!timestamp) return '';

  try {
    const date = parseTimestamp(timestamp, precision.SECOND);
    const now = getCurrentTime(precision.SECOND);

    if (isNaN(date)) return '';

    const diffMs = now - date;

    if (diffMs < 0) return 'in the future';
    if (diffMs < constants.MILLISECONDS_PER_MINUTE) return 'just now';

    if (diffMs < constants.MILLISECONDS_PER_HOUR) {
      const mins = Math.floor(diffMs / constants.MILLISECONDS_PER_MINUTE);
      return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`;
    }

    if (diffMs < constants.MILLISECONDS_PER_DAY) {
      const hours = Math.floor(diffMs / constants.MILLISECONDS_PER_HOUR);
      return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
    }

    if (diffMs < 7 * constants.MILLISECONDS_PER_DAY) {
      const days = Math.floor(diffMs / constants.MILLISECONDS_PER_DAY);
      return `${days} ${days === 1 ? 'day' : 'days'} ago`;
    }

    return formatDate(new Date(date), formats.DATETIME_DISPLAY);
  } catch (error) {
    console.error('Error formatting relative time:', error);
    return '';
  }
}

/**
 * Format datetime for human-readable display in the UI
 *
 * Produces a consistent, locale-aware string suitable for history lists,
 * detail views, and any screen that needs a readable date + time.
 *
 * Output examples:
 *   "Feb 12, 2026, 14:35"   (same year)
 *   "Dec 3, 2025, 09:00"    (different year – year is always shown)
 *
 * FIX v4.1: Added this method to resolve the runtime error
 *   "TypeError: TimeManager.formatDateTimeDisplay is not a function"
 *   that appeared in the History screen because the method was called
 *   but had never been defined or included in the TimeManager object.
 *
 * @param timestamp - Any supported time input (ISO string, Date, ms number)
 * @returns Human-readable date/time string, or empty string for invalid input
 */
export function formatDateTimeDisplay(timestamp: TimeInput | null | undefined): string {
  if (!timestamp) return '';

  try {
    const d = timestamp instanceof Date ? timestamp : new Date(timestamp);
    if (isNaN(d.getTime())) {
      console.warn('[TimeManager] formatDateTimeDisplay received invalid timestamp:', timestamp);
      return '';
    }

    // Use Intl.DateTimeFormat for locale-aware, consistent output
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
  } catch (error) {
    console.error('[TimeManager] Error in formatDateTimeDisplay:', error);
    return '';
  }
}

/**
 * Format a UTC ISO string for time-only display in local timezone
 *
 * Produces a user-friendly time string for display, converting from UTC to
 * the user's local timezone.
 *
 * Output examples:
 *   "2:30 PM"
 *   "14:35" (in 24-hour locale)
 *   "9:05 AM"
 *
 * FIX v4.2: Added this method to resolve the runtime error
 *   "TypeError: TimeManager.formatTimeDisplay is not a function"
 *   that appeared in UnifiedActivityInput when displaying activity times.
 *
 * @param utcIsoString - UTC ISO timestamp string (e.g., "2024-01-15T14:30:00Z")
 * @returns Human-readable time string in local timezone, or empty string for invalid input
 */
export function formatTimeDisplay(utcIsoString: string | null | undefined): string {
  if (!utcIsoString) return '';

  try {
    const date = new Date(utcIsoString);

    if (isNaN(date.getTime())) {
      console.warn('[TimeManager] formatTimeDisplay received invalid timestamp:', utcIsoString);
      return '';
    }

    // Format as local time (e.g., "2:30 PM" or "14:30")
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  } catch (error) {
    console.error('[TimeManager] Error formatting time:', error);
    return '';
  }
}

/**
 * ========================================================================
 * UTC / LOCAL CONVERSIONS
 * ========================================================================
 */

/**
 * Get user's timezone
 */
export function getUserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Convert UTC timestamp to local timezone
 */
export function utcToLocal(utcTime: TimeInput): Date {
  const date = new Date(utcTime);
  return new Date(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds()
  );
}

/**
 * Convert local timestamp to UTC
 */
export function localToUtc(localTime: TimeInput): Date {
  const date = new Date(localTime);
  return new Date(Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds()
  ));
}

/**
 * Convert UTC ISO string to local datetime format
 */
export function utcToLocalString(utcIsoString: string | null | undefined): string {
  if (!utcIsoString) return '';

  try {
    const date = new Date(utcIsoString);
    return formatDateTimeLocal(date);
  } catch (error) {
    console.error('Error converting UTC to local time:', error);
    return '';
  }
}

/**
 * Convert local datetime to UTC ISO string
 */
export function localToUTCISOString(localDateTimeString: string | null | undefined): string {
  if (!localDateTimeString) return new Date().toISOString();

  const localDate = new Date(localDateTimeString);
  return localDate.toISOString();
}

/**
 * Alias for backwards compatibility
 */
export function utcToLocalIsoString(utcIsoString: string | null | undefined): string {
  return utcToLocalString(utcIsoString);
}

/**
 * ========================================================================
 * DURATION CALCULATIONS
 * ========================================================================
 */

/**
 * Calculate duration between two timestamps
 */
export function calculateDuration(startTime: TimeInput | null | undefined, endTime: TimeInput | null | undefined): DurationResult {
  if (!startTime || !endTime) {
    return { hours: 0, minutes: 0, totalHours: 0, formatted: "0h 0m" };
  }

  try {
    const start = new Date(startTime);
    const end = new Date(endTime);
    const durationMs = Math.max(0, end.getTime() - start.getTime());

    const totalMinutes = durationMs / constants.MILLISECONDS_PER_MINUTE;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = Math.round(totalMinutes % 60);

    return {
      hours,
      minutes,
      totalHours: hours + (minutes / 60),
      formatted: `${hours}h ${minutes}m`
    };
  } catch (error) {
    console.error("Error calculating duration:", error);
    return { hours: 0, minutes: 0, totalHours: 0, formatted: "0h 0m" };
  }
}

/**
 * Convert duration to hours
 */
export function durationToHours(duration: number | string): number {
  if (typeof duration === 'number') return duration;

  if (typeof duration === 'string' && duration.includes(':')) {
    const [hours, minutes] = duration.split(':').map(num => parseInt(num, 10) || 0);
    return hours + (minutes / 60);
  }

  return parseFloat(duration) || 0;
}

/**
 * Convert hours to time string (HH:MM)
 */
export function hoursToTimeString(hours: number | null | undefined): string {
  if (hours === undefined || hours === null) return "00:00";

  const wholeHours = Math.floor(hours);
  const minutes = Math.round((hours - wholeHours) * 60);

  return `${wholeHours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * Add hours to a date
 */
export function addHours(date: TimeInput, hours: number): Date {
  const result = new Date(date);
  result.setTime(result.getTime() + (hours * constants.MILLISECONDS_PER_HOUR));
  return result;
}

/**
 * ========================================================================
 * CHART / VISUALIZATION HELPERS
 * ========================================================================
 */

/**
 * Generate evenly spaced ticks for chart X-axis
 */
export function generateTimeTicks(startTime: number, endTime: number, tickInterval: number = 12): number[] {
  if (!startTime || !endTime) {
    console.warn('Invalid time range for ticks generation', { startTime, endTime });
    return [];
  }

  const ticksArray: number[] = [];
  const start = new Date(startTime);
  start.setMinutes(0, 0, 0);

  let current = start.getTime();
  const intervalMs = tickInterval * constants.MILLISECONDS_PER_HOUR;

  while (current <= endTime) {
    ticksArray.push(current);
    current += intervalMs;
  }

  return ticksArray;
}

/**
 * Format timestamp for X-axis display
 */
export function formatAxisTick(timestamp: number, format: string): string {
  const formatString = format in formats
    ? formats[format as keyof typeof formats]
    : (format || formats.DATETIME_DISPLAY);
  return formatDate(timestamp, formatString);
}

/**
 * Determine time scale settings based on date range
 */
export function getTimeScaleForRange(startDate: string | null | undefined, endDate: string | null | undefined): TimeScaleSettings {
  if (!startDate || !endDate) {
    console.warn('Invalid date range for time scale', { startDate, endDate });
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * constants.MILLISECONDS_PER_DAY);

    return getTimeScaleForRange(
      formatDate(weekAgo, formats.DATE),
      formatDate(now, formats.DATE)
    );
  }

  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);

  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  const diffDays = (end.getTime() - start.getTime()) / constants.MILLISECONDS_PER_DAY;

  let tickInterval: number;
  let tickFormat: string;

  if (diffDays <= 1) {
    tickInterval = 2;
    tickFormat = formats.CHART_TICKS_SHORT;
  } else if (diffDays <= 7) {
    tickInterval = 12;
    tickFormat = formats.CHART_TICKS_MEDIUM;
  } else {
    tickInterval = 24;
    tickFormat = formats.CHART_TICKS_LONG;
  }

  return {
    start: start.getTime(),
    end: end.getTime(),
    tickInterval,
    tickFormat
  };
}

/**
 * Check if timestamp is within range
 */
export function isTimeInRange(timestamp: number | null | undefined, startTime: number, endTime: number): boolean {
  if (!timestamp || !startTime || !endTime) return false;
  return timestamp >= startTime && timestamp <= endTime;
}

/**
 * ========================================================================
 * SYSTEM TIME & USER INFO
 * ========================================================================
 */

/**
 * Get system date and time in consistent format
 */
export function getSystemDateTime(format: string | null = null): string {
  const now = new Date();
  const systemTime = now.toISOString().replace('T', ' ').substring(0, 19);

  if (!format) return systemTime;

  try {
    const [datePart, timePart] = systemTime.split(' ');
    const [year, month, day] = datePart.split('-');
    const [hours, minutes, seconds] = timePart.split(':');

    const date = new Date(Date.UTC(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      parseInt(hours),
      parseInt(minutes),
      parseInt(seconds || '0')
    ));

    return formatDate(date, format);
  } catch (e) {
    console.error('Error parsing system time:', e);
    return systemTime;
  }
}

/**
 * Get current user login
 * @deprecated Legacy function - should be replaced with proper authentication context
 * @returns Hardcoded user login for backward compatibility
 */
export function getCurrentUserLogin(): string {
  return "aliattia02";
}

/**
 * ========================================================================
 * UTILITY FUNCTIONS
 * ========================================================================
 */

/**
 * Get time point hours ago
 */
export function getTimePointHoursAgo(hoursAgo: number): string {
  const date = addHours(new Date(), -hoursAgo);
  return formatDateTimeLocal(date);
}

/**
 * Get future projection time
 */
export function getFutureProjectionTime(futureHours: number = 7): number {
  const now = new Date();
  return addHours(now, futureHours).getTime();
}

/**
 * Format datetime for display
 * @deprecated Use formatDateTimeDisplay for consistent UI output.
 *             This alias is kept for backward compatibility.
 */
export function formatDateTime(isoString: TimeInput | null | undefined): string {
  if (!isoString) return '';

  try {
    const date = parseTimestamp(isoString);
    return new Date(date).toLocaleString();
  } catch (error) {
    console.error('Error formatting date:', error);
    return '';
  }
}

/**
 * ========================================================================
 * DEBUGGING & LOGGING HELPERS
 * ========================================================================
 */

/**
 * Get detailed timestamp info for debugging
 */
export function debugTimestamp(timestamp: number): TimestampDebugInfo {
  const original = timestamp;
  const asMillisecond = normalizeToMillisecondBoundary(timestamp);
  const asSecond = normalizeToSecondBoundary(timestamp);
  const asMinute = normalizeToMinuteBoundary(timestamp);
  const asHour = normalizeToHourBoundary(timestamp);

  return {
    original,
    normalized: {
      millisecond: asMillisecond,
      second: asSecond,
      minute: asMinute,
      hour: asHour
    },
    formatted: {
      millisecond: new Date(asMillisecond).toISOString(),
      second: new Date(asSecond).toISOString(),
      minute: new Date(asMinute).toISOString(),
      hour: new Date(asHour).toISOString()
    },
    differences: {
      ms_to_second: asMillisecond - asSecond,
      second_to_minute: asSecond - asMinute,
      minute_to_hour: asMinute - asHour
    }
  };
}

/**
 * Log normalization comparison
 */
export function logNormalizationComparison(timestamp: number): void {
  const debug = debugTimestamp(timestamp);
  console.log('🕐 Timestamp Normalization Comparison:', {
    original: new Date(debug.original).toISOString(),
    normalized: debug.formatted,
    differences_ms: debug.differences
  });
}

/**
 * ========================================================================
 * CUMULATIVE EFFECTS UTILITIES (Daily Reset Logic)
 * ========================================================================
 *
 * These utilities support cumulative baseline calculations that reset
 * daily at 7 AM. Used by bloodGlucoseEstimationService and
 * netEffectCalculationService.
 *
 * Added in v3.1 to consolidate duplicate code and prevent circular dependencies.
 */

/**
 * Get the most recent daily reset time with TIMEZONE SUPPORT
 *
 * 🆕 v4.3-TIMEZONE-FIX: Now accepts timezone parameters to match backend
 *
 * @param currentTimestamp - Current time in milliseconds (UTC)
 * @param resetHour - Hour of day for reset (0-23) in PATIENT'S LOCAL TIME (default: 7)
 * @param timezoneOffsetMinutes - Patient's timezone offset from UTC in minutes
 *                                Examples: UTC+2 = 120, UTC-5 = -300, UTC = 0
 * @returns Reset time as millisecond timestamp (UTC)
 *
 * CRITICAL: Must match backend time_manager.py get_daily_reset_time() exactly
 *
 * @example
 * // Patient in EST (UTC-5 = -300 minutes), reset at 7 AM local
 * const currentTime = new Date('2026-02-14T14:00:00Z').getTime(); // 9 AM EST
 * const resetTime = getDailyResetTime(currentTime, 7, -300);
 * // Returns: 2026-02-14T12:00:00.000Z (7 AM EST in UTC)
 *
 * // Legacy usage (no timezone) still works:
 * const resetTime = getDailyResetTime(Date.now()); // Uses 7 AM UTC
 */
export function getDailyResetTime(
  currentTimestamp: number,
  resetHour: number = 7,
  timezoneOffsetMinutes: number = 0
): number {
  // Validate resetHour
  if (!Number.isInteger(resetHour) || resetHour < 0 || resetHour > 23) {
    console.warn(`[TimeManager] Invalid resetHour ${resetHour}, using default 7`);
    resetHour = 7;
  }

  // Convert current UTC time to patient's local time
  const offsetMs = timezoneOffsetMinutes * 60 * 1000;
  const currentLocalTime = new Date(currentTimestamp + offsetMs);

  // Set to reset hour in patient's local time
  const resetLocalTime = new Date(currentLocalTime);
  // UTC method — immune to JS runtime local timezone (see §M-7 fix)
  resetLocalTime.setUTCHours(resetHour, 0, 0, 0);

  // If current local time is before reset hour today, use yesterday's reset
  if (currentLocalTime < resetLocalTime) {
    // UTC method — immune to JS runtime local timezone (see §M-7 fix)
    resetLocalTime.setUTCDate(resetLocalTime.getUTCDate() - 1);
  }

  // Convert back to UTC
  const resetUTC = resetLocalTime.getTime() - offsetMs;

  return resetUTC;
}

/**
 * Check if a dose/meal should be included in cumulative calculation
 * Only include doses AFTER the most recent reset (not AT reset time)
 *
 * 🆕 v4.3-TIMEZONE-FIX: Now accepts timezone parameters to match backend
 *
 * @param doseTimestamp - Timestamp of dose/meal in milliseconds (UTC)
 * @param currentTimestamp - Current time in milliseconds (UTC)
 * @param resetHour - Hour of day for reset in PATIENT'S LOCAL TIME (default: 7)
 * @param timezoneOffsetMinutes - Patient's timezone offset from UTC in minutes (default: 0)
 * @returns true if dose is after the most recent reset time
 *
 * CRITICAL: Must match backend time_manager.py is_within_current_day() exactly
 * Doses exactly at reset time (e.g., 7:00:00 AM) are EXCLUDED for clean reset.
 *
 * @example
 * // Dose at 8 AM EST, checked at 10 AM EST, reset at 7 AM
 * const doseTime = new Date('2026-02-14T13:00:00Z').getTime(); // 8 AM EST
 * const currentTime = new Date('2026-02-14T15:00:00Z').getTime(); // 10 AM EST
 * const isValid = isWithinCurrentDay(doseTime, currentTime, 7, -300);
 * // Returns: true (dose is after 7 AM EST reset)
 *
 * // Legacy usage (no timezone) still works:
 * const isValid = isWithinCurrentDay(mealTime, Date.now()); // Uses 7 AM UTC
 */
export function isWithinCurrentDay(
  doseTimestamp: number,
  currentTimestamp: number,
  resetHour: number = 7,
  timezoneOffsetMinutes: number = 0
): boolean {
  const resetTime = getDailyResetTime(currentTimestamp, resetHour, timezoneOffsetMinutes);
  // Use > instead of >= to exclude doses exactly at reset time
  return doseTimestamp > resetTime;
}

/**
 * Check if current time is exactly at or very close to reset point
 * Returns true if within 1 minute of reset time
 *
 * 🆕 v4.3-TIMEZONE-FIX: Now accepts timezone parameters to match backend
 *
 * @param currentTimestamp - Current time in milliseconds (UTC)
 * @param resetHour - Hour of day for reset in PATIENT'S LOCAL TIME (default: 7)
 * @param timezoneOffsetMinutes - Patient's timezone offset from UTC in minutes (default: 0)
 * @returns true if within 1 minute of reset time
 *
 * @example
 * // At 7:00 AM EST -> true (within 1 minute of reset)
 * // At 6:59 AM EST -> false
 * // At 7:01 AM EST -> false (more than 1 minute after reset)
 * const atReset = isAtResetTime(Date.now(), 7, -300);
 *
 * // Legacy usage (no timezone) still works:
 * const atReset = isAtResetTime(Date.now()); // Uses 7 AM UTC
 */
export function isAtResetTime(
  currentTimestamp: number,
  resetHour: number = 7,
  timezoneOffsetMinutes: number = 0
): boolean {
  // Convert to patient's local time
  const offsetMs = timezoneOffsetMinutes * 60 * 1000;
  const currentLocal = new Date(currentTimestamp + offsetMs);

  // UTC method — immune to JS runtime local timezone (see §M-7 fix)
  const hours = currentLocal.getUTCHours();
  // UTC method — immune to JS runtime local timezone (see §M-7 fix)
  const minutes = currentLocal.getUTCMinutes();

  // Check if it's at reset hour (within 1 minute)
  return hours === resetHour && minutes === 0;
}

/**
 * ========================================================================
 * PHARMACODYNAMICS UTILITIES (Consolidated from duplicate code)
 * ========================================================================
 *
 * These utilities support common patterns in insulin and meal calculations.
 * Added in v3.2 to eliminate duplicate code across pharmacodynamics modules.
 *
 * CRITICAL FIX v3.3: parseTimestamp was renamed to parseTimestampRaw to
 * avoid shadowing the comprehensive parseTimestamp method above.
 * parseAndNormalize now correctly delegates to parseTimestampRaw + normalize.
 */

/**
 * Parse any timestamp format to milliseconds (RAW - no normalization)
 *
 * This is the SIMPLE parser for pharmacodynamic calculations where you
 * just need a numeric millisecond value without precision normalization.
 * For precision-aware parsing, use parseTimestamp() instead.
 *
 * RENAMED in v3.3 from parseTimestamp to parseTimestampRaw to resolve
 * the method shadowing bug where this simple version was overwriting
 * the comprehensive version above.
 *
 * FIX v4.3: Bare ISO strings (no 'Z', no '+', no offset) are now treated
 * as UTC, not browser local time. The backend stores all timestamps in UTC
 * and omits the 'Z' suffix. Previously, `new Date('2024-01-01T12:00:00')`
 * was parsed as local time, introducing a timezone offset into every IOB/MOB
 * calculation (e.g. hoursSinceDose wrong by ±2 hours in UTC+2 environments).
 * This matches the existing behaviour of the comprehensive parseTimestamp().
 *
 * @example
 * parseTimestampRaw(1234567890000) // -> 1234567890000
 * parseTimestampRaw('2024-01-01T12:00:00Z') // -> milliseconds (UTC)
 * parseTimestampRaw('2024-01-01T12:00:00')  // -> milliseconds (UTC, no local shift)
 * parseTimestampRaw(new Date()) // -> milliseconds
 */
export function parseTimestampRaw(timestamp: TimeInput): number {
  if (typeof timestamp === 'number') return timestamp;
  if (timestamp instanceof Date) return timestamp.getTime();
  if (typeof timestamp === 'string') {
    // If the string already carries timezone info, let Date parse it normally.
    // If it has no timezone (no 'Z', no '+hh:mm', no '-hh:mm' after position 10),
    // treat it as UTC by appending 'Z' — the backend stores timestamps in UTC
    // without the suffix and browsers would otherwise shift by local offset.
    const hasTimezone = timestamp.endsWith('Z') ||
                        timestamp.includes('+') ||
                        /T.*-\d{2}:\d{2}$/.test(timestamp);
    if (!hasTimezone && (timestamp.includes('T') || timestamp.includes(' '))) {
      // Normalise space-separated datetime to ISO before appending Z
      return new Date(timestamp.replace(' ', 'T') + 'Z').getTime();
    }
    return new Date(timestamp).getTime();
  }
  console.warn('Invalid timestamp format:', timestamp);
  return Date.now();
}

/**
 * Parse and normalize timestamp in one step
 * Combines parseTimestampRaw() and normalize() for convenience
 *
 * @example
 * // Parse and normalize to minute boundary
 * const ts = parseAndNormalize('2024-01-01T12:34:56Z', precision.MINUTE);
 */
export function parseAndNormalize(timestamp: TimeInput, precisionLevel: PrecisionLevel = precision.SECOND): number {
  const ts = parseTimestampRaw(timestamp);
  return normalize(ts, precisionLevel);
}

/**
 * Check if an effect (insulin or meal) is still active
 * Generic utility for pharmacodynamic calculations
 *
 * @example
 * const insulinProfile = { duration_hours: 4 };
 * const isActive = isEffectActive(2.5, insulinProfile); // true
 */
export function isEffectActive(hoursSince: number, profile: PharmacodynamicProfile | null | undefined): boolean {
  if (!profile || typeof profile.duration_hours !== 'number') {
    return false;
  }
  return hoursSince >= 0 && hoursSince <= profile.duration_hours;
}

/**
 * Get duration from any pharmacodynamic profile
 *
 * @example
 * const profile = { duration_hours: 6 };
 * const duration = getProfileDuration(profile); // 6
 */
export function getProfileDuration(profile: PharmacodynamicProfile | null | undefined): number {
  return profile?.duration_hours || 0;
}

/**
 * Get time to peak from any pharmacodynamic profile
 *
 * @example
 * const profile = { peak_hours: 1.5 };
 * const peak = getProfilePeakTime(profile); // 1.5
 */
export function getProfilePeakTime(profile: PharmacodynamicProfile | null | undefined): number {
  return profile?.peak_hours || 0;
}

/**
 * ========================================================================
 * DEFAULT EXPORT (for backward compatibility)
 * ========================================================================
 */

const TimeManager = {
  formats,
  constants,
  precision,
  normalizeToMillisecondBoundary,
  normalizeToSecondBoundary,
  normalizeToMinuteBoundary,
  normalizeToHourBoundary,
  normalize,
  calculateHoursSinceWithSecondPrecision,
  calculateHoursSinceWithMinutePrecision,
  calculateHoursSince,
  calculateMinutesSince,
  getCurrentTime,
  getCurrentTimeISOString,
  getCurrentTimeNormalizedISO,
  parseTimestamp,
  isValidTimestamp,
  formatDateTimeLocal,
  formatDate,
  formatTime,
  formatRelativeTime,
  // FIX v4.1: formatDateTimeDisplay added — resolves runtime crash in History screen
  // "TypeError: TimeManager.formatDateTimeDisplay is not a function"
  formatDateTimeDisplay,
  // FIX v4.2: formatTimeDisplay added — resolves runtime crash in UnifiedActivityInput
  // "TypeError: TimeManager.formatTimeDisplay is not a function"
  formatTimeDisplay,
  getUserTimeZone,
  utcToLocal,
  localToUtc,
  utcToLocalString,
  localToUTCISOString,
  utcToLocalIsoString,
  calculateDuration,
  durationToHours,
  hoursToTimeString,
  addHours,
  generateTimeTicks,
  formatAxisTick,
  getTimeScaleForRange,
  isTimeInRange,
  getSystemDateTime,
  getCurrentUserLogin,
  getTimePointHoursAgo,
  getFutureProjectionTime,
  formatDateTime,
  debugTimestamp,
  logNormalizationComparison,
  getDailyResetTime,
  isWithinCurrentDay,
  isAtResetTime,
  parseTimestampRaw,
  parseAndNormalize,
  isEffectActive,
  getProfileDuration,
  getProfilePeakTime
};

export default TimeManager;