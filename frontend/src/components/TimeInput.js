import React, { useState, useEffect, useContext } from 'react';
import PropTypes from 'prop-types';
import { FaClock, FaCalendarAlt } from 'react-icons/fa';
import TimeManager from '../utils/TimeManager';
import TimeContext from '../contexts/TimeContext';
import './Charts/input-components.css';

/**
 * Enhanced TimeInput component that can handle:
 * - Single time points (datetime-local input)
 * - Duration input (hours:minutes)
 * - Time ranges (start and end times)
 * - Date range selection connected to TimeContext
 */
const TimeInput = ({
  mode = 'timepoint',
  value = null,
  onChange,
  label = '',
  defaultToNow = true,
  disabled = false,
  className = '',
  required = false,
  placeholder = '',
  useTimeContext = false,
  showPresets = true
}) => {
  // Always call useContext unconditionally (React Hooks rule)
  const timeContext = useContext(TimeContext);

  // Initialize state based on mode
  const [timepoint, setTimepoint] = useState('');
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(0);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [showSystemInfo, setShowSystemInfo] = useState(false);

  // Local date range state for when not using context
  const [localDateRange, setLocalDateRange] = useState({
    start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    end: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  });

  // Decide whether to use context functions or direct TimeManager - after hooks are called
  const contextAvailable = useTimeContext && timeContext;

  // Helper functions that work whether or not context is available
  const getCurrentTime = () => {
    if (contextAvailable) {
      return timeContext.TimeManager.getCurrentTimeISOString();
    }
    return TimeManager.getCurrentTimeISOString();
  };

  const formatDateTime = (date, format) => {
    if (contextAvailable) {
      return timeContext.formatDateTime(date, format);
    }
    return TimeManager.formatDateTime(date);
  };

  const calculateDuration = (start, end) => {
    if (contextAvailable) {
      return timeContext.TimeManager.calculateDuration(start, end);
    }
    return TimeManager.calculateDuration(start, end);
  };

  // Initialize values based on props
  useEffect(() => {
    if (mode === 'daterange' && !useTimeContext) {
      // Initialize local date range if not using context
      if (value && typeof value === 'object') {
        setLocalDateRange({
          start: value.start || localDateRange.start,
          end: value.end || localDateRange.end
        });
      }
      return;
    }

    // Handle timepoint mode
    if (mode === 'timepoint') {
      if (value) {
        setTimepoint(value);
      } else if (defaultToNow) {
        // Use the helper function that considers context
        setTimepoint(getCurrentTime());
      } else {
        setTimepoint('');
      }
    }
    // Handle duration mode
    else if (mode === 'duration') {
      if (value !== null && value !== undefined) {
        // Value could be a number of hours or a HH:MM string
        if (typeof value === 'string' && value.includes(':')) {
          const [h, m] = value.split(':').map(num => parseInt(num, 10) || 0);
          setHours(h);
          setMinutes(m);
        } else {
          // Assume it's in hours
          const numValue = parseFloat(value) || 0;
          setHours(Math.floor(numValue));
          setMinutes(Math.round((numValue % 1) * 60));
        }
      } else {
        setHours(0);
        setMinutes(0);
      }
    }
    // Handle range mode
    else if (mode === 'range') {
      if (value && typeof value === 'object') {
        setStartTime(value.start || '');
        setEndTime(value.end || '');
      } else if (defaultToNow) {
        const now = getCurrentTime();
        setStartTime(now);
        setEndTime(now);
      } else {
        setStartTime('');
        setEndTime('');
      }
    }
  }, [mode, value, defaultToNow, useTimeContext, localDateRange.start, localDateRange.end, getCurrentTime]);

  // Handler functions for each mode
  const handleTimepointChange = (e) => {
    const newValue = e.target.value;
    setTimepoint(newValue);
    onChange(newValue);
  };

  const handleHoursChange = (e) => {
    const newHours = Math.max(0, Math.min(99, parseInt(e.target.value) || 0));
    setHours(newHours);
    onChange(TimeManager.durationToHours(`${newHours}:${minutes}`));
  };

  const handleMinutesChange = (e) => {
    const newMinutes = Math.max(0, Math.min(59, parseInt(e.target.value) || 0));
    setMinutes(newMinutes);
    onChange(TimeManager.durationToHours(`${hours}:${newMinutes}`));
  };

  const handleStartTimeChange = (e) => {
    const newStartTime = e.target.value;
    setStartTime(newStartTime);

    // If end time is before start time, update it
    if (endTime && endTime < newStartTime) {
      setEndTime(newStartTime);
      onChange({ start: newStartTime, end: newStartTime });
    } else {
      onChange({ start: newStartTime, end: endTime });
    }
  };

  const handleEndTimeChange = (e) => {
    const newEndTime = e.target.value;
    setEndTime(newEndTime);
    onChange({ start: startTime, end: newEndTime });
  };

  // Handle date range change - works with or without TimeContext
  const handleDateRangeChange = (e) => {
    const { name, value } = e.target;

    if (contextAvailable && timeContext.handleDateRangeChange) {
      // Update in context if available and enabled
      timeContext.handleDateRangeChange(e);
    } else {
      // Fallback to local state
      setLocalDateRange(prev => {
        const newRange = { ...prev, [name]: value };
        onChange(newRange); // Notify parent
        return newRange;
      });
    }
  };

  // Quick date range presets handler
  const applyDatePreset = (days) => {
    if (contextAvailable && timeContext.applyDatePreset) {
      timeContext.applyDatePreset(days);
    } else {
      const now = new Date();

      let start = new Date(now);
      start.setDate(start.getDate() - days);

      let end;
      if (days === 1) {
        end = new Date(now);
        end.setHours(end.getHours() + 12);
      } else {
        end = new Date(now);
        end.setDate(end.getDate() + 1);
      }

      const newDateRange = {
        start: start.toISOString().split('T')[0],
        end: end.toISOString().split('T')[0]
      };

      setLocalDateRange(newDateRange);
      onChange(newDateRange);
    }
  };

  // Toggle system info display
  const toggleSystemInfo = () => {
    setShowSystemInfo(!showSystemInfo);
  };

  // Calculate duration string for range mode
  const duration = mode === 'range' && startTime && endTime
    ? calculateDuration(startTime, endTime)
    : null;

  // Determine which date range to use (context or local)
  const effectiveDateRange = (contextAvailable && timeContext.dateRange)
    ? timeContext.dateRange
    : localDateRange;

  // Get system values - prefer context values when available
  const systemDateTime = contextAvailable ? timeContext.systemDateTime : TimeManager.getSystemDateTime();
  const currentUserLogin = contextAvailable ? timeContext.currentUserLogin : TimeManager.getCurrentUserLogin();
  const userTimeZone = contextAvailable ? timeContext.userTimeZone : TimeManager.getUserTimeZone();

  return (
    <div className={`time-input ${className}`}>
      {label && <label className="time-input-label">{label}</label>}

      {/* Render appropriate input based on mode */}
      {mode === 'timepoint' && (
        <div className="time-input-timepoint">
          <FaCalendarAlt className="time-input-icon" />
          <input
            type="datetime-local"
            value={timepoint}
            onChange={handleTimepointChange}
            className="time-input-datetime"
            disabled={disabled}
            required={required}
            placeholder={placeholder}
          />
        </div>
      )}

      {mode === 'duration' && (
        <div className="time-input-duration">
          <input
            type="number"
            value={hours.toString().padStart(2, '0')}
            onChange={handleHoursChange}
            min="0"
            max="99"
            className="time-input-hours"
            disabled={disabled}
            required={required}
            aria-label="Hours"
          />
          <span className="time-input-separator">:</span>
          <input
            type="number"
            value={minutes.toString().padStart(2, '0')}
            onChange={handleMinutesChange}
            min="0"
            max="59"
            className="time-input-minutes"
            disabled={disabled}
            required={required}
            aria-label="Minutes"
          />
          <span className="time-input-duration-label">hours : minutes</span>
        </div>
      )}

      {mode === 'range' && (
        <div className="time-input-range">
          <div className="time-input-range-group">
            <label className="time-input-range-label">Start Time</label>
            <div className="time-input-timepoint">
              <FaCalendarAlt className="time-input-icon" />
              <input
                type="datetime-local"
                value={startTime}
                onChange={handleStartTimeChange}
                className="time-input-datetime"
                disabled={disabled}
                required={required}
              />
            </div>
          </div>

          <div className="time-input-range-group">
            <label className="time-input-range-label">End Time</label>
            <div className="time-input-timepoint">
              <FaCalendarAlt className="time-input-icon" />
              <input
                type="datetime-local"
                value={endTime}
                onChange={handleEndTimeChange}
                className="time-input-datetime"
                disabled={disabled}
                required={required}
                min={startTime}
              />
            </div>
          </div>

          {duration && startTime && endTime && (
            <div className="time-input-duration-display">
              Duration: {duration.formatted}
            </div>
          )}
        </div>
      )}

      {/* Date range mode - works with or without TimeContext */}
      {mode === 'daterange' && (
        <div className="time-input-daterange">
          <div className="date-controls">
            <div className="date-input-group">
              <label htmlFor="start-date">From:</label>
              <input
                id="start-date"
                type="date"
                name="start"
                value={effectiveDateRange.start}
                onChange={handleDateRangeChange}
                disabled={disabled}
              />
            </div>

            <div className="date-input-group">
              <label htmlFor="end-date">To:</label>
              <input
                id="end-date"
                type="date"
                name="end"
                value={effectiveDateRange.end}
                onChange={handleDateRangeChange}
                disabled={disabled}
              />
            </div>
          </div>

          {showPresets && (
            <div className="quick-ranges">
              <button
                type="button"
                onClick={() => applyDatePreset(1)}
                disabled={disabled}
              >
                Last 24h
              </button>
              <button
                type="button"
                onClick={() => applyDatePreset(7)}
                disabled={disabled}
              >
                Last Week
              </button>
              <button
                type="button"
                onClick={() => applyDatePreset(30)}
                disabled={disabled}
              >
                Last Month
              </button>
            </div>
          )}

        </div>
      )}

      {showSystemInfo && (
        <div className="system-info">
          <div>System time: {systemDateTime}</div>
          <div>User: {currentUserLogin}</div>
          <div>Timezone: {userTimeZone}</div>
        </div>
      )}
    </div>
  );
};

TimeInput.propTypes = {
  mode: PropTypes.oneOf(['timepoint', 'duration', 'range', 'daterange']),
  value: PropTypes.oneOfType([
    PropTypes.string,
    PropTypes.number,
    PropTypes.object
  ]),
  onChange: PropTypes.func.isRequired,
  label: PropTypes.string,
  defaultToNow: PropTypes.bool,
  disabled: PropTypes.bool,
  className: PropTypes.string,
  required: PropTypes.bool,
  placeholder: PropTypes.string,
  useTimeContext: PropTypes.bool,
  showPresets: PropTypes.bool
};

export default TimeInput;



