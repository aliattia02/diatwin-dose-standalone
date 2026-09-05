import API_BASE_URL from '../config';
// ============================================================================
// ENHANCED PATIENT CONSTANTS CALC - v4.0
// ============================================================================
// UPDATED: Replaced deleted BG_Effect and insulinUtils imports with new
// 3-file service layer system:
//   - mealPharmacodynamics.js (meal absorption, MOB, absorbed fraction)
//   - insulinPharmacodynamics.js (insulin activity, IOB)
//   - netEffectCalculationService.js (orchestration, routing layer)
//
// CHANGES FROM PREVIOUS VERSION:
// ✅ Removed: import { calculateMedicationEffect } from '../utils/insulinUtils'
// ✅ Removed: import { calculateUnifiedMealImpact, calculateCarbEquivalents,
//             calculateMealActivityPercentage } from '../utils/BG_Effect'
// ✅ Added: imports from mealPharmacodynamics.js, insulinPharmacodynamics.js
// ✅ Replaced: calculateAbsorbedFraction local approximation with proper
//             gamma-distribution version from mealPharmacodynamics.js
// ✅ Replaced: calculateInsulinActivityAtTime local approximation with proper
//             version from insulinPharmacodynamics.js
// ✅ Replaced: calculateUnifiedMealImpact with inline carb-equivalent +
//             base insulin calculation using mealPharmacodynamics profiles
// ✅ Replaced: calculateMealActivityPercentage with calculateMealActivity
//             from mealPharmacodynamics.js
// ✅ Inlined: calculateMedicationEffect logic (was a simple time-based
//             decay calculation that doesn't need a separate module)
// ============================================================================

// Import the time utilities
import TimeManager from '../utils/TimeManager';
import axios from 'axios';

// ============================================================================
// NEW IMPORTS: 3-file service layer system
// ============================================================================

// Meal pharmacodynamics - replaces BG_Effect meal functions
import {
  calculateMealActivity,
  calculateAbsorbedFraction,
  calculateMOB,
  getAbsorptionProfile,
  calculateMealBGImpact
} from '../utils/mealPharmacodynamics';

// Insulin pharmacodynamics - replaces insulinUtils insulin functions
import {
  calculateIOB,
  calculateInsulinActivity,
  getInsulinProfile
} from '../utils/insulinPharmacodynamics';

// Shared constants for absorption profiles and medication factors
import { SHARED_CONSTANTS } from '../constants/shared_constants';

// Unit conversion constants
import {
  MEASUREMENT_SYSTEMS,
  VOLUME_MEASUREMENTS,
  WEIGHT_MEASUREMENTS,
  convertToGrams as baseConvertToGrams,
  convertToMl as baseConvertToMl
} from '../constants';

// ============================================================================
// CONVERSION UTILITIES
// ============================================================================

const convertToGrams = (amount, unit) => {
  if (baseConvertToGrams) {
    return baseConvertToGrams(amount, unit);
  }
  if (WEIGHT_MEASUREMENTS[unit]) {
    return amount * WEIGHT_MEASUREMENTS[unit].grams;
  }
  return amount;
};

const convertToMl = (amount, unit) => {
  if (baseConvertToMl) {
    return baseConvertToMl(amount, unit);
  }
  if (VOLUME_MEASUREMENTS[unit]) {
    return amount * VOLUME_MEASUREMENTS[unit].ml;
  }
  return amount;
};

// ============================================================================
// MEDICATION EFFECT CALCULATION
// ============================================================================
// Previously imported from insulinUtils. Now inlined here since it's a simple
// time-based decay calculation specific to non-insulin medications (e.g.
// metformin, prednisone) and doesn't belong in the insulin pharmacodynamics
// service which handles insulin-specific absorption curves.
// ============================================================================

/**
 * Calculate the current effect of a medication based on its schedule
 * and pharmacokinetic properties.
 *
 * @param {string} medicationName - Name/key of the medication
 * @param {object} medData - Medication data from patient constants
 * @param {object} schedule - Medication schedule (times, last dose, etc.)
 * @param {Date} currentDate - Current date/time for calculation
 * @returns {object|null} Medication effect with factor, status, etc.
 */
