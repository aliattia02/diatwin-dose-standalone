/**
 * BloodGlucoseVisualization.js - UPDATED WITH CUMULATIVE NET EFFECT
 *
 * VERSION: 3.0 - CHARTUTILS REFACTOR + MEAL BUG FIX
 *
 * 🆕 NEW IN v3.0:
 * ✅ FIXED: Meals now load correctly (removed stale debounce guard)
 * ✅ FIXED: Removed circular chartData dependency from generateChartData
 * ✅ FIXED: Added MOB/IOB lookback window filtering (like EffectsVisualization)
 * ✅ Refactored shared logic into ChartUtils.js
 * ✅ Uses useCurrentMinute(), useChartTimeRange() hooks
 * ✅ Uses processContextMealsForChart(), processContextInsulinForChart()
 * ✅ Uses calculateCumulativeAxisDomain(), calculateCumulativeAxisTicks()
 * ✅ Uses generateXAxisTicks(), createXAxisFormatter(), getConfidenceLevel()
 * ✅ Removed ~150 lines of duplicated utility logic
 *
 * MAINTAINED FROM v2.0:
 * ✅ Uses CUMULATIVE NET EFFECT for blood glucose projection
 * ✅ Shows both instantaneous and cumulative effects
 * ✅ Properly displays baseline + cumulative net effect = projected BG
 * ✅ Updated tooltip to show cumulative values alongside instantaneous
 */

import React, { useState, useEffect, useCallback, useMemo, useContext, useRef } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
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
  generateChartTimeline,
  getEffectColor,
  getEffectLevel
} from '../utils/netEffectCalculationService';

import { SHARED_CONSTANTS } from '../constants/shared_constants';
import { FaSync, FaExpand, FaCompress } from 'react-icons/fa';
import './Charts/global-visualization.css';

// ✅ Import shared chart utilities
import {
  getBloodSugarStatusColor,
  useCurrentMinute,
  useChartTimeRange,
  processContextMealsForChart,
  processContextInsulinForChart,
  generateXAxisTicks,
  createXAxisFormatter,
  calculateCumulativeAxisDomain,
  calculateCumulativeAxisTicks,
  getConfidenceLevel,
  findMealsAtTime,
  findInsulinAtTime,
  // ✅ FIX: Import the extended VIEW_CONFIGS (includes '6h' and '3d')
  // instead of using SHARED_CONSTANTS.VIEW_MODE_CONFIGS directly which
  // only has 12h / 24h / week / month and would leave viewConfig undefined.
  VIEW_CONFIGS as CHART_VIEW_CONFIGS
} from '../utils/ChartUtils';

// =====================================
// CONSTANTS
// =====================================

// ✅ FIX: Use the extended VIEW_CONFIGS from ChartUtils (includes '6h' and '3d').
// SHARED_CONSTANTS.VIEW_MODE_CONFIGS only has 12h/24h/week/month; using it
// directly here would crash when the '3d' or '6h' buttons are pressed.
const VIEW_CONFIGS = CHART_VIEW_CONFIGS;
const DEBUG_MODE = false;

// =====================================
// MAIN COMPONENT
// =====================================

