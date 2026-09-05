/**
 * Timeline data generation for NATIVE diabetes management platform
 * Ported from frontend/src/utils/BG_Effect.js to TypeScript
 * 
 * Generates combined timeline data showing meal and insulin impacts on blood glucose
 * 
 * @module utils/glucose/timeline-generator
 */

import { AbsorptionType } from '../../types/meal.types';
import { PatientConstants } from '../../types/constants.types';
import { calculateUnifiedMealImpact, MealData } from './blood-glucose-estimation';
import { MealImpactPoint } from './meal-impact-curves';

/**
 * Blood glucose reading data
 */
export interface BloodGlucoseReading {
  bloodSugar: number;
  bloodSugarTimestamp?: string;
  timestamp?: string;
  readingTime?: number;
  isActualReading?: boolean;
  isInterpolated?: boolean;
  isEstimated?: boolean;
  dataType?: 'actual' | 'interpolated' | 'estimated';
  status?: string;
}

/**
 * Timeline data point
 */
export interface TimelinePoint {
  timestamp: number;
  formattedTime: string;
  meals: Array<{
    id?: string;
    mealType?: string;
    carbs: number;
    protein: number;
    fat: number;
    totalCarbEquiv: number;
    absorptionType: AbsorptionType;
    calculationSummary?: any;
    foodItems?: any[];
    notes?: string;
    parsedFoodName?: string | null;
  }>;
  mealEffects: Record<string, number>;
  totalMealEffect: number;
  bloodSugar: number;
  estimatedBloodSugar: number;
  isActualReading: boolean;
  isInterpolated: boolean;
  isEstimated: boolean;
  dataType: string;
  status: any;
  foodItems?: any[];
  notes?: string;
  [key: string]: any; // For dynamic meal-specific properties
}

/**
 * Options for timeline generation
 */
export interface TimelineOptions {
  timeScale?: {
    start: number;
    end: number;
    tickInterval?: number;
  };
  targetGlucose?: number;
  includeFutureEffect?: boolean;
  futureHours?: number;
  effectDurationHours?: number;
  patientConstants?: Partial<PatientConstants>;
}

/**
 * Context functions for blood sugar calculations
 */
export interface ContextFunctions {
  getBloodSugarAtTime?: (timestamp: number) => BloodGlucoseReading | null;
  getBloodSugarStatus?: (bloodSugar: number, targetGlucose: number) => any;
  getFilteredData?: (data: BloodGlucoseReading[]) => BloodGlucoseReading[];
}

/**
 * Generate combined timeline data showing meal impacts on blood glucose
 * 
 * @param mealData - Array of meal objects
 * @param bloodGlucoseData - Array of blood glucose readings
 * @param options - Configuration options
 * @param contextFunctions - Blood sugar context functions
 * @returns Combined timeline data with meal effects
 */
