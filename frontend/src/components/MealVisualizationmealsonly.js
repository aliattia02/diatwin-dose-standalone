/**
 * ============================================================================
 * MEAL EFFECT VISUALIZATION - COMPREHENSIVE MEAL TRACKING
 * ============================================================================
 *
 * VERSION: 1.1 - USER-CONFIGURABLE DAILY RESET HOUR
 *
 * NEW IN v1.1:
 * ✅ FEATURE: Support for user-configurable daily reset hour via patientConstants.daily_reset_hour
 * ✅ UPDATED: TimeManager calls now pass resetHour parameter (lines 208-209, 227)
 * ✅ BENEFIT: Absorbed carbs reset at patient's configured time (default 7 AM)
 *
 * VERSION: 1.0 - INITIAL RELEASE
 *
 * Modeled after InsulinVisualization v1.3 but for meal effects:
 * - Three-line system showing meal pharmacodynamics:
 *   1. Absorbed Carbs (cumulative, resets daily) - GREEN SOLID
 *   2. Active Carbs / Activity (instantaneous absorption rate) - ORANGE DASHED
 *   3. MOB (remaining carbs on board) - RED DOTTED
 * - Dual Y-axis: BG Impact (left) and Carbs (right)
 * - Enhanced tooltips with breakdown of all three effects
 * - Phase indicators (Starting, Rising, Peak, Active, Declining)
 * - Stacking risk visualization
 *
 * PHARMACODYNAMIC MODEL:
 * - Absorbed = Total carbs that have been absorbed (cumulative, resets at configured hour)
 * - Activity = Currently absorbing carbs (instantaneous, rate of change)
 * - MOB = Remaining carbs on board (future effect)
 *
 * Uses ChartUtils for shared functionality
 * ============================================================================
 */

import React, { useState, useEffect, useCallback, useMemo, useContext, useRef } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine
} from 'recharts';

import { useBloodSugarData } from '../contexts/BloodSugarDataContext';
import { useConstants } from '../contexts/ConstantsContext';
import TimeContext from '../contexts/TimeContext';
import TimeManager from '../utils/TimeManager';

import {
  calculateAbsorbedFraction,
  calculateMealActivity,
  calculateMOB,
  getAbsorptionProfile
} from '../utils/mealPharmacodynamics';

import { SHARED_CONSTANTS } from '../constants/shared_constants';
import { FaSync, FaExpand, FaCompress } from 'react-icons/fa';
import './Charts/global-visualization.css';

// ✅ Import shared chart utilities
import {
  useCurrentMinute,
  useChartTimeRange,
  processContextMealsForChart,
  generateXAxisTicks,
  createXAxisFormatter,
  calculateDynamicBarSize,
  findMealsAtTime,
  getMealTypeDisplay,
  TooltipSection,
  TooltipHeader,
  TooltipRow
} from '../utils/ChartUtils';

// =====================================
// CONSTANTS
// =====================================

const VIEW_CONFIGS = SHARED_CONSTANTS.VIEW_MODE_CONFIGS;
const DEBUG_MODE = false;

// ── Eating-delay offset ──────────────────────────────────────────────────────
// Eating is not instantaneous: a meal takes ~15 minutes to consume.
// We keep the bar at the logged meal timestamp (T=0) so the user sees when
// they sat down to eat, but we delay pharmacodynamics by this many minutes so
// that the MOB / Activity lines only start rising *after* the bar — matching
// what the body actually does.  Mirrors the Math.floor fix in InsulinVisualization
// that prevents IOB from leading its bar.
const EATING_DELAY_MINUTES = 15;
const EATING_DELAY_MS = EATING_DELAY_MINUTES * 60 * 1000;

// =====================================
// HELPER: Get meal phase description
// =====================================

function getMealPhase(hoursSinceMeal, profile) {
  if (!profile) return 'Unknown';

  const { onset_hours, peak_hours, duration_hours } = profile;

  if (hoursSinceMeal < (onset_hours || 0.25)) {
    return 'Starting';
  } else if (hoursSinceMeal < peak_hours) {
    return 'Rising to Peak';
  } else if (hoursSinceMeal < peak_hours * 1.3) {
    return 'At Peak';
  } else if (hoursSinceMeal < duration_hours * 0.7) {
    return 'Active';
  } else {
    return 'Declining';
  }
}

// =====================================
// MAIN COMPONENT
// =====================================

