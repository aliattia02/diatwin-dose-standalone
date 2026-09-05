/**
 * ============================================================================
 * VALIDATION METRICS UTILITY
 * ============================================================================
 *
 * Medical-grade accuracy metrics for Component 1 (Clinical Validation Dashboard)
 * Implements industry-standard validation methods for glucose prediction systems
 *
 * Key Metrics:
 * - Clarke Error Grid Analysis (FDA standard)
 * - MARD (Mean Absolute Relative Difference)
 * - MAE (Mean Absolute Error)
 * - RMSE (Root Mean Squared Error)
 *
 * Author: DiaTwin Team
 * Version: 1.0
 * ============================================================================
 */

/**
 * Clarke Error Grid Classification
 *
 * Classifies prediction accuracy into clinical zones:
 * - Zone A: Clinically accurate (within 20% or ±15 mg/dL if <70)
 * - Zone B: Benign errors (would not lead to inappropriate treatment)
 * - Zone C: Overcorrection errors (unnecessary treatment)
 * - Zone D: Failure to detect errors (dangerous misses)
 * - Zone E: Erroneous treatment (dangerous incorrect actions)
 *
 * FDA Standard: ≥95% in zones A+B for approval
 *
 * @param {number} actual - Actual CGM reading (mg/dL)
 * @param {number} predicted - Predicted BG value (mg/dL)
 * @returns {string} Zone classification ('A', 'B', 'C', 'D', 'E')
 */
export function classifyClarkeErrorGridPoint(actual, predicted) {
  // Zone A: Clinically accurate
  if (actual < 70) {
    // For hypoglycemia, ±15 mg/dL is acceptable
    if (Math.abs(predicted - actual) <= 15) return 'A';
  } else {
    // For normal/high, within 20% is acceptable
    if (Math.abs(predicted - actual) / actual <= 0.20) return 'A';
  }

  // Zone B: Benign errors
  // Upper region
  if (actual >= 180) {
    if (predicted >= 70 && predicted <= actual * 1.2) return 'B';
  }
  // Lower region
  if (actual <= 70) {
    if (predicted >= actual * 0.8 && predicted <= 180) return 'B';
  }
  // Middle region
  if (actual > 70 && actual < 180) {
    if (predicted >= actual * 0.7 && predicted <= actual * 1.3) return 'B';
  }

  // Zone C: Overcorrection
  if (actual >= 70 && actual <= 290) {
    if (predicted >= actual + 110) return 'C';
  }
  if (actual >= 130 && actual <= 180) {
    if (predicted <= (actual - 30) * 0.4) return 'C';
  }

  // Zone D: Failure to detect
  if (actual <= 70) {
    if (predicted >= 180) return 'D';
  }
  if (actual >= 240) {
    if (predicted >= 70 && predicted <= 180) return 'D';
  }

  // Zone E: Erroneous treatment (most dangerous)
  if (actual <= 70 && predicted >= 180) return 'E';
  if (actual >= 180 && predicted <= 70) return 'E';

  // Default to B if no other classification matches
  return 'B';
}

/**
 * Calculate Clarke Error Grid distribution for dataset
 *
 * @param {Array} validationData - Array of {actual, predicted} pairs
 * @returns {object} Percentage distribution across zones
 */
export function calculateClarkeErrorGrid(validationData) {
  if (!validationData || validationData.length === 0) {
    return {
      zoneA: 0,
      zoneB: 0,
      zoneC: 0,
      zoneD: 0,
      zoneE: 0,
      totalPoints: 0,
      clinicallyAcceptable: 0,
      meetsFDA: false
    };
  }

  const zones = { A: 0, B: 0, C: 0, D: 0, E: 0 };

  validationData.forEach(point => {
    const zone = classifyClarkeErrorGridPoint(point.actual, point.predicted);
    zones[zone]++;
  });

  const total = validationData.length;
  const clinicallyAcceptable = ((zones.A + zones.B) / total) * 100;

  return {
    zoneA: Math.round((zones.A / total) * 1000) / 10,
    zoneB: Math.round((zones.B / total) * 1000) / 10,
    zoneC: Math.round((zones.C / total) * 1000) / 10,
    zoneD: Math.round((zones.D / total) * 1000) / 10,
    zoneE: Math.round((zones.E / total) * 1000) / 10,
    totalPoints: total,
    clinicallyAcceptable: Math.round(clinicallyAcceptable * 10) / 10,
    meetsFDA: clinicallyAcceptable >= 95,
    counts: {
      zoneA: zones.A,
      zoneB: zones.B,
      zoneC: zones.C,
      zoneD: zones.D,
      zoneE: zones.E
    }
  };
}

