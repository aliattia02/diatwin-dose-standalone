/**
 * Glucose utilities exports
 * @module utils/glucose
 */

export * from './carb-equivalents';
export * from './meal-impact';
export { 
  generateMealImpactCurve,
  getAbsorptionDescription 
} from './meal-impact-curves';
export { 
  calculateUnifiedMealImpact,
  calculateWeightedAbsorptionType 
} from './blood-glucose-estimation';
export * from './timeline-generator';
export * from './meal-pharmacodynamics';