export const calculateMedicationEffect = (medicationName, medData, schedule, currentDate = new Date()) => {
  if (!medData || !medData.factor) return null;

  const baseFactor = parseFloat(medData.factor);

  // If not duration-based, return flat factor
  if (!medData.duration_based) {
    return {
      factor: baseFactor,
      status: 'active',
      description: medData.description || medicationName
    };
  }

  // Duration-based medication: calculate time since last dose
  if (!schedule) {
    return {
      factor: baseFactor,
      status: 'unknown_schedule',
      description: medData.description || medicationName
    };
  }

  // Find most recent dose time
  let lastDoseTime = null;

  if (schedule.last_taken) {
    lastDoseTime = new Date(schedule.last_taken);
  } else if (schedule.daily_times && schedule.daily_times.length > 0) {
    // Estimate from scheduled times
    const today = new Date(currentDate);
    for (const timeStr of schedule.daily_times.sort().reverse()) {
      const [hours, minutes] = timeStr.split(':').map(Number);
      const scheduledTime = new Date(today);
      scheduledTime.setHours(hours, minutes, 0, 0);

      if (scheduledTime <= currentDate) {
        lastDoseTime = scheduledTime;
        break;
      }
    }

    // If no dose today yet, check yesterday's last dose
    if (!lastDoseTime && schedule.daily_times.length > 0) {
      const lastTimeStr = schedule.daily_times.sort().reverse()[0];
      const [hours, minutes] = lastTimeStr.split(':').map(Number);
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(hours, minutes, 0, 0);
      lastDoseTime = yesterday;
    }
  }

  if (!lastDoseTime) {
    return {
      factor: baseFactor,
      status: 'no_dose_found',
      description: medData.description || medicationName
    };
  }

  const hoursSinceLastDose = (currentDate - lastDoseTime) / (1000 * 60 * 60);
  const peakHours = medData.peak_hours || 2;
  const durationHours = medData.duration_hours || 8;

  // Calculate effect decay
  let effectMultiplier;

  if (hoursSinceLastDose < 0) {
    // Dose in the future
    effectMultiplier = 0;
  } else if (hoursSinceLastDose <= peakHours) {
    // Rising to peak: linear ramp
    effectMultiplier = hoursSinceLastDose / peakHours;
  } else if (hoursSinceLastDose <= durationHours) {
    // Declining from peak: exponential decay
    const decayProgress = (hoursSinceLastDose - peakHours) / (durationHours - peakHours);
    effectMultiplier = Math.exp(-2.0 * decayProgress);
  } else {
    // Past duration: no effect
    effectMultiplier = 0;
  }

  // Scale the factor: base factor is at peak, scale proportionally
  // factor = 1.0 means no change, so we scale the deviation from 1.0
  const scaledFactor = 1.0 + (baseFactor - 1.0) * effectMultiplier;

  let status;
  if (effectMultiplier >= 0.8) status = 'peak';
  else if (effectMultiplier >= 0.3) status = 'active';
  else if (effectMultiplier > 0) status = 'declining';
  else status = 'inactive';

  return {
    factor: scaledFactor,
    status: status,
    effectMultiplier: effectMultiplier,
    hoursSinceLastDose: hoursSinceLastDose,
    lastDose: lastDoseTime.toISOString(),
    description: medData.description || medicationName
  };
};

// ============================================================================
// HEALTH FACTORS CALCULATION
// ============================================================================

const calculateHealthFactorsData = (patientConstants, options = {}) => {
  if (!patientConstants) return null;

  const currentDate = options.currentDate || new Date();
  const { formatNames = false } = options;

  const result = {
    healthMultiplier: 1.0,
    conditions: [],
    medications: [],
    summary: '',
    hasHealthFactors: false
  };

  // Calculate conditions impact
  if (patientConstants.active_conditions?.length > 0) {
    result.conditions = patientConstants.active_conditions
      .map(condition => {
        const conditionData = patientConstants.disease_factors[condition];
        if (!conditionData?.factor) return null;

        const factor = parseFloat(conditionData.factor);
        const percentChange = ((factor - 1) * 100).toFixed(1);

        return {
          name: formatNames
            ? condition.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
            : condition,
          factor: factor,
          percentage: percentChange,
          isIncrease: factor > 1
        };
      })
      .filter(Boolean);
  }

  // Calculate medications impact
  if (patientConstants.active_medications?.length > 0) {
    result.medications = patientConstants.active_medications
      .map(medication => {
        const medData = patientConstants.medication_factors[medication];
        const schedule = patientConstants.medication_schedules?.[medication];
        if (!medData) return null;

        const medicationEffect = calculateMedicationEffect(
          medication,
          medData,
          schedule,
          currentDate
        );

        if (!medicationEffect) return null;

        return {
          name: formatNames
            ? medication.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
            : medication,
          ...medicationEffect,
          percentChange: ((medicationEffect.factor - 1) * 100).toFixed(1),
          isIncrease: medicationEffect.factor > 1
        };
      })
      .filter(Boolean);
  }

  // Calculate combined health multiplier
  result.healthMultiplier = calculateHealthFactors(patientConstants, currentDate);

  // Format summary
  const percentageChange = ((result.healthMultiplier - 1) * 100).toFixed(1);
  result.summary = `${percentageChange}%${
    result.healthMultiplier > 1
      ? ` (+${percentageChange}% increase)`
      : ` (${percentageChange}% decrease)`
  }`;

  result.hasHealthFactors = result.conditions.length > 0 || result.medications.length > 0;

  return result;
};

