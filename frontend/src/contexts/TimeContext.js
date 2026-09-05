import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import TimeManager from '../utils/TimeManager';

// Create the context
const TimeContext = createContext();

/**
 * Enhanced hook for using time-related functionality throughout the application
 * Provides a unified interface for all time operations
 * @returns {Object} Time utility methods and state
 */
export const useTime = () => {
  const context = useContext(TimeContext);
  if (!context) {
    throw new Error('useTime must be used within a TimeProvider');
  }

  // Return context with additional convenience methods
  return {
    // Original context values
    ...context,

    // Common time operations
    getCurrentTimeLocal: () => TimeManager.getCurrentTimeISOString(),
    localToUTC: (localTime) => TimeManager.localToUTCISOString(localTime),
    utcToLocal: (utcTime) => TimeManager.utcToLocalString(utcTime),
    formatTime: (time, format = context.formats.DATETIME_DISPLAY) =>
      TimeManager.formatDate(time, format),
    formatRelative: (time) => TimeManager.formatRelativeTime(time),
    calculateDuration: TimeManager.calculateDuration,
    parseTimestamp: TimeManager.parseTimestamp,

    // Common time initialization
    resetToCurrentTime: () => TimeManager.getCurrentTimeISOString(),

    // Helper for showing user-friendly timezone information
    getTimezoneDisplay: () => ({
      name: context.userTimeZone,
      infoText: '(all times stored in UTC but displayed in your local timezone)'
    })
  };
};

