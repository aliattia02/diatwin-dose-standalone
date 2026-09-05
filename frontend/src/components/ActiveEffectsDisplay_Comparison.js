import API_BASE_URL from '../config';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import moment from 'moment';
import axios from 'axios';
import { useBloodSugarData } from '../contexts/BloodSugarDataContext';
import { useConstants } from '../contexts/ConstantsContext';
import { SHARED_CONSTANTS, getInsulinInfo } from '../constants/shared_constants';
import './Charts/new-global-viz.css';
import TimeManager from '../utils/TimeManager';

// =====================================
// CONSTANTS CONFIGURATION
// =====================================
const DEBUG_MODE = false;

// Use timing thresholds from shared constants
const TIMING_THRESHOLDS = {
  MIN_ACTIVE_CARBS: SHARED_CONSTANTS.TIMING_THRESHOLDS.min_active_carbs,
  MAX_ACTIVE_CARBS: SHARED_CONSTANTS.TIMING_THRESHOLDS.max_active_carbs,
  HIGH_IOB_THRESHOLD: SHARED_CONSTANTS.TIMING_THRESHOLDS.high_iob_threshold,
  SLOW_MEAL_ACTIVITY_THRESHOLD: SHARED_CONSTANTS.TIMING_THRESHOLDS.slow_meal_activity_threshold
};

// Status color mappings
const STATUS_COLORS = {
  safe: '#4CAF50',
  balanced: '#2196F3',
  caution_insulin: '#9C27B0',
  caution_meal: '#FF9800',
  risky: '#f44336'
};

// Use net effect thresholds from shared constants
const NET_EFFECT_THRESHOLDS = {
  HIGH_RISING: SHARED_CONSTANTS.NET_EFFECT_THRESHOLDS.high_rising,
  RISING: SHARED_CONSTANTS.NET_EFFECT_THRESHOLDS.rising,
  SLIGHTLY_RISING: SHARED_CONSTANTS.NET_EFFECT_THRESHOLDS.slightly_rising,
  RAPIDLY_FALLING: SHARED_CONSTANTS.NET_EFFECT_THRESHOLDS.rapidly_falling,
  FALLING: SHARED_CONSTANTS.NET_EFFECT_THRESHOLDS.falling,
  SLIGHTLY_FALLING: SHARED_CONSTANTS.NET_EFFECT_THRESHOLDS.slightly_falling
};

// Medication display names - derived from shared constants
const MEDICATION_NAMES = (() => {
  const medications = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors;
  const names = {};

  Object.entries(medications).forEach(([key, value]) => {
    if (value.brand_names && value.brand_names.length > 0) {
      names[key] = `${value.brand_names[0]} (${key.replace('insulin_', '').replace('_', ' ')})`;
    } else {
      names[key] = value.description || key.replace('insulin_', '').replace('_', ' ');
    }
  });

  return names;
})();

// Use curve descriptions from shared constants
const CURVE_DESCRIPTIONS = SHARED_CONSTANTS.CURVE_DESCRIPTIONS;

// Absorption type characteristics - from shared constants
const ABSORPTION_PROFILES = (() => {
  const profiles = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.meal_absorption_profiles;
  const simplified = {};

  Object.entries(profiles).forEach(([key, value]) => {
    simplified[key] = {
      peak: value.peak_hours,
      duration: value.duration_hours,
      onset: value.onset_hours
    };
  });

  return simplified;
})();

// Default pharmacokinetic parameters - from rapid-acting insulin
const DEFAULT_PHARMA = (() => {
  const rapidActing = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors.insulin_aspart;
  return {
    onset: rapidActing?.onset_hours || 0.5,
    peak: rapidActing?.peak_hours || 2.0,
    duration: rapidActing?.duration_hours || 4.0
  };
})();
// =====================================
// ASSESSMENT HELPER (mirrors mobile getProjectedAssessment)
// =====================================

/**
 * Derive a rich assessment from IOB, MOB, and pending effects.
 * Uses the same logic as the mobile getProjectedAssessment — meaningful
 * thresholds (IOB > 0.5u, MOB > 5g) and dynamic card colours.
 */
const NET_PENDING_THRESHOLD = 20;

function getProjectedAssessment(iobValue, mobValue, pendingMealRise, pendingInsulinReduction, currentBG = null) {
  const hasMeaningfulIOB = iobValue > 0.5;
  const hasMeaningfulMOB = mobValue > 5;
  const bothActive       = hasMeaningfulIOB && hasMeaningfulMOB;
  const netPending       = pendingMealRise - pendingInsulinReduction;

  if (currentBG !== null && currentBG < 70) {
    return {
      icon: '🚨', title: 'CRITICAL LOW', titleColor: '#F44336',
      recommendation: 'Critically low blood sugar — take action immediately.',
      projectedOutcome: 'critical_low', cardBg: '#ffebee', borderColor: '#f44336',
    };
  }
  if (currentBG !== null && currentBG > 300) {
    return {
      icon: '🚨', title: 'CRITICAL HIGH', titleColor: '#F44336',
      recommendation: 'Critically high blood sugar — take action immediately.',
      projectedOutcome: 'critical_high', cardBg: '#ffebee', borderColor: '#f44336',
    };
  }

  if (bothActive) {
    if (netPending < -NET_PENDING_THRESHOLD) {
      return {
        icon: '⬇️', title: 'BOTH ACTIVE — FALLING RISK', titleColor: '#9C27B0',
        recommendation:
          'Insulin is outpacing meal absorption — BG is likely to fall. ' +
          'Consider a small snack if not eating again soon.',
        projectedOutcome: 'hypo_risk', cardBg: '#e3f2fd', borderColor: '#2196f3',
      };
    }
    if (netPending > NET_PENDING_THRESHOLD) {
      return {
        icon: '⬆️', title: 'BOTH ACTIVE — RISING RISK', titleColor: '#FF9800',
        recommendation:
          'Meal carbs are outpacing active insulin — BG is likely to rise. ' +
          'Monitor closely and consider a correction dose if needed.',
        projectedOutcome: 'hyper_risk', cardBg: '#fff3e0', borderColor: '#ff9800',
      };
    }
    return {
      icon: '⚖️', title: 'BOTH ACTIVE — BALANCED', titleColor: '#2196F3',
      recommendation:
        'Insulin and carbs are closely matched. Monitor BG closely over the next hour.',
      projectedOutcome: 'balanced', cardBg: '#e3f2fd', borderColor: '#2196f3',
    };
  }

  if (hasMeaningfulIOB) {
    return {
      icon: pendingInsulinReduction > NET_PENDING_THRESHOLD ? '⬇️' : '💉',
      title: 'HIGH IOB', titleColor: '#9C27B0',
      recommendation: pendingInsulinReduction > NET_PENDING_THRESHOLD
        ? 'Active insulin may lower your BG significantly. Consider a snack if not eating soon.'
        : 'Insulin is active. Monitor BG before your next meal.',
      projectedOutcome: 'iob_only', cardBg: '#f3e5f5', borderColor: '#9c27b0',
    };
  }

  if (hasMeaningfulMOB) {
    return {
      icon: pendingMealRise > NET_PENDING_THRESHOLD ? '⬆️' : '🍽️',
      title: 'HIGH MOB', titleColor: '#FF9800',
      recommendation: 'Carbs still absorbing — account for them before dosing again.',
      projectedOutcome: 'mob_only', cardBg: '#fff3e0', borderColor: '#ff9800',
    };
  }

  return {
    icon: '✅', title: 'CLEAR', titleColor: '#4CAF50',
    recommendation: 'No significant active effects. You can eat now.',
    projectedOutcome: 'stable', cardBg: '#e8f5e9', borderColor: '#4caf50',
  };
}

// =====================================
// COMPONENT
// =====================================

/**
 * ActiveEffectsDisplay - T1D Version (FIXED - No Race Conditions)
 *
 * KEY CHANGES:
 * 1. Removed all independent API fetching (fetchRecentMeals, fetchRecentInsulin)
 * 2. Removed duplicate state (iobData, mobData, recentMeals, recentInsulin)
 * 3. Uses ONLY context data as single source of truth
 * 4. Fixed useEffect dependencies to prevent stale closures
 * 5. Simplified calculateNetEffect to only use context baseline
 *
 * Displays:
 * - Stable Baseline (metabolic state without effects)
 * - Current Estimated BG (baseline + current net effect)
 * - IOB (Insulin on Board) - from context only
 * - MOB (Meal on Board) - from context only
 * - Net Effect breakdown
 */

