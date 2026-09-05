/**
 * Meal Form
 * Location: mobile/components/forms/MealForm.tsx
 *
 * Main Component: MealForm
 * Description: Comprehensive meal logging form with insulin calculator,
 *              activity tracking, and blood sugar monitoring.
 *
 * UPDATED: Insulin calculation now runs entirely on-device using
 *          insulinCalculationService.ts — no backend call needed.
 *          Logic mirrors MealInput.jsx → calculateInsulinNeeds() exactly.
 *
 * Calculation pipeline (matches JS web app):
 *   1. calculateTotalNutrients()   – carbs/protein/fat + weighted absorption type
 *   2. calculateCarbEquivalents()  – protein & fat → carb-equivalent grams
 *   3. base insulin                – totalCarbEquiv / insulin_to_carb_ratio
 *   4. calculateActivityImpact()   – scale by activity level & duration
 *   5. correctionInsulin           – (BG − target) / correction_factor
 *   6. IOB/MOB deduction           – subtract active IOB, add MOB equivalent
 *   7. peakOverlapAdjustment       – predictive overlap of existing MOB/IOB
 *   8. calculateHealthFactors()    – disease + medication multipliers
 *   9. Round to 0.1u, 0.5u safety floor
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Modal,
  Alert,
  Platform,
} from 'react-native';
import { apiClient } from '../../services/api/client';

// Import UNIFIED child components
import UnifiedActivityInput from './UnifiedActivityInput';
import UnifiedBloodSugarInput, { type BloodSugarData } from './UnifiedBloodSugarInput';
import UnifiedInsulinInput, { type InsulinData } from './UnifiedInsulinInput';
import UnifiedTimePicker, { type TimeMode } from './UnifiedTimePicker';
import FoodSearch from '../meal/FoodSearch';
import SelectedFoodsList from '../meal/SelectedFoodsList';
import MealTimingGuidelines from '../meal/MealTimingGuidelines';
import { TimeManager } from '@/utils/time';

// Import hooks
import { usePatientConstants } from '../../hooks/usePatientConstants';
import { useActiveEffects } from '../../hooks/useActiveEffects';
import { useMealStore } from '../../store/meal.store';

// Import API
import API from '../../services/api/endpoints'; // I-25: single source of truth for all endpoint paths
import { getActiveInsulin } from '../../services/api/insulin';
import { getActiveEffectsFull } from '../../services/api/calculations';
import type { ActiveEffectsFullResult } from '../../services/api/calculations';
// ✅ Activity PD: fetch stacked exercise effect for the current day
import {
  fetchStackedActivityEffectSafe,
} from '../../services/api/activity-pharmacodynamics';
import type { ActivityPDResult } from '../../services/api/activity-pharmacodynamics';
// ✅ Live PK snapshot resolver — merges AED live data with stale API snapshot
import { resolveLiveEffects } from '@/utils/calculations/resolve-live-effects';
import type { ActiveEffectData } from '@/types/active-effects.types';

// ✅ NEW: Import the on-device insulin calculation service
import {
  calculateInsulinNeeds,
  calculateTotalNutrients,
  computeSyntheticSensitivityMultiplier,
  computeSyntheticAOB,
  type InsulinCalculationResult,
} from '../../services/insulinCalculationService';

// ── Insulin type suggestion config — from shared-constants (mirrors constants.py) ──
import { SHARED_CONSTANTS, ABSORPTION_TO_INSULIN_CONFIG, getCircadianBaseline, type AbsorptionType } from '@/constants/shared-constants';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface MealFormData {
  mealType: string;
  mealTime: string;            // UTC ISO string
  selectedFoods: any[];
  activityIds?: string[];
  bloodSugar?: number;
  bloodSugarTimestamp?: string; // UTC ISO string
  bloodSugarUnit?: string;
  intendedInsulin?: number;
  intendedInsulinType?: string;
  insulinTimestamp?: string;   // UTC ISO string
  notes?: string;
  calculationFactors?: any;
}

// Kept for backward compatibility if parent still passes onCalculate
export interface MealCalculationResult {
  calculations?: { nutrition?: any; insulin?: any };
  suggestedInsulin?: number;
  nutrition?: any;
  breakdown?: any;
}

interface MealFormProps {
  onSubmit: (data: MealFormData) => Promise<void>;
  /**
   * @deprecated Calculation now runs on-device; onCalculate is no longer called.
   *             The prop is kept for API stability — existing call-sites need no changes.
   */
  onCalculate?: (data: Partial<MealFormData>) => Promise<MealCalculationResult>;
  onCancel: () => void;
  isLoading: boolean;
  /**
   * Live PK snapshot from ActiveEffectsDisplay.onEffectsComputed().
   *
   * When provided, `performLocalCalculation` uses these values instead of the
   * stale `getActiveEffectsFull()` API snapshot for MOB, IOB, AOB, estimatedBG,
   * and projectedBG — guaranteeing the meal form's calculation matches what the
   * patient sees on the Active Effects panel.
   *
   * Wire up at the screen level:
   *   const [aedSnapshot, setAedSnapshot] = useState<ActiveEffectData | null>(null);
   *   <ActiveEffectDisplay onEffectsComputed={setAedSnapshot} />
   *   <MealForm liveActiveEffects={aedSnapshot ?? undefined} … />
   */
  liveActiveEffects?: ActiveEffectData;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the recommended minutes between insulin dose and eating,
 * based on the slowest-absorbing food in the selection.
 */
const getTimingMinutes = (foods: any[], patientConstants: any): number => {
  if (foods.length === 0) return 0;
  const absorptionPriority: Record<string, number> = {
    very_slow: 5, slow: 4, medium: 3, fast: 2, very_fast: 1,
  };
  // timing_minutes = minutes to wait after injecting before eating.
  // very_fast -> 0 (inject at meal start), very_slow -> 30 (most pre-loading needed).
  // Fallback minutes sourced from shared-constants — single source of truth
  const sharedGuidelines = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.insulin_timing_guidelines;
  const defaultMins: Record<string, number> = Object.fromEntries(
    Object.entries(sharedGuidelines).map(([k, v]) => [k, v.timing_minutes])
  );
  const guidelineMap = (patientConstants as any)?.insulin_timing_guidelines ?? {};
  const absorptionTypes = foods.map((f: any) => f.details?.absorption_type || 'medium');
  const slowestType = absorptionTypes.reduce(
    (s: string, c: string) =>
      (absorptionPriority[c] || 3) > (absorptionPriority[s] || 3) ? c : s,
    absorptionTypes[0], // seed with first food's actual type, not hardcoded 'medium'
  );
  return guidelineMap[slowestType]?.timing_minutes ?? defaultMins[slowestType] ?? 10;
};

// ─── Absorption priority (slowest food drives the suggestion) ─────────────────
const ABSORPTION_PRIORITY: Record<string, number> = {
  very_slow: 5, slow: 4, medium: 3, fast: 2, very_fast: 1,
};

function getDominantAbsorptionType(foods: any[]): AbsorptionType {
  if (foods.length === 0) return 'medium';
  const types = foods.map(f => (f.details?.absorption_type || 'medium') as AbsorptionType);
  return types.reduce(
    (slowest, current) =>
      (ABSORPTION_PRIORITY[current] || 3) > (ABSORPTION_PRIORITY[slowest] || 3)
        ? current : slowest,
    types[0], // seed with first food's actual type, not hardcoded 'medium'
  );
}

// ─── Mixed-meal detection ────────────────────────────────────────────────────
// A "mixed meal" is any combination where at least one item is slow/very_slow
// AND at least one is medium/fast/very_fast — the pizza-effect scenario where
// a single bolus cannot cover both the early carb spike and the fat-delayed peak.
const MIXED_SLOW_TYPES = new Set(['slow', 'very_slow']);
const MIXED_FAST_TYPES = new Set(['very_fast', 'fast', 'medium']);

function detectMixedMeal(foods: any[]): boolean {
  const hasSlow = foods.some(f => MIXED_SLOW_TYPES.has(f.details?.absorption_type ?? ''));
  const hasFast = foods.some(f => MIXED_FAST_TYPES.has(f.details?.absorption_type ?? ''));
  return hasSlow && hasFast;
}

/**
 * Reads brand names directly from patient constants (or SHARED_CONSTANTS fallback).
 * This keeps brand names in sync with constants.py via shared-constants.ts —
 * no manual duplication.
 */