export function generateMealTimelineData(
  mealData: MealData[],
  bloodGlucoseData: BloodGlucoseReading[],
  options: TimelineOptions = {},
  contextFunctions: ContextFunctions = {}
): TimelinePoint[] {
  const {
    timeScale = { start: 0, end: 0, tickInterval: 3600000 },
    targetGlucose = 100,
    includeFutureEffect = false,
    futureHours = 6,
    effectDurationHours = 6,
    patientConstants = {},
  } = options;

  const {
    getBloodSugarAtTime = () => null,
    getBloodSugarStatus = () => ({ status: 'normal', color: '#000000' }),
    getFilteredData = (data) => data,
  } = contextFunctions;

  try {
    if (!mealData || !Array.isArray(mealData) || mealData.length === 0) {
      return [];
    }

    // Find the earliest and latest timestamps
    const allMealTimes = mealData.map((m) => m.timestamp).filter((t) => t && !isNaN(t) && t > 0) as number[];
    const allBGTimes = bloodGlucoseData
      .map((d) => {
        const time = d.readingTime || (d.bloodSugarTimestamp ? new Date(d.bloodSugarTimestamp).getTime() : 0);
        return time;
      })
      .filter((t) => !isNaN(t) && t > 0);

    const allTimestamps = [...allMealTimes, ...allBGTimes];
    if (allTimestamps.length === 0) {
      return [];
    }

    let minTime: number;
    let maxTime: number;

    if (timeScale && timeScale.start && timeScale.end) {
      minTime = timeScale.start;
      maxTime = timeScale.end;
    } else {
      minTime = Math.min(...allTimestamps);
      maxTime = Math.max(...allTimestamps);

      if (allMealTimes.length > 0) {
        const earliestMeal = Math.min(...allMealTimes);
        const latestMeal = Math.max(...allMealTimes);
        const effectDurationMs = effectDurationHours * 60 * 60 * 1000;

        minTime = Math.min(minTime, earliestMeal - effectDurationMs / 2);
        maxTime = Math.max(maxTime, latestMeal + effectDurationMs / 2);
      }
    }

    if (includeFutureEffect) {
      const futureTime = new Date().getTime() + futureHours * 60 * 60 * 1000;
      maxTime = Math.max(maxTime, futureTime);
    }

    const contextBloodSugarData = getFilteredData(bloodGlucoseData);

    // Process meal effects
    const mealEffects = mealData
      .filter((meal) => meal && meal.timestamp && !isNaN(meal.timestamp) && meal.timestamp > 0)
      .map((meal) => {
        try {
          // Calculate unified impact
          const unifiedImpact = calculateUnifiedMealImpact(meal, patientConstants, {
            includeTimeCurve: true,
            durationHours: effectDurationHours,
            currentTime: new Date(),
          });

          return {
            meal,
            effects: unifiedImpact.timeCurve || [],
            unifiedImpact,
          };
        } catch (error) {
          // Error processing meal effect
          return {
            meal,
            effects: [],
            unifiedImpact: null,
          };
        }
      });

    // Create timeline using 15-minute intervals
    const timelineData: TimelinePoint[] = [];
    const interval = 15 * 60 * 1000; // 15 minutes in milliseconds
    let currentTime = minTime;

    // Generate the timeline
    while (currentTime <= maxTime) {
      const bsAtTime = getBloodSugarAtTime(currentTime);

      const timePoint: TimelinePoint = {
        timestamp: currentTime,
        formattedTime: new Date(currentTime).toLocaleString(),
        meals: [],
        mealEffects: {},
        totalMealEffect: 0,
        bloodSugar: bsAtTime ? bsAtTime.bloodSugar : targetGlucose,
        estimatedBloodSugar: bsAtTime ? bsAtTime.bloodSugar : targetGlucose,
        isActualReading: bsAtTime ? bsAtTime.isActualReading || false : false,
        isInterpolated: bsAtTime ? bsAtTime.isInterpolated || false : false,
        isEstimated: bsAtTime ? bsAtTime.isEstimated || false : false,
        dataType: bsAtTime ? bsAtTime.dataType || 'estimated' : 'estimated',
        status: bsAtTime ? bsAtTime.status : getBloodSugarStatus(targetGlucose, targetGlucose),
      };

      // Add meals that occurred at this time point
      mealData.forEach((meal) => {
        if (meal && meal.timestamp && !isNaN(meal.timestamp) && Math.abs(meal.timestamp - currentTime) < interval / 2) {
          const absorptionType = (meal.calculation_summary?.absorption_type ||
            meal.nutrition?.absorptionType ||
            (meal.nutrition as any)?.absorption_type ||
            'medium') as AbsorptionType;

          const mealForTooltip = {
            id: meal.id,
            mealType: meal.mealType,
            carbs: meal.nutrition?.totalCarbs || meal.nutrition?.carbs || 0,
            protein: meal.nutrition?.totalProtein || (meal.nutrition as any)?.protein || 0,
            fat: meal.nutrition?.totalFat || (meal.nutrition as any)?.fat || 0,
            totalCarbEquiv: (meal.nutrition as any)?.totalCarbEquiv || 0,
            absorptionType: absorptionType,
            calculationSummary: meal.calculation_summary,
            foodItems: meal.foodItems || [],
            notes: (meal as any).notes || '',
            parsedFoodName: (meal as any).notes ? (meal as any).notes.split(' - ')[0]?.trim() : null,
          };

          timePoint.meals.push(mealForTooltip);

          // Also add food items to the timePoint for easy access
          if (meal.foodItems && meal.foodItems.length > 0) {
            timePoint.foodItems = meal.foodItems;
          }

          // Store meal carbs
          if (meal.id) {
            timePoint[`mealCarbs.${meal.id}`] = meal.nutrition?.totalCarbs || meal.nutrition?.carbs || 0;
          }
        }
      });

      // Calculate combined meal effects at this time point
      mealEffects.forEach(({ meal, effects, unifiedImpact }) => {
        if (!Array.isArray(effects)) {
          return;
        }

        const effect = effects.find((e) => Math.abs(e.timestamp - currentTime) < interval / 2);
        if (effect && !isNaN(effect.bgImpact) && effect.bgImpact > 0) {
          const mealId = meal.id;
          if (mealId) {
            timePoint.mealEffects[mealId] = effect.bgImpact;
            timePoint[`mealEffect.${mealId}`] = effect.bgImpact;

            // Store unified calculation data in time point for tooltips
            if (unifiedImpact?.calculationSummary) {
              timePoint[`mealInsulin.${mealId}`] = unifiedImpact.calculationSummary.meal_only_suggested_insulin;
            }

            timePoint.totalMealEffect += effect.bgImpact;
          }
        }
      });

      // Validate totalMealEffect
      if (isNaN(timePoint.totalMealEffect)) {
        timePoint.totalMealEffect = 0;
      }

      // Apply meal effect calculations
      if (timePoint.totalMealEffect > 0) {
        timePoint.mealImpactMgdL = timePoint.totalMealEffect;

        if (!timePoint.isActualReading) {
          timePoint.estimatedBloodSugar = timePoint.bloodSugar;
          timePoint.bloodSugar = Math.max(70, timePoint.estimatedBloodSugar + timePoint.mealImpactMgdL);
          (timePoint as any).affectedByMeal = true;
        }

        timePoint.targetWithMealEffect = Math.max(70, targetGlucose + timePoint.mealImpactMgdL);
        timePoint.targetDeviation = timePoint.bloodSugar - targetGlucose;
        timePoint.targetDeviationPercent = Math.round((timePoint.bloodSugar / targetGlucose) * 100);
        timePoint.status = getBloodSugarStatus(timePoint.bloodSugar, targetGlucose);
      }

      timelineData.push(timePoint);
      currentTime += interval;
    }

    const processedTimelineData = prepareTimelineData(timelineData, targetGlucose);
    return processedTimelineData;
  } catch (error) {
    // Error generating meal timeline data
    return [];
  }
}

