/**
 * Unified Insulin Input
 * Location: mobile/components/forms/UnifiedInsulinInput.tsx
 *
 * Main Component: UnifiedInsulinInput
 * Description: Insulin dose input component with UTC timestamp handling,
 *              properly handles UTC storage and local display
 *
 * Features:
 * - Insulin type selection by category (rapid/short/intermediate/long)
 * - Dose validation with range limits
 * - Suggested dose display
 * - UTC timestamp management via UnifiedTimePicker
 * - Optional notes field
 * - Real-time validation feedback
 * - Correction suggestion card (standalone mode only — not shown in MealForm)
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView, ActivityIndicator } from 'react-native';

// Constants
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import { DEFAULT_PATIENT_CONSTANTS, getInsulinsByType, getCircadianBaseline, type MedicationFactor, SHARED_CONSTANTS, ABSORPTION_TO_INSULIN_CONFIG, type AbsorptionType } from '@/constants/shared-constants';

// Utils
import { validateInsulinDose, INSULIN_LIMITS } from '@/utils/validation';
import { TimeManager } from '@/utils/time';

// Components
import UnifiedTimePicker, { type TimeMode } from './UnifiedTimePicker';

// Services & hooks (used only in standalone mode)
import { useActiveEffects } from '@/hooks/useActiveEffects';
import { usePatientConstants } from '@/hooks/usePatientConstants';
import { getActiveEffectsFull } from '@/services/api/calculations';
import type { ActiveEffectsFullResult } from '@/services/api/calculations';
import { fetchStackedActivityEffectSafe } from '@/services/api/activity-pharmacodynamics';
import type { ActivityPDResult } from '@/services/api/activity-pharmacodynamics';
import { getActiveInsulin } from '@/services/api/insulin';
import {
  calculateInsulinDose,
  computeSyntheticSensitivityMultiplier,
  computeSyntheticAOB,
} from '@/services/insulinCalculationService';
import { resolveLiveEffects } from '@/utils/calculations/resolve-live-effects';
import type { ActiveEffectData } from '@/types/active-effects.types';

// Types
interface InsulinProfileWithId extends MedicationFactor {
  id: string;
  name?: string;
}

export interface InsulinData {
  medication: string;
  dose: number;
  timestamp: string; // ISO string in UTC
  notes?: string;
  mealType?: string;
  bloodSugar?: number;
  timestampMode?: 'now' | 'custom'; // ✅ lets MealForm snap meal time from live clock when in "now" mode
}

interface UnifiedInsulinInputProps {
  onChange: (data: InsulinData) => void;
  suggestedDose?: number;
  suggestedType?: string;
  mealType?: string;
  bloodSugar?: number;
  initialDose?: string;
  initialMedication?: string;
  initialTimestamp?: Date | string;
  initialMode?: TimeMode;
  initialNotes?: string;
  standalone?: boolean;
  disabled?: boolean;
  showTimestampSelector?: boolean;
  showSuggestion?: boolean;
  showNotes?: boolean;
  /** Dominant absorption type of the meal — drives insulin type + timing suggestion */
  absorptionType?: AbsorptionType;
  /** True when the meal has both slow AND fast items (pizza-effect) */
  isMixedMeal?: boolean;
  /** IOB already covers the full meal — show surplus warning instead of dose */
  iobSurplusWarning?: { surplusUnits: number; extraCarbsNeeded: number } | null;
  /** Warning from active-effects fetch (e.g. stale BG) — shown as banner above dose */
  activeEffectsWarning?: string;
  /**
   * Live PK snapshot from ActiveEffectsDisplay.onEffectsComputed().
   * When provided, the suggestion useMemo uses these values instead of
   * the stale getActiveEffectsFull() API snapshot.
   */
  liveActiveEffects?: ActiveEffectData;
}

const INSULIN_CATEGORIES = [
  { id: 'rapid', label: 'Rapid Acting', color: colors.insulin?.rapid || '#4caf50' },
  { id: 'short', label: 'Short Acting', color: colors.insulin?.short || '#8bc34a' },
  { id: 'intermediate', label: 'Intermediate', color: colors.insulin?.intermediate || '#ff9800' },
  { id: 'long', label: 'Long Acting', color: colors.insulin?.long || '#9c27b0' },
];

// ─── Suggestion engine (correction-only, no food context) ─────────────────────

interface CorrectionSuggestion {
  // ── One-sentence headline the patient reads first ───────────────────────────
  header: string;
  headerColor: string;

  // ── Supporting data (always visible, compact rows) ──────────────────────────
  estimatedBG: number | null;
  activeMealEffect:    { grams: number; pendingRise: number } | null;
  activeInsulinEffect: { units: number; pendingDrop: number } | null;
  projectedBG: number | null;
  projectedContext: string;

  // ── Correction dose — null = no dose row ───────────────────────────────────
  correctionDose:    number | null;
  correctionType:    string | null;
  correctionFormula: string | null;

  type: 'rapid' | 'long' | 'none';
  caution?: string;
  bgSource?: 'reading' | 'estimated' | 'circadian';
}

// ─── buildSuggestion ─────────────────────────────────────────────────────────

