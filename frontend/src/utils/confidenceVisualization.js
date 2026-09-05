/**
 * ============================================================================
 * CONFIDENCE VISUALIZATION UTILITY
 * ============================================================================
 *
 * Visual styling utilities for Components 2 & 3 based on confidence levels
 *
 * Key Features:
 * - Confidence-based opacity for SMBG timeline
 * - Trend arrows for CGM
 * - Time-in-range calculations
 * - Reading priority classification
 * - Warning threshold detection
 *
 * Author: DiaTwin Team
 * Version: 1.0
 * ============================================================================
 */

/**
 * Calculate line opacity based on confidence
 *
 * Used in Component 3 (SMBG Monitoring) to visually indicate
 * estimate reliability through opacity decay
 *
 * @param {number} minutesSinceReading - Minutes since last actual reading
 * @param {boolean} hasActiveEffects - Whether IOB/MOB is present
 * @returns {number} Opacity value (0.0 - 1.0)
 */
export function getConfidenceOpacity(minutesSinceReading, hasActiveEffects = false) {
  // Base opacity on time since reading
  let opacity;

  if (minutesSinceReading < 15) {
    opacity = 1.0;      // Solid - very recent
  } else if (minutesSinceReading < 30) {
    opacity = 0.95;     // Nearly solid
  } else if (minutesSinceReading < 60) {
    opacity = 0.85;     // Slightly faded
  } else if (minutesSinceReading < 120) {
    opacity = 0.70;     // Faded
  } else if (minutesSinceReading < 180) {
    opacity = 0.50;     // Half opacity
  } else if (minutesSinceReading < 240) {
    opacity = 0.35;     // Very faded
  } else if (minutesSinceReading < 360) {
    opacity = 0.25;     // Almost transparent
  } else {
    opacity = 0.15;     // Barely visible
  }

  // Penalty for active effects (adds uncertainty)
  if (hasActiveEffects && minutesSinceReading > 30) {
    opacity *= 0.90; // 10% reduction
  }

  return Math.max(0.10, Math.min(1.0, opacity));
}

/**
 * Get line style (solid vs dotted) based on confidence
 *
 * @param {number} minutesSinceReading - Minutes since last reading
 * @param {string} confidenceLevel - 'high', 'medium', 'low', 'very_low'
 * @returns {string} CSS line style ('solid', 'dashed', 'dotted')
 */
export function getLineStyle(minutesSinceReading, confidenceLevel = null) {
  // Use confidence level if provided
  if (confidenceLevel) {
    switch (confidenceLevel) {
      case 'very_high':
      case 'high':
        return 'solid';
      case 'medium':
        return 'solid';
      case 'low':
        return 'dashed';
      case 'very_low':
        return 'dotted';
      default:
        return 'solid';
    }
  }

  // Otherwise use time-based heuristic
  if (minutesSinceReading > 360) {
    return 'dotted';  // >6 hours - very unreliable
  } else if (minutesSinceReading > 180) {
    return 'dashed';  // >3 hours - low confidence
  } else {
    return 'solid';   // <3 hours - acceptable
  }
}

/**
 * Get trend arrow for CGM display
 *
 * Used in Component 2 (CGM Monitoring) to show rate of change
 * Matches Dexcom G6/G7 arrow convention
 *
 * @param {number} velocityPerHour - BG change rate (mg/dL per hour)
 * @returns {string} Arrow emoji
 */
export function getTrendArrow(velocityPerHour) {
  if (velocityPerHour === null || velocityPerHour === undefined) {
    return '➡️'; // Unknown/stable
  }

  // Dexcom-style thresholds
  if (velocityPerHour > 120) return '⬆️⬆️';      // Rising rapidly (>2 mg/dL/min)
  if (velocityPerHour > 60) return '⬆️';         // Rising (1-2 mg/dL/min)
  if (velocityPerHour > 20) return '↗️';         // Rising slowly
  if (velocityPerHour >= -20) return '➡️';       // Stable
  if (velocityPerHour > -60) return '↘️';        // Falling slowly
  if (velocityPerHour > -120) return '⬇️';       // Falling
  return '⬇️⬇️';                                  // Falling rapidly
}

