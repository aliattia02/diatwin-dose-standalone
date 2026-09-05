/**
 * ============================================================================
 * CHART UTILS - Common Chart Utilities for All Visualizations
 * ============================================================================
 *
 * VERSION: 2.0 - CONSOLIDATED CHART UTILITIES
 *
 * NEW IN v2.0:
 * ✅ Extracted shared tick generation logic from both visualizations
 * ✅ Extracted shared time range calculation (7 AM logic)
 * ✅ Extracted shared axis domain computation
 * ✅ Extracted shared meal/insulin processing with lookback windows
 * ✅ Extracted confidence level calculation
 * ✅ Extracted minute-boundary sync hook
 * ✅ Extracted dynamic bar size calculation
 * ✅ All chart components now import these from a single source
 *
 * Single source of truth for:
 * - Tooltip components and logic
 * - Axis formatting and domain calculation
 * - Legend formatting
 * - Custom renderers (dots, labels)
 * - Color utilities (brightness adjustments)
 * - Insulin display helpers
 * - Time range and tick generation
 * - Meal/insulin processing for charts
 * - Common chart patterns and hooks
 * ============================================================================
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import TimeManager from '../utils/TimeManager';
import { SHARED_CONSTANTS } from '../constants/shared_constants';
import { NET_EFFECT_CONSTANTS } from '../utils/netEffectCalculationService';

// ==========================================
// COLOR UTILITIES
// ==========================================

/**
 * Helper function to adjust color brightness
 * Used consistently across all charts for effect variations
 *
 * @param {string} hex - Hex color code (e.g., '#FF5722')
 * @param {number} percent - Brightness adjustment (-100 to 100)
 * @returns {string} Adjusted hex color
 */
export const adjustColorBrightness = (hex, percent) => {
  let r = parseInt(hex.substring(1, 3), 16);
  let g = parseInt(hex.substring(3, 5), 16);
  let b = parseInt(hex.substring(5, 7), 16);

  r = Math.min(255, Math.max(0, r + percent));
  g = Math.min(255, Math.max(0, g + percent));
  b = Math.min(255, Math.max(0, b + percent));

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
};

/**
 * Get blood sugar status color based on value and target
 *
 * @param {number} value - Blood sugar value
 * @param {number} targetGlucose - Target glucose level
 * @returns {string} Hex color representing status
 */
export const getBloodSugarStatusColor = (value, targetGlucose) => {
  if (value > targetGlucose * 1.3) {
    return '#ff8800'; // High
  } else if (value < targetGlucose * 0.7) {
    return '#ff4444'; // Low
  } else if (value >= targetGlucose * 0.9 && value <= targetGlucose * 1.1) {
    return '#4CAF50'; // In range
  }
  return '#8031A7'; // Normal
};

/**
 * Return a consistent color for insulin elements
 *
 * @param {string} insulinType - Type of insulin
 * @param {number} index - Index for color cycling
 * @param {boolean} isEffect - Whether to darken for effect variation
 * @returns {string} Hex color for the insulin element
 */
export const getInsulinColor = (insulinType, index, isEffect = false) => {
  if (typeof insulinType === 'undefined') {
    return '#4a90e2';
  }

  const colors = [
    '#8884d8', '#82ca9d', '#ffc658', '#ff8042',
    '#0088fe', '#00C49F', '#FFBB28', '#FF8042',
    '#a4de6c', '#d0ed57'
  ];

  const baseColor = colors[index % colors.length];

  if (isEffect) {
    return adjustColorBrightness(baseColor, -20);
  }

  return baseColor;
};

// ==========================================
// INSULIN DISPLAY UTILITIES
// ==========================================

/**
 * Helper function to get insulin type display info
 * @param {string} insulinType - Insulin type key
 * @param {Object} patientConstants - Patient constants with medication_factors
 * @returns {Object} Display info including name, type, onset, peak, duration, color
 */
export const getInsulinTypeDisplay = (insulinType, patientConstants) => {
  const formatName = (type) =>
    type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  const medicationFactors = patientConstants?.medication_factors || {};
  const insulinData = medicationFactors[insulinType];

  if (!insulinData) {
    return {
      displayName: formatName(insulinType),
      type: 'Rapid-Acting',
      color: '#FF6B6B'
    };
  }

  const typeColors = {
    'rapid_acting': '#FF6B6B',
    'short_acting': '#FF8E53',
    'intermediate_acting': '#4ECDC4',
    'long_acting': '#45B7D1',
    'mixed': '#96CEB4'
  };

  const typeLabels = {
    'rapid_acting': 'Rapid-Acting',
    'short_acting': 'Short-Acting',
    'intermediate_acting': 'Intermediate-Acting',
    'long_acting': 'Long-Acting',
    'mixed': 'Mixed'
  };

  return {
    displayName: formatName(insulinType),
    type: typeLabels[insulinData.type] || insulinData.type,
    onset: `${(insulinData.onset_hours * 60).toFixed(0)} min`,
    peak: insulinData.is_peakless ? 'Peakless' : `${insulinData.peak_hours.toFixed(1)} hrs`,
    duration: `${insulinData.duration_hours.toFixed(1)} hrs`,
    color: typeColors[insulinData.type] || '#666666',
    isLongActing: insulinData.type === 'long_acting',
    isPeakless: insulinData.is_peakless,
    brandNames: insulinData.brand_names || []
  };
};

// ==========================================
// SHARED VIEW MODE CONFIGS
// ==========================================

