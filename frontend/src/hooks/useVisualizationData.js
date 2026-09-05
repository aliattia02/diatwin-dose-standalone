/**
 * ============================================================================
 * useVisualizationData.js - Unified Visualization Hook (v3.0 Refactored)
 * ============================================================================
 *
 * SINGLE SOURCE OF TRUTH for all visualization components
 *
 * Key Features:
 * - Exposes data from BloodSugarDataContext (which delegates to services)
 * - Eliminates duplicate calculations in components
 * - Organized structure: current, pending, at-reading-time
 * - Stacking and risk analysis included
 * - Backward compatible with existing components
 *
 * Architecture:
 * Context → Services → Hook → Components
 *
 * Author: DiaTwin Team
 * Version: 3.0 (Refactored - matches new architecture)
 * ============================================================================
 */

import { useMemo, useCallback } from 'react';
import { useBloodSugarData } from '../contexts/BloodSugarDataContext';
import { useConstants } from '../contexts/ConstantsContext';

/**
 * Main visualization hook - provides unified data structure
 *
 * @param {Object} options - Optional configuration
 * @returns {Object} Unified visualization data structure
 */
export const useVisualizationData = (options = {}) => {
  const {
    // ===== CORE DATA =====
    activeEffects,                    // MOB, IOB, stacking, risk (from netEffectCalculationService)
    adjustedBaselineForProjection,    // Complete projection state
    currentEstimatedBG,               // Current BG estimate with baseline

    // ===== CHART DATA =====
    combinedData,                     // All BG data (actual + estimated)
    bloodSugarData,                   // Raw actual readings
    filteredData,                     // Filtered by time range
    last24hData,                      // Last 24h for baseline calculation
    baselineHistory,                  // Historical baselines

    // ===== SETTINGS =====
    targetGlucose,
    estimationSettings,

    // ===== ENHANCED ESTIMATION DATA =====
    velocityData,                     // Velocity/trend analysis
    nextReadingRecommendation,        // SMBG reading recommendations
    baselineShiftData,                // CGM baseline shift detection
    dataQualityMetrics,               // CGM data quality assessment
    dataSource,                       // 'smbg' or 'cgm'

    // ===== ACTIONS =====
    calculateActiveEffects,           // Refresh function

    // ===== STATE =====
    loading,
    error,

    // ===== RAW DATA FOR SPECIAL CASES =====
    recentMealsData,
    recentInsulinData,

  } = useBloodSugarData();

  const { patientConstants } = useConstants();

  // ============================================================================
  // CURRENT STATE (PAST→PRESENT)
  // What has already happened and is affecting BG NOW
  // ============================================================================

  const currentState = useMemo(() => {
    if (!adjustedBaselineForProjection) {
      return {
        baseline: targetGlucose,
        actualReading: null,
        currentEstimatedBG: targetGlucose,
        absorbedCarbs: 0,
        absorbedInsulin: 0,
        mealImpact: 0,
        insulinImpact: 0,
        currentNetEffect: 0,
        isLoading: true
      };
    }

    return {
      // Baseline (stable, calculated at reading time)
      baseline: adjustedBaselineForProjection.baselineValue || targetGlucose,
      baselineSource: adjustedBaselineForProjection.baselineSource,

      // Last actual reading
      actualReading: adjustedBaselineForProjection.actualReading,
      readingTimestamp: adjustedBaselineForProjection.readingTimestamp,
      minutesSinceReading: adjustedBaselineForProjection.minutesSinceReading,

      // Current estimated BG (Baseline + Current Net Effect)
      currentEstimatedBG: adjustedBaselineForProjection.currentEstimatedBG || targetGlucose,

      // ✅ ABSORBED AMOUNTS (what has already acted - PAST→PRESENT)
      absorbedCarbs: adjustedBaselineForProjection.currentAbsorbedCarbs || 0,
      absorbedInsulin: adjustedBaselineForProjection.currentAbsorbedInsulin || 0,

      // Current BG impacts (from absorbed amounts)
      mealImpact: adjustedBaselineForProjection.mealImpact || 0,
      insulinImpact: adjustedBaselineForProjection.insulinImpact || 0,
      currentNetEffect: adjustedBaselineForProjection.currentNetEffect || 0,

      // Status
      hasActiveEffects: adjustedBaselineForProjection.hasActiveEffects || false,
    };
  }, [adjustedBaselineForProjection, targetGlucose]);

  // ============================================================================
  // PENDING STATE (PRESENT→FUTURE)
  // What will happen based on active MOB/IOB
  // ============================================================================

  const pendingState = useMemo(() => {
    if (!adjustedBaselineForProjection) {
      return {
        activeMOB: 0,
        activeIOB: 0,
        pendingMealRise: 0,
        pendingInsulinReduction: 0,
        projectedFinalBG: targetGlucose,
        netPendingEffect: 0
      };
    }

    const pendingMealRise = adjustedBaselineForProjection.pendingMealRise || 0;
    const pendingInsulinReduction = adjustedBaselineForProjection.pendingInsulinReduction || 0;
    const netPendingEffect = pendingMealRise - pendingInsulinReduction;

    return {
      // Active amounts (what is still working - PRESENT→FUTURE)
      activeMOB: adjustedBaselineForProjection.activeMOB || 0,
      activeIOB: adjustedBaselineForProjection.activeIOB || 0,

      // Pending BG impacts
      pendingMealRise: pendingMealRise,
      pendingInsulinReduction: pendingInsulinReduction,
      netPendingEffect: netPendingEffect,

      // Projected final BG (current + pending)
      projectedFinalBG: adjustedBaselineForProjection.projectedFinalBG || targetGlucose,
    };
  }, [adjustedBaselineForProjection, targetGlucose]);

  // ============================================================================
  // AT READING TIME (Step 1 values)
  // Values at the moment of the last blood sugar reading
  // ============================================================================

  const atReadingTime = useMemo(() => {
    if (!adjustedBaselineForProjection) {
      return {
        absorbedCarbsAtReading: 0,
        absorbedInsulinAtReading: 0,
        activeMOBAtReading: 0,
        activeIOBAtReading: 0,
        mealImpactAtReading: 0,
        insulinImpactAtReading: 0,
        netEffectAtReading: 0
      };
    }

    return {
      // Absorbed amounts AT READING TIME
      absorbedCarbsAtReading: adjustedBaselineForProjection.absorbedCarbsAtReading || 0,
      absorbedInsulinAtReading: adjustedBaselineForProjection.absorbedInsulinAtReading || 0,

      // Active amounts AT READING TIME
      activeMOBAtReading: adjustedBaselineForProjection.activeMOBAtReading || 0,
      activeIOBAtReading: adjustedBaselineForProjection.activeIOBAtReading || 0,

      // BG impacts AT READING TIME
      mealImpactAtReading: adjustedBaselineForProjection.mealImpactAtReading || 0,
      insulinImpactAtReading: adjustedBaselineForProjection.insulinImpactAtReading || 0,
      netEffectAtReading: adjustedBaselineForProjection.netEffectAtReading || 0,
    };
  }, [adjustedBaselineForProjection]);

  // ============================================================================
  // MOB DETAILS (Meal On Board)
  // Detailed breakdown of meal contributions
  // ============================================================================

  const mobDetails = useMemo(() => {
    if (!activeEffects?.mob) {
      return {
        totalActiveCarbs: 0,
        totalAbsorbedCarbs: 0,
        currentBGElevation: 0,
        pendingBGRise: 0,
        mealContributions: [],
        activeMealsCount: 0,
        byAbsorptionType: {}
      };
    }

    return {
      totalActiveCarbs: activeEffects.mob.total_active_carbs || 0,
      totalAbsorbedCarbs: activeEffects.mob.total_absorbed_carbs || 0,
      currentBGElevation: activeEffects.mob.current_bg_elevation || 0,
      pendingBGRise: activeEffects.mob.pending_bg_rise || 0,
      mealContributions: activeEffects.mob.meal_contributions || [],
      activeMealsCount: activeEffects.mob.active_meals_count || 0,
      byAbsorptionType: activeEffects.mob.by_absorption_type || {},
      lastUpdate: activeEffects.mob.calculation_time
    };
  }, [activeEffects]);

  // ============================================================================
  // IOB DETAILS (Insulin On Board)
  // Detailed breakdown of insulin contributions
  // ============================================================================

  const iobDetails = useMemo(() => {
    if (!activeEffects?.iob) {
      return {
        totalActiveInsulin: 0,
        totalAbsorbedInsulin: 0,
        currentBGReduction: 0,
        pendingBGReduction: 0,
        insulinContributions: [],
        activeInsulinCount: 0,
        byInsulinType: {}
      };
    }

    // Calculate absorbed insulin from contributions
    let totalAbsorbedInsulin = 0;
    const byInsulinType = {};

    if (activeEffects.iob.insulin_contributions) {
      activeEffects.iob.insulin_contributions.forEach(contrib => {
        const initialDose = contrib.initial_dose || contrib.dose;
        const iob = contrib.iob || 0;
        const absorbed = Math.max(0, initialDose - iob);
        totalAbsorbedInsulin += absorbed;

        // Group by insulin type
        if (!byInsulinType[contrib.insulinType]) {
          byInsulinType[contrib.insulinType] = {
            totalDose: 0,
            totalIOB: 0,
            totalAbsorbed: 0,
            doses: []
          };
        }
        byInsulinType[contrib.insulinType].totalDose += initialDose;
        byInsulinType[contrib.insulinType].totalIOB += iob;
        byInsulinType[contrib.insulinType].totalAbsorbed += absorbed;
        byInsulinType[contrib.insulinType].doses.push(contrib);
      });
    }

    const correctionFactor = patientConstants?.correction_factor || 50;

    return {
      totalActiveInsulin: activeEffects.iob.total_active_insulin || 0,
      totalAbsorbedInsulin: totalAbsorbedInsulin,
      currentBGReduction: Math.abs(activeEffects.iob.bg_impact || 0),
      pendingBGReduction: (activeEffects.iob.total_active_insulin || 0) * correctionFactor,
      insulinContributions: activeEffects.iob.insulin_contributions || [],
      activeInsulinCount: activeEffects.iob.insulin_contributions?.length || 0,
      byInsulinType: byInsulinType,
      lastUpdate: activeEffects.iob.calculation_time
    };
  }, [activeEffects, patientConstants]);

  // ============================================================================
  // STACKING ANALYSIS
  // Insulin and meal stacking risk assessment
  // ============================================================================

  const stackingAnalysis = useMemo(() => {
    return {
      // Insulin stacking
      insulin: activeEffects?.insulinStacking || {
        isStacking: false,
        severity: { level: 'none', score: 0, factors: [] },
        peakOverlap: 0,
        rapidActingIOB: 0,
        longActingIOB: 0,
        recommendations: [],
        alerts: []
      },

      // Meal stacking
      meal: activeEffects?.mealStacking || {
        isStacking: false,
        severity: { level: 'none', score: 0, factors: [] },
        peakOverlap: 0,
        fastMealMOB: 0,
        slowMealMOB: 0,
        recommendations: [],
        alerts: []
      },

      // Combined stacking status
      hasAnyStacking:
        (activeEffects?.insulinStacking?.isStacking || false) ||
        (activeEffects?.mealStacking?.isStacking || false),

      maxSeverity: Math.max(
        activeEffects?.insulinStacking?.severity?.score || 0,
        activeEffects?.mealStacking?.severity?.score || 0
      )
    };
  }, [activeEffects]);

  // ============================================================================
  // RISK ASSESSMENT
  // Hypoglycemia and hyperglycemia risk
  // ============================================================================

  const riskAssessment = useMemo(() => {
    return {
      // Hypoglycemia risk
      hypo: activeEffects?.hypoRisk || {
        risk_level: 'minimal',
        risk_score: 0,
        current_bg: null,
        predicted_lowest_bg: null,
        recommendations: []
      },

      // Hyperglycemia risk
      hyper: activeEffects?.hyperRisk || {
        risk_level: 'minimal',
        risk_score: 0,
        current_bg: null,
        predicted_highest_bg: null,
        recommendations: []
      },

      // Combined risk status
      hasAnyRisk:
        (activeEffects?.hypoRisk?.risk_level !== 'minimal') ||
        (activeEffects?.hyperRisk?.risk_level !== 'minimal'),

      maxRiskScore: Math.max(
        activeEffects?.hypoRisk?.risk_score || 0,
        activeEffects?.hyperRisk?.risk_score || 0
      )
    };
  }, [activeEffects]);

  // ============================================================================
  // CONFIDENCE & METADATA
  // Information about data quality and timing
  // ============================================================================

  const metadata = useMemo(() => {
    return {
      // Confidence
      confidence: adjustedBaselineForProjection?.confidence || 'low',
      confidenceScore: adjustedBaselineForProjection?.confidenceScore || 0,
      confidenceMessage: adjustedBaselineForProjection?.confidenceMessage,

      // Timing
      timestamp: adjustedBaselineForProjection?.timestamp || Date.now(),
      readingTimestamp: adjustedBaselineForProjection?.readingTimestamp,
      minutesSinceReading: adjustedBaselineForProjection?.minutesSinceReading,

      // Status
      hasActiveEffects: adjustedBaselineForProjection?.hasActiveEffects || false,
      requiresPhysicianReview: adjustedBaselineForProjection?.requiresPhysicianReview || false,

      // Velocity (trend analysis)
      velocity: velocityData ? {
        velocity: velocityData.velocity,
        velocityPerHour: velocityData.velocityPerHour,
        trend: velocityData.trend,
        arrow: velocityData.arrow,
        message: velocityData.message,
        severity: velocityData.severity,
        direction: velocityData.direction,
        prediction: velocityData.prediction
      } : null,

      // Data source
      dataSource: dataSource,

      // Stability
      stability: adjustedBaselineForProjection?.stability || null,

      // Warnings
      warnings: adjustedBaselineForProjection?.warnings || [],

      // Enhanced estimation features
      nextReadingRecommendation: nextReadingRecommendation,
      baselineShiftData: baselineShiftData,
      dataQualityMetrics: dataQualityMetrics,
    };
  }, [
    adjustedBaselineForProjection,
    velocityData,
    nextReadingRecommendation,
    baselineShiftData,
    dataQualityMetrics,
    dataSource
  ]);

  // ============================================================================
  // CHART DATA
  // Raw data for chart visualizations
  // ============================================================================

  const chartData = useMemo(() => {
    return {
      // Blood sugar readings
      combined: combinedData || [],
      actual: bloodSugarData || [],
      filtered: filteredData || [],
      last24h: last24hData || [],

      // Baseline history
      baselineHistory: baselineHistory || [],

      // Contributions (for detailed charts)
      mealContributions: activeEffects?.mob?.meal_contributions || [],
      insulinContributions: activeEffects?.iob?.insulin_contributions || [],

      // Raw meal/insulin data
      recentMeals: recentMealsData || [],
      recentInsulin: recentInsulinData || [],
    };
  }, [
    combinedData,
    bloodSugarData,
    filteredData,
    last24hData,
    baselineHistory,
    activeEffects,
    recentMealsData,
    recentInsulinData
  ]);

  // ============================================================================
  // CHART GENERATION HELPER
  // Generates chart-ready data from context (no local calculations)
  // ============================================================================

  const generateChartDataFromContext = useCallback((timeRange, viewConfig = {}) => {
    const {
      pastHours = 8,
      futureHours = 4,
      interpolationInterval = 1,
      includeBaseline = true,
      includeMeals = true,
      includeInsulin = true
    } = viewConfig;

    const now = Date.now();
    const startTime = timeRange?.start || (now - (pastHours * 3600 * 1000));
    const endTime = timeRange?.end || (now + (futureHours * 3600 * 1000));

    // Filter actual readings
    const actualReadings = chartData.combined.filter(
      reading =>
        reading.isActualReading &&
        reading.readingTime >= startTime &&
        reading.readingTime <= endTime
    );

    // Build chart points
    const chartPoints = actualReadings.map(reading => ({
      timestamp: reading.readingTime,
      bloodSugar: reading.bloodSugar,
      isActual: true,
      isInterpolated: false,
      status: reading.status,
      ...reading
    }));

    // Add baseline line if requested
    let baselineLine = null;
    if (includeBaseline && currentState.baseline) {
      baselineLine = {
        value: currentState.baseline,
        label: 'Stable Baseline',
        color: '#999'
      };
    }

    // Add meal markers if requested
    let mealMarkers = [];
    if (includeMeals && chartData.mealContributions.length > 0) {
      mealMarkers = chartData.mealContributions
        .filter(meal => {
          const mealTime = meal.timestamp || (now - (meal.hoursSinceMeal * 3600 * 1000));
          return mealTime >= startTime && mealTime <= endTime;
        })
        .map(meal => ({
          timestamp: meal.timestamp || (now - (meal.hoursSinceMeal * 3600 * 1000)),
          type: 'meal',
          label: `${meal.mealType}: ${meal.carbEquiv}g`,
          carbs: meal.carbEquiv,
          icon: '🍽️',
          color: '#ff9800'
        }));
    }

    // Add insulin markers if requested
    let insulinMarkers = [];
    if (includeInsulin && chartData.insulinContributions.length > 0) {
      insulinMarkers = chartData.insulinContributions
        .filter(insulin => {
          const doseTime = now - (insulin.hoursSinceDose * 3600 * 1000);
          return doseTime >= startTime && doseTime <= endTime;
        })
        .map(insulin => ({
          timestamp: now - (insulin.hoursSinceDose * 3600 * 1000),
          type: 'insulin',
          label: `${insulin.dose}u ${insulin.insulinType}`,
          dose: insulin.dose,
          icon: '💉',
          color: '#2196f3'
        }));
    }

    // Sort chart points
    chartPoints.sort((a, b) => a.timestamp - b.timestamp);

    return {
      chartPoints,
      baseline: currentState.baseline,
      baselineLine,
      actualReadings,
      mealMarkers,
      insulinMarkers,
      timeRange: { start: startTime, end: endTime },

      // Include current state for reference lines
      currentEstimatedBG: currentState.currentEstimatedBG,
      projectedFinalBG: pendingState.projectedFinalBG,
    };
  }, [chartData, currentState, pendingState]);

  // ============================================================================
  // SUMMARY
  // Quick overview for dashboard widgets
  // ============================================================================

  const summary = useMemo(() => {
    return {
      // Current values
      baseline: currentState.baseline,
      currentBG: currentState.currentEstimatedBG,
      projectedBG: pendingState.projectedFinalBG,

      // Active amounts
      activeMOB: pendingState.activeMOB,
      activeIOB: pendingState.activeIOB,

      // Status indicators
      hasActiveEffects: currentState.hasActiveEffects,
      hasStacking: stackingAnalysis.hasAnyStacking,
      hasRisk: riskAssessment.hasAnyRisk,

      // Trend
      trend: metadata.velocity?.trend || 'stable',
      arrow: metadata.velocity?.arrow || '→',

      // Confidence
      confidence: metadata.confidence,
      confidenceScore: metadata.confidenceScore,

      // Warnings
      criticalAlerts: [
        ...stackingAnalysis.insulin.alerts.filter(a => a.level === 'critical'),
        ...stackingAnalysis.meal.alerts.filter(a => a.level === 'critical'),
      ],

      // Time since reading
      minutesSinceReading: metadata.minutesSinceReading,
      isStale: (metadata.minutesSinceReading || 0) > 180, // >3 hours
    };
  }, [
    currentState,
    pendingState,
    stackingAnalysis,
    riskAssessment,
    metadata
  ]);

  // ============================================================================
  // RETURN UNIFIED DATA STRUCTURE
  // ============================================================================

  return {
    // ===== STRUCTURED DATA =====

    // Current state (PAST→PRESENT: absorbed amounts, current impacts)
    currentState,

    // Pending state (PRESENT→FUTURE: active amounts, pending impacts)
    pendingState,

    // At reading time (Step 1 values)
    atReadingTime,

    // MOB details
    mob: mobDetails,

    // IOB details
    iob: iobDetails,

    // Stacking analysis
    stacking: stackingAnalysis,

    // Risk assessment
    risk: riskAssessment,

    // Confidence & metadata
    metadata,

    // Chart data
    chartData,

    // Quick summary
    summary,

    // ===== PATIENT SETTINGS =====
    patientConstants,
    targetGlucose,
    estimationSettings,

    // ===== ACTIONS =====
    refresh: calculateActiveEffects,
    generateChartData: generateChartDataFromContext,

    // ===== LOADING STATE =====
    isLoading: activeEffects?.loading || loading || false,
    error: activeEffects?.error || error || null,

    // ===== BACKWARD COMPATIBILITY =====
    // Direct access to original context data for components that need it
    activeEffects,              // Full activeEffects object
    currentEstimatedBG,         // Original currentEstimatedBG
    adjustedBaselineForProjection, // Original projection object
  };
};

export default useVisualizationData;