/**
 * Get trend description for display
 *
 * @param {number} velocityPerHour - BG change rate (mg/dL per hour)
 * @returns {object} Trend description with severity
 */
export function getTrendDescription(velocityPerHour) {
  const arrow = getTrendArrow(velocityPerHour);

  let description, severity, action;

  if (velocityPerHour > 120) {
    description = `Rising rapidly (${Math.round(velocityPerHour)} mg/dL/hr)`;
    severity = 'high';
    action = 'Check for missed insulin or unusual carb intake';
  } else if (velocityPerHour > 60) {
    description = `Rising (${Math.round(velocityPerHour)} mg/dL/hr)`;
    severity = 'medium';
    action = 'Monitor closely, may need correction';
  } else if (velocityPerHour > 20) {
    description = `Rising slowly (${Math.round(velocityPerHour)} mg/dL/hr)`;
    severity = 'low';
    action = 'Normal post-meal rise';
  } else if (velocityPerHour >= -20) {
    description = 'Stable';
    severity = 'none';
    action = null;
  } else if (velocityPerHour > -60) {
    description = `Falling slowly (${Math.round(Math.abs(velocityPerHour))} mg/dL/hr)`;
    severity = 'low';
    action = 'Normal insulin action';
  } else if (velocityPerHour > -120) {
    description = `Falling (${Math.round(Math.abs(velocityPerHour))} mg/dL/hr)`;
    severity = 'medium';
    action = 'Monitor for hypoglycemia';
  } else {
    description = `Falling rapidly (${Math.round(Math.abs(velocityPerHour))} mg/dL/hr)`;
    severity = 'high';
    action = 'Risk of hypoglycemia - prepare fast carbs';
  }

  return {
    arrow,
    description,
    severity,
    action,
    velocityPerHour: Math.round(velocityPerHour)
  };
}

/**
 * Calculate time in range statistics
 *
 * Used in Component 2 (CGM Monitoring) for daily/weekly summaries
 *
 * @param {Array} readings - Array of {bloodSugar, timestamp} readings
 * @param {number} lowerBound - Lower target bound (default: 70 mg/dL)
 * @param {number} upperBound - Upper target bound (default: 180 mg/dL)
 * @returns {object} Time-in-range statistics
 */
export function getTimeInRange(readings, lowerBound = 70, upperBound = 180) {
  if (!readings || readings.length === 0) {
    return {
      percent: 0,
      inRangeCount: 0,
      totalCount: 0,
      lowCount: 0,
      highCount: 0,
      veryLowCount: 0,
      veryHighCount: 0,
      assessment: 'insufficient_data'
    };
  }

  const inRange = readings.filter(r =>
    r.bloodSugar >= lowerBound && r.bloodSugar <= upperBound
  ).length;

  const low = readings.filter(r =>
    r.bloodSugar < lowerBound && r.bloodSugar >= 54
  ).length;

  const veryLow = readings.filter(r =>
    r.bloodSugar < 54
  ).length;

  const high = readings.filter(r =>
    r.bloodSugar > upperBound && r.bloodSugar <= 250
  ).length;

  const veryHigh = readings.filter(r =>
    r.bloodSugar > 250
  ).length;

  const total = readings.length;
  const percent = (inRange / total) * 100;

  // Assessment based on clinical guidelines
  let assessment;
  if (percent >= 70) {
    assessment = 'excellent';
  } else if (percent >= 50) {
    assessment = 'good';
  } else if (percent >= 30) {
    assessment = 'needs_improvement';
  } else {
    assessment = 'poor';
  }

  return {
    percent: Math.round(percent * 10) / 10,
    inRangeCount: inRange,
    totalCount: total,
    lowCount: low,
    highCount: high,
    veryLowCount: veryLow,
    veryHighCount: veryHigh,
    percentLow: Math.round((low / total) * 1000) / 10,
    percentHigh: Math.round((high / total) * 1000) / 10,
    percentVeryLow: Math.round((veryLow / total) * 1000) / 10,
    percentVeryHigh: Math.round((veryHigh / total) * 1000) / 10,
    assessment: assessment,
    meetsTarget: percent >= 70
  };
}