// Interface functions
export const calculateHealthFactorsDetails = (patientConstants, currentDate) => {
  return calculateHealthFactorsData(patientConstants, { currentDate });
};

export const getHealthFactorsDisplayData = (patientConstants, currentDate) => {
  const data = calculateHealthFactorsData(patientConstants, { formatNames: true, currentDate });
  return {
    activeConditions: data.conditions,
    medications: data.medications,
    hasHealthFactors: data.hasHealthFactors
  };
};

export const getHealthFactorsBreakdown = (patientConstants, currentDate = new Date()) => {
  const data = calculateHealthFactorsData(patientConstants, { currentDate });
  return {
    conditions: data.conditions,
    medications: data.medications,
    healthMultiplier: data.healthMultiplier
  };
};

export const calculateHealthFactors = (patientConstants, currentDate = new Date()) => {
  if (!patientConstants) return 1.0;

  let healthMultiplier = 1.0;

  // Calculate disease impacts
  const activeConditions = patientConstants.active_conditions || [];
  activeConditions.forEach(condition => {
    const diseaseData = patientConstants.disease_factors[condition];
    if (diseaseData && diseaseData.factor) {
      healthMultiplier *= diseaseData.factor;
    }
  });

  // Calculate medication impacts
  const activeMedications = patientConstants.active_medications || [];
  activeMedications.forEach(medication => {
    const medData = patientConstants.medication_factors[medication];
    if (!medData || !medData.factor) return;

    if (medData.duration_based) {
      const schedule = patientConstants.medication_schedules?.[medication];
      if (schedule) {
        const medicationEffect = calculateMedicationEffect(
          medication,
          medData,
          schedule,
          currentDate
        );

        if (medicationEffect) {
          healthMultiplier *= medicationEffect.factor;
        }
      } else {
        healthMultiplier *= medData.factor;
      }
    } else {
      healthMultiplier *= medData.factor;
    }
  });

  return healthMultiplier;
};

// ============================================================================
// ACTIVITY IMPACT CALCULATION
// ============================================================================

export const calculateActivityImpact = (activities, patientConstants) => {
  if (!activities || !patientConstants?.activity_coefficients) {
    return 1.0;
  }

  let totalImpact = 1.0;

  activities.forEach(activity => {
    const coefficient = patientConstants.activity_coefficients[activity.level.toString()] || 1.0;

    let duration;

    if (activity.startTime && activity.endTime) {
      duration = TimeManager.calculateDuration(activity.startTime, activity.endTime).totalHours;
    } else if (typeof activity.duration === 'string' && activity.duration.includes(':')) {
      duration = TimeManager.durationToHours(activity.duration);
    } else {
      duration = parseFloat(activity.duration) || 0;
    }

    const durationWeight = Math.min(duration / 2, 1);
    const weightedImpact = 1.0 + ((coefficient - 1.0) * durationWeight);
    totalImpact *= weightedImpact;
  });

  return 1.0 + (totalImpact - 1.0);
};

// ============================================================================
// MEDICATION SCHEDULE VALIDATION
// ============================================================================

export const validateMedicationSchedule = (schedule) => {
  const errors = [];
  const startDateObj = new Date(schedule.startDate);
  const endDateObj = new Date(schedule.endDate);
  const currentDate = new Date();
  currentDate.setHours(0, 0, 0, 0);

  if (!schedule.startDate || !schedule.endDate) {
    errors.push('Start and end dates are required');
  } else {
    if (startDateObj < currentDate) {
      errors.push('Start date cannot be in the past');
    }
    if (endDateObj <= startDateObj) {
      errors.push('End date must be after start date');
    }
  }

  if (schedule.dailyTimes.some(time => !time)) {
    errors.push('All time slots must be filled');
  }

  const uniqueTimes = new Set(schedule.dailyTimes);
  if (uniqueTimes.size !== schedule.dailyTimes.length) {
    errors.push('Duplicate times are not allowed');
  }

  return errors;
};

