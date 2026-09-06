/**
 * ============================================================================
 * INSULIN EFFECT VISUALIZATION - COMPREHENSIVE INSULIN TRACKING
 * ============================================================================
 *
 * VERSION: 1.3 - SYNCHRONIZED Y-AXES
 *
 * CHANGES IN v1.3:
 * ✅ FIXED: Synchronized left and right Y-axes based on correction factor
 * ✅ FIXED: BG Impact (mg/dL) = Insulin (units) × Correction Factor
 * ✅ FIXED: Lines now perfectly align: 1u insulin = 50 mg/dL (or user's correction factor)
 * ✅ FIXED: Only 5 units padding instead of 20% for more prominent visualization
 * ✅ Both axes now scale together automatically
 *
 * CHANGES IN v1.2:
 * ✅ FIXED: Unified right Y-axis for insulin units (max 40)
 * ✅ FIXED: Dose markers now use same axis as insulin lines
 * ✅ FIXED: Removed 10x multiplier on dose markers
 * ✅ All insulin measurements now on same scale (0-40 units)
 *
 * CHANGES IN v1.1:
 * ✅ FIXED: Cumulative absorbed insulin now resets at 7 AM daily
 * ✅ FIXED: Cumulative line not selected by default (showAbsorbed = false)
 * ✅ FIXED: BG Impact axis moved to LEFT (insulin units on right) for consistency
 * ✅ Uses TimeManager.getDailyResetTime() and isWithinCurrentDay()
 *
 * KEY FEATURES:
 * - Three-line system showing insulin pharmacodynamics:
 *   1. Absorbed Insulin (cumulative, resets daily at 7 AM) - GREEN SOLID
 *   2. Active Insulin (instantaneous activity) - BLUE DASHED
 *   3. IOB (remaining insulin) - PURPLE DOTTED
 * - Dual Y-axis: BG Impact (left) and Insulin Units (right, max 40)
 * - Enhanced tooltips with breakdown of all three effects
 * - Phase indicators (Starting, Rising, Peak, Active, Declining)
 * - Stacking risk visualization
 *
 * PHARMACODYNAMIC MODEL:
 * - Absorbed = Total insulin that has acted (cumulative, resets at 7 AM)
 * - Active = Currently working insulin (instantaneous, rate of change)
 * - IOB = Remaining insulin on board (future effect)
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
  calculateInsulinBGImpact,
  getInsulinProfile,
  calculateIOB,
  calculateInsulinActivity
} from '../utils/insulinPharmacodynamics';

import { analyzeStackingRisk } from '../utils/insulinStackingAnalyzer';

import { SHARED_CONSTANTS } from '../constants/shared_constants';
import { FaSync, FaExpand, FaCompress } from 'react-icons/fa';
import './Charts/global-visualization.css';

// ✅ Import shared chart utilities
import {
  useCurrentMinute,
  useChartTimeRange,
  processContextInsulinForChart,
  generateXAxisTicks,
  createXAxisFormatter,
  calculateDynamicBarSize,
  findInsulinAtTime,
  getInsulinTypeDisplay,
  CustomInsulinTooltip,
  TooltipSection,
  TooltipHeader,
  TooltipRow
} from '../utils/ChartUtils';

// =====================================
// CONSTANTS
// =====================================

const VIEW_CONFIGS = SHARED_CONSTANTS.VIEW_MODE_CONFIGS;
const DEBUG_MODE = false;

// =====================================
// MAIN COMPONENT
// =====================================

const InsulinEffectVisualization = ({
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
    recentInsulinData,
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

  // ✅ CHANGED: showAbsorbed now defaults to FALSE
  const [showAbsorbed, setShowAbsorbed] = useState(false);
  const [showActive, setShowActive] = useState(true);
  const [showIOB, setShowIOB] = useState(true);
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
  const correctionFactor = patientConstants?.correction_factor || 50;

  // ✅ v1.4: Configurable reset hour with human-readable label
  const resetHour = patientConstants?.daily_reset_hour ?? 7;
  const resetLabel = resetHour === 0 ? '12 AM'
    : resetHour < 12  ? `${resetHour} AM`
    : resetHour === 12 ? '12 PM'
    : `${resetHour - 12} PM`;

  // ===== CONTEXT DATA =====
  const contextInsulin = useMemo(() => {
    if (recentInsulinData && recentInsulinData.length > 0) {
      return recentInsulinData;
    }

    if (activeEffects?.iob?.insulin_contributions && activeEffects.iob.insulin_contributions.length > 0) {
      const now = Date.now();
      return activeEffects.iob.insulin_contributions.map(contrib => ({
        id: `${contrib.insulinType}-${contrib.hoursSinceDose}`,
        administrationTime: now - (contrib.hoursSinceDose * 3600 * 1000),
        dose: contrib.dose,
        medication: contrib.insulinType,
        insulinType: contrib.insulinType
      }));
    }

    return [];
  }, [recentInsulinData, activeEffects?.iob?.insulin_contributions]);

  // ===== MEMOIZED PROCESSING (via ChartUtils) =====
  const processedInsulin = useMemo(() => {
    return processContextInsulinForChart(contextInsulin, timeRange);
  }, [contextInsulin, timeRange.start, timeRange.end]);

  // ===== GENERATE CHART DATA =====
  const generateChartData = useCallback(async () => {
    if (!patientConstants) return [];

    if (DEBUG_MODE) {
      console.log('🚀 Generating insulin chart data (v1.3):', {
        insulin: processedInsulin.length
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

    const halfInterval = intervalMs / 2;

    // Pre-assign each dose to its single closest time point to avoid duplicate bars
    const dosesByTimePoint = new Map();
    processedInsulin.forEach(dose => {
      const doseTime = dose.administrationTime;

      // ✅ FIX Bug 1: Skip doses outside the visible chart window entirely —
      // no ghost bar gets clamped to the first tick.
      if (doseTime < timePoints[0] || doseTime > timePoints[timePoints.length - 1]) {
        return;
      }

      const rawIdx = (doseTime - timePoints[0]) / intervalMs;
const clampedIdx = Math.max(0, Math.min(timePoints.length - 1, Math.floor(rawIdx)));
      const closestTime = timePoints[clampedIdx];
      if (!dosesByTimePoint.has(closestTime)) {
        dosesByTimePoint.set(closestTime, []);
      }
      dosesByTimePoint.get(closestTime).push(dose);
    });

    const timeline = timePoints.map((time) => {
      const isHistorical = time <= now;
      const isFuture = time > now;
      const isNow = Math.abs(time - now) < halfInterval;

      // ✅ v1.4: Use configurable reset hour from patientConstants
      // FIX: use ?? (nullish) not || (falsy) so resetHour=0 (midnight) works correctly
      const resetHour = patientConstants?.daily_reset_hour ?? 7;
      // FIX: pass patient's stored timezone offset so reset boundary matches their
      // local clock even when the browser timezone differs (e.g. travelling patient)
      const tzOffset = patientConstants?.timezone_offset_minutes ?? null;
      const isAtReset = TimeManager.isAtResetTime(time, resetHour, tzOffset);
      const dailyResetTime = TimeManager.getDailyResetTime(time, resetHour, tzOffset);

      // Calculate three insulin effects at this timepoint
      let totalAbsorbedInsulin = 0;
      let totalActiveInsulin = 0;
      let totalIOB = 0;
      let totalAbsorbedBGReduction = 0;
      let totalActiveBGReduction = 0;
      let totalPendingBGReduction = 0;

      const insulinContributions = [];
      const dosesAtTime = dosesByTimePoint.get(time) || [];

      // If exactly at reset hour, force cumulative to 0; active/IOB continue normally
      if (!isAtReset) {
        processedInsulin.forEach(dose => {
          const doseTime = dose.administrationTime;

          // isWithinCurrentDay gates ONLY the cumulative absorbed line —
          // a dose from before the reset still has active/IOB effect right now
          // FIX: pass tzOffset so the boundary uses the patient's local clock
          const isWithinCurrentDay = TimeManager.isWithinCurrentDay(doseTime, time, resetHour, tzOffset);

          const hoursSinceDose = TimeManager.calculateHoursSince(
            time,
            doseTime,
            TimeManager.precision.SECOND
          );

          const impact = calculateInsulinBGImpact(
            hoursSinceDose,
            dose.dose,
            dose.insulinType,
            correctionFactor
          );

          // CRITICAL FIX: Active insulin and IOB are physiological — they continue
          // across the daily reset boundary.  A dose given at 6:50 AM is still
          // actively working at 8 AM; gating it away would hide real insulin
          // on board from the clinician.  Only the cumulative *absorbed* line
          // (used for daily totals) is reset at the configured hour.
          if (impact.isActive) {
            totalActiveInsulin += impact.activeInsulin;
            totalIOB += impact.iob;
            totalActiveBGReduction += impact.activeInsulin * correctionFactor;
            totalPendingBGReduction += impact.pendingReduction;

            insulinContributions.push({
              insulinType: dose.insulinType,
              dose: dose.dose,
              hoursSinceDose: impact.hoursSinceDose,
              absorbed: impact.absorbedInsulin,
              active: impact.activeInsulin,
              iob: impact.iob,
              activity: impact.activity,
              bgReduction: impact.bgReduction,
              pendingReduction: impact.pendingReduction,
              phase: getInsulinPhase(impact),
              profile: impact.profile,
              isWithinCurrentDay
            });
          }

          // Cumulative absorbed: only doses after today's reset contribute
          if (isWithinCurrentDay) {
            if (!impact.isActive && hoursSinceDose > 0) {
              // After duration — full dose absorbed (within current day)
              totalAbsorbedInsulin += dose.dose;
              totalAbsorbedBGReduction += dose.dose * correctionFactor;
            } else if (impact.isActive) {
              // During active phase (within current day)
              totalAbsorbedInsulin += impact.absorbedInsulin;
              totalAbsorbedBGReduction += impact.bgReduction;
            }
          }
        });
      }

      // Dose markers (no scaling - uses same axis as insulin units)
      const totalInsulinAtTime = dosesAtTime.reduce((sum, d) => sum + d.dose, 0);
      const insulinDoseMarker = totalInsulinAtTime > 0 ? totalInsulinAtTime : null;

      return {
        timestamp: time,
        formattedTime: TimeManager.formatDate(
          new Date(time),
          viewConfig.tickFormat === 'HH:mm' ? 'HH:mm' : 'DD/MM HH:mm'
        ),
        timestampPrecision: 'MINUTE',

        // Three insulin effect lines
        absorbedInsulin: totalAbsorbedInsulin,  // ✅ Now resets at 7 AM
        activeInsulin: totalActiveInsulin,
        iob: totalIOB,

        // BG Impact values (for left Y-axis)
        absorbedBGReduction: totalAbsorbedBGReduction,  // ✅ Now resets at 7 AM
        activeBGReduction: totalActiveBGReduction,
        pendingBGReduction: totalPendingBGReduction,

        // Dose markers
        insulinDoseMarker: insulinDoseMarker,

        // Additional info for tooltip
        insulinAdministered: dosesAtTime,
        insulinContributions: insulinContributions,

        // Metadata
        isHistorical,
        isFuture,
        isNow,
        isAtReset,  // ✅ NEW: Flag for 7 AM reset point
        dailyResetTime  // ✅ NEW: For tooltip display
      };
    });

    if (DEBUG_MODE) {
      console.log(`✅ Generated ${timeline.length} chart points with insulin tracking`);
    }

    return timeline;
  }, [
    patientConstants,
    processedInsulin,
    timeRange,
    viewConfig,
    correctionFactor
  ]);

  // ===== EFFECTS =====
  useEffect(() => {
    if (patientConstants && processedInsulin.length > 0) {
      const timeoutId = setTimeout(() => {
        generateChartData().then(data => {
          setChartData(data);
          setLoading(false);

          if (onDataUpdate) {
            onDataUpdate(data);
          }
        }).catch(error => {
          console.error('Error generating chart data:', error);
          setError('Failed to generate chart data');
          setLoading(false);
        });
      }, 200);

      return () => clearTimeout(timeoutId);
    } else if (patientConstants && processedInsulin.length === 0) {
      // No insulin doses in the current window — clear loading immediately
      // so the empty-state message is shown rather than an infinite spinner.
      setChartData([]);
      setLoading(false);
    }
  }, [generateChartData, patientConstants, onDataUpdate, processedInsulin.length]);

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

  // ✅ CHANGED: Calculate SYNCHRONIZED Y-axis domains
  // The two axes are linked: BG Impact (mg/dL) = Insulin (units) × Correction Factor
  const { insulinAxisDomain, bgImpactAxisDomain } = useMemo(() => {
    if (!chartData || chartData.length === 0) {
      return {
        insulinAxisDomain: [0, 10],
        bgImpactAxisDomain: [0, 10 * correctionFactor]
      };
    }

    // Find max values for both insulin units and BG impact
    const maxAbsorbedInsulin = Math.max(...chartData.map(d => d.absorbedInsulin || 0), 0);
    const maxActiveInsulin = Math.max(...chartData.map(d => d.activeInsulin || 0), 0);
    const maxIOB = Math.max(...chartData.map(d => d.iob || 0), 0);
    const maxDose = Math.max(...chartData.map(d => d.insulinDoseMarker || 0), 0);

    const maxAbsorbedBG = Math.max(...chartData.map(d => d.absorbedBGReduction || 0), 0);
    const maxActiveBG = Math.max(...chartData.map(d => d.activeBGReduction || 0), 0);
    const maxPendingBG = Math.max(...chartData.map(d => d.pendingBGReduction || 0), 0);

    // Determine which axis needs more space
    const maxInsulin = Math.max(maxAbsorbedInsulin, maxActiveInsulin, maxIOB, maxDose);
    const maxBGImpact = Math.max(maxAbsorbedBG, maxActiveBG, maxPendingBG);

    // Calculate required insulin units to accommodate BG impact
    const insulinNeededForBG = maxBGImpact / correctionFactor;

    // Use the larger of the two requirements + 5 units padding
    const maxInsulinRequired = Math.max(maxInsulin, insulinNeededForBG);
    const insulinLimit = Math.ceil(maxInsulinRequired) + 5; // 5 units padding

    // Cap at 40 units, minimum 10 units
    const finalInsulinMax = Math.min(Math.max(insulinLimit, 10), 40);

    // BG Impact axis is ALWAYS synchronized: insulin units × correction factor
    const finalBGImpactMax = finalInsulinMax * correctionFactor;

    return {
      insulinAxisDomain: [0, finalInsulinMax],
      bgImpactAxisDomain: [0, finalBGImpactMax]
    };
  }, [chartData, correctionFactor]);

  // ===== CUSTOM TOOLTIP =====
  const CustomTooltipContent = ({ active, payload }) => {
    const data = stickyTooltip || (active && payload && payload.length ? payload[0].payload : null);

    if (!data) return null;

    const hasDose = data.insulinAdministered && data.insulinAdministered.length > 0;

    return (
      <div className="bg-visualization-tooltip">
        {stickyTooltip && (
          <button onClick={handleCloseTooltip} aria-label="Close tooltip">✕</button>
        )}

        {/* Time and Now indicator */}
        <div style={{ fontWeight: '600', marginBottom: '8px', fontSize: '13px' }}>
          {data.formattedTime}
          {data.isNow && <span style={{ marginLeft: '8px', color: '#ff0000', fontSize: '12px' }}>🔴 Now</span>}
          {/* ✅ NEW: Show reset indicator */}
          {data.isAtReset && (
            <span style={{ marginLeft: '8px', color: '#6a1b9a', fontSize: '12px' }}>
              🔄 {resetLabel} Reset
            </span>
          )}
        </div>

        {/* ✅ NEW: Reset notification */}
        {data.isAtReset && (
          <TooltipSection
            backgroundColor="#e8f5e9"
            borderColor="#6a1b9a"
            marginBottom="8px"
          >
            <TooltipHeader icon="🔄" color="#2e7d32">
              Daily Reset Point:
            </TooltipHeader>
            <div style={{ fontSize: '11px', color: '#2e7d32', marginTop: '4px' }}>
              ✅ Cumulative absorbed insulin resets to 0
              <br />
              📊 Active insulin and IOB continue normally (physiological)
            </div>
          </TooltipSection>
        )}

        {/* DOSES ADMINISTERED AT THIS TIME */}
        {hasDose && (
          <TooltipSection
            backgroundColor="#e3f2fd"
            borderColor="#2196F3"
            marginBottom="8px"
          >
            <TooltipHeader icon="💉" color="#1976d2">
              Insulin Doses Administered ({data.insulinAdministered.length}):
            </TooltipHeader>
            {data.insulinAdministered.map((dose, idx) => {
              const insulinInfo = getInsulinTypeDisplay(dose.medication, patientConstants);
              return (
                <div key={idx} style={{
                  padding: '6px',
                  marginBottom: '4px',
                  backgroundColor: '#f9fafb',
                  borderRadius: '4px',
                  borderLeft: `3px solid ${insulinInfo.color}`
                }}>
                  <div style={{ fontWeight: '600', color: insulinInfo.color, fontSize: '11px' }}>
                    {insulinInfo.displayName}
                  </div>
                  <div style={{ fontSize: '12px', marginTop: '2px' }}>
                    <strong>{dose.dose.toFixed(1)} units</strong> - {insulinInfo.type}
                  </div>
                  <div style={{ fontSize: '10px', color: '#6b7280', marginTop: '2px' }}>
                    Onset: {insulinInfo.onset} • Peak: {insulinInfo.peak} • Duration: {insulinInfo.duration}
                  </div>
                </div>
              );
            })}
          </TooltipSection>
        )}

        {/* THREE INSULIN EFFECTS */}
        <TooltipSection
          backgroundColor="#f0f9ff"
          borderColor="#2196F3"
          marginBottom="8px"
        >
          <TooltipHeader icon="💊" color="#1565c0">
            Three Insulin Effects:
          </TooltipHeader>

          {/* 1. Absorbed Insulin (GREEN) - ✅ Now with reset info */}
          <div style={{ marginTop: '6px' }}>
            <div style={{ fontWeight: '600', color: '#6a1b9a', fontSize: '11px', marginBottom: '4px' }}>
              1️⃣ Absorbed Insulin (GREEN SOLID):
            </div>
            <TooltipRow
              label="Amount"
              value={`${data.absorbedInsulin.toFixed(2)} units`}
              valueColor="#6a1b9a"
            />
            <TooltipRow
              label="BG Reduction"
              value={`-${data.absorbedBGReduction.toFixed(1)} mg/dL`}
              valueColor="#6a1b9a"
            />
            <div style={{ fontSize: '10px', color: '#666', marginTop: '2px', fontStyle: 'italic' }}>
              ✅ Cumulative effect (resets daily at {resetLabel})
            </div>
          </div>

          {/* 2. Active Insulin (BLUE) */}
          <div style={{ marginTop: '8px', paddingTop: '6px', borderTop: '1px solid #e0e0e0' }}>
            <div style={{ fontWeight: '600', color: '#2196F3', fontSize: '11px', marginBottom: '4px' }}>
              2️⃣ Active Insulin (BLUE DASHED):
            </div>
            <TooltipRow
              label="Amount"
              value={`${data.activeInsulin.toFixed(2)} units`}
              valueColor="#2196F3"
            />
            <TooltipRow
              label="BG Reduction"
              value={`-${data.activeBGReduction.toFixed(1)} mg/dL`}
              valueColor="#2196F3"
            />
            <div style={{ fontSize: '10px', color: '#666', marginTop: '2px', fontStyle: 'italic' }}>
              ⚡ Currently working (instantaneous rate)
            </div>
          </div>

          {/* 3. IOB (PURPLE) */}
          <div style={{ marginTop: '8px', paddingTop: '6px', borderTop: '1px solid #e0e0e0' }}>
            <div style={{ fontWeight: '600', color: '#9c27b0', fontSize: '11px', marginBottom: '4px' }}>
              3️⃣ Insulin On Board (PURPLE DOTTED):
            </div>
            <TooltipRow
              label="Amount"
              value={`${data.iob.toFixed(2)} units`}
              valueColor="#9c27b0"
            />
            <TooltipRow
              label="Pending BG Reduction"
              value={`-${data.pendingBGReduction.toFixed(1)} mg/dL`}
              valueColor="#9c27b0"
            />
            <div style={{ fontSize: '10px', color: '#666', marginTop: '2px', fontStyle: 'italic' }}>
              ⏳ Remaining to act (future effect)
            </div>
          </div>
        </TooltipSection>

        {/* INDIVIDUAL INSULIN CONTRIBUTIONS */}
        {data.insulinContributions && data.insulinContributions.length > 0 && (
          <TooltipSection
            backgroundColor="#fff9e6"
            borderColor="#ff9800"
            marginBottom="8px"
          >
            <TooltipHeader icon="📊" color="#e65100">
              Active Doses Breakdown ({data.insulinContributions.length}):
            </TooltipHeader>
            {data.insulinContributions.slice(0, 3).map((contrib, idx) => {
              const insulinInfo = getInsulinTypeDisplay(contrib.insulinType, patientConstants);
              return (
                <div key={idx} style={{
                  padding: '6px',
                  marginTop: '6px',
                  backgroundColor: '#fffef7',
                  borderRadius: '4px',
                  borderLeft: `3px solid ${insulinInfo.color}`,
                  fontSize: '10px'
                }}>
                  <div style={{ fontWeight: '600', color: insulinInfo.color, marginBottom: '3px' }}>
                    {insulinInfo.displayName} ({contrib.dose.toFixed(1)}u)
                    {/* ✅ NEW: Show if within current day */}
                    {!contrib.isWithinCurrentDay && (
                      <span style={{ color: '#999', fontSize: '9px', marginLeft: '4px' }}>
                        (before {resetLabel} reset)
                      </span>
                    )}
                  </div>
                  <div style={{ color: '#666' }}>
                    ⏱️ {contrib.hoursSinceDose.toFixed(1)}h ago • {contrib.phase}
                  </div>
                  <div style={{ color: '#666', marginTop: '2px' }}>
                    Absorbed: {contrib.absorbed.toFixed(2)}u | Active: {contrib.active.toFixed(2)}u | IOB: {contrib.iob.toFixed(2)}u
                  </div>
                  <div style={{ color: '#666', marginTop: '2px' }}>
                    Activity: {contrib.activity.toFixed(1)}%
                  </div>
                  <div style={{ marginTop: '3px', fontWeight: '600' }}>
                    Current: -{contrib.bgReduction.toFixed(1)} mg/dL | Pending: -{contrib.pendingReduction.toFixed(1)} mg/dL
                  </div>
                </div>
              );
            })}
            {data.insulinContributions.length > 3 && (
              <div style={{ fontSize: '10px', color: '#666', marginTop: '4px', fontStyle: 'italic' }}>
                +{data.insulinContributions.length - 3} more active doses...
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
        Loading insulin data...
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
            <h3>Insulin Effect Visualization</h3>
            <p style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
              🔬 v1.4 Synchronized Axes • Green = Absorbed (resets at {resetLabel}) • Blue = Active • Purple = IOB
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
          {/* ✅ CHANGED: Note about daily reset added */}
          <label style={{ fontWeight: '600', color: '#6a1b9a' }}>
            <input
              type="checkbox"
              checked={showAbsorbed}
              onChange={() => setShowAbsorbed(!showAbsorbed)}
            />
            Absorbed Insulin (resets at {resetLabel}) ⭐
          </label>
          <label>
            <input
              type="checkbox"
              checked={showActive}
              onChange={() => setShowActive(!showActive)}
            />
            Active Insulin (Current)
          </label>
          <label>
            <input
              type="checkbox"
              checked={showIOB}
              onChange={() => setShowIOB(!showIOB)}
            />
            IOB (Remaining)
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
            Dose Markers
          </label>
        </div>
      )}

      {/* Chart */}
      <div ref={chartRef} className="chart-container">
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart
            data={chartData}
            margin={{ top: 20, right: 30, left: 20, bottom: 60 }}
            onClick={handleChartClick}
          >
            <defs>
              <linearGradient id="absorbedGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6a1b9a" stopOpacity={0.6} />
                <stop offset="100%" stopColor="#ce93d8" stopOpacity={0.15} />
              </linearGradient>

              <linearGradient id="activeGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#2196F3" stopOpacity={0.5} />
                <stop offset="100%" stopColor="#2196F3" stopOpacity={0.1} />
              </linearGradient>

              <linearGradient id="iobGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#9c27b0" stopOpacity={0.5} />
                <stop offset="100%" stopColor="#9c27b0" stopOpacity={0.1} />
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

            {/* ✅ CHANGED: BG Impact is now on LEFT Y-axis */}
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

            {/* ✅ CHANGED: Insulin units now on RIGHT Y-axis */}
            <YAxis
              yAxisId="insulin"
              orientation="right"
              domain={insulinAxisDomain}
              tickFormatter={(value) => `${value.toFixed(1)}u`}
              label={{
                value: 'Insulin (units)',
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
                  'absorbedInsulin': `💊 Absorbed Insulin (resets at ${resetLabel}) ⭐`,
                  'activeInsulin': '⚡ Active Insulin (current activity)',
                  'iob': '⏳ IOB (remaining to act)',
                  'absorbedBGReduction': '📉 Absorbed BG Impact',
                  'activeBGReduction': '📉 Active BG Impact',
                  'pendingBGReduction': '📉 Pending BG Impact',
                  'insulinDoseMarker': '💉 Insulin Doses'
                };
                return labels[value] || value;
              }}
            />

            <ReferenceLine
              yAxisId="insulin"
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
                yAxisId="insulin"
                dataKey="insulinDoseMarker"
                fill="#9c27b0"
                fillOpacity={0.8}
                barSize={dynamicBarSize}
                isAnimationActive={false}
                name="insulinDoseMarker"
              />
            )}

            {showAbsorbed && (
              <Area
                yAxisId="insulin"
                type="monotone"
                dataKey="absorbedInsulin"
                name="absorbedInsulin"
                stroke="#6a1b9a"
                strokeWidth={3}
                fill="url(#absorbedGradient)"
                isAnimationActive={false}
                style={{
                  filter: 'drop-shadow(0 0 2px rgba(106, 27, 154, 0.4))'
                }}
              />
            )}

            {showActive && (
              <Line
                yAxisId="insulin"
                type="monotone"
                dataKey="activeInsulin"
                name="activeInsulin"
                stroke="#2196F3"
                strokeWidth={2.5}
                strokeDasharray="5 5"
                dot={false}
                isAnimationActive={false}
              />
            )}

            {showIOB && (
              <Line
                yAxisId="insulin"
                type="monotone"
                dataKey="iob"
                name="iob"
                stroke="#9c27b0"
                strokeWidth={2}
                strokeDasharray="3 3"
                dot={false}
                isAnimationActive={false}
              />
            )}

            {showBGImpact && showAbsorbed && (
              <Line
                yAxisId="bgimpact"
                type="monotone"
                dataKey="absorbedBGReduction"
                name="absorbedBGReduction"
                stroke="#6a1b9a"
                strokeWidth={1.5}
                strokeOpacity={0.6}
                dot={false}
                isAnimationActive={false}
              />
            )}

            {showBGImpact && showActive && (
              <Line
                yAxisId="bgimpact"
                type="monotone"
                dataKey="activeBGReduction"
                name="activeBGReduction"
                stroke="#2196F3"
                strokeWidth={1.5}
                strokeOpacity={0.6}
                dot={false}
                isAnimationActive={false}
              />
            )}

            {showBGImpact && showIOB && (
              <Line
                yAxisId="bgimpact"
                type="monotone"
                dataKey="pendingBGReduction"
                name="pendingBGReduction"
                stroke="#9c27b0"
                strokeWidth={1.5}
                strokeOpacity={0.6}
                dot={false}
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
    </div>
  );
};