// ✅ FIX: Extend shared VIEW_MODE_CONFIGS with extra view modes used by
// BloodSugarVisualization ('6h', '3d') that are not in the backend-generated
// shared_constants.js.  We spread the shared object so all existing keys
// (12h, 24h, week, month) are preserved and only the missing ones are added.
// Exported so BloodSugarVisualization can import the complete set instead of
// using SHARED_CONSTANTS.VIEW_MODE_CONFIGS directly (which lacks '6h'/'3d').
export const VIEW_CONFIGS = {
  ...SHARED_CONSTANTS.VIEW_MODE_CONFIGS,
  // 6-hour short view
  '6h': {
    label: '6 Hours',
    pastHours: 4,
    futureHours: 2,
    tickInterval: 1,
    tickFormat: 'HH:mm',
    interpolationInterval: 1,
    mealLookback: 8,
    insulinLookback: 8
  },
  // 3-day view (72 hours)
  '3d': {
    label: '3 Days',
    pastHours: 68,
    futureHours: 4,
    tickInterval: 12,
    tickFormat: 'DD/MM HH:mm',
    interpolationInterval: 10,
    mealLookback: 72,
    insulinLookback: 72
  }
};

// ==========================================
// SHARED HOOKS
// ==========================================

/**
 * Hook that returns a timestamp (rounded to the minute) and updates every 60s.
 * Both EffectsVisualization and BloodGlucoseVisualization used identical
 * useEffect blocks to keep "now" fresh – this hook replaces both.
 *
 * @returns {number} Current time rounded to the nearest minute boundary
 */
export const useCurrentMinute = () => {
  const [currentMinute, setCurrentMinute] = useState(
    TimeManager.getCurrentTime(TimeManager.precision.MINUTE)
  );

  useEffect(() => {
    let intervalId = null;

    const updateCurrentMinute = () => {
      const now = TimeManager.getCurrentTime(TimeManager.precision.MINUTE);
      setCurrentMinute(now);
    };

    // Calculate time until next minute boundary
    const now = Date.now();
    const msUntilNextMinute = 60000 - (now % 60000);

    // Sync to minute boundary first, then update every minute
    const syncTimeout = setTimeout(() => {
      updateCurrentMinute();
      intervalId = setInterval(updateCurrentMinute, 60000);
    }, msUntilNextMinute);

    return () => {
      clearTimeout(syncTimeout);
      if (intervalId !== null) {
        clearInterval(intervalId);
      }
    };
  }, []);

  return currentMinute;
};

/**
 * Hook to compute the visible time range for a chart.
 * Implements the shared 7 AM logic for 12h / 24h views and
 * standard pastHours logic for shorter views.
 *
 * @param {string} viewMode - Current view mode key (e.g., '3h', '6h', '12h', '24h')
 * @param {number} currentMinute - Current time rounded to the minute
 * @returns {{ start: number, end: number, now: number }}
 */
export const useChartTimeRange = (viewMode, currentMinute) => {
  // ✅ FIX: Fall back to '12h' config if an unrecognised viewMode key is passed.
  // Previously an unknown key left viewConfig undefined and crashed immediately
  // with "Cannot read properties of undefined (reading 'pastHours')".
  const viewConfig = VIEW_CONFIGS[viewMode] || VIEW_CONFIGS['12h'];

  const timeRange = useMemo(() => {
    const now = currentMinute;

    let start;
    const currentDate = new Date(now);
    const sevenAMToday = new Date(currentDate);
    sevenAMToday.setHours(7, 0, 0, 0);

    const sevenAMYesterday = new Date(sevenAMToday);
    sevenAMYesterday.setDate(sevenAMYesterday.getDate() - 1);

    if (viewMode === '12h') {
      // If current time is before 7 AM today, 7 AM today is in the future.
      // Fall back to 7 AM yesterday so the window always starts in the past.
      start = now >= sevenAMToday.getTime()
        ? sevenAMToday.getTime()
        : sevenAMYesterday.getTime();
    } else if (viewMode === '24h') {
      // Same guard: if before 7 AM today, use 7 AM two days ago as anchor.
      const sevenAMTwoDaysAgo = new Date(sevenAMYesterday);
      sevenAMTwoDaysAgo.setDate(sevenAMTwoDaysAgo.getDate() - 1);
      start = now >= sevenAMToday.getTime()
        ? sevenAMYesterday.getTime()
        : sevenAMTwoDaysAgo.getTime();
    } else {
      start = now - (viewConfig.pastHours * 60 * 60 * 1000);
    }

    const end = now + (viewConfig.futureHours * 60 * 60 * 1000);

    return { start, end, now };
  }, [viewConfig, currentMinute, viewMode]);

  return timeRange;
};

// ==========================================
// SHARED MEAL / INSULIN PROCESSING
// ==========================================


/**
 * Memoisation-ready function that filters and normalises raw insulin
 * from context so they're ready for calculateNetEffectAtTime().
 *
 * @param {Array} contextInsulin - Raw insulin from recentInsulinData
 * @param {{ start: number, end: number }} timeRange - Visible chart range
 * @returns {Array} Processed insulin doses with numeric timestamps
 */
export const processContextInsulinForChart = (contextInsulin, timeRange) => {
  if (!contextInsulin || contextInsulin.length === 0) return [];

  const { start, end } = timeRange;
  const cutoffTime = start - (NET_EFFECT_CONSTANTS.IOB_LOOKBACK_HOURS * 60 * 60 * 1000);

  return contextInsulin
    .filter(dose => {
      const doseTime = TimeManager.parseTimestamp(
        dose.administrationTime || dose.taken_at || dose.scheduled_time,
        TimeManager.precision.SECOND
      );
      if (!doseTime || doseTime === 0 || isNaN(doseTime)) return false;
      return doseTime >= cutoffTime && doseTime <= end;
    })
    .map(dose => {
      let doseTime;
      if (dose.administrationTime && typeof dose.administrationTime === 'number') {
        doseTime = dose.administrationTime;
      } else if (dose.taken_at) {
        doseTime = new Date(dose.taken_at).getTime();
      } else {
        doseTime = new Date(dose.scheduled_time).getTime();
      }

      return {
        administrationTime: doseTime,
        dose: parseFloat(dose.dose || dose.amount || dose.units) || 0,
        medication: dose.medication || dose.insulinType || dose.insulin_type || 'regular_insulin',
        insulinType: dose.medication || dose.insulinType || dose.insulin_type || 'regular_insulin',
        id: dose.id || dose._id
      };
    });
};

// ==========================================
// TICK GENERATION
// ==========================================