// ============================================================================
// NUTRIENT CALCULATION
// ============================================================================

export const calculateNutrients = (food) => {
  if (!food.details) return { carbs: 0, protein: 0, fat: 0, absorptionType: 'medium' };

  let conversionRatio = 1;

  if (food.portion.activeMeasurement === MEASUREMENT_SYSTEMS.WEIGHT) {
    const portionInGrams = convertToGrams(food.portion.w_amount, food.portion.w_unit);
    const servingSizeInGrams = convertToGrams(
      food.details.serving_size?.w_amount || 100,
      food.details.serving_size?.w_unit || 'g'
    );
    conversionRatio = portionInGrams / servingSizeInGrams;
  } else {
    const portionInMl = convertToMl(food.portion.amount, food.portion.unit);
    const servingSizeInMl = convertToMl(
      food.details.serving_size?.amount || 1,
      food.details.serving_size?.unit || 'serving'
    );
    conversionRatio = portionInMl / servingSizeInMl;
  }

  return {
    carbs: (food.details.carbs || 0) * conversionRatio,
    protein: (food.details.protein || 0) * conversionRatio,
    fat: (food.details.fat || 0) * conversionRatio,
    absorptionType: food.details.absorption_type || 'medium'
  };
};

export const calculateTotalNutrients = (selectedFoods) => {
  const totalNutrition = { carbs: 0, protein: 0, fat: 0, absorptionType: 'medium' };

  if (!selectedFoods || selectedFoods.length === 0) {
    return totalNutrition;
  }

  const absorptionValues = {
    'very_fast': 5,
    'fast': 4,
    'medium': 3,
    'slow': 2,
    'very_slow': 1
  };

  const reverseMap = {
    5: 'very_fast',
    4: 'fast',
    3: 'medium',
    2: 'slow',
    1: 'very_slow'
  };

  let totalWeight = 0;
  let weightedSum = 0;
  const foodAbsorptionTypes = [];

  selectedFoods.forEach(food => {
    const nutrients = calculateNutrients(food);
    totalNutrition.carbs += nutrients.carbs;
    totalNutrition.protein += nutrients.protein;
    totalNutrition.fat += nutrients.fat;

    if (nutrients.carbs > 0) {
      const absorptionType = nutrients.absorptionType || 'medium';
      const absorptionValue = absorptionValues[absorptionType] || 3;

      weightedSum += absorptionValue * nutrients.carbs;
      totalWeight += nutrients.carbs;

      foodAbsorptionTypes.push({
        food: food.name,
        type: absorptionType,
        carbs: nutrients.carbs
      });
    }
  });

  if (totalWeight > 0) {
    const averageValue = Math.round(weightedSum / totalWeight);
    totalNutrition.absorptionType = reverseMap[averageValue] || 'medium';
  }

  totalNutrition.absorptionMetadata = {
    weightedType: totalNutrition.absorptionType,
    foodTypes: foodAbsorptionTypes,
    totalCarbWeight: totalWeight
  };

  return totalNutrition;
};

// ============================================================================
// ACTIVE INSULIN FETCHING
// ============================================================================

export const fetchActiveInsulin = async () => {
  try {
    const token = localStorage.getItem('token');
    if (!token) return 0;

    const response = await axios.get(
      `${API_BASE_URL}/api/active-insulin`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );

    if (response.data && response.data.total_active_insulin !== undefined) {
      return parseFloat(response.data.total_active_insulin);
    }
    return 0;
  } catch (error) {
    console.error('Error fetching active insulin:', error);
    return 0;
  }
};

// ============================================================================
// MOB/IOB PROJECTION FUNCTIONS
// ============================================================================
// Updated to use mealPharmacodynamics.js and insulinPharmacodynamics.js
// instead of deleted BG_Effect.js and insulinUtils.js
// ============================================================================

/**
 * Project future MOB effect over time
 * UPDATED: Uses calculateMealActivity and calculateAbsorbedFraction from
 * mealPharmacodynamics.js (proper gamma-distribution calculation)
 */