/**
 * Determine if warning should be shown
 *
 * @param {string} confidenceLevel - Confidence level
 * @param {number} minutesSinceReading - Minutes since last reading
 * @param {number} currentBG - Current estimated BG (optional)
 * @returns {object} Warning assessment
 */
export function shouldShowWarning(confidenceLevel, minutesSinceReading, currentBG = null) {
  const warnings = [];
  let severity = 'none';

  // Confidence-based warnings
  if (confidenceLevel === 'very_low' || minutesSinceReading > 360) {
    warnings.push({
      type: 'confidence',
      message: 'Very low confidence - testing strongly recommended',
      severity: 'high'
    });
    severity = 'high';
  } else if (confidenceLevel === 'low' || minutesSinceReading > 180) {
    warnings.push({
      type: 'confidence',
      message: 'Low confidence - consider testing',
      severity: 'medium'
    });
    if (severity === 'none') severity = 'medium';
  }

  // BG-based warnings (if provided)
  if (currentBG !== null) {
    if (currentBG < 70) {
      warnings.push({
        type: 'hypoglycemia',
        message: 'Possible hypoglycemia - test and treat immediately',
        severity: 'critical'
      });
      severity = 'critical';
    } else if (currentBG > 250) {
      warnings.push({
        type: 'hyperglycemia',
        message: 'High blood sugar - test and correct',
        severity: 'high'
      });
 if (severity !== 'critical') severity = 'high';
    } else if (currentBG < 80) {
      warnings.push({
        type: 'low_warning',
        message: 'Blood sugar trending low - monitor closely',
        severity: 'medium'
      });
      if (severity === 'none') severity = 'medium';
    }
  }

  return {
    showWarning: warnings.length > 0,
    severity: severity,
    warnings: warnings,
    count: warnings.length
  };
}

/**
 * Get priority level for reading reminders
 *
 * Used in Component 3 (SMBG Monitoring) to prioritize when patients should test
 *
 * @param {string} reason - Reason for recommendation ('insulin_peak', 'meal_peak', 'low_confidence', 'routine')
 * @param {number} minutesUntil - Minutes until recommended reading
 * @param {object} context - Additional context (currentBG, activeEffects)
 * @returns {object} Priority assessment
 */
export function getReadingPriority(reason, minutesUntil, context = {}) {
  let priority = 'low';
  let urgency = 'routine';
  let message = '';
  let color = '#666666';

  const { currentBG, hasHighIOB, hasHighMOB, confidenceLevel } = context;

  // Base priority on reason
  switch (reason) {
    case 'insulin_peak':
      priority = 'high';
      urgency = 'important';
      message = 'Insulin peak approaching - risk of hypoglycemia';
      color = '#2196f3';

      // Escalate if high IOB
      if (hasHighIOB) {
        priority = 'critical';
        urgency = 'urgent';
        message = 'High insulin stacking - test immediately';
        color = '#f44336';
      }
      break;

    case 'meal_peak':
      priority = 'medium';
      urgency = 'recommended';
      message = 'Meal peak approaching - verify glucose response';
      color = '#ff9800';

      // Escalate if high MOB
      if (hasHighMOB) {
        priority = 'high';
        urgency = 'important';
        message = 'High meal stacking - monitor glucose closely';
        color = '#ff5722';
      }
      break;

    case 'low_confidence':
      priority = 'high';
      urgency = 'important';
      message = 'Low confidence in current estimate';
      color = '#ff9800';

      // Escalate if very low confidence
      if (confidenceLevel === 'very_low') {
        priority = 'critical';
        urgency = 'urgent';
        message = 'Very low confidence - test immediately';
        color = '#f44336';
      }
      break;

    case 'possible_hypo':
      priority = 'critical';
      urgency = 'urgent';
      message = 'Possible hypoglycemia detected';
      color = '#f44336';
      break;

    case 'possible_hyper':
      priority = 'high';
      urgency = 'important';
      message = 'Possible hyperglycemia detected';
      color = '#ff5722';
      break;

    case 'routine':
      priority = 'low';
      urgency = 'routine';
      message = 'Routine check recommended';
      color = '#666666';
      break;

    default:
      priority = 'low';
      urgency = 'routine';
      message = 'Consider testing';
      color = '#666666';
  }

  // Adjust based on time until reading
  if (minutesUntil <= 0) {
    urgency = priority === 'critical' ? 'urgent' : 'important';
    message += ' now';
  } else if (minutesUntil <= 15) {
    message += ` in ${minutesUntil} minutes`;
  } else if (minutesUntil <= 60) {
    message += ` in ${Math.round(minutesUntil)} minutes`;
  } else {
    const hours = Math.floor(minutesUntil / 60);
    const mins = Math.round(minutesUntil % 60);
    message += ` in ${hours}h ${mins}m`;
  }

  // Additional context-based escalation
  if (currentBG !== null && currentBG !== undefined) {
    if (currentBG < 70 && priority !== 'critical') {
      priority = 'critical';
      urgency = 'urgent';
      message = 'Hypoglycemia detected - test and treat immediately';
      color = '#f44336';
    } else if (currentBG > 300) {
      priority = 'high';
      urgency = 'important';
      message = 'Very high blood sugar - test and correct';
      color = '#f44336';
    }
  }

  return {
    priority: priority,
    urgency: urgency,
    message: message,
    color: color,
    reason: reason,
    minutesUntil: minutesUntil,
    shouldAlert: priority === 'critical',
    shouldNotify: priority === 'high' || priority === 'critical'
  };
}

