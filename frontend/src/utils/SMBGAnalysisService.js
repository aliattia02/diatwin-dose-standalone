/**
 * ============================================================================
 * SMBG ANALYSIS SERVICE
 * ============================================================================
 *
 * Specialized service for Self-Monitoring Blood Glucose (SMBG) use cases.
 * Focuses on sparse data scenarios with 4-8 readings per day.
 *
 * Key Features:
 * - Reading priority calculation (High/Medium/Low)
 * - Confidence-based opacity mapping for visualizations
 * - Adaptive reminder scheduling
 * - Compliance and adherence tracking
 * - Unreported event inference
 * - Risk assessment (hypo/hyper predictions)
 * - Gap warning system
 *
 * Author: DiaTwin Team
 * Version: 1.0 (Initial SMBG Specialization)
 * ============================================================================
 */

import TimeManager from './TimeManager.js';
import {
  calculateIOB,
  calculateInsulinActivity
} from './insulinPharmacodynamics.js';
import {
  calculateMOB,
  calculateMealActivity
} from './mealPharmacodynamics.js';

// ============================================================================
// CONSTANTS
// ============================================================================

export const SMBG_CONSTANTS = {
  // Reading priority thresholds (minutes since last reading)
  PRIORITY_THRESHOLDS: {
    CRITICAL: 360,      // 6 hours - URGENT reading needed
    HIGH: 240,          // 4 hours - High priority
    MEDIUM: 180,        // 3 hours - Medium priority
    LOW: 120,           // 2 hours - Low priority
    ROUTINE: 60         // 1 hour - Routine check
  },

  // Confidence opacity levels (for visualization)
  CONFIDENCE_OPACITY: {
    VERY_HIGH: 1.0,     // <1h since reading
    HIGH: 0.75,         // 1-2h since reading
    MEDIUM: 0.50,       // 2-4h since reading
    LOW: 0.30,          // 4-6h since reading
    VERY_LOW: 0.15      // >6h since reading
  },

  // Gap warning thresholds
  GAP_WARNINGS: {
    CAUTION: 180,       // 3 hours - Show caution
    WARNING: 240,       // 4 hours - Show warning
    DANGER: 360         // 6 hours - Show danger
  },

  // Risk assessment thresholds
  RISK_THRESHOLDS: {
    HYPO_RISK_HIGH: 80,     // mg/dL - High hypo risk
    HYPO_RISK_MEDIUM: 90,   // mg/dL - Medium hypo risk
    HYPER_RISK_HIGH: 250,   // mg/dL - High hyper risk
    HYPER_RISK_MEDIUM: 200  // mg/dL - Medium hyper risk
  },

  // Compliance targets
  COMPLIANCE_TARGETS: {
    MIN_READINGS_PER_DAY: 4,
    IDEAL_READINGS_PER_DAY: 6,
    MAX_GAP_HOURS: 6
  },

  // Event inference thresholds
  INFERENCE_THRESHOLDS: {
    UNEXPLAINED_RISE: 40,    // mg/dL - Suggest unreported meal
    UNEXPLAINED_FALL: 30,    // mg/dL - Suggest unreported insulin
    VELOCITY_THRESHOLD: 2    // mg/dL/min - Rapid change detection
  }
};

// ============================================================================
// READING PRIORITY CALCULATION
// ============================================================================

/**
 * Calculate reading priority based on multiple factors
 * 
 * @param {Object} params - Priority calculation parameters
 * @param {number} params.minutesSinceReading - Minutes since last BG reading
 * @param {number} params.currentEstimate - Current estimated BG (mg/dL)
 * @param {number} params.iob - Insulin on board
 * @param {number} params.mob - Meal on board
 * @param {number} params.netEffect - Net effect (mg/dL/min)
 * @param {string} params.timeOfDay - Time of day ('morning'|'afternoon'|'evening'|'night')
 * @param {boolean} params.hasActiveEffects - Whether there are active meal/insulin effects
 * @returns {Object} Priority assessment
 */