/**
 * Process timeline data for historical vs. future display
 * 
 * @param timelineData - Raw timeline data
 * @param targetGlucose - Target blood glucose level
 * @returns Processed timeline data
 */
export function prepareTimelineData(timelineData: TimelinePoint[], targetGlucose: number): TimelinePoint[] {
  if (!timelineData || !Array.isArray(timelineData)) return [];

  const now = new Date().getTime();

  return timelineData.map((point) => {
    const isHistorical = point.timestamp < now;
    const newPoint = { ...point };

    // Always save the baseline blood sugar
    newPoint.baselineBloodSugar = newPoint.estimatedBloodSugar;

    // For historical points that aren't actual readings, show only baseline values
    if (isHistorical && !point.isActualReading) {
      // Store the meal effect version for tooltips
      newPoint.bloodSugarWithMealEffect = newPoint.bloodSugar;
      // Set displayed blood sugar to baseline (no meal effect)
      newPoint.bloodSugar = newPoint.estimatedBloodSugar;
    }
    // For future points, ensure we maintain both values
    else if (!isHistorical) {
      // Keep bloodSugar as is (with meal effects)
      // Make sure estimatedBloodSugar has a valid value for future points
      if (!newPoint.estimatedBloodSugar || newPoint.estimatedBloodSugar === 0) {
        newPoint.estimatedBloodSugar =
          point.totalMealEffect > 0
            ? newPoint.bloodSugar - (point.mealImpactMgdL || 0)
            : newPoint.bloodSugar;
      }
    }

    return newPoint;
  });
}

/**
 * Prepare chart data for rendering
 * 
 * @param data - The processed timeline data
 * @param options - Configuration options
 * @returns Data ready for chart rendering
 */
export function prepareChartData(data: TimelinePoint[], options: { now?: number } = {}): TimelinePoint[] {
  if (!data || !Array.isArray(data)) return [];

  const now = options.now || new Date().getTime();

  return data.map((point) => {
    const isHistorical = point.timestamp < now;

    return {
      ...point,
      isHistorical,
      isFuture: !isHistorical,
    };
  });
}

export default {
  generateMealTimelineData,
  prepareTimelineData,
  prepareChartData,
};