export const projectMOBEffect = (currentMOB, absorptionProfile, projectionHours = 3, patientConstants) => {
  const projectionPoints = [];
  const carbToBgFactor = patientConstants?.carb_to_bg_factor || 4.0;

  // Get absorption type and look up proper profile from shared constants
  const absorptionType = absorptionProfile?.absorption_type || 'medium';
  const profile = getAbsorptionProfile(absorptionType) || {
    onset_hours: 0.42,
    peak_hours: 1.5,
    duration_hours: 4.0,
    shape_param: 2.0,
    scale_param: 0.5
  };

  for (let h = 0; h <= projectionHours; h += 0.5) {
    const futureHoursSinceMeal = (currentMOB.hoursElapsed || 0) + h;

    // ✅ Use proper gamma-distribution calculation from mealPharmacodynamics
    const futureActivity = calculateMealActivity(futureHoursSinceMeal, profile);
    const absorbedFraction = calculateAbsorbedFraction(futureHoursSinceMeal, profile);
    const remainingCarbs = currentMOB.totalCarbs * (1 - absorbedFraction);

    projectionPoints.push({
      hoursFromNow: h,
      activeCarbs: Math.max(0, remainingCarbs),
      activityPercent: futureActivity,
      bgImpact: Math.max(0, remainingCarbs) * carbToBgFactor
    });
  }

  return projectionPoints;
};

/**
 * Project future IOB effect over time
 * UPDATED: Uses calculateInsulinActivity and calculateIOB from
 * insulinPharmacodynamics.js (proper pharmacokinetic calculation)
 */
export const projectIOBEffect = (currentIOB, insulinProfile, projectionHours = 4, patientConstants) => {
  const projectionPoints = [];
  const correctionFactor = patientConstants?.correction_factor || 50;

  // Get insulin type and look up proper profile from shared constants
  const insulinType = insulinProfile?.type || 'insulin_aspart';
  const profile = getInsulinProfile(insulinType) || {
    onset_hours: 0.5,
    peak_hours: 2.0,
    duration_hours: 4.0
  };

  for (let h = 0; h <= projectionHours; h += 0.5) {
    const futureHoursSinceDose = (currentIOB.hoursElapsed || 0) + h;

    let remainingInsulin = 0;
    if (futureHoursSinceDose >= 0 && futureHoursSinceDose <= profile.duration_hours) {
      // ✅ Use proper IOB calculation from insulinPharmacodynamics
      remainingInsulin = calculateIOB(futureHoursSinceDose, currentIOB.totalUnits, profile);
    }

    const futureActivity = (futureHoursSinceDose >= 0 && futureHoursSinceDose <= profile.duration_hours)
      ? calculateInsulinActivity(futureHoursSinceDose, profile)
      : 0;

    projectionPoints.push({
      hoursFromNow: h,
      activeInsulin: Math.max(0, remainingInsulin),
      activityPercent: futureActivity,
      bgImpact: -Math.max(0, remainingInsulin) * correctionFactor
    });
  }

  return projectionPoints;
};

/**
 * Calculate when new meal's peak will overlap with existing effects
 */
export const calculatePeakOverlap = (newMealProfile, existingMOBData, existingIOBData, patientConstants) => {
  const newMealPeakTime = newMealProfile.peak_hours || 1.5;

  const mobProjection = existingMOBData?.totalCarbs > 0
    ? projectMOBEffect(existingMOBData, existingMOBData.profile, newMealPeakTime, patientConstants)
    : [];

  const iobProjection = existingIOBData?.totalUnits > 0
    ? projectIOBEffect(existingIOBData, existingIOBData.profile, newMealPeakTime, patientConstants)
    : [];

  const mobAtPeak = mobProjection.find(p => Math.abs(p.hoursFromNow - newMealPeakTime) < 0.25) ||
    { activeCarbs: 0, bgImpact: 0 };
  const iobAtPeak = iobProjection.find(p => Math.abs(p.hoursFromNow - newMealPeakTime) < 0.25) ||
    { activeInsulin: 0, bgImpact: 0 };

  const netBgImpactAtPeak = mobAtPeak.bgImpact + iobAtPeak.bgImpact;

  return {
    peakTime: newMealPeakTime,
    existingMobAtPeak: mobAtPeak.activeCarbs,
    existingIobAtPeak: iobAtPeak.activeInsulin,
    netBgImpactAtPeak,
    mobBgImpact: mobAtPeak.bgImpact,
    iobBgImpact: iobAtPeak.bgImpact,
    adjustmentFactor: calculateAdjustmentFromOverlap(netBgImpactAtPeak, mobAtPeak.activeCarbs, iobAtPeak.activeInsulin)
  };
};

/**
 * Calculate adjustment factor based on overlap
 */