export function calculateReadingPriority({
  minutesSinceReading = 0,
  currentEstimate = 100,
  iob = 0,
  mob = 0,
  netEffect = 0,
  timeOfDay = 'afternoon',
  hasActiveEffects = false
}) {
  let priority = 'LOW';
  let score = 0;
  let reasons = [];

  // Factor 1: Time since last reading (40% weight)
  if (minutesSinceReading >= SMBG_CONSTANTS.PRIORITY_THRESHOLDS.CRITICAL) {
    score += 40;
    reasons.push(`${Math.floor(minutesSinceReading / 60)}h ${minutesSinceReading % 60}min since last reading`);
  } else if (minutesSinceReading >= SMBG_CONSTANTS.PRIORITY_THRESHOLDS.HIGH) {
    score += 30;
    reasons.push(`${Math.floor(minutesSinceReading / 60)}h since last reading`);
  } else if (minutesSinceReading >= SMBG_CONSTANTS.PRIORITY_THRESHOLDS.MEDIUM) {
    score += 20;
  } else if (minutesSinceReading >= SMBG_CONSTANTS.PRIORITY_THRESHOLDS.LOW) {
    score += 10;
  }

  // Factor 2: Estimated BG level (30% weight)
  if (currentEstimate <= SMBG_CONSTANTS.RISK_THRESHOLDS.HYPO_RISK_HIGH) {
    score += 30;
    reasons.push(`Low BG risk (${Math.round(currentEstimate)} mg/dL)`);
  } else if (currentEstimate <= SMBG_CONSTANTS.RISK_THRESHOLDS.HYPO_RISK_MEDIUM) {
    score += 20;
    reasons.push(`Borderline low (${Math.round(currentEstimate)} mg/dL)`);
  } else if (currentEstimate >= SMBG_CONSTANTS.RISK_THRESHOLDS.HYPER_RISK_HIGH) {
    score += 25;
    reasons.push(`High BG (${Math.round(currentEstimate)} mg/dL)`);
  } else if (currentEstimate >= SMBG_CONSTANTS.RISK_THRESHOLDS.HYPER_RISK_MEDIUM) {
    score += 15;
    reasons.push(`Elevated BG (${Math.round(currentEstimate)} mg/dL)`);
  }

  // Factor 3: Active effects (20% weight)
  if (hasActiveEffects) {
    if (iob > 0 && mob > 0) {
      score += 20;
      reasons.push('Both insulin and meal active');
    } else if (iob > 0) {
      score += 15;
      reasons.push('Insulin active');
    } else if (mob > 0) {
      score += 10;
      reasons.push('Meal active');
    }
  }

  // Factor 4: Rate of change (10% weight)
  const absVelocity = Math.abs(netEffect);
  if (absVelocity >= SMBG_CONSTANTS.INFERENCE_THRESHOLDS.VELOCITY_THRESHOLD) {
    score += 10;
    const direction = netEffect > 0 ? 'rising' : 'falling';
    reasons.push(`Rapid ${direction} (${Math.abs(netEffect).toFixed(1)} mg/dL/min)`);
  }

  // Determine priority level based on total score
  if (score >= 60) {
    priority = 'CRITICAL';
  } else if (score >= 40) {
    priority = 'HIGH';
  } else if (score >= 25) {
    priority = 'MEDIUM';
  } else {
    priority = 'LOW';
  }

  // Add time-of-day specific recommendations
  const timeRecommendations = getTimeOfDayRecommendations(timeOfDay, minutesSinceReading);
  if (timeRecommendations) {
    reasons.push(timeRecommendations);
  }

  return {
    priority,
    score,
    reasons,
    color: getPriorityColor(priority),
    icon: getPriorityIcon(priority),
    recommendation: getPriorityRecommendation(priority, reasons)
  };
}

/**
 * Get time-of-day specific recommendations
 */