/**
 * Generate hour-aligned X-axis ticks for a given time range and view config.
 * Both EffectsVisualization and BloodGlucoseVisualization had nearly-identical
 * versions of this function — now consolidated here.
 *
 * @param {{ start: number, end: number }} timeRange
 * @param {Object} viewConfig - View config with tickInterval (hours)
 * @returns {number[]} Array of tick timestamps
 */
export const generateXAxisTicks = (timeRange, viewConfig) => {
  const { start, end } = timeRange;
  const duration = end - start;
  const hourMs = 60 * 60 * 1000;

  // Determine tick interval: use viewConfig.tickInterval if available,
  // otherwise calculate from duration
  let tickIntervalMs;
  if (viewConfig && viewConfig.tickInterval) {
    tickIntervalMs = viewConfig.tickInterval * hourMs;
  } else {
    // Auto-detect
    if (duration <= 6 * hourMs) {
      tickIntervalMs = hourMs;
    } else if (duration <= 12 * hourMs) {
      tickIntervalMs = 2 * hourMs;
    } else if (duration <= 24 * hourMs) {
      tickIntervalMs = 3 * hourMs;
    } else {
      tickIntervalMs = 6 * hourMs;
    }
  }

  const ticks = [];
  const alignedStart = new Date(start);
  alignedStart.setMinutes(0, 0, 0);

  for (let time = alignedStart.getTime(); time <= end; time += tickIntervalMs) {
    if (time >= start) {
      ticks.push(time);
    }
  }

  return ticks;
};

/**
 * Generate symmetric Y-axis ticks around 0 for an effects axis.
 * Used by the effects chart for both the effects and dose axes.
 *
 * @param {[number, number]} domain - [min, max] of the axis
 * @param {Object} options
 * @param {number[]} options.intervals - Ordered list of candidate intervals
 * @returns {number[]} Sorted, deduplicated tick values (always includes 0)
 */
export const generateSymmetricTicks = (domain, options = {}) => {
  const [min, max] = domain;
  const range = max - min;

  const {
    intervals = [10, 20, 50, 100, 200]
  } = options;

  // Pick the right interval based on range
  let interval = intervals[intervals.length - 1];
  if (range <= 50) interval = intervals[0] || 10;
  else if (range <= 100) interval = intervals[1] || 20;
  else if (range <= 200) interval = intervals[2] || 50;
  else if (range <= 400) interval = intervals[3] || 100;

  const ticks = new Set([0]);

  for (let tick = 0; tick >= min; tick -= interval) {
    ticks.add(tick);
  }
  for (let tick = interval; tick <= max; tick += interval) {
    ticks.add(tick);
  }

  return [...ticks].sort((a, b) => a - b);
};

// ==========================================
// AXIS DOMAIN UTILITIES
// ==========================================

/**
 * Calculate the symmetric Y-axis domain for an effects chart.
 * Takes into account meal, insulin, net, and cumulative effects.
 *
 * @param {Array} chartData - Array of chart data points
 * @param {Object} options
 * @param {boolean} options.includeCumulative - Whether to include cumulative range
 * @param {number} options.paddingFactor - Padding as fraction of max (default 0.15)
 * @returns {[number, number]} [min, max] domain values
 */
export const calculateEffectsAxisDomain = (chartData, options = {}) => {
  const { includeCumulative = true, paddingFactor = 0.15 } = options;

  if (!chartData || chartData.length === 0) return [-100, 100];

  const maxMealEffect = Math.max(
    ...chartData.map(d => d.mealImpact || 0),
    0
  );
  const minInsulinEffect = Math.min(
    ...chartData.map(d => d.insulinImpact || 0),
    0
  );
  const maxNetEffect = Math.max(
    ...chartData.map(d => Math.abs(d.netEffect || 0)),
    0
  );

  let maxCumulative = 0;
  if (includeCumulative) {
    maxCumulative = Math.max(
      ...chartData.map(d => Math.abs(d.cumulativeNetBaseline || 0)),
      0
    );
  }

  const maxAbsolute = Math.max(
    maxMealEffect,
    Math.abs(minInsulinEffect),
    maxNetEffect,
    maxCumulative
  );

  const padding = maxAbsolute * paddingFactor;
  const limit = Math.ceil(maxAbsolute + padding);

  return [-limit, limit];
};

/**
 * Calculate dose axis domain for bar chart markers.
 *
 * @param {Array} chartData - Array of chart data points
 * @param {number} paddingFactor - Padding as fraction of max (default 0.2)
 * @returns {[number, number]} [min, max] domain values
 */
export const calculateDoseAxisDomain = (chartData, paddingFactor = 0.2) => {
  if (!chartData || chartData.length === 0) return [-30, 30];

  const maxMealDose = Math.max(
    ...chartData.map(d => d.mealDoseMarker || 0),
    0
  );
  const minInsulinDose = Math.min(
    ...chartData.map(d => d.insulinDoseMarker || 0),
    0
  );

  const maxAbsolute = Math.max(maxMealDose, Math.abs(minInsulinDose));
  const padding = maxAbsolute * paddingFactor;
  const limit = Math.ceil(maxAbsolute + padding);

  return [-limit, limit];
};

/**
 * Calculate the cumulative-effect Y-axis domain so that its zero
 * aligns with the glucose axis baseline value.
 *
 * @param {number|null} baselineValue - T1D baseline BG
 * @param {number} glucoseMin - Glucose axis minimum (default 40)
 * @param {number} glucoseMax - Glucose axis maximum (default 400)
 * @returns {[number, number]} Cumulative axis [min, max]
 */
export const calculateCumulativeAxisDomain = (baselineValue, glucoseMin = 40, glucoseMax = 400) => {
  if (!baselineValue) return [-180, 180];

  const gRange = glucoseMax - glucoseMin;
  const baselineOffset = baselineValue - glucoseMin;

  return [-baselineOffset, gRange - baselineOffset];
};

/**
 * Calculate cumulative axis ticks that align with glucose axis ticks.
 *
 * @param {number|null} baselineValue - T1D baseline BG
 * @param {number[]} glucoseTicks - Glucose axis tick values
 * @returns {number[]|undefined} Cumulative tick values, or undefined
 */
