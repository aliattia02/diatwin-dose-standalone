/**
 * ============================================================================
 * TIME MANAGER - ENHANCED WITH TIMEZONE SUPPORT
 * ============================================================================
 *
 * Centralized utility for ALL time-related operations across the application.
 *
 * KEY FEATURES:
 * - Timestamp normalization (millisecond, second, minute boundaries)
 * - Precision-aware time calculations
 * - UTC/Local timezone conversions
 * - Time formatting and parsing
 * - Duration calculations
 * - Relative time formatting
 * - 🆕 v4.3 - Timezone detection and management (merged from timezoneUtils)
 * - Cumulative effects utilities (daily reset logic)
 *
 * USAGE GUIDELINES:
 * 1. ALWAYS use TimeManager for time operations - DO NOT use Date directly
 * 2. Use normalized timestamps for consistency across calculations
 * 3. Store times in UTC, display in local timezone
 * 4. Use second precision for pharmacodynamic calculations
 * 5. Use minute boundary for user-facing timestamps
 * 6. Use timezone utilities for patient-specific timezone handling
 *
 * VERSION HISTORY:
 * v4.3 - 🔧 TIMEZONE FIX: Merged timezone detection utilities for FE/BE alignment
 * v4.0 - Added user-configurable daily reset hour support
 * v3.3 - CRITICAL FIX: Resolved parseTimestamp shadowing
 * v3.2 - Added pharmacodynamics utilities
 * v3.1 - Added cumulative effects utilities
 * v3.0 - Enhanced with comprehensive normalization
 *
 * Author: DiaTwin Team
 * Version: 4.3 (Timezone Alignment Fix)
 * ============================================================================
 */

class TimeManager {
  /**
   * ========================================================================
   * CONSTANTS
   * ========================================================================
   */

  static formats = {
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
  };

  static constants = {
    MILLISECONDS_PER_SECOND: 1000,
    MILLISECONDS_PER_MINUTE: 60 * 1000,
    MILLISECONDS_PER_HOUR: 60 * 60 * 1000,
    MILLISECONDS_PER_DAY: 24 * 60 * 60 * 1000,
    SECONDS_PER_MINUTE: 60,
    SECONDS_PER_HOUR: 3600,
    MINUTES_PER_HOUR: 60,
    HOURS_PER_DAY: 24
  };

  static precision = {
    MILLISECOND: 'millisecond',
    SECOND: 'second',
    MINUTE: 'minute',
    HOUR: 'hour'
  };

  /**
   * ========================================================================
   * TIMEZONE UTILITIES (🆕 v4.3 - Merged from timezoneUtils.js)
   * ========================================================================
   *
   * Auto-detect and manage patient timezone for frontend/backend alignment.
   *
   * CRITICAL: JavaScript's Date.getTimezoneOffset() returns NEGATIVE of
   * standard offset (e.g., UTC+2 returns -120). We negate it to get
   * standard offset for backend use.
   */

  /**
   * Get the current timezone offset in minutes (standard format: positive = east of UTC)
   *
   * @returns {number} Timezone offset in minutes
   *
   * @example
   * // Browser in UTC+2 (Egypt, Eastern Europe)
   * TimeManager.getTimezoneOffsetMinutes() // Returns: 120
   *
   * // Browser in UTC-5 (US Eastern Standard Time)
   * TimeManager.getTimezoneOffsetMinutes() // Returns: -300
   *
   * // Browser in UTC
   * TimeManager.getTimezoneOffsetMinutes() // Returns: 0
   */
  static getTimezoneOffsetMinutes() {
    // JavaScript returns NEGATIVE of standard offset (UTC+2 = -120)
    // We negate to get standard format (UTC+2 = +120)
    return -new Date().getTimezoneOffset();
  }

  /**
   * Get timezone offset in hours (for display purposes)
   *
   * @returns {number} Timezone offset in hours (rounded to 1 decimal)
   *
   * @example
   * // Browser in UTC+2
   * TimeManager.getTimezoneOffsetHours() // Returns: 2.0
   *
   * // Browser in UTC+5:30 (India)
   * TimeManager.getTimezoneOffsetHours() // Returns: 5.5
   */
  static getTimezoneOffsetHours() {
    const minutes = this.getTimezoneOffsetMinutes();
    return Math.round((minutes / 60) * 10) / 10;
  }

