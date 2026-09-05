/**
 * Meal impact curves generation for NATIVE diabetes management platform
 * Ported from frontend/src/utils/BG_Effect.js to TypeScript
 * 
 * Generates physiologically accurate absorption curves for meal impact on blood glucose
 * 
 * @module utils/glucose/meal-impact-curves
 */

import { AbsorptionType } from '../../types/meal.types';
import { PatientConstants } from '../../types/constants.types';

/**
 * Absorption profile configuration
 */
export interface AbsorptionProfile {
  onsetMinutes: number;
  peakMinutes: number;
  plateauMinutes: number;
  durationHours: number;
  riseShape: number;
  fallShape: number;
  peakWidth: number;
  description: string;
}

/**
 * Meal impact curve data point
 */
export interface MealImpactPoint {
  timestamp: number;
  minutesSinceMeal: number;
  hoursSinceMeal: number;
  impactValue: number;
  bgImpact: number;
  absorptionType: AbsorptionType;
  profile: {
    onset: number;
    peak: number;
    plateauEnd: number;
    duration: number;
    description: string;
  };
}

/**
 * Absorption profiles with smoother, physiologically accurate curves
 */
const ABSORPTION_PROFILES: Record<AbsorptionType, AbsorptionProfile> = {
  very_fast: {
    onsetMinutes: 5,
    peakMinutes: 30,
    plateauMinutes: 15,
    durationHours: 2.0,
    riseShape: 1.8,
    fallShape: 1.2,
    peakWidth: 0.3,
    description: 'Simple sugars, glucose',
  },
  fast: {
    onsetMinutes: 15,
    peakMinutes: 60,
    plateauMinutes: 20,
    durationHours: 3.0,
    riseShape: 1.5,
    fallShape: 1.0,
    peakWidth: 0.25,
    description: 'Refined carbohydrates',
  },
  medium: {
    onsetMinutes: 25,
    peakMinutes: 90,
    plateauMinutes: 30,
    durationHours: 4.0,
    riseShape: 1.2,
    fallShape: 0.8,
    peakWidth: 0.3,
    description: 'Mixed meals, whole grains',
  },
  slow: {
    onsetMinutes: 45,
    peakMinutes: 150,
    plateauMinutes: 45,
    durationHours: 5.5,
    riseShape: 1.0,
    fallShape: 0.6,
    peakWidth: 0.4,
    description: 'High fat/protein, fiber-rich',
  },
  very_slow: {
    onsetMinutes: 60,
    peakMinutes: 210,
    plateauMinutes: 60,
    durationHours: 7.0,
    riseShape: 0.8,
    fallShape: 0.4,
    peakWidth: 0.5,
    description: 'Very high fat/fiber content',
  },
};

/**
 * Get human-readable description for absorption type
 */
export function getAbsorptionDescription(absorptionType: AbsorptionType): string {
  return ABSORPTION_PROFILES[absorptionType]?.description || ABSORPTION_PROFILES.medium.description;
}

/**
 * Generate meal impact curve with absorption-specific profiles
 * 
 * @param totalCarbEquiv - Total carbohydrate equivalents
 * @param absorptionType - Absorption type (very_fast, fast, medium, slow, very_slow)
 * @param startTimestamp - Start time of the meal
 * @param durationHours - Maximum duration to project in hours (default 6)
 * @param intervalMinutes - Time interval between data points in minutes (default 5)
 * @param carbToBgFactor - Factor to convert carb units to blood glucose impact (default 4.0)
 * @param absorptionFactor - Absorption rate modifier from constants (default 1.0)
 * @param patientConstants - Patient-specific constants (optional)
 * @returns Array of time points with impact values
 */