export const calculateCumulativeAxisTicks = (baselineValue, glucoseTicks = [40, 80, 100, 120, 140, 180, 200, 250, 300, 350, 400]) => {
  if (!baselineValue) return undefined;
  return glucoseTicks.map(gTick => gTick - baselineValue);
};

/**
 * Calculate dynamic bar size based on chart width and data density.
 *
 * @param {number} chartWidth - Width of chart container in pixels
 * @param {number} pointsCount - Number of data points
 * @param {Object} options
 * @param {number} options.widthFraction - Fraction of point width for bar (default 0.4)
 * @param {number} options.minSize - Minimum bar size (default 8)
 * @param {number} options.maxSize - Maximum bar size (default 30)
 * @returns {number} Computed bar size in pixels
 */
export const calculateDynamicBarSize = (chartWidth, pointsCount, options = {}) => {
  const { widthFraction = 0.4, minSize = 8, maxSize = 30 } = options;

  if (!pointsCount || pointsCount === 0) return 20;

  const effectiveWidth = chartWidth || 1000;
  const widthPerPoint = effectiveWidth / pointsCount;
  const calculatedSize = Math.floor(widthPerPoint * widthFraction);

  return Math.max(minSize, Math.min(maxSize, calculatedSize));
};

// ==========================================
// CONFIDENCE UTILITIES
// ==========================================

/**
 * Get confidence level for a chart data point.
 * Extracted from BloodGlucoseVisualization.
 *
 * @param {Object} point - Data point with flags
 * @param {boolean} point.isActualReading
 * @param {boolean} point.isFuture
 * @param {number} point.timestamp
 * @param {number} baselineAge - Minutes since last baseline reading
 * @returns {{ level: string, color: string, label: string }}
 */
export const getConfidenceLevel = (point, baselineAge) => {
  if (point.isActualReading) {
    return {
      level: 'actual',
      color: '#4CAF50',
      label: 'Meter Reading'
    };
  }

  if (point.isFuture) {
    const minutesIntoFuture = (point.timestamp - Date.now()) / (60 * 1000);

    if (minutesIntoFuture < 30) {
      return { level: 'projected_high', color: '#2196F3', label: 'Near-term Projection' };
    } else if (minutesIntoFuture < 120) {
      return { level: 'projected_medium', color: '#9C27B0', label: 'Medium-term Projection' };
    } else {
      return { level: 'projected_low', color: '#FF9800', label: 'Long-term Projection' };
    }
  }

  if (baselineAge < 30) {
    return { level: 'high', color: '#2196F3', label: 'High Confidence' };
  } else if (baselineAge < 90) {
    return { level: 'medium', color: '#9C27B0', label: 'Medium Confidence' };
  } else if (baselineAge < 180) {
    return { level: 'low', color: '#FF9800', label: 'Low Confidence' };
  } else {
    return { level: 'very_low', color: '#F44336', label: 'Very Low Confidence' };
  }
};

// ==========================================
// DOSE MATCHING UTILITIES
// ==========================================

/**
 * Find meals administered within a time window of a chart point.
 *
 * @param {Array} meals - Processed meals (with numeric timestamp)
 * @param {number} pointTimestamp - Chart point timestamp
 * @param {number} halfIntervalMs - Half the chart interval in ms
 * @returns {Array} Matching meals
 */
export const findMealsAtTime = (meals, pointTimestamp, halfIntervalMs) => {
  if (!meals || meals.length === 0) return [];
  return meals.filter(meal => {
    const mealTime = typeof meal.timestamp === 'number'
      ? meal.timestamp
      : TimeManager.parseTimestamp(meal.timestamp, TimeManager.precision.SECOND);
    if (isNaN(mealTime)) return false;
    // ✅ FIX 2: Use <= so meals landing exactly at the midpoint between two chart
    // grid points (common in the 2-min 24h grid) are not silently dropped.
    return Math.abs(mealTime - pointTimestamp) <= halfIntervalMs;
  });
};

/**
 * Find insulin doses administered within a time window of a chart point.
 *
 * @param {Array} insulinDoses - Processed insulin (with numeric administrationTime)
 * @param {number} pointTimestamp - Chart point timestamp
 * @param {number} halfIntervalMs - Half the chart interval in ms
 * @returns {Array} Matching insulin doses
 */
export const findInsulinAtTime = (insulinDoses, pointTimestamp, halfIntervalMs) => {
  if (!insulinDoses || insulinDoses.length === 0) return [];
  return insulinDoses.filter(dose => {
    const doseTime = dose.administrationTime || 0;
    // ✅ FIX 2: <= mirrors the fix applied to findMealsAtTime above.
    return Math.abs(doseTime - pointTimestamp) <= halfIntervalMs;
  });
};

// ==========================================
// X-AXIS FORMATTING
// ==========================================

/**
 * Create a memoisation-friendly X-axis formatter.
 *
 * @param {Object} viewConfig - View config with tickFormat
 * @returns {function} Formatter function for XAxis tickFormatter
 */
export const createXAxisFormatter = (viewConfig) => {
  return (timestamp) => {
    return TimeManager.formatDate(
      new Date(timestamp),
      viewConfig.tickFormat === 'HH:mm' ? 'HH:mm' : 'DD/MM HH:mm'
    );
  };
};

// ==========================================
// CUSTOM INSULIN TOOLTIP COMPONENT
// ==========================================

/**
 * Custom insulin tooltip for insulin-only visualizations
 * Shared across insulin chart views
 *
 * @param {Object} props - Tooltip props from Recharts
 * @param {Object} props.patientConstants - Patient constants for insulin display
 * @param {boolean} props.showIOB - Whether to show IOB section
 * @param {boolean} props.showActivity - Whether to show activity section
 * @returns {JSX.Element|null} Tooltip component
 */