function buildSuggestion(
  estimatedBG: number | null,
  projectedBG: number | null,
  iob: number,
  pendingInsulinReduction: number,
  pendingMealRise: number,
  mob: number,
  targetBG: number,
  correctionFactor: number,
  bgSource?: 'reading' | 'estimated' | 'circadian',
): CorrectionSuggestion {
  const hour    = new Date().getHours();
  const isNight = hour >= 22 || hour < 6;

  const activeMealEffect: CorrectionSuggestion['activeMealEffect'] =
    mob > 0.5 ? { grams: mob, pendingRise: pendingMealRise } : null;
  const activeInsulinEffect: CorrectionSuggestion['activeInsulinEffect'] =
    iob > 0.05 ? { units: iob, pendingDrop: pendingInsulinReduction } : null;

  // ── No BG reading ─────────────────────────────────────────────────────────
  if (estimatedBG === null) {
    if (isNight) {
      return {
        header: 'No reading — nighttime basal dose likely',
        headerColor: '#6a1b9a',
        estimatedBG: null, activeMealEffect, activeInsulinEffect,
        projectedBG: null, projectedContext: '',
        correctionDose: null, correctionType: null, correctionFormula: null,
        type: 'long',
        bgSource,
      };
    }
    return {
      header: 'No BG reading — check before dosing',
      headerColor: '#e64a19',
      estimatedBG: null, activeMealEffect, activeInsulinEffect,
      projectedBG: null, projectedContext: '',
      correctionDose: null, correctionType: null, correctionFormula: null,
      type: 'rapid',
      caution: 'Check your blood sugar before dosing.',
      bgSource,
    };
  }

  const netPendingBG   = pendingMealRise - pendingInsulinReduction;
  const projectedValue = projectedBG ?? estimatedBG + netPendingBG;

  const netCorrectionUnits = (projectedValue - targetBG) / correctionFactor;

  // ── BG going low ─────────────────────────────────────────────────────────
  if (estimatedBG < targetBG - 10 || projectedValue < targetBG - 10) {
    return {
      header: 'Your blood sugar is going low — please consider taking a snack as soon as possible',
      headerColor: '#0d47a1',
      estimatedBG, activeMealEffect, activeInsulinEffect,
      projectedBG: projectedValue, projectedContext: 'when effects clear',
      correctionDose: null, correctionType: null, correctionFormula: null,
      type: 'none',
      caution: iob > 0.5
        ? `${iob.toFixed(1)}u of active insulin may lower it further — do not dose.`
        : undefined,
      bgSource,
    };
  }

  // ── IOB will handle it ────────────────────────────────────────────────────
  if (projectedValue <= targetBG + 20) {
    return {
      header: "It's OK — you don't need correction insulin right now",
      headerColor: '#2e7d32',
      estimatedBG, activeMealEffect, activeInsulinEffect,
      projectedBG: projectedValue, projectedContext: 'projected when effects clear',
      correctionDose: null, correctionType: null, correctionFormula: null,
      type: 'none',
      caution: 'Your active insulin is already bringing BG toward target. Dosing now risks a low.',
      bgSource,
    };
  }

  // ── BG at / below target ──────────────────────────────────────────────────
  if (estimatedBG <= targetBG) {
    if (isNight) {
      return {
        header: "It's OK — BG at target, nighttime basal dose likely",
        headerColor: '#6a1b9a',
        estimatedBG, activeMealEffect, activeInsulinEffect,
        projectedBG: projectedValue, projectedContext: 'when effects clear',
        correctionDose: null, correctionType: null, correctionFormula: null,
        type: 'long',
        caution: iob > 1
          ? `You have ${iob.toFixed(1)}u active — confirm basal is due.`
          : undefined,
        bgSource,
      };
    }
    return {
      header: "It's OK — you don't need correction insulin",
      headerColor: '#2e7d32',
      estimatedBG, activeMealEffect, activeInsulinEffect,
      projectedBG: projectedValue, projectedContext: 'when effects clear',
      correctionDose: null, correctionType: null, correctionFormula: null,
      type: 'none',
      caution: 'If logging a scheduled basal, select Long-Acting below.',
      bgSource,
    };
  }

  // ── Correction needed ─────────────────────────────────────────────────────
  // projectedValue already nets out both pendingMealRise and pendingInsulinReduction,
  // so we correct from projected BG — avoids double-counting IOB that is already
  // spoken for by active meal carbs.
  const formula = `(${projectedValue.toFixed(0)} projected − ${targetBG} target) ÷ ${correctionFactor} CF\n(active meal & IOB already netted into projected BG)`;
  const dose    = netCorrectionUnits >= 1.0 ? parseFloat(netCorrectionUnits.toFixed(1)) : null;

  return {
    header: dose !== null
      ? `Suggested correction insulin is ~${dose.toFixed(1)}u Rapid-Acting`
      : "It's OK — correction is small, no dose needed",
    headerColor: dose !== null ? '#c62828' : '#e65100',
    estimatedBG, activeMealEffect, activeInsulinEffect,
    projectedBG: projectedValue, projectedContext: 'projected without correction',
    correctionDose: dose,
    correctionType: dose !== null ? 'Rapid-Acting' : null,
    correctionFormula: dose !== null ? formula : null,
    type: 'rapid',
    caution: mob > 20
      ? `${mob.toFixed(0)}g active meal carbs already factored in.`
      : undefined,
    bgSource,
  };
}

// ─── Suggestion card component ────────────────────────────────────────────────

const SuggestionCard: React.FC<{ suggestion: CorrectionSuggestion }> = ({ suggestion }) => {
  const [showFormula, setShowFormula]           = useState(false);
  const [showActiveEffects, setShowActiveEffects] = useState(false);

  const hasActiveEffects =
    suggestion.activeMealEffect !== null || suggestion.activeInsulinEffect !== null;
  const hasDetails =
    suggestion.estimatedBG !== null || hasActiveEffects || suggestion.projectedBG !== null;

  // Net pending BG change from active meal/insulin effects — shown in the collapsed header
  const netPending = (() => {
    const rise = suggestion.activeMealEffect?.pendingRise  ?? 0;
    const drop = suggestion.activeInsulinEffect?.pendingDrop ?? 0;
    return rise - drop;
  })();
  const netLabel  = netPending >= 0 ? `+${netPending.toFixed(0)}` : `${netPending.toFixed(0)}`;
  const netColor  = netPending > 10 ? '#e65100' : netPending < -10 ? '#1565c0' : '#2e7d32';

  return (
    <View style={[suggStyles.card, { borderLeftColor: suggestion.headerColor }]}>

      {/* ── Header — one clear patient-facing sentence ── */}
      <View style={[suggStyles.header, { backgroundColor: suggestion.headerColor + '14' }]}>
        <Text style={[suggStyles.headerText, { color: suggestion.headerColor }]}>
          {suggestion.header}
        </Text>
        {suggestion.bgSource === 'circadian' && (
          <Text style={{ fontSize: 10, color: '#6a1b9a', marginTop: 4, fontStyle: 'italic' }}>
            🌙 BG from circadian baseline
          </Text>
        )}
      </View>

      {/* ── Compact data rows ── */}
      {hasDetails && (
        <View style={suggStyles.dataBlock}>

          {/* Current BG — always visible */}
          {suggestion.estimatedBG !== null && (
            <View style={suggStyles.dataRow}>
              <Text style={suggStyles.dataLabel}>📊 Current BG</Text>
              <Text style={[suggStyles.dataValue, { color: suggestion.headerColor }]}>
                {suggestion.estimatedBG.toFixed(0)}{' '}
                <Text style={suggStyles.dataUnit}>mg/dL</Text>
              </Text>
            </View>
          )}

          {/* ── Active effects — collapsed by default ── */}
          {hasActiveEffects && (
            <>
              {/* Collapsed header row — always visible, tappable to expand */}
              <TouchableOpacity
                style={suggStyles.activeEffectsHeader}
                onPress={() => setShowActiveEffects(v => !v)}
                activeOpacity={0.75}
              >
                <Text style={suggStyles.dataLabel}>⚡ Active effects</Text>
                <View style={suggStyles.activeEffectsHeaderRight}>
                  <Text style={[suggStyles.activeEffectsNet, { color: netColor }]}>
                    {netLabel}{' '}
                    <Text style={suggStyles.dataUnit}>mg/dL net</Text>
                  </Text>
                  <Text style={suggStyles.activeEffectsChevron}>
                    {showActiveEffects ? '▲' : '▼'}
                  </Text>
                </View>
              </TouchableOpacity>

              {/* Expanded rows */}
              {showActiveEffects && (
                <View style={suggStyles.activeEffectsBody}>
                  {suggestion.activeMealEffect && (
                    <View style={[suggStyles.dataRow, suggStyles.activeEffectsInnerRow]}>
                      <Text style={suggStyles.dataLabel}>🍽️ Meal still raising</Text>
                      <Text style={[suggStyles.dataValue, { color: '#e65100' }]}>
                        +{suggestion.activeMealEffect.pendingRise.toFixed(0)}{' '}
                        <Text style={suggStyles.dataUnit}>
                          mg/dL  ({suggestion.activeMealEffect.grams.toFixed(0)}g active)
                        </Text>
                      </Text>
                    </View>
                  )}
                  {suggestion.activeInsulinEffect && (
                    <View style={[suggStyles.dataRow, suggStyles.activeEffectsInnerRow]}>
                      <Text style={suggStyles.dataLabel}>💉 Insulin working</Text>
                      <Text style={[suggStyles.dataValue, { color: '#1565c0' }]}>
                        −{suggestion.activeInsulinEffect.pendingDrop.toFixed(0)}{' '}
                        <Text style={suggStyles.dataUnit}>
                          mg/dL  ({suggestion.activeInsulinEffect.units.toFixed(1)}u IOB)
                        </Text>
                      </Text>
                    </View>
                  )}
                </View>
              )}
            </>
          )}

          {/* Projected BG — always visible */}
          {suggestion.projectedBG !== null && !!suggestion.projectedContext && (
            <View style={[suggStyles.dataRow, suggStyles.dataRowProjected]}>
              <Text style={suggStyles.dataLabel}>🎯 Projected BG</Text>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[suggStyles.dataValue, { color: suggestion.headerColor }]}>
                  {suggestion.projectedBG.toFixed(0)}{' '}
                  <Text style={suggStyles.dataUnit}>mg/dL</Text>
                </Text>
                <Text style={suggStyles.projectedCtx}>{suggestion.projectedContext}</Text>
              </View>
            </View>
          )}
        </View>
      )}

      {/* ── Correction dose (only when ≥ 1.0u) ── */}
      {suggestion.correctionDose !== null && (
        <>
          <View style={suggStyles.divider} />
          <TouchableOpacity
            style={suggStyles.correctionRow}
            onPress={() => setShowFormula(v => !v)}
            activeOpacity={0.75}
          >
            <View style={{ flex: 1 }}>
              <Text style={suggStyles.correctionLabel}>Suggested dose</Text>
              <Text style={[suggStyles.correctionDose, { color: suggestion.headerColor }]}>
                ~{suggestion.correctionDose.toFixed(1)}u{'  '}
                <Text style={suggStyles.correctionType}>{suggestion.correctionType}</Text>
              </Text>
            </View>
            <Text style={[suggStyles.formulaToggle, { color: suggestion.headerColor }]}>
              {showFormula ? 'Hide ▲' : 'How? ▼'}
            </Text>
          </TouchableOpacity>
          {showFormula && suggestion.correctionFormula && (
            <View style={suggStyles.formulaBody}>
              <Text style={suggStyles.formulaText}>{suggestion.correctionFormula}</Text>
            </View>
          )}
        </>
      )}

      {/* ── Caution ── */}
      {!!suggestion.caution && (
        <View style={suggStyles.cautionRow}>
          <Text style={suggStyles.cautionText}>⚠️  {suggestion.caution}</Text>
        </View>
      )}

      <Text style={suggStyles.disclaimer}>
        Always follow your doctor's prescription. Informational only.
      </Text>
    </View>
  );
};