  /**
   * Get formatted timezone string for display
   *
   * @returns {string} Timezone string (e.g., "UTC+2", "UTC-5", "UTC+0")
   *
   * @example
   * // Browser in UTC+2
   * TimeManager.getTimezoneString() // Returns: "UTC+2"
   *
   * // Browser in UTC-5
   * TimeManager.getTimezoneString() // Returns: "UTC-5"
   */
  static getTimezoneString() {
    const hours = this.getTimezoneOffsetHours();
    const sign = hours >= 0 ? '+' : '';
    return `UTC${sign}${hours}`;
  }

  /**
   * Get comprehensive timezone information
   *
   * @returns {object} Timezone data object
   *
   * @example
   * TimeManager.getTimezoneInfo()
   * // Returns:
   * // {
   * //   offset_minutes: 120,
   * //   offset_hours: 2.0,
   * //   timezone_string: "UTC+2",
   * //   browser_timezone: "Africa/Cairo",
   * //   is_dst: false
   * // }
   */
  static getTimezoneInfo() {
    const offset_minutes = this.getTimezoneOffsetMinutes();
    const offset_hours = this.getTimezoneOffsetHours();

    // Try to get IANA timezone name (e.g., "Africa/Cairo", "America/New_York")
    let browser_timezone = 'Unknown';
    try {
      browser_timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (error) {
      console.warn('Could not detect IANA timezone:', error);
    }

    // Check if DST is active (offset changes between January and July)
    const jan = new Date(new Date().getFullYear(), 0, 1);
    const jul = new Date(new Date().getFullYear(), 6, 1);
    const is_dst = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset()) !== new Date().getTimezoneOffset();

    return {
      offset_minutes,
      offset_hours,
      timezone_string: this.getTimezoneString(),
      browser_timezone,
      is_dst
    };
  }

  /**
   * Save timezone offset to patient constants
   *
   * This should be called:
   * 1. On user registration
   * 2. On first login if not already set
   * 3. Periodically (e.g., daily) to detect timezone changes (travel, DST)
   *
   * @param {object} api - API instance with authentication
   * @returns {Promise<object>} Updated patient constants
   *
   * @example
   * const updatedConstants = await TimeManager.saveTimezoneToConstants(api);
   * console.log('Timezone saved:', updatedConstants.timezone_offset_minutes);
   */
  static async saveTimezoneToConstants(api) {
    const timezone_offset_minutes = this.getTimezoneOffsetMinutes();

    try {
      const response = await api.patch('/api/patient-constants', {
        timezone_offset_minutes
      });

      console.log(
        `✅ Timezone saved: ${this.getTimezoneString()} (${timezone_offset_minutes} minutes)`
      );

      return response.data;
    } catch (error) {
      console.error('Failed to save timezone offset:', error);
      throw error;
    }
  }

  /**
   * Check if timezone has changed and update if needed
   *
   * Useful for detecting:
   * - User traveling to different timezone
   * - Daylight saving time changes
   * - User moving permanently
   *
   * @param {number} storedOffsetMinutes - Current offset in patient constants
   * @param {object} api - API instance
   * @returns {Promise<boolean>} True if timezone was updated
   *
   * @example
   * const wasUpdated = await TimeManager.checkAndUpdateTimezone(
   *   patientConstants.timezone_offset_minutes,
   *   api
   * );
   *
   * if (wasUpdated) {
   *   console.log('Timezone changed! Refreshing data...');
   * }
   */
  static async checkAndUpdateTimezone(storedOffsetMinutes, api) {
    const currentOffsetMinutes = this.getTimezoneOffsetMinutes();

    if (currentOffsetMinutes !== storedOffsetMinutes) {
      const oldString = `UTC${storedOffsetMinutes >= 0 ? '+' : ''}${storedOffsetMinutes / 60}`;
      const newString = this.getTimezoneString();

      console.warn(
        `⚠️ Timezone changed: ${oldString} → ${newString}\n` +
        `   Updating patient constants...`
      );

      await this.saveTimezoneToConstants(api);
      return true;
    }

    return false;
  }

  /**
   * ========================================================================
   * TIMESTAMP NORMALIZATION
   * ========================================================================
   */

