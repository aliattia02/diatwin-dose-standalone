import React, { useState, useEffect, useCallback, useRef } from 'react';
import moment from 'moment';
import axios from 'axios';
import { useBloodSugarData } from '../contexts/BloodSugarDataContext';
import { useConstants } from '../contexts/ConstantsContext';
import { SHARED_CONSTANTS, getInsulinInfo } from '../constants/shared_constants';
import './Charts/new-global-viz.css';
import TimeManager from '../utils/TimeManager';
import { fetchStackedActivityEffectSafe } from '../services/activityPharmacodynamicsApi';

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
 *
 * projectedOutcome:
 *   'hypo_risk'   – insulin pending reduction outpaces remaining carb rise
 *   'hyper_risk'  – remaining carb rise outpaces insulin pending reduction
 *   'balanced'    – both active, net swing within ±20 mg/dL
 *   'iob_only'    – only insulin is meaningfully active
 *   'mob_only'    – only meal carbs are meaningfully active
 *   'critical_low' / 'critical_high' – BG out of safe range
 *   'stable'      – neither force is significant
 */
const NET_PENDING_THRESHOLD = 20;

function getProjectedAssessment(iobValue, mobValue, pendingMealRise, pendingInsulinReduction, currentBG = null) {
  const hasMeaningfulIOB = iobValue > 0.5;
  const hasMeaningfulMOB = mobValue > 5;
  const bothActive       = hasMeaningfulIOB && hasMeaningfulMOB;
  const netPending       = pendingMealRise - pendingInsulinReduction;

  // ── Critical BG states ───────────────────────────────────────────────────
  if (currentBG !== null && currentBG < 70) {
    return {
      icon: '🚨', title: 'CRITICAL LOW', titleColor: '#F44336',
      recommendation: 'Critically low blood sugar — take action immediately.',
      projectedOutcome: 'critical_low',
      cardBg: '#ffebee', borderColor: '#f44336',
    };
  }
  if (currentBG !== null && currentBG > 300) {
    return {
      icon: '🚨', title: 'CRITICAL HIGH', titleColor: '#F44336',
      recommendation: 'Critically high blood sugar — take action immediately.',
      projectedOutcome: 'critical_high',
      cardBg: '#ffebee', borderColor: '#f44336',
    };
  }

  // ── Both IOB + MOB are meaningfully active ───────────────────────────────
  if (bothActive) {
    if (netPending < -NET_PENDING_THRESHOLD) {
      return {
        icon: '⬇️', title: 'BOTH ACTIVE — FALLING RISK', titleColor: '#9C27B0',
        recommendation:
          'Insulin is outpacing meal absorption — BG is likely to fall. ' +
          'Consider a small snack if not eating again soon.',
        projectedOutcome: 'hypo_risk',
        cardBg: '#e3f2fd', borderColor: '#2196f3',
      };
    }
    if (netPending > NET_PENDING_THRESHOLD) {
      return {
        icon: '⬆️', title: 'BOTH ACTIVE — RISING RISK', titleColor: '#FF9800',
        recommendation:
          'Meal carbs are outpacing active insulin — BG is likely to rise. ' +
          'Monitor closely and consider a correction dose if needed.',
        projectedOutcome: 'hyper_risk',
        cardBg: '#fff3e0', borderColor: '#ff9800',
      };
    }
    return {
      icon: '⚖️', title: 'BOTH ACTIVE — BALANCED', titleColor: '#2196F3',
      recommendation:
        'Insulin and carbs are closely matched. Monitor BG closely over the next hour.',
      projectedOutcome: 'balanced',
      cardBg: '#e3f2fd', borderColor: '#2196f3',
    };
  }

  // ── Only IOB ─────────────────────────────────────────────────────────────
  if (hasMeaningfulIOB) {
    return {
      icon: pendingInsulinReduction > NET_PENDING_THRESHOLD ? '⬇️' : '💉',
      title: 'HIGH IOB', titleColor: '#9C27B0',
      recommendation: pendingInsulinReduction > NET_PENDING_THRESHOLD
        ? 'Active insulin may lower your BG significantly. Consider a snack if not eating soon.'
        : 'Insulin is active. Monitor BG before your next meal.',
      projectedOutcome: 'iob_only',
      cardBg: '#f3e5f5', borderColor: '#9c27b0',
    };
  }

  // ── Only MOB ─────────────────────────────────────────────────────────────
  if (hasMeaningfulMOB) {
    return {
      icon: pendingMealRise > NET_PENDING_THRESHOLD ? '⬆️' : '🍽️',
      title: 'HIGH MOB', titleColor: '#FF9800',
      recommendation: 'Carbs still absorbing — account for them before dosing again.',
      projectedOutcome: 'mob_only',
      cardBg: '#fff3e0', borderColor: '#ff9800',
    };
  }

  // ── Clear ────────────────────────────────────────────────────────────────
  return {
    icon: '✅', title: 'CLEAR', titleColor: '#4CAF50',
    recommendation: 'No significant active effects. You can eat now.',
    projectedOutcome: 'stable',
    cardBg: '#e8f5e9', borderColor: '#4caf50',
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
  const [showT1DExplainer, setShowT1DExplainer] = useState(false);

  // ── Activity PD state (non-fatal — component works fine without it) ──────
  const [activityPD, setActivityPD] = useState(null);

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

const calculateNetEffect = useCallback((force = false) => {
  // `force = true` bypasses the per-minute throttle for explicit timer-driven
  // calls. Reactive calls (from context dependency changes) use `force = false`
  // so they are still throttled to once per minute.
  const currentMinute = Math.floor(Date.now() / 60000);
  if (!force && currentMinute === lastUpdateMinuteRef.current) {
    // Skip — already updated this minute (reactive re-render guard)
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

  if (DEBUG_MODE) console.log('⏰ TIME CHECK:', {
    displayTimestamp: new Date(displayTimestamp).toLocaleTimeString(),
    readingTimestamp: readingTimestamp ? new Date(readingTimestamp).toLocaleTimeString() : 'N/A',
    minutesSinceReading: minutesSinceReading?.toFixed(2)
  });

  // Use the pre-calculated values from context
  const baseline = adjustedBaselineForProjection.baselineValue;
  const actualReading = adjustedBaselineForProjection.actualReading;
  const currentEstimatedBGValue = adjustedBaselineForProjection.currentEstimatedBG;
  const projectedFinalBG = adjustedBaselineForProjection.projectedFinalBG;

  if (DEBUG_MODE) console.log('📊 BASIC VALUES:', {
    baseline,
    actualReading,
    currentEstimatedBGValue,
    projectedFinalBG
  });

  // ✅ CHECK: Look for cumulative values in context
  if (DEBUG_MODE) {
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
  }

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

  if (DEBUG_MODE) console.log('✅ EXTRACTED VALUES FOR STEP 1 (at reading time):', {
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

  if (DEBUG_MODE) console.log('✅ EXTRACTED VALUES FOR STEP 2 (current):', {
    mealImpact,
    insulinImpact,
    currentNetEffect
  });

  // 🆕 CUMULATIVE BASELINE VALUES - The "bank balance"
  const cumulativeMealEffect = adjustedBaselineForProjection.cumulativeMealEffect || 0;
  const cumulativeInsulinEffect = adjustedBaselineForProjection.cumulativeInsulinEffect || 0;
  const cumulativeNetBaseline = adjustedBaselineForProjection.cumulativeNetBaseline || 0;

  if (DEBUG_MODE) console.log('✅ CUMULATIVE BASELINE VALUES (bank balance):', {
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

  if (DEBUG_MODE) console.log('✅ CALCULATED ABSORBED (current):', {
    currentAbsorbedCarbs,
    currentAbsorbedInsulin
  });

  // PENDING EFFECTS (PRESENT→FUTURE)
  const pendingMealRise = adjustedBaselineForProjection.pendingMealRise || 0;
  const pendingInsulinReduction = adjustedBaselineForProjection.pendingInsulinReduction || 0;
  const activeMOB = adjustedBaselineForProjection.activeMOB || 0;
  const activeIOB = adjustedBaselineForProjection.activeIOB || 0;

  if (DEBUG_MODE) console.log('✅ PENDING EFFECTS:', {
    pendingMealRise,
    pendingInsulinReduction,
    activeMOB,
    activeIOB
  });

  // ── Activity PD values (safe-access — null when fetch failed) ────────────
  const cumulativeActivityEffect = activityPD?.cumulative_activity_effect ?? 0;
  const sensitivityMultiplier    = activityPD?.sensitivity_multiplier ?? 1.0;
  const activityOnBoard          = activityPD?.activity_on_board ?? 0;
  const activeSessions           = activityPD?.active_sessions ?? 0;
  const activityContributions    = activityPD?.activity_contributions ?? [];
  const effectiveISF             = activityPD?.effective_correction_factor ?? (patientConstants?.correction_factor || 40);
  const effectiveCR              = activityPD?.effective_carb_to_bg_ratio  ?? (patientConstants?.carb_to_bg_ratio || patientConstants?.carb_to_bg_factor || 4);

  // NOTE: currentEstimatedBGValue is sourced from adjustedBaselineForProjection.currentEstimatedBG,
  // which is computed in BloodSugarDataContext as:
  //   effectiveBaseline + cumulativeNetBaseline
  // where cumulativeNetBaseline already includes cumulativeActivityEffect (added via C-1 fix).
  // Adding cumulativeActivityEffect again here would double-count the exercise BG drop.
  const correctedEstimatedBG = currentEstimatedBGValue;

  // CREATE THE RESULT OBJECT
  const resultObject = {
    // The stable baseline
    baseline: Math.round(baseline),
    currentEstimatedBG: Math.round(correctedEstimatedBG),
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

    // ── Activity PD fields ───────────────────────────────────────────────────
    cumulativeActivityEffect: Math.round(cumulativeActivityEffect * 10) / 10,
    sensitivityMultiplier,
    activityOnBoard:       Math.round(activityOnBoard * 10) / 10,
    activeSessions,
    activityContributions,
    effectiveISF:          Math.round(effectiveISF * 10) / 10,
    effectiveCR:           Math.round(effectiveCR * 100) / 100,

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
    projected: Math.round(correctedEstimatedBG),
  };

  if (DEBUG_MODE) {
    console.log('📦 FINAL RESULT OBJECT BEING SET:', resultObject);
    console.log('🔍 ==================== calculateNetEffect DIAGNOSTIC END ====================');
  }

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
   * Minute-boundary data fetch
   *
   * Replaces the old dumb 2-minute setInterval.  We sync to the wall-clock
   * :00 boundary so this fires at the same instant as the context's own
   * calculateActiveEffects interval, giving the context fresh BG readings
   * before it recomputes pharmacokinetics.
   *
   * fetchLast24hData → context recalculates → adjustedBaselineForProjection
   * changes → the reactive useEffect below calls calculateNetEffect().
   */
  useEffect(() => {
    if (DEBUG_MODE) console.log('🚀 ActiveEffectsDisplay: mounting — initial data fetch');
    fetchLast24hData?.();

    const now = new Date();
    const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    let intervalId = null;

    const syncTimeout = setTimeout(() => {
      if (DEBUG_MODE) {
        console.log(`🔄 ActiveEffects: fetchLast24hData synced to minute boundary at ${new Date().toLocaleTimeString()}`);
      }
      fetchLast24hData?.();
      intervalId = setInterval(() => {
        if (DEBUG_MODE) {
          console.log(`🔄 ActiveEffects: fetchLast24hData minute tick at ${new Date().toLocaleTimeString()}`);
        }
        fetchLast24hData?.();
      }, 60000);
    }, msUntilNextMinute);

    return () => {
      clearTimeout(syncTimeout);
      if (intervalId) clearInterval(intervalId);
    };
  }, [fetchLast24hData]);

  // ── Activity PD fetch (non-fatal) ─────────────────────────────────────────
  // Fires once on mount and on every minute-boundary sync alongside the
  // existing fetchLast24hData call.  Failure returns null and the component
  // continues rendering without activity data.
  useEffect(() => {
    let cancelled = false;

    async function fetchActivityPD() {
      const data = await fetchStackedActivityEffectSafe();
      if (!cancelled) setActivityPD(data);
    }

    fetchActivityPD();

    // Sync to minute boundary so this fires at the same tick as the context update
    const now = new Date();
    const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    let intervalId = null;

    const syncTimeout = setTimeout(() => {
      fetchActivityPD();
      intervalId = setInterval(fetchActivityPD, 60000);
    }, msUntilNextMinute);

    return () => {
      cancelled = true;
      clearTimeout(syncTimeout);
      if (intervalId) clearInterval(intervalId);
    };
  }, []); // no deps — fetch is self-contained



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
 * Reactive display refresh
 *
 * Replaces the old timer that depended on currentEstimatedBG.  That approach
 * restarted the entire timeout/interval chain every time the context pushed an
 * update, which drifted the timer and could race with lastUpdateMinuteRef.
 *
 * Instead we simply watch adjustedBaselineForProjection — the one object that
 * holds every value calculateNetEffect reads.  Whenever the context recomputes
 * pharmacokinetics (at each minute boundary, or after a data fetch) this fires,
 * and the lastUpdateMinuteRef throttle prevents more than one render per minute.
 *
 * Initial render: we call calculateNetEffect(true) with force=true so the very
 * first paint is never skipped even if the mount happens mid-minute.
 */
useEffect(() => {
  if (!adjustedBaselineForProjection || adjustedBaselineForProjection.baselineValue === null) {
    return;
  }

  // On first render, force past the per-minute throttle so we always show
  // data immediately — even if another call happened earlier this minute.
  const isFirstRender = lastUpdateMinuteRef.current === null;
  calculateNetEffect(isFirstRender);

  if (DEBUG_MODE) {
    console.log(`📊 ActiveEffects: adjustedBaselineForProjection changed — recalculating (force=${isFirstRender})`);
  }
}, [adjustedBaselineForProjection, calculateNetEffect]);



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
   * Update timing assessment when IOB/MOB or net effect changes.
   * Pass netEffectData so the assessment can use projected pending effects.
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
          {/* ── Last Meter Reading Badge ── */}
          {netEffectData?.actualReading ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                background: (() => {
                  const v = netEffectData.actualReading;
                  if (v < effectiveTargetGlucose * 0.7) return '#fff3e0';
                  if (v > effectiveTargetGlucose * 1.3) return '#fce4ec';
                  return '#e8f5e9';
                })(),
                border: `2px solid ${(() => {
                  const v = netEffectData.actualReading;
                  if (v < effectiveTargetGlucose * 0.7) return '#ff9800';
                  if (v > effectiveTargetGlucose * 1.3) return '#f44336';
                  return '#4caf50';
                })()}`,
                borderRadius: '10px',
                padding: '6px 14px',
                minWidth: '110px',
                textAlign: 'center',
                flexShrink: 0,
              }}
              onClick={e => e.stopPropagation()}
            >
              <div style={{ fontSize: '10px', color: '#666', fontWeight: 500, letterSpacing: '0.5px' }}>
                📱 LAST READING
              </div>
              <div style={{
                fontSize: '22px',
                fontWeight: 800,
                lineHeight: 1.1,
                color: (() => {
                  const v = netEffectData.actualReading;
                  if (v < effectiveTargetGlucose * 0.7) return '#e65100';
                  if (v > effectiveTargetGlucose * 1.3) return '#c62828';
                  return '#2e7d32';
                })(),
              }}>
                {netEffectData.actualReading}
                <span style={{ fontSize: '11px', fontWeight: 400, color: '#888', marginLeft: '2px' }}>mg/dL</span>
              </div>
              <div style={{ fontSize: '11px', color: '#888', marginTop: '2px' }}>
                {netEffectData.lastReadingTime
                  ? (() => {
                      const mins = netEffectData.minutesSinceReading
                        ?? ((Date.now() - netEffectData.lastReadingTime) / 60000);
                      const roundedMins = Math.round(mins);
                      if (roundedMins < 1)  return 'just now';
                      if (roundedMins < 60) return `${roundedMins} min ago`;
                      const hrs = Math.floor(roundedMins / 60);
                      const rem = roundedMins % 60;
                      return rem > 0 ? `${hrs}h ${rem}m ago` : `${hrs}h ago`;
                    })()
                  : '—'}
              </div>
              {netEffectData.lastReadingTime && (
                <div style={{ fontSize: '10px', color: '#aaa', marginTop: '1px' }}>
                  {new Date(netEffectData.lastReadingTime).toLocaleTimeString([], {
                    hour: '2-digit', minute: '2-digit'
                  })}
                </div>
              )}
            </div>
          ) : (
            <div
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                background: '#f5f5f5', border: '2px dashed #ccc',
                borderRadius: '10px', padding: '6px 14px', minWidth: '110px', textAlign: 'center',
              }}
              onClick={e => e.stopPropagation()}
            >
              <div style={{ fontSize: '10px', color: '#999', fontWeight: 500 }}>📱 LAST READING</div>
              <div style={{ fontSize: '14px', color: '#bbb', margin: '4px 0' }}>—</div>
              <div style={{ fontSize: '10px', color: '#bbb' }}>No reading yet</div>
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
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

              {/* ── Activity On Board (AOB) Card ──────────────────────────────────────────
                   Visible when:
                     • Sessions are currently active (activeSessions > 0), OR
                     • There is a remaining acute BG drop (cumulativeActivityEffect !== 0), OR
                     • Post-exercise W window is still open (sensitivityMultiplier > 1.0)
              */}
              {netEffectData && (netEffectData.activeSessions > 0 || netEffectData.cumulativeActivityEffect !== 0 || netEffectData.sensitivityMultiplier > 1.0) && (
                <div style={{
                  background: '#e8f5e9',
                  border: '1px solid #4CAF50',
                  borderRadius: '8px',
                  padding: '12px',
                  marginBottom: '12px',
                }}>
                  {/* Header row */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontWeight: 600, fontSize: '13px', color: '#2e7d32' }}>
                      🏃 Activity On Board
                    </span>
                    {netEffectData.activeSessions > 0 && (
                      <span style={{
                        background: '#4CAF50', color: '#fff',
                        borderRadius: '12px', padding: '2px 8px', fontSize: '11px',
                      }}>
                        {netEffectData.activeSessions} active session{netEffectData.activeSessions !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>

                  {/* Metrics row */}
                  <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                    {(netEffectData.cumulativeActivityEffect !== 0 || netEffectData.activeSessions > 0) && (
                      <div>
                        <div style={{ fontSize: '11px', color: '#666' }}>Current Effect</div>
                        <div style={{ fontSize: '16px', fontWeight: 700, color: netEffectData.cumulativeActivityEffect < 0 ? '#2e7d32' : '#c62828' }}>
                          {netEffectData.cumulativeActivityEffect > 0 ? '+' : ''}{fmt(netEffectData.cumulativeActivityEffect)} mg/dL
                        </div>
                      </div>
                    )}
                    {netEffectData.activityOnBoard > 0 && (
                      <div>
                        <div style={{ fontSize: '11px', color: '#666' }}>Remaining Drop (AOB)</div>
                        <div style={{ fontSize: '16px', fontWeight: 700, color: '#1565c0' }}>
                          {fmt(netEffectData.activityOnBoard)} mg/dL
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Intensity badges from activity_contributions */}
                  {netEffectData.activityContributions?.length > 0 && (
                    <div style={{ marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      {netEffectData.activityContributions.map((contrib, idx) => (
                        <span key={idx} style={{
                          background: contrib.intensity === 'vigorous' ? '#ef9a9a'
                                     : contrib.intensity === 'moderate' ? '#fff9c4'
                                     : '#e1f5fe',
                          border: '1px solid #ccc',
                          borderRadius: '10px',
                          padding: '2px 8px',
                          fontSize: '11px',
                          color: '#333',
                        }}>
                          {contrib.intensity} · {Math.round(contrib.duration_minutes)} min
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Post-exercise sensitivity badge — visible during W window even when Z ≈ 0 */}
                  {netEffectData.sensitivityMultiplier > 1.0 && (
                    <div style={{
                      marginTop: '8px',
                      background: '#fff8e1',
                      border: '1px solid #ffca28',
                      borderRadius: '6px',
                      padding: '6px 10px',
                      fontSize: '12px',
                      color: '#5d4037',
                    }}>
                      ⚡ Post-exercise ×{netEffectData.sensitivityMultiplier.toFixed(2)} — ISF boosted to {fmt(netEffectData.effectiveISF)} mg/dL/u
                      <br />
                      <span style={{ fontSize: '10px', color: '#795548' }}>
                        Enhanced insulin sensitivity still active (GLUT4 upregulation)
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Timing Assessment Card — in left column */}
              {(() => {
                const pendingMealRise         = netEffectData?.pendingMealRise         || 0;
                const pendingInsulinReduction = netEffectData?.pendingInsulinReduction || 0;
                const netPending              = pendingMealRise - pendingInsulinReduction;
                const bothActive              = displayIobValue > 0.5 && displayMobValue > 5;

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

                    {/* Header */}
                    <div className="active-effects-assessment-header">
                      <span className="active-effects-assessment-icon">{assessment.icon}</span>
                      <strong style={{ color: assessment.titleColor }}>{assessment.title}</strong>
                    </div>

                    {/* IOB + MOB chips */}
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

                    {/* Recommendation */}
                    <div className="active-effects-recommendation">
                      {assessment.recommendation}
                    </div>

                    {/* Projected net pending — shown whenever either force is active */}
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

                    {/* Slow-meal note from timing assessment if present */}
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

                  {/* Actual Reading */}
                  {netEffectData.actualReading && (
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
      {(netEffectData.cumulativeActivityEffect !== 0 || netEffectData.sensitivityMultiplier > 1.0) && (
        <span style={{ color: '#2e7d32', fontSize: '12px' }}>
          {' '}{netEffectData.cumulativeActivityEffect <= 0 ? '−' : '+'} ΔActivity ({Math.abs(netEffectData.cumulativeActivityEffect).toFixed(1)} mg/dL)
        </span>
      )}
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

        </>
      )}
    </div>
  );
};




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