function getTimeOfDayRecommendations(timeOfDay, minutesSinceReading) {
  const hour = new Date().getHours();
  
  // Morning fasting check
  if (hour >= 6 && hour < 9 && minutesSinceReading > 480) {
    return 'Fasting BG check recommended';
  }
  
  // Pre-meal checks
  if ((hour >= 11 && hour < 13) || (hour >= 17 && hour < 19)) {
    if (minutesSinceReading > 180) {
      return 'Pre-meal check recommended';
    }
  }
  
  // Bedtime check
  if (hour >= 21 && hour < 23 && minutesSinceReading > 180) {
    return 'Bedtime check recommended';
  }
  
  return null;
}

/**
 * Get priority color code
 */
function getPriorityColor(priority) {
  const colors = {
    CRITICAL: '#D32F2F',  // Red
    HIGH: '#F57C00',      // Orange
    MEDIUM: '#FFA726',    // Light orange
    LOW: '#66BB6A'        // Green
  };
  return colors[priority] || '#9E9E9E';
}

/**
 * Get priority icon
 */
function getPriorityIcon(priority) {
  const icons = {
    CRITICAL: '🔴',
    HIGH: '🟠',
    MEDIUM: '🟡',
    LOW: '🟢'
  };
  return icons[priority] || '⚪';
}

/**
 * Get priority recommendation text
 */
function getPriorityRecommendation(priority, reasons) {
  const recommendations = {
    CRITICAL: 'Test NOW - Critical reading needed',
    HIGH: 'Test soon - High priority reading',
    MEDIUM: 'Test when convenient - Recommended',
    LOW: 'No urgent testing needed'
  };
  
  let rec = recommendations[priority];
  if (reasons.length > 0) {
    rec += ` (${reasons[0]})`;
  }
  
  return rec;
}

// ============================================================================
// CONFIDENCE OPACITY MAPPING
// ============================================================================

/**
 * Map confidence to opacity for visualization
 * 
 * @param {number} minutesSinceReading - Minutes since last BG reading
 * @param {string} lineStyle - Optional line style override ('solid'|'dashed'|'dotted')
 * @returns {Object} Opacity and style settings
 */
export function mapConfidenceToOpacity(minutesSinceReading, lineStyle = null) {
  let opacity, style, label;

  if (minutesSinceReading < 60) {
    opacity = SMBG_CONSTANTS.CONFIDENCE_OPACITY.VERY_HIGH;
    style = 'solid';
    label = 'Very High Confidence (<1h)';
  } else if (minutesSinceReading < 120) {
    opacity = SMBG_CONSTANTS.CONFIDENCE_OPACITY.HIGH;
    style = 'solid';
    label = 'High Confidence (1-2h)';
  } else if (minutesSinceReading < 240) {
    opacity = SMBG_CONSTANTS.CONFIDENCE_OPACITY.MEDIUM;
    style = 'solid';
    label = 'Medium Confidence (2-4h)';
  } else if (minutesSinceReading < 360) {
    opacity = SMBG_CONSTANTS.CONFIDENCE_OPACITY.LOW;
    style = 'solid';
    label = 'Low Confidence (4-6h)';
  } else {
    opacity = SMBG_CONSTANTS.CONFIDENCE_OPACITY.VERY_LOW;
    style = lineStyle || 'dotted';
    label = 'Very Low Confidence (>6h)';
  }

  return {
    opacity,
    style,
    label,
    strokeDasharray: getStrokeDashArray(style),
    color: getConfidenceColor(opacity)
  };
}

/**
 * Get stroke dash array for line style
 */
function getStrokeDashArray(style) {
  const dashArrays = {
    solid: '0',
    dashed: '5 5',
    dotted: '2 3'
  };
  return dashArrays[style] || '0';
}

/**
 * Get confidence color (purple gradient)
 */
function getConfidenceColor(opacity) {
  // Map opacity to purple color intensity
  const alpha = Math.floor(opacity * 255).toString(16).padStart(2, '0');
  return `#8031A7${alpha}`;
}

// ============================================================================
// GAP WARNING SYSTEM
// ============================================================================