const ActiveEffectsDisplay = ({
  patientId = null,
  compact = false,
  showDetails = true,
  showNetEffect = true,
  showBaseline = true,
  refreshInterval = 60000,
  onDataUpdate = null,
}) => {
  // Get data from context - SINGLE SOURCE OF TRUTH
  const {
    currentEstimatedBG,
    adjustedBaselineForProjection,
    activeEffects,
    targetGlucose: contextTargetGlucose,
    fetchLast24hData,
  } = useBloodSugarData();

  const { patientConstants } = useConstants();

  // Use context target glucose
  const effectiveTargetGlucose = contextTargetGlucose || patientConstants?.target_glucose || 100;

  const fmt = (v, digits = 1, fallback = '—') =>
    typeof v === 'number' && !isNaN(v) ? v.toFixed(digits) : fallback;

  // SIMPLIFIED STATE - Only display state, no fetched data
  const [netEffectData, setNetEffectData] = useState(null);
  const [timingAssessment, setTimingAssessment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedSection, setExpandedSection] = useState(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [showComparison, setShowComparison] = useState(false);
  const [showT1DExplainer, setShowT1DExplainer] = useState(false);

  // Add throttle ref to prevent rapid state updates within the same minute
  const lastUpdateMinuteRef = useRef(null);

  // =====================================
// LOCATE THIS SECTION (around line 130-280)
// =====================================

/**
 * Calculate net effect display using adjusted baseline from context
 *
 * FIXED: Properly extract and store both:
 * 1. Values AT READING TIME (for Step 1 display)
 * 2. Values NOW (for Step 2 display)
 *
 * The context already handles the T1D cumulative model correctly.
 */

/**
 * Calculate net effect display using adjusted baseline from context
 *
 * FIXED: Now uses DISPLAY TIME as the reference, not calculation time
 * This ensures "Last updated" shows when we're DISPLAYING, not when context calculated
 */
// ============================================================================
// DIAGNOSTIC VERSION - calculateNetEffect with extensive logging
// Replace your existing calculateNetEffect function with this temporarily
// to identify where the cumulative values are being lost
// ============================================================================

const calculateNetEffect = useCallback(() => {

  const currentMinute = Math.floor(Date.now() / 60000);
  if (currentMinute === lastUpdateMinuteRef.current) {
    // Skip update if we already updated this minute
    return;
  }

  // Wait for context baseline to be ready
  if (!adjustedBaselineForProjection || adjustedBaselineForProjection.baselineValue === null) {
    return;
  }


  // ✅ FIX: Use minute precision directly to prevent second-level re-renders
  const displayTimestamp = TimeManager.getCurrentTime(TimeManager.precision.MINUTE);
  const readingTimestamp = adjustedBaselineForProjection.readingTimestamp;
  const minutesSinceReading = readingTimestamp
    ? (displayTimestamp - readingTimestamp) / 60000
    : null;

  console.log('⏰ TIME CHECK:', {
    displayTimestamp: new Date(displayTimestamp).toLocaleTimeString(),
    readingTimestamp: readingTimestamp ? new Date(readingTimestamp).toLocaleTimeString() : 'N/A',
    minutesSinceReading: minutesSinceReading?.toFixed(2)
  });

  // Use the pre-calculated values from context
  const baseline = adjustedBaselineForProjection.baselineValue;
  const actualReading = adjustedBaselineForProjection.actualReading;
  const currentEstimatedBGValue = adjustedBaselineForProjection.currentEstimatedBG;
  const projectedFinalBG = adjustedBaselineForProjection.projectedFinalBG;

  console.log('📊 BASIC VALUES:', {
    baseline,
    actualReading,
    currentEstimatedBGValue,
    projectedFinalBG
  });

  // ✅ CHECK: Look for cumulative values in context
  console.log('🔍 CHECKING FOR CUMULATIVE VALUES IN CONTEXT:');
  console.log('  cumulativeMealEffectAtReading:', adjustedBaselineForProjection.cumulativeMealEffectAtReading);
  console.log('  cumulativeInsulinEffectAtReading:', adjustedBaselineForProjection.cumulativeInsulinEffectAtReading);
  console.log('  cumulativeNetEffectAtReading:', adjustedBaselineForProjection.cumulativeNetEffectAtReading);
  console.log('  cumulativeTotalAbsorbedCarbsAtReading:', adjustedBaselineForProjection.cumulativeTotalAbsorbedCarbsAtReading);
  console.log('  cumulativeTotalAbsorbedInsulinAtReading:', adjustedBaselineForProjection.cumulativeTotalAbsorbedInsulinAtReading);

  console.log('🔍 CHECKING FOR OLD INSTANTANEOUS VALUES IN CONTEXT:');
  console.log('  mealImpactAtReading:', adjustedBaselineForProjection.mealImpactAtReading);
  console.log('  insulinImpactAtReading:', adjustedBaselineForProjection.insulinImpactAtReading);
  console.log('  absorbedCarbsAtReading:', adjustedBaselineForProjection.absorbedCarbsAtReading);
  console.log('  absorbedInsulinAtReading:', adjustedBaselineForProjection.absorbedInsulinAtReading);

  console.log('🔍 CHECKING FOR CURRENT CUMULATIVE VALUES:');
  console.log('  cumulativeMealEffect:', adjustedBaselineForProjection.cumulativeMealEffect);
  console.log('  cumulativeInsulinEffect:', adjustedBaselineForProjection.cumulativeInsulinEffect);
  console.log('  cumulativeNetBaseline:', adjustedBaselineForProjection.cumulativeNetBaseline);

  // ✅ VALUES AT READING TIME (for Step 1 display)
  // Try cumulative values first, fallback to old values
  const mealImpactAtReading = adjustedBaselineForProjection.cumulativeMealEffectAtReading ||
                               adjustedBaselineForProjection.mealImpactAtReading || 0;
  const insulinImpactAtReading = adjustedBaselineForProjection.cumulativeInsulinEffectAtReading ||
                                 adjustedBaselineForProjection.insulinImpactAtReading || 0;
  const netEffectAtReading = adjustedBaselineForProjection.cumulativeNetEffectAtReading ||
                             adjustedBaselineForProjection.netEffectAtReading || 0;
  const absorbedCarbsAtReading = adjustedBaselineForProjection.cumulativeTotalAbsorbedCarbsAtReading ||
                                 adjustedBaselineForProjection.absorbedCarbsAtReading || 0;
  const absorbedInsulinAtReading = adjustedBaselineForProjection.cumulativeTotalAbsorbedInsulinAtReading ||
                                   adjustedBaselineForProjection.absorbedInsulinAtReading || 0;
  const activeMOBAtReading = adjustedBaselineForProjection.activeMOBAtReading || 0;
  const activeIOBAtReading = adjustedBaselineForProjection.activeIOBAtReading || 0;

  console.log('✅ EXTRACTED VALUES FOR STEP 1 (at reading time):', {
    mealImpactAtReading,
    insulinImpactAtReading,
    netEffectAtReading,
    absorbedCarbsAtReading,
    absorbedInsulinAtReading,
    activeMOBAtReading,
    activeIOBAtReading
  });

  // CURRENT VALUES NOW (for Step 2 display)
  const mealImpact = adjustedBaselineForProjection.mealImpact || 0;
  const insulinImpact = adjustedBaselineForProjection.insulinImpact || 0;
  const currentNetEffect = adjustedBaselineForProjection.currentNetEffect || 0;

  console.log('✅ EXTRACTED VALUES FOR STEP 2 (current):', {
    mealImpact,
    insulinImpact,
    currentNetEffect
  });

  // 🆕 CUMULATIVE BASELINE VALUES - The "bank balance"
  const cumulativeMealEffect = adjustedBaselineForProjection.cumulativeMealEffect || 0;
  const cumulativeInsulinEffect = adjustedBaselineForProjection.cumulativeInsulinEffect || 0;
  const cumulativeNetBaseline = adjustedBaselineForProjection.cumulativeNetBaseline || 0;

  console.log('✅ CUMULATIVE BASELINE VALUES (bank balance):', {
    cumulativeMealEffect,
    cumulativeInsulinEffect,
    cumulativeNetBaseline
  });

  // Calculate current absorbed carbs from meal impact if not provided
  const carbToBgFactor = patientConstants?.carb_to_bg_factor || 4;
  const currentAbsorbedCarbs = adjustedBaselineForProjection.currentAbsorbedCarbs ||
                                (mealImpact > 0 ? mealImpact / carbToBgFactor : 0);

  // Calculate current absorbed insulin if not provided
  const correctionFactor = patientConstants?.correction_factor || 40;
  const currentAbsorbedInsulin = adjustedBaselineForProjection.currentAbsorbedInsulin ||
                                  (insulinImpact > 0 ? insulinImpact / correctionFactor : 0);

  console.log('✅ CALCULATED ABSORBED (current):', {
    currentAbsorbedCarbs,
    currentAbsorbedInsulin
  });

  // PENDING EFFECTS (PRESENT→FUTURE)
  const pendingMealRise = adjustedBaselineForProjection.pendingMealRise || 0;
  const pendingInsulinReduction = adjustedBaselineForProjection.pendingInsulinReduction || 0;
  const activeMOB = adjustedBaselineForProjection.activeMOB || 0;
  const activeIOB = adjustedBaselineForProjection.activeIOB || 0;

  console.log('✅ PENDING EFFECTS:', {
    pendingMealRise,
    pendingInsulinReduction,
    activeMOB,
    activeIOB
  });

  // CREATE THE RESULT OBJECT
  const resultObject = {
    // The stable baseline
    baseline: Math.round(baseline),
    currentEstimatedBG: Math.round(currentEstimatedBGValue),
    projectedFinalBG: Math.round(projectedFinalBG),

    // ✅ VALUES AT READING TIME (Step 1 - using cumulative values)
    mealImpactAtReading: Math.round(mealImpactAtReading * 10) / 10,
    insulinImpactAtReading: Math.round(insulinImpactAtReading * 10) / 10,
    netEffectAtReading: Math.round(netEffectAtReading * 10) / 10,
    absorbedCarbsAtReading: Math.round(absorbedCarbsAtReading * 10) / 10,
    absorbedInsulinAtReading: Math.round(absorbedInsulinAtReading * 100) / 100,
    activeMOBAtReading: Math.round(activeMOBAtReading * 10) / 10,
    activeIOBAtReading: Math.round(activeIOBAtReading * 100) / 100,

    // ✅ Meal and insulin contributions
    mealContributionsAtReading: adjustedBaselineForProjection.mealContributions || [],
    insulinContributionsAtReading: adjustedBaselineForProjection.insulinContributions || [],

    // CURRENT VALUES NOW (instantaneous rate of change)
    projectedEffect: Math.round(currentNetEffect * 10) / 10,
    mealImpact: Math.round(mealImpact * 10) / 10,
    insulinImpact: Math.round(insulinImpact * 10) / 10,
    absorbedCarbs: Math.round(currentAbsorbedCarbs * 10) / 10,
    absorbedInsulin: Math.round(currentAbsorbedInsulin * 100) / 100,

    // 🆕 CUMULATIVE BASELINE VALUES (the "bank balance" - persists after absorption)
    cumulativeMealEffect: Math.round(cumulativeMealEffect * 10) / 10,
    cumulativeInsulinEffect: Math.round(cumulativeInsulinEffect * 10) / 10,
    cumulativeNetBaseline: Math.round(cumulativeNetBaseline * 10) / 10,

    // PENDING EFFECTS
    pendingMealRise: Math.round(pendingMealRise * 10) / 10,
    pendingInsulinReduction: Math.round(pendingInsulinReduction * 10) / 10,
    activeMOB: Math.round(activeMOB * 10) / 10,
    activeIOB: Math.round(activeIOB * 100) / 100,

    // Metadata
    actualReading: actualReading ? Math.round(actualReading) : null,
    lastActualReading: actualReading ? Math.round(actualReading) : null,
    lastReadingTime: readingTimestamp,
    timestamp: displayTimestamp,
    contextCalculationTime: adjustedBaselineForProjection.timestamp,
    source: adjustedBaselineForProjection.source || adjustedBaselineForProjection.baselineSource,
    confidence: adjustedBaselineForProjection.confidence,
    confidenceScore: adjustedBaselineForProjection.confidenceScore,
    confidenceMessage: adjustedBaselineForProjection.confidenceMessage,
    hasActiveEffects: adjustedBaselineForProjection.hasActiveEffects,
    minutesSinceReading: minutesSinceReading ? Math.round(minutesSinceReading * 10) / 10 : null,
    projected: Math.round(currentEstimatedBGValue),
  };

  console.log('📦 FINAL RESULT OBJECT BEING SET:', resultObject);
  console.log('🔍 ==================== calculateNetEffect DIAGNOSTIC END ====================');

  // Update the ref to track this minute's update
  lastUpdateMinuteRef.current = currentMinute;
  setNetEffectData(resultObject);

}, [adjustedBaselineForProjection, patientConstants]);




  /**
   * FIXED: Set loading state based on context readiness
   * No more independent fetching
   */
  useEffect(() => {
    if (activeEffects && !activeEffects.loading) {
      setError(null);
      setLoading(false);
    }
  }, [activeEffects]);

  /**
   * Trigger initial 24h data fetch on mount
   */
  useEffect(() => {
    if (DEBUG_MODE) console.log('🚀 ActiveEffectsDisplay: Mounting, triggering initial data fetch');
    if (fetchLast24hData) {
      fetchLast24hData();
    }

    // Periodic refresh of 24h data
    const interval = setInterval(() => {
      if (fetchLast24hData) {
        fetchLast24hData();
      }
    }, 2 * 60 * 1000);

    return () => clearInterval(interval);
  }, [fetchLast24hData]);



  // =====================================
// TIMESTAMP DISPLAY HELPER COMPONENT
// =====================================

/**
 * Display timestamp with relative time
 * @param {number} timestamp - Unix timestamp in milliseconds
 */
const TimestampDisplay = ({ timestamp }) => {
  if (!timestamp) return <span style={{ color: '#999' }}>N/A</span>;

  const date = new Date(timestamp);
  const now = new Date();
  const minutesAgo = (now - date) / 60000;

  return (
    <span style={{ color: '#666', fontSize: '10px' }}>
      {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      {' '}
      ({minutesAgo < 60
        ? `${Math.round(minutesAgo)}min ago`
        : `${(minutesAgo / 60).toFixed(1)}h ago`})
    </span>
  );
};




/**
 * Set up periodic refresh synchronized to minute boundaries
 * FIXED: Loads IMMEDIATELY on mount, then syncs to minute boundaries
 *
 * Timeline:
 * 1. Component mounts → calculate immediately (don't wait)
 * 2. After first calculation → sync to next minute boundary
 * 3. Continue refreshing every minute at :00 seconds
 */






/**
 * Synchronized refresh with BloodSugarDataContext
 * Both IOB/MOB and Net Effect refresh together at minute boundaries
 */
useEffect(() => {
  if (!currentEstimatedBG || currentEstimatedBG.source === 'loading') {
    return;
  }

  let syncTimeout = null;
  let refreshInterval_id = null;

  // ✅ IMMEDIATE: Calculate on mount
  if (DEBUG_MODE) {
    const now = new Date();
    console.log('🚀 ActiveEffects: Loading data immediately at',
      now.toLocaleTimeString() + '.' + now.getMilliseconds());
  }
  calculateNetEffect();

  // ✅ SYNC: Schedule to next minute boundary
  const now = new Date();
  const secondsUntilNextMinute = 60 - now.getSeconds();
  const msUntilNextMinute = secondsUntilNextMinute * 1000 - now.getMilliseconds();

  if (DEBUG_MODE) {
    const nextMinuteBoundary = new Date(Date.now() + msUntilNextMinute);
    console.log(`⏰ ActiveEffects: Next sync in ${secondsUntilNextMinute}s at ${nextMinuteBoundary.toLocaleTimeString()}`);
  }

  syncTimeout = setTimeout(() => {
    const syncTime = new Date();
    if (DEBUG_MODE) {
      console.log(`🔄 ActiveEffects: SYNCED to minute boundary at ${syncTime.toLocaleTimeString()}`);
    }
    calculateNetEffect();

    // Set up interval for every minute
    refreshInterval_id = setInterval(() => {
      const refreshTime = new Date();
      if (DEBUG_MODE) {
        console.log(`🔄 ActiveEffects: Minute boundary refresh at ${refreshTime.toLocaleTimeString()}`);
      }
      calculateNetEffect();
    }, 60000);

  }, msUntilNextMinute);

  return () => {
    if (syncTimeout) {
      clearTimeout(syncTimeout);
      if (DEBUG_MODE) console.log('🧹 ActiveEffects: Cleared sync timeout');
    }
    if (refreshInterval_id) {
      clearInterval(refreshInterval_id);
      if (DEBUG_MODE) console.log('🧹 ActiveEffects: Cleared refresh interval');
    }
  };
}, [currentEstimatedBG, calculateNetEffect]);



  /**
   * Assess meal timing safety
   *
   * UPDATED: Now accepts netEffectData to use projected pending effects
   * (pendingMealRise, pendingInsulinReduction, projectedFinalBG) so the
   * recommendation reflects which force is "winning" going forward.
   *
   * projectedOutcome values:
   *   'hypo_risk'  – insulin likely to outpace remaining carbs → BG dropping
   *   'hyper_risk' – remaining carbs likely to outpace insulin → BG rising
   *   'balanced'   – net pending effect is small / offsetting
   *   'stable'     – only one factor active, no major swing expected
   */
  const assessMealTiming = useCallback((mobData, iobData, netData = null) => {
    const totalActiveCarbs  = mobData?.total_active_carbs   || 0;
    const totalActiveInsulin = iobData?.total_active_insulin || 0;

    const contributions = mobData?.contributions || [];
    const slowMealsActive = contributions.filter(
      c => ['slow', 'very_slow'].includes(c.absorptionType) &&
           c.activityPercent > TIMING_THRESHOLDS.SLOW_MEAL_ACTIVITY_THRESHOLD
    );

    const hasHighIOB    = totalActiveInsulin >= TIMING_THRESHOLDS.HIGH_IOB_THRESHOLD;
    const hasHighMOB    = totalActiveCarbs   >= TIMING_THRESHOLDS.MAX_ACTIVE_CARBS;
    const hasModerateMOB = totalActiveCarbs  >= TIMING_THRESHOLDS.MIN_ACTIVE_CARBS;

    // Projected pending swing (positive = BG going up, negative = BG going down)
    const pendingMealRise         = netData?.pendingMealRise         || 0;
    const pendingInsulinReduction = netData?.pendingInsulinReduction || 0;
    const projectedFinalBG        = netData?.projectedFinalBG        || null;
    const netPendingEffect        = pendingMealRise - pendingInsulinReduction;

    let safety          = 'safe';
    let recommendation  = 'You can eat now.';
    let warning         = null;
    let projectedOutcome = 'stable'; // hypo_risk | hyper_risk | balanced | stable

    if (hasHighIOB && hasHighMOB) {
      // ── Both active: use projected net to determine which is winning ──
      safety = 'balanced';
      warning = `${Math.round(totalActiveCarbs)}g carbs and ${totalActiveInsulin.toFixed(1)}u insulin active.`;

      if (netPendingEffect < -NET_PENDING_THRESHOLD) {
        projectedOutcome = 'hypo_risk';
        recommendation   =
          'Insulin is outpacing meal absorption — BG is likely to fall. ' +
          'Consider a small snack if not eating again soon.';
      } else if (netPendingEffect > NET_PENDING_THRESHOLD) {
        projectedOutcome = 'hyper_risk';
        recommendation   =
          'Meal carbs are outpacing active insulin — BG is likely to rise. ' +
          'Monitor closely and consider a correction dose if needed.';
      } else {
        projectedOutcome = 'balanced';
        recommendation   =
          'Insulin and carbs are closely matched. Monitor BG closely over the next hour.';
      }
    } else if (totalActiveCarbs >= TIMING_THRESHOLDS.MAX_ACTIVE_CARBS) {
      // ── High MOB only ──
      safety           = 'risky';
      projectedOutcome = 'hyper_risk';
      recommendation   = 'Wait 30–60 minutes before eating again.';
      warning          = `${Math.round(totalActiveCarbs)}g of carbs still absorbing from previous meal(s).`;
    } else if (hasHighIOB) {
      // ── High IOB only ──
      safety           = 'caution_insulin';
      projectedOutcome = pendingInsulinReduction > NET_PENDING_THRESHOLD ? 'hypo_risk' : 'stable';
      recommendation   = pendingInsulinReduction > NET_PENDING_THRESHOLD
        ? 'Active insulin may lower your BG significantly. Consider a snack if not eating soon.'
        : 'Insulin is active. Monitor BG before your next meal.';
      warning = `${totalActiveInsulin.toFixed(1)}u insulin still active.`;
    } else if (hasModerateMOB) {
      // ── Moderate MOB only ──
      safety           = 'caution_meal';
      projectedOutcome = pendingMealRise > NET_PENDING_THRESHOLD ? 'hyper_risk' : 'stable';
      recommendation   = 'You can eat, but account for active carbs in your insulin calculation.';
      warning          = `${Math.round(totalActiveCarbs)}g carbs still absorbing.`;
    }

    if (slowMealsActive.length > 0) {
      const slowMeal = slowMealsActive[0];
      warning = (warning || '') +
        ` Note: ${slowMeal.absorptionType} meal from ${slowMeal.hoursElapsed}h ago still absorbing.`;
    }

    return {
      safety,
      recommendation,
      warning,
      projectedOutcome,
      pendingMealRise,
      pendingInsulinReduction,
      netPendingEffect,
      projectedFinalBG,
      activeCarbs:   totalActiveCarbs,
      activeInsulin: totalActiveInsulin,
      shouldWait:    safety === 'risky'
    };
  }, []);

  /**
   * Update timing assessment when IOB/MOB changes
   */
  useEffect(() => {
    if (activeEffects?.iob && activeEffects?.mob) {
      const assessment = assessMealTiming(activeEffects.mob, activeEffects.iob, netEffectData);
      setTimingAssessment(assessment);
    }
  }, [activeEffects, netEffectData, assessMealTiming]);

  /**
   * Callback for parent components
   */
  useEffect(() => {
    if (onDataUpdate && !loading && activeEffects && netEffectData) {
      onDataUpdate({
        iob: activeEffects.iob,
        mob: activeEffects.mob,
        timing: timingAssessment,
        netEffect: netEffectData,
        baseline: adjustedBaselineForProjection
      });
    }
  }, [onDataUpdate, loading, activeEffects, netEffectData, timingAssessment, adjustedBaselineForProjection]);

  // === HELPER FUNCTIONS FOR UI ===

  const getStatusColor = (projectedEffect) => {
    if (projectedEffect > NET_EFFECT_THRESHOLDS.HIGH_RISING) return '#ff4444';
    if (projectedEffect > NET_EFFECT_THRESHOLDS.RISING) return '#ff8800';
    if (projectedEffect < NET_EFFECT_THRESHOLDS.RAPIDLY_FALLING) return '#4CAF50';
    if (projectedEffect < NET_EFFECT_THRESHOLDS.FALLING) return '#82ca9d';
    return '#666666';
  };

  const getStatusText = (projectedEffect) => {
    if (projectedEffect > NET_EFFECT_THRESHOLDS.HIGH_RISING) return 'High Rising';
    if (projectedEffect > NET_EFFECT_THRESHOLDS.RISING) return 'Rising';
    if (projectedEffect > NET_EFFECT_THRESHOLDS.SLIGHTLY_RISING) return 'Slightly Rising';
    if (projectedEffect < NET_EFFECT_THRESHOLDS.RAPIDLY_FALLING) return 'Rapidly Falling';
    if (projectedEffect < NET_EFFECT_THRESHOLDS.FALLING) return 'Falling';
    if (projectedEffect < NET_EFFECT_THRESHOLDS.SLIGHTLY_FALLING) return 'Slightly Falling';
    return 'Stable';
  };

  const getOverallStatus = () => {
    if (!timingAssessment) return 'safe';

    const { safety, projectedOutcome } = timingAssessment;

    // Risky always wins
    if (safety === 'risky') return 'risky';

    // Both active — colour by projected outcome
    if (safety === 'balanced') {
      if (projectedOutcome === 'hypo_risk')  return 'caution_insulin'; // purple
      if (projectedOutcome === 'hyper_risk') return 'caution_meal';    // orange
      return 'balanced';                                               // blue
    }

    if (safety === 'caution_insulin') return 'caution_insulin';
    if (safety === 'caution_meal')    return 'caution_meal';
    if (safety === 'caution')         return 'caution_meal';
    return 'safe';
  };

// [CONTINUATION FROM PART 1...]

  // === RENDER LOGIC ===

  // Show loading state while waiting for baseline
  if (loading && !activeEffects?.iob && !activeEffects?.mob) {
    return (
      <div className={compact ? 'active-effects-compact' : 'active-effects-card'}>
        <div className="active-effects-loading">
          ⏳ Loading active effects...
        </div>
      </div>
    );
  }

  // Show error state
  if (error) {
    return (
      <div className={compact ? 'active-effects-compact' : 'active-effects-card'}>
        <div className="active-effects-error">
          {error}
        </div>
      </div>
    );
  }

  // Extract display values - allow component to render even if baseline not ready
  const displayIobValue = activeEffects?.iob?.total_active_insulin || 0;
  const displayMobValue = activeEffects?.mob?.total_active_carbs || 0;
  const displayIobContributions = activeEffects?.iob?.insulin_contributions || [];
  const displayMobContributions = activeEffects?.mob?.meal_contributions || [];

  // Don't render if we have absolutely no data
  if (!activeEffects?.iob && !activeEffects?.mob) {
    if (DEBUG_MODE) console.log('⚠️ ActiveEffects: No IOB/MOB data yet, not rendering');
    return null;
  }

  if (DEBUG_MODE) {
    console.log('✅ ActiveEffects: Rendering with data', {
      hasIOB: !!activeEffects?.iob,
      hasMOB: !!activeEffects?.mob,
      hasBaseline: !!adjustedBaselineForProjection,
      iobValue: displayIobValue,
      mobValue: displayMobValue
    });
  }

  const overallStatus = getOverallStatus();
  const statusColor = STATUS_COLORS[overallStatus];

  // === COMPACT VIEW ===
  if (compact) {
    return (
      <div className="active-effects-compact" style={{ borderLeftColor: statusColor }}>
        <div className="active-effects-compact-content">
          {/* Net Effect */}
          {netEffectData && (
            <div className="active-effects-compact-stat">
              <div>
                <div className="active-effects-value active-effects-value-compact" style={{
                  color: netEffectData.projectedEffect > 0 ? '#FF9800' :
                         netEffectData.projectedEffect < 0 ? '#4CAF50' : '#666'
                }}>
                  {netEffectData.projectedEffect > 0 ? '+' : ''}{netEffectData.projectedEffect.toFixed(0)}
                </div>
                <div className="active-effects-label-compact">Net</div>
              </div>
            </div>
          )}

          <div className="active-effects-divider" />

          {/* MOB */}
          <div className="active-effects-compact-stat">
            <span className="active-effects-icon">🍽️</span>
            <div>
              <div className="active-effects-value active-effects-value-compact">
                {displayMobValue.toFixed(0)}g
              </div>
              <div className="active-effects-label-compact">MOB</div>
            </div>
          </div>

          {showNetEffect && netEffectData && (
            <>
              <div className="active-effects-divider" />

              {/* Baseline */}
              <div className="active-effects-compact-stat">
                <div>
                  <div className="active-effects-value active-effects-value-compact active-effects-value-baseline">
                    {netEffectData.baseline}
                  </div>
                  <div className="active-effects-label-compact">Base</div>
                </div>
              </div>

              <div className="active-effects-divider" />

              {/* Net Effect */}
              <div className="active-effects-compact-stat">
                <div>
                  <div className="active-effects-value active-effects-value-compact" style={{
                    color: netEffectData.projectedEffect > 0 ? '#FF9800' : '#4CAF50'
                  }}>
                    {netEffectData.projectedEffect > 0 ? '+' : ''}{netEffectData.projectedEffect.toFixed(0)}
                  </div>
                  <div className="active-effects-label-compact">Net</div>
                </div>
              </div>

              <div className="active-effects-divider" />

              {/* Current Estimated BG */}
              <div className="active-effects-compact-stat">
                <div>
                  <div className="active-effects-value active-effects-value-compact" style={{
                    color: netEffectData.currentEstimatedBG > effectiveTargetGlucose * 1.3 ? '#ff4444' :
                           netEffectData.currentEstimatedBG < effectiveTargetGlucose * 0.7 ? '#ff8800' : '#4CAF50'
                  }}>
                    {netEffectData.currentEstimatedBG || netEffectData.projected}
                  </div>
                  <div className="active-effects-label-compact">Est BG</div>
                </div>
              </div>

              {/* Projected Final BG (if pending insulin exists) */}
              {netEffectData.pendingInsulinReduction > 0 && (
                <>
                  <div className="active-effects-divider" />
                  <div className="active-effects-compact-stat">
                    <div>
                      <div className="active-effects-value-compact-final" style={{
                        color: netEffectData.projectedFinalBG > effectiveTargetGlucose * 1.3 ? '#ff4444' :
                               netEffectData.projectedFinalBG < effectiveTargetGlucose * 0.7 ? '#ff8800' : '#4CAF50'
                      }}>
                        {netEffectData.projectedFinalBG}
                      </div>
                      <div className="active-effects-label-compact-final">Final</div>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  // === FULL VIEW ===
  return (
    <div className="active-effects-card">
      <div className="active-effects-header" style={{borderLeftColor: statusColor}}
        onClick={() => setIsCollapsed(!isCollapsed)}>
        <div className="active-effects-header-content">
          <div>
            <h3 className="active-effects-title">Active Effects Dashboard</h3>
            <div className="active-effects-subtitle">
              Complete metabolic state • IOB • MOB • Net Effect
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              className="active-effects-collapse-btn"
              onClick={(e) => {
                e.stopPropagation();
                setShowComparison(prev => !prev);
              }}
              title="Toggle frontend ↔ backend comparison panel"
              style={{
                padding: '4px 10px',
                backgroundColor: showComparison ? '#1a237e' : 'transparent',
                border: `1px solid ${showComparison ? '#5c6bc0' : '#aaa'}`,
                borderRadius: '4px',
                color: showComparison ? '#e8eaf6' : '#666',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer',
                letterSpacing: '0.04em',
                transition: 'all 0.2s',
              }}
            >
              🔬 {showComparison ? 'Hide Comparison' : 'Compare Backend'}
            </button>
            <button className="active-effects-collapse-btn">
              {isCollapsed ? '▼' : '▲'}
            </button>
          </div>
        </div>
      </div>

      {!isCollapsed && (
        <>
          <div className="active-effects-data-source">
            📊 Real-time IOB/MOB from unified context calculation
          </div>

          <div className="active-effects-layout">
            {/* Left Column: IOB and MOB */}
            <div className="active-effects-left-column">
              {/* IOB Card */}
              <div className="active-effects-summary-card active-effects-clickable"
                style={{ borderTop: '3px solid #9c27b0' }}
                onClick={() => setExpandedSection(expandedSection === 'iob' ? null : 'iob')}>
                <div className="active-effects-card-header">
                  <span className="active-effects-icon">💉</span>
                  <span className="active-effects-card-title">Insulin On Board</span>
                </div>
                <div className="active-effects-card-value" style={{ color: '#7b1fa2' }}>
                  {displayIobValue.toFixed(2)} units
                </div>
                <div className="active-effects-card-subtext">
                  {displayIobContributions.length || 0} active dose{displayIobContributions.length !== 1 ? 's' : ''}
                </div>

                {/* Show cumulative BG reduction (ABSORBED insulin) */}
                {netEffectData && netEffectData.insulinImpact > 0 && (
                  <div className="active-effects-impact active-effects-impact-current">
                    <span style={{ fontWeight: 700, color: '#7b1fa2' }}>✅ -{Math.round(netEffectData.insulinImpact)} mg/dL current</span>
                    <div className="active-effects-impact-subtext">
                      From absorbed insulin (PAST→PRESENT)
                    </div>
                  </div>
                )}

                {/* Show pending BG reduction from IOB */}
                {netEffectData && netEffectData.pendingInsulinReduction > 0 && (
                  <div className="active-effects-impact active-effects-impact-pending">
                    <span style={{ fontWeight: 700, color: '#ab47bc' }}>⏳ -{Math.round(netEffectData.pendingInsulinReduction)} mg/dL pending</span>
                    <div className="active-effects-impact-subtext">
                      From IOB ({displayIobValue.toFixed(1)}u) — PRESENT→FUTURE
                    </div>
                  </div>
                )}
              </div>

              {/* MOB Card */}
              <div className="active-effects-summary-card active-effects-clickable"
                style={{ borderTop: '3px solid #4caf50' }}
                onClick={() => setExpandedSection(expandedSection === 'mob' ? null : 'mob')}>
                <div className="active-effects-card-header">
                  <span className="active-effects-icon">🍽️</span>
                  <span className="active-effects-card-title">Meal On Board (MOB)</span>
                </div>
                <div className="active-effects-card-value" style={{ color: '#2e7d32' }}>
                  {displayMobValue.toFixed(1)}g
                </div>
                <div className="active-effects-card-subtext-small">
                  Still digesting • Future BG rise
                </div>
                <div className="active-effects-card-subtext">
                  {activeEffects?.mob?.active_meals_count || 0} active meal{activeEffects?.mob?.active_meals_count !== 1 ? 's' : ''}
                </div>

                {/* Show ABSORBED carbs causing CURRENT elevation */}
                {netEffectData && netEffectData.mealImpact > 0 && (
                  <div className="active-effects-impact active-effects-impact-current-meal">
                    <span style={{ fontWeight: 700, color: '#2e7d32' }}>✅ +{Math.round(netEffectData.mealImpact)} mg/dL current</span>
                    <div className="active-effects-impact-subtext">
                      From absorbed carbs (PAST→PRESENT)
                    </div>
                  </div>
                )}

                {/* Show PENDING rise from remaining MOB */}
                {netEffectData && netEffectData.pendingMealRise > 0 && (
                  <div className="active-effects-impact active-effects-impact-pending-meal">
                    <span style={{ fontWeight: 700, color: '#f57f17' }}>⏳ +{Math.round(netEffectData.pendingMealRise)} mg/dL pending</span>
                    <div className="active-effects-impact-subtext">
                      From MOB ({displayMobValue.toFixed(1)}g) — PRESENT→FUTURE
                    </div>
                  </div>
                )}
              </div>

              {/* Timing Assessment Card — in left column */}
              {(() => {
                const pendingMealRise         = netEffectData?.pendingMealRise         || 0;
                const pendingInsulinReduction = netEffectData?.pendingInsulinReduction || 0;
                const netPending              = pendingMealRise - pendingInsulinReduction;

                const assessment = getProjectedAssessment(
                  displayIobValue,
                  displayMobValue,
                  pendingMealRise,
                  pendingInsulinReduction,
                  netEffectData?.currentEstimatedBG ?? null,
                );

                return (
                  <div className="active-effects-assessment" style={{
                    backgroundColor: assessment.cardBg,
                    borderColor: assessment.borderColor,
                  }}>
                    <div className="active-effects-assessment-header">
                      <span className="active-effects-assessment-icon">{assessment.icon}</span>
                      <strong style={{ color: assessment.titleColor }}>{assessment.title}</strong>
                    </div>

                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '6px 0' }}>
                      {displayIobValue > 0 && (
                        <span style={{
                          background: '#9C27B020', border: '1px solid #9C27B0',
                          borderRadius: '12px', padding: '2px 10px',
                          fontSize: '12px', color: '#9C27B0', fontWeight: 600,
                        }}>
                          💉 {displayIobValue.toFixed(1)}u IOB
                        </span>
                      )}
                      {displayMobValue > 0 && (
                        <span style={{
                          background: '#FF980020', border: '1px solid #FF9800',
                          borderRadius: '12px', padding: '2px 10px',
                          fontSize: '12px', color: '#FF9800', fontWeight: 600,
                        }}>
                          🍽️ {Math.round(displayMobValue)}g MOB
                        </span>
                      )}
                    </div>

                    <div className="active-effects-recommendation">
                      {assessment.recommendation}
                    </div>

                    {(pendingMealRise > 0 || pendingInsulinReduction > 0) && (
                      <div style={{
                        marginTop: '8px', paddingTop: '8px',
                        borderTop: '1px solid rgba(0,0,0,0.07)',
                      }}>
                        <div style={{ fontSize: '11px', color: '#999', marginBottom: '4px' }}>
                          Projected net pending effect
                        </div>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 600, color: '#FF9800' }}>▲ +{Math.round(pendingMealRise)} mg/dL</span>
                          <span style={{ color: '#999' }}>vs</span>
                          <span style={{ fontWeight: 600, color: '#9C27B0' }}>▼ −{Math.round(pendingInsulinReduction)} mg/dL</span>
                          <span style={{
                            fontWeight: 700,
                            color: netPending > 5 ? '#FF9800' : netPending < -5 ? '#9C27B0' : '#4CAF50',
                          }}>
                            = {netPending > 0 ? '+' : ''}{Math.round(netPending)} net
                          </span>
                        </div>
                        {netEffectData?.projectedFinalBG != null && (
                          <div style={{ fontSize: '11px', color: '#666', marginTop: '4px' }}>
                            Projected final BG ≈{' '}
                            <strong style={{
                              color: netEffectData.projectedFinalBG < 70 ? '#F44336'
                                   : netEffectData.projectedFinalBG > 180 ? '#FF9800'
                                   : '#4CAF50',
                            }}>
                              {Math.round(netEffectData.projectedFinalBG)} mg/dL
                            </strong>
                          </div>
                        )}
                      </div>
                    )}

                    {timingAssessment?.warning && (
                      <div className="active-effects-warning">{timingAssessment.warning}</div>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* Right Column: Net Effect - T1D Version */}
            {showNetEffect && netEffectData && (
              <div className="active-effects-right-column">
                <div className="active-effects-net-effect">
                  <div className="active-effects-card-header">
                    <span className="active-effects-icon">⚖️</span>
                    <span className="active-effects-card-title">T1D Net Effect Analysis</span>
                  </div>

                  {/* Current Estimated BG - Primary Display */}
                  <div className="active-effects-estimated-bg">
                    <div className="active-effects-label-main">
                      Current Estimated Blood Sugar
                    </div>
                    <div className="active-effects-value-main" style={{
                      color: netEffectData.currentEstimatedBG > effectiveTargetGlucose * 1.3 ? '#ff4444' :
                             netEffectData.currentEstimatedBG < effectiveTargetGlucose * 0.7 ? '#ff8800' : '#4CAF50'
                    }}>
                      {netEffectData.currentEstimatedBG || netEffectData.projected} mg/dL
                    </div>
                    <div className="active-effects-status" style={{
                      color: getStatusColor(netEffectData.projectedEffect)
                    }}>
                      {getStatusText(netEffectData.projectedEffect)}
                      <span className="active-effects-status-value">
                        ({netEffectData.projectedEffect > 0 ? '+' : ''}{netEffectData.projectedEffect} mg/dL from baseline)
                      </span>
                    </div>
                  </div>

                  {/* T1D Baseline - Stable Value */}
                  <div className="active-effects-baseline-box">
                    <div className="active-effects-baseline-label">
                      T1D STABLE BASELINE
                    </div>
                    <div className="active-effects-baseline-value">
                      {netEffectData.baseline} mg/dL
                    </div>
                    <div className="active-effects-baseline-subtext">
                      Metabolic state (no decay) • Confidence: {netEffectData.confidence || 'unknown'}
                    </div>
                  </div>

                  {/* Actual Reading (if different from baseline) */}
                  {netEffectData.actualReading && netEffectData.actualReading !== netEffectData.baseline && (
                    <div className="active-effects-actual-reading">
                      <span className="active-effects-actual-reading-label">📱 Last meter reading: </span>
                      <strong>{netEffectData.actualReading} mg/dL</strong>
                      {netEffectData.lastReadingTime && (
                        <span className="active-effects-actual-reading-time">
                          ({moment(netEffectData.lastReadingTime).fromNow()})
                        </span>
                      )}
                    </div>
                  )}

                  {/* Effect Breakdown */}
                  <div className="active-effects-breakdown">
                    {/* Current BG Elevation from Absorbed Carbs */}
                    <div className="active-effects-breakdown-item active-effects-breakdown-carbs-absorbed">
                      <span className="active-effects-breakdown-label">
                        ✅ Current BG Elevation
                        <div className="active-effects-breakdown-sublabel">
                          PAST→PRESENT: Absorbed carbs in bloodstream
                        </div>
                      </span>
                      <span className="active-effects-breakdown-value active-effects-breakdown-value-positive">
                        +{netEffectData.mealImpact} mg/dL
                      </span>
                    </div>

                    {/* Pending BG Rise from MOB */}
                    {netEffectData.pendingMealRise > 0 && (
                      <div className="active-effects-breakdown-item active-effects-breakdown-carbs-pending">
                        <span className="active-effects-breakdown-label">
                          ⏳ Pending BG Rise
                          <div className="active-effects-breakdown-sublabel">
                            PRESENT→FUTURE: MOB ({displayMobValue.toFixed(1)}g still digesting)
                          </div>
                        </span>
                        <span className="active-effects-breakdown-value active-effects-breakdown-value-warning">
                          +{Math.round(netEffectData.pendingMealRise)} mg/dL
                        </span>
                      </div>
                    )}

                    {/* Current BG Reduction from Absorbed Insulin */}
                    {netEffectData && netEffectData.insulinImpact > 0 && (
                      <div className="active-effects-breakdown-item active-effects-breakdown-insulin-absorbed">
                        <span className="active-effects-breakdown-label">
                          ✅ Current BG Reduction
                          <div className="active-effects-breakdown-sublabel">
                            PAST→PRESENT: Absorbed insulin has acted
                          </div>
                        </span>
                        <span className="active-effects-breakdown-value active-effects-breakdown-value-reduction">
                          -{netEffectData.insulinImpact} mg/dL
                        </span>
                      </div>
                    )}

                    {/* Pending BG Reduction from IOB */}
                    {netEffectData && netEffectData.pendingInsulinReduction > 0 && (
                      <div className="active-effects-breakdown-item active-effects-breakdown-insulin-pending">
                        <span className="active-effects-breakdown-label">
                          ⏳ Pending BG Reduction
                          <div className="active-effects-breakdown-sublabel">
                            From IOB ({displayIobValue.toFixed(2)}u still active)
                          </div>
                        </span>
                        <span className="active-effects-breakdown-value active-effects-breakdown-value-pending-reduction">
                          -{netEffectData.pendingInsulinReduction} mg/dL
                        </span>
                      </div>
                    )}

                    {/* Net Effect */}
                    <div className="active-effects-breakdown-net">
                      <span>Current Net Effect</span>
                      <span style={{ color: netEffectData.projectedEffect > 0 ? '#FF9800' : '#4CAF50' }}>
                        {netEffectData.projectedEffect > 0 ? '+' : ''}{netEffectData.projectedEffect} mg/dL
                      </span>
                    </div>

                    {/* Previous Cumulative Effect */}
                    <div className="active-effects-breakdown-item active-effects-breakdown-previous-cumulative" style={{
                      backgroundColor: '#f0f9ff',
                      borderLeft: '4px solid #2196F3',
                      marginTop: '12px'
                    }}>
                      <span className="active-effects-breakdown-label">
                        📊 Previous Cumulative Effect
                        <div className="active-effects-breakdown-sublabel">
                          Net effect from previous meals/insulin (before current activity)
                        </div>
                      </span>
                      <span className="active-effects-breakdown-value" style={{
                        color: ((netEffectData.cumulativeMealEffect || 0) - (netEffectData.mealImpact || 0)) -
                               Math.abs((netEffectData.cumulativeInsulinEffect || 0) + (netEffectData.insulinImpact || 0)) > 0 ? '#FF9800' : '#4CAF50',
                        fontWeight: '600'
                      }}>
                        {(() => {
                          const previousMeal = (netEffectData.cumulativeMealEffect || 0) - (netEffectData.mealImpact || 0);
                          const previousInsulin = Math.abs((netEffectData.cumulativeInsulinEffect || 0) + (netEffectData.insulinImpact || 0));
                          const previousNet = previousMeal - previousInsulin;
                          return (previousNet > 0 ? '+' : '') + Math.round(previousNet);
                        })()} mg/dL
                      </span>
                    </div>

                    {/* Net Cumulative Effect (Previous + Current) */}
                    <div className="active-effects-breakdown-item active-effects-breakdown-net-cumulative" style={{
                      backgroundColor: '#e8f5e9',
                      borderLeft: '4px solid #4CAF50',
                      marginTop: '8px'
                    }}>
                      <span className="active-effects-breakdown-label">
                        📈 Net Cumulative Effect
                        <div className="active-effects-breakdown-sublabel">
                          Total effect (Previous + Current) = {(() => {
                            const previousMeal = (netEffectData.cumulativeMealEffect || 0) - (netEffectData.mealImpact || 0);
                            const previousInsulin = Math.abs((netEffectData.cumulativeInsulinEffect || 0) + (netEffectData.insulinImpact || 0));
                            const previousNet = previousMeal - previousInsulin;
                            return `(${previousNet > 0 ? '+' : ''}${Math.round(previousNet)}) + (${netEffectData.projectedEffect > 0 ? '+' : ''}${netEffectData.projectedEffect})`;
                          })()}
                        </div>
                      </span>
                      <span className="active-effects-breakdown-value" style={{
                        color: (netEffectData.cumulativeMealEffect || 0) - Math.abs(netEffectData.cumulativeInsulinEffect || 0) > 0 ? '#FF6B00' : '#2E7D32',
                        fontWeight: '700',
                        fontSize: '16px'
                      }}>
                        {(() => {
                          const netCumulative = (netEffectData.cumulativeMealEffect || 0) - Math.abs(netEffectData.cumulativeInsulinEffect || 0);
                          return (netCumulative > 0 ? '+' : '') + Math.round(netCumulative);
                        })()} mg/dL
                      </span>
                    </div>

                    {/* Show projected final BG if there's pending insulin */}
                    {netEffectData && netEffectData.pendingInsulinReduction > 0 && (
                      <div className="active-effects-breakdown-projected" style={{ marginTop: '12px' }}>
                        <span>
                          Projected Final BG
                          <div className="active-effects-breakdown-sublabel">
                            After IOB acts completely
                          </div>
                        </span>
                        <span className="active-effects-breakdown-value-projected">
                          {netEffectData.projectedFinalBG} mg/dL
                        </span>
                      </div>
                    )}
                  </div>

{/* ✅ T1D Calculation - COLLAPSIBLE */}
<div style={{ marginTop: '12px' }}>
  <button
    onClick={() => setShowT1DExplainer(prev => !prev)}
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      width: '100%',
      padding: '10px 14px',
      backgroundColor: '#f5f5f5',
      border: '1px solid #ddd',
      borderRadius: showT1DExplainer ? '8px 8px 0 0' : '8px',
      cursor: 'pointer',
      fontSize: '13px',
      fontWeight: 700,
      color: '#1976D2',
      textAlign: 'left',
      transition: 'background 0.2s',
    }}
  >
    <span>📊 T1D Model Explained</span>
    <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#888' }}>
      {showT1DExplainer ? '▲ Hide' : '▼ Show'}
    </span>
  </button>

  {showT1DExplainer && (
<div className="active-effects-calculation">

  {/* ========== CURRENT VALUES (What matters NOW) ========== */}

  {/* Current BG Estimate */}
  <div className="active-effects-calc-step">
    <div className="active-effects-calc-step-header">
      <strong>Current Blood Sugar Estimate:</strong> {netEffectData.currentEstimatedBG} mg/dL
    </div>
    <div className="active-effects-calc-formula">
      <span>{netEffectData.baseline}</span>
      <span className="active-effects-calc-unit">(baseline)</span>
      <span className="active-effects-calc-op">+</span>
      <span className="active-effects-calc-detail">
        {(netEffectData.cumulativeMealEffect || 0).toFixed(1)}
      </span>
      <span className="active-effects-calc-unit">(cumulative meal)</span>
      <span className="active-effects-calc-op">−</span>
      <span className="active-effects-calc-detail">
        {Math.abs(netEffectData.cumulativeInsulinEffect || 0).toFixed(1)}
      </span>
      <span className="active-effects-calc-unit">(cumulative insulin)</span>
      <span className="active-effects-calc-op">=</span>
      <strong style={{
        color: netEffectData.currentEstimatedBG > effectiveTargetGlucose * 1.3 ? '#ff4444' :
               netEffectData.currentEstimatedBG < effectiveTargetGlucose * 0.7 ? '#ff8800' : '#4CAF50'
      }}>
        {netEffectData.currentEstimatedBG}
      </strong>
      <span className="active-effects-calc-unit">mg/dL</span>
    </div>

    {/* Breakdown of cumulative effects */}
    <div className="active-effects-calc-note" style={{ fontSize: '11px', marginTop: '8px', padding: '8px', backgroundColor: '#e8f5e9', borderRadius: '4px' }}>
      <strong>Cumulative Effect Breakdown:</strong>
      <div style={{ marginTop: '6px', paddingLeft: '8px' }}>
        <div style={{ fontSize: '10px', marginBottom: '4px' }}>
          🍽️ <strong>Meal Effect:</strong> {(netEffectData.cumulativeMealEffect || 0).toFixed(1)} mg/dL
          <span style={{ fontSize: '9px', color: '#666', marginLeft: '8px' }}>
            = Previous ({((netEffectData.cumulativeMealEffect || 0) - (netEffectData.mealImpact || 0)).toFixed(1)}) + Current (+{(netEffectData.mealImpact || 0).toFixed(1)})
          </span>
        </div>
        <div style={{ fontSize: '10px' }}>
          💉 <strong>Insulin Effect:</strong> {Math.abs(netEffectData.cumulativeInsulinEffect || 0).toFixed(1)} mg/dL
          <span style={{ fontSize: '9px', color: '#666', marginLeft: '8px' }}>
            = Previous ({Math.abs((netEffectData.cumulativeInsulinEffect || 0) + (netEffectData.insulinImpact || 0)).toFixed(1)}) + Current (−{(netEffectData.insulinImpact || 0).toFixed(1)})
          </span>
        </div>
      </div>
    </div>
  </div>

  {/* Current Activity (Rate of Change NOW) */}
  <div className="active-effects-calc-note" style={{ fontSize: '12px', marginTop: '8px', padding: '8px', backgroundColor: '#fff9e6', borderRadius: '4px', borderLeft: '3px solid #ff9800' }}>
    <strong>⚡ Current Activity (Rate of Change):</strong>
    <div style={{ marginTop: '6px', paddingLeft: '8px', fontSize: '11px' }}>
      <div style={{ marginBottom: '4px' }}>
        🍽️ Meal: <strong style={{ color: '#ff9800' }}>+{(netEffectData.mealImpact || 0).toFixed(1)} mg/dL</strong>
        <span style={{ fontSize: '10px', color: '#666', marginLeft: '8px' }}>
          - Absorbed: {(netEffectData.absorbedCarbs || 0).toFixed(1)}g
        </span>
      </div>
      <div>
        💉 Insulin: <strong style={{ color: '#9c27b0' }}>-{(netEffectData.insulinImpact || 0).toFixed(1)} mg/dL</strong>
        <span style={{ fontSize: '10px', color: '#666', marginLeft: '8px' }}>
          - Absorbed: {(netEffectData.absorbedInsulin || 0).toFixed(2)}u
        </span>
      </div>
    </div>
  </div>

  {/* Current Active Amounts (MOB/IOB) */}
  {((netEffectData.activeMOB || 0) > 0 || (netEffectData.activeIOB || 0) > 0) && (
    <div className="active-effects-calc-note" style={{ fontSize: '12px', marginTop: '8px', padding: '8px', backgroundColor: '#fff9e6', borderRadius: '4px' }}>
      <strong>Still Active (NOW):</strong>
      {(netEffectData.activeMOB || 0) > 0 && (
        <div style={{ marginTop: '4px' }}>
          • MOB: {(netEffectData.activeMOB || 0).toFixed(1)}g → pending +{Math.round(netEffectData.pendingMealRise || 0)} mg/dL
        </div>
      )}
      {(netEffectData.activeIOB || 0) > 0 && (
        <div>
          • IOB: {(netEffectData.activeIOB || 0).toFixed(2)}u → pending −{Math.round(netEffectData.pendingInsulinReduction || 0)} mg/dL
        </div>
      )}
    </div>
  )}

  {/* ========== BASELINE CALCULATION (How we got the starting point) ========== */}

  {netEffectData.actualReading && netEffectData.source !== 'target_fallback' && (
    <div className="active-effects-calc-step" style={{ marginTop: '16px', borderTop: '2px solid #e0e0e0', paddingTop: '12px' }}>
      <div className="active-effects-calc-step-header">
        <strong>Baseline Calculation</strong> (from last reading)
        {netEffectData.minutesSinceReading > 360 && (
          <span style={{ fontSize: '10px', color: '#e65100', fontWeight: 'normal', marginLeft: '8px' }}>
            ⚠️ stale — used with low confidence
          </span>
        )}
        {netEffectData.lastReadingTime && (
          <div style={{ fontSize: '10px', color: '#999', fontWeight: 'normal', marginTop: '2px' }}>
            📱 Reading taken: <TimestampDisplay timestamp={netEffectData.lastReadingTime} />
          </div>
        )}
      </div>
      <div className="active-effects-calc-formula">
        <span>{netEffectData.actualReading}</span>
        <span className="active-effects-calc-unit">(reading)</span>
        <span className="active-effects-calc-op">−</span>
        <span className="active-effects-calc-detail">
          ({netEffectData.mealImpactAtReading > 0 ? '+' : ''}{netEffectData.mealImpactAtReading || 0} meal − {netEffectData.insulinImpactAtReading || 0} insulin)
        </span>
        <span className="active-effects-calc-op">=</span>
        <strong>{netEffectData.baseline}</strong>
        <span className="active-effects-calc-unit">mg/dL baseline</span>
      </div>

      {/* Absorbed at reading time */}
      <div className="active-effects-calc-note" style={{ fontSize: '11px', color: '#666', marginTop: '4px' }}>
        ✅ At reading time: {(netEffectData.absorbedCarbsAtReading || 0).toFixed(1)}g carbs absorbed
        {netEffectData.mealContributionsAtReading?.length > 0 && (
          <span style={{ fontSize: '9px', color: '#999' }}>
            {' '}(from {netEffectData.mealContributionsAtReading.length} meal{netEffectData.mealContributionsAtReading.length !== 1 ? 's' : ''})
          </span>
        )}
        , {(netEffectData.absorbedInsulinAtReading || 0).toFixed(2)}u insulin absorbed
        {netEffectData.insulinContributionsAtReading?.length > 0 && (
          <span style={{ fontSize: '9px', color: '#999' }}>
            {' '}(from {netEffectData.insulinContributionsAtReading.length} dose{netEffectData.insulinContributionsAtReading.length !== 1 ? 's' : ''})
          </span>
        )}
      </div>

      {/* Meal details at reading */}
      {netEffectData.mealContributionsAtReading?.length > 0 && (
        <div className="active-effects-calc-note" style={{
          fontSize: '10px',
          color: '#666',
          marginTop: '6px',
          paddingLeft: '10px',
          borderLeft: '3px solid #4CAF50'
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: '3px', color: '#2E7D32' }}>
            🍽️ Meals at reading time:
          </div>
          {netEffectData.mealContributionsAtReading.map((meal, idx) => {
            const mealTimestamp = netEffectData.lastReadingTime - (meal.hoursSinceMeal * 3600000);
            return (
              <div key={idx} style={{ marginBottom: '3px', paddingLeft: '8px' }}>
                • {meal.totalCarbs}g at <TimestampDisplay timestamp={mealTimestamp} />
                <span style={{ fontSize: '9px', color: '#999', paddingLeft: '4px' }}>
                  (absorbed: {meal.absorbedCarbs.toFixed(1)}g, MOB: {meal.mob.toFixed(1)}g)
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Insulin details at reading */}
      {netEffectData.insulinContributionsAtReading?.length > 0 && (
        <div className="active-effects-calc-note" style={{
          fontSize: '10px',
          color: '#666',
          marginTop: '4px',
          paddingLeft: '10px',
          borderLeft: '3px solid #2196F3'
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: '3px', color: '#1565C0' }}>
            💉 Insulin at reading time:
          </div>
          {netEffectData.insulinContributionsAtReading.map((insulin, idx) => {
            const doseTimestamp = netEffectData.lastReadingTime - (insulin.hoursSinceDose * 3600000);
            return (
              <div key={idx} style={{ marginBottom: '3px', paddingLeft: '8px' }}>
                • {insulin.initialDose}u {insulin.insulinType.replace('insulin_', '')} at <TimestampDisplay timestamp={doseTimestamp} />
                <span style={{ fontSize: '9px', color: '#999', paddingLeft: '4px' }}>
                  (absorbed: {insulin.absorbedInsulin.toFixed(2)}u, IOB: {insulin.iob.toFixed(2)}u)
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  )}

  {/* Warning when reading is stale — two distinct cases */}

  {/* Case 1: Reading > 6h old but still within today's daily period (reading is used, just stale) */}
  {netEffectData.minutesSinceReading > 360 && netEffectData.source !== 'target_fallback' && (
    <div className="active-effects-calc-step" style={{
      backgroundColor: '#fff3e0',
      padding: '12px',
      borderRadius: '8px',
      borderLeft: '4px solid #ff9800',
      marginTop: '16px'
    }}>
      <div className="active-effects-calc-step-header" style={{ color: '#e65100' }}>
        ⚠️ Reading Too Old — Using With Reduced Confidence
      </div>
      <div className="active-effects-calc-note" style={{ fontSize: '12px', color: '#666', marginTop: '8px' }}>
        Last reading: {netEffectData.actualReading} mg/dL ({Math.floor(netEffectData.minutesSinceReading / 60)}h {Math.round(netEffectData.minutesSinceReading % 60)}m ago)
      </div>
      <div className="active-effects-calc-note" style={{ fontSize: '11px', color: '#888', marginTop: '6px' }}>
        📐 Baseline is <strong>still derived from this reading</strong> (matches backend behaviour).
        Accuracy is reduced because more time has passed since the anchor reading.
      </div>
      <div className="active-effects-calc-note" style={{ fontSize: '11px', color: '#999', marginTop: '4px', fontStyle: 'italic' }}>
        💡 Take a new reading for a more accurate baseline.
      </div>
    </div>
  )}

  {/* Case 2: Reading is from a previous daily period — target_glucose fallback used */}
  {netEffectData.source === 'target_fallback' && (
    <div className="active-effects-calc-step" style={{
      backgroundColor: '#fce4ec',
      padding: '12px',
      borderRadius: '8px',
      borderLeft: '4px solid #e91e63',
      marginTop: '16px'
    }}>
      <div className="active-effects-calc-step-header" style={{ color: '#c62828' }}>
        ⚠️ No Reading in Current Daily Period
      </div>
      <div className="active-effects-calc-note" style={{ fontSize: '12px', color: '#666', marginTop: '8px' }}>
        {netEffectData.actualReading
          ? `Last reading: ${netEffectData.actualReading} mg/dL (${Math.floor(netEffectData.minutesSinceReading / 60)}h ${Math.round(netEffectData.minutesSinceReading % 60)}m ago — before today's reset)`
          : 'No reading found for today.'}
      </div>
      <div className="active-effects-calc-note" style={{ fontSize: '11px', color: '#888', marginTop: '6px' }}>
        📐 Using <strong>target glucose ({effectiveTargetGlucose} mg/dL)</strong> as baseline fallback.
        This is a rough estimate only.
      </div>
      <div className="active-effects-calc-note" style={{ fontSize: '11px', color: '#999', marginTop: '4px', fontStyle: 'italic' }}>
        💡 Take a new reading to anchor an accurate baseline for today.
      </div>
    </div>
  )}

  {/* ========== COMPARISON: Reading Time vs Now ========== */}

  {netEffectData.actualReading && netEffectData.source !== 'target_fallback' && (
    <div className="active-effects-calc-note" style={{
      fontSize: '11px',
      marginTop: '16px',
      padding: '10px',
      backgroundColor: '#e8f5e9',
      borderRadius: '6px',
      borderLeft: '3px solid #4CAF50'
    }}>
      <div style={{ fontWeight: 'bold', marginBottom: '6px', color: '#2e7d32' }}>
        📊 Change Since Reading ({
          netEffectData.minutesSinceReading > 120
            ? `${Math.floor(netEffectData.minutesSinceReading / 60)}h ${Math.round(netEffectData.minutesSinceReading % 60)}m ago`
            : `${Math.round(netEffectData.minutesSinceReading)} min ago`
        }):
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '10px' }}>
        <div>
          <strong>At Reading:</strong>
          <div>• {(netEffectData.absorbedCarbsAtReading || 0).toFixed(1)}g carbs absorbed</div>
          <div>• {(netEffectData.absorbedInsulinAtReading || 0).toFixed(2)}u insulin absorbed</div>
        </div>
        <div>
          <strong>Now:</strong>
          <div>• {(netEffectData.absorbedCarbs || 0).toFixed(1)}g carbs absorbed</div>
          <div>• {(netEffectData.absorbedInsulin || 0).toFixed(2)}u insulin absorbed</div>
        </div>
      </div>
      <div style={{ marginTop: '6px', fontSize: '10px', color: '#666' }}>
        <strong>Additional absorption:</strong> +{((netEffectData.absorbedCarbs || 0) - (netEffectData.absorbedCarbsAtReading || 0)).toFixed(1)}g carbs,
        +{((netEffectData.absorbedInsulin || 0) - (netEffectData.absorbedInsulinAtReading || 0)).toFixed(2)}u insulin
      </div>
    </div>
  )}

  {/* ========== FUTURE PROJECTION ========== */}

  {((netEffectData.pendingInsulinReduction || 0) > 0 || (netEffectData.pendingMealRise || 0) > 0) && (
    <div className="active-effects-calc-step" style={{ marginTop: '16px', borderTop: '2px solid #e0e0e0', paddingTop: '12px' }}>
      <div className="active-effects-calc-step-header">
        <strong>Projected Final BG</strong> (after all effects complete)
      </div>
      <div className="active-effects-calc-formula">
        <span>{netEffectData.currentEstimatedBG}</span>
        <span className="active-effects-calc-unit">(current)</span>
        {(netEffectData.pendingMealRise || 0) > 0 && (
          <>
            <span className="active-effects-calc-op">+</span>
            <span className="active-effects-calc-detail">{Math.round(netEffectData.pendingMealRise)}</span>
            <span className="active-effects-calc-unit">(MOB)</span>
          </>
        )}
        {(netEffectData.pendingInsulinReduction || 0) > 0 && (
          <>
            <span className="active-effects-calc-op">−</span>
            <span className="active-effects-calc-detail">{Math.round(netEffectData.pendingInsulinReduction)}</span>
            <span className="active-effects-calc-unit">(IOB)</span>
          </>
        )}
        <span className="active-effects-calc-op">=</span>
        <strong style={{
          color: netEffectData.projectedFinalBG > effectiveTargetGlucose * 1.3 ? '#ff4444' :
                 netEffectData.projectedFinalBG < effectiveTargetGlucose * 0.7 ? '#ff8800' : '#4CAF50'
        }}>
          {netEffectData.projectedFinalBG}
        </strong>
        <span className="active-effects-calc-unit">mg/dL</span>
      </div>
    </div>
  )}

  {/* ========== TECHNICAL DETAILS (Cumulative vs Instantaneous) ========== */}

  <div className="active-effects-calc-note" style={{
    fontSize: '11px',
    color: '#666',
    marginTop: '16px',
    padding: '10px',
    backgroundColor: '#f0f9ff',
    borderRadius: '6px',
    borderLeft: '3px solid #2196F3'
  }}>
    <div style={{ fontWeight: 'bold', marginBottom: '6px', color: '#1976D2' }}>
      💡 Understanding the Numbers:
    </div>
    <div style={{ paddingLeft: '8px', fontSize: '10px' }}>
      <div style={{ marginBottom: '6px' }}>
        <strong>Cumulative Effects</strong> (Total absorbed - persists in bloodstream):
        <div style={{ paddingLeft: '12px', marginTop: '2px' }}>
          • Meal: {(netEffectData.cumulativeMealEffect || 0).toFixed(1)} mg/dL = Previous ({((netEffectData.cumulativeMealEffect || 0) - (netEffectData.mealImpact || 0)).toFixed(1)}) + Current ({(netEffectData.mealImpact || 0).toFixed(1)})
        </div>
        <div style={{ paddingLeft: '12px' }}>
          • Insulin: {Math.abs(netEffectData.cumulativeInsulinEffect || 0).toFixed(1)} mg/dL = Previous ({Math.abs((netEffectData.cumulativeInsulinEffect || 0) + (netEffectData.insulinImpact || 0)).toFixed(1)}) + Current ({(netEffectData.insulinImpact || 0).toFixed(1)})
        </div>
      </div>
      <div>
        <strong>Current Activity</strong> (Rate of change happening NOW):
        <div style={{ paddingLeft: '12px', marginTop: '2px' }}>
          • Meal: +{(netEffectData.mealImpact || 0).toFixed(1)} mg/dL (from recent absorption)
        </div>
        <div style={{ paddingLeft: '12px' }}>
          • Insulin: -{(netEffectData.insulinImpact || 0).toFixed(1)} mg/dL (from recent absorption)
        </div>
      </div>
    </div>
  </div>

  {/* ========== KEY CONCEPTS ========== */}

  <div className="active-effects-calc-notes" style={{ marginTop: '12px' }}>
    <div className="active-effects-calc-note">
      📝 <strong>Baseline:</strong> Your metabolic state without active effects (stays stable)
    </div>
    <div className="active-effects-calc-note">
      🍽️ <strong>Absorbed carbs:</strong> In bloodstream now, causing current BG elevation
    </div>
    <div className="active-effects-calc-note">
      💉 <strong>Absorbed insulin:</strong> Already acted, caused permanent BG reduction
    </div>
    <div className="active-effects-calc-note">
      ⏳ <strong>MOB/IOB:</strong> Still working, will cause future BG changes
    </div>
  </div>
</div>

  )}
</div>

                </div>
              </div>
            )}
          </div>

{/* IOB Details Section */}
          {showDetails && expandedSection === 'iob' && displayIobContributions.length > 0 && (
            <div className="active-effects-details">
              <h4 className="active-effects-details-title">
                💉 Insulin On Board - Pharmacodynamic Timeline
              </h4>

              {/* Summary Box */}
              <div className="active-effects-iob-summary-box">
                <div className="active-effects-iob-summary-title">
                  📊 T1D Insulin Model - Cumulative BG Reduction
                </div>
                <div className="active-effects-iob-summary-content">
                  <div className="active-effects-iob-summary-line">
                    <strong>✅ Absorbed Insulin:</strong> {((activeEffects?.iob?.total_active_insulin || 0) * 2).toFixed(2)}u
                    → <span className="active-effects-iob-summary-value-absorbed">
                      -{netEffectData?.insulinImpact || 0} mg/dL
                    </span> (cumulative reduction)
                  </div>
                  <div className="active-effects-iob-summary-line">
                    <strong>⏳ IOB (Active):</strong> {(activeEffects?.iob?.total_active_insulin || 0).toFixed(2)}u
                    → <span className="active-effects-iob-summary-value-pending">
                      -{netEffectData?.pendingInsulinReduction || 0} mg/dL
                    </span> pending
                  </div>
                  <div className="active-effects-iob-summary-note">
                    <strong>Key Difference from Meals:</strong> Absorbed insulin = PAST BG reduction (permanent, doesn't decay).
                    Only carbs can raise BG back up. IOB = FUTURE reduction still coming.
                  </div>
                </div>
              </div>

              {/* Stacking Warning Banner */}
              {activeEffects?.iob?.stacking_analysis?.severity?.level &&
               ['high', 'severe', 'critical'].includes(activeEffects.iob.stacking_analysis.severity.level) && (
                <div className="active-effects-stacking-warning">
                  <div className="active-effects-stacking-warning-title">
                    ⚠️ INSULIN STACKING DETECTED - {activeEffects.iob.stacking_analysis.severity.level.toUpperCase()} RISK
                  </div>
                  <div className="active-effects-stacking-warning-factors">
                    {activeEffects.iob.stacking_analysis.severity.factors?.join(' • ')}
                  </div>
                  {activeEffects.iob.stacking_analysis.recommendations?.[0] && (
                    <div className="active-effects-stacking-warning-recommendation">
                      → {activeEffects.iob.stacking_analysis.recommendations[0].message}
                    </div>
                  )}
                </div>
              )}

              {/* Enhanced Stacking Analysis from New System */}
              {activeEffects?.stacking && activeEffects.stacking.isStacking && (
                <div className="active-effects-stacking-enhanced" style={{
                  backgroundColor: activeEffects.stacking.riskLevel === 'critical' ? '#ffebee' :
                                  activeEffects.stacking.riskLevel === 'severe' ? '#fff3e0' :
                                  activeEffects.stacking.riskLevel === 'high' ? '#fff9c4' : '#f5f5f5',
                  borderLeftColor: activeEffects.stacking.riskLevel === 'critical' ? '#c62828' :
                                   activeEffects.stacking.riskLevel === 'severe' ? '#ef6c00' :
                                   activeEffects.stacking.riskLevel === 'high' ? '#f57f17' : '#9e9e9e'
                }}>
                  <div className="active-effects-stacking-enhanced-title">
                    🔬 Enhanced Stacking Analysis
                  </div>
                  <div className="active-effects-stacking-enhanced-risk">
                    <strong>Risk Level:</strong> {activeEffects.stacking.riskLevel.toUpperCase()}
                    <span className="active-effects-stacking-enhanced-score">
                      (Score: {activeEffects.stacking.riskScore}/100)
                    </span>
                  </div>
                  {activeEffects.stacking.peakOverlap > 0 && (
                    <div className="active-effects-stacking-enhanced-overlap">
                      ⚠️ {activeEffects.stacking.peakOverlap} dose(s) at peak simultaneously
                    </div>
                  )}
                  <div className="active-effects-stacking-enhanced-grid">
                    <div>
                      <strong>Rapid-Acting IOB:</strong> {activeEffects.stacking.rapidActingIOB?.toFixed(2) || 0}u
                    </div>
                    <div>
                      <strong>Long-Acting IOB:</strong> {activeEffects.stacking.longActingIOB?.toFixed(2) || 0}u
                    </div>
                  </div>
                  {activeEffects.stacking.recommendations && activeEffects.stacking.recommendations.length > 0 && (
                    <div className="active-effects-stacking-enhanced-recommendation">
                      💡 {activeEffects.stacking.recommendations[0].message}
                    </div>
                  )}
                </div>
              )}

              {/* Individual Dose Contributions */}
              {displayIobContributions.map((contrib, idx) => {
                // Get pharmacokinetics data from new system
                const pharma = contrib.pharmacokinetics || {};
                const onset = pharma.onset_hours || DEFAULT_PHARMA.onset;
                const peak = pharma.peak_hours || pharma.peak || DEFAULT_PHARMA.peak;
                const duration = pharma.duration_hours || pharma.duration || DEFAULT_PHARMA.duration;
                const isPeakless = pharma.is_peakless || pharma.type === 'long_acting' || pharma.type === 'ultra_long';
                const curveType = pharma.curve_type || 'gamma_standard';

                // Calculate time points
                // Try multiple field name variants (snake_case and camelCase),
                // then fall back to computing from a timestamp if available.
                // Use ?? (nullish coalescing) so a legitimate 0 is preserved.
                const hoursElapsed =
                  contrib.hours_since_dose ??
                  contrib.hoursSinceDose ??
                  contrib.hours_elapsed ??
                  (contrib.timestamp
                    ? (Date.now() - contrib.timestamp) / 3600000
                    : contrib.administered_at
                    ? (Date.now() - new Date(contrib.administered_at).getTime()) / 3600000
                    : 0);
                const durationRemaining = Math.max(0, duration - hoursElapsed);

                // Determine phase
                let currentPhase = '';
                let phaseColor = '#666';
                if (hoursElapsed < onset) {
                  currentPhase = 'Pre-Onset';
                  phaseColor = '#9e9e9e';
                } else if (isPeakless) {
                  if (hoursElapsed < duration * 0.25) {
                    currentPhase = 'Rising';
                    phaseColor = '#ff9800';
                  } else if (hoursElapsed < duration * 0.75) {
                    currentPhase = 'Plateau';
                    phaseColor = '#4caf50';
                  } else {
                    currentPhase = 'Declining';
                    phaseColor = '#2196f3';
                  }
                } else {
                  if (hoursElapsed < peak) {
                    currentPhase = 'Rising to Peak';
                    phaseColor = '#ff9800';
                  } else if (hoursElapsed < peak * 1.5) {
                    currentPhase = 'Peak Activity';
                    phaseColor = '#f44336';
                  } else {
                    currentPhase = 'Declining';
                    phaseColor = '#2196f3';
                  }
                }

                // Calculate percentages for visualization
                const totalDuration = duration;
                const elapsedPercent = Math.min(100, (hoursElapsed / totalDuration) * 100);
                const activePercent = Math.max(0, ((duration - hoursElapsed) / totalDuration) * 100);

                // Get activity metrics from new system
                const activityPercent = contrib.activity_percent || 0;
                const iobValue = contrib.iob || 0;
                const initialDose = contrib.initial_dose || contrib.dose;

                // Calculate absorbed insulin
                const absorbedUnits = initialDose - iobValue;
                const absorbedPercent = (absorbedUnits / initialDose) * 100;

                // Calculate BG impact breakdown
                const correctionFactor = patientConstants?.correction_factor || 50;
                const cumulativeBGReduction = absorbedUnits * correctionFactor;
                const pendingBGReduction = iobValue * correctionFactor;

                // Get medication display name
                const displayName = MEDICATION_NAMES[contrib.medication] || contrib.medication;

                // Curve type description
                const curveDesc = CURVE_DESCRIPTIONS[curveType] || curveType;

                return (
                  <div
                    key={idx}
                    className="active-effects-contribution-card"
                    style={{ borderLeftColor: phaseColor }}
                  >
                    {/* HEADER */}
                    <div className="active-effects-contribution-header">
                      <div>
                        <span className="active-effects-contribution-type">
                          {displayName}
                        </span>
                        <div className="active-effects-contribution-subtype">
                          {curveDesc} • {pharma.type || 'unknown type'}
                        </div>
                      </div>
                      <div className="active-effects-contribution-time-section">
                        <span className="active-effects-contribution-time">
                          {hoursElapsed.toFixed(1)}h ago
                        </span>
                        <div className="active-effects-contribution-phase" style={{ color: phaseColor }}>
                          {currentPhase}
                        </div>
                      </div>
                    </div>

                    {/* PHARMACODYNAMIC CURVE VISUALIZATION */}
                    <div className="active-effects-pharma-visualization">
                      <div className="active-effects-pharma-header">
                        <span>📊 Insulin Activity Curve</span>
                        <span>{activityPercent.toFixed(0)}% active now</span>
                      </div>

                      {/* ACTIVITY CURVE BAR */}
                      <div className="active-effects-curve-bar">
                        {/* ABSORBED (used insulin) */}
                        <div className="active-effects-curve-absorbed" style={{ width: `${absorbedPercent}%` }} />

                        {/* ACTIVE (IOB - currently working) */}
                        <div
                          className="active-effects-curve-active"
                          style={{
                            left: `${absorbedPercent}%`,
                            width: `${activePercent}%`,
                            height: `${Math.max(20, activityPercent)}%`
                          }}
                        />

                        {/* ONSET MARKER */}
                        {totalDuration > 0 && (
                          <div className="active-effects-curve-marker-onset" style={{ left: `${(onset / totalDuration) * 100}%` }} />
                        )}

                        {/* PEAK MARKER (if not peakless) */}
                        {!isPeakless && totalDuration > 0 && (
                          <div className="active-effects-curve-marker-peak" style={{ left: `${(peak / totalDuration) * 100}%` }} />
                        )}

                        {/* CURRENT TIME MARKER */}
                        {totalDuration > 0 && (
                          <div className="active-effects-curve-marker-current" style={{ left: `${(hoursElapsed / totalDuration) * 100}%` }} />
                        )}
                      </div>

                      {/* TIMELINE LABELS */}
                      <div className="active-effects-curve-labels">
                        <span>Start</span>
                        <span className="active-effects-curve-label-onset">Onset ({onset}h)</span>
                        {!isPeakless && <span className="active-effects-curve-label-peak">Peak ({peak}h)</span>}
                        {isPeakless && <span className="active-effects-curve-label-plateau">Plateau</span>}
                        <span>End ({duration}h)</span>
                      </div>
                    </div>

                    {/* METRICS GRID */}
                    <div className="active-effects-metrics-grid">
                      {/* ABSORBED INSULIN */}
                      <div className="active-effects-metric-box active-effects-metric-absorbed">
                        <div className="active-effects-metric-label">✅ ABSORBED</div>
                        <div className="active-effects-metric-value">{absorbedUnits.toFixed(2)}u</div>
                        <div className="active-effects-metric-percent">{absorbedPercent.toFixed(0)}% used</div>
                        <div className="active-effects-metric-impact">-{cumulativeBGReduction.toFixed(0)} mg/dL</div>
                        <div className="active-effects-metric-subtext">Current reduction</div>
                      </div>

                      {/* ACTIVE INSULIN (IOB) */}
                      <div className="active-effects-metric-box active-effects-metric-active">
                        <div className="active-effects-metric-label">🔥 IOB (ACTIVE)</div>
                        <div className="active-effects-metric-value">{iobValue.toFixed(2)}u</div>
                        <div className="active-effects-metric-percent">{activityPercent.toFixed(0)}% activity</div>
                        <div className="active-effects-metric-impact">-{pendingBGReduction.toFixed(0)} mg/dL</div>
                        <div className="active-effects-metric-subtext">Pending reduction</div>
                      </div>

                      {/* DURATION REMAINING */}
                      <div className="active-effects-metric-box active-effects-metric-duration">
                        <div className="active-effects-metric-label">⏱️ TIME LEFT</div>
                        <div className="active-effects-metric-value">{durationRemaining.toFixed(1)}h</div>
                        <div className="active-effects-metric-percent">Until complete</div>
                      </div>
                    </div>

                    {/* PHARMACOKINETIC DETAILS */}
                    <div className="active-effects-pharma-details">
                      <div className="active-effects-pharma-details-title">📋 Pharmacodynamic Profile</div>
                      <div className="active-effects-pharma-details-grid">
                        <div>
                          <span className="active-effects-pharma-detail-label">Onset:</span>
                          <span className="active-effects-pharma-detail-value">{onset}h</span>
                        </div>
                        <div>
                          <span className="active-effects-pharma-detail-label">Peak:</span>
                          <span className="active-effects-pharma-detail-value">
                            {isPeakless ? 'Peakless' : `${peak}h`}
                          </span>
                        </div>
                        <div>
                          <span className="active-effects-pharma-detail-label">Duration:</span>
                          <span className="active-effects-pharma-detail-value">{duration}h</span>
                        </div>
                        <div>
                          <span className="active-effects-pharma-detail-label">Curve:</span>
                          <span className="active-effects-pharma-detail-value">
                            {curveType.replace('gamma_', '').replace('_', ' ')}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* SUMMARY */}
                    <div className="active-effects-contribution-summary">
                      <strong>T1D Impact:</strong>
                      <ul className="active-effects-contribution-summary-list">
                        <li>
                          <strong className="active-effects-summary-absorbed">{absorbedUnits.toFixed(2)}u absorbed</strong> →
                          Cumulative BG reduction: <strong>-{cumulativeBGReduction.toFixed(0)} mg/dL</strong>
                        </li>
                        <li>
                          <strong className="active-effects-summary-pending">{iobValue.toFixed(2)}u IOB</strong> →
                          Additional reduction coming: <strong>-{pendingBGReduction.toFixed(0)} mg/dL</strong>
                        </li>
                        <li>
                          Effect continues for <strong>{durationRemaining.toFixed(1)} more hours</strong>
                        </li>
                      </ul>
                      {isPeakless && (
                        <div className="active-effects-contribution-note">
                          (Peakless basal insulin provides steady background coverage)
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* MOB Details Section */}
          {showDetails && expandedSection === 'mob' && displayMobContributions.length > 0 && (
            <div className="active-effects-details">
              <h4 className="active-effects-details-title">
                🍽️ Meal Absorption Analysis - T1D Model
              </h4>

              {/* Summary Info Box */}
              <div className="active-effects-mob-summary-box">
                <div className="active-effects-mob-summary-title">
                  📊 T1D Meal Model - Carbohydrate Absorption
                </div>
                <div className="active-effects-mob-summary-content">
                  <div className="active-effects-mob-summary-line">
                    <strong>✅ Absorbed Carbs:</strong> {(activeEffects?.mob?.total_absorbed_carbs || 0).toFixed(1)}g
                    → <span className="active-effects-mob-summary-value-absorbed">
                      +{(activeEffects?.mob?.current_bg_elevation || 0).toFixed(1)} mg/dL
                    </span> (current elevation)
                  </div>
                  <div className="active-effects-mob-summary-line">
                    <strong>⏳ MOB (Active):</strong> {(activeEffects?.mob?.total_active_carbs || 0).toFixed(1)}g
                    → <span className="active-effects-mob-summary-value-pending">
                      +{(activeEffects?.mob?.pending_bg_rise || (activeEffects?.mob?.total_active_carbs || 0) * (patientConstants?.carb_to_bg_factor || 4)).toFixed(1)} mg/dL
                    </span> pending
                  </div>
                  <div className="active-effects-mob-summary-note">
                    <strong>Key Difference from Insulin:</strong> Absorbed carbs = CURRENT BG elevation (in bloodstream).
                    MOB = FUTURE BG rise (still digesting). Only insulin can bring BG back down.
                  </div>
                </div>
              </div>

              {/* Stacking Warning Banner */}
              {activeEffects?.mob?.stacking_info?.isStacking &&
               activeEffects.mob.stacking_info.severity?.level &&
               ['high', 'severe', 'critical'].includes(activeEffects.mob.stacking_info.severity.level) && (
                <div className="active-effects-stacking-warning">
                  <div className="active-effects-stacking-warning-title">
                    ⚠️ MEAL STACKING DETECTED - {activeEffects.mob.stacking_info.severity.level.toUpperCase()} RISK
                  </div>
                  <div className="active-effects-stacking-warning-factors">
                    {activeEffects.mob.stacking_info.severity?.factors?.join(' • ')}
                  </div>
                  {activeEffects.mob.stacking_info.recommendations?.[0] && (
                    <div className="active-effects-stacking-warning-recommendation">
                      → {activeEffects.mob.stacking_info.recommendations[0].message}
                    </div>
                  )}
                </div>
              )}

              {/* Individual Meal Contributions */}
              {displayMobContributions.map((contrib, idx) => {
                // Extract values using CORRECT camelCase field names FIRST
                const hoursElapsed = contrib.hoursSinceMeal ?? contrib.hours_elapsed ?? 0;
                const absorbedCarbs = contrib.absorbedCarbs ?? contrib.absorbed_carbs ?? 0;
                const activeCarbs = contrib.activeCarbs ?? contrib.active_carbs ?? contrib.mob ?? 0;
                const totalCarbs = contrib.carbEquiv ?? contrib.total_carbs ?? (absorbedCarbs + activeCarbs);
                const absorptionType = contrib.absorptionType ?? contrib.absorption_type ?? 'medium';
                const activityPercent = contrib.activityPercent ?? contrib.activity_percent ?? 0;

                // Calculate percentages with fallback
                let absorbedPercent = contrib.absorbedPercent ?? contrib.absorbed_percent ?? 0;
                if (absorbedPercent === 0 && totalCarbs > 0) {
                  absorbedPercent = (absorbedCarbs / totalCarbs) * 100;
                }
                const activePercent = totalCarbs > 0 ? (activeCarbs / totalCarbs) * 100 : 0;

                const peakTime = contrib.profile?.peak ?? ABSORPTION_PROFILES[absorptionType]?.peak ?? 1.5;
                const totalDuration = contrib.profile?.duration ?? ABSORPTION_PROFILES[absorptionType]?.duration ?? 4;
                const durationRemaining = Math.max(0, totalDuration - hoursElapsed);
                const isPastPeak = hoursElapsed > peakTime;
                const carbToBgFactor = patientConstants?.carb_to_bg_factor ?? 4;

                // Calculate BG impacts with validation
                let bgElevation = contrib.bgElevation ?? contrib.bgImpact ?? 0;
                let pendingBGRise = contrib.pendingBGRise ?? contrib.pending_bg_rise ?? 0;

                // Failsafe calculations
                if (bgElevation === 0 && absorbedCarbs > 0) {
                  bgElevation = absorbedCarbs * carbToBgFactor;
                }

                if (pendingBGRise === 0 && activeCarbs > 0) {
                  pendingBGRise = activeCarbs * carbToBgFactor;
                }

                return (
                  <div
                    key={idx}
                    className="active-effects-contribution-card"
                    style={{ borderLeftColor: isPastPeak ? '#4CAF50' : '#FF9800' }}
                  >
                    <div className="active-effects-contribution-header">
                      <span className="active-effects-contribution-type">
                        {contrib.meal_type || contrib.mealType
                          ? (contrib.meal_type || contrib.mealType).charAt(0).toUpperCase() + (contrib.meal_type || contrib.mealType).slice(1)
                          : 'Meal'}
                      </span>
                      <span className="active-effects-contribution-time">
                        {fmt(hoursElapsed, 1)}h ago
                      </span>
                    </div>

                    <div className="active-effects-pharma-visualization">
                      <div className="active-effects-pharma-header">
                        <span>📊 Absorption Timeline</span>
                        <span>{fmt(absorbedPercent, 0)}% absorbed</span>
                      </div>

                      {/* Absorption Progress Bar */}
                      <div className="active-effects-curve-bar active-effects-absorption-bar">
                        <div className="active-effects-absorption-absorbed" style={{ width: `${absorbedPercent}%` }} />
                        <div className="active-effects-absorption-active" style={{
                          left: `${absorbedPercent}%`,
                          width: `${activePercent}%`
                        }} />
                        {totalCarbs > 0 && (
                          <>
                            <div className="active-effects-curve-marker-peak" style={{ left: `${(peakTime / totalDuration) * 100}%` }} />
                            <div className="active-effects-curve-marker-current" style={{ left: `${(hoursElapsed / totalDuration) * 100}%` }} />
                          </>
                        )}
                      </div>

                      <div className="active-effects-curve-labels">
                        <span>Start</span>
                        <span className="active-effects-curve-label-peak">Peak ({peakTime}h)</span>
                        <span>End ({fmt(totalDuration, 1)}h)</span>
                      </div>
                    </div>

                    {/* Metrics Grid */}
                    <div className="active-effects-metrics-grid">
                      <div className="active-effects-metric-box active-effects-metric-carbs-absorbed">
                        <div className="active-effects-metric-label">✅ ABSORBED</div>
                        <div className="active-effects-metric-value">{fmt(absorbedCarbs, 1)}g</div>
                        <div className="active-effects-metric-percent">{fmt(absorbedPercent, 0)}% absorbed</div>
                        <div className="active-effects-metric-impact active-effects-metric-impact-positive">
                          +{fmt(bgElevation, 0)} mg/dL
                        </div>
                        <div className="active-effects-metric-subtext">Current elevation</div>
                      </div>

                      <div className="active-effects-metric-box active-effects-metric-carbs-active">
                        <div className="active-effects-metric-label">⏳ MOB (ACTIVE)</div>
                        <div className="active-effects-metric-value">{fmt(activeCarbs, 1)}g</div>
                        <div className="active-effects-metric-percent">Still digesting</div>
                        <div className="active-effects-metric-impact active-effects-metric-impact-warning">
                          +{fmt(pendingBGRise, 0)} mg/dL
                        </div>
                        <div className="active-effects-metric-subtext">Pending rise</div>
                      </div>

                      <div className="active-effects-metric-box active-effects-metric-duration">
                        <div className="active-effects-metric-label">⏱️ DURATION</div>
                        <div className="active-effects-metric-value">{fmt(durationRemaining, 1)}h</div>
                        <div className="active-effects-metric-percent">Time remaining</div>
                        <div className="active-effects-metric-impact active-effects-metric-impact-info">
                          {fmt(activityPercent, 0)}%
                        </div>
                        <div className="active-effects-metric-subtext">Current activity</div>
                      </div>
                    </div>

                    {/* T1D Impact Summary */}
                    <div className="active-effects-contribution-summary">
                      <strong>T1D Impact:</strong>
                      <ul className="active-effects-contribution-summary-list">
                        <li>
                          <strong className="active-effects-summary-absorbed-meal">{fmt(absorbedCarbs, 1)}g absorbed</strong> →
                          Current BG elevation: <strong>+{fmt(bgElevation, 0)} mg/dL</strong>
                        </li>
                        <li>
                          <strong className="active-effects-summary-pending-meal">{fmt(activeCarbs, 1)}g MOB</strong> →
                          Additional rise expected: <strong>+{fmt(pendingBGRise, 0)} mg/dL</strong>
                        </li>
                        <li>
                          Absorption continues for <strong>{fmt(durationRemaining, 1)} more hours</strong>
                        </li>
                      </ul>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

     <div className="active-effects-last-update">
  Last updated: {(() => {
    // ✅ FIX: Use display timestamp (when we're showing the data)
    const displayTime = netEffectData?.timestamp || Date.now();
    // Only show hours and minutes, not seconds
    return new Date(displayTime).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  })()}
  {showNetEffect && netEffectData && (
    <span className="active-effects-update-note">
      {' '}• Refreshes at minute boundaries (:00 seconds)
      {DEBUG_MODE && netEffectData.contextCalculationTime && (
        <span style={{fontSize: '10px', color: '#999', marginLeft: '8px'}}>
          (Context calculated: {new Date(netEffectData.contextCalculationTime).toLocaleTimeString()})
        </span>
      )}
    </span>
  )}
</div>

          {/* ── Backend Comparison Panel ── */}
          {showComparison && (
            <BackendComparisonPanel
              patientId={patientId}
              netEffectData={netEffectData}
              activeEffects={activeEffects}
              patientConstants={patientConstants}
            />
          )}
        </>
      )}
    </div>
  );
};


// ============================================================================
// BACKEND COMPARISON PANEL
// ============================================================================
// Fetches /api/active-effects-full and diffs against frontend-calculated values.
// Toggle visibility with the "🔬 Compare Backend" button added to the dashboard.
// ============================================================================

/** Tolerance bands for match classification */
const DIFF_THRESHOLDS = {
  EXACT: 0.5,     // ≤0.5 → exact match (green ✅)
  CLOSE: 3.0,     // ≤3.0 → close match (yellow 🟡)
  // > 3.0          → divergent (red 🔴)
};

/**
 * Classify a numeric diff and return styling metadata.
 */
function classifyDiff(frontendVal, backendVal) {
  if (frontendVal == null || backendVal == null) {
    return { label: 'N/A', color: '#aaa', bg: '#f5f5f5', icon: '⬜' };
  }
  const diff = Math.abs(frontendVal - backendVal);
  if (diff <= DIFF_THRESHOLDS.EXACT)  return { label: `Δ${diff.toFixed(2)}`, color: '#2e7d32', bg: '#e8f5e9', icon: '✅' };
  if (diff <= DIFF_THRESHOLDS.CLOSE)  return { label: `Δ${diff.toFixed(2)}`, color: '#e65100', bg: '#fff3e0', icon: '🟡' };
  return { label: `Δ${diff.toFixed(2)}`, color: '#c62828', bg: '#ffebee', icon: '🔴' };
}

/**
 * A single comparison row.
 */
function CompRow({ label, sublabel, feVal, beVal, unit = '', precision = 1 }) {
  const fe = typeof feVal === 'number' ? feVal : null;
  const be = typeof beVal === 'number' ? beVal : null;
  const { label: diffLabel, color, bg, icon } = classifyDiff(fe, be);

  const fmt = (v) => v != null ? `${v.toFixed(precision)}${unit}` : '—';

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 120px 120px 90px',
      alignItems: 'center',
      gap: '8px',
      padding: '8px 12px',
      borderBottom: '1px solid #e0e0e0',
      backgroundColor: bg,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
      fontSize: '12px',
    }}>
      <div>
        <div style={{ fontWeight: 600, color: '#333', fontFamily: 'inherit' }}>{label}</div>
        {sublabel && <div style={{ color: '#888', fontSize: '10px', marginTop: '2px' }}>{sublabel}</div>}
      </div>
      <div style={{ textAlign: 'right', color: '#1565c0', fontWeight: 600 }}>{fmt(fe)}</div>
      <div style={{ textAlign: 'right', color: '#6a1b9a', fontWeight: 600 }}>{fmt(be)}</div>
      <div style={{ textAlign: 'center', color, fontWeight: 700 }}>
        <span style={{ fontSize: '14px' }}>{icon}</span>
        <div style={{ fontSize: '10px', marginTop: '2px' }}>{diffLabel}</div>
      </div>
    </div>
  );
}

/**
 * Section header for the comparison table.
 */
function CompSection({ title, icon }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 120px 120px 90px',
      gap: '8px',
      padding: '10px 12px 6px',
      backgroundColor: '#263238',
      color: '#eceff1',
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: '11px',
      fontWeight: 700,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
    }}>
      <div>{icon} {title}</div>
      <div style={{ textAlign: 'right', color: '#90caf9' }}>FRONTEND</div>
      <div style={{ textAlign: 'right', color: '#ce93d8' }}>BACKEND</div>
      <div style={{ textAlign: 'center', color: '#a5d6a7' }}>DIFF</div>
    </div>
  );
}

/**
 * BackendComparisonPanel
 *
 * Props:
 *   patientId  - optional, forwarded to query param
 *   netEffectData    - from parent calculateNetEffect()
 *   activeEffects    - from BloodSugarDataContext
 *   patientConstants - from ConstantsContext
 */
function BackendComparisonPanel({ patientId, netEffectData, activeEffects, patientConstants }) {
  const [beData, setBeData]           = useState(null);
  const [status, setStatus]           = useState('idle'); // idle | loading | success | error
  const [errorMsg, setErrorMsg]       = useState('');
  const [lastFetched, setLastFetched] = useState(null);
  const [feFetchTime, setFeFetchTime] = useState(null); // local wall-clock when FE was snapshotted
  const [beFetchTime, setBeFetchTime] = useState(null); // local wall-clock when BE replied
  const [sentUtcTime, setSentUtcTime] = useState(null); // the UTC ISO we sent to the backend
  const abortRef = useRef(null);

  // ── Timezone helpers ────────────────────────────────────────────────────────
  const tzOffsetMinutes = new Date().getTimezoneOffset(); // negative for UTC+
  const tzOffsetHours   = -(tzOffsetMinutes / 60);       // e.g. +2 for UTC+2
  const tzLabel         = `UTC${tzOffsetHours >= 0 ? '+' : ''}${tzOffsetHours}`;

  /**
   * Convert a local JS timestamp (ms) to a UTC ISO string the backend expects.
   * Backend always works in naive UTC datetimes, so we strip the offset.
   */
  const toBackendUTC = (localMs) => {
    const d = new Date(localMs);
    // toISOString() returns UTC already (Z-suffix).  Backend parses +00:00 → strips tzinfo.
    return d.toISOString(); // "2026-02-12T19:39:46.000Z"
  };

  const fetchBackend = useCallback(async () => {
    setStatus('loading');
    setErrorMsg('');

    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    // Snapshot the frontend calculation time right before we fire the request
    const feSnapshot = Date.now();
    setFeFetchTime(feSnapshot);

    // Build the UTC target_time to send.  We use the SAME moment as our FE snapshot
    // so both sides are computing at identical clock ticks.
    const utcIso = toBackendUTC(feSnapshot);
    setSentUtcTime(utcIso);

 try {
  const token = localStorage.getItem('token');
  const params = new URLSearchParams();
  if (patientId) params.set('patient_id', patientId);
  params.set('target_time', utcIso);
  params.set('timezone_offset_minutes', TimeManager.getTimezoneOffsetMinutes());

  const resp = await axios.get(
    `${API_BASE_URL}/api/active-effects-full?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: abortRef.current.signal,
    }
  );
      setBeData(resp.data);
      setBeFetchTime(Date.now());
      setLastFetched(new Date());
      setStatus('success');
    } catch (err) {
      if (axios.isCancel(err)) return;
      setErrorMsg(err.response?.data?.error || err.message || 'Unknown error');
      setStatus('error');
    }
  }, [patientId]);

  // Convenience aliases
  const fe = netEffectData || {};
  const feIob = activeEffects?.iob || {};
  const feMob = activeEffects?.mob || {};

  const be = beData || {};
  const beIob = be.iob || {};
  const beMob = be.mob || {};
  const beCumulative = be.cumulative || {};

  const carbToBg = patientConstants?.carb_to_bg_factor ?? 4;
  const corrFactor = patientConstants?.correction_factor ?? 40;

  return (
    <div style={{
      marginTop: '16px',
      border: '2px solid #37474f',
      borderRadius: '8px',
      overflow: 'hidden',
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    }}>
      {/* Panel Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 16px',
        background: 'linear-gradient(135deg, #1a237e 0%, #283593 100%)',
        color: '#e8eaf6',
      }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: '13px', letterSpacing: '0.05em' }}>
            🔬 FRONTEND ↔ BACKEND COMPARISON
          </div>
          <div style={{ fontSize: '10px', color: '#9fa8da', marginTop: '3px' }}>
            Validates pharmacodynamics alignment · Endpoint: /api/active-effects-full
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {lastFetched && (
            <span style={{ fontSize: '10px', color: '#9fa8da' }}>
              Last: {lastFetched.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          <button
            onClick={fetchBackend}
            disabled={status === 'loading'}
            style={{
              padding: '6px 14px',
              backgroundColor: status === 'loading' ? '#455a64' : '#00acc1',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: status === 'loading' ? 'not-allowed' : 'pointer',
              fontSize: '11px',
              fontWeight: 700,
              fontFamily: 'inherit',
              letterSpacing: '0.05em',
              transition: 'background 0.2s',
            }}
          >
            {status === 'loading' ? '⏳ FETCHING...' : '↻ FETCH BACKEND'}
          </button>
        </div>
      </div>

      {/* Timezone + Calculation Time Banner */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gap: '1px',
        backgroundColor: '#cfd8dc',
        fontSize: '10px',
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      }}>
        {/* Browser timezone */}
        <div style={{ padding: '6px 12px', backgroundColor: '#e8eaf6' }}>
          <div style={{ fontWeight: 700, color: '#3949ab', marginBottom: '2px' }}>🌐 BROWSER TIMEZONE</div>
          <div style={{ color: '#333' }}>{tzLabel}</div>
          <div style={{ color: '#888', fontSize: '9px' }}>
            Offset: {tzOffsetMinutes < 0 ? '+' : ''}{-tzOffsetMinutes / 60}h from UTC
          </div>
          <div style={{ color: '#888', fontSize: '9px', marginTop: '2px' }}>
            Backend expects naive UTC (no offset)
          </div>
        </div>
        {/* Frontend snapshot time */}
        <div style={{ padding: '6px 12px', backgroundColor: '#e3f2fd' }}>
          <div style={{ fontWeight: 700, color: '#1565c0', marginBottom: '2px' }}>🔵 FRONTEND CALCULATED AT</div>
          {feFetchTime ? (
            <>
              <div style={{ color: '#1565c0' }}>
                Local: {new Date(feFetchTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </div>
              <div style={{ color: '#5c7cfa', fontSize: '9px' }}>
                UTC: {new Date(feFetchTime).toISOString().replace('T', ' ').slice(0, 19)}
              </div>
            </>
          ) : (
            <div style={{ color: '#999' }}>Not yet fetched</div>
          )}
          <div style={{ color: '#888', fontSize: '9px', marginTop: '2px' }}>
            Uses local time for reset-hour logic ({tzLabel})
          </div>
        </div>
        {/* Backend calculation time */}
        <div style={{ padding: '6px 12px', backgroundColor: '#f3e5f5' }}>
          <div style={{ fontWeight: 700, color: '#6a1b9a', marginBottom: '2px' }}>🟣 BACKEND CALCULATED AT</div>
          {beData?.calculation_time ? (
            <>
              <div style={{ color: '#6a1b9a' }}>
                UTC: {beData.calculation_time.replace('T', ' ').slice(0, 19)}
              </div>
              <div style={{ color: '#ab47bc', fontSize: '9px' }}>
                Local equiv: {new Date(beData.calculation_time + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </div>
            </>
          ) : (
            <div style={{ color: '#999' }}>Not yet fetched</div>
          )}
          <div style={{ color: '#888', fontSize: '9px', marginTop: '2px' }}>
            UTC-naive datetime · target_time param sent: {sentUtcTime ? sentUtcTime.slice(11, 19) + 'Z' : '—'}
          </div>
        </div>
      </div>

      {/* Clock skew warning */}
      {feFetchTime && beFetchTime && (() => {
        const skewMs = Math.abs(beFetchTime - feFetchTime);
        if (skewMs < 3000) return null; // under 3 s, fine
        return (
          <div style={{
            padding: '6px 14px',
            backgroundColor: '#fff8e1',
            borderTop: '1px solid #ffe082',
            fontSize: '10px',
            color: '#e65100',
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 600,
          }}>
            ⚠️ Response latency: {(skewMs / 1000).toFixed(1)}s — backend may have computed at a slightly different moment than the frontend snapshot.
          </div>
        );
      })()}

      {/* Legend */}
      <div style={{
        display: 'flex',
        gap: '20px',
        padding: '6px 16px',
        backgroundColor: '#eceff1',
        fontSize: '10px',
        fontWeight: 600,
        color: '#546e7a',
        borderBottom: '1px solid #cfd8dc',
        fontFamily: 'inherit',
        flexWrap: 'wrap',
      }}>
        <span>✅ Exact  (Δ≤{DIFF_THRESHOLDS.EXACT})</span>
        <span>🟡 Close  (Δ≤{DIFF_THRESHOLDS.CLOSE})</span>
        <span>🔴 Divergent  (Δ&gt;{DIFF_THRESHOLDS.CLOSE})</span>
        <span style={{ marginLeft: 'auto', color: '#1565c0' }}>BLUE = Frontend</span>
        <span style={{ color: '#6a1b9a' }}>PURPLE = Backend</span>
      </div>

      {/* Error State */}
      {status === 'error' && (
        <div style={{
          padding: '16px',
          backgroundColor: '#ffebee',
          color: '#c62828',
          fontSize: '12px',
          fontFamily: 'inherit',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <span style={{ fontSize: '18px' }}>⚠️</span>
          <div>
            <strong>Backend fetch failed:</strong> {errorMsg}
            <div style={{ marginTop: '4px', color: '#888', fontSize: '10px' }}>
              Check that the Flask server is running and /api/active-effects-full is registered.
            </div>
          </div>
        </div>
      )}

      {/* Idle State */}
      {status === 'idle' && (
        <div style={{
          padding: '24px',
          textAlign: 'center',
          color: '#90a4ae',
          fontSize: '12px',
          fontFamily: 'inherit',
        }}>
          Click <strong>↻ FETCH BACKEND</strong> to pull live data from the backend and compare.
          <div style={{ marginTop: '8px', fontSize: '10px', color: '#b0bec5' }}>
            Frontend values shown below are pre-calculated by BloodSugarDataContext.
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {status === 'loading' && (
        <div style={{ padding: '24px', textAlign: 'center', color: '#78909c', fontSize: '12px', fontFamily: 'inherit' }}>
          ⏳ Fetching from backend…
        </div>
      )}

      {/* Comparison Table */}
      {(status === 'success' || status === 'idle') && (
        <div style={{ overflowX: 'auto' }}>

          {/* ── IOB Section ──────────────────────────────────────────────────
               Mirrors the IOB card visual layout exactly:
                 Card row 1 : value  "{X.XX} units"
                 Card row 2 : subtext "{N} active dose(s)"
                 Card row 3 : ✅ -{insulinImpact} mg/dL current   (PAST→PRESENT)
                 Card row 4 : ⏳ -{pendingInsulinReduction} mg/dL pending (PRESENT→FUTURE)
               ──────────────────────────────────────────────────────────────── */}
          <CompSection icon="💉" title="Insulin on Board (IOB)" />

          {/* Row matches card header value: "X.XX units" */}
          <CompRow
            label="⏳ Total IOB"
            sublabel="Units still active in body (PRESENT→FUTURE)"
            feVal={feIob.total_active_insulin ?? feIob.totalIOB}
            beVal={beIob.total_active_insulin ?? beIob.totalIOB}
            unit="u"
            precision={3}
          />

          {/* Row matches card subtext: "N active dose(s)" */}
          <CompRow
            label="Active Doses"
            sublabel="Number of doses still within PK window"
            feVal={feIob.insulin_contributions?.length ?? null}
            beVal={beIob.insulin_contributions?.length ?? beIob.active_doses ?? null}
            unit=""
            precision={0}
          />

          {/* New row: absorbed insulin units (companion to the mg/dL row below)
               FE: fe.absorbedInsulin  (from adjustedBaselineForProjection.absorbedInsulin)
               BE: beIob.total_absorbed_insulin if the backend exposes it, else N/A */}
          <CompRow
            label="✅ Absorbed Insulin"
            sublabel="Units already acted on BG (PAST→PRESENT)"
            feVal={fe.absorbedInsulin ?? null}
            beVal={beIob.total_absorbed_insulin ?? null}
            unit="u"
            precision={2}
          />

          {/* Row matches card line 3: "✅ -{insulinImpact} mg/dL current"
               CORRECT source for BOTH sides = cumulative absorbed effect (bank balance).
               ⚠️  Do NOT use beIob.current_bg_reduction or activeUnits×CF —
               those use the instantaneous gamma-PDF rate which gives inflated values
               (e.g. 192 mg/dL for a 5u dose near its activity peak). */}
          <CompRow
            label="✅ Current BG Reduction"
            sublabel="From absorbed insulin (PAST→PRESENT)"
            feVal={fe.insulinImpact ?? null}
            beVal={(() => {
              const cumInsulin = beCumulative.cumulative_insulin_effect ?? be.cumulative_insulin_effect;
              return cumInsulin != null ? Math.abs(cumInsulin) : null;
            })()}
            unit=" mg/dL"
            precision={1}
          />

          {/* Row matches card line 4: "⏳ -{pendingInsulinReduction} mg/dL pending" */}
          <CompRow
            label="⏳ Pending BG Reduction"
            sublabel="From IOB still to act (PRESENT→FUTURE)"
            feVal={fe.pendingInsulinReduction}
            beVal={beIob.pending_bg_reduction != null
              ? beIob.pending_bg_reduction
              : (beIob.total_active_insulin != null
                ? beIob.total_active_insulin * corrFactor
                : null)}
            unit=" mg/dL"
            precision={1}
          />

          {/* ── MOB Section ── */}
          <CompSection icon="🍽️" title="Meal on Board (MOB)" />
          <CompRow
            label="Total Active Carbs (MOB)"
            sublabel="Grams still digesting"
            feVal={feMob.total_active_carbs ?? feMob.totalActiveCarbs}
            beVal={beMob.total_active_carbs ?? beMob.totalActiveCarbs}
            unit="g"
            precision={1}
          />
          <CompRow
            label="Total Absorbed Carbs"
            sublabel="Grams already in bloodstream"
            feVal={feMob.total_absorbed_carbs ?? feMob.totalAbsorbedCarbs}
            beVal={beMob.total_absorbed_carbs ?? beMob.totalAbsorbedCarbs}
            unit="g"
            precision={1}
          />
          <CompRow
            label="Active Meals Count"
            sublabel="Meals still absorbing"
            feVal={feMob.active_meals_count ?? null}
            beVal={beMob.active_meals_count ?? null}
            unit=""
            precision={0}
          />
          <CompRow
            label="Pending BG Rise (from MOB)"
            sublabel="Expected future BG rise"
            feVal={fe.pendingMealRise}
            beVal={beMob.total_active_carbs != null
              ? beMob.total_active_carbs * carbToBg
              : null}
            unit=" mg/dL"
            precision={1}
          />

          {/* ── Cumulative Effects Section ── */}
          <CompSection icon="📊" title="Cumulative Effects (Daily Baseline Shift)" />
          <CompRow
            label="Cumulative Meal Effect"
            sublabel="Total BG elevation from today's absorbed carbs"
            feVal={fe.cumulativeMealEffect}
            beVal={beCumulative.cumulative_meal_effect ?? be.cumulative_meal_effect}
            unit=" mg/dL"
            precision={1}
          />
          <CompRow
            label="Cumulative Insulin Effect"
            sublabel="Total BG reduction from today's absorbed insulin (negative)"
            feVal={fe.cumulativeInsulinEffect}
            beVal={beCumulative.cumulative_insulin_effect ?? be.cumulative_insulin_effect}
            unit=" mg/dL"
            precision={1}
          />
          <CompRow
            label="Cumulative Net Baseline"
            sublabel="Net daily shift = meal effect + insulin effect"
            feVal={fe.cumulativeNetBaseline}
            beVal={beCumulative.cumulative_net_baseline ?? be.cumulative_net_baseline}
            unit=" mg/dL"
            precision={1}
          />

          {/* ── Instantaneous Net Effects ── */}
          <CompSection icon="⚖️" title="Instantaneous Net Effects (Now)" />
          <CompRow
            label="Current Meal Impact"
            sublabel="BG elevation from absorbed carbs RIGHT NOW"
            feVal={fe.mealImpact}
            beVal={be.instantaneous_meal_effect ?? null}
            unit=" mg/dL"
            precision={1}
          />
          <CompRow
            label="Current Insulin Impact"
            sublabel="BG reduction from absorbed insulin RIGHT NOW"
            feVal={fe.insulinImpact}
            beVal={beIob.current_bg_reduction != null
              ? beIob.current_bg_reduction
              : (beIob.total_absorbed_insulin != null
                ? beIob.total_absorbed_insulin * corrFactor
                : null)}
            unit=" mg/dL"
            precision={1}
          />
          <CompRow
            label="Net Effect (Projected)"
            sublabel="Current net BG change from baseline"
            feVal={fe.projectedEffect}
            beVal={(() => {
              const beMealNow = be.instantaneous_meal_effect;
              const beInsulinNow = beIob.current_bg_reduction;
              if (beMealNow != null && beInsulinNow != null) {
                return Math.round((beMealNow - beInsulinNow) * 10) / 10;
              }
              return null;
            })()}
            unit=" mg/dL"
            precision={1}
          />

          {/* ── BG Estimates ── */}
          <CompSection icon="🩸" title="Blood Glucose Estimates" />
          <CompRow
            label="Stable Baseline"
            sublabel="Metabolic baseline (no active effects)"
            feVal={fe.baseline}
            beVal={be.bg_estimates?.stable_baseline ?? null}
            unit=" mg/dL"
            precision={0}
          />
          <CompRow
            label="Current Estimated BG"
            sublabel="Baseline + current net effect"
            feVal={fe.currentEstimatedBG}
            beVal={be.bg_estimates?.current_estimated_bg ?? null}
            unit=" mg/dL"
            precision={0}
          />
          <CompRow
            label="Projected Final BG"
            sublabel="After all IOB acts"
            feVal={fe.projectedFinalBG}
            beVal={be.bg_estimates?.projected_final_bg ?? null}
            unit=" mg/dL"
            precision={0}
          />

          {/* ── Reset / Metadata ── */}
          <CompSection icon="🕐" title="Daily Reset Metadata" />
          <CompRow
            label="Daily Reset Hour"
            sublabel="Hour of day when cumulative effects reset"
            feVal={patientConstants?.daily_reset_hour ?? 7}
            beVal={be.reset_hour ?? beCumulative.reset_hour}
            unit="h"
            precision={0}
          />

          {/* ── Timezone Diagnosis ── */}
          <CompSection icon="🌐" title="Timezone Diagnosis" />

          {/* Reset time as interpreted by each side */}
          {(() => {
            const resetHour = patientConstants?.daily_reset_hour ?? 7;
            const now = Date.now();
            // Conventional offset: positive for UTC+  (e.g. UTC+2 → +120)
            const tzOff = -(new Date().getTimezoneOffset()); // minutes

            // Frontend: getDailyResetTime uses LOCAL time via tzOffsetMinutes-aware logic
            const feResetMs = TimeManager.getDailyResetTime(now, resetHour, tzOff);

            // Backend (FIXED v4.3): get_daily_reset_time also uses timezone_offset_minutes
            // It converts to patient local time, applies resetHour, converts back to UTC.
            // The result is identical to the frontend when tzOffsetMinutes is passed correctly.
            const beResetMs = (() => {
              // Replicate time_manager.py get_daily_reset_time logic
              const localMs = now + tzOff * 60 * 1000;
              const localDate = new Date(localMs);
              const resetLocal = new Date(localMs);
              resetLocal.setUTCHours(resetHour, 0, 0, 0);
              if (localDate < resetLocal) resetLocal.setUTCDate(resetLocal.getUTCDate() - 1);
              return resetLocal.getTime() - tzOff * 60 * 1000;
            })();

            const diffH = (feResetMs - beResetMs) / 3600000;
            const fmtUTC = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
            const fmtLocal = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const fmtDate = ms => new Date(ms).toLocaleDateString();

            return (
              <>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '1px',
                  backgroundColor: '#e0e0e0',
                  fontSize: '10px',
                  fontFamily: "'JetBrains Mono', monospace",
                  margin: '0',
                }}>
                  <div style={{ padding: '8px 12px', backgroundColor: '#e3f2fd' }}>
                    <div style={{ fontWeight: 700, color: '#1565c0', marginBottom: '4px' }}>
                      🔵 FE Reset (reset_hour={resetHour})
                    </div>
                    <div style={{ color: '#1565c0' }}>
                      Local: {fmtLocal(feResetMs)} ({fmtDate(feResetMs)})
                    </div>
                    <div style={{ color: '#5c7cfa', fontSize: '9px', marginTop: '2px' }}>
                      UTC: {fmtUTC(feResetMs)}
                    </div>
                    <div style={{ color: '#888', fontSize: '9px', marginTop: '3px' }}>
                      TimeManager.getDailyResetTime(now, {resetHour}, {tzOff}) → timezone-aware
                    </div>
                  </div>
                  <div style={{ padding: '8px 12px', backgroundColor: '#f3e5f5' }}>
                    <div style={{ fontWeight: 700, color: '#6a1b9a', marginBottom: '4px' }}>
                      🟣 BE Reset (reset_hour={resetHour})
                    </div>
                    <div style={{ color: '#6a1b9a' }}>
                      UTC: {fmtUTC(beResetMs)}
                    </div>
                    <div style={{ color: '#ab47bc', fontSize: '9px', marginTop: '2px' }}>
                      Local equiv: {fmtLocal(beResetMs)}
                    </div>
                    <div style={{ color: '#888', fontSize: '9px', marginTop: '3px' }}>
                      time_manager.py v4.3 — timezone_offset_minutes={tzOff} applied
                    </div>
                  </div>
                </div>
                {/* Gap indicator */}
                <div style={{
                  padding: '8px 12px',
                  backgroundColor: Math.abs(diffH) >= 0.5 ? '#ffebee' : '#e8f5e9',
                  borderBottom: '1px solid #e0e0e0',
                  fontSize: '10px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 600,
                  color: Math.abs(diffH) >= 0.5 ? '#c62828' : '#2e7d32',
                }}>
                  {Math.abs(diffH) >= 0.5 ? '🔴' : '✅'} Reset window gap:{' '}
                  <strong>{diffH > 0 ? '+' : ''}{diffH.toFixed(1)}h</strong>
                  {Math.abs(diffH) < 0.5 && (
                    <span style={{ fontWeight: 400, marginLeft: '8px' }}>
                      — FE and BE reset windows are aligned. Both use patient local time (UTC{tzOff >= 0 ? '+' : ''}{tzOff / 60}h).
                    </span>
                  )}
                  {Math.abs(diffH) >= 0.5 && (
                    <span style={{ fontWeight: 400, marginLeft: '8px' }}>
                      — Windows are misaligned by {Math.abs(diffH).toFixed(1)}h.
                      Check that <code>timezone_offset_minutes</code> is being sent in the request
                      and that the patient constant is up to date.
                    </span>
                  )}
                </div>
              </>
            );
          })()}

          {/* ── Raw Backend JSON (collapsible) ── */}
          {status === 'success' && beData && (
            <details style={{ padding: '0 12px 12px', backgroundColor: '#fafafa' }}>
              <summary style={{
                padding: '10px 0',
                cursor: 'pointer',
                fontSize: '11px',
                fontWeight: 700,
                color: '#546e7a',
                fontFamily: 'inherit',
                letterSpacing: '0.05em',
              }}>
                📋 RAW BACKEND RESPONSE (click to expand)
              </summary>
              <pre style={{
                margin: '8px 0 0',
                padding: '12px',
                backgroundColor: '#1e2a35',
                color: '#a8d8a8',
                fontSize: '10px',
                borderRadius: '4px',
                overflowX: 'auto',
                lineHeight: '1.5',
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {JSON.stringify(beData, null, 2)}
              </pre>
            </details>
          )}

        </div>
      )}

      {/* Summary score when we have data */}
      {status === 'success' && beData && netEffectData && (
        <ComparisonSummaryBadge
          fe={fe}
          feMob={feMob}
          feIob={feIob}
          be={be}
          beMob={beMob}
          beIob={beIob}
          beCumulative={beCumulative}
          carbToBg={carbToBg}
          corrFactor={corrFactor}
        />
      )}
    </div>
  );
}

/**
 * Summary score bar - aggregates all comparison results into one health score.
 */
function ComparisonSummaryBadge({ fe, feMob, feIob, be, beMob, beIob, beCumulative, carbToBg, corrFactor }) {
  const pairs = [
    // IOB (mirrors card rows top-to-bottom)
    [feIob.total_active_insulin ?? feIob.totalIOB,           beIob.total_active_insulin ?? beIob.totalIOB],
    [fe.absorbedInsulin ?? null,                              beIob.total_absorbed_insulin ?? null],
    [fe.insulinImpact ?? null,
     (() => { const c = beCumulative.cumulative_insulin_effect ?? be.cumulative_insulin_effect; return c != null ? Math.abs(c) : null; })()],
    // MOB
    [feMob.total_active_carbs ?? feMob.totalActiveCarbs,     beMob.total_active_carbs ?? beMob.totalActiveCarbs],
    [feMob.total_absorbed_carbs ?? feMob.totalAbsorbedCarbs, beMob.total_absorbed_carbs ?? beMob.totalAbsorbedCarbs],
    // Cumulative
    [fe.cumulativeMealEffect,    beCumulative.cumulative_meal_effect    ?? be.cumulative_meal_effect],
    [fe.cumulativeInsulinEffect, beCumulative.cumulative_insulin_effect ?? be.cumulative_insulin_effect],
    [fe.cumulativeNetBaseline,   beCumulative.cumulative_net_baseline   ?? be.cumulative_net_baseline],
  ].filter(([a, b]) => a != null && b != null);

  const counts = pairs.reduce((acc, [a, b]) => {
    const d = Math.abs(a - b);
    if (d <= DIFF_THRESHOLDS.EXACT)      acc.exact++;
    else if (d <= DIFF_THRESHOLDS.CLOSE) acc.close++;
    else                                  acc.divergent++;
    return acc;
  }, { exact: 0, close: 0, divergent: 0 });

  const total = pairs.length;
  const score = total > 0
    ? Math.round(((counts.exact + counts.close * 0.5) / total) * 100)
    : null;

  const scoreColor = score == null ? '#90a4ae'
    : score >= 85 ? '#2e7d32'
    : score >= 60 ? '#e65100'
    : '#c62828';

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '16px',
      padding: '12px 16px',
      backgroundColor: '#eceff1',
      borderTop: '2px solid #cfd8dc',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: '11px',
      flexWrap: 'wrap',
    }}>
      <div style={{ fontWeight: 700, color: '#455a64', letterSpacing: '0.05em' }}>
        ALIGNMENT SCORE
      </div>
      <div style={{
        fontSize: '24px',
        fontWeight: 900,
        color: scoreColor,
        lineHeight: 1,
      }}>
        {score != null ? `${score}%` : 'N/A'}
      </div>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <span style={{ color: '#2e7d32' }}>✅ {counts.exact} exact</span>
        <span style={{ color: '#e65100' }}>🟡 {counts.close} close</span>
        <span style={{ color: '#c62828' }}>🔴 {counts.divergent} divergent</span>
        <span style={{ color: '#78909c' }}>/ {total} compared</span>
      </div>
      {score != null && score < 85 && (
        <div style={{ color: '#b71c1c', fontWeight: 600, fontSize: '10px', flex: '1 0 100%', marginTop: '4px' }}>
          ⚠️ Divergent values detected. Check pharmacodynamics constants alignment between frontend and backend.
        </div>
      )}
      {score != null && score >= 85 && (
        <div style={{ color: '#1b5e20', fontWeight: 600, fontSize: '10px', flex: '1 0 100%', marginTop: '4px' }}>
          ✅ Frontend and backend calculations are well-aligned.
        </div>
      )}
    </div>
  );
}


export default React.memo(ActiveEffectsDisplay, (prevProps, nextProps) => {
  return (
    prevProps.patientId === nextProps.patientId &&
    prevProps.compact === nextProps.compact &&
    prevProps.showDetails === nextProps.showDetails &&
    prevProps.showNetEffect === nextProps.showNetEffect &&
    prevProps.showBaseline === nextProps.showBaseline &&
    prevProps.refreshInterval === nextProps.refreshInterval
  );
});