const calculateAdjustmentFromOverlap = (netBgImpact, mobAtPeak, iobAtPeak) => {
  let adjustment = 1.0;

  if (mobAtPeak > 10) {
    adjustment *= (1 + (mobAtPeak / 100) * 0.1);
  }

  if (iobAtPeak > 1) {
    adjustment *= (1 - (iobAtPeak / 10) * 0.2);
  }

  return Math.max(0.5, Math.min(1.5, adjustment));
};

// ============================================================================
// CARB EQUIVALENT CALCULATION
// ============================================================================
// Previously provided by calculateCarbEquivalents from BG_Effect.js
// Now calculated inline using patient constants
// ============================================================================

/**
 * Calculate carb equivalents from macronutrients
 * Replaces calculateCarbEquivalents from deleted BG_Effect.js
 *
 * @param {number} carbs - Grams of carbohydrates
 * @param {number} protein - Grams of protein
 * @param {number} fat - Grams of fat
 * @param {object} patientConstants - Patient-specific factors
 * @returns {object} Carb equivalent breakdown
 */
const calculateCarbEquivalents = (carbs, protein, fat, patientConstants) => {
  const proteinFactor = patientConstants?.protein_factor || 0.5;
  const fatFactor = patientConstants?.fat_factor || 0.2;

  const carbsActual = carbs || 0;
  const proteinCarbEquiv = (protein || 0) * proteinFactor;
  const fatCarbEquiv = (fat || 0) * fatFactor;
  const totalCarbEquiv = carbsActual + proteinCarbEquiv + fatCarbEquiv;

  return {
    carbsActual,
    proteinCarbEquiv,
    fatCarbEquiv,
    totalCarbEquiv
  };
};

// ============================================================================
// UNIFIED MEAL IMPACT CALCULATION
// ============================================================================
// Previously provided by calculateUnifiedMealImpact from BG_Effect.js
// Now calculated inline using mealPharmacodynamics profiles and patient constants
// ============================================================================

/**
 * Calculate unified meal impact for insulin dosing
 * Replaces calculateUnifiedMealImpact from deleted BG_Effect.js
 *
 * @param {object} mealData - Meal data with nutrition info
 * @param {object} patientConstants - Patient-specific constants
 * @returns {object} Unified calculation result
 */
const calculateUnifiedMealImpact = (mealData, patientConstants) => {
  const nutrition = mealData.nutrition || {};
  const carbs = nutrition.carbs || 0;
  const protein = nutrition.protein || 0;
  const fat = nutrition.fat || 0;
  const absorptionType = nutrition.absorptionType || 'medium';

  // Calculate carb equivalents
  const carbEquivalents = calculateCarbEquivalents(carbs, protein, fat, patientConstants);

  // Calculate base insulin from carb equivalents
  const insulinToCarbRatio = patientConstants?.insulin_to_carb_ratio || 10;
  const baseInsulin = carbEquivalents.totalCarbEquiv / insulinToCarbRatio;

  // Pharmacodynamic adjustments are DISABLED (set to 1.0)
  // Will apply patient rhythm to blood sugar line instead
  const adjustedInsulin = baseInsulin;

  return {
    baseInsulin,
    adjustedInsulin,
    carbEquivalents,
    absorptionType,
    calculationSummary: {
      total_carb_equiv: carbEquivalents.totalCarbEquiv,
      base_insulin: baseInsulin,
      adjustment_factors: {
        absorption_rate: 1.0,
        meal_timing: 1.0
      }
    }
  };
};

// ============================================================================
// INSULIN DOSE CALCULATION
// ============================================================================