/**
 * Get gap warning level and message
 * 
 * @param {number} minutesSinceReading - Minutes since last reading
 * @param {boolean} hasActiveEffects - Whether active effects present
 * @returns {Object} Warning information
 */
export function getGapWarning(minutesSinceReading, hasActiveEffects = false) {
  if (minutesSinceReading < SMBG_CONSTANTS.GAP_WARNINGS.CAUTION) {
    return {
      level: 'none',
      message: null,
      color: '#4CAF50',
      showWarning: false
    };
  }

  const hours = Math.floor(minutesSinceReading / 60);
  const mins = minutesSinceReading % 60;
  const timeStr = hours > 0 ? `${hours}h ${mins}min` : `${mins}min`;

  if (minutesSinceReading >= SMBG_CONSTANTS.GAP_WARNINGS.DANGER) {
    return {
      level: 'danger',
      message: `⚠️ CRITICAL: No reading for ${timeStr} - Test NOW`,
      color: '#D32F2F',
      showWarning: true,
      urgent: true
    };
  }

  if (minutesSinceReading >= SMBG_CONSTANTS.GAP_WARNINGS.WARNING) {
    return {
      level: 'warning',
      message: `⚠️ WARNING: No reading for ${timeStr} - Test soon`,
      color: '#F57C00',
      showWarning: true,
      urgent: hasActiveEffects
    };
  }

  if (minutesSinceReading >= SMBG_CONSTANTS.GAP_WARNINGS.CAUTION) {
    return {
      level: 'caution',
      message: `⚡ CAUTION: ${timeStr} since last reading`,
      color: '#FFA726',
      showWarning: true,
      urgent: false
    };
  }

  return {
    level: 'none',
    message: null,
    color: '#4CAF50',
    showWarning: false
  };
}

// ============================================================================
// RISK ASSESSMENT
// ============================================================================

/**
 * Assess hypo/hyper risks
 * 
 * @param {Object} params - Risk assessment parameters
 * @param {number} params.currentBG - Current/estimated BG
 * @param {number} params.iob - Insulin on board
 * @param {number} params.mob - Meal on board
 * @param {number} params.netEffect - Net effect (mg/dL/min)
 * @param {number} params.projectedBG_1h - 1-hour projection
 * @param {string} params.timeOfDay - Time of day
 * @returns {Object} Risk assessment
 */
