/**
 * ============================================================================
 * CHART UTILS - Common Chart Utilities for All Visualizations (Mobile)
 * ============================================================================
 *
 * VERSION: 2.0 - MOBILE PORT (TypeScript / React Native)
 *
 * Ported from frontend/src/utils/ChartUtils.js
 *
 * Changes from web version:
 * - Full TypeScript typings added throughout
 * - JSX tooltip components rewritten for React Native (View/Text/Pressable)
 * - CSS class names and web-only style properties removed
 * - boxShadow → elevation + shadowColor/Offset/Opacity/Radius
 * - CustomBloodSugarDot is chart-library-agnostic (returns data, not SVG)
 * - useStickyTooltip adapted for touch (no chartX/chartY from mouse events)
 *
 * Place at: mobile/utils/ChartUtils.ts
 * ============================================================================
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { VictoryAxis } from 'victory-native';

import TimeManager from './time/TimeManager';
import {
  SHARED_CONSTANTS,
  type PatientConstants as SharedPatientConstants,
  type ViewModeConfig,
  MEAL_ABSORPTION_PROFILES,
} from '../constants/shared-constants';
import { type InsulinDoseForStacking } from './insulin/pharmacodynamics';

// FIX N-6: IOB_LOOKBACK_HOURS removed — it was dead code (no longer referenced
// anywhere in this file since processContextInsulinForChart switched to
// const cutoffTime = timeRange.start).  The misleading fallback of 8 (vs. the
// 48 used in useActiveEffects) was a maintenance trap; if a future author
// needs a lookback constant here, derive it from SHARED_CONSTANTS directly
// or import the 48-hour value from useActiveEffects.

// ─── Safe hardcoded floor — always correct regardless of SHARED_CONSTANTS ────
// Previously VIEW_CONFIGS was an all-or-nothing override: if SHARED_CONSTANTS
// .VIEW_MODE_CONFIGS existed but was missing or wrong for a key (e.g. '12h'
// with pastHours: 4 instead of 10), the entire hardcoded fallback was thrown
// away and useChartTimeRange fell back to { pastHours: 3, futureHours: 1 },
// causing the 12H graph to only show ~6h of data.
//
// Fix: always start from the correct hardcoded defaults, then spread
// SHARED_CONSTANTS on top so it can intentionally extend or override a key
// without silently breaking other views.
const _DEFAULT_VIEW_CONFIGS: Record<string, any> = {
  '3h':  { label: '3H',  pastHours: 2,  futureHours: 1,  tickInterval: 0.5, tickFormat: 'HH:mm',  interpolationInterval: 5  },
  '6h':  { label: '6H',  pastHours: 4,  futureHours: 2,  tickInterval: 1,   tickFormat: 'HH:mm',  interpolationInterval: 5  },
  '12h': { label: '12H', pastHours: 10, futureHours: 2,  tickInterval: 2,   tickFormat: 'HH:mm',  interpolationInterval: 10 },
  '24h': { label: '24H', pastHours: 20, futureHours: 4,  tickInterval: 3,   tickFormat: 'HH:mm',  interpolationInterval: 15 },
  '3d':  { label: '3D',  pastHours: 68, futureHours: 4,  tickInterval: 6,   tickFormat: 'MM/DD',  interpolationInterval: 30 },
  // 'week' and 'month' are defined in SHARED_CONSTANTS.VIEW_MODE_CONFIGS and merged below
};

export const VIEW_CONFIGS: Record<string, any> = {
  ..._DEFAULT_VIEW_CONFIGS,
  ...((SHARED_CONSTANTS as any)?.VIEW_MODE_CONFIGS ?? {}),
};

// ============================================================
// TYPES
// ============================================================

export interface TimeRange {
  start: number;
  end: number;
  now?: number;
}

// ViewConfig is re-exported from shared-constants as ViewModeConfig.
// The alias lets existing imports of ViewConfig continue to work.
export type { ViewModeConfig as ViewConfig } from '../constants/shared-constants';
type ViewConfig = ViewModeConfig;

export interface ChartDataPoint {
  timestamp?: number;
  time?: number;
  mealImpact?: number;
  insulinImpact?: number;
  netEffect?: number;
  cumulativeNetBaseline?: number;
  mealDoseMarker?: number;
  insulinDoseMarker?: number;
  bloodSugar?: number;
  baseBG?: number;
  isActualReading?: boolean;
  isFuture?: boolean;
  isInterpolated?: boolean;
  source?: string;
  [key: string]: any;
}

// PatientConstants is re-exported from shared-constants (authoritative source).
export type { PatientConstants } from '../constants/shared-constants';
/** Convenience alias so call-sites that previously imported PatientConstants from
 *  ChartUtils continue to work without changes. */
type PatientConstants = SharedPatientConstants;

export interface InsulinFactorData {
  type: string;
  onset_hours: number;
  peak_hours: number;
  duration_hours: number;
  is_peakless?: boolean;
  brand_names?: string[];
}

export interface InsulinTypeDisplay {
  displayName: string;
  type: string;
  onset?: string;
  peak?: string;
  duration?: string;
  color: string;
  isLongActing?: boolean;
  isPeakless?: boolean;
  brandNames?: string[];
}

export interface MealTypeDisplay {
  displayName: string;
  absorptionType: string;
  color: string;
  absorptionColor: string;
}

export interface ConfidenceLevel {
  level: string;
  color: string;
  label: string;
}

export interface ProcessedInsulinDose {
  administrationTime: number;
  dose: number;
  medication: string;
  insulinType: string;
  id?: string | number;
}

export interface ProcessedMeal {
  timestamp: number;
  [key: string]: any;
}

// ============================================================
// COLOR UTILITIES
// ============================================================

/**
 * Adjust hex color brightness.
 * @param hex   - e.g. '#FF5722'
 * @param percent - negative to darken, positive to lighten
 */