const suggStyles = StyleSheet.create({
  // ── Card shell ──────────────────────────────────────────────────────────────
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    marginBottom: 14,
    overflow: 'hidden',
    borderLeftWidth: 4,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
  },
  // ── Header band ─────────────────────────────────────────────────────────────
  header: {
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  headerText: {
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
  },
  // ── Compact data block ───────────────────────────────────────────────────────
  dataBlock: {
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  dataRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#f5f5f5',
  },
  dataRowProjected: {
    backgroundColor: '#fafafa',
  },
  dataLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: '#666',
    flex: 1,
  },
  dataValue: {
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'right',
  },
  dataUnit: {
    fontSize: 11,
    fontWeight: '400',
    color: '#888',
  },
  projectedCtx: {
    fontSize: 10,
    color: '#aaa',
    marginTop: 1,
    textAlign: 'right',
  },
  // ── Active effects collapsible ────────────────────────────────────────────
  activeEffectsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#f5f5f5',
  },
  activeEffectsHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  activeEffectsNet: {
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'right',
  },
  activeEffectsChevron: {
    fontSize: 10,
    color: '#aaa',
    fontWeight: '600',
    marginLeft: 4,
  },
  activeEffectsBody: {
    backgroundColor: '#fafcff',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  activeEffectsInnerRow: {
    paddingLeft: 22,   // indent under the parent row
    backgroundColor: 'transparent',
    borderBottomColor: '#f0f4f8',
  },
  // ── Divider ─────────────────────────────────────────────────────────────────
  divider: {
    height: 1,
    backgroundColor: '#ececec',
  },
  // ── Correction row ───────────────────────────────────────────────────────────
  correctionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  correctionLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: '#999',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  correctionDose: {
    fontSize: 18,
    fontWeight: '800',
  },
  correctionType: {
    fontSize: 13,
    fontWeight: '500',
    color: '#555',
  },
  formulaToggle: {
    fontSize: 12,
    fontWeight: '600',
    paddingLeft: 10,
  },
  formulaBody: {
    backgroundColor: '#fafafa',
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  formulaText: {
    fontSize: 12,
    color: '#666',
    fontFamily: 'monospace',
    lineHeight: 18,
  },
  // ── Caution ─────────────────────────────────────────────────────────────────
  cautionRow: {
    backgroundColor: '#fff8e1',
    borderTopWidth: 1,
    borderTopColor: '#ffe082',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  cautionText: {
    fontSize: 12,
    color: '#795548',
    lineHeight: 17,
  },
  // ── Disclaimer ───────────────────────────────────────────────────────────────
  disclaimer: {
    fontSize: 10,
    color: '#bbb',
    fontStyle: 'italic',
    marginTop: 6,
    marginBottom: 8,
    marginHorizontal: 14,
  },
  // ── Loading state ────────────────────────────────────────────────────────────
  loadingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surfaceVariant,
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
  },
  loadingText: {
    fontSize: 13,
    color: colors.text.secondary,
  },
});

// ─── Helpers ported from MealForm (insulin type + timing suggestion) ──────────

const safeToFixedLocal = (value: number | undefined | null, decimals = 1): string =>
  value !== undefined && value !== null && !isNaN(value) ? value.toFixed(decimals) : '0';

// ─── Main component ───────────────────────────────────────────────────────────