// Provider component
export const TimeProvider = ({ children }) => {
  // Initialize with default values safely
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // Format dates safely
  const formatDate = (date) => {
    try {
      return date.toISOString().split('T')[0];
    } catch (e) {
      console.error('Error formatting date:', e);
      return now.toISOString().split('T')[0];
    }
  };

  // Core time state with safe initialization
  const [currentDateTime, setCurrentDateTime] = useState(now);
  const [dateRange, setDateRange] = useState({
    start: formatDate(sevenDaysAgo),
    end: formatDate(tomorrow)
  });

  // Initialize timeScale with safe defaults
  const defaultTimeScale = {
    start: sevenDaysAgo.getTime(),
    end: tomorrow.getTime(),
    tickInterval: 12,
    tickFormat: TimeManager.formats.CHART_TICKS_MEDIUM
  };

  const [timeScale, setTimeScale] = useState(defaultTimeScale);
  const [userTimeZone, setUserTimeZone] = useState(TimeManager.getUserTimeZone());

  // Future projection settings - centralized here to avoid duplication
  const [includeFutureEffect, setIncludeFutureEffect] = useState(true);
  const [futureHours, setFutureHours] = useState(7);

  // System info (using TimeManager for consistency)
  const [systemDateTime, setSystemDateTime] = useState(
    TimeManager.getSystemDateTime(TimeManager.formats.SYSTEM_TIME)
  );
  const [currentUserLogin, setCurrentUserLogin] = useState(
    TimeManager.getCurrentUserLogin()
  );

  // Timer ref to prevent memory leaks
  const timerRef = useRef(null);

  // Update current time at regular intervals
  useEffect(() => {
    // Update immediately
    updateCurrentTime();

    // Set up interval for future updates (every minute)
    timerRef.current = setInterval(updateCurrentTime, 60000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  // Initialize time scale on mount and when date range changes
  useEffect(() => {
    try {
      // Add defensive check for dateRange properties
      if (dateRange && typeof dateRange.start === 'string' && typeof dateRange.end === 'string') {
        const newTimeScale = TimeManager.getTimeScaleForRange(dateRange.start, dateRange.end);

        // Verify newTimeScale is valid before updating state
        if (newTimeScale && typeof newTimeScale.start === 'number' && typeof newTimeScale.end === 'number') {
          setTimeScale(newTimeScale);
        } else {
          console.warn('Invalid time scale returned from TimeManager:', newTimeScale);
          setTimeScale(defaultTimeScale); // Use default if invalid
        }
      } else {
        console.warn('Invalid dateRange in TimeProvider:', dateRange);
        // Reset to default date range if invalid
        const newDateRange = {
          start: formatDate(sevenDaysAgo),
          end: formatDate(tomorrow)
        };
        setDateRange(newDateRange);
      }
    } catch (error) {
      console.error('Error initializing time scale:', error);
      setTimeScale(defaultTimeScale); // Use default on error
    }
  }, [dateRange]);

  // Helper to update current time
  const updateCurrentTime = useCallback(() => {
    setCurrentDateTime(new Date());
    // Also update system time if needed for real-time applications
    setSystemDateTime(TimeManager.getSystemDateTime(TimeManager.formats.SYSTEM_TIME));
  }, []);

  // Date range change handler with enhanced error handling
  const handleDateRangeChange = useCallback((e) => {
    try {
      // Handle both event-style inputs and direct object updates
      if (e && e.target) {
        const { name, value } = e.target;
        setDateRange(prev => {
          if (!prev) return { start: value, end: value }; // Handle case where prev is null
          const newRange = { ...prev, [name]: value };
          return newRange;
        });
      } else if (typeof e === 'object' && e !== null) {
        // Validate object has required properties
        const newRange = {};
        newRange.start = typeof e.start === 'string' ? e.start : formatDate(sevenDaysAgo);
        newRange.end = typeof e.end === 'string' ? e.end : formatDate(tomorrow);
        setDateRange(newRange);
      }
    } catch (error) {
      console.error('Error handling date range change:', error);
      // Set a safe default if something goes wrong
      setDateRange({
        start: formatDate(sevenDaysAgo),
        end: formatDate(tomorrow)
      });
    }
  }, []);

  // Quick date range presets
  const applyDatePreset = useCallback((days) => {
    try {
      const now = new Date();
      const start = new Date(now);
      start.setDate(start.getDate() - days);
      const startStr = formatDate(start);

      let end;
      if (days === 1) {
        // For "Last 24h": past day plus 12 hours
        end = new Date(now);
        end.setHours(end.getHours() + 12);
      } else if (days === 7) {
        // For "Last Week": past 7 days plus one future day
        end = new Date(now);
        end.setDate(end.getDate() + 1);
      } else if (days === 30) {
        // For "Last Month": past 30 days plus 4 future days
        end = new Date(now);
        end.setDate(end.getDate() + 4);
      } else {
        // Default case
        end = new Date(now);
        end.setDate(end.getDate() + 1);
      }
      const endStr = formatDate(end);

      const newRange = { start: startStr, end: endStr };
      setDateRange(newRange);
      return newRange; // Return for immediate use
    } catch (error) {
      console.error('Error applying date preset:', error);
      // Return a safe default if something goes wrong
      const fallbackRange = {
        start: formatDate(sevenDaysAgo),
        end: formatDate(tomorrow)
      };
      setDateRange(fallbackRange);
      return fallbackRange;
    }
  }, []);

  // Toggle future effect projection
  const toggleFutureEffect = useCallback(() => {
    setIncludeFutureEffect(prev => !prev);
  }, []);

  // Update future hours projection
  const setFutureHoursValue = useCallback((hours) => {
    // Ensure hours is a valid number between 1 and 24
    const validHours = Math.min(Math.max(1, Number(hours) || 7), 24);
    setFutureHours(validHours);
  }, []);

  // Generate ticks for x-axis based on time scale
  const generateTimeTicks = useCallback(() => {
    // Safety check for valid timeScale
    if (!timeScale || typeof timeScale.start !== 'number' || typeof timeScale.end !== 'number') {
      console.warn('Invalid timeScale for tick generation:', timeScale);
      return [];
    }
    return TimeManager.generateTimeTicks(timeScale.start, timeScale.end, timeScale.tickInterval);
  }, [timeScale]);

  // Format X-axis labels with error handling
  const formatXAxis = useCallback((tickItem) => {
    try {
      return TimeManager.formatAxisTick(tickItem, timeScale?.tickFormat || TimeManager.formats.CHART_TICKS_MEDIUM);
    } catch (error) {
      console.error('Error formatting X axis:', error);
      return '';
    }
  }, [timeScale]);

  // Check if a timestamp is within the current time scale range
  const isTimeInRange = useCallback((timestamp) => {
    if (!timeScale || typeof timeScale.start !== 'number' || typeof timeScale.end !== 'number') {
      return false;
    }
    return TimeManager.isTimeInRange(timestamp, timeScale.start, timeScale.end);
  }, [timeScale]);

  // Format a date for consistent display
  const formatDateTime = useCallback((date, format = TimeManager.formats.DATETIME_DISPLAY) => {
    try {
      return TimeManager.formatDate(date, format);
    } catch (error) {
      console.error('Error formatting date/time:', error);
      return '';
    }
  }, []);

  // Get future projection end time
  const getFutureProjectionEndTime = useCallback(() => {
    if (!includeFutureEffect) return TimeManager.getCurrentTime(TimeManager.precision.SECOND);
    return TimeManager.getFutureProjectionTime(futureHours);
  }, [includeFutureEffect, futureHours]);

  // Calculate time settings for API requests with future data
  const getAPITimeSettings = useCallback(() => {
    try {
      // Ensure dateRange exists and has required properties
      if (!dateRange || typeof dateRange.start !== 'string' || typeof dateRange.end !== 'string') {
        throw new Error('Invalid dateRange');
      }

      // Calculate the date range including future hours if needed
      const endDate = includeFutureEffect
        ? TimeManager.addHours(new Date(dateRange.end), futureHours)
        : new Date(dateRange.end);

      return {
        startDate: dateRange.start,
        endDate: TimeManager.formatDate(endDate, TimeManager.formats.DATE),
        includeFuture: includeFutureEffect,
        futureHours
      };
    } catch (error) {
      console.error('Error getting API time settings:', error);
      // Return a safe default
      return {
        startDate: formatDate(sevenDaysAgo),
        endDate: formatDate(tomorrow),
        includeFuture: includeFutureEffect,
        futureHours
      };
    }
  }, [dateRange, includeFutureEffect, futureHours]);

  // Value to be provided by the context
  const contextValue = {
    // Core time state
    currentDateTime: currentDateTime.getTime(),
    currentDateTimeFormatted: TimeManager.formatDate(currentDateTime, TimeManager.formats.DATETIME_FULL),
    dateRange,
    timeScale,
    userTimeZone,

    // Future projection settings - centralized
    includeFutureEffect,
    futureHours,

    // System info
    systemDateTime,
    currentUserLogin,

    // Time format constants
    formats: TimeManager.formats,

    // Functions
    setDateRange,
    handleDateRangeChange,
    applyDatePreset,
    setFutureHours: setFutureHoursValue,
    toggleFutureEffect,
    generateTimeTicks,
    formatXAxis,
    isTimeInRange,
    formatDateTime,
    getFutureProjectionEndTime,
    getAPITimeSettings,

    // Direct access to TimeManager for advanced usage
    TimeManager
  };

  return (
    <TimeContext.Provider value={contextValue}>
      {children}
    </TimeContext.Provider>
  );
};

export default TimeContext;