export function assessRisks({
  currentBG = 100,
  iob = 0,
  mob = 0,
  netEffect = 0,
  projectedBG_1h = 100,
  timeOfDay = 'afternoon'
}) {
  const risks = {
    hypo: { level: 'none', score: 0, factors: [] },
    hyper: { level: 'none', score: 0, factors: [] }
  };

  // === HYPO RISK ASSESSMENT ===
  
  // Current BG level
  if (currentBG <= SMBG_CONSTANTS.RISK_THRESHOLDS.HYPO_RISK_HIGH) {
    risks.hypo.score += 40;
    risks.hypo.factors.push(`Current BG low (${Math.round(currentBG)} mg/dL)`);
  } else if (currentBG <= SMBG_CONSTANTS.RISK_THRESHOLDS.HYPO_RISK_MEDIUM) {
    risks.hypo.score += 20;
    risks.hypo.factors.push(`BG borderline (${Math.round(currentBG)} mg/dL)`);
  }

  // Projected BG
  if (projectedBG_1h <= SMBG_CONSTANTS.RISK_THRESHOLDS.HYPO_RISK_HIGH) {
    risks.hypo.score += 30;
    risks.hypo.factors.push(`Projected to drop to ${Math.round(projectedBG_1h)} mg/dL`);
  }

  // High IOB
  if (iob > 1.0) {
    risks.hypo.score += 20;
    risks.hypo.factors.push(`High insulin on board (${iob.toFixed(1)}U)`);
  }

  // Falling rapidly
  if (netEffect < -1.5) {
    risks.hypo.score += 15;
    risks.hypo.factors.push(`Falling rapidly (${Math.abs(netEffect).toFixed(1)} mg/dL/min)`);
  }

  // Nighttime (higher hypo risk)
  const hour = new Date().getHours();
  if (hour >= 22 || hour < 6) {
    risks.hypo.score += 10;
    risks.hypo.factors.push('Nighttime (higher risk)');
  }

  // === HYPER RISK ASSESSMENT ===
  
  // Current BG level
  if (currentBG >= SMBG_CONSTANTS.RISK_THRESHOLDS.HYPER_RISK_HIGH) {
    risks.hyper.score += 40;
    risks.hyper.factors.push(`Current BG high (${Math.round(currentBG)} mg/dL)`);
  } else if (currentBG >= SMBG_CONSTANTS.RISK_THRESHOLDS.HYPER_RISK_MEDIUM) {
    risks.hyper.score += 20;
    risks.hyper.factors.push(`BG elevated (${Math.round(currentBG)} mg/dL)`);
  }

  // Projected BG
  if (projectedBG_1h >= SMBG_CONSTANTS.RISK_THRESHOLDS.HYPER_RISK_HIGH) {
    risks.hyper.score += 30;
    risks.hyper.factors.push(`Projected to rise to ${Math.round(projectedBG_1h)} mg/dL`);
  }

  // High MOB without insulin
  if (mob > 30 && iob < 0.5) {
    risks.hyper.score += 20;
    risks.hyper.factors.push(`Meal active without sufficient insulin`);
  }

  // Rising rapidly
  if (netEffect > 1.5) {
    risks.hyper.score += 15;
    risks.hyper.factors.push(`Rising rapidly (${netEffect.toFixed(1)} mg/dL/min)`);
  }

  // Determine risk levels
  if (risks.hypo.score >= 50) {
    risks.hypo.level = 'high';
    risks.hypo.color = '#D32F2F';
    risks.hypo.message = '🔴 HIGH HYPO RISK - Test and treat if needed';
  } else if (risks.hypo.score >= 30) {
    risks.hypo.level = 'medium';
    risks.hypo.color = '#F57C00';
    risks.hypo.message = '🟠 MEDIUM HYPO RISK - Monitor closely';
  } else if (risks.hypo.score > 0) {
    risks.hypo.level = 'low';
    risks.hypo.color = '#FFA726';
    risks.hypo.message = '🟡 LOW HYPO RISK - Stay aware';
  }

  if (risks.hyper.score >= 50) {
    risks.hyper.level = 'high';
    risks.hyper.color = '#D32F2F';
    risks.hyper.message = '🔴 HIGH HYPER RISK - Consider correction';
  } else if (risks.hyper.score >= 30) {
    risks.hyper.level = 'medium';
    risks.hyper.color = '#F57C00';
    risks.hyper.message = '🟠 MEDIUM HYPER RISK - Monitor';
  } else if (risks.hyper.score > 0) {
    risks.hyper.level = 'low';
    risks.hyper.color = '#FFA726';
    risks.hyper.message = '🟡 LOW HYPER RISK - Stay aware';
  }

  return risks;
}

// ============================================================================
// COMPLIANCE TRACKING
// ============================================================================

/**
 * Analyze reading compliance/adherence
 * 
 * @param {Array} readings - Array of BG readings with timestamps
 * @param {number} daysToAnalyze - Number of days to analyze (default 7)
 * @param {number} targetReadingsPerDay - Target readings per day
 * @returns {Object} Compliance analysis
 */
