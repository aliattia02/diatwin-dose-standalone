/**
 * Types Barrel Export
 * Location: mobile/types/index.ts
 *
 * Description: Central export point for all type definitions
 *
 * Features:
 * - Re-exports all domain types from individual modules
 * - Provides clean import paths (@/types instead of @/types/glucose.types)
 * - Organized by category for easy discovery
 */

// User types
export type {
  User,
  Patient,
  Doctor,
  UserType
} from './user.types';

// Glucose types
export type {
  GlucoseReading,
  GlucoseStatus,
  GlucoseSource,
  GlucoseRange,
  TimeInRange,
  GlucoseStatistics,
  GlucoseTrend,
  CGMReading
} from './glucose.types';

// Insulin types
export type {
  InsulinActionType,
  InsulinCurveType,
  InsulinProfile,
  InsulinDose,
  InsulinActivityPoint,
  InsulinCalculationInput,
  InsulinCalculationResult,
  InsulinPharmacokinetics
} from './insulin.types';

// Meal types
export type {
  MealType,
  AbsorptionType,
  MeasurementType,
  ServingSize,
  FoodItem,
  MealFoodEntry,
  MealNutrition,
  Meal,
  MealImpactCurvePoint,
  CarbEquivalentsResult,
  AbsorptionProfile
} from './meal.types';

// Food types
export type {
  Food,
  FoodCategory,
  FoodPortion,
  FoodDetails,
  SelectedFood,
  CustomFoodData,
  CalculatedNutrients,
  MeasurementsResponse,
  CategoriesResponse,
  FavoriteFood,
  FoodSearchResponse
} from './food';

// Activity types
export type {
  ActivityLevel,
  ActivityType,
  ActivityIntensity,
  Activity,
  ActivityEffect
} from './activity.types';

// Constants types
export type {
  PatientConstants,
  ActivityCoefficients,
  AbsorptionModifiers,
  InsulinTimingGuideline,
  InsulinTimingGuidelines,
  MealTimingFactors,
  TimeOfDayFactor,
  TimeOfDayFactors,
  DiseaseFactor,
  DiseaseFactors,
  MedicationFactor,
  MedicationFactors,
  VolumeMeasurement,
  WeightMeasurement,
  MeasurementSystems,
  MealTypeOption,
  FoodCategoryOption
} from './constants.types';

// Re-export DEFAULT_PATIENT_CONSTANTS
export { DEFAULT_PATIENT_CONSTANTS } from './constants.types';

// Pharmacodynamics types
export type {
  GammaDistributionParams,
  PharmacodynamicProfile,
  ActivityCurvePoint,
  IOBResult,
  MOBResult,
  ActivityCurveData,
  InsulinActivityResult,
  MealActivityResult,
  PharmacodynamicTimelinePoint,
  StackedPharmacodynamicEffect
} from './pharmacodynamics.types';

// Safety types
export type {
  SafetyLevel,
  RiskLevel,
  PriorityLevel,
  SafetyStatus,
  InsulinStackingAnalysis,
  MealStackingAnalysis,
  HypoglycemiaRisk,
  HyperglycemiaRisk,
  DosingSafetyCheck,
  ComprehensiveSafetyAssessment,
  SMBGPriority,
  CounterRegulationResponse
} from './safety.types';

// Calculation types
export type {
  NetEffectResult,
  BGEstimation,
  DetailedEffects,
  TimelinePoint,
  BGTrajectory,
  CalculationOptions,
  NetEffectInput,
  GlucoseVelocity,
  BaselineResult,
  InterpolationResult,
  ValidationMetrics,
  TimeSeriesPoint,
  ChartData
} from './calculation.types';

// API types
export type {
  ApiResponse,
  PaginationInfo,
  PaginatedResponse,
  LoginResponse,
  RegisterResponse,
  PatientConstantsResponse,
  MealResponse,
  MealsListResponse,
  BloodSugarResponse,
  BloodSugarCreateResponse,
  InsulinLogResponse,
  InsulinDataResponse,
  ActiveInsulinResponse,
  ActivityResponse,
  FoodSearchResult,
  FoodCategoriesResponse,
  ApiError
} from './api';

// Navigation types
export type {
  AuthStackParamList,
  TabsParamList,
  LogStackParamList,
  MealStackParamList,
  SettingsStackParamList,
  RootStackParamList,
  ScreenProps
} from './navigation';