/**
 * Calculate confidence color for display
 *
 * @param {string} confidenceLevel - Confidence level
 * @param {number} confidenceScore - Numeric confidence (0-100)
 * @returns {object} Color information for UI
 */
export function getConfidenceColor(confidenceLevel, confidenceScore = null) {
  let color, backgroundColor, label;

  switch (confidenceLevel) {
    case 'very_high':
      color = '#2e7d32';
      backgroundColor = '#e8f5e9';
      label = 'Very High';
      break;
    case 'high':
      color = '#388e3c';
      backgroundColor = '#f1f8e9';
      label = 'High';
      break;
    case 'medium':
      color = '#f57c00';
      backgroundColor = '#fff3e0';
      label = 'Medium';
      break;
    case 'low':
      color = '#e64a19';
      backgroundColor = '#fbe9e7';
      label = 'Low';
      break;
    case 'very_low':
      color = '#c62828';
      backgroundColor = '#ffebee';
      label = 'Very Low';
      break;
    default:
      color = '#757575';
      backgroundColor = '#f5f5f5';
      label = 'Unknown';
  }

  return {
    color: color,
    backgroundColor: backgroundColor,
    label: label,
    score: confidenceScore,
    shouldWarn: confidenceLevel === 'low' || confidenceLevel === 'very_low'
  };
}

/**
 * Format confidence for display
 *
 * @param {number} confidenceScore - Confidence score (0-100)
 * @param {number} minutesSinceReading - Minutes since last reading
 * @returns {object} Formatted confidence display
 */
export function formatConfidenceDisplay(confidenceScore, minutesSinceReading) {
  let level;
  if (confidenceScore >= 85) level = 'very_high';
  else if (confidenceScore >= 70) level = 'high';
  else if (confidenceScore >= 55) level = 'medium';
  else if (confidenceScore >= 40) level = 'low';
  else level = 'very_low';

  const colorInfo = getConfidenceColor(level, confidenceScore);

  // Time description
  let timeDescription;
  if (minutesSinceReading < 15) {
    timeDescription = 'just tested';
  } else if (minutesSinceReading < 60) {
    timeDescription = `${Math.round(minutesSinceReading)} min ago`;
  } else {
    const hours = Math.floor(minutesSinceReading / 60);
    const mins = Math.round(minutesSinceReading % 60);
    timeDescription = `${hours}h ${mins}m ago`;
  }

  return {
    ...colorInfo,
    level: level,
    percentage: `${Math.round(confidenceScore)}%`,
    timeDescription: timeDescription,
    fullDescription: `${colorInfo.label} confidence (${Math.round(confidenceScore)}%) - reading ${timeDescription}`
  };
}