export function analyzeCompliance(
  readings = [],
  daysToAnalyze = 7,
  targetReadingsPerDay = SMBG_CONSTANTS.COMPLIANCE_TARGETS.IDEAL_READINGS_PER_DAY
) {
  if (!readings || readings.length === 0) {
    return {
      averageReadingsPerDay: 0,
      complianceRate: 0,
      missedDays: daysToAnalyze,
      longestGapHours: 0,
      recommendation: 'No readings found'
    };
  }

  // Group readings by day
  const readingsByDay = {};
  const now = Date.now();
  const startTime = now - (daysToAnalyze * 24 * 60 * 60 * 1000);

  readings.forEach(reading => {
    if (reading.timestamp >= startTime) {
      const date = new Date(reading.timestamp).toDateString();
      if (!readingsByDay[date]) {
        readingsByDay[date] = [];
      }
      readingsByDay[date].push(reading);
    }
  });

  const daysWithReadings = Object.keys(readingsByDay).length;
  const totalReadings = Object.values(readingsByDay).reduce((sum, day) => sum + day.length, 0);
  const averageReadingsPerDay = daysWithReadings > 0 ? totalReadings / daysWithReadings : 0;

  // Calculate compliance rate
  const complianceRate = Math.min(100, (averageReadingsPerDay / targetReadingsPerDay) * 100);

  // Find longest gap
  let longestGapHours = 0;
  const sortedReadings = [...readings].sort((a, b) => a.timestamp - b.timestamp);
  for (let i = 1; i < sortedReadings.length; i++) {
    const gapMs = sortedReadings[i].timestamp - sortedReadings[i - 1].timestamp;
    const gapHours = gapMs / (60 * 60 * 1000);
    if (gapHours > longestGapHours) {
      longestGapHours = gapHours;
    }
  }

  // Generate recommendation
  let recommendation;
  let recommendationColor;
  
  if (complianceRate >= 90) {
    recommendation = '✅ Excellent adherence - Keep it up!';
    recommendationColor = '#4CAF50';
  } else if (complianceRate >= 70) {
    recommendation = '👍 Good adherence - Small improvements possible';
    recommendationColor = '#66BB6A';
  } else if (complianceRate >= 50) {
    recommendation = '⚡ Fair adherence - Try to test more regularly';
    recommendationColor = '#FFA726';
  } else {
    recommendation = '⚠️ Low adherence - More frequent testing recommended';
    recommendationColor = '#F57C00';
  }

  return {
    daysAnalyzed: daysToAnalyze,
    daysWithReadings,
    missedDays: daysToAnalyze - daysWithReadings,
    totalReadings,
    averageReadingsPerDay: Math.round(averageReadingsPerDay * 10) / 10,
    complianceRate: Math.round(complianceRate),
    longestGapHours: Math.round(longestGapHours * 10) / 10,
    recommendation,
    recommendationColor,
    status: complianceRate >= 70 ? 'good' : complianceRate >= 50 ? 'fair' : 'poor'
  };
}

// ============================================================================
// EVENT INFERENCE
// ============================================================================

/**
 * Infer unreported events (meals, insulin) based on BG changes
 * 
 * @param {Array} readings - Recent BG readings
 * @param {Array} reportedMeals - Reported meals
 * @param {Array} reportedInsulin - Reported insulin doses
 * @returns {Array} Inferred events
 */
