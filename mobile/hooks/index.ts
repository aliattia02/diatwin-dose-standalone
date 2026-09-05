/**
 * Hooks barrel export
 * Location: mobile/hooks/index.ts
 */

export { useApi } from './useApi';
export { useAuth } from './useAuth';
export { useOffline } from './useOffline';
export { 
  usePatientConstants, 
  useInsulinToCarbRatio, 
  useCorrectionFactor, 
  useTargetGlucose 
} from './usePatientConstants';
// NEW: Export blood glucose estimation hook
export { useBloodGlucoseEstimation } from './useBloodGlucoseEstimation';
export type { EstimatedBG, UseBloodGlucoseEstimationOptions } from './useBloodGlucoseEstimation';