const UnifiedInsulinInput: React.FC<UnifiedInsulinInputProps> = ({
  onChange,
  suggestedDose,
  suggestedType,
  mealType,
  bloodSugar,
  initialDose = '',
  initialMedication = '',
  initialTimestamp,
  initialMode = 'now',
  initialNotes = '',
  standalone = false,
  disabled = false,
  showTimestampSelector = true,
  showSuggestion = true,
  showNotes = true,
  absorptionType,
  isMixedMeal = false,
  iobSurplusWarning,
  activeEffectsWarning,
  liveActiveEffects,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<string>('rapid');
  const [selectedInsulin, setSelectedInsulin] = useState<string>(initialMedication || suggestedType || '');
  const [dose, setDose] = useState(initialDose || suggestedDose?.toString() || '');
  const [notes, setNotes] = useState(initialNotes);
  const [timestampUTC, setTimestampUTC] = useState<string>(
    initialTimestamp ? new Date(initialTimestamp).toISOString() : new Date().toISOString()
  );
  const [timestampMode, setTimestampMode] = useState<TimeMode>(initialMode);
  const [error, setError] = useState<string | null>(null);

  // ── Patient constants (always needed) ────────────────────────────────────
  const { constants, isLoading: constantsLoading, hasLoadedFromAPI } = usePatientConstants();

  // ── useActiveEffects: used only for the preset-mode net-effect BG estimate
  // (mirrors MealForm's netEffectEstimatedBG / netEffectBaselineMode).
  // autoRefresh only when standalone to avoid redundant fetches when embedded.
  const {
    estimatedBG:  netEffectEstimatedBG,
    baselineMode: netEffectBaselineMode,
  } = useActiveEffects({ autoRefresh: standalone, refreshInterval: 60_000, windowHours: 24, skipIobCutoff: false });

  // ── Full active-effects state (mirrors MealForm) ──────────────────────────
  const [activeEffects, setActiveEffects]   = useState<ActiveEffectsFullResult | null>(null);
  const [activityPD, setActivityPD]         = useState<ActivityPDResult | null>(null);
  const [estimatedBGState, setEstimatedBGState] = useState<{
    value: number;
    confidence: string;
    minutesSinceReading: number;
    source: 'reading' | 'stale_reading' | 'target_fallback';
  } | null>(null);
  const [effectsLoading, setEffectsLoading] = useState(false);

  // ── Load active effects on mount (standalone only) ────────────────────────
  useEffect(() => {
    if (!standalone) return;
    let cancelled = false;

    const load = async () => {
      setEffectsLoading(true);
      try {
        const [effects, activityPDResult] = await Promise.all([
          getActiveEffectsFull(undefined, undefined, -new Date().getTimezoneOffset()),
          fetchStackedActivityEffectSafe(),
        ]);

        if (cancelled) return;
        setActiveEffects(effects);
        if (activityPDResult) setActivityPD(activityPDResult);

        // Update IOB in parent via store if needed
        const iob = effects?.totalIOB ?? effects?.iob?.totalIOB ?? effects?.iob?.total_active_insulin ?? 0;

        // ── Parse estimated BG (mirrors MealForm loadActiveInsulin) ──────────
        const bgEst       = effects?.bg_estimates;
        const resolvedMode = (constants as any)?.baseline_mode ?? 'dynamic';
        const tzOffset     = (constants as any)?.timezone_offset_minutes ?? 0;

        const computeReadingAnchoredBG = (): number | null => {
          if (bgEst?.reading_value == null) return null;
          const totalNetNow =
            (bgEst.cumulative_net_baseline   ?? 0) +
            (bgEst.cumulative_activity_effect ?? 0);
          const totalNetAtReading = bgEst.cumulative_net_effect_at_reading ?? 0;
          return Math.max(40, bgEst.reading_value + (totalNetNow - totalNetAtReading));
        };

        if (resolvedMode === 'preset') {
          const readingAnchored = computeReadingAnchoredBG();
          if (readingAnchored != null) {
            const minSince = bgEst!.minutes_since_reading ?? 9999;
            setEstimatedBGState({ value: readingAnchored, confidence: 'estimated', minutesSinceReading: minSince, source: minSince <= 360 ? 'reading' : 'stale_reading' });
          } else {
            const localHour = ((new Date().getTime() + tzOffset * 60_000) / 3_600_000) % 24;
            const circadianValue = getCircadianBaseline(localHour, (constants as any)?.circadian_profile ?? undefined);
            const cumMealEffect    = effects?.cumulative?.cumulative_meal_effect    ?? 0;
            const cumInsulinEffect = effects?.cumulative?.cumulative_insulin_effect ?? 0;
            setEstimatedBGState({ value: Math.max(40, circadianValue + cumMealEffect + cumInsulinEffect), confidence: 'circadian', minutesSinceReading: 0, source: 'target_fallback' });
          }
        } else {
          const readingAnchored = computeReadingAnchoredBG();
          if (readingAnchored != null) {
            const minSince = bgEst!.minutes_since_reading ?? 9999;
            setEstimatedBGState({ value: readingAnchored, confidence: 'estimated', minutesSinceReading: minSince, source: minSince <= 360 ? 'reading' : 'stale_reading' });
          } else {
            setEstimatedBGState(null);
          }
        }
      } catch (err) {
        console.error('[UnifiedInsulinInput] Failed to load active effects:', err);
        try {
          const result = await getActiveInsulin();
          // IOB-only fallback — estimatedBGState stays null
        } catch (e2) {
          console.error('[UnifiedInsulinInput] Failed to load active insulin:', e2);
        }
      } finally {
        if (!cancelled) setEffectsLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  // Re-run when constants load so the circadian fallback uses real patient values
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standalone, hasLoadedFromAPI]);

  // ── Derive CorrectionSuggestion using MealForm's full pipeline ───────────
  //
  // Key differences from the old buildSuggestion approach:
  //   • Uses calculateInsulinDose() with carbs/protein/fat = 0 (correction-only)
  //   • Applies activitySensitivityMultiplier (÷ effectiveCF) from activityPD
  //   • Applies activityOnBoard (pending BG drop, subtracted like IOB)
  //   • Applies cumulativeActivityEffect to non-actual BG estimates
  //   • Full reading-anchored BG formula (bank-balance) — same as MealForm
  //   • Guards double-counting of cumulativeActivityEffect (bgSourceAlreadyHasActivity)
  //   • No meal base insulin: baseInsulin = 0/ICR = 0u, only correctionInsulin matters
  const suggestion = useMemo<CorrectionSuggestion | null>(() => {
    if (!standalone) return null;

    const targetBG         = (constants as any)?.target_glucose    ?? 100;
    const correctionFactor = (constants as any)?.correction_factor ?? 40;
    // Hoisted here so resolveLiveEffects can use it as the carb-factor fallback
    // for pendingMealRise when the stale API snapshot doesn't carry the field.
    const carbBgFactor = (constants as any)?.carb_to_bg_factor ?? 4;

    // ── Resolve active effects (live AED > stale API snapshot) ───────────
    const r = resolveLiveEffects(liveActiveEffects, activeEffects, activityPD, carbBgFactor);

    const activeInsulinValue       = r.activeInsulinUnits;
    const activeMealCarbs          = r.activeMealCarbs;
    const pendingMealRise          = r.pendingMealRise;
    const pendingInsulinReduction  = r.pendingInsulinReduction;
    let   effectiveSensitivityMult = r.sensitivityMultiplier;
    let   aobValue                 = r.activityOnBoard;

    // Cumulative / absorbed fields: stay on the API snapshot — they feed the
    // breakdown card detail only and are not the source of the panel discrepancy.
    const cumulativeMealEffect    = activeEffects?.cumulative?.cumulative_meal_effect    ?? (activeEffects as any)?.cumulative_meal_effect    ?? 0;
    const cumulativeInsulinEffect = activeEffects?.cumulative?.cumulative_insulin_effect ?? (activeEffects as any)?.cumulative_insulin_effect ?? 0;
    const cumulativeNetBaseline   = activeEffects?.cumulative?.cumulative_net_baseline   ?? (activeEffects as any)?.cumulative_net_baseline   ?? 0;
    const bgEst        = activeEffects?.bg_estimates;
    const corrFactor   = (constants as any)?.correction_factor ?? 40;
    // carbBgFactor already declared above — used by both resolveLiveEffects and absorbedCarbs
    const absorbedCarbs   = bgEst ? (bgEst.cumulative_meal_effect_at_reading   / carbBgFactor) : 0;
    const absorbedInsulin = bgEst ? (Math.abs(bgEst.cumulative_insulin_effect_at_reading) / corrFactor) : 0;

    const cumulativeActivityEffect = activityPD?.cumulative_activity_effect ?? 0;

    // ── Smart BG selection (mirrors MealForm performLocalCalculation) ────────
    let smartBG            = 0;
    let bgSource           = 'unknown';
    let bgConfidence       = 'unknown';
    let minSinceReading    = 0;
    let usedNetEffectEstimate = false;

    const shouldUseNetEffectEstimate =
      netEffectBaselineMode === 'preset' && netEffectEstimatedBG != null;

    // Case 0: live AED estimate — same number the patient sees on screen.
    // Only fires when liveActiveEffects is present; the stale API path runs below.
    if (r.isLive) {
      smartBG               = r.estimatedBG!;
      bgSource              = 'estimated';
      bgConfidence          = r.minutesSinceReading > 360 ? 'very_low' : 'estimated';
      minSinceReading       = r.minutesSinceReading;
      usedNetEffectEstimate = true;
      if (!r.readingTimestamp) {
        bgConfidence = 'circadian_preset';
      } else if (r.minutesSinceReading > 360) {
        // stale reading — bgConfidence already set to very_low above
      }
    } else if (shouldUseNetEffectEstimate) {
      smartBG               = netEffectEstimatedBG!;
      bgSource              = 'estimated';
      usedNetEffectEstimate = true;
      if (estimatedBGState !== null && estimatedBGState.confidence !== 'circadian') {
        bgConfidence    = estimatedBGState.minutesSinceReading <= 360 ? 'estimated' : 'very_low';
        minSinceReading = estimatedBGState.minutesSinceReading;
      } else {
        bgConfidence = 'circadian_preset';
      }
    } else if (estimatedBGState !== null) {
      smartBG         = estimatedBGState.value;
      bgSource        = 'estimated';
      bgConfidence    = estimatedBGState.confidence === 'circadian'
        ? 'circadian_preset'
        : estimatedBGState.minutesSinceReading <= 360
          ? (estimatedBGState.confidence || 'medium')
          : 'very_low';
      minSinceReading = estimatedBGState.minutesSinceReading;
    } else {
      // Target fallback
      const targetGlucose    = (constants as any)?.target_glucose ?? 100;
      const cumMealEffect    = activeEffects?.cumulative?.cumulative_meal_effect    ?? (activeEffects as any)?.cumulative_meal_effect ?? 0;
      const cumInsulinEffect = activeEffects?.cumulative?.cumulative_insulin_effect ?? (activeEffects as any)?.cumulative_insulin_effect ?? 0;
      const computedFallback = targetGlucose + cumMealEffect + cumInsulinEffect;
      if (cumMealEffect !== 0 || cumInsulinEffect !== 0) {
        smartBG      = Math.max(40, computedFallback);
        bgSource     = 'estimated';
        bgConfidence = 'very_low';
      } else {
        smartBG      = targetGlucose;
        bgSource     = 'target_fallback';
        bgConfidence = 'very_low';
      }
    }

    // ── Guard: avoid double-applying cumulativeActivityEffect ────────────
    const bgSourceAlreadyHasActivity =
      r.isLive ||
      bgSource === 'actual' ||
      usedNetEffectEstimate ||
      (bgSource === 'estimated' &&
       estimatedBGState !== null &&
       estimatedBGState.confidence !== 'circadian');
    const effectiveCumulativeActivityEffect = bgSourceAlreadyHasActivity ? 0 : cumulativeActivityEffect;

    // ── Run correction-only dose calculation ──────────────────────────────
    // carbs/protein/fat = 0 → baseInsulin = 0; only correctionInsulin is non-zero.
    if (!constants || smartBG <= 0) {
      // Not enough data yet — show "no reading" state
      const bgSrc: CorrectionSuggestion['bgSource'] = undefined;
      return buildSuggestion(null, null, activeInsulinValue, pendingInsulinReduction, pendingMealRise, activeMealCarbs, targetBG, correctionFactor, bgSrc);
    }

    let doseResult;
    try {
      doseResult = calculateInsulinDose({
        carbs:   0,
        protein: 0,
        fat:     0,
        bloodSugar:           smartBG,
        bloodSugarSource:     bgSource,
        bloodSugarConfidence: bgConfidence,
        minutesSinceReading:  minSinceReading,
        activities:           [],   // no manual activities in standalone insulin log
        patientConstants:     constants as any,
        activeInsulinValue,
        activeMealCarbs,
        cumulativeMealEffect,
        cumulativeInsulinEffect,
        cumulativeNetBaseline,
        absorbedCarbs,
        absorbedInsulin,
        pendingMealRise,
        pendingInsulinReduction,
        activitySensitivityMultiplier: effectiveSensitivityMult,
        activityOnBoard:               aobValue,
        cumulativeActivityEffect:      effectiveCumulativeActivityEffect,
      });
    } catch (err) {
      console.error('[UnifiedInsulinInput] calculateInsulinDose error:', err);
      return null;
    }

    const bd = doseResult.breakdown;

    // ── Map calculateInsulinDose output → CorrectionSuggestion ───────────
    // correctionInsulin already nets out IOB/MOB/AOB adjustments in postActiveTotal.
    const corrDose     = bd.correctionInsulin;   // signed: negative = over-insulinised
    // When live, use AED's pre-netted projection (includes AOB, correct sensitivity).
    const projectedBG  = r.isLive
      ? r.projectedBG!
      : smartBG + (pendingMealRise - pendingInsulinReduction);

    const bgSrc: CorrectionSuggestion['bgSource'] =
      bgSource === 'actual'    ? 'reading'   :
      bgConfidence === 'circadian_preset' ? 'circadian' :
      estimatedBGState !== null ? 'reading'  : undefined;

    console.log('[UnifiedInsulinInput] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('[UnifiedInsulinInput] smartBG             :', smartBG.toFixed(1), `(${bgSource})`);
    console.log('[UnifiedInsulinInput] projectedBG         :', projectedBG.toFixed(1));
    console.log('[UnifiedInsulinInput] correctionInsulin   :', corrDose.toFixed(2), 'u');
    console.log('[UnifiedInsulinInput] effectiveCF         :', bd.effectiveCF.toFixed(1));
    console.log('[UnifiedInsulinInput] sensitivityMult     :', effectiveSensitivityMult.toFixed(3));
    console.log('[UnifiedInsulinInput] AOB                 :', aobValue.toFixed(1), 'mg/dL');
    console.log('[UnifiedInsulinInput] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    return buildSuggestion(
      smartBG,
      projectedBG,
      activeInsulinValue,
      pendingInsulinReduction,
      pendingMealRise,
      activeMealCarbs,
      targetBG,
      bd.effectiveCF,   // use sensitivity-adjusted CF for display formula
      bgSrc,
    );
  }, [
    standalone, constants, hasLoadedFromAPI,
    netEffectEstimatedBG, netEffectBaselineMode,
    estimatedBGState, activeEffects, activityPD,
    liveActiveEffects,
  ]);

  const isInitialMount = useRef(true);

  const numericDose = parseFloat(dose);
  const isValidDose = !isNaN(numericDose) && numericDose >= INSULIN_LIMITS.MIN && numericDose <= INSULIN_LIMITS.MAX;

  // Get all insulin profiles from shared constants
  const ALL_INSULIN_PROFILES_ARRAY = useMemo(() => {
    const medications = DEFAULT_PATIENT_CONSTANTS.medication_factors;
    return Object.entries(medications).map(([id, profile]) => ({
      id,
      ...profile,
      name: profile.brand_names?.[0] || id.replace(/_/g, ' '),
    })) as InsulinProfileWithId[];
  }, []);

  // Get insulin profiles by category
  const getInsulinsByCategory = (category: string): InsulinProfileWithId[] => {
    return ALL_INSULIN_PROFILES_ARRAY.filter((profile) => {
      switch (category) {
        case 'rapid':
          return profile.type === 'rapid_acting' || profile.type === 'ultra_rapid_acting';
        case 'short':
          return profile.type === 'short_acting';
        case 'intermediate':
          return profile.type === 'intermediate_acting';
        case 'long':
          return profile.type === 'long_acting' || profile.type === 'ultra_long_acting';
        default:
          return false;
      }
    });
  };

  const insulinsInCategory = getInsulinsByCategory(selectedCategory);

  // Set initial category based on selected insulin
  useEffect(() => {
    if (selectedInsulin) {
      const profile = ALL_INSULIN_PROFILES_ARRAY.find(p => p.id === selectedInsulin);
      if (profile) {
        const categoryMap: Record<string, string> = {
          'rapid_acting': 'rapid',
          'short_acting': 'short',
          'intermediate_acting': 'intermediate',
          'long_acting': 'long',
        };
        const cat = categoryMap[profile.type];
        if (cat) setSelectedCategory(cat);
      }
    }
  }, []);

  // Notify parent of changes (debounced)
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    if (selectedInsulin && isValidDose) {
      const timeoutId = setTimeout(() => {
        console.log('[UnifiedInsulinInput] Triggering callback with UTC:', timestampUTC);
        onChange({
          medication: selectedInsulin,
          dose: numericDose,
          timestamp: timestampUTC,
          timestampMode,
          notes,
          mealType,
          bloodSugar,
        });
      }, 300);

      return () => clearTimeout(timeoutId);
    }
  }, [selectedInsulin, numericDose, timestampUTC, notes]);

  const handleDoseChange = (text: string) => {
    setDose(text);
    setError(null);

    const value = parseFloat(text);
    if (text && !isNaN(value)) {
      const validation = validateInsulinDose(value);
      if (!validation.isValid) {
        setError(validation.error || 'Invalid dose');
      }
    }
  };

  const handleTimeChange = (utcIsoString: string) => {
    console.log('[UnifiedInsulinInput] Time changed to:', utcIsoString);
    setTimestampUTC(utcIsoString);
  };

  const handleModeChange = (newMode: TimeMode) => {
    setTimestampMode(newMode);
  };

  return (
    <View style={[styles.container, !standalone && styles.containerEmbedded]}>
      {standalone && <Text style={styles.title}>Insulin Dose</Text>}

      {/* ── Correction suggestion card (standalone only) ──────────────────── */}
      {standalone && (
        effectsLoading ? (
          <View style={suggStyles.loadingCard}>
            <ActivityIndicator color={colors.primary} size="small" />
            <Text style={suggStyles.loadingText}>Checking active effects…</Text>
          </View>
        ) : suggestion ? (
          <SuggestionCard suggestion={suggestion} />
        ) : null
      )}

      {/* ── Suggested Insulin Dose Card (mirrors MealForm's compact 3-line layout) ── */}
      {showSuggestion && suggestedDose != null && (
        <View style={styles.doseCard}>

          {/* Warning banner — active-effects / stale BG */}
          {!!activeEffectsWarning && (
            <View style={styles.doseWarningBanner}>
              <Text style={styles.doseWarningText}>⚠️ {activeEffectsWarning}</Text>
            </View>
          )}

          {/* IOB Surplus — active insulin already covers this meal */}
          {iobSurplusWarning && (
            <View style={styles.iobSurplusBanner}>
              <View style={styles.iobSurplusLeft}>
                <Text style={styles.iobSurplusTitle}>⚠️ IOB Covers This Meal</Text>
                <Text style={styles.iobSurplusBody}>
                  {iobSurplusWarning.surplusUnits.toFixed(1)}u IOB — no dose needed, injecting risks a low.
                </Text>
                <Text style={styles.iobSurplusCarbNote}>
                  Eat glucose tablets, juice, or fruit to offset.
                </Text>
              </View>
              <View style={styles.iobSurplusRight}>
                <View style={styles.iobSurplusStatPill}>
                  <Text style={styles.iobSurplusStatLabel}>Surplus</Text>
                  <Text style={styles.iobSurplusStatValue}>{iobSurplusWarning.surplusUnits.toFixed(1)}u</Text>
                </View>
                <View style={[styles.iobSurplusStatPill, styles.iobSurplusStatPillCarb]}>
                  <Text style={[styles.iobSurplusStatLabel, styles.iobSurplusStatLabelCarb]}>Eat</Text>
                  <Text style={[styles.iobSurplusStatValue, styles.iobSurplusStatValueCarb]}>{iobSurplusWarning.extraCarbsNeeded}g</Text>
                </View>
              </View>
            </View>
          )}

          {/* Line 1 — primary dose row */}
          <View style={styles.dosePrimaryRow}>
            <View style={styles.doseLabelStack}>
              <Text style={styles.dosePrimaryLabel}>Suggested Insulin Dose</Text>
              {absorptionType && (
                <Text style={styles.doseNutritionPill}>
                  {absorptionType.replace(/_/g, ' ')}
                </Text>
              )}
            </View>
            <Text style={styles.dosePrimaryValue}>{safeToFixedLocal(suggestedDose, 1)} units</Text>
          </View>

          {/* Lines 2 + 3+4 — insulin type & timing — hidden when IOB surplus */}
          {!iobSurplusWarning && absorptionType && (() => {
            const insulinConfig = ABSORPTION_TO_INSULIN_CONFIG[absorptionType];
            const isSlowMeal   = absorptionType === 'slow' || absorptionType === 'very_slow';
            const mealLabel    = mealType
              ? mealType.charAt(0).toUpperCase() + mealType.slice(1)
              : 'Meal';

            const guidelineMap = (constants as any)?.insulin_timing_guidelines ?? {};
            const sharedGuidelines = SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.insulin_timing_guidelines;
            const defaultMins: Record<string, number> = Object.fromEntries(
              Object.entries(sharedGuidelines).map(([k, v]) => [k, (v as any).timing_minutes])
            );
            const CLINICAL_MINIMUMS: Record<string, number> = { slow: 20, very_slow: 30 };
            const storedMins = guidelineMap[absorptionType]?.timing_minutes ?? defaultMins[absorptionType] ?? 10;
            const mins = CLINICAL_MINIMUMS[absorptionType]
              ? Math.max(storedMins, CLINICAL_MINIMUMS[absorptionType])
              : storedMins;

            const totalDose = suggestedDose;

            const timingBlock = (() => {
              // ── Mixed meal (pizza-effect) — dual split strategy ─────────────
              if (isMixedMeal) {
                const firstDose  = Math.round(totalDose * 0.6 * 10) / 10;
                const secondDose = Math.round((totalDose - firstDose) * 10) / 10;
                return (
                  <View style={{ marginHorizontal: 12, marginBottom: 8, marginTop: 2, borderRadius: 8, borderWidth: 1, borderColor: '#e0e0e0', overflow: 'hidden' }}>
                    <View style={{ backgroundColor: '#fff8f0', paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#e0e0e0' }}>
                      <Text style={{ fontSize: 11, fontWeight: '700', color: '#bf360c' }}>
                        🍕 Mixed meal — biphasic glucose response
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#f0f0f0' }}>
                      <View style={{ flex: 1, paddingHorizontal: 10, paddingVertical: 8, borderRightWidth: 1, borderRightColor: '#f0d0b8' }}>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: '#1565c0', marginBottom: 3 }}>
                          A · NovoLog — dual split (recommended)
                        </Text>
                        <Text style={{ fontSize: 12, color: '#333' }}>
                          <Text style={{ fontWeight: '700' }}>{safeToFixedLocal(firstDose, 1)}u</Text>
                          {' (60%)  5 min before eating'}
                        </Text>
                        <Text style={{ fontSize: 12, color: '#333' }}>
                          <Text style={{ fontWeight: '700' }}>{safeToFixedLocal(secondDose, 1)}u</Text>
                          {' (40%)  at +2.5 h after meal start'}
                        </Text>
                        <Text style={{ fontSize: 10, color: '#888', marginTop: 3 }}>
                          1st covers fast-carb peak (~60–90 min) · 2nd covers fat-delayed peak (~3–5 h)
                        </Text>
                      </View>
                      <View style={{ flex: 1, paddingHorizontal: 10, paddingVertical: 8 }}>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: '#2e7d32', marginBottom: 3 }}>
                          B · Regular insulin (Humulin R / Novolin R)
                        </Text>
                        <Text style={{ fontSize: 12, color: '#333' }}>
                          <Text style={{ fontWeight: '700' }}>{safeToFixedLocal(totalDose, 1)}u</Text>
                          {' at meal time — no wait, no split'}
                        </Text>
                      </View>
                    </View>
                    <View style={{ paddingHorizontal: 10, paddingVertical: 8 }}>
                      <Text style={{ fontSize: 11, color: '#bf360c', fontStyle: 'italic' }}>
                        ⏱ Check BG at +2 h and +5–6 h — late hyperglycaemia (3–6 h) is the primary risk.
                      </Text>
                    </View>
                  </View>
                );
              }

              // ── Fast / medium / very_fast — plain single timing line ────────
              if (!isSlowMeal) {
                const timingText = mins === 0
                  ? 'Inject your bolus insulin, then eat immediately'
                  : `Inject your bolus insulin, then eat your ${mealLabel} ${mins} min later`;
                return (
                  <View style={styles.doseMetaRow}>
                    <Text style={styles.doseMetaLabel}>⏰ Timing: </Text>
                    <Text style={styles.doseMetaValue}>{timingText}</Text>
                  </View>
                );
              }

              // ── Slow / Very slow — options A, B, C ──────────────────────────
              const firstDose  = Math.round(totalDose * 0.5 * 10) / 10;
              const secondDose = Math.round((totalDose - firstDose) * 10) / 10;
              const secondInjectFromMealStart = 90 - mins;
              const afterMealMins = absorptionType === 'very_slow' ? 30 : 10;
              const tailMins      = absorptionType === 'very_slow' ? 180 : 70;
              const tailHours     = (tailMins / 60).toFixed(1);

              return (
                <View style={{ marginHorizontal: 12, marginBottom: 8, marginTop: 2, borderRadius: 8, borderWidth: 1, borderColor: '#e0e0e0', overflow: 'hidden' }}>
                  <View style={{
                    backgroundColor: absorptionType === 'very_slow' ? '#fff3e0' : '#fff8f0',
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderBottomWidth: 1,
                    borderBottomColor: '#e0e0e0',
                  }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: absorptionType === 'very_slow' ? '#e65100' : '#ef6c00' }}>
                      ⏰ {absorptionType === 'very_slow' ? 'Very slow' : 'Slow'} meal — choose one option
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row' }}>
                    {/* Left column: A + C */}
                    <View style={{ flex: 1, borderRightWidth: 1, borderRightColor: '#e0e0e0' }}>
                      <View style={{ paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' }}>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: '#1565c0', marginBottom: 3 }}>
                          A · NovoLog — split dose
                        </Text>
                        <Text style={{ fontSize: 12, color: '#333' }}>
                          <Text style={{ fontWeight: '700' }}>{safeToFixedLocal(firstDose, 1)}u</Text>{` now  →  eat in ${mins} min`}
                        </Text>
                        <Text style={{ fontSize: 12, color: '#333' }}>
                          <Text style={{ fontWeight: '700' }}>{safeToFixedLocal(secondDose, 1)}u</Text>{` at +90 min`}{secondInjectFromMealStart > 0 ? ` (${secondInjectFromMealStart} min after eating)` : ''}
                        </Text>
                      </View>
                      <View style={{ paddingHorizontal: 10, paddingVertical: 8 }}>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: '#6a1b9a', marginBottom: 3 }}>
                          C · NovoLog — single dose
                        </Text>
                        <Text style={{ fontSize: 12, color: '#333' }}>
                          {'Start eating  →  inject '}
                          <Text style={{ fontWeight: '700' }}>{safeToFixedLocal(totalDose, 1)}u</Text>
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
                        <Text style={{ fontWeight: '700' }}>{safeToFixedLocal(totalDose, 1)}u</Text>{' at meal time — no wait, no split'}
                      </Text>
                    </View>
                  </View>
                </View>
              );
            })();

            return (
              <React.Fragment>
                {/* Line 2: insulin type */}
                {insulinConfig && (
                  <View style={styles.doseMetaRow}>
                    <Text style={styles.doseMetaLabel}>💉 Bolus insulin: </Text>
                    <Text style={[styles.doseMetaValue, { color: insulinConfig.color }]}>
                      {insulinConfig.label}
                    </Text>
                  </View>
                )}
                {/* Line 3+4: timing / dosing strategy */}
                {timingBlock}
              </React.Fragment>
            );
          })()}

        </View>
      )}

      {/* Insulin Category Selector */}
      <Text style={styles.label}>Insulin Type</Text>
      <View style={styles.categoryTabs}>
        {INSULIN_CATEGORIES.map((category) => (
          <TouchableOpacity
            key={category.id}
            style={[
              styles.categoryTab,
              selectedCategory === category.id && {
                backgroundColor: category.color,
                borderColor: category.color,
              },
            ]}
            onPress={() => {
              setSelectedCategory(category.id);
              setSelectedInsulin('');
            }}
            disabled={disabled}
          >
            <Text
              style={[
                styles.categoryTabText,
                selectedCategory === category.id && styles.categoryTabTextActive,
              ]}
            >
              {category.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Insulin Selector */}
      <ScrollView style={styles.insulinList} nestedScrollEnabled>
        {insulinsInCategory.map((insulin) => (
          <TouchableOpacity
            key={insulin.id}
            style={[
              styles.insulinOption,
              selectedInsulin === insulin.id && styles.insulinOptionSelected,
            ]}
            onPress={() => setSelectedInsulin(insulin.id)}
            disabled={disabled}
          >
            <View style={styles.insulinInfo}>
              <Text
                style={[
                  styles.insulinName,
                  selectedInsulin === insulin.id && styles.insulinNameSelected,
                ]}
              >
                {insulin.name || insulin.id.replace(/_/g, ' ')}
              </Text>
              <Text style={styles.insulinDetails}>
                Onset: {insulin.onset_hours}h | Peak: {insulin.peak_hours ? `${insulin.peak_hours}h` : 'N/A'} | Duration: {insulin.duration_hours}h
              </Text>
              {insulin.brand_names && insulin.brand_names.length > 0 && (
                <Text style={styles.insulinBrands}>({insulin.brand_names.join(', ')})</Text>
              )}
            </View>
            {selectedInsulin === insulin.id && (
              <View style={styles.checkmark}>
                <Text style={styles.checkmarkText}>✓</Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Dose Input */}
      <Text style={[styles.label, styles.labelSpacing]}>Dose (units)</Text>
      <TextInput
        style={[styles.input, error && styles.inputError]}
        value={dose}
        onChangeText={handleDoseChange}
        placeholder={suggestedDose ? `Suggested: ${suggestedDose.toFixed(1)}` : 'Enter dose'}
        placeholderTextColor={colors.text.secondary}
        keyboardType="decimal-pad"
        editable={!disabled}
      />
      {error && <Text style={styles.errorText}>{error}</Text>}
      <Text style={styles.helperText}>
        Range: {INSULIN_LIMITS.MIN} - {INSULIN_LIMITS.MAX} units
      </Text>

      {/* Unified Time Picker */}
      {showTimestampSelector && (
        <UnifiedTimePicker
          value={timestampUTC}
          onChange={handleTimeChange}
          mode={timestampMode}
          onModeChange={handleModeChange}
          disabled={disabled}
          label="Administration Time"
          displayFormat="datetime"
        />
      )}

      {/* Notes — hidden when embedded (e.g. in MealForm) */}
      {showNotes && (
        <>
          <Text style={[styles.label, styles.labelSpacing]}>Notes (optional)</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Add any notes..."
            placeholderTextColor={colors.text.secondary}
            multiline
            numberOfLines={2}
            textAlignVertical="top"
            editable={!disabled}
          />
        </>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  containerEmbedded: {
    backgroundColor: 'transparent',
    borderRadius: 0,
    padding: 0,
    marginBottom: 0,
  },
  title: {
    ...typography.h3,
    color: colors.text.primary,
    marginBottom: spacing.md,
  },
  // ── Suggested dose card (mirrors MealForm compact layout) ──────────────────
  doseCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    marginBottom: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e3f2fd',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
  },
  doseWarningBanner: {
    backgroundColor: '#fff8e1',
    borderBottomWidth: 1,
    borderBottomColor: '#ffe082',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  doseWarningText: {
    fontSize: 12,
    color: '#795548',
    lineHeight: 17,
  },
  iobSurplusBanner: {
    flexDirection: 'row' as const,
    alignItems: 'flex-start' as const,
    backgroundColor: '#fbe9e7',
    borderBottomWidth: 1,
    borderBottomColor: '#ffccbc',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  iobSurplusLeft: {
    flex: 1,
    gap: 3,
  },
  iobSurplusRight: {
    gap: 5,
    alignItems: 'flex-end' as const,
  },
  iobSurplusTitle: {
    fontSize: 12,
    fontWeight: '700' as const,
    color: '#bf360c',
  },
  iobSurplusBody: {
    fontSize: 11,
    color: '#6d4c41',
    lineHeight: 15,
  },
  iobSurplusCarbNote: {
    fontSize: 10,
    color: '#6d4c41',
    fontStyle: 'italic' as const,
    lineHeight: 13,
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
    fontWeight: '600' as const,
    color: '#bf360c',
  },
  iobSurplusStatLabelCarb: {
    color: '#e65100',
  },
  iobSurplusStatValue: {
    fontSize: 13,
    fontWeight: '800' as const,
    color: '#bf360c',
  },
  iobSurplusStatValueCarb: {
    color: '#bf360c',
  },
  dosePrimaryRow: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
  },
  doseLabelStack: {
    flex: 1,
    paddingRight: 8,
  },
  dosePrimaryLabel: {
    fontSize: 11,
    fontWeight: '700' as const,
    color: '#1565c0',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.3,
  },
  dosePrimaryValue: {
    fontSize: 26,
    fontWeight: '800' as const,
    color: '#1b5e20',
  },
  doseNutritionPill: {
    fontSize: 11,
    color: '#666',
    marginTop: 3,
    lineHeight: 16,
  },
  doseMetaRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: 12,
    paddingVertical: 3,
  },
  doseMetaLabel: {
    fontSize: 12,
    color: '#666',
  },
  doseMetaValue: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: '#333',
    flexShrink: 1,
  },
  label: {
    ...typography.caption,
    color: colors.text.primary,
    fontWeight: '500',
    marginBottom: spacing.xs,
  },
  labelSpacing: {
    marginTop: spacing.md,
  },
  categoryTabs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  categoryTab: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  categoryTabText: {
    ...typography.small,
    color: colors.text.secondary,
  },
  categoryTabTextActive: {
    color: colors.text.inverse,
    fontWeight: '600',
  },
  insulinList: {
    maxHeight: 200,
    marginBottom: spacing.md,
  },
  insulinOption: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    marginBottom: spacing.xs,
    backgroundColor: colors.surface,
  },
  insulinOptionSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary + '10',
  },
  insulinInfo: {
    flex: 1,
  },
  insulinName: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '500',
  },
  insulinNameSelected: {
    color: colors.primary,
  },
  insulinDetails: {
    ...typography.small,
    color: colors.text.secondary,
    marginTop: 2,
  },
  insulinBrands: {
    ...typography.caption,
    color: colors.text.secondary,
    marginTop: 2,
    fontStyle: 'italic',
  },
  checkmark: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkmarkText: {
    color: colors.text.inverse,
    fontWeight: 'bold',
  },
  input: {
    backgroundColor: colors.surfaceVariant,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    fontSize: 16,
    color: colors.text.primary,
  },
  inputError: {
    borderColor: colors.danger,
  },
  textArea: {
    height: 80,
  },
  errorText: {
    ...typography.caption,
    color: colors.danger,
    marginTop: spacing.xs,
  },
  helperText: {
    ...typography.caption,
    color: colors.text.secondary,
    marginTop: spacing.xs,
  },
});

export default UnifiedInsulinInput;