export const calculateInsulinDose = async ({
  carbs,
  protein,
  fat,
  bloodSugar,
  activities,
  patientConstants,
  mealType,
  absorptionType = 'medium',
  currentTime = new Date(),
  activeInsulinValue = null,
  activeMealCarbs = 0,

  // Blood sugar metadata
  bloodSugarSource = 'unknown',
  bloodSugarConfidence = 'unknown',
  minutesSinceReading = 0,

  // Cumulative effects
  cumulativeMealEffect = 0,
  cumulativeInsulinEffect = 0,
  cumulativeNetBaseline = 0,

  // Absorbed amounts
  absorbedCarbs = 0,
  absorbedInsulin = 0,

  // Pending effects
  pendingMealRise = 0,
  pendingInsulinReduction = 0,

  // Full context objects
  activeEffectsContext = null,
  adjustedBaselineContext = null
}) => {
  if (!patientConstants) {
    throw new Error('Patient constants are required');
  }

  // If active insulin wasn't passed, fetch it
  let activeInsulin = activeInsulinValue;
  if (activeInsulin === null) {
    try {
      activeInsulin = await fetchActiveInsulin();
    } catch (error) {
      console.warn('Error fetching active insulin, defaulting to 0:', error);
      activeInsulin = 0;
    }
  }

  // Create a meal-like object for unified calculation
  const mealData = {
    mealType,
    nutrition: {
      carbs,
      protein,
      fat,
      absorptionType
    }
  };

  // ✅ Use local calculateUnifiedMealImpact (replaces deleted BG_Effect import)
  const unifiedResult = calculateUnifiedMealImpact(mealData, patientConstants);

  const { baseInsulin } = unifiedResult;
  const carbEquivalents = unifiedResult.carbEquivalents;

  // Pharmacodynamic adjustments DISABLED
  const absorptionFactor = 1.0;
  const mealTimingFactor = 1.0;

  // Get absorption profile from mealPharmacodynamics for peak overlap
  const profile = getAbsorptionProfile(absorptionType);
  const newMealProfile = {
    onset_hours: profile?.onset_hours || 0.42,
    peak_hours: profile?.peak_hours || 1.5,
    duration_hours: profile?.duration_hours || 4.0,
    absorption_type: absorptionType
  };

  // Calculate peak overlap if there's active MOB or IOB
  let peakOverlapData = null;
  let overlapAdjustment = 1.0;

  if (activeMealCarbs > 0 || activeInsulin > 0) {
    const existingMOBData = activeMealCarbs > 0 ? {
      totalCarbs: activeMealCarbs,
      hoursElapsed: 1.0,
      profile: newMealProfile
    } : null;

    const existingIOBData = activeInsulin > 0 ? {
      totalUnits: activeInsulin,
      hoursElapsed: 1.5,
      profile: {
        onset_hours: 0.5,
        peak_hours: 2.0,
        duration_hours: 4.0,
        type: 'rapid_acting'
      }
    } : null;

    peakOverlapData = calculatePeakOverlap(
      newMealProfile,
      existingMOBData,
      existingIOBData,
      patientConstants
    );

    overlapAdjustment = peakOverlapData.adjustmentFactor;
  }

  // MOB insulin equivalent
  const mobInsulinEquivalent = activeMealCarbs > 0
    ? activeMealCarbs / (patientConstants.insulin_to_carb_ratio || 10)
    : 0;

  // Activity impact
  const activityImpact = calculateActivityImpact(activities, patientConstants);
  const activityAdjustedInsulin = baseInsulin * activityImpact;

  // Correction insulin
  let correctionInsulin = 0;
  let correctionNote = '';
  if (typeof bloodSugar === 'number' && !isNaN(bloodSugar) && patientConstants.target_glucose && patientConstants.correction_factor) {
    correctionInsulin = (bloodSugar - patientConstants.target_glucose) / patientConstants.correction_factor;

    if (bloodSugarSource === 'estimated') {
      correctionNote = `Based on estimated BG (confidence: ${bloodSugarConfidence}, ${minutesSinceReading} min since reading)`;
    } else if (bloodSugarSource === 'target_fallback') {
      correctionNote = 'Based on target glucose - no recent reading available';
    } else {
      correctionNote = 'Based on actual BG reading';
    }
  }

  const preActiveTotal = activityAdjustedInsulin + correctionInsulin;

  // Cumulative and pending adjustments (display only, not subtracted)
  const cumulativeAdjustment = cumulativeNetBaseline / (patientConstants.correction_factor || 50);
  const pendingNetChange = pendingMealRise - pendingInsulinReduction;
  const pendingAdjustment = pendingNetChange / (patientConstants.correction_factor || 50);

  // Only subtract active IOB and add MOB equivalent
  const postActiveTotal = preActiveTotal - activeInsulin + mobInsulinEquivalent;

  // Apply predictive overlap adjustment
  const predictiveAdjustedTotal = postActiveTotal * overlapAdjustment;

  // Apply health factors
  const healthMultiplier = calculateHealthFactors(patientConstants, currentTime);
  let totalInsulin = Math.max(0, predictiveAdjustedTotal * healthMultiplier);

  // Round to nearest 0.1 units
  totalInsulin = Math.round(totalInsulin * 10) / 10;

  // Safety threshold
  if (preActiveTotal > 0 && totalInsulin < 0.5) {
    totalInsulin = 0.5;
  }

  return {
    total: totalInsulin,
    breakdown: {
      carbsActual: Math.round(carbEquivalents.carbsActual * 100) / 100,
      proteinCarbEquiv: Math.round(carbEquivalents.proteinCarbEquiv * 100) / 100,
      fatCarbEquiv: Math.round(carbEquivalents.fatCarbEquiv * 100) / 100,
      totalCarbEquiv: Math.round(carbEquivalents.totalCarbEquiv * 100) / 100,
      baseInsulin: Math.round(baseInsulin * 100) / 100,
      adjustedInsulin: Math.round(activityAdjustedInsulin * 100) / 100,
      correctionInsulin: Math.round(correctionInsulin * 100) / 100,
      preActiveTotal: Math.round(preActiveTotal * 100) / 100,
      activeInsulin: Math.round(activeInsulin * 100) / 100,
      activeMealCarbs: Math.round(activeMealCarbs * 100) / 100,
      mobInsulinEquivalent: Math.round(mobInsulinEquivalent * 100) / 100,
      postActiveTotal: Math.round(postActiveTotal * 100) / 100,
      overlapAdjustment: Math.round(overlapAdjustment * 100) / 100,
      projectedMobAtPeak: peakOverlapData ? Math.round(peakOverlapData.existingMobAtPeak * 100) / 100 : 0,
      projectedIobAtPeak: peakOverlapData ? Math.round(peakOverlapData.existingIobAtPeak * 100) / 100 : 0,
      netBgImpactAtPeak: peakOverlapData ? Math.round(peakOverlapData.netBgImpactAtPeak) : 0,
      peakTime: newMealProfile.peak_hours,
      healthMultiplier: Math.round(healthMultiplier * 100) / 100,
      absorptionFactor,
      mealTimingFactor,
      activityImpact: Math.round(activityImpact * 100) / 100,
      timeOfDayFactor: 1.0,

      // Blood sugar metadata
      bloodSugarUsed: bloodSugar,
      bloodSugarSource,
      bloodSugarConfidence,
      minutesSinceReading,
      correctionNote,

      // Cumulative adjustments
      cumulativeMealEffect,
      cumulativeInsulinEffect,
      cumulativeNetBaseline,
      cumulativeAdjustment: Math.round(cumulativeAdjustment * 100) / 100,

      // Absorbed amounts
      absorbedCarbs,
      absorbedInsulin,

      // Pending adjustments
      pendingMealRise,
      pendingInsulinReduction,
      pendingNetChange,
      pendingAdjustment: Math.round(pendingAdjustment * 100) / 100,

      // Summary of all adjustments
      totalAdjustments: {
        cumulative: Math.round(-cumulativeAdjustment * 100) / 100,
        active: Math.round(-(activeInsulin - mobInsulinEquivalent) * 100) / 100,
        pending: Math.round(-pendingAdjustment * 100) / 100,
        total: Math.round(-(cumulativeAdjustment + activeInsulin - mobInsulinEquivalent + pendingAdjustment) * 100) / 100
      }
    }
  };
};