export function generateMealImpactCurve(
  totalCarbEquiv: number,
  absorptionType: AbsorptionType = 'medium',
  startTimestamp: number = Date.now(),
  durationHours: number = 6,
  intervalMinutes: number = 5,
  carbToBgFactor: number = 4.0,
  absorptionFactor: number = 1.0,
  patientConstants?: Partial<PatientConstants>
): MealImpactPoint[] {
  // Get profile for the specified absorption type
  const profile = ABSORPTION_PROFILES[absorptionType] || ABSORPTION_PROFILES.medium;

  // Apply absorption factor adjustments
  const adjustedOnsetMinutes = profile.onsetMinutes / absorptionFactor;
  const adjustedPeakMinutes = profile.peakMinutes / absorptionFactor;
  const adjustedPlateauMinutes = profile.plateauMinutes / Math.sqrt(absorptionFactor);
  const adjustedDurationHours = Math.min(
    profile.durationHours / Math.sqrt(absorptionFactor),
    durationHours
  );

  // Calculate plateau end time
  const plateauEndMinutes = adjustedPeakMinutes + adjustedPlateauMinutes;

  const results: MealImpactPoint[] = [];

  // Generate points at specified intervals
  for (let minute = 0; minute <= adjustedDurationHours * 60; minute += intervalMinutes) {
    const minutesSinceStart = minute;
    let impactValue = 0;

    // Calculate impact based on enhanced absorption profile
    if (minutesSinceStart < adjustedOnsetMinutes) {
      // Pre-onset phase - minimal early absorption
      const preOnsetFraction = minutesSinceStart / adjustedOnsetMinutes;
      impactValue = totalCarbEquiv * 0.02 * preOnsetFraction;
    } else if (minutesSinceStart <= adjustedPeakMinutes) {
      // Rising phase - from onset to peak with smoother curve
      const riseTime = minutesSinceStart - adjustedOnsetMinutes;
      const totalRiseTime = adjustedPeakMinutes - adjustedOnsetMinutes;

      if (totalRiseTime > 0) {
        const normalizedRiseTime = riseTime / totalRiseTime;

        // Use sigmoid-like function for smoother, less acute rise
        const sigmoid = (x: number, steepness: number) =>
          1 / (1 + Math.exp(-steepness * (x - 0.5)));
        const sigmoidValue = sigmoid(normalizedRiseTime, profile.riseShape * 4);

        // Apply additional smoothing with cosine function
        const cosineSmoothing = 0.5 * (1 - Math.cos(Math.PI * normalizedRiseTime));

        // Blend sigmoid and cosine for optimal smoothness
        const blendedValue = 0.7 * sigmoidValue + 0.3 * cosineSmoothing;

        impactValue = totalCarbEquiv * blendedValue;
      }
    } else if (minutesSinceStart <= plateauEndMinutes) {
      // Plateau phase - sustained peak level with slight variation
      const plateauTime = minutesSinceStart - adjustedPeakMinutes;
      const plateauFraction = plateauTime / adjustedPlateauMinutes;

      // Add slight natural variation to plateau (±5%)
      const variation = 1 + 0.05 * Math.sin(plateauFraction * Math.PI * 2);

      // Slight decline during plateau (95% to 90% of peak)
      const plateauLevel = 0.95 - 0.05 * plateauFraction;

      impactValue = totalCarbEquiv * plateauLevel * variation;
    } else if (minutesSinceStart <= adjustedDurationHours * 60) {
      // Falling phase - from plateau end to duration end with very smooth decline
      const fallTime = minutesSinceStart - plateauEndMinutes;
      const totalFallTime = adjustedDurationHours * 60 - plateauEndMinutes;

      if (totalFallTime > 0) {
        const normalizedFallTime = fallTime / totalFallTime;

        // Use multiple decay components for more realistic fall
        const primaryDecay = Math.exp(-profile.fallShape * normalizedFallTime);

        // Secondary slower decay for fat/protein absorption
        const secondaryDecay = Math.exp(-profile.fallShape * 0.3 * normalizedFallTime);

        // Combine decays based on absorption type
        let combinedDecay: number;
        if (absorptionType === 'very_fast' || absorptionType === 'fast') {
          combinedDecay = primaryDecay; // Faster foods use primary decay only
        } else {
          // Slower foods blend both decays for extended tail
          combinedDecay = 0.7 * primaryDecay + 0.3 * secondaryDecay;
        }

        // Start from plateau level (90% of peak)
        impactValue = totalCarbEquiv * 0.9 * combinedDecay;
      }
    }

    // Apply absorption factor to final impact
    impactValue *= absorptionFactor;

    // Ensure minimum threshold
    if (impactValue < 0.005 * totalCarbEquiv) {
      impactValue = 0;
    }

    // Calculate BG impact in mg/dL
    const bgImpact = impactValue * carbToBgFactor;

    // Timestamp for this point
    const timestamp = startTimestamp + minute * 60 * 1000;

    // Add point to results
    results.push({
      timestamp,
      minutesSinceMeal: minutesSinceStart,
      hoursSinceMeal: minutesSinceStart / 60,
      impactValue: Math.max(0, impactValue),
      bgImpact: Math.max(0, bgImpact),
      absorptionType,
      profile: {
        onset: adjustedOnsetMinutes,
        peak: adjustedPeakMinutes,
        plateauEnd: plateauEndMinutes,
        duration: adjustedDurationHours * 60,
        description: profile.description,
      },
    });

    // Early termination if impact becomes negligible
    if (minutesSinceStart > plateauEndMinutes && impactValue < 0.01 * totalCarbEquiv) {
      break;
    }
  }

  return results;
}

export default {
  generateMealImpactCurve,
  getAbsorptionDescription,
  ABSORPTION_PROFILES,
};