/**
 * Calculate MARD (Mean Absolute Relative Difference)
 *
 * Gold standard for CGM accuracy evaluation
 * Industry benchmark: <10% is excellent, <15% is good
 *
 * Formula: MARD = (1/n) × Σ |actual - predicted| / actual × 100%
 *
 * @param {Array} validationData - Array of {actual, predicted, error, errorPercent}
 * @returns {number} MARD percentage
 */
export function calculateMARD(validationData) {
  if (!validationData || validationData.length === 0) return 0;

  const sumRelativeErrors = validationData.reduce((sum, point) => {
    // Avoid division by zero
    if (point.actual === 0) return sum;

    const relativeError = Math.abs(point.actual - point.predicted) / point.actual;
    return sum + relativeError;
  }, 0);

  const mard = (sumRelativeErrors / validationData.length) * 100;
  return Math.round(mard * 100) / 100;
}

/**
 * Calculate MAE (Mean Absolute Error)
 *
 * Average magnitude of errors in mg/dL
 * More intuitive than MARD for clinicians
 *
 * Formula: MAE = (1/n) × Σ |actual - predicted|
 *
 * @param {Array} validationData - Array of {actual, predicted}
 * @returns {number} MAE in mg/dL
 */
export function calculateMAE(validationData) {
  if (!validationData || validationData.length === 0) return 0;

  const sumAbsErrors = validationData.reduce((sum, point) =>
    sum + Math.abs(point.actual - point.predicted), 0
  );

  const mae = sumAbsErrors / validationData.length;
  return Math.round(mae * 10) / 10;
}

/**
 * Calculate RMSE (Root Mean Squared Error)
 *
 * Penalizes larger errors more heavily than MAE
 * Useful for detecting outliers and systematic biases
 *
 * Formula: RMSE = √[(1/n) × Σ (actual - predicted)²]
 *
 * @param {Array} validationData - Array of {actual, predicted}
 * @returns {number} RMSE in mg/dL
 */
export function calculateRMSE(validationData) {
  if (!validationData || validationData.length === 0) return 0;

  const sumSquaredErrors = validationData.reduce((sum, point) =>
    sum + Math.pow(point.actual - point.predicted, 2), 0
  );

  const rmse = Math.sqrt(sumSquaredErrors / validationData.length);
  return Math.round(rmse * 10) / 10;
}

/**
 * Calculate accuracy by time of day
 *
 * Breaks down MARD by 6 time periods:
 * - 00:00-04:00 (Night)
 * - 04:00-08:00 (Early morning/Dawn)
 * - 08:00-12:00 (Morning)
 * - 12:00-16:00 (Afternoon)
 * - 16:00-20:00 (Evening)
 * - 20:00-00:00 (Night)
 *
 * @param {Array} validationData - Array with timestamp, actual, predicted
 * @returns {object} MARD breakdown by time period
 */
export function calculateAccuracyByTimeOfDay(validationData) {
  if (!validationData || validationData.length === 0) {
    return {};
  }

  const timeBuckets = {
    '00:00-04:00': [],
    '04:00-08:00': [],
    '08:00-12:00': [],
    '12:00-16:00': [],
    '16:00-20:00': [],
    '20:00-00:00': []
  };

  validationData.forEach(point => {
    const date = new Date(point.timestamp);
    const hour = date.getHours();

    let bucket;
    if (hour >= 0 && hour < 4) bucket = '00:00-04:00';
    else if (hour >= 4 && hour < 8) bucket = '04:00-08:00';
    else if (hour >= 8 && hour < 12) bucket = '08:00-12:00';
    else if (hour >= 12 && hour < 16) bucket = '12:00-16:00';
    else if (hour >= 16 && hour < 20) bucket = '16:00-20:00';
    else bucket = '20:00-00:00';

    timeBuckets[bucket].push(point);
  });

  const results = {};
  Object.keys(timeBuckets).forEach(bucket => {
    const points = timeBuckets[bucket];
    if (points.length > 0) {
      results[bucket] = {
        mard: calculateMARD(points),
        mae: calculateMAE(points),
        count: points.length,
        label: getTimeOfDayLabel(bucket)
      };
    }
  });

  return results;
}