export const adjustColorBrightness = (hex: string, percent: number): string => {
  let r = parseInt(hex.substring(1, 3), 16);
  let g = parseInt(hex.substring(3, 5), 16);
  let b = parseInt(hex.substring(5, 7), 16);

  r = Math.min(255, Math.max(0, r + percent));
  g = Math.min(255, Math.max(0, g + percent));
  b = Math.min(255, Math.max(0, b + percent));

  return `#${r.toString(16).padStart(2, '0')}${g
    .toString(16)
    .padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
};

/**
 * Get blood-sugar status colour based on value vs target.
 */
export const getBloodSugarStatusColor = (
  value: number,
  targetGlucose: number
): string => {
  if (value > targetGlucose * 1.3) return '#ff8800'; // High
  if (value < targetGlucose * 0.7) return '#ff4444'; // Low
  if (value >= targetGlucose * 0.9 && value <= targetGlucose * 1.1)
    return '#4CAF50'; // In range
  return '#8031A7'; // Normal-ish
};

/**
 * Consistent colour for insulin chart elements.
 */
export const getInsulinColor = (
  insulinType: string | undefined,
  index: number,
  isEffect = false
): string => {
  if (insulinType === undefined) return '#4a90e2';

  const colors = [
    '#8884d8', '#82ca9d', '#ffc658', '#ff8042',
    '#0088fe', '#00C49F', '#FFBB28', '#FF8042',
    '#a4de6c', '#d0ed57',
  ];

  const baseColor = colors[index % colors.length];
  return isEffect ? adjustColorBrightness(baseColor, -20) : baseColor;
};

// ============================================================
// INSULIN DISPLAY UTILITIES
// ============================================================

const TYPE_COLORS: Record<string, string> = {
  rapid_acting: '#FF6B6B',
  short_acting: '#FF8E53',
  intermediate_acting: '#4ECDC4',
  long_acting: '#45B7D1',
  mixed: '#96CEB4',
};

const TYPE_LABELS: Record<string, string> = {
  rapid_acting: 'Rapid-Acting',
  short_acting: 'Short-Acting',
  intermediate_acting: 'Intermediate-Acting',
  long_acting: 'Long-Acting',
  mixed: 'Mixed',
};

const formatName = (type: string): string =>
  type.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());

/**
 * Get display info for an insulin type.
 */
export const getInsulinTypeDisplay = (
  insulinType: string,
  patientConstants?: PatientConstants
): InsulinTypeDisplay => {
  const medicationFactors = patientConstants?.medication_factors ?? {};
  const insulinData: InsulinFactorData | undefined = medicationFactors[insulinType];

  if (!insulinData) {
    return { displayName: formatName(insulinType), type: 'Rapid-Acting', color: '#FF6B6B' };
  }

  return {
    displayName: formatName(insulinType),
    type: TYPE_LABELS[insulinData.type] ?? insulinData.type,
    onset: `${(insulinData.onset_hours * 60).toFixed(0)} min`,
    peak: insulinData.is_peakless ? 'Peakless' : `${insulinData.peak_hours.toFixed(1)} hrs`,
    duration: `${insulinData.duration_hours.toFixed(1)} hrs`,
    color: TYPE_COLORS[insulinData.type] ?? '#666666',
    isLongActing: insulinData.type === 'long_acting',
    isPeakless: insulinData.is_peakless,
    brandNames: insulinData.brand_names ?? [],
  };
};

// ============================================================
// MEAL DISPLAY UTILITIES
// ============================================================

const MEAL_TYPE_COLORS: Record<string, string> = {
  fast: '#FF6B6B',
  medium: '#FF9800',
  slow: '#4CAF50',
  very_slow: '#2196F3',
};

const ABSORPTION_LABELS: Record<string, string> = {
  fast: 'Fast Absorption',
  medium: 'Medium Absorption',
  slow: 'Slow Absorption',
  very_slow: 'Very Slow Absorption',
};

const MEAL_COLORS: Record<string, string> = {
  breakfast: '#FFB74D',
  lunch: '#FF9800',
  dinner: '#F57C00',
  snack: '#9C27B0',
};

export const getMealTypeDisplay = (
  mealType: string,
  absorptionType = 'medium'
): MealTypeDisplay => ({
  displayName: formatName(mealType || 'meal'),
  absorptionType: ABSORPTION_LABELS[absorptionType] ?? absorptionType,
  color:
    MEAL_COLORS[mealType?.toLowerCase()] ??
    MEAL_TYPE_COLORS[absorptionType] ??
    '#FF9800',
  absorptionColor: MEAL_TYPE_COLORS[absorptionType] ?? '#FF9800',
});

export const getMealColor = (
  mealType: string,
  index: number,
  isEffect = false
): string => {
  const colors = [
    '#FF9800', '#FFB74D', '#F57C00', '#FF6B6B',
    '#FF8042', '#FFC658', '#FFBB28', '#FFD700',
    '#FFA500', '#FF7F50',
  ];
  const baseColor = colors[index % colors.length];
  return isEffect ? adjustColorBrightness(baseColor, -20) : baseColor;
};

// ============================================================
// SHARED HOOKS
// ============================================================

/**
 * Returns a timestamp rounded to the nearest minute, refreshed at each minute boundary.
 */
export const useCurrentMinute = (): number => {
  const [currentMinute, setCurrentMinute] = useState<number>(() =>
    TimeManager.getCurrentTime(TimeManager.precision.MINUTE)
  );

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const update = () => {
      setCurrentMinute(TimeManager.getCurrentTime(TimeManager.precision.MINUTE));
    };

    const msUntilNextMinute = 60_000 - (Date.now() % 60_000);

    const syncTimeout = setTimeout(() => {
      update();
      intervalId = setInterval(update, 60_000);
    }, msUntilNextMinute);

    return () => {
      clearTimeout(syncTimeout);
      if (intervalId !== null) clearInterval(intervalId);
    };
  }, []);

  return currentMinute;
};

/**
 * Compute visible time range for a chart given a view mode.
 * Implements the shared 7 AM anchor logic for 12h / 24h views.
 */
export const useChartTimeRange = (
  viewMode: string,
  currentMinute: number
): TimeRange => {
  const viewConfig: ViewConfig = VIEW_CONFIGS[viewMode] ?? {
    label: '',
    pastHours: 3,
    futureHours: 1,
    tickInterval: 1,
    tickFormat: 'HH:mm',
    interpolationInterval: 5,
    mealLookback: 8,
    insulinLookback: 8,
  };

  const timeRange = useMemo<TimeRange>(() => {
    const now = currentMinute;
    const currentDate = new Date(now);

    const sevenAMToday = new Date(currentDate);
    sevenAMToday.setHours(7, 0, 0, 0);

    const sevenAMYesterday = new Date(sevenAMToday);
    sevenAMYesterday.setDate(sevenAMYesterday.getDate() - 1);

    let start: number;
    let end: number;

    if (viewMode === '6h' || viewMode === '12h') {
      // ── Sliding window for short-to-medium views ─────────────────────────
      // The 7 AM daily-anchor is wrong here: at 1 PM in "12h" mode it would
      // show 7 AM → 7 PM, giving only 6 h of historical data and 6 h of
      // future projection. A sliding window always shows the last N hours.
      start = now - viewConfig.pastHours * 60 * 60 * 1_000;
      end   = now + viewConfig.futureHours * 60 * 60 * 1_000;
    } else if (viewMode === '24h') {
      const sevenAMTwoDaysAgo = new Date(sevenAMYesterday);
      sevenAMTwoDaysAgo.setDate(sevenAMTwoDaysAgo.getDate() - 1);
      start = now >= sevenAMToday.getTime()
        ? sevenAMYesterday.getTime()
        : sevenAMTwoDaysAgo.getTime();

      // FIX: was hardcoded to "tomorrow 8AM" which created an arbitrary large
      // future window regardless of the configured futureHours. Use
      // now + futureHours to match all other view modes.
      end = now + viewConfig.futureHours * 60 * 60 * 1_000;
    } else {
      start = now - viewConfig.pastHours * 60 * 60 * 1_000;
      end   = now + viewConfig.futureHours * 60 * 60 * 1_000;
    }

    return { start, end, now };
  }, [viewConfig, currentMinute, viewMode]);

  return timeRange;
};
// ============================================================
// SHARED MEAL / INSULIN PROCESSING
// ============================================================

/**
 * Filter and normalise raw insulin doses from context for chart use.
 */
export const processContextInsulinForChart = (
  contextInsulin: any[],
  timeRange: TimeRange
): ProcessedInsulinDose[] => {
  if (!contextInsulin || contextInsulin.length === 0) return [];

  const { end } = timeRange;

  // BUG FIX: the previous cutoff was `timeRange.start - IOB_LOOKBACK_HOURS * 3600s`.
  // IOB_LOOKBACK_HOURS falls back to 8 when SHARED_CONSTANTS is unavailable,
  // meaning doses older than (rangeStart − 8 h) were silently discarded even
  // when the chart window was a full week.  For the Week view, rangeStart is
  // ~168 h ago, so any dose between 168 h ago and 176 h ago was kept — but
  // anything farther back (e.g. 27/03 at 72 h) was dropped.
  //
  // The caller (useActiveEffects + EffectsVisualizationChart) already controls
  // how far back data is fetched via windowHours.  This function just needs to
  // pass through whatever arrived — use timeRange.start as the lower bound
  // so doses across the full visible chart window are always retained.
  const cutoffTime = timeRange.start;

  return contextInsulin
    .filter((dose) => {
      const doseTime = TimeManager.parseTimestamp(
        dose.administrationTime ?? dose.taken_at ?? dose.scheduled_time,
        TimeManager.precision.SECOND
      );
      if (!doseTime || doseTime === 0 || isNaN(doseTime)) return false;
      return doseTime >= cutoffTime && doseTime <= end;
    })
    .map((dose) => {
      let doseTime: number;
      if (dose.administrationTime && typeof dose.administrationTime === 'number') {
        doseTime = dose.administrationTime;
      } else if (dose.taken_at) {
        doseTime = new Date(dose.taken_at).getTime();
      } else {
        doseTime = new Date(dose.scheduled_time).getTime();
      }

      return {
        administrationTime: doseTime,
        dose: parseFloat(dose.dose ?? dose.amount ?? dose.units) || 0,
        medication:
          dose.medication ?? dose.insulinType ?? dose.insulin_type ?? 'regular_insulin',
        insulinType:
          dose.medication ?? dose.insulinType ?? dose.insulin_type ?? 'regular_insulin',
        id: dose.id ?? dose._id,
      };
    });
};

/**
 * UTC-safe timestamp parser for bare ISO strings coming from the backend.
 *
 * The backend stores timestamps in UTC but frequently omits the 'Z' suffix
 * (e.g. "2026-02-13T22:38:00").  Browsers treat bare ISO strings as LOCAL
 * time, introducing a ±hours offset equal to the user's UTC offset.
 * This function appends 'Z' when no timezone indicator is present so the
 * parsed millisecond value is always correct UTC, matching the fix in
 * TimeManager.ts parseTimestampRaw().
 *
 * Also handles the numeric-timestamp fast-path (already UTC ms).
 */
export function parseUTCMs(ts: string | number | null | undefined): number {
  if (ts === null || ts === undefined || ts === '') return NaN;
  if (typeof ts === 'number') return isFinite(ts) ? ts : NaN;
  // FIX N-5: numeric-string fast-path, matching the module-local copy in
  // cumulative-effects.ts.  Without this, a stringified millisecond value
  // (e.g. "1748390400000") would reach new Date("1748390400000Z") →
  // Invalid Date → NaN, silently dropping the associated meal or dose.
  if (/^\d+$/.test(ts)) return parseInt(ts, 10);
  const hasZone =
    ts.endsWith('Z') || ts.includes('+') || /T.*-\d{2}:\d{2}$/.test(ts);
  return hasZone
    ? new Date(ts).getTime()
    : new Date(ts.replace(' ', 'T') + 'Z').getTime();
}

/**
 * Filter and normalise raw meals from context for chart use.
 * Applies an 8-hour lookback window for meal effects.
 *
 * ✅ FIX 1: Accept patientConstants and compute carbEquiv when absent.
 * recentMealsData returns raw meal records where carb data lives inside
 * meal.nutrition, not at meal.carbEquiv.  Without this, dose markers never
 * render because the chart component accesses m.carbEquiv directly with
 * no fallback (unlike the effects calculation which has its own fallback).
 *
 * ✅ FIX 2 (UTC timestamp + alias resolution):
 * The backend shapes meals with various timestamp field names
 * (meal_time, logged_at, created_at, takenAt) and always omits the 'Z'
 * suffix.  `new Date(bare_string)` interprets those as LOCAL time,
 * producing NaN or wrong values.  We now:
 *   a) resolve all timestamp aliases before parsing
 *   b) use parseUTCMs() which appends 'Z' for bare strings
 * Without this fix, all meal timestamps were NaN → every meal was filtered
 * out → processedMeals was always [] → activeMealsAtTime was always [] →
 * calculateTotalCumulativeEffects received no meals → cumulativeNetBaseline
 * was 0 for every chart point → the cumulative VictoryArea had zero height
 * and was invisible even with the toggle on.
 */
export const processContextMealsForChart = (
  contextMeals: any[],
  timeRange: TimeRange,
  patientConstants?: PatientConstants
): ProcessedMeal[] => {
  if (!contextMeals || !Array.isArray(contextMeals)) return [];

  const LOOKBACK_MS = 8 * 3_600 * 1_000;
  const effectiveStart = timeRange.start - LOOKBACK_MS;

  const proteinFactor: number = (patientConstants as any)?.protein_factor ?? 0.5;
  const fatFactor: number    = (patientConstants as any)?.fat_factor    ?? 0.2;

  return contextMeals
    .filter((meal) => {
      // ✅ FIX: resolve all timestamp aliases, then UTC-safe parse
      const rawTs =
        meal.timestamp  ??
        meal.meal_time  ??
        meal.logged_at  ??
        meal.created_at ??
        meal.takenAt    ??
        null;
      const mealTime = parseUTCMs(rawTs);
      if (isNaN(mealTime)) return false;
      return mealTime >= effectiveStart && mealTime <= timeRange.end;
    })
    .map((meal) => {
      // ✅ FIX: same alias resolution + UTC-safe parse for the mapped timestamp
      const rawTs =
        meal.timestamp  ??
        meal.meal_time  ??
        meal.logged_at  ??
        meal.created_at ??
        meal.takenAt    ??
        null;
      const timestamp = parseUTCMs(rawTs);

      // Resolve carbEquiv: prefer top-level, then calculation_summary (backend
      // field — this is where the server stores the processed carb equivalent),
      // then drill into the nutrition object, finally compute from macros.
      //
      // ✅ FIX: calculation_summary.total_carb_equiv was previously skipped,
      // causing carbEquiv = 0 whenever the backend stored it there.  The dose-
      // marker code in buildChartPoint already checked calculation_summary first;
      // this brings processContextMealsForChart into alignment so that
      // calculateStackedMealEffect receives the correct carb amount and can
      // return a non-zero totalBGElevation, making the meal-effect area visible.
      let carbEquiv: number =
        meal.carbEquiv ||
        meal.calculation_summary?.total_carb_equiv ||
        0;
      if (!carbEquiv || carbEquiv <= 0) {
        const nutrition = meal.nutrition ?? {};
        carbEquiv =
          nutrition.totalCarbEquiv ??
          nutrition.total_carb_equiv;
        if (!carbEquiv || carbEquiv <= 0) {
          const carbs   = parseFloat(nutrition.carbs    ?? nutrition.totalCarbs ?? nutrition.total_carbs ?? 0);
          const protein = parseFloat(nutrition.protein  ?? 0);
          const fat     = parseFloat(nutrition.fat      ?? 0);
          carbEquiv = carbs + protein * proteinFactor + fat * fatFactor;
        }
      }

      return {
        ...meal,
        timestamp,
        carbEquiv: parseFloat(String(carbEquiv)) || 0,
      };
    })
    .sort((a, b) => a.timestamp - b.timestamp);
};

// ============================================================
// SHARED DOSE / MEAL NORMALIZATION & STACKING HELPERS
// (Previously duplicated in EffectsVisualizationChart and BloodGlucoseVisualization)
// ============================================================

/** Compute last daily reset in UTC ms (mirrors backend TimeManager). */
export function getLastResetTimeMs(
  currentTime: Date,
  resetHour: number,
  tzOffsetMinutes: number
): number {
  const offsetMs   = tzOffsetMinutes * 60 * 1_000;
  const localMs    = currentTime.getTime() + offsetMs;
  const resetLocal = new Date(localMs);
  resetLocal.setUTCHours(resetHour, 0, 0, 0);
  if (localMs < resetLocal.getTime()) {
    resetLocal.setUTCDate(resetLocal.getUTCDate() - 1);
  }
  return resetLocal.getTime() - offsetMs;
}

/** Get absorption duration for a meal (hours).
 *
 * Checks camelCase `durationHours` before snake_case `duration_hours` so this
 * function is consistent with the cumulative-effects lock-in model, which
 * uses the same precedence order (camelCase first, then snake_case, then 4 h).
 * Falls back to the `medium` profile before applying the hard 4.0 h default so
 * a missing-key absType never silently produces a wrong window.
 */
export function getMealDurationHours(meal: any): number {
  const absType =
    meal?.calculation_summary?.absorption_type ||
    meal?.nutrition?.absorption_type ||
    meal?.nutrition?.absorptionType ||
    'medium';
  const profile: any =
    (MEAL_ABSORPTION_PROFILES as any)?.[absType] ??
    (MEAL_ABSORPTION_PROFILES as any)?.['medium'];
  return profile?.durationHours ?? profile?.duration_hours ?? 4.0;
}

/**
 * Normalise a raw API meal to the canonical shape expected by chart and
 * display calculations.  Guarantees that `calculation_summary` and `nutrition`
 * are always objects (never undefined) so downstream property access is safe.
 */
export function normaliseMeal(raw: any): any {
  return {
    ...raw,
    id:                  raw.id ?? String(raw._id ?? ''),
    calculation_summary: raw.calculation_summary ?? {},
    nutrition:           raw.nutrition           ?? {},
  };
}

/** Normalise a raw API dose to the canonical InsulinDose shape. */
export function normaliseDose(raw: any): any {
  return {
    ...raw,
    id:                 String(raw._id ?? raw.id ?? ''),
    units:              raw.dose ?? raw.units ?? raw.doseAmount ?? raw.amount ?? 0,
    administrationTime: raw.taken_at ?? raw.administrationTime ?? raw.takenAt ?? raw.timestamp ?? null,
    insulinType:        raw.medication ?? raw.insulinType ?? raw.insulin_type ?? 'regular_insulin',
    dose:               raw.dose ?? raw.units ?? raw.doseAmount ?? raw.amount ?? 0,
  };
}

/**
 * Convert a normalised dose to an InsulinDoseForStacking object at a given
 * target time.  Returns null if the dose has no valid timestamp, zero units,
 * or lies in the future relative to targetTime.
 */
export function doseToStacking(
  dose: any,
  targetTime: Date
): InsulinDoseForStacking | null {
  const units   = dose?.units ?? dose?.dose ?? 0;
  const takenAt = dose?.administrationTime ?? null;
  if (!takenAt || units <= 0) return null;
  const doseMs = parseUTCMs(takenAt);
  if (isNaN(doseMs)) return null;
  const hoursSinceDose = (targetTime.getTime() - doseMs) / (1_000 * 60 * 60);
  if (hoursSinceDose < 0) return null;
  return {
    dose: units,
    hoursSinceDose,
    insulinType: dose?.insulinType ?? dose?.medication ?? 'regular_insulin',
  };
}



/**
 * Generate hour-aligned X-axis ticks for a time range.
 */
export const generateXAxisTicks = (
  timeRange: TimeRange,
  viewConfig?: ViewConfig
): number[] => {
  const { start, end } = timeRange;
  const duration = end - start;
  const hourMs = 60 * 60 * 1_000;

  let tickIntervalMs: number;
  if (viewConfig?.tickInterval) {
    tickIntervalMs = viewConfig.tickInterval * hourMs;
  } else if (duration <= 6 * hourMs) {
    tickIntervalMs = hourMs;
  } else if (duration <= 12 * hourMs) {
    tickIntervalMs = 2 * hourMs;
  } else if (duration <= 24 * hourMs) {
    tickIntervalMs = 3 * hourMs;
  } else {
    tickIntervalMs = 6 * hourMs;
  }

  const ticks: number[] = [];
  const alignedStart = new Date(start);
  alignedStart.setMinutes(0, 0, 0);

  for (let time = alignedStart.getTime(); time <= end; time += tickIntervalMs) {
    if (time >= start) ticks.push(time);
  }

  return ticks;
};

/**
 * Generate symmetric Y-axis ticks around 0 (always includes 0).
 */
export const generateSymmetricTicks = (
  domain: [number, number],
  options: { intervals?: number[] } = {}
): number[] => {
  const [min, max] = domain;
  const range = max - min;
  const { intervals = [10, 20, 50, 100, 200] } = options;

  let interval = intervals[intervals.length - 1];
  if (range <= 50) interval = intervals[0] ?? 10;
  else if (range <= 100) interval = intervals[1] ?? 20;
  else if (range <= 200) interval = intervals[2] ?? 50;
  else if (range <= 400) interval = intervals[3] ?? 100;

  const ticks = new Set<number>([0]);
  for (let tick = 0; tick >= min; tick -= interval) ticks.add(tick);
  for (let tick = interval; tick <= max; tick += interval) ticks.add(tick);

  return [...ticks].sort((a, b) => a - b);
};

// ============================================================
// AXIS DOMAIN UTILITIES
// ============================================================

export const calculateEffectsAxisDomain = (
  chartData: ChartDataPoint[],
  options: { includeCumulative?: boolean; paddingFactor?: number } = {}
): [number, number] => {
  const { includeCumulative = true, paddingFactor = 0.15 } = options;
  if (!chartData || chartData.length === 0) return [-100, 100];

  const maxMeal = Math.max(...chartData.map((d) => d.mealImpact ?? 0), 0);
  const minInsulin = Math.min(...chartData.map((d) => d.insulinImpact ?? 0), 0);
  const maxNet = Math.max(...chartData.map((d) => Math.abs(d.netEffect ?? 0)), 0);

  let maxCumulative = 0;
  if (includeCumulative) {
    maxCumulative = Math.max(
      ...chartData.map((d) => Math.abs(d.cumulativeNetBaseline ?? 0)),
      0
    );
  }

  const maxAbsolute = Math.max(maxMeal, Math.abs(minInsulin), maxNet, maxCumulative);
  const padding = maxAbsolute * paddingFactor;
  const limit = Math.ceil(maxAbsolute + padding);

  return [-limit, limit];
};

export const calculateDoseAxisDomain = (
  chartData: ChartDataPoint[],
  paddingFactor = 0.2
): [number, number] => {
  if (!chartData || chartData.length === 0) return [-30, 30];

  const maxMealDose = Math.max(...chartData.map((d) => d.mealDoseMarker ?? 0), 0);
  const minInsulinDose = Math.min(...chartData.map((d) => d.insulinDoseMarker ?? 0), 0);
  const maxAbsolute = Math.max(maxMealDose, Math.abs(minInsulinDose));
  const limit = Math.ceil(maxAbsolute + maxAbsolute * paddingFactor);

  return [-limit, limit];
};

export const calculateCumulativeAxisDomain = (
  baselineValue: number | null,
  glucoseMin = 40,
  glucoseMax = 400
): [number, number] => {
  if (!baselineValue) return [-180, 180];
  const gRange = glucoseMax - glucoseMin;
  const baselineOffset = baselineValue - glucoseMin;
  return [-baselineOffset, gRange - baselineOffset];
};

export const calculateCumulativeAxisTicks = (
  baselineValue: number | null,
  glucoseTicks = [40, 80, 100, 120, 140, 180, 200, 250, 300, 350, 400]
): number[] | undefined => {
  if (!baselineValue) return undefined;
  return glucoseTicks.map((gTick) => gTick - baselineValue);
};

export const calculateDynamicBarSize = (
  chartWidth: number,
  pointsCount: number,
  options: { widthFraction?: number; minSize?: number; maxSize?: number } = {}
): number => {
  const { widthFraction = 0.4, minSize = 8, maxSize = 30 } = options;
  if (!pointsCount || pointsCount === 0) return 20;

  const effectiveWidth = chartWidth || 1_000;
  const widthPerPoint = effectiveWidth / pointsCount;
  const calculated = Math.floor(widthPerPoint * widthFraction);

  return Math.max(minSize, Math.min(maxSize, calculated));
};

// ============================================================
// CONFIDENCE UTILITIES
// ============================================================

export const getConfidenceLevel = (
  point: ChartDataPoint,
  baselineAge: number
): ConfidenceLevel => {
  if (point.isActualReading) {
    return { level: 'actual', color: '#4CAF50', label: 'Meter Reading' };
  }

  if (point.isFuture) {
    const minutesIntoFuture = ((point.timestamp ?? 0) - Date.now()) / 60_000;
    if (minutesIntoFuture < 30)
      return { level: 'projected_high', color: '#2196F3', label: 'Near-term Projection' };
    if (minutesIntoFuture < 120)
      return { level: 'projected_medium', color: '#9C27B0', label: 'Medium-term Projection' };
    return { level: 'projected_low', color: '#FF9800', label: 'Long-term Projection' };
  }

  if (baselineAge < 30) return { level: 'high', color: '#2196F3', label: 'High Confidence' };
  if (baselineAge < 90) return { level: 'medium', color: '#9C27B0', label: 'Medium Confidence' };
  if (baselineAge < 180) return { level: 'low', color: '#FF9800', label: 'Low Confidence' };
  return { level: 'very_low', color: '#F44336', label: 'Very Low Confidence' };
};

// ============================================================
// DOSE MATCHING UTILITIES
// ============================================================

export const findMealsAtTime = (
  meals: ProcessedMeal[],
  pointTimestamp: number,
  halfIntervalMs: number
): ProcessedMeal[] => {
  if (!meals || meals.length === 0) return [];
  return meals.filter((meal) => {
    const mealTime =
      typeof meal.timestamp === 'number'
        ? meal.timestamp
        : TimeManager.parseTimestamp(meal.timestamp, TimeManager.precision.SECOND);
    if (isNaN(mealTime)) return false;
    // ✅ FIX 2: Use <= so meals landing exactly at the midpoint between two
    // grid points (common in the 2-min 24h grid) are not silently dropped.
    return Math.abs(mealTime - pointTimestamp) <= halfIntervalMs;
  });
};

export const findInsulinAtTime = (
  insulinDoses: ProcessedInsulinDose[],
  pointTimestamp: number,
  halfIntervalMs: number
): ProcessedInsulinDose[] => {
  if (!insulinDoses || insulinDoses.length === 0) return [];
  return insulinDoses.filter(
    // ✅ FIX 2: <= mirrors the fix in findMealsAtTime above.
    (dose) => Math.abs((dose.administrationTime ?? 0) - pointTimestamp) <= halfIntervalMs
  );
};

export const findMealAtTime = (
  meals: ProcessedMeal[],
  time: number,
  threshold = 5 * 60 * 1_000
): ProcessedMeal[] =>
  meals.filter((meal) => Math.abs(meal.timestamp - time) < threshold);

// ============================================================
// X-AXIS FORMATTING
// ============================================================

export const createXAxisFormatter = (viewConfig: ViewConfig) => {
  return (timestamp: number): string =>
    TimeManager.formatDate(
      new Date(timestamp),
      viewConfig.tickFormat === 'HH:mm' ? 'HH:mm' : 'DD/MM HH:mm'
    );
};

// ============================================================
// CHART DOMAIN UTILITIES
// ============================================================

export const computeXDomain = (
  data: ChartDataPoint[],
  dateRange: { start: string; end: string },
  timeScale: { start?: number; end?: number } = {}
): [number, number] => {
  const rangeStart = new Date(dateRange.start).setHours(0, 0, 0, 0);
  const rangeEnd = new Date(dateRange.end).setHours(23, 59, 59, 999);

  let domainStart = rangeStart;
  let domainEnd = rangeEnd;

  if (data && data.length > 0) {
    const dataMin = data[0].timestamp ?? rangeStart;
    const dataMax = data[data.length - 1].timestamp ?? rangeEnd;
    domainStart = Math.min(rangeStart, dataMin);
    domainEnd = Math.max(rangeEnd, dataMax);
  }

  if (timeScale.start) domainStart = Math.min(domainStart, timeScale.start);
  if (timeScale.end) domainEnd = Math.max(domainEnd, timeScale.end);

  return [domainStart, domainEnd];
};

export const computeTickInterval = (domainStart: number, domainEnd: number): number => {
  const durationHours = (domainEnd - domainStart) / (1_000 * 60 * 60);

  if (durationHours <= 6) return 0.5;
  if (durationHours <= 12) return 1;
  if (durationHours <= 24) return 2;
  if (durationHours <= 48) return 4;
  if (durationHours <= 72) return 6;
  if (durationHours <= 168) return 12;
  return 24;
};

export const generateChartTicks = (
  domainStart: number,
  domainEnd: number,
  intervalHours: number
): number[] => {
  const ticks: number[] = [];
  const intervalMs = intervalHours * 60 * 60 * 1_000;
  const alignedStart = Math.ceil(domainStart / intervalMs) * intervalMs;

  for (let current = alignedStart; current <= domainEnd; current += intervalMs) {
    ticks.push(current);
  }
  return ticks;
};

// ============================================================
// FORMATTING UTILITIES
// ============================================================

export const formatXAxis = (timestamp: number | string, format = 'MM/DD HH:mm'): string => {
  const date = new Date(timestamp);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const mm  = pad(date.getMonth() + 1);
  const dd  = pad(date.getDate());
  const hh  = pad(date.getHours());
  const min = pad(date.getMinutes());

  // ── Short-form formats (time only) ──
  if (format === 'HH:mm') return `${hh}:${min}`;
  if (format === 'H:mm')  return `${date.getHours()}:${min}`;

  // ── Date-only formats ──
  if (format === 'MM/DD') return `${mm}/${dd}`;
  if (format === 'DD/MM') return `${dd}/${mm}`;

  // ── Default / medium (date + time) ──
  return `${mm}/${dd} ${hh}:${min}`;
};

export const formatYAxis = (value: number, unit = 'mg/dL'): string =>
  `${Math.round(value)} ${unit}`;

export const formatLegendText = (value: string): string => {
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
  if (['breakfast', 'lunch', 'dinner', 'snack'].some((t) => value.includes(t))) {
    const mealType = value.split(' (')[0];
    return mealType.charAt(0).toUpperCase() + mealType.slice(1);
  }
  return value;
};

// ============================================================
// GENERAL UTILITY FUNCTIONS
// ============================================================

export const isInRange = (value: number, target: number, tolerance = 0.1): boolean =>
  value >= target * (1 - tolerance) && value <= target * (1 + tolerance);

export const formatTimeDifference = (
  timestamp1: number | string,
  timestamp2: number | string
): string => {
  const diffMs = Math.abs(new Date(timestamp1).getTime() - new Date(timestamp2).getTime());
  const hours = Math.floor(diffMs / (1_000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1_000 * 60 * 60)) / (1_000 * 60));
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

export const truncateText = (text: string, maxLength = 30): string => {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
};

// ============================================================
// CUSTOM DOT DATA HELPER
// ============================================================

/**
 * Returns dot styling data for a blood-sugar reading point.
 * Use this inside your chart library's custom-dot callback.
 * (Replaces the SVG <circle> from the web version.)
 */
export const getBloodSugarDotStyle = (
  payload: ChartDataPoint,
  targetGlucose = 100
): { color: string; radius: number } | null => {
  if (!payload || payload.isInterpolated || payload.source === 'interpolated') {
    return null;
  }

  const value = payload.bloodSugar ?? payload.baseBG ?? targetGlucose;
  const color = getBloodSugarStatusColor(value, targetGlucose);
  return { color, radius: 2 };
};

// ============================================================
// CHART CONFIGURATION CONSTANTS
// ============================================================

export const CHART_MARGINS = {
  default: { top: 20, right: 80, left: 80, bottom: 20 },
  withLegend: { top: 20, right: 100, left: 80, bottom: 90 },
  compact: { top: 10, right: 20, left: 10, bottom: 10 },
};

export const STROKE_PATTERNS = {
  solid: '0',
  dashed: '5 5',
  dotted: '2 2',
  dashedLong: '10 5',
  dashedDot: '10 5 2 5',
};

export const ANIMATION_CONFIG = {
  animationDuration: 750,
  animationEasing: 'ease-in-out',
};

// ============================================================
// NOW VERTICAL LINE — shared Victory component
// ============================================================

/**
 * NowVerticalLine
 *
 * Renders a vertical dashed red line at the current time on any VictoryChart
 * that uses Unix-millisecond timestamps on its X axis.
 *
 * WHY dependentAxis is required
 * ──────────────────────────────
 * Victory interprets `axisValue` differently depending on axis type:
 *   • No dependentAxis (X-axis style):  axisValue = Y position → horizontal line.
 *   • dependentAxis   (Y-axis style):   axisValue = X position → vertical line.
 *
 * Without `dependentAxis` the line would be at Y ≈ 1.74 × 10¹² mg/dL — far
 * above every chart domain — and never rendered on screen.
 *
 * Usage inside any <VictoryChart …>:
 *
 *   import { NowVerticalLine } from '@/utils/ChartUtils';
 *   …
 *   {timeRange.now && <NowVerticalLine now={timeRange.now} />}
 *
 * Props
 * ─────
 * now          Unix-ms timestamp for "now" (from useChartTimeRange).
 * color        Line colour. Default: '#E53935' (Material Red 600).
 * strokeWidth  Line width.   Default: 1.5.
 * dashArray    SVG dash pattern. Default: '6 4'.
 */
export interface NowVerticalLineProps {
  now: number;
  color?: string;
  strokeWidth?: number;
  dashArray?: string;
}

export const NowVerticalLine: React.FC<NowVerticalLineProps> = ({
  now,
  color = '#E53935',
  strokeWidth = 1.5,
  dashArray = '6 4',
}) => (
  <VictoryAxis
    dependentAxis
    axisValue={now}
    tickFormat={() => ''}
    style={{
      axis:       { stroke: color, strokeWidth, strokeDasharray: dashArray },
      grid:       { stroke: 'none' },
      ticks:      { stroke: 'none', size: 0 },
      tickLabels: { fill: 'none', fontSize: 0 },
    }}
  />
);

// ============================================================
// STICKY TOOLTIP HOOK (touch-adapted)
// ============================================================

export interface StickyTooltipState {
  stickyTooltip: ChartDataPoint | null;
  tooltipPosition: { x: number; y: number };
  setStickyData: (data: ChartDataPoint | null, x?: number, y?: number) => void;
  clearTooltip: () => void;
}

/**
 * Touch-friendly sticky tooltip state manager.
 * Call setStickyData() from your chart's onPress / onDataPointClick handler.
 */
export const useStickyTooltip = (): StickyTooltipState => {
  const [stickyTooltip, setStickyTooltip] = useState<ChartDataPoint | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });

  const setStickyData = (
    data: ChartDataPoint | null,
    x = 0,
    y = 0
  ) => {
    setStickyTooltip(data);
    setTooltipPosition({ x, y });
  };

  const clearTooltip = () => setStickyTooltip(null);

  return { stickyTooltip, tooltipPosition, setStickyData, clearTooltip };
};

// ============================================================
// REACT NATIVE TOOLTIP COMPONENTS
// ============================================================

// ---------- TooltipContainer ----------

interface TooltipContainerProps {
  children: React.ReactNode;
  title?: string;
  isSticky?: boolean;
  onClose?: () => void;
  style?: ViewStyle;
}

export const TooltipContainer: React.FC<TooltipContainerProps> = ({
  children,
  title,
  isSticky = false,
  onClose,
  style,
}) => (
  <View style={[tooltipStyles.container, isSticky && tooltipStyles.sticky, style]}>
    {isSticky && onClose && (
      <View style={tooltipStyles.headerRow}>
        {title ? <Text style={tooltipStyles.titleText}>{title}</Text> : <View />}
        <Pressable onPress={onClose} hitSlop={8} style={tooltipStyles.closeBtn}>
          <Text style={tooltipStyles.closeBtnText}>✕</Text>
        </Pressable>
      </View>
    )}
    {children}
  </View>
);

// ---------- TooltipSection ----------

interface TooltipSectionProps {
  children: React.ReactNode;
  backgroundColor?: string;
  borderColor?: string;
  marginBottom?: number;
  padding?: number;
}

export const TooltipSection: React.FC<TooltipSectionProps> = ({
  children,
  backgroundColor = '#f9fafb',
  borderColor,
  marginBottom = 10,
  padding = 8,
}) => (
  <View
    style={[
      { backgroundColor, borderRadius: 6, marginBottom, padding },
      borderColor
        ? { borderWidth: 2, borderColor }
        : undefined,
    ]}
  >
    {children}
  </View>
);

// ---------- TooltipHeader ----------

interface TooltipHeaderProps {
  children: React.ReactNode;
  icon?: string;
  color?: string;
}

export const TooltipHeader: React.FC<TooltipHeaderProps> = ({
  children,
  icon,
  color = '#6b7280',
}) => (
  <Text style={[tooltipStyles.sectionHeader, { color }]}>
    {icon ? `${icon} ` : ''}{children}
  </Text>
);

// ---------- TooltipRow ----------

interface TooltipRowProps {
  label: string;
  value: string | number;
  valueColor?: string;
  fontSize?: number;
}

export const TooltipRow: React.FC<TooltipRowProps> = ({
  label,
  value,
  valueColor,
  fontSize = 12,
}) => (
  <View style={tooltipStyles.row}>
    <Text style={[tooltipStyles.rowLabel, { fontSize }]}>{label}: </Text>
    <Text
      style={[
        tooltipStyles.rowValue,
        { fontSize },
        valueColor ? { color: valueColor } : undefined,
      ]}
    >
      {value}
    </Text>
  </View>
);

// ---------- CustomMealTooltip ----------

interface CustomMealTooltipProps {
  data: ChartDataPoint;
  onClose?: () => void;
}

export const CustomMealTooltip: React.FC<CustomMealTooltipProps> = ({ data, onClose }) => {
  if (!data) return null;

  return (
    <TooltipContainer isSticky={!!onClose} onClose={onClose}>
      {/* Header: time */}
      <View style={tooltipStyles.headerRow}>
        <Text style={tooltipStyles.timeText}>
          {data.timeLabel ?? new Date(data.time ?? 0).toLocaleTimeString()}
        </Text>
        {data.isNow && <Text style={tooltipStyles.nowBadge}>NOW</Text>}
      </View>

      {/* Active Meals */}
      {Array.isArray(data.mealContributions) && data.mealContributions.length > 0 && (
        <TooltipSection backgroundColor="#fff8e1" borderColor="#FFB74D">
          <TooltipHeader icon="🍽️" color="#e65100">Active Meals</TooltipHeader>
          {data.mealContributions.map((meal: any, idx: number) => {
            const display = getMealTypeDisplay(meal.mealType, meal.absorptionType);
            const isLast = idx === data.mealContributions.length - 1;
            return (
              <View
                key={idx}
                style={[
                  tooltipStyles.mealRow,
                  !isLast && tooltipStyles.mealRowDivider,
                ]}
              >
                <View style={tooltipStyles.rowSpaceBetween}>
                  <Text style={[tooltipStyles.rowValue, { color: display.color }]}>
                    {display.displayName}
                  </Text>
                  <Text style={tooltipStyles.mutedSmall}>{meal.hoursSinceMeal}h ago</Text>
                </View>
                <Text style={tooltipStyles.mutedSmall}>
                  {display.absorptionType} • {meal.phase}
                </Text>
                <TooltipRow label="Absorbed" value={`${meal.absorbedCarbs}g`} />
                <TooltipRow label="MOB" value={`${meal.mob}g`} />
                <TooltipRow label="Activity" value={`${meal.activity}%`} />
                <TooltipRow label="BG Impact" value={`+${meal.bgElevation} mg/dL`} valueColor="#f44336" />
                <TooltipRow label="Pending" value={`+${meal.mobBGPotential} mg/dL`} valueColor="#4CAF50" />
              </View>
            );
          })}
        </TooltipSection>
      )}

      {/* Stacking warning */}
      {data.isStacking && (
        <View style={tooltipStyles.stackingWarning}>
          <Text style={tooltipStyles.stackingText}>
            ⚠️ {data.mealContributions?.length} meals overlapping
          </Text>
        </View>
      )}
    </TooltipContainer>
  );
};

// ---------- CustomInsulinTooltip ----------

interface CustomInsulinTooltipProps {
  data: ChartDataPoint;
  patientConstants?: PatientConstants;
  showIOB?: boolean;
  showActivity?: boolean;
  onClose?: () => void;
}

export const CustomInsulinTooltip: React.FC<CustomInsulinTooltipProps> = ({
  data,
  patientConstants,
  showIOB = true,
  showActivity = true,
  onClose,
}) => {
  if (!data) return null;

  const iobData = data.iobData ?? {};
  const hasIOBData =
    iobData.totalActiveInsulin > 0 || iobData.insulinContributions?.length > 0;

  return (
    <TooltipContainer isSticky={!!onClose} onClose={onClose}>
      {/* Time */}
      <Text style={tooltipStyles.timeText}>{data.formattedTime}</Text>

      {/* Doses */}
      {Object.keys(data.insulinDoses ?? {}).length > 0 && (
        <TooltipSection backgroundColor="#f9fafb">
          <TooltipHeader icon="💉" color="#6b7280">Insulin Doses</TooltipHeader>
          {Object.entries(data.insulinDoses ?? {}).map(([type, dose], idx) => {
            const info = getInsulinTypeDisplay(type, patientConstants);
            return (
              <View
                key={idx}
                style={[
                  tooltipStyles.doseBadge,
                  { borderLeftColor: info.color, borderLeftWidth: 3 },
                ]}
              >
                <Text style={[tooltipStyles.rowValue, { color: info.color }]}>
                  {info.displayName}
                </Text>
                <Text style={{ fontSize: 12 }}>
                  <Text style={{ fontWeight: '600' }}>{(dose as number).toFixed(1)} units</Text>
                  {' - '}{info.type}
                </Text>
                <Text style={tooltipStyles.mutedSmall}>
                  Onset: {info.onset} • Peak: {info.peak} • Duration: {info.duration}
                </Text>
              </View>
            );
          })}
        </TooltipSection>
      )}

      {/* Insulin activity */}
      {showActivity && (data.totalInsulinEffect > 0 || data.totalActivity > 0) && (
        <TooltipSection backgroundColor="#e8f5e9" borderColor="#82ca9d">
          <TooltipHeader color="#2e7d32">Insulin Activity</TooltipHeader>
          <TooltipRow
            label="Active Effect"
            value={`${(data.totalInsulinEffect ?? 0).toFixed(2)} units`}
            valueColor="#2e7d32"
          />
          <TooltipRow
            label="Activity Level"
            value={`${(data.totalActivity ?? 0).toFixed(1)}%`}
            valueColor="#2e7d32"
          />
          <TooltipRow
            label="BG Impact"
            value={`-${(data.bgImpactFromInsulin ?? 0).toFixed(1)} mg/dL`}
            valueColor="#dc2626"
          />
        </TooltipSection>
      )}

      {/* IOB */}
      {showIOB && hasIOBData && (
        <TooltipSection backgroundColor="#f3e5f5" borderColor="#9c27b0">
          <TooltipHeader color="#7b1fa2">IOB – Insulin On Board</TooltipHeader>
          <TooltipRow
            label="Total IOB"
            value={`${(iobData.totalActiveInsulin ?? data.totalIOB ?? 0).toFixed(2)} units`}
            valueColor="#7b1fa2"
          />
          <TooltipRow
            label="Potential BG Impact"
            value={`-${Math.abs(iobData.bgImpact ?? data.insulinImpactMgdL ?? 0).toFixed(1)} mg/dL`}
            valueColor="#dc2626"
          />
          {Array.isArray(iobData.insulinContributions) &&
            iobData.insulinContributions.length > 0 && (
              <View style={tooltipStyles.contribList}>
                <Text style={tooltipStyles.mutedSmall}>
                  Active doses ({iobData.insulinContributions.length}):
                </Text>
                {iobData.insulinContributions.slice(0, 3).map((c: any, idx: number) => (
                  <View key={idx} style={tooltipStyles.rowSpaceBetween}>
                    <Text style={tooltipStyles.mutedSmall}>{c.insulinType}:</Text>
                    <Text style={tooltipStyles.mutedSmall}>
                      {c.activeUnits.toFixed(2)}u ({c.hoursSinceDose}h ago)
                    </Text>
                  </View>
                ))}
                {iobData.insulinContributions.length > 3 && (
                  <Text style={[tooltipStyles.mutedSmall, { fontStyle: 'italic' }]}>
                    +{iobData.insulinContributions.length - 3} more…
                  </Text>
                )}
              </View>
            )}
        </TooltipSection>
      )}

      {/* Blood glucose */}
      {data.bloodSugar !== undefined && (
        <TooltipSection backgroundColor="#f9fafb">
          <TooltipHeader icon="🩸" color="#6b7280">Blood Glucose</TooltipHeader>
          <Text style={{ fontSize: 13, fontWeight: '600' }}>
            {Math.round(data.bloodSugar)} mg/dL
            {data.bloodSugarStatus ? (
              <Text style={tooltipStyles.mutedSmall}>
                {' '}({data.bloodSugarStatus.label ?? data.bloodSugarStatus})
              </Text>
            ) : null}
          </Text>
        </TooltipSection>
      )}
    </TooltipContainer>
  );
};

// ============================================================
// SHARED STYLESHEET FOR TOOLTIP COMPONENTS
// ============================================================

const tooltipStyles = StyleSheet.create({
  container: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    padding: 12,
    maxWidth: 350,
    // Shadow (iOS)
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    // Shadow (Android)
    elevation: 4,
  } as ViewStyle,
  sticky: {
    borderWidth: 2,
    borderColor: '#3b82f6',
  } as ViewStyle,
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  } as ViewStyle,
  titleText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1f2937',
  } as TextStyle,
  timeText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1f2937',
    paddingBottom: 8,
    marginBottom: 8,
    borderBottomWidth: 2,
    borderBottomColor: '#e5e7eb',
  } as TextStyle,
  nowBadge: {
    fontSize: 12,
    color: '#2196F3',
    fontWeight: '600',
  } as TextStyle,
  closeBtn: {
    padding: 4,
  } as ViewStyle,
  closeBtnText: {
    fontSize: 18,
    color: '#6b7280',
  } as TextStyle,
  sectionHeader: {
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 6,
    textTransform: 'uppercase',
  } as TextStyle,
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  } as ViewStyle,
  rowLabel: {
    color: '#6b7280',
  } as TextStyle,
  rowValue: {
    fontWeight: '600',
    color: '#1f2937',
  } as TextStyle,
  rowSpaceBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  } as ViewStyle,
  mutedSmall: {
    fontSize: 11,
    color: '#6b7280',
  } as TextStyle,
  mealRow: {
    paddingVertical: 8,
  } as ViewStyle,
  mealRowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  } as ViewStyle,
  stackingWarning: {
    marginTop: 8,
    padding: 8,
    backgroundColor: '#FFF3CD',
    borderRadius: 4,
  } as ViewStyle,
  stackingText: {
    fontSize: 12,
    color: '#856404',
  } as TextStyle,
  doseBadge: {
    padding: 6,
    marginBottom: 4,
    backgroundColor: '#f9fafb',
    borderRadius: 4,
  } as ViewStyle,
  contribList: {
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#ce93d8',
  } as ViewStyle,
});