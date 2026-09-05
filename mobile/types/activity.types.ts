/**
 * Activity type definitions for NATIVE diabetes management platform
 * @module types/activity
 *
 * Changes:
 *   - Added AOBResult interface (spec §STEP 6).
 *   - Added StackedActivityResult interface (spec §STEP 6).
 *   - Added optional `level` field to Activity (M-4 fix — 0=light, 1=moderate, 2=vigorous).
 */

/**
 * Activity level matching backend ACTIVITY_LEVELS
 */
export interface ActivityLevel {
  /** Numeric value (-2 to 2) */
  value: number;
  /** Display label */
  label: string;
  /** Impact factor on insulin needs */
  impact: number;
}

/**
 * Activity type classification
 */
export type ActivityType =
  | 'walking'
  | 'running'
  | 'cycling'
  | 'swimming'
  | 'strength_training'
  | 'yoga'
  | 'sports'
  | 'housework'
  | 'gardening'
  | 'other';

/**
 * Activity intensity level
 */
export type ActivityIntensity = 'light' | 'moderate' | 'vigorous';

/**
 * Activity record
 */
export interface Activity {
  /** Unique identifier */
  id: string;
  /** User ID who recorded this activity */
  userId: string;
  /** Type of activity */
  type: ActivityType;
  /** Intensity level */
  intensity: ActivityIntensity;
  /** Duration in minutes */
  durationMinutes: number;
  /** Start timestamp (ISO 8601 format) */
  startTime: string;
  /** End timestamp (ISO 8601 format) */
  endTime?: string;
  /** Estimated calories burned */
  caloriesBurned?: number;
  /** Activity level value (-2 to 2) for insulin calculations */
  activityLevel: number;
  /** Notes about the activity */
  notes?: string;
  /** Creation timestamp */
  createdAt?: string;
  /**
   * Numeric intensity level written by the watch recording subsystem (M-4 fix).
   *
   *   0 = light
   *   1 = moderate
   *   2 = vigorous
   *
   * Display fallback: if this field is absent (legacy documents), read the
   * `intensity` string field directly.
   */
  level?: 0 | 1 | 2;
}

/**
 * Predefined activity levels from backend Constants.ACTIVITY_LEVELS
 */
export const ACTIVITY_LEVELS: ActivityLevel[] = [
  { value: -2, label: 'mode 1', impact: 1.2 },
  { value: -1, label: 'mode 2', impact: 1.1 },
  { value: 0, label: 'Normal Activity', impact: 1.0 },
  { value: 1, label: 'High Activity', impact: 0.9 },
  { value: 2, label: 'Vigorous Activity', impact: 0.8 }
];

/**
 * Get activity coefficient for insulin calculations
 * @param activityLevel - Activity level value (-2 to 2)
 * @returns Impact factor for insulin needs
 */
export function getActivityCoefficient(activityLevel: number): number {
  const level = ACTIVITY_LEVELS.find(l => l.value === activityLevel);
  return level ? level.impact : 1.0;
}

/**
 * Activity effect on blood glucose
 */
export interface ActivityEffect {
  /** Start timestamp in milliseconds */
  startTimestamp: number;
  /** Duration of effect in hours */
  durationHours: number;
  /** Peak effect time in hours after start */
  peakHours: number;
  /** Maximum effect percentage */
  maxEffectPercent: number;
  /** Current effect percentage at a given time */
  currentEffect: number;
}

// ─── Activity On Board ────────────────────────────────────────────────────────

/**
 * Activity On Board (AOB) result — analogous to IOB.
 *
 * total_aob is the unsigned sum of remaining acute BG-lowering effect
 * across all sessions (mg/dL still to be delivered).
 *
 * Used by the AOB endpoint and the hypoglycaemia risk display.
 */
export interface AOBResult {
  /** Sum of remaining_bg_drop across all sessions (unsigned mg/dL) */
  total_aob: number;
  /** Per-session breakdown */
  sessions: Array<{
    activity_id:       string;
    /** Unsigned remaining acute drop for this session (mg/dL) */
    remaining_bg_drop: number;
    /** 0.0–1.0 fraction already delivered */
    absorbed_fraction: number;
    /** True while elapsed time < duration_minutes */
    is_active:         boolean;
  }>;
}

// ─── Stacked Activity Result ──────────────────────────────────────────────────

/**
 * Combined result from the stacked pharmacodynamic calculation.
 *
 * Mirrors the shape returned by the backend's calculate_stacked_activity_effect()
 * and the local ODE utility's calculateStackedActivityEffect().
 *
 * ⚠️  Sign convention: cumulative_activity_effect is SIGNED.
 *     Negative = BG-lowering (aerobic default). ALWAYS add it, never subtract.
 */
export interface StackedActivityResult {
  /** Signed net BG effect (mg/dL). Negative = BG-lowering. */
  cumulative_activity_effect: number;
  /**
   * Post-exercise ISF/CR sensitivity multiplier (≥ 1.0).
   * 1.0 = no boost. effective_correction_factor in the PD response is
   * pre-multiplied — do NOT re-apply here.
   */
  sensitivity_multiplier: number;
  /** Unsigned remaining acute drop summed across sessions (mg/dL) */
  activity_on_board: number;
  /** Count of sessions currently within their exercise window */
  active_sessions: number;
}