export function inferUnreportedEvents(readings, reportedMeals = [], reportedInsulin = []) {
  if (!readings || readings.length < 2) {
    return [];
  }

  const inferences = [];
  const sortedReadings = [...readings].sort((a, b) => a.timestamp - b.timestamp);

  for (let i = 1; i < sortedReadings.length; i++) {
    const prev = sortedReadings[i - 1];
    const curr = sortedReadings[i];
    
    const bgChange = curr.bloodGlucose - prev.bloodGlucose;
    const timeGapMinutes = (curr.timestamp - prev.timestamp) / (60 * 1000);
    
    // Check for unexplained rise (possible unreported meal)
    if (bgChange >= SMBG_CONSTANTS.INFERENCE_THRESHOLDS.UNEXPLAINED_RISE) {
      // Check if there's a reported meal in this time window
      const mealReported = reportedMeals.some(meal => 
        meal.timestamp >= prev.timestamp && meal.timestamp <= curr.timestamp
      );
      
      if (!mealReported && timeGapMinutes <= 180) {
        inferences.push({
          type: 'unreported_meal',
          timestamp: prev.timestamp + (timeGapMinutes * 60 * 1000 / 2), // Midpoint
          confidence: bgChange > 60 ? 'high' : 'medium',
          bgChange,
          timeGapMinutes,
          message: `Possible unreported meal (BG rose ${Math.round(bgChange)} mg/dL)`,
          icon: '🍽️',
          color: '#FF9800'
        });
      }
    }
    
    // Check for unexplained fall (possible unreported insulin)
    if (bgChange <= -SMBG_CONSTANTS.INFERENCE_THRESHOLDS.UNEXPLAINED_FALL) {
      // Check if there's reported insulin in this time window
      const insulinReported = reportedInsulin.some(dose => 
        dose.timestamp >= prev.timestamp && dose.timestamp <= curr.timestamp
      );
      
      if (!insulinReported && timeGapMinutes <= 180) {
        inferences.push({
          type: 'unreported_insulin',
          timestamp: prev.timestamp + (timeGapMinutes * 60 * 1000 / 2), // Midpoint
          confidence: Math.abs(bgChange) > 50 ? 'high' : 'medium',
          bgChange,
          timeGapMinutes,
          message: `Possible unreported insulin (BG fell ${Math.abs(Math.round(bgChange))} mg/dL)`,
          icon: '💉',
          color: '#2196F3'
        });
      }
    }
  }

  return inferences;
}

// ============================================================================
// ADAPTIVE REMINDER SCHEDULING
// ============================================================================

/**
 * Schedule adaptive reminders based on patient behavior
 * 
 * @param {Array} readingHistory - Historical readings
 * @param {Object} patientSchedule - Patient's typical schedule
 * @returns {Array} Recommended reminder times
 */
export function scheduleAdaptiveReminders(readingHistory = [], patientSchedule = null) {
  // Default schedule if no history
  const defaultReminders = [
    { hour: 7, minute: 0, label: 'Fasting', priority: 'high' },
    { hour: 12, minute: 0, label: 'Pre-lunch', priority: 'medium' },
    { hour: 18, minute: 0, label: 'Pre-dinner', priority: 'medium' },
    { hour: 22, minute: 0, label: 'Bedtime', priority: 'high' }
  ];

  if (!readingHistory || readingHistory.length < 7) {
    return defaultReminders;
  }

  // Analyze patient's typical testing times
  const testingTimes = readingHistory.map(r => {
    const date = new Date(r.timestamp);
    return {
      hour: date.getHours(),
      minute: date.getMinutes(),
      dayOfWeek: date.getDay()
    };
  });

  // Find most common testing times
  const hourCounts = {};
  testingTimes.forEach(t => {
    const hourKey = t.hour;
    hourCounts[hourKey] = (hourCounts[hourKey] || 0) + 1;
  });

  // Get top 4-6 most common testing hours
  const commonHours = Object.entries(hourCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([hour]) => parseInt(hour));

  // Create adaptive reminders
  const adaptiveReminders = commonHours.map(hour => {
    let label, priority;
    
    if (hour >= 6 && hour < 9) {
      label = 'Morning';
      priority = 'high';
    } else if (hour >= 11 && hour < 13) {
      label = 'Pre-lunch';
      priority = 'medium';
    } else if (hour >= 17 && hour < 19) {
      label = 'Pre-dinner';
      priority = 'medium';
    } else if (hour >= 21 && hour < 23) {
      label = 'Bedtime';
      priority = 'high';
    } else {
      label = `${hour}:00`;
      priority = 'low';
    }

    return {
      hour,
      minute: 0,
      label,
      priority,
      basedOnHistory: true
    };
  });

  return adaptiveReminders.length > 0 ? adaptiveReminders : defaultReminders;
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  SMBG_CONSTANTS,
  calculateReadingPriority,
  mapConfidenceToOpacity,
  getGapWarning,
  assessRisks,
  analyzeCompliance,
  inferUnreportedEvents,
  scheduleAdaptiveReminders
};