  /**
   * Normalize timestamp to millisecond boundary (no change, just validation)
   * Use this when you need full precision (rare in diabetes management)
   *
   * @param {number} timestamp - Timestamp in milliseconds
   * @returns {number} Same timestamp (validated)
   */
  static normalizeToMillisecondBoundary(timestamp) {
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
   *
   * @param {number} timestamp - Timestamp in milliseconds
   * @returns {number} Normalized timestamp at second boundary
   */
  static normalizeToSecondBoundary(timestamp) {
    const ts = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();

    if (isNaN(ts)) {
      console.warn('Invalid timestamp for second normalization:', timestamp);
      return Math.floor(Date.now() / this.constants.MILLISECONDS_PER_SECOND) * this.constants.MILLISECONDS_PER_SECOND;
    }

    // Remove milliseconds by flooring to seconds then converting back
    return Math.floor(ts / this.constants.MILLISECONDS_PER_SECOND) * this.constants.MILLISECONDS_PER_SECOND;
  }

  /**
   * Normalize timestamp to minute boundary (remove seconds and milliseconds)
   * Use this for user-facing timestamps, baseline calculations
   *
   * @param {number} timestamp - Timestamp in milliseconds
   * @returns {number} Normalized timestamp at minute boundary
   */
  static normalizeToMinuteBoundary(timestamp) {
    const ts = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();

    if (isNaN(ts)) {
      console.warn('Invalid timestamp for minute normalization:', timestamp);
      const now = Date.now();
      return Math.floor(now / this.constants.MILLISECONDS_PER_MINUTE) * this.constants.MILLISECONDS_PER_MINUTE;
    }

    // Remove seconds and milliseconds
    return Math.floor(ts / this.constants.MILLISECONDS_PER_MINUTE) * this.constants.MILLISECONDS_PER_MINUTE;
  }

  /**
   * Normalize timestamp to hour boundary (remove minutes, seconds, milliseconds)
   * Use this for hourly aggregations, long-term trends
   *
   * @param {number} timestamp - Timestamp in milliseconds
   * @returns {number} Normalized timestamp at hour boundary
   */
  static normalizeToHourBoundary(timestamp) {
    const ts = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();

    if (isNaN(ts)) {
      console.warn('Invalid timestamp for hour normalization:', timestamp);
      const now = Date.now();
      return Math.floor(now / this.constants.MILLISECONDS_PER_HOUR) * this.constants.MILLISECONDS_PER_HOUR;
    }

    // Remove minutes, seconds, and milliseconds
    return Math.floor(ts / this.constants.MILLISECONDS_PER_HOUR) * this.constants.MILLISECONDS_PER_HOUR;
  }

  /**
   * Normalize timestamp using specified precision
   *
   * @param {number} timestamp - Timestamp in milliseconds
   * @param {string} precision - Precision level (from TimeManager.precision)
   * @returns {number} Normalized timestamp
   */
  static normalize(timestamp, precision = this.precision.SECOND) {
    switch (precision) {
      case this.precision.MILLISECOND:
        return this.normalizeToMillisecondBoundary(timestamp);
      case this.precision.SECOND:
        return this.normalizeToSecondBoundary(timestamp);
      case this.precision.MINUTE:
        return this.normalizeToMinuteBoundary(timestamp);
      case this.precision.HOUR:
        return this.normalizeToHourBoundary(timestamp);
      default:
        console.warn('Unknown precision:', precision, '- using SECOND');
        return this.normalizeToSecondBoundary(timestamp);
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
   *
   * @param {number} currentTime - Current timestamp (ms)
   * @param {number} eventTime - Event timestamp (ms)
   * @returns {number} Hours since event (rounded to nearest second = 6 decimal places)
   */
  static calculateHoursSinceWithSecondPrecision(currentTime, eventTime) {
    const currentSeconds = Math.floor(currentTime / this.constants.MILLISECONDS_PER_SECOND);
    const eventSeconds = Math.floor(eventTime / this.constants.MILLISECONDS_PER_SECOND);
    const secondsDiff = currentSeconds - eventSeconds;

    return secondsDiff / this.constants.SECONDS_PER_HOUR;
  }

  /**
   * Calculate hours since event with MINUTE precision
   * USE THIS for user-facing displays
   *
   * @param {number} currentTime - Current timestamp (ms)
   * @param {number} eventTime - Event timestamp (ms)
   * @returns {number} Hours since event (rounded to nearest minute)
   */
  static calculateHoursSinceWithMinutePrecision(currentTime, eventTime) {
    const currentMinutes = Math.floor(currentTime / this.constants.MILLISECONDS_PER_MINUTE);
    const eventMinutes = Math.floor(eventTime / this.constants.MILLISECONDS_PER_MINUTE);
    const minutesDiff = currentMinutes - eventMinutes;

    return minutesDiff / this.constants.MINUTES_PER_HOUR;
  }

  /**
   * Calculate hours since event with specified precision
   *
   * @param {number} currentTime - Current timestamp (ms)
   * @param {number} eventTime - Event timestamp (ms)
   * @param {string} precision - Precision level
   * @returns {number} Hours since event
   */
  static calculateHoursSince(currentTime, eventTime, precision = this.precision.SECOND) {
    switch (precision) {
      case this.precision.SECOND:
        return this.calculateHoursSinceWithSecondPrecision(currentTime, eventTime);
      case this.precision.MINUTE:
        return this.calculateHoursSinceWithMinutePrecision(currentTime, eventTime);
      case this.precision.MILLISECOND:
        return (currentTime - eventTime) / this.constants.MILLISECONDS_PER_HOUR;
      default:
        return this.calculateHoursSinceWithSecondPrecision(currentTime, eventTime);
    }
  }

  /**
   * Calculate minutes since event with specified precision
   *
   * @param {number} currentTime - Current timestamp (ms)
   * @param {number} eventTime - Event timestamp (ms)
   * @param {string} precision - Precision level
   * @returns {number} Minutes since event
   */
  static calculateMinutesSince(currentTime, eventTime, precision = this.precision.SECOND) {
    return this.calculateHoursSince(currentTime, eventTime, precision) * this.constants.MINUTES_PER_HOUR;
  }

  /**
   * ========================================================================
   * CURRENT TIME GETTERS (WITH NORMALIZATION)
   * ========================================================================
   */

  /**
   * Get current time normalized to specified precision
   *
   * @param {string} precision - Precision level
   * @returns {number} Normalized current timestamp
   */
  static getCurrentTime(precision = this.precision.SECOND) {
    return this.normalize(Date.now(), precision);
  }

  /**
   * Get current time as ISO string for datetime-local input
   * Format: YYYY-MM-DDTHH:MM in local timezone
   *
   * @returns {string} ISO datetime string in local timezone
   */
  static getCurrentTimeISOString() {
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
   *
   * @returns {string} ISO datetime string at minute boundary
   */
  static getCurrentTimeNormalizedISO() {
    const normalized = this.normalizeToMinuteBoundary(Date.now());
    return this.formatDateTimeLocal(new Date(normalized));
  }

  /**
   * ========================================================================
   * TIMESTAMP PARSING AND VALIDATION
   * ========================================================================
   */

  /**
   * Parse timestamp safely with normalization
   *
   * Handles all input types (number, string, Date) and normalizes
   * to the requested precision. This is the PRIMARY parsing method
   * and should be used throughout the application.
   *
   * @param {string|Date|number} timestamp - Timestamp to parse
   * @param {string} precision - Normalization precision (default: SECOND)
   * @returns {number} Parsed and normalized timestamp in milliseconds
   */
  static parseTimestamp(timestamp, precision = this.precision.SECOND) {
    if (!timestamp) {
      return this.getCurrentTime(precision);
    }

    if (timestamp instanceof Date) {
      return this.normalize(timestamp.getTime(), precision);
    }

    if (typeof timestamp === 'number') {
      return this.normalize(timestamp, precision);
    }

    try {
      // Handle ISO strings with timezone info
      if (typeof timestamp === 'string') {
        if (timestamp.endsWith('Z') || timestamp.includes('+') || timestamp.includes('-', 10)) {
          return this.normalize(new Date(timestamp).getTime(), precision);
        } else {
          // No timezone info - treat as UTC
          const [datePart, timePart] = timestamp.includes('T')
            ? timestamp.split('T')
            : [timestamp.split(' ')[0], timestamp.split(' ')[1] || '00:00:00'];

          if (!datePart) {
            return this.getCurrentTime(precision);
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

          return this.normalize(date.getTime(), precision);
        }
      }

      return this.normalize(new Date(timestamp).getTime(), precision);
    } catch (error) {
      console.error('Error parsing timestamp:', error, timestamp);
      return this.getCurrentTime(precision);
    }
  }

  /**
   * Validate timestamp
   *
   * @param {any} timestamp - Value to validate
   * @returns {boolean} True if valid timestamp
   */
  static isValidTimestamp(timestamp) {
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
   *
   * @param {Date|number|string} date - Date to format
   * @returns {string} Formatted datetime string
   */
  static formatDateTimeLocal(date) {
    if (!date) date = new Date();

    const d = date instanceof Date ? date : new Date(date);

    if (isNaN(d.getTime())) {
      console.warn('Invalid date for formatDateTimeLocal:', date);
      return this.getCurrentTimeISOString();
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
   *
   * @param {Date|number|string} date - Date to format
   * @param {string} format - Format string
   * @returns {string} Formatted date string
   */
  static formatDate(date, format) {
    if (!date) return '';
    if (!format) format = this.formats.DATETIME_DISPLAY;

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
      .replace('YYYY', year)
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
   *
   * @param {string|Date|number} timestamp - Timestamp to format
   * @returns {string} Time in HH:MM format
   */
  static formatTime(timestamp) {
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
   *
   * @param {string|Date|number} timestamp - Timestamp to format
   * @returns {string} Human-readable relative time
   */
  static formatRelativeTime(timestamp) {
    if (!timestamp) return '';

    try {
      const date = this.parseTimestamp(timestamp, this.precision.SECOND);
      const now = this.getCurrentTime(this.precision.SECOND);

      if (isNaN(date)) return '';

      const diffMs = now - date;

      if (diffMs < 0) return 'in the future';
      if (diffMs < this.constants.MILLISECONDS_PER_MINUTE) return 'just now';

      if (diffMs < this.constants.MILLISECONDS_PER_HOUR) {
        const mins = Math.floor(diffMs / this.constants.MILLISECONDS_PER_MINUTE);
        return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`;
      }

      if (diffMs < this.constants.MILLISECONDS_PER_DAY) {
        const hours = Math.floor(diffMs / this.constants.MILLISECONDS_PER_HOUR);
        return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
      }

      if (diffMs < 7 * this.constants.MILLISECONDS_PER_DAY) {
        const days = Math.floor(diffMs / this.constants.MILLISECONDS_PER_DAY);
        return `${days} ${days === 1 ? 'day' : 'days'} ago`;
      }

      return this.formatDate(new Date(date), this.formats.DATETIME_DISPLAY);
    } catch (error) {
      console.error('Error formatting relative time:', error);
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
   *
   * @returns {string} User's timezone (e.g., "America/New_York")
   */
  static getUserTimeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /**
   * Convert UTC timestamp to local timezone
   *
   * @param {number|string|Date} utcTime - UTC timestamp
   * @returns {Date} Date object in local timezone
   */
  static utcToLocal(utcTime) {
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
   *
   * @param {number|string|Date} localTime - Local timestamp
   * @returns {Date} Date object in UTC
   */
  static localToUtc(localTime) {
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
   *
   * @param {string} utcIsoString - UTC ISO string
   * @returns {string} Local datetime in YYYY-MM-DDTHH:mm format
   */
  static utcToLocalString(utcIsoString) {
    if (!utcIsoString) return '';

    try {
      const date = new Date(utcIsoString);
      return this.formatDateTimeLocal(date);
    } catch (error) {
      console.error('Error converting UTC to local time:', error);
      return '';
    }
  }

  /**
   * Convert local datetime to UTC ISO string
   *
   * @param {string} localDateTimeString - Local datetime string
   * @returns {string} UTC ISO string
   */
  static localToUTCISOString(localDateTimeString) {
    if (!localDateTimeString) return new Date().toISOString();

    const localDate = new Date(localDateTimeString);
    return localDate.toISOString();
  }

  /**
   * Alias for backwards compatibility
   */
  static utcToLocalIsoString(utcIsoString) {
    return this.utcToLocalString(utcIsoString);
  }

  /**
   * ========================================================================
   * DURATION CALCULATIONS
   * ========================================================================
   */

  /**
   * Calculate duration between two timestamps
   *
   * @param {number|string|Date} startTime - Start timestamp
   * @param {number|string|Date} endTime - End timestamp
   * @returns {object} Duration breakdown
   */
  static calculateDuration(startTime, endTime) {
    if (!startTime || !endTime) {
      return { hours: 0, minutes: 0, totalHours: 0, formatted: "0h 0m" };
    }

    try {
      const start = new Date(startTime);
      const end = new Date(endTime);
      const durationMs = Math.max(0, end - start);

      const totalMinutes = durationMs / this.constants.MILLISECONDS_PER_MINUTE;
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
   *
   * @param {number|string} duration - Duration (hours or HH:MM format)
   * @returns {number} Duration in hours
   */
  static durationToHours(duration) {
    if (typeof duration === 'number') return duration;

    if (typeof duration === 'string' && duration.includes(':')) {
      const [hours, minutes] = duration.split(':').map(num => parseInt(num, 10) || 0);
      return hours + (minutes / 60);
    }

    return parseFloat(duration) || 0;
  }

  /**
 * Convert a decimal hours value to an "HH:MM" duration string
 * Inverse of durationToHours()
 *
 * @param {number} totalHours - Duration in decimal hours (e.g. 1.5)
 * @returns {string} Duration string in "HH:MM" format (e.g. "01:30")
 *
 * @example
 * TimeManager.hoursToTimeString(1.5)   // "01:30"
 * TimeManager.hoursToTimeString(0.25)  // "00:15"
 * TimeManager.hoursToTimeString(2)     // "02:00"
 */
static hoursToTimeString(totalHours) {
  const safeHours = typeof totalHours === 'number' && !isNaN(totalHours)
    ? Math.max(0, totalHours)
    : 0;
  const hours   = Math.floor(safeHours);
  const minutes = Math.round((safeHours - hours) * 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

  /**
   * Add hours to a date
   *
   * @param {Date|number|string} date - Date to modify
   * @param {number} hours - Hours to add (negative to subtract)
   * @returns {Date} New date with hours added
   */
  static addHours(date, hours) {
    const d = date instanceof Date ? date : new Date(date);
    return new Date(d.getTime() + hours * this.constants.MILLISECONDS_PER_HOUR);
  }

  /**
   * Add minutes to a date
   *
   * @param {Date|number|string} date - Date to modify
   * @param {number} minutes - Minutes to add (negative to subtract)
   * @returns {Date} New date with minutes added
   */
  static addMinutes(date, minutes) {
    const d = date instanceof Date ? date : new Date(date);
    return new Date(d.getTime() + minutes * this.constants.MILLISECONDS_PER_MINUTE);
  }

  /**
   * Add days to a date
   *
   * @param {Date|number|string} date - Date to modify
   * @param {number} days - Days to add (negative to subtract)
   * @returns {Date} New date with days added
   */
  static addDays(date, days) {
    const d = date instanceof Date ? date : new Date(date);
    return new Date(d.getTime() + days * this.constants.MILLISECONDS_PER_DAY);
  }

  /**
   * ========================================================================
   * CHART / VISUALIZATION HELPERS
   * ========================================================================
   */

  /**
   * Generate time ticks for chart X-axis
   *
   * @param {number} startTime - Start timestamp in milliseconds
   * @param {number} endTime - End timestamp in milliseconds
   * @param {number} tickInterval - Hours between ticks
   * @returns {number[]} Array of timestamp ticks
   */
  static generateTimeTicks(startTime, endTime, tickInterval = 12) {
    if (!startTime || !endTime) {
      console.warn('Invalid time range for ticks generation', { startTime, endTime });
      return [];
    }

    const ticksArray = [];
    const start = new Date(startTime);
    start.setMinutes(0, 0, 0);

    let current = start.getTime();
    const intervalMs = tickInterval * this.constants.MILLISECONDS_PER_HOUR;

    while (current <= endTime) {
      ticksArray.push(current);
      current += intervalMs;
    }

    return ticksArray;
  }

  /**
   * Format timestamp for X-axis display
   *
   * @param {number} timestamp - Timestamp in milliseconds
   * @param {string} format - Format string
   * @returns {string} Formatted date string
   */
  static formatAxisTick(timestamp, format) {
    const formatString = this.formats[format] || format || this.formats.DATETIME_DISPLAY;
    return this.formatDate(timestamp, formatString);
  }

  /**
   * Determine time scale settings based on date range
   *
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @returns {object} Time scale settings
   */
  static getTimeScaleForRange(startDate, endDate) {
    if (!startDate || !endDate) {
      console.warn('Invalid date range for time scale', { startDate, endDate });
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * this.constants.MILLISECONDS_PER_DAY);

      return this.getTimeScaleForRange(
        this.formatDate(weekAgo, this.formats.DATE),
        this.formatDate(now, this.formats.DATE)
      );
    }

    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);

    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const diffDays = (end - start) / this.constants.MILLISECONDS_PER_DAY;

    let tickInterval, tickFormat;

    if (diffDays <= 1) {
      tickInterval = 2;
      tickFormat = this.formats.CHART_TICKS_SHORT;
    } else if (diffDays <= 7) {
      tickInterval = 12;
      tickFormat = this.formats.CHART_TICKS_MEDIUM;
    } else {
      tickInterval = 24;
      tickFormat = this.formats.CHART_TICKS_LONG;
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
   *
   * @param {number} timestamp - Timestamp to check
   * @param {number} startTime - Range start
   * @param {number} endTime - Range end
   * @returns {boolean} True if in range
   */
  static isTimeInRange(timestamp, startTime, endTime) {
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
   *
   * @param {string|null} format - Optional format override
   * @returns {string} System date/time
   */
  static getSystemDateTime(format = null) {
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
        parseInt(seconds || 0)
      ));

      return this.formatDate(date, format);
    } catch (e) {
      console.error('Error parsing system time:', e);
      return systemTime;
    }
  }

  /**
   * Get current user login
   *
   * @returns {string} Current user's login ID
   */
  static getCurrentUserLogin() {
    return "aliattia02";
  }

  /**
   * ========================================================================
   * UTILITY FUNCTIONS
   * ========================================================================
   */

  /**
   * Get time point hours ago
   *
   * @param {number} hoursAgo - Hours in the past
   * @returns {string} ISO datetime string
   */
  static getTimePointHoursAgo(hoursAgo) {
    const date = this.addHours(new Date(), -hoursAgo);
    return this.formatDateTimeLocal(date);
  }

  /**
   * Get future projection time
   *
   * @param {number} futureHours - Hours into future (default: 7)
   * @returns {number} Future timestamp
   */
  static getFutureProjectionTime(futureHours = 7) {
    const now = new Date();
    return this.addHours(now, futureHours).getTime();
  }

  /**
   * Format datetime for display
   *
   * @param {string|Date|number} isoString - ISO string or timestamp
   * @returns {string} Formatted datetime
   */
  static formatDateTime(isoString) {
    if (!isoString) return '';

    try {
      const date = this.parseTimestamp(isoString);
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
   *
   * @param {number} timestamp - Timestamp to analyze
   * @returns {object} Detailed breakdown
   */
  static debugTimestamp(timestamp) {
    const original = timestamp;
    const asMillisecond = this.normalizeToMillisecondBoundary(timestamp);
    const asSecond = this.normalizeToSecondBoundary(timestamp);
    const asMinute = this.normalizeToMinuteBoundary(timestamp);
    const asHour = this.normalizeToHourBoundary(timestamp);

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
   *
   * @param {number} timestamp - Timestamp to analyze
   */
  static logNormalizationComparison(timestamp) {
    const debug = this.debugTimestamp(timestamp);
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
   * daily at a configured hour (default 7 AM). Used by bloodGlucoseEstimationService
   * and netEffectCalculationService.
   *
   * 🆕 v4.3 - Now matches backend behavior exactly by using local time
   */

  /**
   * Get the most recent daily reset time
   * Used for calculating cumulative effects (IOB/MOB) that reset daily
   *
   * CRITICAL: Must match backend time_manager.py getDailyResetTime logic
   *
   * @param {number} currentTimestamp - Current time in milliseconds
   * @param {number} [resetHour=7] - Hour of day for reset (0-23). Defaults to 7 AM.
   * @returns {number} Reset time in milliseconds
   *
   * @example
   * // Using default 7 AM reset
   * // At 10:30 AM on Jan 5, returns 7:00 AM on Jan 5
   * // At 6:30 AM on Jan 5, returns 7:00 AM on Jan 4
   * const resetTime = TimeManager.getDailyResetTime(Date.now());
   *
   * // Using custom 9 AM reset for night owl patient
   * const resetTime = TimeManager.getDailyResetTime(Date.now(), 9);
   */
  static getDailyResetTime(currentTimestamp, resetHour = 7, tzOffsetMinutes = null) {
    // Validate resetHour (must be 0-23)
    const validResetHour = (typeof resetHour === 'number' && resetHour >= 0 && resetHour <= 23) ? resetHour : 7;

    if (validResetHour !== resetHour) {
      console.warn(`Invalid resetHour ${resetHour}, using default 7`);
    }

    // Determine effective timezone offset in minutes.
    // If not supplied, fall back to the browser's own offset (already in local time).
    // Note: getTimezoneOffset() returns minutes BEHIND UTC (e.g. UTC+2 → -120),
    // so we negate it to get the conventional "UTC+X" sign.
    const effectiveTzOffset = (tzOffsetMinutes != null)
      ? tzOffsetMinutes
      : -(new Date(currentTimestamp).getTimezoneOffset());

    // Convert current timestamp to the patient's local time
    const utcMs = (currentTimestamp instanceof Date) ? currentTimestamp.getTime() : currentTimestamp;
    const localMs = utcMs + effectiveTzOffset * 60 * 1000;
    const localDate = new Date(localMs);

    // Build reset time in local-equivalent ms
    const resetLocal = new Date(localMs);
    resetLocal.setUTCHours(validResetHour, 0, 0, 0);

    // If current local time is before reset hour today, use yesterday's reset
    if (localDate < resetLocal) {
      resetLocal.setUTCDate(resetLocal.getUTCDate() - 1);
    }

    // Convert back to real UTC ms
    return resetLocal.getTime() - effectiveTzOffset * 60 * 1000;
  }

  /**
   * Check if a dose/meal should be included in cumulative calculation
   * Only include doses AFTER the most recent reset hour (not AT reset hour)
   *
   * CRITICAL: Doses exactly at reset hour are EXCLUDED to ensure clean reset
   *
   * @param {number} doseTimestamp - Timestamp of dose/meal in milliseconds
   * @param {number} currentTimestamp - Current time in milliseconds
   * @param {number} [resetHour=7] - Hour of day for reset (0-23). Defaults to 7 AM
   * @returns {boolean} True if dose is within current day (after reset hour)
   *
   * @example
   * // Using default 7 AM reset
   * // Meal at 8:00 AM, checked at 10:00 AM -> true (after 7 AM)
   * // Meal at 6:00 AM, checked at 10:00 AM -> false (before 7 AM)
   * // Meal at 7:00 AM exactly -> false (excluded for clean reset)
   * const isValid = TimeManager.isWithinCurrentDay(mealTime, Date.now());
   */
  static isWithinCurrentDay(doseTimestamp, currentTimestamp, resetHour = 7, tzOffsetMinutes = null) {
    const resetTime = this.getDailyResetTime(currentTimestamp, resetHour, tzOffsetMinutes);
    // Use > instead of >= to exclude doses exactly at reset time
    return doseTimestamp > resetTime;
  }

  /**
   * Check if current time is exactly at or very close to reset point
   * Returns true if within 1 minute of configured reset hour
   *
   * @param {number} currentTimestamp - Current time in milliseconds
   * @param {number} [resetHour=7] - Hour of day for reset (0-23). Defaults to 7 AM
   * @returns {boolean} True if at reset time
   *
   * @example
   * // At 7:00 AM -> true
   * // At 6:59 AM -> false
   * // At 7:01 AM -> false
   * const atReset = TimeManager.isAtResetTime(Date.now());
   */
  static isAtResetTime(currentTimestamp, resetHour = 7) {
    // Validate resetHour (must be 0-23)
    const validResetHour = (typeof resetHour === 'number' && resetHour >= 0 && resetHour <= 23) ? resetHour : 7;

    const currentDate = new Date(currentTimestamp);
    const hours = currentDate.getHours();
    const minutes = currentDate.getMinutes();

    // Check if it's at configured reset hour (within 1 minute)
    return hours === validResetHour && minutes === 0;
  }

  /**
   * ========================================================================
   * PHARMACODYNAMICS UTILITIES (Consolidated from duplicate code)
   * ========================================================================
   *
   * These utilities support common patterns in insulin and meal calculations.
   */

  /**
   * Parse any timestamp format to milliseconds (RAW - no normalization)
   *
   * This is the SIMPLE parser for pharmacodynamic calculations where you
   * just need a numeric millisecond value without precision normalization.
   * For precision-aware parsing, use parseTimestamp() instead.
   *
   * @param {number|string|Date} timestamp - Input in any format
   * @returns {number} Timestamp in milliseconds (NOT normalized)
   */
  static parseTimestampRaw(timestamp) {
    if (typeof timestamp === 'number') return timestamp;
    if (timestamp instanceof Date) return timestamp.getTime();
    if (typeof timestamp === 'string') return new Date(timestamp).getTime();
    console.warn('Invalid timestamp format:', timestamp);
    return Date.now();
  }

  /**
   * Parse and normalize timestamp in one step
   * Combines parseTimestampRaw() and normalize() for convenience
   *
   * @param {number|string|Date} timestamp - Input in any format
   * @param {string} precision - Precision level (default: SECOND)
   * @returns {number} Normalized timestamp in milliseconds
   */
  static parseAndNormalize(timestamp, precision = this.precision.SECOND) {
    const ts = this.parseTimestampRaw(timestamp);
    return this.normalize(ts, precision);
  }

  /**
   * Check if an effect (insulin or meal) is still active
   * Generic utility for pharmacodynamic calculations
   *
   * @param {number} hoursSince - Hours since administration/consumption
   * @param {object} profile - Profile with duration_hours property
   * @returns {boolean} True if effect is still active
   */
  static isEffectActive(hoursSince, profile) {
    if (!profile || typeof profile.duration_hours !== 'number') {
      return false;
    }
    return hoursSince >= 0 && hoursSince <= profile.duration_hours;
  }

  /**
   * Get duration from any pharmacodynamic profile
   *
   * @param {object} profile - Profile with duration_hours property
   * @returns {number} Duration in hours (0 if invalid)
   */
  static getProfileDuration(profile) {
    return profile?.duration_hours || 0;
  }

  /**
   * Get time to peak from any pharmacodynamic profile
   *
   * @param {object} profile - Profile with peak_hours property
   * @returns {number} Hours to peak (0 if invalid)
   */
  static getProfilePeakTime(profile) {
    return profile?.peak_hours || 0;
  }
}

export default TimeManager;