function getInsulinBrandNames(
  absorptionType: AbsorptionType,
  medicationFactors: Record<string, any>,
): string {
  const config = ABSORPTION_TO_INSULIN_CONFIG[absorptionType];
  const keys = config.preferredKeys
    ?? Object.keys(medicationFactors).filter(k =>
        config.typeFilter.includes(medicationFactors[k]?.type)
      );
  const brands = keys
    .flatMap(k => medicationFactors[k]?.brand_names ?? [])
    .filter(Boolean);
  // Deduplicate
  return [...new Set(brands)].join('  ·  ');
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const MEAL_TYPES = [
  { value: 'breakfast', label: 'Breakfast', icon: '🌅' },
  { value: 'lunch',     label: 'Lunch',     icon: '☀️' },
  { value: 'dinner',    label: 'Dinner',    icon: '🌙' },
  { value: 'snack',     label: 'Snack',     icon: '🍎' },
];



// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// FullInsulinBreakdown — mirrors MealInput.js breakdown card display exactly
// ─────────────────────────────────────────────────────────────────────────────

interface FullInsulinBreakdownProps {
  result: InsulinCalculationResult;
  patientConstants: any;
  warning?: string;
}

const FullInsulinBreakdown: React.FC<FullInsulinBreakdownProps> = ({ result, patientConstants, warning }) => {
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const bd = result.breakdown;
  const total = result.total;

  const activityPct = bd.activityImpact !== 1.0
    ? `${((bd.activityImpact - 1) * 100).toFixed(1)}%`
    // When manual activities were routed through the sensitivity pathway (coefficient
    // bypassed, activityImpact = 1.0), surface the same dose-reduction % here.
    : bd.activitySensitivityMultiplier > 1.001
      ? `−${(((bd.activitySensitivityMultiplier - 1) / bd.activitySensitivityMultiplier) * 100).toFixed(1)}%`
      : '0.0%';

  const pharmPct = (bd.absorptionFactor !== 1.0 || bd.mealTimingFactor !== 1.0)
    ? `${(((bd.absorptionFactor * bd.mealTimingFactor) - 1) * 100).toFixed(1)}%`
    : '0.0% (no adjustment)';

  const hasCorrectionDose = bd.correctionInsulin !== 0 && bd.bloodSugarUsed > 0;
  const hasActiveEffects  = bd.activeInsulin > 0 || bd.activeMealCarbs > 0 || bd.aobInsulinEquivalent > 0;
  const CF = patientConstants?.correction_factor ?? 40;
  const ICR = patientConstants?.insulin_to_carb_ratio ?? 10;
  // Show exercise card when there is a meaningful post-exercise effect
  const hasExerciseEffect = bd.activitySensitivityMultiplier > 1.001 || bd.activityOnBoard > 0;
  const sensitivityPct = hasExerciseEffect
    ? `−${(((bd.activitySensitivityMultiplier - 1) / bd.activitySensitivityMultiplier) * 100).toFixed(1)}%`
    : '0.0%';

  const toggle = (card: string) => setExpandedCard(expandedCard === card ? null : card);

  return (
    <View style={bStyles.container}>
      <Text style={bStyles.title}>Insulin Calculation Summary</Text>

      {/* Generic warning */}
      {!!warning && (
        <View style={bStyles.warningBox}>
          <Text style={bStyles.warningText}>⚠️ {warning}</Text>
        </View>
      )}

      {/* IOB Surplus — brief reference; full alert shown in the dose card above */}
      {bd.iobSurplusWarning && (
        <View style={bStyles.iobWarningCard}>
          <Text style={bStyles.iobWarningTitle}>
            ⚠️ IOB surplus: {bd.iobSurplusWarning.surplusUnits.toFixed(1)} u — see dose card for details
          </Text>
        </View>
      )}

      {/* ── Card 1: Base Insulin ── */}
      <TouchableOpacity style={bStyles.card} onPress={() => toggle('base')} activeOpacity={0.85}>
        <View style={bStyles.cardHeader}>
          <View style={bStyles.cardLabelContainer}>
            <Text style={bStyles.cardLabel}>Base Insulin Needs</Text>
            {hasExerciseEffect && (
              <Text style={bStyles.cardSubLabel}>🏃 Exercise sensitivity applied ({sensitivityPct})</Text>
            )}
          </View>
          <Text style={bStyles.cardValue}>{bd.adjustedInsulin.toFixed(1)} units</Text>
        </View>
        {expandedCard === 'base' && (
          <View style={bStyles.cardBody}>
            <View style={bStyles.row}><Text style={bStyles.detail}>Carbohydrates</Text><Text style={bStyles.detail}>{bd.carbsActual.toFixed(1)}g</Text></View>
            <View style={bStyles.row}><Text style={bStyles.detail}>Protein equivalent</Text><Text style={bStyles.detail}>{bd.proteinCarbEquiv.toFixed(1)}g</Text></View>
            <View style={bStyles.row}><Text style={bStyles.detail}>Fat equivalent</Text><Text style={bStyles.detail}>{bd.fatCarbEquiv.toFixed(2)}g</Text></View>
            <View style={[bStyles.row, bStyles.rowHighlight]}><Text style={bStyles.detailBold}>Total carb equivalent</Text><Text style={bStyles.detailBold}>{bd.totalCarbEquiv.toFixed(1)}g</Text></View>
            <Text style={bStyles.formula}>÷ {ICR} (ICR) = {bd.baseInsulin.toFixed(2)} u</Text>
            {hasExerciseEffect && (
              <>
                <View style={bStyles.divider} />
                <View style={[bStyles.row, bStyles.rowHighlight, { marginTop: 4 }]}>
                  <Text style={bStyles.detailBold}>🏃 Exercise sensitivity (÷{bd.activitySensitivityMultiplier.toFixed(2)})</Text>
                  <Text style={[bStyles.detailBold, bStyles.valueNegative]}>{bd.adjustedInsulin.toFixed(2)} u ({sensitivityPct})</Text>
                </View>
              </>
            )}
          </View>
        )}
      </TouchableOpacity>

      {/* ── Card 2: Activity Impact (manual, from form) ── */}
      <TouchableOpacity style={bStyles.card} onPress={() => toggle('activity')} activeOpacity={0.85}>
        <View style={bStyles.cardHeader}>
          <Text style={bStyles.cardLabel}>Activity Impact</Text>
          <Text style={bStyles.cardValue}>{activityPct}</Text>
        </View>
      </TouchableOpacity>


      {/* ── Card 3: Pharmacodynamic Adjustments ── */}
      <TouchableOpacity style={bStyles.card} onPress={() => toggle('pharm')} activeOpacity={0.85}>
        <View style={bStyles.cardHeader}>
          <Text style={bStyles.cardLabel}>Pharmacodynamic Adjustments</Text>
          <Text style={bStyles.cardValue}>{pharmPct}</Text>
        </View>
      </TouchableOpacity>

      {/* ── Card 4: Current State Correction (BG) ── */}
      {hasCorrectionDose && (
        <TouchableOpacity style={bStyles.card} onPress={() => toggle('correction')} activeOpacity={0.85}>
          <View style={bStyles.cardHeader}>
            <View style={bStyles.cardLabelContainer}>
              <Text style={bStyles.cardLabel}>Current State Correction</Text>
              <Text style={bStyles.cardSubLabel}>📊 Accounts for your current blood sugar position</Text>
            </View>
            <Text style={[bStyles.cardValue, bd.correctionInsulin >= 0 ? bStyles.valuePositive : bStyles.valueNegative]}>
              {bd.correctionInsulin >= 0 ? '+' : ''}{bd.correctionInsulin.toFixed(1)} units
            </Text>
          </View>
          {expandedCard === 'correction' && (
            <View style={bStyles.cardBody}>
              <View style={bStyles.row}>
                <Text style={bStyles.detail}>Current BG</Text>
                <Text style={bStyles.detail}>
                  {bd.bloodSugarUsed.toFixed(0)} mg/dL
                  {bd.bloodSugarSource === 'estimated'
                    ? (bd.bloodSugarConfidence === 'circadian_preset' ? ' · Circadian est.' : ' · Estimated')
                    : ''}
                  {bd.minutesSinceReading > 0 ? ` · ${bd.minutesSinceReading} min ago` : ''}
                </Text>
              </View>
              <View style={bStyles.row}>
                <Text style={bStyles.detail}>Target BG</Text>
                <Text style={bStyles.detail}>{patientConstants?.target_glucose ?? 100} mg/dL</Text>
              </View>
              <View style={bStyles.row}>
                <Text style={bStyles.detail}>
                  Correction Factor{hasExerciseEffect ? ` 🏃 (was ${CF}, widened by exercise)` : ''}
                </Text>
                <Text style={bStyles.detail}>1 u / {hasExerciseEffect ? bd.effectiveCF.toFixed(0) : CF} mg/dL</Text>
              </View>
              <View style={[bStyles.row, bStyles.rowHighlight]}>
                <Text style={bStyles.detailBold}>Correction Needed</Text>
                <Text style={bStyles.detailBold}>{bd.correctionInsulin.toFixed(1)} u = ({bd.bloodSugarUsed.toFixed(0)} − {patientConstants?.target_glucose ?? 100}) / {hasExerciseEffect ? bd.effectiveCF.toFixed(0) : CF}</Text>
              </View>
            </View>
          )}
        </TouchableOpacity>
      )}

      {/* ── Card 5: Active Effects Adjustment (IOB / MOB) ── */}
      {hasActiveEffects && (
        <TouchableOpacity style={bStyles.card} onPress={() => toggle('active')} activeOpacity={0.85}>
          <View style={bStyles.cardHeader}>
            <View style={bStyles.cardLabelContainer}>
              <Text style={bStyles.cardLabel}>Active Effects Adjustment</Text>
              <Text style={bStyles.cardSubLabel}>⏳ Accounts for insulin, carbs and activity still working</Text>
            </View>
            <Text style={bStyles.valueNegative}>
              {(() => { const net = bd.activeInsulin - bd.mobInsulinEquivalent + bd.aobInsulinEquivalent; return (net >= 0 ? '-' : '+') + Math.abs(net).toFixed(1); })()} units
            </Text>
          </View>
          {expandedCard === 'active' && (
            <View style={bStyles.cardBody}>
              {bd.activeInsulin > 0 && (
                <View style={bStyles.row}>
                  <Text style={bStyles.detail}>💉 IOB (active insulin)</Text>
                  <Text style={[bStyles.detail, bStyles.valueNegative]}>−{bd.activeInsulin.toFixed(1)} u · ~{(bd.activeInsulin * CF).toFixed(0)} mg/dL drop</Text>
                </View>
              )}
              {bd.activeMealCarbs > 0 && (
                <View style={bStyles.row}>
                  <Text style={bStyles.detail}>🍽️ MOB (active carbs)</Text>
                  <Text style={[bStyles.detail, bStyles.valuePositive]}>+{bd.mobInsulinEquivalent.toFixed(1)} u · ~{(bd.mobInsulinEquivalent * CF).toFixed(0)} mg/dL rise</Text>
                </View>
              )}
              {bd.aobInsulinEquivalent > 0 && (
                <View style={bStyles.row}>
                  <Text style={bStyles.detail}>🏃 AOB (exercise pending)</Text>
                  <Text style={[bStyles.detail, bStyles.valueNegative]}>−{bd.aobInsulinEquivalent.toFixed(1)} u · {bd.activityOnBoard?.toFixed(1) ?? '?'} mg/dL drop</Text>
                </View>
              )}
              {(() => {
                const net   = bd.activeInsulin - bd.mobInsulinEquivalent + bd.aobInsulinEquivalent;
                const iobBg = bd.activeInsulin        * CF;
                const mobBg = bd.mobInsulinEquivalent * CF;
                const aobBg = bd.aobInsulinEquivalent * CF;
                const netBg = mobBg - iobBg - aobBg; // positive = net rise, negative = net drop
                return (
                  <View style={[bStyles.row, bStyles.rowHighlight, { marginTop: 4 }]}>
                    <Text style={bStyles.detailBold}>
                      {net >= 0 ? 'Net Reduction' : 'Net Addition'}
                    </Text>
                    <Text style={[bStyles.detailBold, net >= 0 ? bStyles.valueNegative : bStyles.valuePositive]}>
                      {(net >= 0 ? '-' : '+') + Math.abs(net).toFixed(1)} units · ~{Math.abs(netBg).toFixed(0)} mg/dL {netBg >= 0 ? 'rise' : 'drop'}
                    </Text>
                  </View>
                );
              })()}
            </View>
          )}
        </TouchableOpacity>
      )}

      {/* ── Card 6: Final Dose ── */}
      <TouchableOpacity style={[bStyles.card, bStyles.cardFinal]} onPress={() => toggle('final')} activeOpacity={0.85}>
        <View style={bStyles.cardHeader}>
          <Text style={[bStyles.cardLabel, bStyles.cardLabelFinal]}>Suggested Insulin Dose</Text>
          <Text style={[bStyles.cardValue, bStyles.cardValueFinal]}>{total.toFixed(1)} units</Text>
        </View>
        {expandedCard === 'final' && (
          <View style={bStyles.cardBody}>
            <Text style={bStyles.calcTitle}>📋 Complete Calculation:</Text>

            <View style={bStyles.calcStep}>
              <Text style={bStyles.stepNum}>1.</Text>
              <Text style={bStyles.stepLabel}>Base Insulin for Meal:</Text>
              <Text style={bStyles.stepValue}>{bd.adjustedInsulin.toFixed(1)} units</Text>
            </View>
            <Text style={bStyles.stepDetail}>({bd.totalCarbEquiv.toFixed(1)}g carb equiv ÷ {ICR} ratio)</Text>

            {hasCorrectionDose && (
              <>
                <View style={bStyles.calcStep}>
                  <Text style={bStyles.stepNum}>2.</Text>
                  <Text style={bStyles.stepLabel}>Current State Correction:</Text>
                  <Text style={[bStyles.stepValue, bd.correctionInsulin >= 0 ? bStyles.valuePositive : bStyles.valueNegative]}>
                    {bd.correctionInsulin >= 0 ? '+' : ''}{bd.correctionInsulin.toFixed(1)} units
                  </Text>
                </View>
                <Text style={bStyles.stepDetail}>Current BG ({bd.bloodSugarUsed.toFixed(0)}) already includes absorbed carbs &amp; insulin</Text>
              </>
            )}

            <View style={bStyles.divider} />
            <View style={bStyles.calcStep}>
              <Text style={bStyles.subtotalLabel}>Subtotal:</Text>
              <Text style={bStyles.subtotalValue}>{bd.preActiveTotal.toFixed(1)} units</Text>
            </View>

            {hasActiveEffects && (
              <>
                <View style={bStyles.calcStep}>
                  <Text style={bStyles.stepNum}>{hasCorrectionDose ? '3.' : '2.'}</Text>
                  <Text style={bStyles.stepLabel}>Active Effects Adjustment:</Text>
                </View>
                {bd.activeInsulin > 0 && (
                  <View style={bStyles.calcItem}>
                    <Text style={bStyles.calcItemLabel}>• Active Insulin (IOB):</Text>
                    <Text style={bStyles.valueNegative}>-{bd.activeInsulin.toFixed(1)} units</Text>
                  </View>
                )}
                {bd.activeMealCarbs > 0 && (
                  <View style={bStyles.calcItem}>
                    <Text style={bStyles.calcItemLabel}>• Active Meal Carbs (MOB):</Text>
                    <Text style={bStyles.valuePositive}>+{bd.mobInsulinEquivalent.toFixed(1)} units</Text>
                  </View>
                )}
                {bd.aobInsulinEquivalent > 0 && (
                  <View style={bStyles.calcItem}>
                    <Text style={bStyles.calcItemLabel}>• Activity On Board (AOB):</Text>
                    <Text style={bStyles.valueNegative}>-{bd.aobInsulinEquivalent.toFixed(1)} units</Text>
                  </View>
                )}
                <Text style={bStyles.stepDetail}>IOB reduces dose; MOB (active carbs) adds back; AOB (pending exercise drop) reduces dose</Text>
                <View style={bStyles.divider} />
                <View style={bStyles.calcStep}>
                  <Text style={bStyles.subtotalLabel}>After Active Adjustments:</Text>
                  <Text style={bStyles.subtotalValue}>{bd.postActiveTotal.toFixed(1)} units</Text>
                </View>
              </>
            )}

            {bd.overlapAdjustment !== 1.0 && (
              <>
                <View style={bStyles.calcStep}>
                  <Text style={bStyles.stepNum}>{hasActiveEffects ? (hasCorrectionDose ? '4.' : '3.') : (hasCorrectionDose ? '3.' : '2.')}</Text>
                  <Text style={bStyles.stepLabel}>Peak Overlap Adjustment:</Text>
                  <Text style={bStyles.stepValue}>×{bd.overlapAdjustment.toFixed(2)}</Text>
                </View>
                <Text style={bStyles.stepDetail}>Predictive adjustment for existing MOB/IOB peak overlap</Text>
              </>
            )}

            {bd.healthMultiplier !== 1.0 && (
              <>
                <View style={bStyles.calcStep}>
                  <Text style={bStyles.stepNum}>
                    {[hasActiveEffects, bd.overlapAdjustment !== 1.0, hasCorrectionDose].filter(Boolean).length + 2}.
                  </Text>
                  <Text style={bStyles.stepLabel}>Health Factor Multiplier:</Text>
                  <Text style={bStyles.stepValue}>×{bd.healthMultiplier.toFixed(2)}</Text>
                </View>
                <Text style={bStyles.stepDetail}>Accounts for illness, medications, or other health factors</Text>
              </>
            )}

            <View style={bStyles.thickDivider} />
            <View style={bStyles.finalRow}>
              <Text style={bStyles.finalLabel}>FINAL DOSE:</Text>
              <Text style={bStyles.finalValue}>{total.toFixed(1)} units</Text>
            </View>
            {(() => {
              // Compute the true result before Math.max(0) floor so the patient
              // can see the actual surplus, not just "= 0.0 units"
              const preFloorTotal =
                bd.postActiveTotal * bd.overlapAdjustment * bd.healthMultiplier;
              const wasClamped = preFloorTotal < -0.05; // tolerance for rounding
              return (
                <Text style={bStyles.formulaText}>
                  {'Formula: ('}
                  {bd.adjustedInsulin.toFixed(1)}
                  {hasCorrectionDose ? ` ${bd.correctionInsulin >= 0 ? '+' : ''}${bd.correctionInsulin.toFixed(1)}` : ''}
                  {bd.activeInsulin > 0 ? ` − ${bd.activeInsulin.toFixed(1)}` : ''}
                  {bd.mobInsulinEquivalent > 0 ? ` + ${bd.mobInsulinEquivalent.toFixed(1)}` : ''}
                  {bd.aobInsulinEquivalent > 0 ? ` − ${bd.aobInsulinEquivalent.toFixed(1)} AOB` : ''}
                  {')'}
                  {bd.overlapAdjustment !== 1.0 ? ` × ${bd.overlapAdjustment.toFixed(2)}` : ''}
                  {bd.healthMultiplier !== 1.0 ? ` × ${bd.healthMultiplier.toFixed(2)}` : ''}
                  {' = '}
                  {preFloorTotal.toFixed(1)} units
                  {wasClamped ? `  →  0.0 u (IOB covers this meal — consider ${bd.iobSurplusWarning?.extraCarbsNeeded ?? Math.round(Math.abs(preFloorTotal) * ICR)}g fast carbs)` : ''}
                </Text>
              );
            })()}
          </View>
        )}
      </TouchableOpacity>
    </View>
  );
};

// Breakdown styles
const bStyles = StyleSheet.create({
  container:     { marginBottom: 16 },
  title:         { fontSize: 16, fontWeight: '700', color: '#333', marginBottom: 8, paddingHorizontal: 4 },
  warningBox:    { backgroundColor: '#fff3e0', borderRadius: 8, padding: 10, marginBottom: 8, borderLeftWidth: 3, borderLeftColor: '#ff9800' },
  warningText:   { color: '#e65100', fontSize: 13 },
  card:          { backgroundColor: '#fff', borderRadius: 10, marginBottom: 8, overflow: 'hidden', borderWidth: 1, borderColor: '#e0e0e0', elevation: 1, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2 },
  cardFinal:     { borderColor: '#1976d2', borderWidth: 2 },
  cardExercise:  { borderColor: '#2e7d32', borderLeftWidth: 4, borderLeftColor: '#4caf50' },
  cardHeader:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 12 },
  cardLabelContainer: { flex: 1, paddingRight: 8 },
  cardLabel:     { fontSize: 14, fontWeight: '600', color: '#333' },
  cardLabelFinal:{ color: '#1976d2' },
  cardSubLabel:  { fontSize: 11, color: '#888', marginTop: 2 },
  cardValue:     { fontSize: 15, fontWeight: '700', color: '#333' },
  cardValueFinal:{ fontSize: 18, color: '#1976d2' },
  cardBody:      { backgroundColor: '#fafafa', padding: 12, borderTopWidth: 1, borderTopColor: '#f0f0f0' },
  row:           { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  rowHighlight:  { backgroundColor: '#e3f2fd', borderRadius: 4, paddingHorizontal: 6, marginTop: 4 },
  detail:        { fontSize: 13, color: '#555' },
  detailBold:    { fontSize: 13, fontWeight: '600', color: '#333' },
  formula:       { fontSize: 12, color: '#888', marginTop: 6, fontStyle: 'italic' },
  noteText:      { fontSize: 12, color: '#666', marginBottom: 8, fontStyle: 'italic' },
  activeRow:     { backgroundColor: '#f3f0ff', borderRadius: 6, padding: 8, marginBottom: 6 },
  activeLabel:   { fontSize: 13, fontWeight: '600', color: '#333' },
  activeSubLabel:{ fontSize: 12, color: '#666', marginTop: 2 },
  infoBox:       { backgroundColor: '#e8f4fd', borderRadius: 6, padding: 8, marginTop: 8 },
  infoText:      { fontSize: 12, fontWeight: '600', color: '#1565c0' },
  infoSubText:   { fontSize: 11, color: '#555', marginTop: 2 },
  calcTitle:     { fontSize: 13, fontWeight: '700', color: '#333', marginBottom: 10 },
  calcStep:      { flexDirection: 'row', alignItems: 'center', marginBottom: 2 },
  stepNum:       { fontSize: 13, fontWeight: '700', color: '#1976d2', width: 20 },
  stepLabel:     { fontSize: 13, fontWeight: '600', color: '#333', flex: 1 },
  stepValue:     { fontSize: 13, fontWeight: '700', color: '#333' },
  stepDetail:    { fontSize: 11, color: '#888', marginLeft: 20, marginBottom: 4 },
  calcItem:      { flexDirection: 'row', justifyContent: 'space-between', marginLeft: 20, marginBottom: 2 },
  calcItemLabel: { fontSize: 12, color: '#555' },
  divider:       { height: 1, backgroundColor: '#e0e0e0', marginVertical: 8 },
  thickDivider:  { height: 2, backgroundColor: '#bdbdbd', marginVertical: 10 },
  subtotalLabel: { fontSize: 13, fontWeight: '700', color: '#333', flex: 1 },
  subtotalValue: { fontSize: 14, fontWeight: '700', color: '#333' },
  finalRow:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  finalLabel:    { fontSize: 15, fontWeight: '800', color: '#1976d2' },
  finalValue:    { fontSize: 20, fontWeight: '800', color: '#1976d2' },
  formulaText:   { fontSize: 11, color: '#888', marginTop: 8, fontStyle: 'italic', lineHeight: 16 },
  valuePositive: { color: '#f57c00' },
  valueNegative: { color: '#c62828' },

  // ── IOB surplus warning (inside breakdown) ────────────────────────────────
  iobWarningCard:   { backgroundColor: '#fff3e0', borderRadius: 6, borderWidth: 1, borderColor: '#e65100', borderLeftWidth: 4, borderLeftColor: '#e65100', padding: 8, marginBottom: 8 },
  iobWarningTitle:  { fontSize: 12, fontWeight: '700', color: '#bf360c', marginBottom: 3 },
  iobWarningBody:   { fontSize: 11, color: '#5d4037', lineHeight: 16, marginBottom: 6 },
  iobWarnHighlight: { backgroundColor: '#ffe0b2', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, marginTop: 2 },
  iobWarnCarbLabel: { fontSize: 12, fontWeight: '700', color: '#e65100' },
  iobWarnCarbValue: { fontSize: 13, fontWeight: '800', color: '#bf360c' },
  iobWarningNote:   { fontSize: 10, color: '#795548', fontStyle: 'italic', lineHeight: 14, marginTop: 4 },
});

// ─────────────────────────────────────────────────────────────────────────────
// MealForm Component
// ─────────────────────────────────────────────────────────────────────────────

const MealForm: React.FC<MealFormProps> = ({ onSubmit, onCancel, isLoading, liveActiveEffects }) => {

  // ── Store / hooks ─────────────────────────────────────────────────────────
  const { activeInsulin, fetchRecentMeals, recentMeals } = useMealStore();
  const { constants, isLoading: constantsLoading, hasLoadedFromAPI } = usePatientConstants();
  const {
    estimatedBG: netEffectEstimatedBG,
    baselineMode: netEffectBaselineMode,
  } = useActiveEffects({
    autoRefresh:     true,
    refreshInterval: 60_000,
    windowHours:     24,
    skipIobCutoff:   false,
  });

  // ── Form state ────────────────────────────────────────────────────────────
  const [mealType, setMealType]         = useState('breakfast');
  const [mealTimeUTC, setMealTimeUTC]   = useState<string>(new Date().toISOString());
  const [mealTimeMode, setMealTimeMode] = useState<TimeMode>('now');

  // Foods
  const [selectedFoods, setSelectedFoods]       = useState<any[]>([]);
  const [tempSelectedFoods, setTempSelectedFoods] = useState<any[]>([]);
  const [isFoodsSaved, setIsFoodsSaved]         = useState(false);
  const [showFoodModal, setShowFoodModal]       = useState(false);

  // Blood sugar
  const [bloodSugarData, setBloodSugarData]     = useState<BloodSugarData | null>(null);
  const [savedBloodSugar, setSavedBloodSugar]   = useState<BloodSugarData | null>(null);
  const [isBloodSugarSaved, setIsBloodSugarSaved] = useState(false);

  // Activities
  const [activities, setActivities]           = useState<any[]>([]);
  const [savedActivities, setSavedActivities] = useState<any[]>([]);
  const [isActivitiesSaved, setIsActivitiesSaved] = useState(false);
  const [activityImpact, setActivityImpact]   = useState(1.0);
  /**
   * Activities synthesized from activityPD.activity_contributions (active sessions only).
   * Populated on mount when the backend returns active exercise sessions that the user
   * has not yet entered manually in the form.
   * Used as a fallback when savedActivities is empty so "Activity Impact" reflects
   * pre-logged exercise.  When this fallback is in use, activitySensitivityMultiplier
   * is forced to 1.0 in the calculation to prevent double-counting (both the old
   * coefficient system and the PD sensitivity multiplier encode the same effect).
   */
  const [pdSynthesizedActivities, setPdSynthesizedActivities] = useState<any[]>([]);

  // Insulin
  const [insulinData, setInsulinData]       = useState<InsulinData | null>(null);
  const [savedInsulin, setSavedInsulin]     = useState<InsulinData | null>(null);
  const [isInsulinSaved, setIsInsulinSaved] = useState(false);

  // ── Calculation state ─────────────────────────────────────────────────────
  /**
   * Stores the result of the on-device calculation.
   * Shape is intentionally compatible with the old MealCalculationResult so
   * InsulinBreakdown and other consumers need no changes.
   */
  const [calculationResult, setCalculationResult] = useState<InsulinCalculationResult | null>(null);
  const [isCalculating, setIsCalculating]         = useState(false);

  // ── Active effects context (mirrors MealInput.js BloodSugarDataContext) ───
  const [activeEffects, setActiveEffects]                 = useState<ActiveEffectsFullResult | null>(null);
  /** Activity PD data from /api/activity/pharmacodynamics — fetched concurrently with activeEffects. */
  const [activityPD, setActivityPD]                       = useState<ActivityPDResult | null>(null);
  /**
   * Estimated BG from the backend active-effects-full endpoint.
   * source:
   *   'reading'         – actual meter reading ≤ 6 h ago (high confidence)
   *   'stale_reading'   – meter reading > 6 h ago (very_low confidence but still better than target)
   *   'target_fallback' – no reading today; BG computed from cumulative effects + target_glucose
   */
  const [estimatedBG, setEstimatedBG]                     = useState<{
    value: number;
    confidence: string;
    minutesSinceReading: number;
    source: 'reading' | 'stale_reading' | 'target_fallback';
  } | null>(null);
  const [activeEffectsWarning, setActiveEffectsWarning]   = useState<string>('');

  // ── UI state ──────────────────────────────────────────────────────────────
  const [notes, setNotes]                         = useState('');
  const [expandedSection, setExpandedSection]     = useState<string | null>('foods');
  const [showRecentMeals, setShowRecentMeals]     = useState(false);
  const [message, setMessage]                     = useState('');

  // Prevent duplicate simultaneous calculations
  const calculationInProgress = useRef(false);
  const lastCalculationSignature = useRef('');

  // Retry counter for loadActiveInsulin when no BG reading is available yet.
  // Resets to 0 on mount; increments up to BG_RETRY_MAX before giving up.
  const bgRetryCount = useRef(0);
  const BG_RETRY_MAX = 4;        // max attempts after the first fetch
  const BG_RETRY_BASE_MS = 2000; // first retry after 2 s; doubles each time

  // Controls the "Calculation Details" collapsible below the dose card
  const [showBreakdown, setShowBreakdown] = useState(false);
  // Controls expanded detail inside the insulin type suggestion strip
  const [showInsulinDetail, setShowInsulinDetail] = useState(false);
  // Active tab inside the breakdown panel
  const [breakdownTab, setBreakdownTab] = useState<'summary' | 'timing'>('summary');

  // Incremented whenever handleSaveInsulin programmatically snaps the meal time.
  // Changing this key forces UnifiedTimePicker to remount with the new value/mode
  // as its fresh initial state, guaranteeing the display reflects the snapped time
  // regardless of any stale internal state inside the picker.
  const [pickerKey, setPickerKey] = useState(0);

  // ── Init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    bgRetryCount.current = 0;
    loadActiveInsulin();
    fetchRecentMeals();
  }, []);

  // ── Re-calculate immediately when the live AED snapshot arrives / updates ──
  // liveActiveEffects is passed from the parent's ActiveEffectsDisplay tick.
  // When it transitions from undefined → a real snapshot, it already contains
  // a reading-anchored estimatedBG, so we force a recalculation right away
  // instead of waiting for the next estimatedBG/activeEffects state update.
  useEffect(() => {
    if (!liveActiveEffects) return;
    if (selectedFoods.length === 0) return;
    lastCalculationSignature.current = ''; // force re-run even if foods haven't changed
    performLocalCalculation();
  }, [liveActiveEffects]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─────────────────────────────────────────────────────────────────────────
  // CALCULATION — now runs fully on-device
  // ─────────────────────────────────────────────────────────────────────────

  const loadActiveInsulin = async () => {
    try {
      // Fetch active effects AND activity PD concurrently.
      // fetchStackedActivityEffectSafe() never throws — returns null on any error
      // so a PD failure never breaks the BG / IOB pipeline.
      const [effects, activityPDResult] = await Promise.all([
        getActiveEffectsFull(
          undefined,
          undefined,
          -new Date().getTimezoneOffset(),
        ),
        fetchStackedActivityEffectSafe(),
      ]);

      setActiveEffects(effects);
      if (activityPDResult) {
        setActivityPD(activityPDResult);
        console.log('[MealForm] 🏃 Activity PD loaded:', {
          sensitivityMultiplier: activityPDResult.sensitivity_multiplier,
          cumulativeActivityEffect: activityPDResult.cumulative_activity_effect,
          activityOnBoard: activityPDResult.activity_on_board,
          activeSessions: activityPDResult.active_sessions,
        });

        // ── Synthesize form-compatible activities from active PD sessions ────────
        // Only aerobic (bg_direction === -1) sessions map cleanly to the level-based
        // coefficient system. Anaerobic/stress sessions (bg_direction === +1) are
        // handled by the signed cumulativeActivityEffect applied to the correction BG.
        //
        // Intensity → level mapping (inverse of LEVEL_TO_INTENSITY in UnifiedActivityInput):
        //   light    → -1  (coefficient < 1.0 → small insulin reduction)
        //   moderate →  1  (coefficient < 1.0 → moderate reduction)
        //   vigorous →  2  (coefficient < 1.0 → large reduction)
        const INTENSITY_TO_LEVEL: Record<string, number> = {
          light: -1, moderate: 1, vigorous: 2,
        };
        const activeContributions = activityPDResult.activity_contributions.filter(
          c => c.is_active && c.bg_direction === -1,
        );
        if (activeContributions.length > 0) {
          const synthesized = activeContributions.map(c => {
            const startMs  = new Date(c.start_time).getTime();
            const endMs    = startMs + c.duration_minutes * 60_000;
            const endTime  = new Date(endMs).toISOString();
            const hh = String(Math.floor(c.duration_minutes / 60)).padStart(2, '0');
            const mm = String(c.duration_minutes % 60).padStart(2, '0');
            return {
              level:      INTENSITY_TO_LEVEL[c.intensity] ?? 1,
              intensity:  c.intensity,
              duration:   `${hh}:${mm}`,
              duration_minutes: c.duration_minutes,
              startTime:  c.start_time,
              endTime,
              impact:     1.0,          // will be recomputed by calculateActivityImpact
              isExpected: false,
              _fromPD:    true,         // sentinel — never submit these to the backend
            };
          });
          setPdSynthesizedActivities(synthesized);
          console.log('[MealForm] 🏃 Synthesized', synthesized.length, 'PD activities for Activity Impact row');
        } else {
          setPdSynthesizedActivities([]);
        }
      }

      // Update store with IOB
      const iob = effects?.totalIOB ?? effects?.iob?.totalIOB ?? effects?.iob?.total_active_insulin ?? 0;
      useMealStore.getState().updateActiveInsulin(iob);

      // Parse estimated BG from active effects.
      //
      // FIX (preset-mode BG mismatch):
      //   The previous code always used circadian(now) + pkNet in preset mode,
      //   completely ignoring any actual blood glucose reading. This caused a
      //   safety-critical discrepancy: ActiveEffectsDisplay applied a
      //   reading-residual correction and showed ~50 mg/dL, while the insulin
      //   calculation used the raw circadian baseline (~100 mg/dL), producing
      //   a correction dose that was ~1.2 u too high.
      //
      //   "preset" mode means the circadian profile is used as the stable
      //   pharmacodynamic baseline for chart/effect calculations — it does NOT
      //   mean the correction dose should ignore an actual meter reading.
      //
      //   Priority (both modes):
      //     1. Recent reading available (bgEst.current_estimated_bg != null)
      //        → use the backend's reading-anchored estimate. This matches what
      //          ActiveEffectsDisplay computes after its reading-residual step.
      //          confidence = 'estimated' so bgSourceAlreadyHasActivity = true
      //          in performLocalCalculation, preventing double-application of
      //          the activity effect (the backend value already includes it).
      //     2. No reading at all
      //        → fall back to circadian + PK delta (original behaviour).
      //          confidence = 'circadian' so activity effect IS applied (it is
      //          not baked into this locally-computed estimate).
      const bgEst = effects?.bg_estimates;
      const resolvedMode = (constants as any)?.baseline_mode ?? 'dynamic';
      const tzOffset = (constants as any)?.timezone_offset_minutes ?? 0;

      // ── BG estimate for correction dose ──────────────────────────────────────
      //
      // FIX (reading-anchored BG): The previous code passed bgEst.current_estimated_bg
      // directly from the backend to the correction calculation. That value is computed
      // via the "extracted stable baseline" approach:
      //
      //   stable_baseline = reading − (cumMeal − cumInsulin_magnitude + activityAtReading)
      //   current_estimated_bg = stable_baseline + cumNet_now + activity_now
      //
      // This breaks when cumInsulin_magnitude is large at reading time, causing
      // stable_baseline to exceed the 220 mg/dL hard-clamp. With a clamped baseline
      // combined with large negative cumNet_now, the result can be ~90 mg/dL even
      // when the actual reading is 278 mg/dL — a safety-critical 188 mg/dL error.
      //
      // The correct approach is the reading-anchored "bank balance" formula used by
      // ActiveEffectsDisplay, which never requires extracting or clamping a baseline:
      //
      //   estimatedBG = reading + (totalNetNow − totalNetAtReading)
      //
      // where:
      //   totalNetNow      = cumulative_net_baseline (meal+insulin, Convention A)
      //                    + cumulative_activity_effect
      //   totalNetAtReading = cumulative_net_effect_at_reading
      //                    (meal+insulin+activity at reading moment, Convention B
      //                     — numerically identical to Convention A, different internal sign)
      //
      // All three fields are already present in the backend's bg_estimates response.
      // This formula is used whenever a real reading is available (reading_value != null).
      // The target_fallback path (no reading) is unaffected since it is pure arithmetic
      // (target + cumNet + activity) with no baseline extraction or clamping risk.
      //
      // Activity confidence: 'estimated' is correct in both modes — the formula above
      // includes cumulativeActivityEffect so bgSourceAlreadyHasActivity = true in
      // performLocalCalculation, preventing double-application of the activity delta.

      /**
       * Compute the reading-anchored BG estimate from bg_estimates fields.
       * Mirrors ActiveEffectsDisplay's bank-balance formula.
       * Returns null if reading_value is not available.
       */
      const computeReadingAnchoredBG = (): number | null => {
        if (bgEst?.reading_value == null) return null;

        // Total pharmacodynamic net effect NOW (meal + insulin + activity)
        const totalNetNow =
          (bgEst.cumulative_net_baseline       ?? 0) +
          (bgEst.cumulative_activity_effect     ?? 0);

        // Total net effect AT THE TIME of the reading.
        // bg_estimates.cumulative_net_effect_at_reading comes from
        // baseline_data['cumulative_net_effect'] which already incorporates
        // activity_effect_at_reading (see pharmacodynamics.py line 1087).
        const totalNetAtReading = bgEst.cumulative_net_effect_at_reading ?? 0;

        const anchored = bgEst.reading_value + (totalNetNow - totalNetAtReading);

        console.log(
          '[MealForm] 🩸 Reading-anchored BG:',
          bgEst.reading_value.toFixed(1),
          '+ (', totalNetNow.toFixed(1), '-', totalNetAtReading.toFixed(1), ')',
          '=', anchored.toFixed(1),
          '| backend current_estimated_bg was:', bgEst.current_estimated_bg?.toFixed(1),
        );

        return Math.max(40, anchored);
      };

      if (resolvedMode === 'preset') {
        const readingAnchored = computeReadingAnchoredBG();

        if (readingAnchored != null) {
          // A reading exists: use the reading-anchored estimate (bank-balance formula).
          // This matches what ActiveEffectsDisplay computes and avoids the clamping
          // artefact in the backend's extracted stable_baseline path.
          const minSince = bgEst!.minutes_since_reading ?? 9999;
          setEstimatedBG({
            value:               readingAnchored,
            // 'estimated' → bgSourceAlreadyHasActivity = true in performLocalCalculation,
            // preventing double-application of cumulativeActivityEffect.
            confidence:          'estimated',
            minutesSinceReading: minSince,
            source:              minSince <= 360 ? 'reading' : 'stale_reading',
          });
        } else {
          // No reading available: fall back to circadian profile + absorbed
          // PK delta (meals + insulin since the daily reset).
          // confidence = 'circadian' so performLocalCalculation knows activity
          // effect is NOT yet included and applies cumulativeActivityEffect.
          const localHour = ((new Date().getTime() + tzOffset * 60_000) / 3_600_000) % 24;
          const circadianValue = getCircadianBaseline(
            localHour,
            (constants as any)?.circadian_profile ?? undefined,
          );
          const cumulativeMealEffect    = effects?.cumulative?.cumulative_meal_effect    ?? 0;
          const cumulativeInsulinEffect = effects?.cumulative?.cumulative_insulin_effect ?? 0;
          const pkNet = cumulativeMealEffect + cumulativeInsulinEffect;

          setEstimatedBG({
            value:               Math.max(40, circadianValue + pkNet),
            confidence:          'circadian',
            minutesSinceReading: 0,
            source:              'target_fallback',
          });
        }
      } else {
        // Dynamic mode: prefer reading-anchored estimate; fall back to null
        // (target_fallback path in performLocalCalculation).
        const readingAnchored = computeReadingAnchoredBG();

        if (readingAnchored != null) {
          const minSince = bgEst!.minutes_since_reading ?? 9999;
          setEstimatedBG({
            value:               readingAnchored,
            confidence:          'estimated',
            minutesSinceReading: minSince,
            source:              minSince <= 360 ? 'reading' : 'stale_reading',
          });
        } else {
          setEstimatedBG(null);
        }
      }
    } catch (err) {
      console.error('[MealForm] Failed to load active effects, falling back to IOB only:', err);
      // Fallback: just get IOB
      try {
        const result = await getActiveInsulin();
        useMealStore.getState().updateActiveInsulin(result.total_active_insulin || 0);
      } catch (e2) {
        console.error('[MealForm] Failed to load active insulin:', e2);
      }

      // On error, also schedule a retry so a transient network failure
      // doesn't permanently leave the form in "Using target glucose" mode.
      if (bgRetryCount.current < BG_RETRY_MAX) {
        const delay = BG_RETRY_BASE_MS * Math.pow(2, bgRetryCount.current);
        bgRetryCount.current += 1;
        console.log(`[MealForm] 🔄 BG fetch error — retry ${bgRetryCount.current}/${BG_RETRY_MAX} in ${delay}ms`);
        setTimeout(() => loadActiveInsulin(), delay);
      }
    }
  };

  // ── BG retry: re-fetch if the first response had no reading ───────────────
  // When loadActiveInsulin() completes but reading_value is null, estimatedBG
  // is null (dynamic mode) or circadian_preset (preset mode with no reading).
  // We schedule another fetch with exponential back-off until real data arrives
  // OR liveActiveEffects (from the parent AED tick) supersedes the need entirely.
  // The retry stops as soon as:
  //   a) estimatedBG is non-null with source !== 'target_fallback', OR
  //   b) liveActiveEffects is present (AED already has a reading-anchored BG), OR
  //   c) bgRetryCount has reached BG_RETRY_MAX.
  useEffect(() => {
    // Already have good data from the live AED snapshot — no retry needed.
    if (liveActiveEffects?.baseline?.readingTimestamp) return;

    // Already have a real reading-anchored estimate from the API — no retry needed.
    if (estimatedBG && estimatedBG.source !== 'target_fallback') return;

    // No food selected yet; retrying now is wasteful — wait until foods are added.
    // The retry will re-fire automatically once estimatedBG changes on the next
    // successful loadActiveInsulin() call.
    if (bgRetryCount.current >= BG_RETRY_MAX) return;

    const delay = BG_RETRY_BASE_MS * Math.pow(2, bgRetryCount.current);
    bgRetryCount.current += 1;
    console.log(`[MealForm] 🔄 No BG reading yet — scheduling retry ${bgRetryCount.current}/${BG_RETRY_MAX} in ${delay}ms`);
    const timer = setTimeout(() => loadActiveInsulin(), delay);
    return () => clearTimeout(timer);
  }, [estimatedBG, liveActiveEffects]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Run the full insulin calculation locally.
   *
   * This mirrors calculateInsulinNeeds() / calculateInsulinDose() from
   * EnhancedPatientConstantsCalc.js — no network round-trip required.
   *
   * Inputs pulled from state (same as the JS web app):
   *   - selectedFoods       → nutrition macros + absorption type
   *   - savedActivities     → activity level + duration
   *   - savedBloodSugar     → blood glucose for correction dose
   *   - activeInsulin       → IOB fetched on mount (from meal store)
   *   - constants           → patient-specific ICR, CF, target, factors
   */
  const performLocalCalculation = useCallback(() => {
    if (selectedFoods.length === 0 || calculationInProgress.current) return;

    // ── Guard: wait for real patient constants before any calculation ─────────
    // Mirrors the ActiveEffectsDisplay gate on hasLoadedFromAPI.
    // Without this, calculations that fire before loadConstants() resolves use
    // DEFAULT_PATIENT_CONSTANTS (CF=40, ICR=10) instead of the patient's real
    // values, producing an incorrect first dose suggestion.
    // The useCallback dep on `hasLoadedFromAPI` ensures this re-fires once real
    // constants arrive, so the patient always sees the correct number.
    if (constantsLoading || !hasLoadedFromAPI) {
      setMessage('Loading your personal settings — please wait a moment');
      return;
    }

    if (!constants) {
      setMessage('Patient constants not loaded yet — please wait');
      return;
    }

    calculationInProgress.current = true;
    setIsCalculating(true);

    try {
      console.log('[MealForm] Running on-device insulin calculation…');

      // ── carbBgFactor hoisted: needed by resolveLiveEffects before BG selection ─
      // (also reused by absorbedCarbs further below — no duplicate declaration there)
      const carbBgFactor = (constants as any).carb_to_bg_factor ?? 4;

      // ── Resolve active effects (live AED > stale API snapshot) ───────────────
      // Priority: liveActiveEffects (AED tick) > stale getActiveEffectsFull() cache.
      // pendingMealRise falls back to activeMealCarbs × carbBgFactor in Path B because
      // getActiveEffectsFull() never serialises that field (frontend-only PK value).
      const r = resolveLiveEffects(liveActiveEffects, activeEffects, activityPD, carbBgFactor);

      // ── Smart BG selection — mirrors MealInput.js calculateInsulinNeeds exactly ─
      //
      //  Priority order (same as JS, plus Case 0 for live AED):
      //   0. Live AED snapshot (liveActiveEffects prop) → same number patient sees on screen
      //   1. User entered actual reading → highest confidence
      //   2. Estimated BG from backend (≤ 6 h old) → good confidence
      //   3. Estimated BG from backend (> 6 h, stale) → very_low confidence but
      //      still far better than raw target_glucose (matches JS stale_reading path)
      //   4. No reading at all → derive from cumulative effects + target_glucose
      //      (mirrors JS target_fallback: target + cumulativeMeal + cumulativeInsulin)
      //   5. Absolute fallback → raw target_glucose (should be rare)
      const userEnteredBG = savedBloodSugar?.value ? parseFloat(savedBloodSugar.value) : 0;
      let smartBG = userEnteredBG;
      let bgSource = 'unknown';
      let bgConfidence = 'unknown';
      let minSinceReading = 0;
      let warningMsg = '';
      let usedNetEffectEstimate = false;

// FIX (preset-mode BG mismatch): In preset mode, ALWAYS use netEffectEstimatedBG
      // (the value shown by ActiveEffectsDisplay) regardless of whether estimatedBG from
      // loadActiveInsulin() also has a value.
      //
      // The backend bank-balance formula (computeReadingAnchoredBG) computes:
      //   reading + (cumNetNow + activityNow) − cumNetAtReading
      //
      // The useActiveEffects preset formula (reading-residual) computes:
      //   reading + (circadian@now − circadian@readingTime)   ← absent from bank-balance
      //          + (pkCumNow − pkCumAtReading) + (activityNow − activityAtReading)
      //
      // When the reading was taken hours earlier the circadian drift term can exceed
      // 10 mg/dL, producing a correction-dose error of ~0.25 u. Removing the third
      // condition makes preset mode always use the same BG the patient sees on screen.
      const shouldUseNetEffectEstimate =
        netEffectBaselineMode === 'preset' &&
        netEffectEstimatedBG != null;

      // Case 0: Live AED estimate — same bank-balance BG the patient sees on screen.
      // Only fires when liveActiveEffects is provided AND the user hasn't entered their
      // own reading (a real reading always takes priority over any estimate).
      if (!userEnteredBG && r.isLive) {
        smartBG               = r.estimatedBG!;
        bgSource              = 'estimated';
        bgConfidence          = r.minutesSinceReading > 360 ? 'very_low' : 'estimated';
        minSinceReading       = r.minutesSinceReading;
        usedNetEffectEstimate = true;
        if (!r.readingTimestamp) {
          bgConfidence = 'circadian_preset';
          warningMsg   = "No reading in today's period — using live net-effect BG estimate";
        } else if (r.minutesSinceReading > 360) {
          warningMsg = 'Last reading is over 6 hours old — using best available BG estimate';
        }
      } else if (userEnteredBG > 0) {
        // Case 1: Patient just entered a real reading — most reliable
        bgSource = 'actual';
        bgConfidence = 'very_high';

      } else if (shouldUseNetEffectEstimate) {
        // Preset mode (with or without a reading) — use the live net-effect estimate
        // from useActiveEffects. This is identical to what ActiveEffectsDisplay shows
        // and includes the circadian drift since the last reading that the backend
        // bank-balance formula omits.
        smartBG               = netEffectEstimatedBG!;
        bgSource              = 'estimated';
        usedNetEffectEstimate = true;

        // Carry reading metadata from estimatedBG when a real reading is available
        // so the breakdown card shows "Estimated · N min ago" instead of "Circadian est."
        if (estimatedBG !== null && estimatedBG.confidence !== 'circadian') {
          bgConfidence    = estimatedBG.minutesSinceReading <= 360 ? 'estimated' : 'very_low';
          minSinceReading = estimatedBG.minutesSinceReading;
          if (estimatedBG.source === 'stale_reading') {
            warningMsg = 'Last reading is over 6 hours old — using best available BG estimate';
          }
        } else {
          bgConfidence    = 'circadian_preset';
          minSinceReading = 0;
          warningMsg      = "No reading in today's period — using live net-effect BG estimate";
        }

      } else if (estimatedBG !== null) {
        // Cases 2 & 3: Backend provided a BG estimate (from a real reading, possibly stale)
        // JS always uses this, even if stale, because a stale estimate that includes
        // absorbed meal + insulin effects is more accurate than raw target_glucose.
        smartBG            = estimatedBG.value;
        bgSource           = 'estimated';
        bgConfidence       = estimatedBG.confidence === 'circadian'
          ? 'circadian_preset'
          : estimatedBG.minutesSinceReading <= 360
            ? (estimatedBG.confidence || 'medium')
            : 'very_low';
        minSinceReading    = estimatedBG.minutesSinceReading;

        if (estimatedBG.source === 'stale_reading') {
          warningMsg = 'Last reading is over 6 hours old — using best available BG estimate';
        }

      } else {
        // Cases 4 & 5: No reading available at all.
        // Mirrors JS target_fallback path:
        //   currentEstimatedBG = target_glucose + cumulativeMealEffect + cumulativeInsulinEffect
        //   (cumulativeInsulinEffect is negative, so net = target + meals - |insulin|)
        const targetGlucose    = (constants as any).target_glucose ?? 100;
        const cumMealEffect    = activeEffects?.cumulative?.cumulative_meal_effect
          ?? (activeEffects as any)?.cumulative_meal_effect ?? 0;
        const cumInsulinEffect = activeEffects?.cumulative?.cumulative_insulin_effect
          ?? (activeEffects as any)?.cumulative_insulin_effect ?? 0;

        const computedFallbackBG = targetGlucose + cumMealEffect + cumInsulinEffect;

        if (cumMealEffect !== 0 || cumInsulinEffect !== 0) {
          // Case 4: We have cumulative data — use it for a meaningful estimate
          smartBG        = Math.max(40, computedFallbackBG);
          bgSource       = 'estimated';
          bgConfidence   = 'very_low';
          warningMsg     = "No reading in today's period — BG estimated from cumulative meal/insulin effects";
        } else {
          // Case 5: Absolute last resort — no reading, no cumulative data
          smartBG        = targetGlucose;
          bgSource       = 'target_fallback';
          bgConfidence   = 'very_low';
          warningMsg     = 'Using target glucose — no blood sugar data available';
        }
      }

      // ── Extract active effects (IOB / MOB / cumulative) ───────────────────
      // IOB: prefer live AED snapshot; fall back to store value so pre-AED-tick
      //      renders still show a meaningful active insulin figure.
      const activeInsulinValue = r.activeInsulinUnits || activeInsulin;
      // MOB / pending: from resolveLiveEffects (live > stale API, with C2B fallback).
      // pendingMealRise previously read activeEffects?.mob?.pending_bg_rise — a field
      // getActiveEffectsFull() never emits — producing a permanent 0 mg/dL pending rise.
      const activeMealCarbs         = r.activeMealCarbs;
      const pendingMealRise         = r.pendingMealRise;
      const pendingInsulinReduction = r.pendingInsulinReduction;

      const cumulativeMealEffect    = activeEffects?.cumulative?.cumulative_meal_effect
        ?? (activeEffects as any)?.cumulative_meal_effect ?? 0;
      const cumulativeInsulinEffect = activeEffects?.cumulative?.cumulative_insulin_effect
        ?? (activeEffects as any)?.cumulative_insulin_effect ?? 0;
      const cumulativeNetBaseline   = activeEffects?.cumulative?.cumulative_net_baseline
        ?? (activeEffects as any)?.cumulative_net_baseline ?? 0;

      // Use patient-specific constants for unit conversions
      const corrFactor = (constants as any).correction_factor ?? 40; // I-3: canonical default is 40 (see constants.py::ConstantConfig)
      // carbBgFactor already declared above — used by resolveLiveEffects + absorbedCarbs

      const bgEst = activeEffects?.bg_estimates;
      const absorbedCarbs    = bgEst
        ? (bgEst.cumulative_meal_effect_at_reading   / carbBgFactor)
        : 0;
      const absorbedInsulin  = bgEst
        ? (Math.abs(bgEst.cumulative_insulin_effect_at_reading) / corrFactor)
        : 0;

      console.log('[MealForm] Smart BG:', { smartBG, bgSource, bgConfidence, minSinceReading });
      console.log('[MealForm] Active effects:', { activeInsulinValue, activeMealCarbs, cumulativeNetBaseline, corrFactor, carbBgFactor, isLive: r.isLive });

      // ── Activity PD values ────────────────────────────────────────────────
      // sensitivity_multiplier ≥ 1.0: reduces base dose and correction dose.
      // cumulativeActivityEffect (signed): applied to non-actual BG estimates so
      //   the correction step sees a more accurate current BG (mirrors useActiveEffects).
      // activityOnBoard (unsigned mg/dL): pending BG drop treated like IOB.
      const sensitivityMultiplier    = activityPD?.sensitivity_multiplier     ?? 1.0;
      const cumulativeActivityEffect = activityPD?.cumulative_activity_effect ?? 0;
      // pdAOB: AOB from sessions already persisted in the backend (pre-logged exercise).
      const pdAOB                    = activityPD?.activity_on_board          ?? 0;

      // ── UNIFIED ACTIVITY PATHWAY ──────────────────────────────────────────────
      //
      // Both manual-form activities and pre-logged PD sessions now go through the
      // SAME sensitivityMultiplier pathway (÷ base dose, × effectiveCF).
      //
      // The legacy coefficient pathway (activityImpact = 0.9 for vigorous 1h) is
      // bypassed entirely — activities=[] is always passed to calculateInsulinNeeds
      // so activityImpact stays 1.0.
      //
      // When savedActivities are present (user entered activity in the form):
      //   • computeSyntheticSensitivityMultiplier() runs the same Dalla Man / Breton
      //     W-state ODE the backend uses for pre-logged sessions.
      //   • The result is combined with any backend PD multiplier by taking the max
      //     (both represent insulin sensitivity boosts; the stronger one dominates
      //     since the sessions may overlap in time).
      //   • computeSyntheticAOB() ports Python's _integrate_z_drop() / get_activity_on_board()
      //     to compute how much acute BG drop is still outstanding from those sessions.
      //     Result is ADDED to pdAOB — manual sessions are independent of pre-logged ones.
      //
      // When no manual activities exist but PD sessions are active (usingPDActivities):
      //   • activities=[] already avoids coefficient double-count (Bug 2 fix preserved).
      //   • effectiveSensitivityMult = real backend sensitivityMultiplier.
      //   • aobValue = pdAOB from activityPD (already correct).
      const usingPDActivities   = savedActivities.length === 0 && pdSynthesizedActivities.length > 0;
      const effectiveActivities: any[] = []; // always bypass coefficient system

      let effectiveSensitivityMult = sensitivityMultiplier;
      let aobValue                 = pdAOB;

      if (savedActivities.length > 0) {
        // ── Sensitivity multiplier (W-state ODE) ─────────────────────────────
        // Compute synthetic W-state multiplier from the manually-entered activities.
        // This mirrors the backend ODE integration exactly — same tau_W, alpha, etc.
        const syntheticMult = computeSyntheticSensitivityMultiplier(savedActivities, constants);
        // Take the max: if the user also has a backend PD session running, the stronger
        // sensitivity effect wins (sessions overlap; summing would double-count).
        effectiveSensitivityMult = Math.max(syntheticMult, sensitivityMultiplier);

        // ── Activity On Board (Z-state ODE) ──────────────────────────────────
        // Manual form activities have NOT been submitted to the backend yet, so they
        // are absent from activityPD. We compute their remaining acute BG drop using
        // the same Z-state ODE the backend runs in get_activity_on_board().
        // Sessions are independent → ADD to pdAOB (same as backend's total_aob loop).
        const syntheticAOB = computeSyntheticAOB(savedActivities, constants);
        aobValue = pdAOB + syntheticAOB;

        console.log('[MealForm] 🏃 Manual activity → synthetic PD values:', {
          syntheticMult:            syntheticMult.toFixed(3),
          pdMult:                   sensitivityMultiplier.toFixed(3),
          effectiveSensitivityMult: effectiveSensitivityMult.toFixed(3),
          doseReductionPct:         (((effectiveSensitivityMult - 1) / effectiveSensitivityMult) * 100).toFixed(1) + '%',
          syntheticAOB:             syntheticAOB.toFixed(1) + ' mg/dL',
          pdAOB:                    pdAOB.toFixed(1) + ' mg/dL',
          aobValue:                 aobValue.toFixed(1) + ' mg/dL',
        });
      }

      // ── FIX (Bug 3): Avoid double-applying cumulativeActivityEffect ──────────
      //
      // When bgSource === 'estimated' and estimatedBG was loaded from the backend's
      // current_estimated_bg (dynamic mode), the backend's net-effect pipeline
      // already includes cumulativeActivityEffect in that value. Passing it again
      // to insulinCalculationService would shift bgForCorrection by −14.6 mg/dL
      // instead of the correct −7.3 mg/dL, artificially lowering the correction dose.
      //
      // It is safe to apply cumulativeActivityEffect only when the BG estimate was
      // built without it:
      //   • bgSource === 'actual'          → real meter reading; exercise already visible. Skip.
      //   • bgSource === 'estimated' from backend (estimatedBG.confidence !== 'circadian')
      //                                   → backend net-effect includes activity. Skip.
      //   • bgSource === 'estimated' from circadian preset (confidence === 'circadian')
      //                                   → pkNet = meals+insulin only; activity not included. Apply.
      //   • bgSource === 'estimated' with no backend data (estimatedBG === null)
      //                                   → computed as target+meals+insulin locally. Apply.
      //   • bgSource === 'target_fallback' → raw target; no activity included. Apply.
      const bgSourceAlreadyHasActivity =
        r.isLive ||          // AED's estimatedBG always includes activityDeltaSinceReading
        bgSource === 'actual' ||
        usedNetEffectEstimate ||
        (bgSource === 'estimated' &&
         estimatedBG !== null &&
         estimatedBG.confidence !== 'circadian');
      const effectiveCumulativeActivityEffect = bgSourceAlreadyHasActivity ? 0 : cumulativeActivityEffect;

      if (sensitivityMultiplier > 1.005 || aobValue > 0) {
        console.log('[MealForm] 🏃 Applying activity PD to dose:', {
          sensitivityMultiplier,
          effectiveSensitivityMult,
          usingPDActivities,
          activitiesPassedToCalc: effectiveActivities.length,
          cumulativeActivityEffect,
          effectiveCumulativeActivityEffect,
          bgSourceAlreadyHasActivity,
          aobValue,
          bgSource,
          estimatedBGConfidence: estimatedBG?.confidence ?? null,
        });
      }

      const result = calculateInsulinNeeds(
        selectedFoods,
        smartBG,
        effectiveActivities,
        constants,
        mealType,
        new Date(),
        activeInsulinValue,
        activeMealCarbs,
        {
          bloodSugarSource:      bgSource,
          bloodSugarConfidence:  bgConfidence,
          minutesSinceReading:   minSinceReading,
          cumulativeMealEffect,
          cumulativeInsulinEffect,
          cumulativeNetBaseline,
          absorbedCarbs,
          absorbedInsulin,
          pendingMealRise,
          pendingInsulinReduction,
          // ── Activity PD ───────────────────────────────────────────────────
          // sensitivityMultiplier: always real value so CF is correctly widened
          //   for correction dose (see FIX Bug 2 above).
          // cumulativeActivityEffect: only non-zero when not already baked into
          //   the BG estimate (see FIX Bug 3 above).
          activitySensitivityMultiplier: effectiveSensitivityMult,
          activityOnBoard:               aobValue,
          cumulativeActivityEffect:      effectiveCumulativeActivityEffect,
        },
      );

      if (result) {
        console.log('[MealForm] ✅ Calculation complete. Suggested:', result.total, 'u');
        setCalculationResult(result);
        setMessage('');
        if (warningMsg) setActiveEffectsWarning(warningMsg);
        else setActiveEffectsWarning('');
      }
    } catch (err: any) {
      console.error('[MealForm] Calculation error:', err);
      setMessage('Failed to calculate insulin dosage');
    } finally {
      setIsCalculating(false);
      calculationInProgress.current = false;
    }
  }, [selectedFoods, savedActivities, pdSynthesizedActivities, savedBloodSugar, estimatedBG, netEffectEstimatedBG, netEffectBaselineMode, activeEffects, activityPD, activeInsulin, constants, constantsLoading, hasLoadedFromAPI, mealType, liveActiveEffects]);

  // ── Auto-recalculate when saved inputs change ─────────────────────────────
  useEffect(() => {
    if (selectedFoods.length === 0) {
      setCalculationResult(null);
      return;
    }

    const signature = JSON.stringify({
      foods:      selectedFoods.map(f => ({ id: f.id, portion: f.portion })),
      activities: savedActivities.map(a => ({ level: a.level, duration: a.duration })),
      bloodSugar: savedBloodSugar?.value,
    });

    if (signature !== lastCalculationSignature.current && !calculationInProgress.current) {
      lastCalculationSignature.current = signature;
      performLocalCalculation();
    }
  }, [performLocalCalculation, selectedFoods, savedActivities, savedBloodSugar?.value]);

  // Re-run when active effects, activity PD, or estimated BG arrive async from the backend
  useEffect(() => {
    if (selectedFoods.length > 0 && !calculationInProgress.current) {
      lastCalculationSignature.current = '';
      performLocalCalculation();
    }
  }, [estimatedBG, netEffectEstimatedBG, netEffectBaselineMode, activeEffects, activityPD, performLocalCalculation]);

  // ─────────────────────────────────────────────────────────────────────────
  // EVENT HANDLERS
  // ─────────────────────────────────────────────────────────────────────────

  const handleFoodSelect = (food: any) => {
    // Functional updater prevents the stale-closure bug where rapid successive
    // calls (e.g. forEach loop) all read the same snapshot of tempSelectedFoods
    // and only the last item survives.
    setTempSelectedFoods(prev => [...prev, food]);
    setShowFoodModal(false);
  };

  // Called by FoodSearch when multiple scanned items are confirmed at once.
  // A single atomic state update avoids the stale-closure issue entirely.
  const handleFoodSelectMultiple = (foods: any[]) => {
    setTempSelectedFoods(prev => [...prev, ...foods]);
    setShowFoodModal(false);
  };

  const handleFoodRemove = (index: number) => {
    setTempSelectedFoods(tempSelectedFoods.filter((_, i) => i !== index));
  };

  const handleFoodPortionUpdate = (index: number, newPortion: any) => {
    setTempSelectedFoods(
      tempSelectedFoods.map((food, i) => (i === index ? { ...food, portion: newPortion } : food)),
    );
  };

  const handleActivityUpdate = (newActivities: any[], totalImpact: number) => {
    setActivities(newActivities);
    setActivityImpact(totalImpact);
  };

  const handleBloodSugarChange = (data: BloodSugarData) => {
    setBloodSugarData(data);
  };

  const handleInsulinChange = (data: InsulinData) => {
    setInsulinData(data);
  };

  const handleMealTimeChange  = (utcIsoString: string) => setMealTimeUTC(utcIsoString);
  const handleMealTimeModeChange = (m: TimeMode) => setMealTimeMode(m);

  // Save handlers
  const handleSaveFoods = () => {
    if (tempSelectedFoods.length > 0) {
      setSelectedFoods(tempSelectedFoods);
      setIsFoodsSaved(true);
      setExpandedSection(null);
      console.log('[MealForm] ✅ Foods saved:', tempSelectedFoods.length);
    }
  };

  const handleSaveBloodSugar = () => {
    if (bloodSugarData?.value && parseFloat(bloodSugarData.value) > 0) {
      setSavedBloodSugar(bloodSugarData);
      setIsBloodSugarSaved(true);
      setExpandedSection(null);
      console.log('[MealForm] ✅ Blood sugar saved:', bloodSugarData.value);
    }
  };

  const handleSaveActivities = () => {
    setSavedActivities(activities);
    setIsActivitiesSaved(activities.length > 0);
    setExpandedSection(null);
    console.log('[MealForm] ✅ Activities saved:', activities.length);
  };

  const handleSaveInsulin = () => {
    if (insulinData?.medication && insulinData?.dose > 0) {
      setSavedInsulin(insulinData);
      setIsInsulinSaved(true);
      setExpandedSection(null);
      console.log('[MealForm] ✅ Insulin saved:', insulinData.dose, 'u');

      // Snap meal time forward to insulin time + timing offset.
      // Uses foods already saved (selectedFoods), falls back to tempSelectedFoods.
      const foods = selectedFoods.length > 0 ? selectedFoods : tempSelectedFoods;
      const offsetMinutes = getTimingMinutes(foods, constants);
      // When the insulin picker is in "Now" mode its timestamp is frozen at the
      // moment the picker first emitted onChange — the 60-second ticker updates
      // the display but intentionally does NOT re-fire onChange (by design, to
      // prevent spam). Use the live clock as the snap base so we never calculate
      // the meal offset from a stale value if the user took time filling the form.
      const insulinTime = insulinData.timestampMode === 'now'
        ? new Date()
        : new Date(insulinData.timestamp);
      const snappedMealTime = new Date(insulinTime.getTime() + offsetMinutes * 60 * 1000);
      console.log(
        `[MealForm] Snapping meal time: insulin @ ${insulinData.timestamp} + ${offsetMinutes}min → ${snappedMealTime.toISOString()}`,
      );
      setMealTimeUTC(snappedMealTime.toISOString());
      setMealTimeMode('custom');
      // Force UnifiedTimePicker to remount so its internal display state is
      // initialised from the new value/mode props rather than staying stale.
      setPickerKey(k => k + 1);
    }
  };

  const toggleSection = (section: string) =>
    setExpandedSection(expandedSection === section ? null : section);

  const toggleFoodsSection = () => {
    if (expandedSection === 'foods') {
      setExpandedSection(null);
    } else {
      setExpandedSection('foods');
      // Auto-open the food search modal when there are no foods yet
      if (tempSelectedFoods.length === 0) {
        setShowFoodModal(true);
      }
    }
  };

  const safeToFixed = (value: number | undefined, decimals = 1) =>
    value !== undefined && value !== null && !isNaN(value) ? value.toFixed(decimals) : '0';

  // ─────────────────────────────────────────────────────────────────────────
  // ACTIVITY RECORDING (unchanged — still calls backend)
  // ─────────────────────────────────────────────────────────────────────────

  const recordActivitiesSeparately = async (): Promise<string[]> => {
    // Filter out activities synthesized from PD data — they're already persisted
    // in the backend's activity log. Only submit activities the user manually
    // added in this form session.
    const manualActivities = savedActivities.filter(a => !a._fromPD);
    if (manualActivities.length === 0) return [];
    try {
      const activitiesData = {
        expectedActivities: manualActivities
          .filter(a => a.isExpected || a.type === 'expected')
          .map(a => {
            const dur = TimeManager.calculateDuration(a.startTime, a.endTime);
            return {
              level: a.level,
              duration: TimeManager.hoursToTimeString(dur.totalHours),
              expectedTime: a.startTime,
              startTime: a.startTime,
              endTime: a.endTime,
              impact: a.impact,
              notes: a.notes || '',
            };
          }),
        completedActivities: manualActivities
          .filter(a => !a.isExpected && a.type === 'completed')
          .map(a => {
            const dur = TimeManager.calculateDuration(a.startTime, a.endTime);
            return {
              level: a.level,
              duration: TimeManager.hoursToTimeString(dur.totalHours),
              completedTime: a.startTime,
              startTime: a.startTime,
              endTime: a.endTime,
              impact: a.impact,
              notes: a.notes || '',
            };
          }),
        notes: '',
      };

      const response = await apiClient.post(API.ACTIVITIES.CREATE, activitiesData); // I-25: was hardcoded '/api/record-activities'
      return response.data.activity_ids || [];
    } catch (err) {
      console.error('[MealForm] Failed to record activities:', err);
      return [];
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // RESET — clears all form state after a successful submission
  // ─────────────────────────────────────────────────────────────────────────

  const resetForm = () => {
    setMealType('breakfast');
    setMealTimeUTC(new Date().toISOString());
    setMealTimeMode('now');
    setSelectedFoods([]);
    setTempSelectedFoods([]);
    setIsFoodsSaved(false);
    setBloodSugarData(null);
    setSavedBloodSugar(null);
    setIsBloodSugarSaved(false);
    setActivities([]);
    setSavedActivities([]);
    setIsActivitiesSaved(false);
    setActivityImpact(1.0);
    setInsulinData(null);
    setSavedInsulin(null);
    setIsInsulinSaved(false);
    setCalculationResult(null);
    setNotes('');
    setExpandedSection('foods');
    setMessage('');
    setShowBreakdown(false);
    setActiveEffectsWarning('');
    lastCalculationSignature.current = '';
    setPickerKey(0);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // SUBMIT
  // ─────────────────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!mealType) {
      Platform.OS === 'web' ? alert('Please select a meal type') : Alert.alert('Error', 'Please select a meal type');
      return;
    }
    if (selectedFoods.length === 0) {
      Platform.OS === 'web'
        ? alert('Please add and save at least one food item')
        : Alert.alert('Error', 'Please add and save at least one food item');
      return;
    }

    try {
      setMessage('Submitting meal…');
      const activityIds = await recordActivitiesSeparately();

      // ─── Backend only accepts these absorption_type values ────────────────────
      const BACKEND_ABSORPTION_TYPES = new Set([
        'very_fast', 'fast', 'medium', 'slow', 'very_slow',
      ]);

      const formData: MealFormData = {
        mealType,
        mealTime: mealTimeUTC,
        selectedFoods: selectedFoods.map(food => {
          const isWeight = food.portion?.activeMeasurement === 'weight';
          // Guard: map 'mixed' and any other UI-only type → 'medium'
          const rawAbsorption = food.details?.absorption_type ?? 'medium';
          const safeAbsorption = BACKEND_ABSORPTION_TYPES.has(rawAbsorption)
            ? rawAbsorption
            : 'medium';
          // Resolve the unit that will actually be sent to the backend
          const sentUnit = isWeight
            ? (food.portion.w_unit ?? food.portion.unit ?? 'g')
            : (food.portion.unit ?? 'serving');
          // Derive measurement_type from the sent unit.
          // activeMeasurement is 'weight' for any food with a w_amount — including
          // liquids measured in ml. Blindly forwarding 'weight' while sending 'ml'
          // fails the backend's unit allow-list check (400 Bad Request).
          const WEIGHT_UNITS_BACKEND = new Set(['g', 'kg', 'oz', 'lb']);
          const VOLUME_UNITS_BACKEND = new Set(['ml', 'l', 'fl_oz', 'tsp', 'tbsp', 'cup']);
          const derivedMeasurementType = WEIGHT_UNITS_BACKEND.has(sentUnit) ? 'weight'
            : VOLUME_UNITS_BACKEND.has(sentUnit) ? 'volume'
            : food.portion.activeMeasurement || 'weight'; // standard portions

          return {
            name: food.name,
            portion: {
              // Use ?? (not ||) so a legitimate 0-value amount isn't silently replaced
              amount: isWeight
                ? (food.portion.w_amount ?? food.portion.amount ?? 1)
                : (food.portion.amount ?? 1),
              unit: sentUnit,
              measurement_type: derivedMeasurementType,
            },
            details: {
              carbs:           parseFloat(food.details?.carbs)   || 0,
              protein:         parseFloat(food.details?.protein) || 0,
              fat:             parseFloat(food.details?.fat)     || 0,
              absorption_type: safeAbsorption,           // ← never 'mixed' to backend
              serving_size:    food.details?.serving_size || { amount: 1, unit: 'serving' },
            },
          };
        }),
        activityIds:          activityIds.length > 0 ? activityIds : undefined,
        // I-12: Always send bloodSugar in mg/dL regardless of display unit.
        // bloodSugarUnit is kept for logging/debugging; backend (meal_insulin.py::submit_meal)
        // always treats bloodSugar as mg/dL and ignores the unit for storage.
        bloodSugar: savedBloodSugar?.value
          ? (savedBloodSugar.unit === 'mmol/L'
              ? Math.round(parseFloat(savedBloodSugar.value) * 18)
              : parseFloat(savedBloodSugar.value))
          : undefined,
        bloodSugarTimestamp:  savedBloodSugar?.timestamp,
        bloodSugarUnit:       savedBloodSugar?.unit, // logging only — backend always stores mg/dL
        intendedInsulin:      savedInsulin?.dose,
        intendedInsulinType:  savedInsulin?.medication,
        insulinTimestamp:     savedInsulin?.timestamp,
        notes,
        // Pass the local calculation breakdown to the backend for audit/logging
        calculationFactors: calculationResult ? {
          absorptionFactor:  calculationResult.breakdown?.absorptionFactor ?? 1,
          mealTimingFactor:  calculationResult.breakdown?.mealTimingFactor ?? 1,
          activityImpact:    calculationResult.breakdown?.activityImpact   ?? activityImpact,
          activeInsulin,
          healthMultiplier:  calculationResult.breakdown?.healthMultiplier ?? 1,
          suggestedInsulin:  calculationResult.total,    // ← backend needs this for meal_only_suggested_insulin
          absorption_type:   getDominantAbsorptionType(selectedFoods), // ← backend needs this for calculation_summary.absorption_type
        } : undefined,
      };

      console.log('[MealForm] Submitting with UTC timestamps:', {
        mealTime:            formData.mealTime,
        bloodSugarTimestamp: formData.bloodSugarTimestamp,
        insulinTimestamp:    formData.insulinTimestamp,
        activityIds:         formData.activityIds,
      });

      // ✅ Await the parent's async API call — this is the key fix.
      // Previously onSubmit was called without await, so success/error
      // handling in the parent ran fire-and-forget with no feedback here.
      await onSubmit(formData);

      // ✅ Success: reset the form to prevent double-submission,
      // then show feedback and navigate away.
      resetForm();
      if (Platform.OS === 'web') {
        alert('Meal logged successfully!');
        onCancel(); // triggers router.back() in the parent screen
      } else {
        Alert.alert('Success', 'Meal logged successfully!', [
          { text: 'OK', onPress: onCancel },
        ]);
      }
    } catch (err: any) {
      console.error('[MealForm] Submit error:', err);
      const errorMessage = err?.response?.data?.error || err?.message || 'Failed to submit meal';
      setMessage(''); // clear "Submitting…" text
      if (Platform.OS === 'web') {
        alert(`Error: ${errorMessage}`);
      } else {
        Alert.alert('Error', errorMessage);
      }
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // DERIVED VALUES
  // ─────────────────────────────────────────────────────────────────────────

  // Suggested dose — now sourced entirely from local calculation
  const suggestedInsulinValue = calculationResult?.total ?? 0;

  // ── Insulin type suggestion — sourced from shared-constants / patient constants ──
  const dominantAbsorption = getDominantAbsorptionType(selectedFoods);
  const isMixedMeal = detectMixedMeal(selectedFoods);
  const medicationFactors =
    (constants as any)?.medication_factors ??
    SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.medication_factors;
  const insulinSuggestionConfig =
    selectedFoods.length > 0 ? ABSORPTION_TO_INSULIN_CONFIG[dominantAbsorption] : null;
  const insulinBrandNames =
    insulinSuggestionConfig
      ? getInsulinBrandNames(dominantAbsorption, medicationFactors)
      : '';

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollContent} contentContainerStyle={styles.contentContainer}>

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Log Your Meal</Text>
          <TouchableOpacity style={styles.recentMealsButton} onPress={() => setShowRecentMeals(!showRecentMeals)}>
            <Text style={styles.recentMealsButtonText}>{showRecentMeals ? 'Hide' : 'Recent'} Meals</Text>
          </TouchableOpacity>
        </View>

        {/* Messages */}
        {!!message && (
          <View style={styles.messageContainer}>
            <Text style={styles.messageText}>{message}</Text>
          </View>
        )}

        {/* Recent Meals */}
        {showRecentMeals && (
          <View style={styles.recentMealsSection}>
            <Text style={styles.sectionTitle}>Recent Meals ({recentMeals.length})</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {recentMeals.map((meal: any, i: number) => (
                <View key={i} style={styles.recentMealCard}>
                  <Text style={styles.recentMealType}>
                    {meal.mealType.charAt(0).toUpperCase() + meal.mealType.slice(1)}
                  </Text>
                  <Text style={styles.recentMealTime}>
                    {TimeManager.formatDate(new Date(meal.timestamp), TimeManager.formats.DATETIME_DISPLAY)}
                  </Text>
                  <Text style={styles.recentMealNutrition}>
                    {safeToFixed(meal.nutrition?.carbs, 0)}g carbs
                  </Text>
                </View>
              ))}
            </ScrollView>
          </View>
        )}

        {/* ── Meal Type ── */}
        <View style={styles.section}>
          <Text style={styles.label}>Meal Type *</Text>
          <View style={styles.mealTypeChips}>
            {MEAL_TYPES.map(t => (
              <TouchableOpacity
                key={t.value}
                style={[styles.mealChip, mealType === t.value && styles.mealChipActive]}
                onPress={() => setMealType(t.value)}
              >
                <Text style={styles.mealChipIcon}>{t.icon}</Text>
                <Text style={[styles.mealChipText, mealType === t.value && styles.mealChipTextActive]}>
                  {t.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* ── Food Items ── */}
        <View style={[styles.activitiesCard, expandedSection === 'foods' && styles.activitiesCardExpanded]}>
          <TouchableOpacity style={styles.activitiesHeader} onPress={toggleFoodsSection}>
            <View style={styles.sectionHeaderContent}>
              <Text style={styles.sectionTitle}>Food Items ({selectedFoods.length}) *</Text>
              {isFoodsSaved && selectedFoods.length > 0 && (
                <View style={styles.savedValueBadge}>
                  <Text style={styles.savedValueText}>✓ {selectedFoods.length} saved</Text>
                </View>
              )}
            </View>
            <Text style={styles.expandIcon}>{expandedSection === 'foods' ? '▼' : '▶'}</Text>
          </TouchableOpacity>

          {expandedSection === 'foods' && (
            <View style={styles.activitiesContent}>
              <SelectedFoodsList
                foods={tempSelectedFoods}
                onRemove={handleFoodRemove}
                onUpdatePortion={handleFoodPortionUpdate}
              />
              <View style={styles.foodActionRow}>
                <TouchableOpacity style={styles.addButtonCompact} onPress={() => setShowFoodModal(true)}>
                  <Text style={styles.addButtonText}>+ Add Food</Text>
                </TouchableOpacity>
                {tempSelectedFoods.length > 0 && (
                  <TouchableOpacity style={styles.saveButtonCompact} onPress={handleSaveFoods}>
                    <Text style={styles.saveButtonText}>Save Foods</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}
        </View>

        {/* ── Blood Sugar ── */}
        <View style={[styles.activitiesCard, expandedSection === 'bloodSugar' && styles.activitiesCardExpanded]}>
          <TouchableOpacity style={styles.activitiesHeader} onPress={() => toggleSection('bloodSugar')}>
            <View style={styles.sectionHeaderContent}>
              <Text style={styles.sectionTitle}>Blood Sugar</Text>
              {isBloodSugarSaved && savedBloodSugar && (
                <View style={styles.savedValueBadge}>
                  <Text style={styles.savedValueText}>✓ {safeToFixed(parseFloat(savedBloodSugar.value))} {savedBloodSugar.unit}</Text>
                </View>
              )}
            </View>
            <Text style={styles.expandIcon}>{expandedSection === 'bloodSugar' ? '▼' : '▶'}</Text>
          </TouchableOpacity>

          {expandedSection === 'bloodSugar' && (
            <View style={styles.activitiesContent}>
              <UnifiedBloodSugarInput
                onChange={handleBloodSugarChange}
                initialValue={bloodSugarData?.value}
                standalone={false}
                showTimestampSelector={true}
                showUnitSelector={true}
                showStatusIndicator={true}
                showReferenceRanges={true}
              />
              <TouchableOpacity
                style={[styles.saveButton, (!bloodSugarData?.value || parseFloat(bloodSugarData.value) <= 0) && styles.saveButtonDisabled]}
                onPress={handleSaveBloodSugar}
                disabled={!bloodSugarData?.value || parseFloat(bloodSugarData.value) <= 0}
              >
                <Text style={styles.saveButtonText}>Save Blood Sugar</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* ── Activities ── */}
        <View style={[styles.activitiesCard, expandedSection === 'activities' && styles.activitiesCardExpanded]}>
          <TouchableOpacity style={styles.activitiesHeader} onPress={() => toggleSection('activities')}>
            <View style={styles.sectionHeaderContent}>
              <Text style={styles.sectionTitle}>Activities</Text>
              {isActivitiesSaved && savedActivities.length > 0 && (
                <View style={styles.savedValueBadge}>
                  <Text style={styles.savedValueText}>✓ {savedActivities.length} saved</Text>
                </View>
              )}
            </View>
            <Text style={styles.expandIcon}>{expandedSection === 'activities' ? '▼' : '▶'}</Text>
          </TouchableOpacity>

          {expandedSection === 'activities' && (
            <View style={styles.activitiesContent}>
              {constantsLoading ? (
                <ActivityIndicator color="#1976d2" />
              ) : (
                <>
                  {savedActivities.length === 0 && pdSynthesizedActivities.length > 0 && (
                    <View style={{ backgroundColor: '#e8f5e9', borderRadius: 6, padding: 8, marginBottom: 8, borderLeftWidth: 3, borderLeftColor: '#4caf50' }}>
                      <Text style={{ fontSize: 12, fontWeight: '600', color: '#2e7d32' }}>
                        🏃 {pdSynthesizedActivities.length} active exercise session{pdSynthesizedActivities.length !== 1 ? 's' : ''} pre-loaded from today's log
                      </Text>
                      <Text style={{ fontSize: 11, color: '#555', marginTop: 2 }}>
                        These are used for Activity Impact. Edit or clear them below, or add your own.
                      </Text>
                    </View>
                  )}
                  <UnifiedActivityInput
                    onActivityUpdate={handleActivityUpdate}
                    initialActivities={savedActivities.length > 0 ? activities : pdSynthesizedActivities}
                    activityCoefficients={constants?.activity_coefficients || {}}
                    showNotes={false}
                  />
                </>
              )}
              <TouchableOpacity style={styles.saveButton} onPress={handleSaveActivities}>
                <Text style={styles.saveButtonText}>
                  {activities.length > 0 ? 'Save Activities' : 'No Activities (Save to Clear)'}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* ── Suggested Insulin Dose Card ── */}
        {calculationResult && (
          <View style={styles.doseCard}>
            {/* Warning banner — active effects / general */}
            {!!activeEffectsWarning && (
              <View style={styles.doseWarningBanner}>
                <Text style={styles.doseWarningText}>⚠️ {activeEffectsWarning}</Text>
              </View>
            )}

            {/* IOB Surplus Warning — active insulin already covers this meal */}
            {calculationResult?.breakdown?.iobSurplusWarning && (
              <View style={styles.iobSurplusBanner}>
                {/* Title + body on left, pills on right */}
                <View style={styles.iobSurplusLeft}>
                  <Text style={styles.iobSurplusTitle}>
                    ⚠️ IOB Covers This Meal
                  </Text>
                  <Text style={styles.iobSurplusBody}>
                    {(calculationResult.breakdown.activeInsulin).toFixed(1)}u IOB — no dose needed, injecting risks a low.
                  </Text>
                  <Text style={styles.iobSurplusCarbNote}>
                    Eat glucose tablets, juice, or fruit to offset.
                  </Text>
                </View>
                {/* Stat pills stacked on right */}
                <View style={styles.iobSurplusRight}>
                  <View style={styles.iobSurplusStatPill}>
                    <Text style={styles.iobSurplusStatLabel}>Surplus</Text>
                    <Text style={styles.iobSurplusStatValue}>
                      {calculationResult.breakdown.iobSurplusWarning.surplusUnits.toFixed(1)}u
                    </Text>
                  </View>
                  <View style={[styles.iobSurplusStatPill, styles.iobSurplusStatPillCarb]}>
                    <Text style={[styles.iobSurplusStatLabel, styles.iobSurplusStatLabelCarb]}>
                      Eat
                    </Text>
                    <Text style={[styles.iobSurplusStatValue, styles.iobSurplusStatValueCarb]}>
                      {calculationResult.breakdown.iobSurplusWarning.extraCarbsNeeded}g
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* Compact dose row */}
            {isCalculating ? (
              <View style={styles.doseCalculatingRow}>
                <ActivityIndicator color="#1976d2" size="small" />
                <Text style={styles.doseCalculatingText}>Calculating…</Text>
              </View>
            ) : (
              <>
                {/*
                  ── Compact 3-line layout ──────────────────────────────────
                  Line 1 (primary): dose number on the right, label + carb
                                    equiv + absorption type on the left.
                  Line 2:           insulin type (plain text, no card/strip).
                  Line 3:           timing guideline.
                  Full details are still accessible via "Show calculation
                  details" below, so the strip/expandable sub-card is gone.
                  ──────────────────────────────────────────────────────────
                */}
                <View style={styles.dosePrimaryRow}>
                  <View style={styles.doseLabelStack}>
                    <Text style={styles.dosePrimaryLabel}>Suggested Insulin Dose</Text>
                    {/* Line 1 sub-text: carb equiv · absorption */}
                    <Text style={styles.doseNutritionPill}>
                      {safeToFixed(calculationResult?.breakdown?.totalCarbEquiv ?? 0, 1)}g carb equiv
                      {'  ·  '}
                      {dominantAbsorption.replace(/_/g, ' ')}
                    </Text>
                  </View>
                  <Text style={styles.dosePrimaryValue}>
                    {safeToFixed(suggestedInsulinValue, 1)} units
                  </Text>
                </View>

                {/* Line 2 + 3: insulin type & timing — hidden when IOB already covers the meal */}
                {/* ── FIX: replaced <> / </> with <React.Fragment> to avoid Babel JSX parser
                         misidentifying the closing tag when deeply nested IIFEs are present ── */}
                {!calculationResult?.breakdown?.iobSurplusWarning && (
                  <React.Fragment>
                    {/* Line 2: insulin type — plain inline text */}
                    {insulinSuggestionConfig && (
                      <View style={styles.doseMetaRow}>
                        <Text style={styles.doseMetaLabel}>💉 Bolus insulin: </Text>
                        <Text style={[styles.doseMetaValue, { color: insulinSuggestionConfig.color }]}>
                          {insulinSuggestionConfig.label}
                        </Text>
                      </View>
                    )}

                    {/* Line 3 + 4: timing + dosing strategy — unified block */}
                    {(() => {
                      const guidelineMap = (constants as any)?.insulin_timing_guidelines ?? {};
                      const sharedGuidelines = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.insulin_timing_guidelines;
                      const defaultMins: Record<string, number> = Object.fromEntries(
                        Object.entries(sharedGuidelines).map(([k, v]) => [k, v.timing_minutes])
                      );

                      // Clamp to clinical minimums — prevents a stale server value like
                      // 5 min from contradicting the advisory text below.
                      const CLINICAL_MINIMUMS: Record<string, number> = { slow: 20, very_slow: 30 };
                      const storedMins = guidelineMap[dominantAbsorption]?.timing_minutes
                        ?? defaultMins[dominantAbsorption]
                        ?? 10;
                      const mins = CLINICAL_MINIMUMS[dominantAbsorption]
                        ? Math.max(storedMins, CLINICAL_MINIMUMS[dominantAbsorption])
                        : storedMins;

                      const mealLabel =
                        mealType ? mealType.charAt(0).toUpperCase() + mealType.slice(1) : 'Meal';
                      const isSlowMeal =
                        dominantAbsorption === 'slow' || dominantAbsorption === 'very_slow';

                      // ── Mixed meal (pizza-effect) — dual split strategy ──────────
                      if (isMixedMeal) {
                        const totalDose  = suggestedInsulinValue;
                        const firstDose  = Math.round(totalDose * 0.6 * 10) / 10;
                        const secondDose = Math.round((totalDose - firstDose) * 10) / 10;
                        return (
                          <View style={{ marginHorizontal: 12, marginBottom: 8, marginTop: 2, borderRadius: 8, borderWidth: 1, borderColor: '#e0e0e0', overflow: 'hidden' }}>
                            {/* Header */}
                            <View style={{ backgroundColor: '#fff8f0', paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#e0e0e0' }}>
                              <Text style={{ fontSize: 11, fontWeight: '700', color: '#bf360c' }}>
                                🍕 Mixed meal — biphasic glucose response
                              </Text>
                            </View>

                            {/* Option A + B — side by side */}
                            <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#f0f0f0' }}>
                              {/* Option A — NovoLog dual split */}
                              <View style={{ flex: 1, paddingHorizontal: 10, paddingVertical: 8, borderRightWidth: 1, borderRightColor: '#f0d0b8' }}>
                                <Text style={{ fontSize: 12, fontWeight: '700', color: '#1565c0', marginBottom: 3 }}>
                                  A · NovoLog — dual split (recommended)
                                </Text>
                                <Text style={{ fontSize: 12, color: '#333' }}>
                                  <Text style={{ fontWeight: '700' }}>{safeToFixed(firstDose, 1)}u</Text>
                                  {' (60%)  5 min before eating'}
                                </Text>
                                <Text style={{ fontSize: 12, color: '#333' }}>
                                  <Text style={{ fontWeight: '700' }}>{safeToFixed(secondDose, 1)}u</Text>
                                  {' (40%)  at +2.5 h after meal start'}
                                </Text>
                                <Text style={{ fontSize: 10, color: '#888', marginTop: 3 }}>
                                  1st covers fast-carb peak (~60–90 min) · 2nd covers fat-delayed peak (~3–5 h)
                                </Text>
                              </View>

                              {/* Option B — Regular insulin */}
                              <View style={{ flex: 1, paddingHorizontal: 10, paddingVertical: 8 }}>
                                <Text style={{ fontSize: 12, fontWeight: '700', color: '#2e7d32', marginBottom: 3 }}>
                                  B · Regular insulin (Humulin R / Novolin R)
                                </Text>
                                <Text style={{ fontSize: 12, color: '#333' }}>
                                  <Text style={{ fontWeight: '700' }}>{safeToFixed(totalDose, 1)}u</Text>
                                  {' at meal time — no wait, no split'}
                                </Text>
                              </View>
                            </View>

                            {/* BG check reminders */}
                            <View style={{ paddingHorizontal: 10, paddingVertical: 8 }}>
                              <Text style={{ fontSize: 11, color: '#bf360c', fontStyle: 'italic' }}>
                                ⏱ Check BG at +2 h and +5–6 h — late hyperglycaemia (3–6 h) is the primary risk.
                              </Text>
                            </View>
                          </View>
                        );
                      }

                      if (!isSlowMeal) {
                        // Fast / medium / very_fast — plain single timing line
                        const timingText =
                          mins === 0
                            ? 'Inject your bolus insulin, then eat immediately'
                            : `Inject your bolus insulin, then eat your ${mealLabel} ${mins} min later`;
                        return (
                          <View style={styles.doseMetaRow}>
                            <Text style={styles.doseMetaLabel}>⏰ Timing: </Text>
                            <Text style={styles.doseMetaValue}>{timingText}</Text>
                          </View>
                        );
                      }

                      // ── Slow / Very slow — show two concrete options ──────────────
                      // Split dose math (NovoLog): first = 50%, second = remainder
                      // to avoid double-rounding error (e.g. 2.6u → 1.3 + 1.3, not 1.3 + 1.4)
                      const totalDose = suggestedInsulinValue;
                      const firstDose  = Math.round(totalDose * 0.5 * 10) / 10;
                      const secondDose = Math.round((totalDose - firstDose) * 10) / 10;

                      // Second injection fires 90 min after the first injection,
                      // which is (90 - mins) min after eating starts.
                      const secondInjectFromMealStart = 90 - mins;

                      return (
                        <View style={{
                          marginHorizontal: 12,
                          marginBottom: 8,
                          marginTop: 2,
                          borderRadius: 8,
                          borderWidth: 1,
                          borderColor: '#e0e0e0',
                          overflow: 'hidden',
                        }}>
                          {/* Header */}
                          <View style={{
                            backgroundColor: dominantAbsorption === 'very_slow' ? '#fff3e0' : '#fff8f0',
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            borderBottomWidth: 1,
                            borderBottomColor: '#e0e0e0',
                          }}>
                            <Text style={{ fontSize: 11, fontWeight: '700', color: dominantAbsorption === 'very_slow' ? '#e65100' : '#ef6c00' }}>
                              ⏰ {dominantAbsorption === 'very_slow' ? 'Very slow' : 'Slow'} meal — choose one option
                            </Text>
                          </View>

                          {/* Options row: A+C on left, B on right */}
                          {(() => {
                            const afterMealMins = dominantAbsorption === 'very_slow' ? 30 : 10;
                            const tailMins      = dominantAbsorption === 'very_slow' ? 180 : 70;
                            const tailHours     = (tailMins / 60).toFixed(1);
                            return (
                              <View style={{ flexDirection: 'row' }}>
                                {/* Left column: A + C */}
                                <View style={{ flex: 1, borderRightWidth: 1, borderRightColor: '#e0e0e0' }}>
                                  {/* Option A — NovoLog split dose */}
                                  <View style={{ paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' }}>
                                    <Text style={{ fontSize: 12, fontWeight: '700', color: '#1565c0', marginBottom: 3 }}>
                                      A · NovoLog — split dose
                                    </Text>
                                    <Text style={{ fontSize: 12, color: '#333' }}>
                                      <Text style={{ fontWeight: '700' }}>{safeToFixed(firstDose, 1)}u</Text>{` now  →  eat in ${mins} min`}
                                    </Text>
                                    <Text style={{ fontSize: 12, color: '#333' }}>
                                      <Text style={{ fontWeight: '700' }}>{safeToFixed(secondDose, 1)}u</Text>{` at +90 min`}{secondInjectFromMealStart > 0 ? ` (${secondInjectFromMealStart} min after eating)` : ''}
                                    </Text>
                                  </View>
                                  {/* Option C — NovoLog single dose */}
                                  <View style={{ paddingHorizontal: 10, paddingVertical: 8 }}>
                                    <Text style={{ fontSize: 12, fontWeight: '700', color: '#6a1b9a', marginBottom: 3 }}>
                                      C · NovoLog — single dose
                                    </Text>
                                    <Text style={{ fontSize: 12, color: '#333' }}>
                                      {'Start eating  →  inject '}
                                      <Text style={{ fontWeight: '700' }}>{safeToFixed(totalDose, 1)}u</Text>
                                      {` after ${afterMealMins} min`}
                                    </Text>
                                    <Text style={{ fontSize: 10, color: '#888', marginTop: 3 }}>
                                      {`BG may run ~${tailHours} h high after eating — resolves with insulin tail.`}
                                    </Text>
                                  </View>
                                </View>

                                {/* Right column: B */}
                                <View style={{ flex: 1, paddingHorizontal: 10, paddingVertical: 8, justifyContent: 'center' }}>
                                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#2e7d32', marginBottom: 3 }}>
                                    B · Regular insulin (Humulin R / Novolin R)
                                  </Text>
                                  <Text style={{ fontSize: 12, color: '#333' }}>
                                    <Text style={{ fontWeight: '700' }}>{safeToFixed(totalDose, 1)}u</Text>{' at meal time — no wait, no split'}
                                  </Text>
                                </View>
                              </View>
                            );
                          })()}
                        </View>
                      );
                    })()}
                  </React.Fragment>
                )}

                {/* Collapsible toggle */}
                <TouchableOpacity
                  style={styles.doseBreakdownToggle}
                  onPress={() => setShowBreakdown(v => !v)}
                  activeOpacity={0.75}
                >
                  <Text style={styles.doseBreakdownToggleText}>
                    {showBreakdown ? 'Hide calculation details ▲' : 'Show calculation details ▼'}
                  </Text>
                </TouchableOpacity>

                {/* Breakdown cards — hidden by default */}
                {showBreakdown && (
                  <View style={styles.doseBreakdownBody}>
                    {/* ── Tabs ── */}
                    <View style={styles.breakdownTabRow}>
                      <TouchableOpacity
                        style={[styles.breakdownTab, breakdownTab === 'summary' && styles.breakdownTabActive]}
                        onPress={() => setBreakdownTab('summary')}
                      >
                        <Text style={[styles.breakdownTabText, breakdownTab === 'summary' && styles.breakdownTabTextActive]}>
                          📋 Calculation
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.breakdownTab, breakdownTab === 'timing' && styles.breakdownTabActive]}
                        onPress={() => setBreakdownTab('timing')}
                      >
                        <Text style={[styles.breakdownTabText, breakdownTab === 'timing' && styles.breakdownTabTextActive]}>
                          ⏰ Timing & Types
                        </Text>
                      </TouchableOpacity>
                    </View>

                    {/* ── Tab content ── */}
                    {breakdownTab === 'summary' && (
                      <FullInsulinBreakdown
                        result={calculationResult}
                        patientConstants={constants}
                      />
                    )}

                    {breakdownTab === 'timing' && (
                      <>
                        <MealTimingGuidelines
                          selectedFoods={selectedFoods}
                          timingGuidelines={(constants as any)?.insulin_timing_guidelines}
                          mealType={mealType}
                          mode="details"
                        />

                        {insulinSuggestionConfig ? (
                          <>
                            <View style={[styles.insulinTypeDetailCard, { borderLeftColor: insulinSuggestionConfig.color, marginTop: 8 }]}>
                              <View style={styles.insulinTypeHeaderRow}>
                                <Text style={[styles.insulinTypeName, { color: insulinSuggestionConfig.color, fontSize: 15 }]}>
                                  {insulinSuggestionConfig.icon}{'  '}{insulinSuggestionConfig.label}
                                </Text>
                                <View style={[styles.insulinTypeAbsorptionBadge, { backgroundColor: insulinSuggestionConfig.color + '18' }]}>
                                  <Text style={[styles.insulinTypeAbsorptionText, { color: insulinSuggestionConfig.color }]}>
                                    {dominantAbsorption.replace(/_/g, ' ')}
                                  </Text>
                                </View>
                              </View>
                              {!!insulinBrandNames && (
                                <Text style={[styles.insulinTypeBrands, { marginTop: 8 }]}>
                                  <Text style={styles.insulinTypeBrandsLabel}>Examples: </Text>
                                  {insulinBrandNames}
                                </Text>
                              )}
                              <Text style={[styles.insulinTypeRationale, { marginTop: 8, fontSize: 12, lineHeight: 18 }]}>
                                {insulinSuggestionConfig.rationale}
                              </Text>
                              {/* Coverage gap note — shown for slow / very_slow */}
                              {!!insulinSuggestionConfig.coverageGapNote && (
                                <View style={{
                                  marginTop: 10,
                                  padding: 8,
                                  backgroundColor: '#fff3e0',
                                  borderRadius: 6,
                                  borderLeftWidth: 3,
                                  borderLeftColor: '#e65100',
                                }}>
                                  <Text style={{ fontSize: 11, fontWeight: '700', color: '#e65100', marginBottom: 3 }}>
                                    ⚠️ Coverage gap
                                  </Text>
                                  <Text style={{ fontSize: 11, color: '#5d4037', lineHeight: 17 }}>
                                    {insulinSuggestionConfig.coverageGapNote}
                                  </Text>
                                </View>
                              )}
                              {/* Split bolus note — shown only for very_slow */}
                              {!!insulinSuggestionConfig.splitDoseNote && (
                                <View style={{
                                  marginTop: 8,
                                  padding: 8,
                                  backgroundColor: '#f3e5f5',
                                  borderRadius: 6,
                                  borderLeftWidth: 3,
                                  borderLeftColor: '#7b1fa2',
                                }}>
                                  <Text style={{ fontSize: 11, fontWeight: '700', color: '#7b1fa2', marginBottom: 3 }}>
                                    💊 Split bolus strategy
                                  </Text>
                                  <Text style={{ fontSize: 11, color: '#4a148c', lineHeight: 17 }}>
                                    {insulinSuggestionConfig.splitDoseNote}
                                  </Text>
                                </View>
                              )}
                              <Text style={[styles.insulinTypeDisclaimer, { marginTop: 8 }]}>
                                ⚠️ Always follow your doctor's prescription. Informational only.
                              </Text>
                            </View>

                            {/* Regular insulin alternative — slow / very_slow only */}
                            {(dominantAbsorption === 'slow' || dominantAbsorption === 'very_slow') && (
                              <View style={[styles.insulinTypeDetailCard, { borderLeftColor: '#2e7d32', marginTop: 8 }]}>
                                <View style={styles.insulinTypeHeaderRow}>
                                  <Text style={[styles.insulinTypeName, { color: '#2e7d32', fontSize: 15 }]}>
                                    🕐{'  '}Regular Insulin — Alternative Option
                                  </Text>
                                  <View style={[styles.insulinTypeAbsorptionBadge, { backgroundColor: '#e8f5e9' }]}>
                                    <Text style={[styles.insulinTypeAbsorptionText, { color: '#2e7d32' }]}>
                                      {dominantAbsorption.replace(/_/g, ' ')}
                                    </Text>
                                  </View>
                                </View>
                                <Text style={[styles.insulinTypeBrands, { marginTop: 8 }]}>
                                  <Text style={styles.insulinTypeBrandsLabel}>Examples: </Text>
                                  Humulin R  ·  Novolin R
                                </Text>
                                <Text style={[styles.insulinTypeRationale, { marginTop: 8, fontSize: 12, lineHeight: 18 }]}>
                                  {dominantAbsorption === 'very_slow'
                                    ? 'Regular insulin (onset ~45 min, peak ~3 h, duration ~8 h) is the best pharmacokinetic match for very slow meals. Its onset aligns with food absorption, peak is only ~30 min after the meal peak, and the tail surplus drops to ~1 h — far less than the ~3 h gap left by rapid-acting analogs.'
                                    : 'Regular insulin (onset ~45 min, peak ~3 h, duration ~8 h) matches slow meal absorption well. Inject at meal start with no pre-bolus wait. The 150-min tail surplus may cause a gentle late hypo — a small snack after 3 h can prevent this.'}
                                </Text>
                                <View style={{ marginTop: 10, padding: 8, backgroundColor: '#e8f5e9', borderRadius: 6, borderLeftWidth: 3, borderLeftColor: '#2e7d32' }}>
                                  <Text style={{ fontSize: 11, fontWeight: '700', color: '#2e7d32', marginBottom: 3 }}>
                                    💉 Dosing
                                  </Text>
                                  <Text style={{ fontSize: 12, color: '#1b5e20', lineHeight: 18 }}>
                                    {'Same calculated dose: '}
                                    <Text style={{ fontWeight: '700' }}>{safeToFixed(suggestedInsulinValue, 1)} units</Text>
                                    {'\nInject at meal start — no pre-bolus wait needed.\nNo split dose required.'}
                                  </Text>
                                </View>
                                {dominantAbsorption === 'slow' && (
                                  <View style={{ marginTop: 8, padding: 8, backgroundColor: '#fff8e1', borderRadius: 6, borderLeftWidth: 3, borderLeftColor: '#f9a825' }}>
                                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#e65100', marginBottom: 3 }}>
                                      ⚠️ Late hypo watch
                                    </Text>
                                    <Text style={{ fontSize: 11, color: '#5d4037', lineHeight: 17 }}>
                                      Regular insulin outlasts slow meals by ~2.5 h. Check BG around 3 h after eating. A small 10–15g carb snack at that point can prevent a late hypo.
                                    </Text>
                                  </View>
                                )}
                                <Text style={[styles.insulinTypeDisclaimer, { marginTop: 8 }]}>
                                  ⚠️ Discuss with your doctor before switching insulin type. Informational only.
                                </Text>
                              </View>
                            )}
                          </>
                        ) : (
                          <Text style={[styles.insulinTypeRationale, { marginTop: 8 }]}>
                            Add foods to see insulin type suggestions.
                          </Text>
                        )}
                      </>
                    )}
                  </View>
                )}
              </>
            )}
          </View>
        )}

        {/* ── Insulin Dose ── */}
        <View style={[styles.activitiesCard, expandedSection === 'insulin' && styles.activitiesCardExpanded]}>
          <TouchableOpacity style={styles.activitiesHeader} onPress={() => toggleSection('insulin')}>
            <View style={styles.sectionHeaderContent}>
              <Text style={styles.sectionTitle}>Insulin Dose</Text>
              {suggestedInsulinValue > 0 && (
                <Text style={styles.suggestedBadge}>
                  Suggested: {safeToFixed(suggestedInsulinValue, 1)}u
                </Text>
              )}
              {isInsulinSaved && savedInsulin && (
                <View style={styles.savedValueBadge}>
                  <Text style={styles.savedValueText}>✓ {savedInsulin.dose}u</Text>
                </View>
              )}
            </View>
            <Text style={styles.expandIcon}>{expandedSection === 'insulin' ? '▼' : '▶'}</Text>
          </TouchableOpacity>

          {expandedSection === 'insulin' && (
            <View style={styles.activitiesContent}>
              <UnifiedInsulinInput
                onChange={handleInsulinChange}
                suggestedDose={suggestedInsulinValue}
                mealType={mealType}
                bloodSugar={savedBloodSugar?.value ? parseFloat(savedBloodSugar.value) : undefined}
                showTimestampSelector={true}
                showSuggestion={true}
                showNotes={false}
                liveActiveEffects={liveActiveEffects}
              />
              {activeInsulin > 0 && (
                <View style={styles.activeInsulinWarning}>
                  <Text style={styles.activeInsulinText}>
                    ⚠️ Active Insulin: {safeToFixed(activeInsulin, 1)} units on board
                  </Text>
                </View>
              )}
              <TouchableOpacity
                style={[
                  styles.saveButton,
                  (!insulinData?.medication || !insulinData?.dose || insulinData.dose <= 0) && styles.saveButtonDisabled,
                ]}
                onPress={handleSaveInsulin}
                disabled={!insulinData?.medication || !insulinData?.dose || insulinData.dose <= 0}
              >
                <Text style={styles.saveButtonText}>Save Insulin Dose</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* ── Notes ── */}
        <View style={[styles.activitiesCard, expandedSection === 'notes' && styles.activitiesCardExpanded]}>
          <TouchableOpacity style={styles.activitiesHeader} onPress={() => toggleSection('notes')}>
            <View style={styles.sectionHeaderContent}>
              <Text style={styles.sectionTitle}>Notes</Text>
              {notes.trim().length > 0 && (
                <View style={styles.savedValueBadge}>
                  <Text style={styles.savedValueText}>✓ Added</Text>
                </View>
              )}
            </View>
            <Text style={styles.expandIcon}>{expandedSection === 'notes' ? '▼' : '▶'}</Text>
          </TouchableOpacity>

          {expandedSection === 'notes' && (
            <View style={styles.activitiesContent}>
              <TextInput
                style={[styles.input, styles.textArea]}
                value={notes}
                onChangeText={setNotes}
                placeholder="Add any notes about this meal…"
                placeholderTextColor="#888888"
                multiline
                numberOfLines={4}
              />
            </View>
          )}
        </View>

        {/* ── Meal Time (always visible) ── */}
        <View style={styles.section}>
          {isInsulinSaved && (
            <View style={styles.mealTimeHint}>
              <Text style={styles.mealTimeHintIcon}>⏰</Text>
              <Text style={styles.mealTimeHintText}>
                {(() => {
                  const foods = selectedFoods.length > 0 ? selectedFoods : tempSelectedFoods;
                  const mins = getTimingMinutes(foods, constants);
                  return mins === 0
                    ? 'Set to your insulin time — adjust below if your meal timing differs'
                    : `Auto-set ${mins} min after your insulin dose — adjust below if needed`;
                })()}
              </Text>
            </View>
          )}
          <UnifiedTimePicker
            key={pickerKey}
            value={mealTimeUTC}
            onChange={handleMealTimeChange}
            mode={mealTimeMode}
            onModeChange={handleMealTimeModeChange}
            label="When will/did you eat this meal? *"
            showModeSelector={true}
            displayFormat="datetime"
          />
        </View>

        {/* ── Actions ── */}
        <View style={styles.buttonContainer}>
          <TouchableOpacity
            style={[styles.button, styles.cancelButton]}
            onPress={onCancel}
            disabled={isLoading}
          >
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.button, styles.submitButton, isLoading && styles.disabledButton]}
            onPress={handleSubmit}
            disabled={isLoading || selectedFoods.length === 0}
          >
            {isLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitButtonText}>Log Meal</Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* Food Search — web uses absolute overlay, native uses Modal */}
      {Platform.OS === 'web' ? (
        showFoodModal && (
          <View style={styles.webOverlay}>
            <View style={styles.webSheet}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Add Food</Text>
                <TouchableOpacity style={styles.modalCloseButton} onPress={() => setShowFoodModal(false)}>
                  <Text style={styles.modalCloseText}>✕</Text>
                </TouchableOpacity>
              </View>
              <FoodSearch onSelect={handleFoodSelect} onSelectMultiple={handleFoodSelectMultiple} onClose={() => setShowFoodModal(false)} />
            </View>
          </View>
        )
      ) : (
        <Modal
          visible={showFoodModal}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setShowFoodModal(false)}
        >
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Food</Text>
              <TouchableOpacity style={styles.modalCloseButton} onPress={() => setShowFoodModal(false)}>
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>
            <FoodSearch onSelect={handleFoodSelect} onSelectMultiple={handleFoodSelectMultiple} onClose={() => setShowFoodModal(false)} />
          </View>
        </Modal>
      )}
    </View>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// STYLES  (unchanged from original)
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:              { flex: 1, backgroundColor: '#f5f5f5' },
  scrollContent:          { flex: 1 },
  contentContainer:       { padding: 12 },
  header:                 { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  title:                  { fontSize: 22, fontWeight: 'bold', color: '#333' },
  recentMealsButton:      { backgroundColor: '#e3f2fd', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  recentMealsButtonText:  { color: '#1976d2', fontSize: 13, fontWeight: '600' },
  messageContainer:       { backgroundColor: '#e3f2fd', padding: 10, borderRadius: 8, marginBottom: 10 },
  messageText:            { color: '#1976d2', fontSize: 14 },
  recentMealsSection:     { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 10 },
  recentMealCard:         { backgroundColor: '#f8f9fa', padding: 10, borderRadius: 8, marginRight: 10, minWidth: 110 },
  recentMealType:         { fontSize: 13, fontWeight: '600', color: '#333', marginBottom: 2 },
  recentMealTime:         { fontSize: 11, color: '#666', marginBottom: 2 },
  recentMealNutrition:    { fontSize: 11, color: '#1976d2' },
  section:                { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 10 },
  expandableHeader:       { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionHeaderContent:   { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  sectionTitle:           { fontSize: 16, fontWeight: '600', color: '#333' },
  expandIcon:             { fontSize: 14, color: '#666' },
  savedValueBadge:        { backgroundColor: '#4caf50', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 10 },
  savedValueText:         { color: '#fff', fontSize: 11, fontWeight: '600' },
  suggestedBadge:         { fontSize: 11, color: '#4caf50', backgroundColor: '#e8f5e9', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 10, fontWeight: '600' },
  expandedContent:        { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 10 },
  activitiesCard:         { backgroundColor: '#fff', borderRadius: 12, marginBottom: 10, overflow: 'hidden' },
  activitiesCardExpanded: { borderRadius: 12 },
  activitiesHeader:       { padding: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  activitiesContent:      { paddingHorizontal: 12, paddingBottom: 12, borderTopWidth: 1, borderTopColor: '#f0f0f0' },
  label:                  { fontSize: 13, fontWeight: '600', color: '#333', marginBottom: 8 },
  pickerContainer:        { backgroundColor: '#f8f9fa', borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 8, overflow: 'hidden' },
  picker:                 { height: 50, color: '#000000' },
  input:                  { backgroundColor: '#f8f9fa', borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 8, padding: 12, fontSize: 16, color: '#000000' },
  textArea:               { height: 90, textAlignVertical: 'top' },
  foodActionRow:          { flexDirection: 'row', gap: 8, marginTop: 8 },
  addButtonCompact:       { flex: 1, backgroundColor: '#1976d2', paddingVertical: 9, borderRadius: 8, alignItems: 'center' },
  addButton:              { backgroundColor: '#1976d2', padding: 12, borderRadius: 8, alignItems: 'center', marginTop: 10 },
  addButtonText:          { color: '#fff', fontSize: 14, fontWeight: '600' },
  saveButtonCompact:      { flex: 1, backgroundColor: '#4caf50', paddingVertical: 9, borderRadius: 8, alignItems: 'center' },
  saveButton:             { backgroundColor: '#4caf50', padding: 12, borderRadius: 8, alignItems: 'center', marginTop: 10 },
  saveButtonDisabled:     { backgroundColor: '#ccc', opacity: 0.6 },
  saveButtonText:         { color: '#fff', fontSize: 14, fontWeight: '600' },
  calculationSection:     { marginBottom: 10 },
  timingGuidelineContainer: { backgroundColor: '#fff3cd', borderRadius: 12, padding: 12, marginBottom: 10, flexDirection: 'row', alignItems: 'center', borderLeftWidth: 4, borderLeftColor: '#ff9800' },
  timingGuidelineIcon:    { fontSize: 18, marginRight: 10 },
  timingGuidelineText:    { flex: 1, fontSize: 13, color: '#856404', fontWeight: '500' },
  activeInsulinWarning:   { backgroundColor: '#fff3e0', padding: 10, borderRadius: 8, marginTop: 10, borderLeftWidth: 4, borderLeftColor: '#ff9800' },
  activeInsulinText:      { color: '#e65100', fontSize: 13, fontWeight: '500' },
  mealTimeHint:           { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff8e1', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 10, marginBottom: 8, borderLeftWidth: 3, borderLeftColor: '#ff9800' },
  mealTimeHintIcon:       { fontSize: 13, marginRight: 6 },
  mealTimeHintText:       { flex: 1, fontSize: 12, color: '#856404', fontWeight: '500' },
  buttonContainer:        { flexDirection: 'row', gap: 10, marginTop: 16, marginBottom: 24 },
  button:                 { flex: 1, padding: 14, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  cancelButton:           { backgroundColor: '#f5f5f5', borderWidth: 1, borderColor: '#e0e0e0' },
  cancelButtonText:       { color: '#666', fontSize: 15, fontWeight: '600' },
  submitButton:           { backgroundColor: '#1976d2' },
  submitButtonText:       { color: '#fff', fontSize: 15, fontWeight: '600' },
  disabledButton:         { opacity: 0.5 },
  modalContainer:         { flex: 1, backgroundColor: '#fff' },
  webOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    zIndex: 1000,
    justifyContent: 'flex-end',
  },
  webSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    height: '85%' as any,
    overflow: 'hidden',
  },
  modalHeader:            { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#e0e0e0', backgroundColor: '#fff', elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4 },
  modalTitle:             { fontSize: 20, fontWeight: '600', color: '#333' },
  modalCloseButton:       { width: 36, height: 36, borderRadius: 18, backgroundColor: '#f5f5f5', alignItems: 'center', justifyContent: 'center' },
  modalCloseText:         { fontSize: 22, color: '#666', fontWeight: '600' },

  // ── Meal type chips ───────────────────────────────────────────────────────
  mealTypeChips: {
    flexDirection: 'row',
    gap: 8,
  },
  mealChip: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#e0e0e0',
    backgroundColor: '#f8f9fa',
    gap: 3,
  },
  mealChipActive: {
    borderColor: '#1976d2',
    backgroundColor: '#e3f2fd',
  },
  mealChipIcon: {
    fontSize: 18,
  },
  mealChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#666',
  },
  mealChipTextActive: {
    color: '#1976d2',
  },

  // ── Suggested dose card ───────────────────────────────────────────────────
  doseCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    marginBottom: 10,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: '#1976d2',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
  },
  doseWarningBanner: {
    backgroundColor: '#fff3e0',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#ffe0b2',
  },
  doseWarningText: { fontSize: 13, color: '#e65100' },

  // ── IOB surplus banner on compact dose card ───────────────────────────────
  iobSurplusBanner: {
    backgroundColor: '#fbe9e7',
    borderBottomWidth: 1,
    borderBottomColor: '#e64a19',
    borderLeftWidth: 4,
    borderLeftColor: '#e64a19',
    paddingVertical: 8,
    paddingHorizontal: 12,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 10,
  },
  iobSurplusLeft: {
    flex: 1,
    gap: 2,
  },
  iobSurplusRight: {
    gap: 4,
    alignItems: 'flex-end' as const,
  },
  iobSurplusHeaderRow: {
    flex: 1,
  },
  iobSurplusTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#bf360c',
  },
  iobSurplusBody: {
    fontSize: 10,
    color: '#5d4037',
    lineHeight: 14,
  },
  iobSurplusStatsRow: {
    flexDirection: 'row' as const,
    gap: 8,
    marginTop: 2,
  },
  iobSurplusStatPill: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 5,
    backgroundColor: '#ffccbc',
    borderRadius: 5,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  iobSurplusStatPillCarb: {
    backgroundColor: '#ffe0b2',
  },
  iobSurplusStatLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: '#bf360c',
  },
  iobSurplusStatLabelCarb: {
    color: '#e65100',
  },
  iobSurplusStatValue: {
    fontSize: 13,
    fontWeight: '800',
    color: '#bf360c',
  },
  iobSurplusStatValueCarb: {
    color: '#bf360c',
  },
  iobSurplusCarbNote: {
    fontSize: 10,
    color: '#6d4c41',
    fontStyle: 'italic' as const,
    lineHeight: 13,
  },
  iobSurplusCarbRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    backgroundColor: '#ffe0b2',
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 4,
  },
  iobSurplusCarbLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#e65100',
  },
  iobSurplusCarbValue: {
    fontSize: 14,
    fontWeight: '800',
    color: '#bf360c',
  },
  dosePrimaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
  },
  doseMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 3,
  },
  doseMetaLabel: {
    fontSize: 12,
    color: '#666',
  },
  doseMetaValue: {
    fontSize: 12,
    fontWeight: '600',
    color: '#333',
    flexShrink: 1,
  },
  doseLabelStack: {
    flex: 1,
    paddingRight: 8,
  },
  dosePrimaryLabel: { fontSize: 11, fontWeight: '700', color: '#1565c0', textTransform: 'uppercase', letterSpacing: 0.3 },
  dosePrimaryValue: { fontSize: 26, fontWeight: '800', color: '#1b5e20' },
  doseCalculatingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 10,
  },
  doseCalculatingText: { fontSize: 14, color: '#666' },
  doseNutritionPill: {
    fontSize: 11,
    color: '#666',
    marginTop: 3,
    lineHeight: 16,
  },
  doseBreakdownToggle: {
    borderTopWidth: 1,
    borderTopColor: '#e3f2fd',
    backgroundColor: '#f5f9ff',
    paddingVertical: 7,
    marginTop: 6,
    alignItems: 'center',
  },
  doseBreakdownToggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1976d2',
  },
  doseBreakdownBody: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 4,
    backgroundColor: '#fafcff',
  },

  // ── Insulin type suggestion strip ────────────────────────────────────────
  insulinTypeStrip: {
    marginHorizontal: 12,
    marginBottom: 10,
    padding: 12,
    backgroundColor: '#fafafa',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderLeftWidth: 4,
    flexDirection: 'row',
    gap: 10,
  },
  insulinTypeIcon: {
    fontSize: 20,
    marginTop: 2,
  },
  insulinTypeBody: {
    flex: 1,
    gap: 3,
  },
  insulinTypeHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  insulinTypeLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  insulinTypeName: {
    fontSize: 13,
    fontWeight: '700',
  },
  insulinTypeNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  insulinTypeChevron: {
    fontSize: 10,
    fontWeight: '700',
    marginLeft: 6,
  },
  insulinTypeBrands: {
    fontSize: 11,
    color: '#555',
    lineHeight: 16,
  },
  insulinTypeBrandsLabel: {
    fontWeight: '700',
    color: '#333',
  },
  insulinTypeRationale: {
    fontSize: 11,
    color: '#666',
    lineHeight: 16,
    marginTop: 2,
  },
  insulinTypeDisclaimer: {
    fontSize: 10,
    color: '#999',
    fontStyle: 'italic',
    marginTop: 2,
  },
  insulinTypeAbsorptionBadge: {
    paddingVertical: 2,
    paddingHorizontal: 7,
    borderRadius: 6,
  },
  insulinTypeAbsorptionText: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'capitalize',
  },

  // ── Breakdown tabs ────────────────────────────────────────────────────────
  breakdownTabRow: {
    flexDirection: 'row',
    marginBottom: 10,
    borderRadius: 8,
    backgroundColor: '#f0f4f8',
    padding: 3,
    gap: 3,
  },
  breakdownTab: {
    flex: 1,
    paddingVertical: 6,
    alignItems: 'center',
    borderRadius: 6,
  },
  breakdownTabActive: {
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 1,
  },
  breakdownTabText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#888',
  },
  breakdownTabTextActive: {
    color: '#1976d2',
  },
  insulinTypeDetailCard: {
    backgroundColor: '#fafafa',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderLeftWidth: 4,
    padding: 12,
  },
});

export default MealForm;