const BloodGlucoseVisualization = ({
  patientId = null,
  height = 500,
  showControls = true,
  embedded = false,
  onDataUpdate = null,
  defaultView = '12h'
}) => {
  // ===== CONTEXT & HOOKS =====
  const timeContext = useContext(TimeContext);
  const {
    combinedData: bloodSugarData,
    targetGlucose,
    adjustedBaselineForProjection,
    fetchLast24hData,
    activeEffects,
    recentMealsData,
    recentInsulinData,
    last24hData,
    handleViewModeChange: contextHandleViewModeChange
  } = useBloodSugarData();

  const { patientConstants } = useConstants();

  // ===== STATE =====
  const [viewMode, setViewMode] = useState(defaultView);
  const [chartData, setChartData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isChangingView, setIsChangingView] = useState(false);

  const [showBaseline, setShowBaseline] = useState(true);
  const [showActualReadings, setShowActualReadings] = useState(true);
  const [showEstimatedLine, setShowEstimatedLine] = useState(true);
  const [showTargetRange, setShowTargetRange] = useState(true);
  const [showNetEffect, setShowNetEffect] = useState(false);
  const [showCumulativeEffect, setShowCumulativeEffect] = useState(true);

  const [stickyTooltip, setStickyTooltip] = useState(null);
  const [tooltipPosition, setTooltipPosition] = useState({ left: 0, top: 0 });

  const chartRef = useRef(null);
  const containerRef = useRef(null);
  const isGeneratingRef = useRef(false);

  // ===== SHARED HOOKS (from ChartUtils) =====
  const currentMinute = useCurrentMinute();
  const timeRange = useChartTimeRange(viewMode, currentMinute);

  // ===== DERIVED VALUES =====
  const effectiveTargetGlucose = targetGlucose || patientConstants?.target_glucose || 100;
  const viewConfig = VIEW_CONFIGS[viewMode];

  // ===== STABLE PRIMITIVE VALUES FOR DEPENDENCIES =====
  const baselineValue = adjustedBaselineForProjection?.baselineValue;
  const baselineSource = adjustedBaselineForProjection?.baselineSource || adjustedBaselineForProjection?.source;
  const minutesSinceReading = adjustedBaselineForProjection?.minutesSinceReading;
  const confidenceScore = adjustedBaselineForProjection?.confidenceScore;

  const mealsCount = recentMealsData?.length || 0;
  const insulinCount = recentInsulinData?.length || 0;
  const readingsCount = last24hData?.length || 0;

  const activeIOB = activeEffects?.iob?.total_active_insulin || 0;
  const activeMOB = activeEffects?.mob?.total_active_carbs || 0;

  // ===== 🆕 FIX: MEMOIZED MEAL/INSULIN PROCESSING WITH LOOKBACK WINDOWS =====
  const processedMealsForChart = useMemo(() => {
    return processContextMealsForChart(recentMealsData, timeRange, patientConstants);
  }, [recentMealsData, timeRange.start, timeRange.end, patientConstants?.protein_factor, patientConstants?.fat_factor]);

  const processedInsulinForChart = useMemo(() => {
    return processContextInsulinForChart(recentInsulinData, timeRange);
  }, [recentInsulinData, timeRange.start, timeRange.end]);

  // ===== CUMULATIVE AXIS DOMAIN (from ChartUtils) =====
  const cumulativeAxisDomain = useMemo(() => {
    return calculateCumulativeAxisDomain(baselineValue);
  }, [baselineValue]);

  const cumulativeAxisTicks = useMemo(() => {
    return calculateCumulativeAxisTicks(baselineValue);
  }, [baselineValue]);

  // ===== TICK GENERATION (from ChartUtils) =====
  const ticks = useMemo(() => generateXAxisTicks(timeRange, viewConfig), [timeRange, viewConfig]);

  // ===== AXIS FORMATTING (from ChartUtils) =====
  const formatXAxisLabel = useMemo(() => createXAxisFormatter(viewConfig), [viewConfig]);

  // ===== GENERATE CHART DATA (FIXED: no circular dependency, meals now load) =====
  const generateChartData = useCallback(async () => {
    if (isGeneratingRef.current) {
      if (DEBUG_MODE) console.log('⏸️ Chart generation already in progress, skipping');
      return []; // ✅ FIX: Return empty instead of stale chartData
    }

    if (!last24hData) {
      if (DEBUG_MODE) console.log('⏳ Waiting for blood sugar data context');
      return [];
    }

    if (!patientConstants) {
      if (DEBUG_MODE) console.log('⏳ Waiting for patient constants');
      return [];
    }

    if (baselineValue === null || baselineValue === undefined) {
      if (DEBUG_MODE) console.log('⏳ Waiting for baseline calculation');
      return [];
    }

    isGeneratingRef.current = true;

    try {
      if (DEBUG_MODE) {
        console.log('🚀 Generating chart data (v3.0 with meal fix):', {
          baseline: baselineValue,
          meals: processedMealsForChart.length,
          insulin: processedInsulinForChart.length,
          readings: readingsCount
        });
      }

      const { start, end, now } = timeRange;

      // Get actual readings for overlay
      const actualReadings = last24hData
        .filter(reading => {
          const readingTime = reading.readingTime || reading.timestamp;
          return readingTime >= start && readingTime <= end;
        })
        .map(reading => ({
          timestamp: reading.readingTime || reading.timestamp,
          bloodSugar: reading.bloodSugar,
          isActual: true,
          source: reading.source || 'meter'
        }))
        .sort((a, b) => a.timestamp - b.timestamp);

      // ✅ FIX: Use time-filtered meals/insulin (like EffectsVisualization)
      const timeline = await generateChartTimeline(
        baselineValue,
        processedMealsForChart,
        processedInsulinForChart,
        patientConstants,
        {
          startTime: start,
          endTime: end,
          intervalMinutes: viewConfig.interpolationInterval,
          currentBG: actualReadings.length > 0 ? actualReadings[actualReadings.length - 1].bloodSugar : null,
          t1dDuration: patientConstants.t1d_duration_years || 5
        }
      );

      if (DEBUG_MODE) {
        console.log(`✅ Generated ${timeline.length} chart points from service`);
      }

      const halfInterval = (viewConfig.interpolationInterval * 60 * 1000) / 2;

      // Merge actual readings with timeline
      const mergedTimeline = timeline.map((point) => {
        const isHistorical = point.timestamp <= now;
        const isFuture = point.timestamp > now;
        const isNow = Math.abs(point.timestamp - now) < halfInterval;

        // Check for actual reading at this time
        let isActualPoint = false;
        let actualValue = null;

        for (const reading of actualReadings) {
          if (Math.abs(reading.timestamp - point.timestamp) <= halfInterval) {
            isActualPoint = true;
            actualValue = reading.bloodSugar;
            break;
          }
        }

        // ✅ Use shared confidence level from ChartUtils
        const confidenceInfo = getConfidenceLevel(
          { isActualReading: isActualPoint, isFuture, timestamp: point.timestamp },
          minutesSinceReading || 0
        );

        const shouldShowHighConfidence = (
          confidenceInfo.level === 'actual' || confidenceInfo.level === 'high'
        );

        // ✅ Use shared helpers for dose matching
        const mealsAdministered = findMealsAtTime(
          processedMealsForChart, point.timestamp, halfInterval
        ).map(meal => ({
          id: meal.id,
          timestamp: meal.timestamp,
          mealType: meal.mealType || 'normal',
          carbEquiv: meal.nutrition?.totalCarbEquiv || meal.carbEquiv || 0,
          foodItems: meal.foodItems || []
        }));

        const insulinAdministered = findInsulinAtTime(
          processedInsulinForChart, point.timestamp, halfInterval
        ).map(dose => ({
          id: dose.id,
          administrationTime: dose.administrationTime,
          dose: dose.dose,
          medication: dose.medication || dose.insulinType || 'regular_insulin'
        }));

        return {
          timestamp: point.timestamp,
          formattedTime: TimeManager.formatDate(
            new Date(point.timestamp),
            viewConfig.tickFormat === 'HH:mm' ? 'HH:mm' : 'DD/MM HH:mm'
          ),

          // Actual reading (if present)
          actualBG: isActualPoint ? actualValue : null,
          isActualReading: isActualPoint,

          // Estimated BG uses CUMULATIVE approach from service
          estimatedBG: point.estimatedBG,
          projectedBG: point.estimatedBG,
          confidenceLevel: confidenceInfo.level,
          confidenceColor: confidenceInfo.color,
          confidenceLabel: confidenceInfo.label,

          // Baseline
          baseBG: baselineValue,
          baselineSource: baselineSource,
          minutesSinceBaselineUpdate: minutesSinceReading,

          // Instantaneous (rate of change happening now)
          netEffect: point.netEffect,
          mealImpact: point.mealImpact,
          insulinImpact: point.insulinImpact,

          // Cumulative (bank balance that persists)
          cumulativeNetBaseline: point.cumulativeNetBaseline,
          cumulativeMealEffect: point.cumulativeMealEffect,
          cumulativeInsulinEffect: point.cumulativeInsulinEffect,

          // Active amounts from service
          currentAbsorbedCarbs: point.totalAbsorbedCarbs || 0,
          currentAbsorbedInsulin: point.totalAbsorbedInsulin || 0,
          activeCarbs: point.totalActiveCarbs || 0,
          activeInsulin: point.totalActiveInsulin || 0,

          // Pending effects from service
          pendingMealRise: point.pendingMealRise || 0,
          pendingInsulinReduction: point.pendingInsulinReduction || 0,

          // Dose markers
          mealsAdministered,
          insulinAdministered,

          // Status flags
          isHistorical,
          isFuture,
          isNow,
          hasActiveEffects: point.hasActiveEffects,

          // Stacking and risk from service
          insulinStacking: point.insulinStacking,
          mealStacking: point.mealStacking,
          hypoRisk: point.hypoRisk,
          hyperRisk: point.hyperRisk,

          // Dual lines (high/low confidence)
          highConfidenceBG: shouldShowHighConfidence
            ? (actualValue || point.estimatedBG) : null,
          lowConfidenceBG: (confidenceInfo.level !== 'actual' && confidenceInfo.level !== 'high' && point.estimatedBG)
            ? point.estimatedBG : null
        };
      });

      if (DEBUG_MODE) {
        console.log(`📈 Final merged timeline: ${mergedTimeline.length} points`);
      }

      return mergedTimeline;

    } catch (error) {
      console.error('❌ Error generating chart data:', error);
      throw error;
    } finally {
      isGeneratingRef.current = false;
    }
  }, [
    // ✅ FIX: Use only PRIMITIVE values and stable references
    readingsCount,
    baselineValue,
    baselineSource,
    minutesSinceReading,
    confidenceScore,
    activeIOB,
    activeMOB,
    timeRange.start,
    timeRange.end,
    timeRange.now,
    viewConfig.interpolationInterval,
    viewConfig.tickFormat,
    patientConstants,
    effectiveTargetGlucose,
    processedMealsForChart,     // ✅ Uses filtered + memoized
    processedInsulinForChart,   // ✅ Uses filtered + memoized
    last24hData
    // ✅ FIX: REMOVED chartData - was causing circular dependency
  ]);

  // ===== 🔥 FIX: Effect that properly regenerates when meals/insulin change =====
  useEffect(() => {
    if (!last24hData) {
      if (DEBUG_MODE) console.log('⏳ Missing required data for chart generation');
      return;
    }

    if (!patientConstants) {
      if (DEBUG_MODE) console.log('⏳ Missing patient constants');
      return;
    }

    if (baselineValue === null || baselineValue === undefined) {
      if (DEBUG_MODE) console.log('⏳ Waiting for baseline value');
      return;
    }

    // ✅ FIX: REMOVED the stale debounce guard that blocked meal updates
    // OLD (BROKEN):
    // if (chartData.length > 0 && !isChangingView) { return; }
    // That guard meant once insulin loaded and generated chart data,
    // meals arriving later were SILENTLY IGNORED.

    const generateData = async () => {
      try {
        setLoading(true);
        setError(null);

        if (DEBUG_MODE) console.log('📊 Triggering chart data generation...', {
          meals: processedMealsForChart.length,
          insulin: processedInsulinForChart.length,
          readings: readingsCount
        });

        const newData = await generateChartData();

        if (newData && newData.length > 0) {
          setChartData(newData);

          if (onDataUpdate) {
            onDataUpdate(newData);
          }

          if (DEBUG_MODE) console.log(`✅ Chart updated with ${newData.length} points`);
        }

        setLoading(false);
        setIsChangingView(false);
      } catch (err) {
        console.error('❌ Chart generation error:', err);
        setError(err.message);
        setLoading(false);
      }
    };

    // ✅ FIX: Use debounce timer instead of stale-data guard
    const debounceTimer = setTimeout(generateData, 300);
    return () => clearTimeout(debounceTimer);
  }, [
    readingsCount,
    mealsCount,
    insulinCount,
    baselineValue,
    timeRange.start,
    timeRange.end,
    isChangingView,
    generateChartData,
    onDataUpdate,
    patientConstants,
    last24hData,
    processedMealsForChart.length,
    processedInsulinForChart.length
    // ✅ FIX: REMOVED chartData.length - it was causing the debounce bypass
  ]);

  // ===== VIEW MODE CHANGE HANDLER =====
  const handleViewChange = useCallback((newMode) => {
    if (newMode === viewMode) return;

    if (DEBUG_MODE) console.log(`🔄 Changing view mode: ${viewMode} → ${newMode}`);

    setIsChangingView(true);
    setViewMode(newMode);
    setChartData([]); // Clear to force regeneration

    if (contextHandleViewModeChange) {
      contextHandleViewModeChange(newMode);
    }
  }, [viewMode, contextHandleViewModeChange]);

  // ===== TOOLTIP COMPONENT =====
  const CustomTooltipContent = ({ active, payload }) => {
    if (!active || !payload || payload.length === 0) {
      return null;
    }

    const data = payload[0].payload;

    return (
      <div className="custom-tooltip-card">
        <div className="tooltip-header">
          <div className="tooltip-time">
            ⏰ {new Date(data.timestamp).toLocaleString()}
          </div>
          {data.isNow && <span className="tooltip-badge now-badge">NOW</span>}
          {data.isFuture && <span className="tooltip-badge future-badge">FUTURE</span>}
        </div>

        <div className="tooltip-section">
          <div className="tooltip-title">📊 Blood Glucose</div>

          {data.actualBG && (
            <div className="tooltip-row highlight-row">
              <span className="tooltip-label">Actual Reading:</span>
              <span className="tooltip-value actual-value">{Math.round(data.actualBG)} mg/dL</span>
            </div>
          )}

          <div className="tooltip-row">
            <span className="tooltip-label">🎯 T1D Baseline:</span>
            <span className="tooltip-value">{Math.round(data.baseBG)} mg/dL</span>
          </div>

          <div className="tooltip-row">
            <span className="tooltip-label">🏦 Cumulative Effect:</span>
            <span className={`tooltip-value ${data.cumulativeNetBaseline >= 0 ? 'positive' : 'negative'}`}>
              {data.cumulativeNetBaseline >= 0 ? '+' : ''}{Math.round(data.cumulativeNetBaseline)} mg/dL
            </span>
          </div>

          <div className="tooltip-row highlight-row">
            <span className="tooltip-label">📈 Projected BG:</span>
            <span className="tooltip-value projected-value">
              {Math.round(data.estimatedBG)} mg/dL
            </span>
          </div>

          <div className="tooltip-formula">
            {Math.round(data.baseBG)} + {Math.round(data.cumulativeNetBaseline)} = {Math.round(data.estimatedBG)}
          </div>
        </div>

        {/* Cumulative Effects (Bank Balance) */}
        <div className="tooltip-section">
          <div className="tooltip-title">🏦 Cumulative Effects (Bank Balance)</div>
          <div className="tooltip-row">
            <span className="tooltip-label">🍽️ Meals:</span>
            <span className="tooltip-value positive">+{Math.round(data.cumulativeMealEffect || 0)} mg/dL</span>
          </div>
          <div className="tooltip-row">
            <span className="tooltip-label">💉 Insulin:</span>
            <span className="tooltip-value negative">-{Math.round(Math.abs(data.cumulativeInsulinEffect || 0))} mg/dL</span>
          </div>
          <div className="tooltip-row">
            <span className="tooltip-label">🔢 Net:</span>
            <span className={`tooltip-value ${data.cumulativeNetBaseline >= 0 ? 'positive' : 'negative'}`}>
              {data.cumulativeNetBaseline >= 0 ? '+' : ''}{Math.round(data.cumulativeNetBaseline)} mg/dL
            </span>
          </div>
        </div>

        {/* Instantaneous Effects (Rate of Change) */}
        <div className="tooltip-section">
          <div className="tooltip-title">⚡ Instantaneous Effects (Rate of Change)</div>
          <div className="tooltip-row">
            <span className="tooltip-label">🍽️ Meal Impact:</span>
            <span className="tooltip-value positive">+{Math.round(data.mealImpact || 0)} mg/dL</span>
          </div>
          <div className="tooltip-row">
            <span className="tooltip-label">💉 Insulin Impact:</span>
            <span className="tooltip-value negative">-{Math.round(Math.abs(data.insulinImpact || 0))} mg/dL</span>
          </div>
          <div className="tooltip-row">
            <span className="tooltip-label">🔢 Net Effect:</span>
            <span className={`tooltip-value ${data.netEffect >= 0 ? 'positive' : 'negative'}`}>
              {data.netEffect >= 0 ? '+' : ''}{Math.round(data.netEffect)} mg/dL
            </span>
          </div>
        </div>

        {/* Active amounts */}
        <div className="tooltip-section">
          <div className="tooltip-title">📊 Active Amounts</div>
          <div className="tooltip-row">
            <span className="tooltip-label">🍽️ Active Carbs (MOB):</span>
            <span className="tooltip-value">{Math.round(data.activeCarbs || 0)} g</span>
          </div>
          <div className="tooltip-row">
            <span className="tooltip-label">💉 Active Insulin (IOB):</span>
            <span className="tooltip-value">{(data.activeInsulin || 0).toFixed(2)} U</span>
          </div>
          <div className="tooltip-row">
            <span className="tooltip-label">🍽️ Absorbed Carbs:</span>
            <span className="tooltip-value">{Math.round(data.currentAbsorbedCarbs || 0)} g</span>
          </div>
          <div className="tooltip-row">
            <span className="tooltip-label">💉 Absorbed Insulin:</span>
            <span className="tooltip-value">{(data.currentAbsorbedInsulin || 0).toFixed(2)} U</span>
          </div>
        </div>

        {/* Meals administered */}
        {data.mealsAdministered && data.mealsAdministered.length > 0 && (
          <div className="tooltip-section">
            <div className="tooltip-title">🍽️ Meals at This Time</div>
            {data.mealsAdministered.map((meal, idx) => (
              <div key={idx} className="tooltip-meal">
                <div className="meal-time">
                  {new Date(meal.timestamp).toLocaleTimeString()}
                </div>
                <div className="meal-carbs">{meal.carbEquiv.toFixed(1)}g carb equiv</div>
                {meal.foodItems && meal.foodItems.length > 0 && (
                  <div className="meal-items">
                    {meal.foodItems.slice(0, 3).map((item, i) => (
                      <div key={i} className="food-item">• {item.name || item.food_name}</div>
                    ))}
                    {meal.foodItems.length > 3 && (
                      <div className="food-item">... and {meal.foodItems.length - 3} more</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Insulin administered */}
        {data.insulinAdministered && data.insulinAdministered.length > 0 && (
          <div className="tooltip-section">
            <div className="tooltip-title">💉 Insulin at This Time</div>
            {data.insulinAdministered.map((dose, idx) => (
              <div key={idx} className="tooltip-insulin">
                <div className="insulin-time">
                  {new Date(dose.administrationTime).toLocaleTimeString()}
                </div>
                <div className="insulin-dose">
                  {dose.dose.toFixed(1)} U {dose.medication}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Confidence */}
        <div className="tooltip-section">
          <div className="tooltip-row">
            <span className="tooltip-label">Confidence:</span>
            <span className="tooltip-value" style={{ color: data.confidenceColor }}>
              {data.confidenceLabel}
            </span>
          </div>
        </div>
      </div>
    );
  };

  // ===== ACTUAL READING DOT RENDERER =====
  const renderActualReadingDot = (props) => {
    const { cx, cy, payload } = props;

    if (!payload.isActualReading) {
      return null;
    }

    const bgValue = payload.actualBG;
    const color = getBloodSugarStatusColor(bgValue, effectiveTargetGlucose);

    return (
      <g>
        <circle
          cx={cx}
          cy={cy}
          r={6}
          fill={color}
          stroke="#fff"
          strokeWidth={2}
          style={{ cursor: 'pointer' }}
          onClick={() => handleDotClick(payload, cx, cy)}
        />
      </g>
    );
  };

  // ===== DOT CLICK HANDLER =====
  const handleDotClick = (payload, cx, cy) => {
    setStickyTooltip(payload);
    setTooltipPosition({ left: cx, top: cy });
  };

  // ===== CLOSE STICKY TOOLTIP =====
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (stickyTooltip && !event.target.closest('.sticky-tooltip-container')) {
        setStickyTooltip(null);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [stickyTooltip]);

  // ===== FULLSCREEN TOGGLE =====
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen(prev => !prev);
  }, []);

  // ===== RENDER =====
  if (error) {
    return (
      <div className="visualization-error">
        <h3>⚠️ Error Loading Chart</h3>
        <p>{error}</p>
        <button onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }

  if (loading && chartData.length === 0) {
    return (
      <div className="visualization-loading">
        <div className="loading-spinner"></div>
        <p>Loading blood glucose visualization...</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`blood-glucose-visualization ${isFullscreen ? 'fullscreen' : ''} ${embedded ? 'embedded' : ''}`}
      style={{ position: 'relative' }}
    >
      {/* Header */}
      {showControls && (
        <div className="bg-visualization-header">
          <div>
            <h3>Blood Glucose Visualization</h3>
            <p style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
              v3.0 with Cumulative Baseline Tracking
            </p>
          </div>

          <div>
            <div className="view-mode-toggle">
              <button
                onClick={() => handleViewChange('6h')}
                className={viewMode === '6h' ? 'active' : ''}
                disabled={loading}
              >
                6 Hours
              </button>
              <button
                onClick={() => handleViewChange('12h')}
                className={viewMode === '12h' ? 'active' : ''}
                disabled={loading}
              >
                12 Hours
              </button>
              <button
                onClick={() => handleViewChange('24h')}
                className={viewMode === '24h' ? 'active' : ''}
                disabled={loading}
              >
                24 Hours
              </button>
              <button
                onClick={() => handleViewChange('3d')}
                className={viewMode === '3d' ? 'active' : ''}
                disabled={loading}
              >
                3 Days
              </button>
            </div>

            <button
              onClick={fetchLast24hData}
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
          <label>
            <input
              type="checkbox"
              checked={showBaseline}
              onChange={(e) => setShowBaseline(e.target.checked)}
            />
            Baseline
          </label>
          <label>
            <input
              type="checkbox"
              checked={showEstimatedLine}
              onChange={(e) => setShowEstimatedLine(e.target.checked)}
            />
            Projected BG
          </label>
          <label>
            <input
              type="checkbox"
              checked={showActualReadings}
              onChange={(e) => setShowActualReadings(e.target.checked)}
            />
            Actual Readings
          </label>
          <label>
            <input
              type="checkbox"
              checked={showTargetRange}
              onChange={(e) => setShowTargetRange(e.target.checked)}
            />
            Target Range
          </label>
          <label>
            <input
              type="checkbox"
              checked={showNetEffect}
              onChange={(e) => setShowNetEffect(e.target.checked)}
            />
            Instantaneous Effect
          </label>
          <label style={{ fontWeight: '600', color: '#FF9800' }}>
            <input
                        type="checkbox"
              checked={showCumulativeEffect}
              onChange={(e) => setShowCumulativeEffect(e.target.checked)}
            />
            Cumulative Baseline ⭐
          </label>
        </div>
      )}

      {/* Chart or No Data Message */}
      {chartData.length === 0 ? (
        <div style={{
          padding: '60px 20px',
          textAlign: 'center',
          color: '#666',
          background: '#f9f9f9',
          borderRadius: '8px',
          margin: '20px 0'
        }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>📊</div>
          <h3 style={{ margin: '0 0 8px 0', color: '#333' }}>No Data Available</h3>
          <p style={{ margin: '0', fontSize: '14px' }}>
            {readingsCount === 0
              ? 'No blood glucose readings found for this time period. Add a reading to see the visualization.'
              : 'Waiting for data to load...'}
          </p>
        </div>
      ) : (
        <div className="chart-container" ref={chartRef} style={{ height: `${height}px` }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              margin={{ top: 20, right: 30, left: 20, bottom: 70 }}
            >
              <defs>
                {/* Gradients for net effect areas */}
                <linearGradient id="netEffectPositiveGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#4CAF50" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="#4CAF50" stopOpacity={0.1} />
                </linearGradient>
                <linearGradient id="netEffectNegativeGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f44336" stopOpacity={0.1} />
                  <stop offset="95%" stopColor="#f44336" stopOpacity={0.8} />
                </linearGradient>
                {/* Gradient for cumulative effect */}
                <linearGradient id="cumulativeEffectGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#FF9800" stopOpacity={0.6} />
                  <stop offset="95%" stopColor="#FF9800" stopOpacity={0.1} />
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

              {/* Y-Axis Configuration - Left (Blood Glucose) */}
              <YAxis
                yAxisId="glucose"
                domain={[40, 400]}
                ticks={[40, 80, 100, 120, 140, 180, 200, 250, 300, 350, 400]}
                tickFormatter={(value) => `${Math.round(value)}`}
                label={{
                  value: 'Blood Glucose (mg/dL)',
                  angle: -90,
                  position: 'insideLeft',
                  style: { fontSize: '12px', fill: '#666' }
                }}
                stroke="#666"
                fontSize={11}
              />

              {/* Y-Axis Configuration - Right (Cumulative Effect) */}
              <YAxis
                yAxisId="cumulative"
                orientation="right"
                domain={cumulativeAxisDomain}
                ticks={cumulativeAxisTicks}
                tickFormatter={(value) => `${value > 0 ? '+' : ''}${Math.round(value)}`}
                label={{
                  value: 'Cumulative Effect (mg/dL)',
                  angle: 90,
                  position: 'insideRight',
                  style: { fontSize: '12px', fill: '#FF9800' }
                }}
                stroke="#FF9800"
                fontSize={11}
              />

              <Tooltip content={<CustomTooltipContent />} />

              <Legend
                verticalAlign="top"
                height={36}
                formatter={(value) => {
                  const labels = {
                    'highConfidenceBG': 'BG (High Confidence)',
                    'lowConfidenceBG': 'BG (Estimated)',
                    'baselineBG': 'T1D Baseline',
                    'actualBG': 'Actual Readings',
                    'netEffect': 'Instantaneous Effect',
                    'cumulativeNetBaseline': 'Cumulative Effect'
                  };
                  return labels[value] || value;
                }}
              />

              {/* Target Range Reference Lines */}
              {showTargetRange && (
                <>
                  <ReferenceLine
                    yAxisId="glucose"
                    y={effectiveTargetGlucose * 1.3}
                    stroke="#ff8800"
                    strokeDasharray="5 5"
                    label={{
                      value: 'High',
                      position: 'left',
                      fill: '#ff8800',
                      fontSize: 10
                    }}
                  />
                  <ReferenceLine
                    yAxisId="glucose"
                    y={effectiveTargetGlucose}
                    stroke="#4CAF50"
                    strokeDasharray="3 3"
                    label={{
                      value: 'Target',
                      position: 'left',
                      fill: '#4CAF50',
                      fontSize: 10
                    }}
                  />
                  <ReferenceLine
                    yAxisId="glucose"
                    y={effectiveTargetGlucose * 0.7}
                    stroke="#f44336"
                    strokeDasharray="5 5"
                    label={{
                      value: 'Low',
                      position: 'left',
                      fill: '#f44336',
                      fontSize: 10
                    }}
                  />
                </>
              )}

              {/* Current Time Reference Line */}
              <ReferenceLine
                yAxisId="glucose"
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

              {/* Zero Reference Line for Cumulative Effect */}
              {showCumulativeEffect && (
                <ReferenceLine
                  yAxisId="cumulative"
                  y={0}
                  stroke="#999"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  label={{
                    value: 'Zero Effect',
                    position: 'right',
                    fill: '#999',
                    fontSize: 9
                  }}
                />
              )}

              {/* Cumulative Effect Area */}
              {showCumulativeEffect && (
                <Area
                  yAxisId="cumulative"
                  type="monotone"
                  dataKey="cumulativeNetBaseline"
                  name="cumulativeNetBaseline"
                  stroke="#FF9800"
                  strokeWidth={1}
                  fill="url(#cumulativeEffectGradient)"
                  fillOpacity={0.4}
                  isAnimationActive={false}
                />
              )}

              {/* Instantaneous Net Effect Area */}
              {showNetEffect && (
                <Area
                  yAxisId="cumulative"
                  type="monotone"
                  dataKey="netEffect"
                  name="netEffect"
                  stroke="none"
                  fill="url(#netEffectPositiveGradient)"
                  fillOpacity={0.5}
                  baseLine={0}
                  isAnimationActive={false}
                />
              )}

              {/* T1D Baseline Line */}
              {showBaseline && (
                <Line
                  yAxisId="glucose"
                  type="stepAfter"
                  dataKey="baseBG"
                  name="baselineBG"
                  stroke="#2196F3"
                  strokeWidth={2}
                  strokeDasharray="8 4"
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              )}

              {/* Low Confidence BG Line */}
              {showEstimatedLine && (
                <Line
                  yAxisId="glucose"
                  type="monotone"
                  dataKey="lowConfidenceBG"
                  name="lowConfidenceBG"
                  stroke="#9C27B0"
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              )}

              {/* High Confidence BG Line */}
              {showEstimatedLine && (
                <Line
                  yAxisId="glucose"
                  type="monotone"
                  dataKey="highConfidenceBG"
                  name="highConfidenceBG"
                  stroke="#8031A7"
                  strokeWidth={2.5}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              )}

              {/* Actual Reading Dots */}
              {showActualReadings && (
                <Line
                  yAxisId="glucose"
                  type="monotone"
                  dataKey="actualBG"
                  name="actualBG"
                  stroke="transparent"
                  strokeWidth={0}
                  dot={renderActualReadingDot}
                  isAnimationActive={false}
                />
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

export default BloodGlucoseVisualization;

/**
 * ============================================================================
 * UPDATE SUMMARY v3.0 - CHARTUTILS REFACTOR + MEAL BUG FIX
 * ============================================================================
 *
 * BUG FIXES:
 * 1. ✅ FIXED: Meals now load correctly into the chart
 *    - ROOT CAUSE: Debounce guard `chartData.length > 0` blocked regeneration
 *      after meals loaded (insulin loaded first, chart generated once, meals ignored)
 *    - FIX: Replaced stale-data guard with setTimeout debounce (300ms)
 *
 * 2. ✅ FIXED: Removed circular chartData dependency
 *    - ROOT CAUSE: `chartData` was in generateChartData's dependency array AND
 *      was the output, creating a stale closure
 *    - FIX: Removed `chartData` from dependencies, return [] instead of stale data
 *
 * 3. ✅ FIXED: Added MOB/IOB lookback window filtering
 *    - ROOT CAUSE: Unlike EffectsVisualization, meals/insulin were NOT filtered
 *      by lookback windows before being passed to generateChartTimeline
 *    - FIX: Added processedMealsForChart and processedInsulinForChart using
 *      shared processContextMealsForChart() / processContextInsulinForChart()
 *
 * REFACTORING:
 * 4. ✅ Extracted useCurrentMinute() hook (was duplicated useEffect)
 * 5. ✅ Extracted useChartTimeRange() hook (was duplicated useMemo with 7AM logic)
 * 6. ✅ Extracted processContextMealsForChart() (was duplicated processing)
 * 7. ✅ Extracted processContextInsulinForChart() (was duplicated processing)
 * 8. ✅ Extracted calculateCumulativeAxisDomain() (was inline useMemo)
 * 9. ✅ Extracted calculateCumulativeAxisTicks() (was inline useMemo)
 * 10. ✅ Extracted generateXAxisTicks() (was duplicated generateTicks)
 * 11. ✅ Extracted createXAxisFormatter() (was duplicated formatXAxis)
 * 12. ✅ Extracted getConfidenceLevel() (was inline function)
 * 13. ✅ Extracted findMealsAtTime() / findInsulinAtTime() (was inline IIFEs)
 *
 * NET RESULT:
 * - ~150 lines of duplicated code removed
 * - Meal loading race condition fixed
 * - Circular dependency eliminated
 * - Time window filtering now matches EffectsVisualization
 * - All shared logic in single source of truth (ChartUtils.js)
 *
 * ============================================================================
 */