/**
 * Get human-readable label for time bucket
 * @private
 */
function getTimeOfDayLabel(bucket) {
  const labels = {
    '00:00-04:00': 'Night',
    '04:00-08:00': 'Early Morning (Dawn Effect)',
    '08:00-12:00': 'Morning',
    '12:00-16:00': 'Afternoon',
    '16:00-20:00': 'Evening',
    '20:00-00:00': 'Night'
  };
  return labels[bucket] || bucket;
}

/**
 * Calculate accuracy by meal type
 *
 * Groups predictions by absorption type to identify
 * which meal types are hardest to predict
 *
 * @param {Array} validationData - Validation points with mealType
 * @param {Array} meals - Meal data with absorption types
 * @returns {object} MAE breakdown by absorption type
 */
export function calculateAccuracyByMealType(validationData, meals) {
  if (!validationData || !meals || validationData.length === 0) {
    return {};
  }

  const mealTypes = {
    'very_fast': [],
    'fast': [],
    'medium': [],
    'slow': [],
    'very_slow': []
  };

  // Create meal lookup by timestamp
  const mealLookup = new Map();
  meals.forEach(meal => {
    const mealTime = new Date(meal.timestamp).getTime();
    const absorptionType = meal.nutrition?.absorptionType ||
                          meal.nutrition?.absorption_type ||
                          'medium';
    mealLookup.set(mealTime, absorptionType);
  });

  validationData.forEach(point => {
    // Find closest meal within 4 hours
    const pointTime = new Date(point.timestamp).getTime();
    let closestMeal = null;
    let closestDistance = Infinity;

    meals.forEach(meal => {
      const mealTime = new Date(meal.timestamp).getTime();
      const distance = Math.abs(pointTime - mealTime);
      const fourHours = 4 * 60 * 60 * 1000;

      if (distance < fourHours && distance < closestDistance) {
        closestDistance = distance;
        closestMeal = meal;
      }
    });

    if (closestMeal) {
      const absorptionType = closestMeal.nutrition?.absorptionType ||
                            closestMeal.nutrition?.absorption_type ||
                            'medium';
      if (mealTypes[absorptionType]) {
        mealTypes[absorptionType].push(point);
      }
    }
  });

  const results = {};
  Object.keys(mealTypes).forEach(type => {
    const points = mealTypes[type];
    if (points.length > 0) {
      results[type] = {
        mae: calculateMAE(points),
        mard: calculateMARD(points),
        count: points.length,
        label: getAbsorptionTypeLabel(type)
      };
    }
  });

  return results;
}

/**
 * Get human-readable label for absorption type
 * @private
 */
function getAbsorptionTypeLabel(type) {
  const labels = {
    'very_fast': 'Very Fast Absorption (Simple Sugars)',
    'fast': 'Fast Absorption (Simple Carbs)',
    'medium': 'Medium Absorption (Mixed Meals)',
    'slow': 'Slow Absorption (Complex Carbs)',
    'very_slow': 'Very Slow Absorption (High Fat/Protein)'
  };
  return labels[type] || type;
}

/**
 * Calculate percentage of predictions within acceptable error bounds
 *
 * @param {Array} validationData - Validation data
 * @param {number} threshold - Acceptable error threshold (mg/dL)
 * @returns {object} Percentage within threshold
 */