/**
 * Determine visualization opacity for chart elements
 *
 * @param {string} elementType - Type of element ('line', 'area', 'point')
 * @param {number} minutesSinceReading - Minutes since last reading
 * @param {string} confidenceLevel - Confidence level
 * @returns {number} Opacity value (0.0 - 1.0)
 */
export function getVisualizationOpacity(elementType, minutesSinceReading, confidenceLevel) {
  // Base opacity on element type
  let baseOpacity;
  switch (elementType) {
    case 'line':
      baseOpacity = 1.0;
      break;
    case 'area':
      baseOpacity = 0.6;
      break;
    case 'point':
      baseOpacity = 1.0;
      break;
    default:
      baseOpacity = 1.0;
  }

  // Apply confidence-based adjustment
  const confidenceOpacity = getConfidenceOpacity(minutesSinceReading, false);

  // Combine base and confidence
  const finalOpacity = baseOpacity * confidenceOpacity;

  // Minimum visibility
  return Math.max(0.15, finalOpacity);
}

/**
 * Get gradient colors for confidence visualization
 *
 * @param {number} minutesSinceReading - Minutes since last reading
 * @returns {object} Gradient color stops
 */
export function getConfidenceGradient(minutesSinceReading) {
  if (minutesSinceReading < 60) {
    return {
      start: 'rgba(76, 175, 80, 0.8)',   // Green - high confidence
      end: 'rgba(76, 175, 80, 0.4)'
    };
  } else if (minutesSinceReading < 120) {
    return {
      start: 'rgba(255, 152, 0, 0.7)',    // Orange - medium confidence
      end: 'rgba(255, 152, 0, 0.3)'
    };
  } else if (minutesSinceReading < 240) {
    return {
      start: 'rgba(244, 67, 54, 0.6)',    // Red - low confidence
      end: 'rgba(244, 67, 54, 0.2)'
    };
  } else {
    return {
      start: 'rgba(158, 158, 158, 0.5)',  // Gray - very low confidence
      end: 'rgba(158, 158, 158, 0.1)'
    };
  }
}

/**
 * Calculate glycemic variability score
 *
 * Used in Component 2 (CGM) for advanced analytics
 *
 * @param {Array} readings - Array of glucose readings
 * @returns {object} Variability metrics
 */
export function calculateGlycemicVariability(readings) {
  if (!readings || readings.length < 2) {
    return {
      coefficient: 0,
      standardDeviation: 0,
      range: 0,
      assessment: 'insufficient_data'
    };
  }

  const values = readings.map(r => r.bloodSugar || r.value);
  const mean = values.reduce((sum, val) => sum + val, 0) / values.length;

  const variance = values.reduce((sum, val) =>
    sum + Math.pow(val - mean, 2), 0
  ) / values.length;

  const stdDev = Math.sqrt(variance);
  const coefficientOfVariation = (stdDev / mean) * 100;

  const range = Math.max(...values) - Math.min(...values);

  // Assessment based on coefficient of variation
  let assessment;
  if (coefficientOfVariation < 36) {
    assessment = 'stable';
  } else if (coefficientOfVariation < 50) {
    assessment = 'moderate';
  } else {
    assessment = 'high';
  }

  return {
    coefficient: Math.round(coefficientOfVariation * 10) / 10,
    standardDeviation: Math.round(stdDev * 10) / 10,
    range: Math.round(range),
    mean: Math.round(mean),
    assessment: assessment,
    interpretation: getVariabilityInterpretation(coefficientOfVariation)
  };
}

/**
 * Get interpretation of glycemic variability
 * @private
 */
function getVariabilityInterpretation(cv) {
  if (cv < 36) {
    return 'Stable glucose control with minimal variability';
  } else if (cv < 50) {
    return 'Moderate variability - some glucose swings present';
  } else {
    return 'High variability - significant glucose swings detected';
  }
}

/**
 * Export all functions
 */
export default {
  getConfidenceOpacity,
  getLineStyle,
  getTrendArrow,
  getTrendDescription,
  getTimeInRange,
  shouldShowWarning,
  getReadingPriority,
  getConfidenceColor,
  formatConfidenceDisplay,
  getVisualizationOpacity,
  getConfidenceGradient,
  calculateGlycemicVariability
};