// Helper function to determine insulin phase
function getInsulinPhase(impact) {
  if (!impact.profile) return 'Unknown';

  const { hoursSinceDose, activity } = impact;
  const { onset_hours, peak_hours, duration_hours } = impact.profile;

  if (hoursSinceDose < onset_hours) {
    return 'Starting';
  } else if (hoursSinceDose < peak_hours) {
    return 'Rising to Peak';
  } else if (hoursSinceDose < peak_hours * 1.3) {
    return 'At Peak';
  } else if (hoursSinceDose < duration_hours * 0.7) {
    return 'Active';
  } else {
    return 'Declining';
  }
}

export default React.memo(InsulinEffectVisualization, (prevProps, nextProps) => {
  return (
    prevProps.patientId === nextProps.patientId &&
    prevProps.embedded === nextProps.embedded &&
    prevProps.height === nextProps.height
  );
});

/**
 * ============================================================================
 * UPDATE SUMMARY v1.3 - SYNCHRONIZED Y-AXES
 * ============================================================================
 *
 * CHANGES FROM v1.2:
 * 1. ✅ Synchronized left and right Y-axes
 *    - BG Impact (left) = Insulin (right) × Correction Factor
 *    - Perfect alignment: 1 unit insulin = 50 mg/dL (default correction factor)
 *    - Both axes scale together automatically
 *    - Single unified domain calculation considers both measurements
 *
 * 2. ✅ Improved padding for prominence
 *    - Changed from 20% padding to 5 units fixed padding
 *    - Makes active insulin and IOB lines more prominent
 *    - Better use of vertical space
 *
 * 3. ✅ Intelligent axis scaling
 *    - Determines max needed from both insulin units AND BG impact
 *    - Converts BG impact to equivalent insulin units
 *    - Uses the larger requirement to ensure all data fits
 *    - Maintains synchronization throughout
 *
 * CHANGES FROM v1.1 (v1.2):
 * 1. ✅ Unified right Y-axis for all insulin measurements
 *    - Single Y-axis with max value of 40 units
 *    - Dose markers and insulin lines share same axis
 *    - Removed 10x multiplier on dose markers
 *    - All insulin values now on consistent scale
 *
 * 2. ✅ Improved axis domain calculation
 *    - Considers absorbed, active, IOB, and dose markers
 *    - Capped at 40 units maximum
 *    - Minimum 10 units for readability
 *
 * 3. ✅ Cleaner visual design
 *    - Removed redundant second right axis
 *    - Simplified axis labels
 *    - Consistent insulin unit representation
 *
 * PREVIOUS CHANGES (v1.1):
 * 1. ✅ Cumulative absorbed insulin now resets at 7 AM daily
 *    - Uses TimeManager.getDailyResetTime() to find last 7 AM
 *    - Uses TimeManager.isWithinCurrentDay() to filter doses
 *    - Only doses after 7 AM contribute to cumulative
 *    - Forces cumulative to 0 at exactly 7:00 AM
 *
 * 2. ✅ Cumulative line NOT selected by default
 *    - showAbsorbed state defaults to FALSE
 *    - Must be explicitly toggled on by user
 *    - Active and IOB lines shown by default
 *
 * 3. ✅ Axis consistency with other graphs
 *    - BG Impact moved to LEFT Y-axis (primary)
 *    - Insulin units moved to RIGHT Y-axis (secondary)
 *    - Matches pattern from BloodSugarVisualization
 *
 * 4. ✅ Enhanced tooltip with reset information
 *    - Shows "🔄 7 AM Reset" indicator at reset time
 *    - Explains which effects reset vs. continue
 *    - Shows if doses are from before/after reset
 *
 * BEHAVIOR:
 * - Right axis: 0-40 units (auto-scales with 5u padding)
 * - Left axis: 0-(Right × Correction Factor) mg/dL
 * - Perfect synchronization: same scale relative to correction factor
 * - Dose markers: Display at actual insulin dose values
 * - At 7:00 AM: Cumulative absorbed insulin = 0
 * - After 7:00 AM: Only doses from current day count toward cumulative
 * - Active insulin and IOB: Continue normally (no reset)
 * - Doses from before 7 AM: Still show in active/IOB if within duration
 *
 * CONSISTENCY:
 * - Synchronized axes: 1 unit insulin always = correction factor mg/dL
 * - Matches meal visualization cumulative reset logic
 * - Matches effects visualization axis pattern
 * - Matches blood sugar visualization axis pattern
 * - All graphs now have BG impact on left, units on right
 * - Lines now perfectly aligned between axes
 *
 * ============================================================================
 */