// ============================================================================
// CONVENIENCE WRAPPERS
// ============================================================================

export const calculateInsulinNeeds = async (selectedFoods, bloodSugar, activities, patientConstants, mealType, currentTime = new Date(), activeInsulinValue = null) => {
  if (selectedFoods.length === 0 || !patientConstants) {
    return {
      suggestedInsulin: '',
      insulinBreakdown: null
    };
  }

  try {
    const totalNutrition = calculateTotalNutrients(selectedFoods);
    const insulinCalculation = await calculateInsulinDose({
      ...totalNutrition,
      bloodSugar: parseFloat(bloodSugar) || 0,
      activities,
      patientConstants,
      mealType,
      currentTime,
      activeInsulinValue
    });

    return {
      suggestedInsulin: insulinCalculation.total,
      insulinBreakdown: insulinCalculation.breakdown
    };
  } catch (error) {
    throw new Error('Error calculating insulin needs: ' + error.message);
  }
};

export const compareCalculations = (frontend, backend) => {
  const differences = {};
  const tolerance = 0.01;

  const compareValues = (key, frontVal, backVal) => {
    const diff = Math.abs((frontVal - backVal) / backVal);
    if (diff > tolerance) {
      differences[key] = {
        frontend: frontVal,
        backend: backVal,
        percentDiff: (diff * 100).toFixed(2) + '%'
      };
    }
  };

  for (const key in frontend) {
    if (typeof frontend[key] === 'number' && backend[key] !== undefined) {
      compareValues(key, frontend[key], backend[key]);
    }
  }

  return differences;
};