export function calculatePercentageWithinThreshold(validationData, threshold = 15) {
  if (!validationData || validationData.length === 0) {
    return { percentage: 0, count: 0, total: 0 };
  }

  const withinThreshold = validationData.filter(point =>
    Math.abs(point.actual - point.predicted) <= threshold
  ).length;

  return {
    percentage: Math.round((withinThreshold / validationData.length) * 1000) / 10,
    count: withinThreshold,
    total: validationData.length,
    threshold: threshold
  };
}

/**
 * Generate comprehensive validation report
 *
 * @param {Array} validationData - Complete validation dataset
 * @param {Array} meals - Meal data for breakdown analysis
 * @returns {object} Complete validation metrics
 */
export function generateValidationReport(validationData, meals = []) {
  if (!validationData || validationData.length === 0) {
    return {
      error: 'No validation data available',
      isEmpty: true
    };
  }

  const report = {
    // Core metrics
    mard: calculateMARD(validationData),
    mae: calculateMAE(validationData),
    rmse: calculateRMSE(validationData),

    // Clarke Error Grid
    clarkeGrid: calculateClarkeErrorGrid(validationData),

    // Threshold analysis
    within15mgdl: calculatePercentageWithinThreshold(validationData, 15),
    within20mgdl: calculatePercentageWithinThreshold(validationData, 20),
    within20percent: calculatePercentageWithinThreshold(
      validationData.filter(p => p.actual > 0),
      validationData.filter(p => p.actual > 0)[0]?.actual * 0.20 || 20
    ),

    // Time-based breakdown
    byTimeOfDay: calculateAccuracyByTimeOfDay(validationData),

    // Meal-based breakdown (if meals provided)
    byMealType: meals.length > 0 ? calculateAccuracyByMealType(validationData, meals) : {},

    // Overall assessment
    assessment: generateAssessment(
      calculateMARD(validationData),
      calculateClarkeErrorGrid(validationData)
    ),

    // Metadata
    dataPoints: validationData.length,
    generatedAt: new Date().toISOString()
  };

  return report;
}

/**
 * Generate clinical assessment from metrics
 * @private
 */
function generateAssessment(mard, clarkeGrid) {
  const assessment = {
    overall: 'unknown',
    mardAssessment: 'unknown',
    clarkeAssessment: 'unknown',
    clinicalUse: 'not_recommended',
    recommendations: []
  };

  // MARD assessment
  if (mard < 10) {
    assessment.mardAssessment = 'excellent';
  } else if (mard < 15) {
    assessment.mardAssessment = 'good';
  } else if (mard < 20) {
    assessment.mardAssessment = 'acceptable';
  } else {
    assessment.mardAssessment = 'poor';
  }

  // Clarke Grid assessment
  if (clarkeGrid.meetsFDA) {
    assessment.clarkeAssessment = 'meets_fda_standard';
    assessment.clinicalUse = 'approved';
  } else if (clarkeGrid.clinicallyAcceptable >= 90) {
    assessment.clarkeAssessment = 'close_to_standard';
    assessment.clinicalUse = 'conditional';
    assessment.recommendations.push('Improve accuracy in zones C/D/E to meet FDA standard');
  } else {
    assessment.clarkeAssessment = 'below_standard';
    assessment.clinicalUse = 'not_recommended';
    assessment.recommendations.push('Significant improvement needed before clinical use');
  }

  // Overall assessment
  if (assessment.mardAssessment === 'excellent' && assessment.clarkeAssessment === 'meets_fda_standard') {
    assessment.overall = 'excellent';
  } else if (assessment.mardAssessment === 'good' && clarkeGrid.clinicallyAcceptable >= 90) {
    assessment.overall = 'good';
  } else if (assessment.mardAssessment === 'acceptable') {
    assessment.overall = 'acceptable';
  } else {
    assessment.overall = 'needs_improvement';
  }

  return assessment;
}

/**
 * Export all functions
 */
export default {
  classifyClarkeErrorGridPoint,
  calculateClarkeErrorGrid,
  calculateMARD,
  calculateMAE,
  calculateRMSE,
  calculateAccuracyByTimeOfDay,
  calculateAccuracyByMealType,
  calculatePercentageWithinThreshold,
  generateValidationReport
};