const MealVisualization = ({
  patientId = null,
  height = 600,
  showControls = true,
  embedded = false,
  onDataUpdate = null,
  defaultView = '12h'
}) => {
  // ===== CONTEXT & HOOKS =====
  const timeContext = useContext(TimeContext);
  const {
    recentMealsData,
    activeEffects,
    fetchLast24hData,
    handleViewModeChange
  } = useBloodSugarData();

  const { patientConstants } = useConstants();

  // ===== STATE =====
  const [viewMode, setViewMode] = useState(defaultView);
  const [chartData, setChartData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // showAbsorbed defaults to FALSE (like InsulinVisualization)
  const [showAbsorbed, setShowAbsorbed] = useState(false);
  const [showActivity, setShowActivity] = useState(true);
  const [showMOB, setShowMOB] = useState(true);
  const [showBGImpact, setShowBGImpact] = useState(true);
  const [showDoseMarkers, setShowDoseMarkers] = useState(true);

  const [stickyTooltip, setStickyTooltip] = useState(null);
  const [tooltipPosition, setTooltipPosition] = useState({ left: 0, top: 0 });

  const chartRef = useRef(null);
  const containerRef = useRef(null);

  // ===== SHARED HOOKS (from ChartUtils) =====
  const currentMinute = useCurrentMinute();
  const timeRange = useChartTimeRange(viewMode, currentMinute);

  // ===== DERIVED VALUES =====
  const viewConfig = VIEW_CONFIGS[viewMode];
  const carbToBGFactor = patientConstants?.carb_to_bg_factor || 4;

  // ✅ v1.1: Configurable reset hour with human-readable label
  const resetHour = patientConstants?.daily_reset_hour ?? 7;
  const resetLabel = resetHour === 0 ? '12 AM'
    : resetHour < 12  ? `${resetHour} AM`
    : resetHour === 12 ? '12 PM'
    : `${resetHour - 12} PM`;

  // ===== CONTEXT DATA =====
  const contextMeals = useMemo(() => {
    if (recentMealsData && recentMealsData.length > 0) {
      return recentMealsData;
    }

    if (activeEffects?.mob?.meal_contributions && activeEffects.mob.meal_contributions.length > 0) {
      return activeEffects.mob.meal_contributions.map(contrib => ({
        id: contrib.mealId,
        timestamp: contrib.timestamp || (Date.now() - (contrib.hoursSinceMeal * 3600 * 1000)),
        mealType: contrib.mealType,
        carbEquiv: contrib.carbEquiv,
        nutrition: {
          totalCarbEquiv: contrib.carbEquiv,
          absorptionType: contrib.absorptionType
        }
      }));
    }

    return [];
  }, [recentMealsData, activeEffects?.mob?.meal_contributions]);

  // ===== MEMOIZED PROCESSING (via ChartUtils) =====
  const processedMeals = useMemo(() => {
    return processContextMealsForChart(contextMeals, timeRange, patientConstants);
  }, [contextMeals, timeRange.start, timeRange.end, patientConstants?.protein_factor, patientConstants?.fat_factor]);

  // ===== GENERATE CHART DATA =====
  const generateChartData = useCallback(() => {
    if (!patientConstants) return [];

    if (DEBUG_MODE) {
      console.log('🚀 Generating meal chart data (v1.0):', {
        meals: processedMeals.length
      });
    }

    const { start, end, now } = timeRange;
    const intervalMs = viewConfig.interpolationInterval * 60 * 1000;

    const timePoints = [];
    for (let t = start; t <= end; t += intervalMs) {
      const normalizedTime = TimeManager.normalize(t, TimeManager.precision.MINUTE);
      if (timePoints.length === 0 || timePoints[timePoints.length - 1] !== normalizedTime) {
        timePoints.push(normalizedTime);
      }
    }

    // ✅ FIX (double-bar bug): inject the exact timestamp of every processed
    //    meal into the time-point array.  findMealsAtTime uses a ± halfInterval
    //    window, so a meal whose timestamp falls exactly halfway between two
    //    ticks can match *both* neighbours and produce two bars for one meal.
    //    With an injected data point at the precise meal ms, the later exact-
    //    match check below finds it at exactly one tick — no duplicates.
    const timePointSet = new Set(timePoints);
    processedMeals.forEach(meal => {
      const mealMs = typeof meal.timestamp === 'number'
        ? meal.timestamp
        : new Date(meal.timestamp).getTime();
      if (mealMs > start && mealMs < end) timePointSet.add(mealMs);
    });
    const sortedTimePoints = [...timePointSet].sort((a, b) => a - b);

    const halfInterval = intervalMs / 2;   // kept for isNow only

    const timeline = sortedTimePoints.map((time) => {
      const isHistorical = time <= now;
      const isFuture = time > now;
      const isNow = Math.abs(time - now) < halfInterval;

      // ✅ v4.0: Use configurable reset hour from patientConstants
      // FIX: use ?? (nullish) not || (falsy) so resetHour=0 (midnight) works correctly
      const resetHour = patientConstants?.daily_reset_hour ?? 7;
      // FIX: pass patient's stored timezone offset so reset boundary matches their
      // local clock even when the browser timezone differs (e.g. travelling patient)
      const tzOffset = patientConstants?.timezone_offset_minutes ?? null;
      const isAtReset = TimeManager.isAtResetTime(time, resetHour, tzOffset);
      const dailyResetTime = TimeManager.getDailyResetTime(time, resetHour, tzOffset);

      let totalAbsorbedCarbs = 0;
      let totalActivityCarbs = 0;
      let totalMOB = 0;
      let totalAbsorbedBGElevation = 0;
      let totalActivityBGElevation = 0;
      let totalPendingBGRise = 0;

      const mealContributions = [];
      // ✅ FIX: exact match only — safe because we injected each meal's precise
      //    timestamp into sortedTimePoints, so there is always a data point at
      //    exactly mealMs.  The old findMealsAtTime(…, halfInterval) call could
      //    return the same meal for two adjacent ticks when the meal timestamp
      //    fell near a tick boundary, producing duplicate bars.
      const dosesAtTime = processedMeals.filter(meal => {
        const mealMs = typeof meal.timestamp === 'number'
          ? meal.timestamp
          : new Date(meal.timestamp).getTime();
        return mealMs === time;
      });

      if (!isAtReset) {
        processedMeals.forEach(meal => {
          const mealMs = typeof meal.timestamp === 'number'
            ? meal.timestamp
            : new Date(meal.timestamp).getTime();

          // ── Eating-delay fix ───────────────────────────────────────────────
          // The bar is anchored at mealMs (when the user logged the meal).
          // Pharmacodynamics (MOB, Activity) are offset forward by EATING_DELAY_MS
          // so that the lines never start rising before the bar — eating takes
          // time, just as digestion takes time.
          // This is the meal analogue of the Math.floor fix in InsulinVisualization.
          const mealTime = mealMs + EATING_DELAY_MS;
          // ──────────────────────────────────────────────────────────────────

          // ✅ v4.0: Use configurable reset hour; pass tzOffset for patient-local boundary
          const isWithinCurrentDay = TimeManager.isWithinCurrentDay(mealTime, time, resetHour, tzOffset);

          const hoursSinceMeal = TimeManager.calculateHoursSince(
            time,
            mealTime,
            TimeManager.precision.SECOND
          );

          const absorptionType = meal.nutrition?.absorptionType ||
                                 meal.nutrition?.absorption_type ||
                                 meal.absorptionType || 'medium';
          const profile = getAbsorptionProfile(absorptionType);

          if (!profile || hoursSinceMeal < 0) return;

          const totalCarbs = meal.nutrition?.totalCarbEquiv ||
                             meal.nutrition?.total_carb_equiv ||
                             meal.carbEquiv || 0;

          if (totalCarbs <= 0) return;

          // Calculate the three meal effect values
          const isActive = hoursSinceMeal <= profile.duration_hours;
          let absorbedFraction = 0;
          let activityValue = 0;
          let mobValue = 0;

          if (isActive) {
            absorbedFraction = calculateAbsorbedFraction(hoursSinceMeal, profile);
            const activityPercentage = calculateMealActivity(hoursSinceMeal, profile);
            activityValue = (activityPercentage / 100) * totalCarbs;
            mobValue = calculateMOB(hoursSinceMeal, totalCarbs, profile);
          } else {
            // Fully absorbed
            absorbedFraction = 1.0;
            activityValue = 0;
            mobValue = 0;
          }

          const absorbedCarbs = totalCarbs * absorbedFraction;

          // Activity and MOB only exist during active phase
          if (isActive) {
            totalActivityCarbs += activityValue;
            totalMOB += mobValue;
            totalActivityBGElevation += activityValue * carbToBGFactor;
            totalPendingBGRise += mobValue * carbToBGFactor;
          }

          // Meal contributions for tooltip breakdown: include ALL meals that
          // have any effect at this time point (active OR fully-absorbed within
          // current day).  Showing only active meals hides why the cumulative
          // absorbed total is elevated — clinicians need the full picture.
          const contributesToAbsorbed = isWithinCurrentDay && (
            (isActive && hoursSinceMeal > 0) ||
            (!isActive && hoursSinceMeal > 0)
          );

          if (isActive || contributesToAbsorbed) {
            mealContributions.push({
              mealType: meal.mealType || 'meal',
              absorptionType,
              totalCarbs,
              hoursSinceMeal,
              absorbed: absorbedCarbs,
              activity: activityValue,
              mob: mobValue,
              // FIX: "Cumulative BG Elevation" not "Current" — absorbed is a
              // running total, not an instantaneous value; "Current" misleads
              // clinicians into treating it as a moment-in-time BG reading
              bgElevation: absorbedCarbs * carbToBGFactor,
              pendingRise: mobValue * carbToBGFactor,
              phase: isActive ? getMealPhase(hoursSinceMeal, profile) : 'Fully Absorbed',
              profile,
              isWithinCurrentDay,
              isFullyAbsorbed: !isActive
            });
          }

          // Cumulative absorbed: only within current day
          if (isWithinCurrentDay) {
            if (!isActive && hoursSinceMeal > 0) {
              // After duration - fully absorbed
              totalAbsorbedCarbs += totalCarbs;
              totalAbsorbedBGElevation += totalCarbs * carbToBGFactor;
            } else if (isActive) {
              totalAbsorbedCarbs += absorbedCarbs;
              totalAbsorbedBGElevation += absorbedCarbs * carbToBGFactor;
            }
          }
        });
      }

      // Dose markers
      const totalCarbsAtTime = dosesAtTime.reduce((sum, m) => {
        const carbs = m.nutrition?.totalCarbEquiv ||
                      m.nutrition?.total_carb_equiv ||
                      m.carbEquiv || 0;
        return sum + carbs;
      }, 0);
      const mealDoseMarker = totalCarbsAtTime > 0 ? totalCarbsAtTime : null;

      return {
        timestamp: time,
        formattedTime: TimeManager.formatDate(
          new Date(time),
          viewConfig.tickFormat === 'HH:mm' ? 'HH:mm' : 'DD/MM HH:mm'
        ),
        timestampPrecision: 'MINUTE',

        // Three meal effect lines
        absorbedCarbs: totalAbsorbedCarbs,
        activityCarbs: totalActivityCarbs,
        mob: totalMOB,

        // BG Impact values (for left Y-axis)
        absorbedBGElevation: totalAbsorbedBGElevation,
        activityBGElevation: totalActivityBGElevation,
        pendingBGRise: totalPendingBGRise,

        // Dose markers
        mealDoseMarker,

        // Additional info for tooltip
        mealsAdministered: dosesAtTime,
        mealContributions,

        // Metadata
        isHistorical,
        isFuture,
        isNow,
        isAtReset,
        dailyResetTime
      };
    });

    if (DEBUG_MODE) {
      console.log(`✅ Generated ${timeline.length} chart points with meal tracking`);
    }

    return timeline;
  }, [
    patientConstants,
    processedMeals,
    timeRange,
    viewConfig,
    carbToBGFactor
  ]);

  // ===== EFFECTS =====
  useEffect(() => {
    if (patientConstants && processedMeals.length > 0) {
      const timeoutId = setTimeout(() => {
        try {
          const data = generateChartData();
          setChartData(data);
          setLoading(false);

          if (onDataUpdate) {
            onDataUpdate(data);
          }
        } catch (err) {
          console.error('Error generating chart data:', err);
          setError('Failed to generate chart data');
          setLoading(false);
        }
      }, 200);

      return () => clearTimeout(timeoutId);
    } else if (patientConstants && processedMeals.length === 0) {
      setChartData([]);
      setLoading(false);
    }
  }, [generateChartData, patientConstants, onDataUpdate, processedMeals.length]);

  // ===== HANDLERS =====
  const handleRefresh = useCallback(() => {
    setLoading(true);
    if (fetchLast24hData) {
      fetchLast24hData();
    }
    setTimeout(() => setLoading(false), 1000);
  }, [fetchLast24hData]);

  const handleChartClick = (data) => {
    if (data && data.activePayload && data.activePayload.length) {
      setStickyTooltip(data.activePayload[0].payload);
      setTooltipPosition({
        left: data.chartX,
        top: data.chartY - 10
      });
    }
  };

  const handleCloseTooltip = () => {
    setStickyTooltip(null);
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  const handleViewChange = useCallback((newMode) => {
    if (newMode === viewMode) return;
    setViewMode(newMode);
    if (handleViewModeChange) {
      handleViewModeChange(newMode);
    }
  }, [viewMode, handleViewModeChange]);

  // ===== FORMATTERS & HELPERS =====
  const formatXAxisLabel = useMemo(() => createXAxisFormatter(viewConfig), [viewConfig]);
  const ticks = useMemo(() => generateXAxisTicks(timeRange, viewConfig), [timeRange, viewConfig]);

  const dynamicBarSize = useMemo(() => {
    return calculateDynamicBarSize(
      chartRef.current?.offsetWidth,
      chartData.length
    );
  }, [chartData.length]);

  // ===== SYNCHRONIZED Y-AXIS DOMAINS =====
  // BG Impact (mg/dL) = Carbs (g) × carbToBGFactor
  const { carbsAxisDomain, bgImpactAxisDomain } = useMemo(() => {
    if (!chartData || chartData.length === 0) {
      return {
        carbsAxisDomain: [0, 50],
        bgImpactAxisDomain: [0, 50 * carbToBGFactor]
      };
    }

    const maxAbsorbed = Math.max(...chartData.map(d => d.absorbedCarbs || 0), 0);
    const maxActivity = Math.max(...chartData.map(d => d.activityCarbs || 0), 0);
    const maxMOB = Math.max(...chartData.map(d => d.mob || 0), 0);
    const maxDose = Math.max(...chartData.map(d => d.mealDoseMarker || 0), 0);

    const maxAbsorbedBG = Math.max(...chartData.map(d => d.absorbedBGElevation || 0), 0);
    const maxActivityBG = Math.max(...chartData.map(d => d.activityBGElevation || 0), 0);
    const maxPendingBG = Math.max(...chartData.map(d => d.pendingBGRise || 0), 0);

    const maxCarbs = Math.max(maxAbsorbed, maxActivity, maxMOB, maxDose);
    const maxBGImpact = Math.max(maxAbsorbedBG, maxActivityBG, maxPendingBG);

    // Calculate required carbs to accommodate BG impact
    const carbsNeededForBG = maxBGImpact / carbToBGFactor;

    const maxCarbsRequired = Math.max(maxCarbs, carbsNeededForBG);
    const carbsLimit = Math.ceil(maxCarbsRequired) + 10; // 10g padding

    // Cap at 200g, minimum 50g
    const finalCarbsMax = Math.min(Math.max(carbsLimit, 50), 200);
    const finalBGImpactMax = finalCarbsMax * carbToBGFactor;

    return {
      carbsAxisDomain: [0, finalCarbsMax],
      bgImpactAxisDomain: [0, finalBGImpactMax]
    };
  }, [chartData, carbToBGFactor]);

  // ===== CUSTOM TOOLTIP =====
  const CustomTooltipContent = ({ active, payload }) => {
    const data = stickyTooltip || (active && payload && payload.length ? payload[0].payload : null);

    if (!data) return null;

    const hasDose = data.mealsAdministered && data.mealsAdministered.length > 0;

    return (
      <div className="bg-visualization-tooltip">
        {stickyTooltip && (
          <button onClick={handleCloseTooltip} aria-label="Close tooltip">✕</button>
        )}

        {/* Time and Now indicator */}
        <div style={{ fontWeight: '600', marginBottom: '8px', fontSize: '13px' }}>
          {data.formattedTime}
          {data.isNow && <span style={{ marginLeft: '8px', color: '#ff0000', fontSize: '12px' }}>🔴 Now</span>}
          {data.isAtReset && (
            <span style={{ marginLeft: '8px', color: '#4CAF50', fontSize: '12px' }}>
              🔄 {resetLabel} Reset
            </span>
          )}
        </div>

        {/* Reset notification */}
        {data.isAtReset && (
          <TooltipSection backgroundColor="#e8f5e9" borderColor="#4CAF50" marginBottom="8px">
            <TooltipHeader icon="🔄" color="#2e7d32">
              Daily Reset Point:
            </TooltipHeader>
            <div style={{ fontSize: '11px', color: '#2e7d32', marginTop: '4px' }}>
              ✅ Cumulative absorbed carbs reset to 0
              <br />
              📊 Active carbs and MOB continue normally
            </div>
          </TooltipSection>
        )}

        {/* MEALS ADMINISTERED AT THIS TIME */}
        {hasDose && (
          <TooltipSection backgroundColor="#fff3e0" borderColor="#ff9800" marginBottom="8px">
            <TooltipHeader icon="🍽️" color="#e65100">
              Meals at This Time ({data.mealsAdministered.length}):
            </TooltipHeader>
            {data.mealsAdministered.map((meal, idx) => {
              const absorptionType = meal.nutrition?.absorptionType ||
                                     meal.nutrition?.absorption_type ||
                                     meal.absorptionType || 'medium';
              const mealDisplay = getMealTypeDisplay(meal.mealType, absorptionType);
              const carbs = meal.nutrition?.totalCarbEquiv ||
                            meal.nutrition?.total_carb_equiv ||
                            meal.carbEquiv || 0;
              return (
                <div key={idx} style={{
                  padding: '6px',
                  marginBottom: '4px',
                  backgroundColor: '#f9fafb',
                  borderRadius: '4px',
                  borderLeft: `3px solid ${mealDisplay.color}`
                }}>
                  <div style={{ fontWeight: '600', color: mealDisplay.color, fontSize: '11px' }}>
                    {mealDisplay.displayName}
                  </div>
                  <div style={{ fontSize: '12px', marginTop: '2px' }}>
                    <strong>{carbs.toFixed(1)}g</strong> carb equiv - {mealDisplay.absorptionType}
                  </div>
                </div>
              );
            })}
          </TooltipSection>
        )}

        {/* THREE MEAL EFFECTS */}
        <TooltipSection backgroundColor="#fff9e6" borderColor="#ff9800" marginBottom="8px">
          <TooltipHeader icon="🍽️" color="#e65100">
            Three Meal Effects:
          </TooltipHeader>

          {/* 1. Absorbed Carbs (GREEN) */}
          <div style={{ marginTop: '6px' }}>
            <div style={{ fontWeight: '600', color: '#4CAF50', fontSize: '11px', marginBottom: '4px' }}>
              1️⃣ Absorbed Carbs (GREEN SOLID):
            </div>
            <TooltipRow
              label="Amount"
              value={`${data.absorbedCarbs.toFixed(1)}g`}
              valueColor="#4CAF50"
            />
            <TooltipRow
              label="BG Elevation"
              value={`+${data.absorbedBGElevation.toFixed(1)} mg/dL`}
              valueColor="#4CAF50"
            />
            <div style={{ fontSize: '10px', color: '#666', marginTop: '2px', fontStyle: 'italic' }}>
              ✅ Cumulative effect (resets daily at {resetLabel})
            </div>
          </div>

          {/* 2. Activity (ORANGE) */}
          <div style={{ marginTop: '8px', paddingTop: '6px', borderTop: '1px solid #e0e0e0' }}>
            <div style={{ fontWeight: '600', color: '#FF6D00', fontSize: '11px', marginBottom: '4px' }}>
              2️⃣ Active Absorption (ORANGE DASHED):
            </div>
            <TooltipRow
              label="Amount"
              value={`${data.activityCarbs.toFixed(1)}g`}
              valueColor="#FF6D00"
            />
            <TooltipRow
              label="BG Elevation"
              value={`+${data.activityBGElevation.toFixed(1)} mg/dL`}
              valueColor="#FF6D00"
            />
            <div style={{ fontSize: '10px', color: '#666', marginTop: '2px', fontStyle: 'italic' }}>
              ⚡ Currently absorbing (instantaneous rate)
            </div>
          </div>

          {/* 3. MOB (RED) */}
          <div style={{ marginTop: '8px', paddingTop: '6px', borderTop: '1px solid #e0e0e0' }}>
            <div style={{ fontWeight: '600', color: '#C62828', fontSize: '11px', marginBottom: '4px' }}>
              3️⃣ Meal On Board (RED DOTTED):
            </div>
            <TooltipRow
              label="Amount"
              value={`${data.mob.toFixed(1)}g`}
              valueColor="#C62828"
            />
            <TooltipRow
              label="Pending BG Rise"
              value={`+${data.pendingBGRise.toFixed(1)} mg/dL`}
              valueColor="#C62828"
            />
            <div style={{ fontSize: '10px', color: '#666', marginTop: '2px', fontStyle: 'italic' }}>
              ⏳ Remaining to absorb (future effect)
            </div>
          </div>
        </TooltipSection>

        {/* INDIVIDUAL MEAL CONTRIBUTIONS */}
        {data.mealContributions && data.mealContributions.length > 0 && (
          <TooltipSection backgroundColor="#f0f9ff" borderColor="#2196F3" marginBottom="8px">
            <TooltipHeader icon="📊" color="#1565c0">
              Meals Contributing to Absorbed Total ({data.mealContributions.length}):
            </TooltipHeader>
            {data.mealContributions.slice(0, 3).map((contrib, idx) => {
              const mealDisplay = getMealTypeDisplay(contrib.mealType, contrib.absorptionType);
              return (
                <div key={idx} style={{
                  padding: '6px',
                  marginTop: '6px',
                  backgroundColor: '#fffef7',
                  borderRadius: '4px',
                  borderLeft: `3px solid ${mealDisplay.color}`,
                  fontSize: '10px'
                }}>
                  <div style={{ fontWeight: '600', color: mealDisplay.color, marginBottom: '3px' }}>
                    {mealDisplay.displayName} ({contrib.totalCarbs.toFixed(1)}g)
                    {contrib.isFullyAbsorbed && (
                      <span style={{ color: '#4CAF50', fontSize: '9px', marginLeft: '4px' }}>
                        ✅ Fully absorbed
                      </span>
                    )}
                    {!contrib.isWithinCurrentDay && (
                      <span style={{ color: '#999', fontSize: '9px', marginLeft: '4px' }}>
                        (before {resetLabel} reset)
                      </span>
                    )}
                  </div>
                  <div style={{ color: '#666' }}>
                    ⏱️ {contrib.hoursSinceMeal.toFixed(1)}h ago • {contrib.phase}
                  </div>
                  <div style={{ color: '#666', marginTop: '2px' }}>
                    Absorbed: {contrib.absorbed.toFixed(1)}g | Activity: {contrib.activity.toFixed(1)}g | MOB: {contrib.mob.toFixed(1)}g
                  </div>
                  <div style={{ marginTop: '3px', fontWeight: '600' }}>
                    Cumul. BG: +{contrib.bgElevation.toFixed(1)} mg/dL | Pending: +{contrib.pendingRise.toFixed(1)} mg/dL
                  </div>
                </div>
              );
            })}
            {data.mealContributions.length > 3 && (
              <div style={{ fontSize: '10px', color: '#666', marginTop: '4px', fontStyle: 'italic' }}>
                +{data.mealContributions.length - 3} more meals...
              </div>
            )}
          </TooltipSection>
        )}

        {/* Historical/Projected indicator */}
        <div style={{
          marginTop: '8px',
          fontSize: '11px',
          color: '#666',
          textAlign: 'center'
        }}>
          {data.isHistorical ? '📊 Historical' : '🔮 Projected'}
        </div>
      </div>
    );
  };

  // ===== RENDER =====
  if (loading && chartData.length === 0) {
    return (
      <div className="bg-visualization-loading" style={{ height }}>
        <FaSync className="spin" />
        Loading meal data...
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-visualization-error" style={{ height }}>
        {error}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`bg-visualization-container ${embedded ? 'embedded' : ''} ${isFullscreen ? 'fullscreen' : ''}`}
    >
      {/* Header */}
      {showControls && (
        <div className="bg-visualization-header">
          <div>
            <h3>Meal Effect Visualization</h3>
            <p style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
              🍽️ v1.1 Synchronized Axes • Light Orange = Absorbed (resets at {resetLabel}) • Deep Orange = Activity • Dark Red = MOB
            </p>
          </div>

          <div>
            <div className="view-mode-toggle">
              {Object.entries(VIEW_CONFIGS).map(([key, config]) => (
                <button
                  key={key}
                  onClick={() => handleViewChange(key)}
                  className={viewMode === key ? 'active' : ''}
                  disabled={loading}
                >
                  {config.label}
                </button>
              ))}
            </div>

            <button
              onClick={handleRefresh}
              disabled={loading}
              className="bg-action-button"
              title="Refresh data"
            >
              <FaSync className={loading ? 'spin' : ''} />
            </button>

            <button
              onClick={toggleFullscreen}
              className="bg-action-button"
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? <FaCompress /> : <FaExpand />}
            </button>
          </div>
        </div>
      )}

      {/* Toggle Controls */}
      {showControls && (
        <div className="toggle-controls" style={{ marginTop: '8px', marginBottom: '8px' }}>
          <label style={{ fontWeight: '600', color: '#FFB74D' }}>
            <input
              type="checkbox"
              checked={showAbsorbed}
              onChange={() => setShowAbsorbed(!showAbsorbed)}
            />
            Absorbed Carbs (resets at {resetLabel}) ⭐
          </label>
          <label>
            <input
              type="checkbox"
              checked={showActivity}
              onChange={() => setShowActivity(!showActivity)}
            />
            Absorption Activity (Current)
          </label>
          <label>
            <input
              type="checkbox"
              checked={showMOB}
              onChange={() => setShowMOB(!showMOB)}
            />
            MOB (Remaining)
          </label>
          <label>
            <input
              type="checkbox"
              checked={showBGImpact}
              onChange={() => setShowBGImpact(!showBGImpact)}
            />
            BG Impact (Left Axis)
          </label>
          <label>
            <input
              type="checkbox"
              checked={showDoseMarkers}
              onChange={() => setShowDoseMarkers(!showDoseMarkers)}
            />
            Meal Markers
          </label>
        </div>
      )}

      {/* No data message */}
      {chartData.length === 0 && !loading ? (
        <div style={{
          padding: '60px 20px',
          textAlign: 'center',
          color: '#666',
          background: '#f9f9f9',
          borderRadius: '8px',
          margin: '20px 0'
        }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>🍽️</div>
          <h3 style={{ margin: '0 0 8px 0', color: '#333' }}>No Meal Data Available</h3>
          <p style={{ margin: '0', fontSize: '14px' }}>
            No recent meals found for this time period. Log a meal to see the visualization.
          </p>
        </div>
      ) : (
        /* Chart */
        <div ref={chartRef} className="chart-container">
          <ResponsiveContainer width="100%" height={height}>
            <ComposedChart
              data={chartData}
              margin={{ top: 20, right: 30, left: 20, bottom: 60 }}
              onClick={handleChartClick}
            >
              <defs>
                <linearGradient id="mealAbsorbedGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#FFB74D" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#FFB74D" stopOpacity={0.1} />
                </linearGradient>

                <linearGradient id="mealActivityGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#FF6D00" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#FF6D00" stopOpacity={0.1} />
                </linearGradient>

                <linearGradient id="mealMobGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#C62828" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#C62828" stopOpacity={0.1} />
                </linearGradient>
              </defs>

              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />

              <XAxis
                dataKey="timestamp"
                type="number"
                scale="time"
                domain={[timeRange.start, timeRange.end]}
                ticks={ticks}
                tickFormatter={formatXAxisLabel}
                angle={-45}
                textAnchor="end"
                height={70}
                stroke="#666"
                fontSize={11}
              />

              {/* Left Y-axis: BG Impact */}
              {showBGImpact && (
                <YAxis
                  yAxisId="bgimpact"
                  domain={bgImpactAxisDomain}
                  tickFormatter={(value) => `${Math.round(value)}`}
                  label={{
                    value: 'BG Impact (mg/dL)',
                    angle: -90,
                    position: 'insideLeft',
                    style: { fontSize: '12px', fill: '#666' }
                  }}
                  stroke="#666"
                  fontSize={11}
                />
              )}

              {/* Right Y-axis: Carbs */}
              <YAxis
                yAxisId="carbs"
                orientation="right"
                domain={carbsAxisDomain}
                tickFormatter={(value) => `${value.toFixed(0)}g`}
                label={{
                  value: 'Carbs (g)',
                  angle: 90,
                  position: 'insideRight',
                  style: { fontSize: '12px', fill: '#666' }
                }}
                stroke="#666"
                fontSize={11}
              />

              <Tooltip content={<CustomTooltipContent />} />

              <Legend
                verticalAlign="top"
                height={36}
                wrapperStyle={{ paddingBottom: '10px' }}
                formatter={(value) => {
                  const labels = {
                    'absorbedCarbs': `💊 Absorbed Carbs (resets at ${resetLabel}) ⭐`,
                    'activityCarbs': '⚡ Absorption Activity (current)',
                    'mob': '⏳ MOB (remaining to absorb)',
                    'absorbedBGElevation': '📈 Absorbed BG Impact',
                    'activityBGElevation': '📈 Activity BG Impact',
                    'pendingBGRise': '📈 Pending BG Rise',
                    'mealDoseMarker': '🍽️ Meals'
                  };
                  return labels[value] || value;
                }}
              />

              <ReferenceLine
                yAxisId="carbs"
                x={timeRange.now}
                stroke="#ff0000"
                strokeWidth={2}
                label={{
                  value: 'Now',
                  position: 'top',
                  fill: '#ff0000',
                  fontSize: 11
                }}
              />

              {showDoseMarkers && (
                <Bar
                  yAxisId="carbs"
                  dataKey="mealDoseMarker"
                  fill="#ff9800"
                  fillOpacity={0.8}
                  barSize={dynamicBarSize}
                  isAnimationActive={false}
                  name="mealDoseMarker"
                />
              )}

              {showAbsorbed && (
                <Area
                  yAxisId="carbs"
                  type="monotone"
                  dataKey="absorbedCarbs"
                  name="absorbedCarbs"
                  stroke="#FFB74D"
                  strokeWidth={3}
                  fill="url(#mealAbsorbedGradient)"
                  isAnimationActive={false}
                  style={{
                    filter: 'drop-shadow(0 0 2px rgba(255, 183, 77, 0.4))'
                  }}
                />
              )}

              {showActivity && (
                <Line
                  yAxisId="carbs"
                  type="monotone"
                  dataKey="activityCarbs"
                  name="activityCarbs"
                  stroke="#FF6D00"
                  strokeWidth={2.5}
                  strokeDasharray="5 5"
                  dot={false}
                  isAnimationActive={false}
                />
              )}

              {showMOB && (
                <Line
                  yAxisId="carbs"
                  type="monotone"
                  dataKey="mob"
                  name="mob"
                  stroke="#C62828"
                  strokeWidth={2}
                  strokeDasharray="3 3"
                  dot={false}
                  isAnimationActive={false}
                />
              )}

              {showBGImpact && (
                <>
                  {showAbsorbed && (
                    <Line
                      yAxisId="bgimpact"
                      type="monotone"
                      dataKey="absorbedBGElevation"
                      name="absorbedBGElevation"
                      stroke="#FFB74D"
                      strokeWidth={1.5}
                      strokeOpacity={0.6}
                      dot={false}
                      isAnimationActive={false}
                    />
                  )}
                  {showActivity && (
                    <Line
                      yAxisId="bgimpact"
                      type="monotone"
                      dataKey="activityBGElevation"
                      name="activityBGElevation"
                      stroke="#FF6D00"
                      strokeWidth={1.5}
                      strokeOpacity={0.6}
                      dot={false}
                      isAnimationActive={false}
                    />
                  )}
                  {showMOB && (
                    <Line
                      yAxisId="bgimpact"
                      type="monotone"
                      dataKey="pendingBGRise"
                      name="pendingBGRise"
                      stroke="#C62828"
                      strokeWidth={1.5}
                      strokeOpacity={0.6}
                      dot={false}
                      isAnimationActive={false}
                    />
                  )}
                </>
              )}
            </ComposedChart>
          </ResponsiveContainer>

          {/* Sticky Tooltip */}
          {stickyTooltip && (
            <div
              className="sticky-tooltip-container"
              style={{
                position: 'absolute',
                left: `${tooltipPosition.left}px`,
                top: `${tooltipPosition.top}px`,
                transform: 'translate(-50%, -100%)',
                zIndex: 1000
              }}
            >
              <CustomTooltipContent active={true} payload={[{ payload: stickyTooltip }]} />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default React.memo(MealVisualization, (prevProps, nextProps) => {
  return (
    prevProps.patientId === nextProps.patientId &&
    prevProps.embedded === nextProps.embedded &&
    prevProps.height === nextProps.height
  );
});