export const CustomInsulinTooltip = ({
  active,
  payload,
  patientConstants,
  showIOB = true,
  showActivity = true
}) => {
  if (!active || !payload || !payload.length) return null;

  const data = payload[0]?.payload;
  if (!data) return null;

  const iobData = data.iobData || {};
  const hasIOBData = iobData.totalActiveInsulin > 0 || iobData.insulinContributions?.length > 0;

  return (
    <div className="insulin-tooltip" style={{
      backgroundColor: 'white',
      border: '2px solid #e5e7eb',
      borderRadius: '8px',
      padding: '12px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      maxWidth: '320px',
      fontSize: '13px'
    }}>
      <p className="tooltip-time" style={{
        fontWeight: '700',
        marginBottom: '8px',
        paddingBottom: '8px',
        borderBottom: '2px solid #e5e7eb',
        color: '#1f2937'
      }}>
        {data.formattedTime}
      </p>

      {/* Insulin Doses at this time */}
      {Object.keys(data.insulinDoses || {}).length > 0 && (
        <div className="tooltip-section" style={{ marginBottom: '10px' }}>
          <p className="tooltip-header" style={{
            fontSize: '11px',
            fontWeight: '700',
            color: '#6b7280',
            marginBottom: '6px',
            textTransform: 'uppercase'
          }}>
            💉 Insulin Doses:
          </p>
          {Object.entries(data.insulinDoses).map(([type, dose], idx) => {
            const insulinInfo = getInsulinTypeDisplay(type, patientConstants);
            return (
              <div key={idx} style={{
                padding: '6px',
                marginBottom: '4px',
                backgroundColor: '#f9fafb',
                borderRadius: '4px',
                borderLeft: `3px solid ${insulinInfo.color}`
              }}>
                <div style={{ fontWeight: '600', color: insulinInfo.color }}>
                  {insulinInfo.displayName}
                </div>
                <div style={{ fontSize: '12px' }}>
                  <strong>{dose.toFixed(1)} units</strong> - {insulinInfo.type}
                </div>
                <div style={{ fontSize: '10px', color: '#6b7280', marginTop: '2px' }}>
                  Onset: {insulinInfo.onset} • Peak: {insulinInfo.peak} • Duration: {insulinInfo.duration}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Active Insulin Activity */}
      {showActivity && (data.totalInsulinEffect > 0 || data.totalActivity > 0) && (
        <div className="tooltip-section" style={{
          marginBottom: '10px',
          padding: '8px',
          backgroundColor: '#e8f5e9',
          borderRadius: '6px',
          border: '2px solid #82ca9d'
        }}>
          <p className="tooltip-header" style={{
            fontSize: '11px',
            fontWeight: '700',
            color: '#2e7d32',
            marginBottom: '6px'
          }}>
            Insulin Activity (Shaded Area):
          </p>
          <div style={{ fontSize: '12px', marginBottom: '4px' }}>
            <span style={{ color: '#6b7280' }}>Active Effect:</span>{' '}
            <strong style={{ color: '#2e7d32' }}>
              {(data.totalInsulinEffect || 0).toFixed(2)} units
            </strong>
          </div>
          <div style={{ fontSize: '12px', marginBottom: '4px' }}>
            <span style={{ color: '#6b7280' }}>Activity Level:</span>{' '}
            <strong style={{ color: '#2e7d32' }}>
              {(data.totalActivity || 0).toFixed(1)}%
            </strong>
          </div>
          <div style={{ fontSize: '12px' }}>
            <span style={{ color: '#6b7280' }}>BG Impact:</span>{' '}
            <strong style={{ color: '#dc2626' }}>
              -{(data.bgImpactFromInsulin || 0).toFixed(1)} mg/dL
            </strong>
          </div>
        </div>
      )}

      {/* IOB - Insulin On Board */}
      {showIOB && hasIOBData && (
        <div className="tooltip-section" style={{
          marginBottom: '10px',
          padding: '8px',
          backgroundColor: '#f3e5f5',
          borderRadius: '6px',
          border: '2px solid #9c27b0'
        }}>
          <p className="tooltip-header" style={{
            fontSize: '11px',
            fontWeight: '700',
            color: '#7b1fa2',
            marginBottom: '6px'
          }}>
            IOB - Insulin On Board (Dashed Line):
          </p>
          <div style={{ fontSize: '12px', marginBottom: '4px' }}>
            <span style={{ color: '#6b7280' }}>Total IOB:</span>{' '}
            <strong style={{ color: '#7b1fa2' }}>
              {(iobData.totalActiveInsulin || data.totalIOB || 0).toFixed(2)} units
            </strong>
          </div>
          <div style={{ fontSize: '12px' }}>
            <span style={{ color: '#6b7280' }}>Potential BG Impact:</span>{' '}
            <strong style={{ color: '#dc2626' }}>
              -{Math.abs(iobData.bgImpact || data.insulinImpactMgdL || 0).toFixed(1)} mg/dL
            </strong>
          </div>

          {iobData.insulinContributions && iobData.insulinContributions.length > 0 && (
            <div style={{
              marginTop: '6px',
              paddingTop: '6px',
              borderTop: '1px solid #ce93d8',
              fontSize: '10px',
              color: '#6b7280'
            }}>
              <div style={{ marginBottom: '3px', fontWeight: '600' }}>
                Active doses ({iobData.insulinContributions.length}):
              </div>
              {iobData.insulinContributions.slice(0, 3).map((contrib, idx) => (
                <div key={idx} style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: '2px'
                }}>
                  <span>{contrib.insulinType}:</span>
                  <span>
                    {contrib.activeUnits.toFixed(2)}u ({contrib.hoursSinceDose}h ago)
                  </span>
                </div>
              ))}
              {iobData.insulinContributions.length > 3 && (
                <div style={{ fontSize: '9px', color: '#9ca3af', fontStyle: 'italic' }}>
                  +{iobData.insulinContributions.length - 3} more doses...
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Blood Sugar */}
      {data.bloodSugar && (
        <div className="tooltip-section" style={{
          padding: '6px',
          backgroundColor: '#f9fafb',
          borderRadius: '4px'
        }}>
          <p className="tooltip-header" style={{
            fontSize: '11px',
            fontWeight: '700',
            color: '#6b7280',
            marginBottom: '4px'
          }}>
            🩸 Blood Glucose:
          </p>
          <p style={{ fontSize: '13px', fontWeight: '600' }}>
            {Math.round(data.bloodSugar)} mg/dL
            {data.bloodSugarStatus && (
              <span style={{
                marginLeft: '6px',
                fontSize: '11px',
                color: '#6b7280'
              }}>
                ({data.bloodSugarStatus.label || data.bloodSugarStatus})
              </span>
            )}
          </p>
        </div>
      )}
    </div>
  );
};

// ==========================================
// CHART DOMAIN UTILITIES
// ==========================================

/**
 * Compute the X-axis domain from the actual data range + date range.
 *
 * @param {Array} data - Combined chart data with `timestamp` field
 * @param {Object} dateRange - { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
 * @param {Object} timeScale - Optional timeScale from context { start, end }
 * @returns {[number, number]} [domainStart, domainEnd]
 */
export const computeXDomain = (data, dateRange, timeScale = {}) => {
  const rangeStart = new Date(dateRange.start).setHours(0, 0, 0, 0);
  const rangeEnd = new Date(dateRange.end).setHours(23, 59, 59, 999);

  let domainStart = rangeStart;
  let domainEnd = rangeEnd;

  if (data && data.length > 0) {
    const dataMin = data[0].timestamp;
    const dataMax = data[data.length - 1].timestamp;
    domainStart = Math.min(rangeStart, dataMin);
    domainEnd = Math.max(rangeEnd, dataMax);
  }

  if (timeScale.start && timeScale.end) {
    domainStart = Math.min(domainStart, timeScale.start);
    domainEnd = Math.max(domainEnd, timeScale.end);
  }

  return [domainStart, domainEnd];
};

/**
 * Generate appropriate tick intervals based on the visible duration.
 *
 * @param {number} domainStart - Start timestamp
 * @param {number} domainEnd - End timestamp
 * @returns {number} Tick interval in hours
 */
export const computeTickInterval = (domainStart, domainEnd) => {
  const durationHours = (domainEnd - domainStart) / (1000 * 60 * 60);

  if (durationHours <= 6) return 0.5;
  if (durationHours <= 12) return 1;
  if (durationHours <= 24) return 2;
  if (durationHours <= 48) return 4;
  if (durationHours <= 72) return 6;
  if (durationHours <= 168) return 12;
  return 24;
};

/**
 * Generate tick values for the X-axis based on domain and interval.
 *
 * @param {number} domainStart - Start timestamp
 * @param {number} domainEnd - End timestamp
 * @param {number} intervalHours - Hours between ticks
 * @returns {number[]} Array of tick timestamps
 */
export const generateChartTicks = (domainStart, domainEnd, intervalHours) => {
  const ticks = [];
  const intervalMs = intervalHours * 60 * 60 * 1000;

  const alignedStart = Math.ceil(domainStart / intervalMs) * intervalMs;

  let current = alignedStart;
  while (current <= domainEnd) {
    ticks.push(current);
    current += intervalMs;
  }

  return ticks;
};

// ==========================================
// FORMATTING UTILITIES
// ==========================================

/**
 * Format X-axis labels for charts
 *
 * @param {number|string} timestamp - Unix timestamp or date string
 * @param {string} format - Format type
 * @returns {string} Formatted time string
 */
export const formatXAxis = (timestamp, format = 'MM/DD HH:mm') => {
  const date = new Date(timestamp);

  if (format === 'CHART_TICKS_MEDIUM') {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${month}/${day} ${hours}:${minutes}`;
  }

  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
};

/**
 * Format Y-axis labels
 *
 * @param {number} value - Numeric value
 * @param {string} unit - Unit of measurement
 * @returns {string} Formatted value with unit
 */
export const formatYAxis = (value, unit = 'mg/dL') => {
  return `${Math.round(value)} ${unit}`;
};

/**
 * Format legend text to clean up labels
 *
 * @param {string} value - Raw legend key
 * @returns {string} Human-readable legend label
 */
export const formatLegendText = (value) => {
  if (value === 'bloodSugar') return 'Blood Sugar (with effects, future)';
  if (value === 'estimatedBloodSugar') return 'Baseline Blood Sugar (historical)';
  if (value === 'baseBG') return 'T1D Baseline (stable)';
  if (value === 'targetWithMealEffect') return 'Target + Meal Effect';
  if (value === 'totalMealEffect') return 'Total Meal Effect (MOB)';
  if (value.includes('mealCarbs.')) return 'Meal Carbs';
  if (value.includes('mealEffect.')) return 'Meal Effect';
  if (value === 'activeInsulin') return 'Active Insulin';
  if (value === 'insulinDose') return 'Insulin Doses';
  if (value === 'totalInsulinEffect') return 'Active Insulin Effect';
  if (value === 'insulinImpactMgdL') return 'Insulin Impact (IOB)';
  if (value.includes('insulinDoses.')) return 'Insulin Dose';
  if (value === 'expectedBloodSugarWithNetEffect') return 'Net Effect (Meals + Insulin)';

  if (value.includes('breakfast') || value.includes('lunch') ||
      value.includes('dinner') || value.includes('snack')) {
    const mealType = value.split(' (')[0];
    return mealType.charAt(0).toUpperCase() + mealType.slice(1);
  }

  return value;
};

// ==========================================
// CUSTOM DOT RENDERERS
// ==========================================

/**
 * Custom dot renderer for blood sugar readings on chart
 *
 * @param {Object} props - Recharts dot props
 * @param {number} targetGlucose - Target glucose value for status coloring
 * @returns {JSX.Element|null} Custom dot SVG element
 */
export const CustomBloodSugarDot = (props, targetGlucose = 100) => {
  const { cx, cy, payload, index } = props;

  if (!payload || payload.isInterpolated || payload.source === 'interpolated') {
    return null;
  }

  const value = payload.bloodSugar || payload.baseBG || targetGlucose;
  let dotColor = '#8031A7';

  if (value > targetGlucose * 1.3) {
    dotColor = '#ff8800';
  } else if (value < targetGlucose * 0.7) {
    dotColor = '#ff4444';
  } else if (value >= targetGlucose * 0.9 && value <= targetGlucose * 1.1) {
    dotColor = '#4CAF50';
  }

  return (
    <circle
      key={`custom-dot-${index}`}
      cx={cx}
      cy={cy}
      r={4}
      fill={dotColor}
      stroke="#fff"
      strokeWidth={2}
    />
  );
};

// ==========================================
// STICKY TOOLTIP LOGIC
// ==========================================

/**
 * Create sticky tooltip handlers
 *
 * @returns {Object} Tooltip state and handlers
 */
export const useStickyTooltip = () => {
  const [stickyTooltip, setStickyTooltip] = React.useState(null);
  const [tooltipPosition, setTooltipPosition] = React.useState({ left: 0, top: 0 });

  const handleChartClick = (data) => {
    if (!data || !data.activePayload || data.activePayload.length === 0) {
      return;
    }

    setStickyTooltip(data.activePayload[0].payload);
    setTooltipPosition({
      left: data.chartX || 0,
      top: data.chartY || 0
    });
  };

  const handleCloseTooltip = () => {
    setStickyTooltip(null);
  };

  return {
    stickyTooltip,
    tooltipPosition,
    handleChartClick,
    handleCloseTooltip
  };
};

// ==========================================
// COMMON TOOLTIP COMPONENTS
// ==========================================

export const TooltipSection = ({
  children,
  backgroundColor = '#f9fafb',
  borderColor = null,
  marginBottom = '10px',
  padding = '8px'
}) => {
  return (
    <div style={{
      marginBottom,
      padding,
      backgroundColor,
      borderRadius: '6px',
      ...(borderColor && { border: `2px solid ${borderColor}` })
    }}>
      {children}
    </div>
  );
};

export const TooltipHeader = ({ children, icon = null, color = '#6b7280' }) => {
  return (
    <p style={{
      fontSize: '11px',
      fontWeight: '700',
      color,
      marginBottom: '6px',
      textTransform: 'uppercase'
    }}>
      {icon && <span style={{ marginRight: '4px' }}>{icon}</span>}
      {children}
    </p>
  );
};

export const TooltipRow = ({ label, value, valueColor = null, fontSize = '12px' }) => {
  return (
    <div style={{ fontSize, marginBottom: '4px' }}>
      <span style={{ color: '#6b7280' }}>{label}:</span>{' '}
      <strong style={valueColor ? { color: valueColor } : {}}>
        {value}
      </strong>
    </div>
  );
};

export const TooltipContainer = ({ children, title = null, isSticky = false, onClose = null }) => {
  return (
    <div
      className="custom-tooltip"
      style={{
        backgroundColor: 'white',
        padding: '12px',
        borderRadius: '8px',
        boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
        maxWidth: '350px',
        ...(isSticky && {
          position: 'fixed',
          zIndex: 1000,
          border: '2px solid #3b82f6'
        })
      }}
    >
      {isSticky && onClose && (
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '8px'
        }}>
          {title && <h4 style={{ margin: 0, fontSize: '14px' }}>{title}</h4>}
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '18px',
              cursor: 'pointer',
              padding: '0 4px',
              color: '#6b7280'
            }}
            aria-label="Close tooltip"
          >
            ✕
          </button>
        </div>
      )}
      {children}
    </div>
  );
};

// ==========================================
// CHART CONFIGURATION HELPERS
// ==========================================

export const CHART_MARGINS = {
  default: { top: 20, right: 80, left: 80, bottom: 20 },
  withLegend: { top: 20, right: 100, left: 80, bottom: 90 },
  compact: { top: 10, right: 20, left: 10, bottom: 10 }
};

export const STROKE_PATTERNS = {
  solid: '0',
  dashed: '5 5',
  dotted: '2 2',
  dashedLong: '10 5',
  dashedDot: '10 5 2 5'
};

export const ANIMATION_CONFIG = {
  animationDuration: 750,
  animationEasing: 'ease-in-out'
};

// ==========================================
// UTILITY EXPORTS
// ==========================================

export const isInRange = (value, target, tolerance = 0.1) => {
  return value >= target * (1 - tolerance) && value <= target * (1 + tolerance);
};

export const formatTimeDifference = (timestamp1, timestamp2) => {
  const diffMs = Math.abs(new Date(timestamp1) - new Date(timestamp2));
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
};

export const truncateText = (text, maxLength = 30) => {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
};

// ==========================================
// MEAL DISPLAY UTILITIES
// ==========================================

/**
 * Helper function to get meal type display info
 * @param {string} mealType - Meal type (breakfast, lunch, dinner, snack)
 * @param {string} absorptionType - Absorption type (fast, medium, slow)
 * @returns {Object} Display info including name, type, color
 */
export const getMealTypeDisplay = (mealType, absorptionType = 'medium') => {
  const formatName = (type) =>
    type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  const typeColors = {
    'fast': '#FF6B6B',
    'medium': '#FF9800',
    'slow': '#4CAF50',
    'very_slow': '#2196F3'
  };

  const typeLabels = {
    'fast': 'Fast Absorption',
    'medium': 'Medium Absorption',
    'slow': 'Slow Absorption',
    'very_slow': 'Very Slow Absorption'
  };

  const mealColors = {
    'breakfast': '#FFB74D',
    'lunch': '#FF9800',
    'dinner': '#F57C00',
    'snack': '#9C27B0'
  };

  return {
    displayName: formatName(mealType || 'meal'),
    absorptionType: typeLabels[absorptionType] || absorptionType,
    color: mealColors[mealType?.toLowerCase()] || typeColors[absorptionType] || '#FF9800',
    absorptionColor: typeColors[absorptionType] || '#FF9800'
  };
};

/**
 * Get color for meal elements
 *
 * @param {string} mealType - Type of meal
 * @param {number} index - Index for color cycling
 * @param {boolean} isEffect - Whether to darken for effect variation
 * @returns {string} Hex color for the meal element
 */
export const getMealColor = (mealType, index, isEffect = false) => {
  const colors = [
    '#FF9800', '#FFB74D', '#F57C00', '#FF6B6B',
    '#FF8042', '#FFC658', '#FFBB28', '#FFD700',
    '#FFA500', '#FF7F50'
  ];

  const baseColor = colors[index % colors.length];

  if (isEffect) {
    return adjustColorBrightness(baseColor, -20);
  }

  return baseColor;
};

/**
 * Process meals from context for chart visualization
 * Filters by time range and normalizes timestamps
 *
 * @param {Array} contextMeals - Raw meals from context
 * @param {{ start: number, end: number }} timeRange - Visible chart range
 * @returns {Array} Processed meals ready for chart
 */
export const processContextMealsForChart = (contextMeals, timeRange, patientConstants) => {
  if (!contextMeals || !Array.isArray(contextMeals)) return [];

  const LOOKBACK_MS = 8 * 3600 * 1000; // 8 hours lookback for meal effects
  const effectiveStart = timeRange.start - LOOKBACK_MS;

  // ✅ FIX 1: Accept patientConstants and compute carbEquiv when absent.
  // recentMealsData returns raw meal records where carb data lives inside
  // meal.nutrition, not at meal.carbEquiv. Without this, dose markers never
  // render because EffectsVisualization.js accesses m.carbEquiv directly with
  // no fallback (unlike the effects calculation which does have a fallback).
  const proteinFactor = patientConstants?.protein_factor || 0.5;
  const fatFactor    = patientConstants?.fat_factor    || 0.2;

  return contextMeals
    .filter(meal => {
      const mealTime = typeof meal.timestamp === 'number'
        ? meal.timestamp
        : new Date(meal.timestamp).getTime();
      return mealTime >= effectiveStart && mealTime <= timeRange.end;
    })
    .map(meal => {
      // Normalize timestamp to a number
      const timestamp = typeof meal.timestamp === 'number'
        ? meal.timestamp
        : new Date(meal.timestamp).getTime();

      // Resolve carbEquiv: prefer top-level value, then drill into nutrition
      let carbEquiv = meal.carbEquiv;
      if (!carbEquiv || carbEquiv <= 0) {
        const nutrition = meal.nutrition || {};
        carbEquiv = nutrition.totalCarbEquiv || nutrition.total_carb_equiv;
        if (!carbEquiv || carbEquiv <= 0) {
          const carbs   = parseFloat(nutrition.carbs    || nutrition.totalCarbs || nutrition.total_carbs || 0);
          const protein = parseFloat(nutrition.protein  || 0);
          const fat     = parseFloat(nutrition.fat      || 0);
          carbEquiv = carbs + (protein * proteinFactor) + (fat * fatFactor);
        }
      }

      return {
        ...meal,
        timestamp,
        carbEquiv: parseFloat(carbEquiv) || 0
      };
    })
    .sort((a, b) => a.timestamp - b.timestamp);
};

/**
 * Find meals at a specific time within a threshold
 *
 * @param {Array} meals - Processed meals array
 * @param {number} time - Target time in milliseconds
 * @param {number} threshold - Time threshold in milliseconds (default 5 minutes)
 * @returns {Array} Meals found at the specified time
 */
export const findMealAtTime = (meals, time, threshold = 5 * 60 * 1000) => {
  return meals.filter(meal => {
    const mealTime = meal.timestamp;
    return Math.abs(mealTime - time) < threshold;
  });
};

/**
 * Custom Meal Tooltip Component
 * Displays meal details with proper formatting
 */
export const CustomMealTooltip = ({ active, payload, label, patientConstants }) => {
  if (!active || !payload || payload.length === 0) return null;

  const data = payload[0].payload;
  if (!data) return null;

  return (
    <TooltipContainer>
      <TooltipHeader>
        <strong>{data.timeLabel || new Date(data.time).toLocaleTimeString()}</strong>
        {data.isNow && <span style={{ marginLeft: '8px', color: '#2196F3' }}>NOW</span>}
      </TooltipHeader>

      {data.mealContributions && data.mealContributions.length > 0 && (
        <TooltipSection>
          <TooltipHeader icon="🍽️">Active Meals</TooltipHeader>
          {data.mealContributions.map((meal, idx) => {
            const display = getMealTypeDisplay(meal.mealType, meal.absorptionType);
            return (
              <div key={idx} style={{ marginBottom: '8px', paddingBottom: '8px', borderBottom: idx < data.mealContributions.length - 1 ? '1px solid #e0e0e0' : 'none' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <strong style={{ color: display.color }}>{display.displayName}</strong>
                  <span style={{ fontSize: '11px', color: '#666' }}>{meal.hoursSinceMeal}h ago</span>
                </div>
                <div style={{ fontSize: '11px', color: '#666', marginBottom: '4px' }}>
                  {display.absorptionType} • {meal.phase}
                </div>
                <div style={{ fontSize: '12px' }}>
                  <TooltipRow label="Absorbed" value={`${meal.absorbedCarbs}g`} />
                  <TooltipRow label="MOB" value={`${meal.mob}g`} />
                  <TooltipRow label="Activity" value={`${meal.activity}%`} />
                  <TooltipRow label="BG Impact" value={`+${meal.bgElevation} mg/dL`} valueColor="#f44336" />
                  <TooltipRow label="Pending" value={`+${meal.mobBGPotential} mg/dL`} valueColor="#4CAF50" />
                </div>
              </div>
            );
          })}
        </TooltipSection>
      )}

      {data.isStacking && (
        <div style={{
          marginTop: '8px',
          padding: '6px 8px',
          backgroundColor: '#FFF3CD',
          borderRadius: '4px',
          fontSize: '12px',
          color: '#856404'
        }}>
          ⚠️ {data.mealContributions.length} meals overlapping
        </div>
      )}
    </TooltipContainer>
  );
};