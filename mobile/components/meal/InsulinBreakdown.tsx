// mobile/components/meal/InsulinBreakdown.tsx - COMPLETE FIXED VERSION
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SelectedFoodDetails {
  absorption_type?: string;
  [key: string]: any;
}

interface SelectedFood {
  id: string;
  name: string;
  details?: SelectedFoodDetails;
  [key: string]: any;
}

interface InsulinBreakdownProps {
  result: any;
  activeInsulin: number;
  isCalculating: boolean;
  /** Pass selected foods so the component can suggest an insulin type */
  selectedFoods?: SelectedFood[];
}

// ─── Insulin type suggestion engine ──────────────────────────────────────────

type AbsorptionType = 'very_fast' | 'fast' | 'medium' | 'mixed' | 'slow' | 'very_slow';

const ABSORPTION_PRIORITY: Record<string, number> = {
  very_slow: 5, slow: 4, medium: 3, fast: 2, very_fast: 1,
};

interface InsulinSuggestion {
  type: string;
  examples: string;
  rationale: string;
  color: string;
  icon: string;
}

const INSULIN_SUGGESTIONS: Record<AbsorptionType, InsulinSuggestion> = {
  very_fast: {
    type: 'Ultra-Rapid Analog',
    examples: 'Fiasp (faster aspart), Lyumjev (ultra-rapid lispro)',
    rationale:
      'Very fast-absorbing foods (glucose tablets, simple sugars) spike blood sugar rapidly. ' +
      'Ultra-rapid analogs match this peak best and reduce post-meal hypoglycemia risk.',
    color: '#d32f2f',
    icon: '⚡',
  },
  fast: {
    type: 'Rapid-Acting Analog',
    examples: 'NovoRapid, Humalog, Apidra',
    rationale:
      'Fast-absorbing foods (white bread, juice, refined carbs) are well-covered by standard ' +
      'rapid-acting analogs taken 5–10 minutes before eating.',
    color: '#e64a19',
    icon: '🔺',
  },
  medium: {
    type: 'Rapid-Acting Analog',
    examples: 'NovoRapid, Humalog, Apidra',
    rationale:
      'Mixed meals and whole grains absorb at a moderate pace. Rapid-acting analogs taken ' +
      '10–15 minutes before the meal align well with the absorption curve.',
    color: '#388e3c',
    icon: '✅',
  },
  mixed: {
    type: 'NovoLog Dual Split or Regular Insulin',
    examples: 'NovoLog / NovoRapid (dual split)  ·  Humulin R / Novolin R (single dose)',
    rationale:
      'This meal combines fast-absorbing and slow/fat-heavy foods, creating a biphasic ' +
      'glucose response (pizza effect). A single rapid-acting bolus covers only one peak. ' +
      'Use a dual split — 60 % before eating, 40 % at +2.5 h — or switch to regular insulin ' +
      'whose longer action profile spans both rises in one injection. ' +
      'Check BG at +2 h and +5–6 h; late hyperglycaemia (3–6 h post-meal) is the primary risk.',
    color: '#f57c00',
    icon: '🍕',
  },
  slow: {
    type: 'Rapid-Acting Analog or Regular Insulin',
    examples: 'NovoRapid (taken early)  ·  Humulin R / Novolin R',
    rationale:
      'High-protein/fat and complex-carb meals absorb slowly. Taking a rapid-acting analog ' +
      '20–30 minutes early, or switching to regular insulin, better matches the delayed glucose rise.',
    color: '#1565c0',
    icon: '🕐',
  },
  very_slow: {
    type: 'Regular Insulin or Split Dose',
    examples: 'Humulin R / Novolin R  ·  or split rapid-acting bolus',
    rationale:
      'Very high-fat/fiber meals have a prolonged, flat absorption curve. A split bolus ' +
      '(50 % now, 50 % in 1–2 h) or regular insulin reduces early hypoglycemia risk.',
    color: '#6a1b9a',
    icon: '⏳',
  },
};

// ─── Mixed-meal detection ─────────────────────────────────────────────────────
const MIXED_SLOW_TYPES = new Set(['slow', 'very_slow']);
const MIXED_FAST_TYPES = new Set(['very_fast', 'fast', 'medium']);

function getDominantAbsorptionType(foods: SelectedFood[]): AbsorptionType {
  if (!foods || foods.length === 0) return 'medium';

  // Pizza-effect check: slow/very_slow + medium/fast/very_fast = mixed
  const hasSlow = foods.some(f => MIXED_SLOW_TYPES.has(f.details?.absorption_type ?? ''));
  const hasFast = foods.some(f => MIXED_FAST_TYPES.has(f.details?.absorption_type ?? ''));
  if (hasSlow && hasFast) return 'mixed';

  // Otherwise return the slowest absorption type present
  return foods
    .map((f) => (f.details?.absorption_type || 'medium') as AbsorptionType)
    .reduce(
      (slowest, current) =>
        (ABSORPTION_PRIORITY[current] || 3) > (ABSORPTION_PRIORITY[slowest] || 3)
          ? current
          : slowest,
      'medium' as AbsorptionType,
    );
}

const InsulinBreakdown: React.FC<InsulinBreakdownProps> = ({
  result,
  activeInsulin,
  isCalculating,
  selectedFoods = [],
}) => {
  const [showDetails, setShowDetails] = useState(false);

  const safeToFixed = (value: number | undefined | null, decimals: number = 1): string => {
    if (value === undefined || value === null || isNaN(value)) {
      return '0.0';
    }
    return value.toFixed(decimals);
  };

  if (isCalculating) {
    return (
      <View style={styles.container}>
        <Text style={styles.calculatingText}>Calculating insulin dose...</Text>
      </View>
    );
  }

  if (!result) return null;

  // Extract data from the correct structure.
  // calculateInsulinDose() returns { total, breakdown } with camelCase keys.
  // Support both the direct service result and legacy wrapped shapes.
  const calculations = result.calculations || result;
  const insulin = calculations.insulin || result;
  const breakdown = insulin.breakdown || result.breakdown || {};
  const nutrition = calculations.nutrition || {};

  // Suggested total
  const suggestedInsulin = result.total ?? insulin.total ?? 0;

  // Extract breakdown values — camelCase keys from insulinCalculationService
  const baseInsulin         = breakdown.baseInsulin        ?? 0;
  const absorptionFactor    = breakdown.absorptionFactor   ?? 1.0;
  const mealTimingFactor    = breakdown.mealTimingFactor   ?? 1.0;
  const activityCoefficient = breakdown.activityImpact     ?? 1.0;
  const adjustedInsulin     = breakdown.adjustedInsulin    ?? 0;
  const correctionInsulin   = breakdown.correctionInsulin  ?? 0;
  const preActiveTotal      = breakdown.preActiveTotal      ?? 0;
  const activeInsulinValue  = breakdown.activeInsulin      ?? activeInsulin;
  const postActiveTotal     = breakdown.postActiveTotal    ?? 0;
  const healthMultiplier    = breakdown.healthMultiplier   ?? 1.0;
  const iobSurplusWarning   = breakdown.iobSurplusWarning as { surplusUnits: number; extraCarbsNeeded: number } | undefined;

  // Carb equivalents
  const carbsActual      = breakdown.carbsActual      ?? 0;
  const proteinCarbEquiv = breakdown.proteinCarbEquiv ?? 0;
  const fatCarbEquiv     = breakdown.fatCarbEquiv     ?? 0;
  const totalCarbEquiv   = breakdown.totalCarbEquiv   ?? 0;

  // Check if adjustments were applied
  const hasAdjustments = absorptionFactor !== 1 || mealTimingFactor !== 1 || activityCoefficient !== 1;

  // Insulin type suggestion derived from the foods' dominant absorption type
  const dominantType = getDominantAbsorptionType(selectedFoods);
  const suggestion   = INSULIN_SUGGESTIONS[dominantType];

  return (
    <View style={styles.container}>
      {/* ── IOB Surplus Warning ─────────────────────────────────────────────── */}
      {iobSurplusWarning && (
        <View style={styles.iobWarningCard}>
          <Text style={styles.iobWarningTitle}>⚠️ Active Insulin Already Covers This Meal</Text>
          <Text style={styles.iobWarningBody}>
            Your current active insulin ({safeToFixed(activeInsulinValue, 1)}u) exceeds what this meal
            and correction require. No additional dose is needed — taking insulin now risks a low.
          </Text>
          <View style={styles.iobWarningRow}>
            <Text style={styles.iobWarningLabel}>Insulin surplus</Text>
            <Text style={styles.iobWarningValue}>
              {safeToFixed(iobSurplusWarning.surplusUnits, 1)} u
            </Text>
          </View>
          <View style={[styles.iobWarningRow, styles.iobWarningRowHighlight]}>
            <Text style={[styles.iobWarningLabel, styles.iobWarningLabelBold]}>
              Eat extra fast carbs to offset
            </Text>
            <Text style={[styles.iobWarningValue, styles.iobWarningCarbValue]}>
              {iobSurplusWarning.extraCarbsNeeded} g
            </Text>
          </View>
          <Text style={styles.iobWarningNote}>
            Choose fast-absorbing carbs (glucose tablets, juice, fruit) to absorb the excess
            insulin and keep your BG stable.
          </Text>
        </View>
      )}
      <View style={styles.mainCard}>
        <Text style={styles.label}>Suggested Insulin Dose</Text>
        <Text style={styles.value}>{safeToFixed(suggestedInsulin, 1)} units</Text>

        {/* Show nutritional summary if available */}
        {nutrition && (nutrition.carbs > 0 || nutrition.protein > 0 || nutrition.fat > 0) && (
          <View style={styles.nutritionSummary}>
            <Text style={styles.nutritionText}>
              {safeToFixed(nutrition.carbs, 0)}g carbs • {safeToFixed(nutrition.protein, 0)}g protein • {safeToFixed(nutrition.fat, 0)}g fat
            </Text>
          </View>
        )}
      </View>

      {/* ── Insulin Type Suggestion ─────────────────────────────────────────── */}
      <View style={[styles.suggestionCard, { borderLeftColor: suggestion.color }]}>
        <View style={styles.suggestionHeader}>
          <Text style={styles.suggestionIcon}>{suggestion.icon}</Text>
          <View style={styles.suggestionHeaderText}>
            <Text style={styles.suggestionLabel}>Recommended Insulin Type</Text>
            <Text style={[styles.suggestionType, { color: suggestion.color }]}>
              {suggestion.type}
            </Text>
          </View>
          <View style={[styles.absorptionBadge, { backgroundColor: suggestion.color + '18' }]}>
            <Text style={[styles.absorptionBadgeText, { color: suggestion.color }]}>
              {dominantType.replace(/_/g, ' ')}
            </Text>
          </View>
        </View>
        <Text style={styles.suggestionExamples}>
          <Text style={styles.suggestionExamplesLabel}>Examples: </Text>
          {suggestion.examples}
        </Text>
        <Text style={styles.suggestionRationale}>{suggestion.rationale}</Text>
        <Text style={styles.suggestionDisclaimer}>
          ⚠️ Always follow your doctor's prescription. This suggestion is informational only.
        </Text>
      </View>

      <TouchableOpacity
        style={styles.toggleButton}
        onPress={() => setShowDetails(!showDetails)}
      >
        <Text style={styles.toggleText}>
          {showDetails ? 'Hide' : 'Show'} Calculation Details
        </Text>
      </TouchableOpacity>

      {showDetails && (
        <View style={styles.detailsContainer}>
          {/* Base Insulin Needs */}
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Base Insulin Needs</Text>
            <Text style={styles.sectionValue}>{safeToFixed(baseInsulin, 1)} units</Text>

            {totalCarbEquiv > 0 && (
              <View style={styles.subSection}>
                <View style={styles.subRow}>
                  <Text style={styles.subLabel}>Carbohydrates</Text>
                  <Text style={styles.subValue}>{safeToFixed(carbsActual, 1)}g</Text>
                </View>
                <View style={styles.subRow}>
                  <Text style={styles.subLabel}>Protein equivalent</Text>
                  <Text style={styles.subValue}>{safeToFixed(proteinCarbEquiv, 1)}g</Text>
                </View>
                <View style={styles.subRow}>
                  <Text style={styles.subLabel}>Fat equivalent</Text>
                  <Text style={styles.subValue}>{safeToFixed(fatCarbEquiv, 2)}g</Text>
                </View>
                <View style={[styles.subRow, styles.totalRow]}>
                  <Text style={[styles.subLabel, styles.totalLabel]}>Total carb equivalent</Text>
                  <Text style={[styles.subValue, styles.totalValue]}>{safeToFixed(totalCarbEquiv, 1)}g</Text>
                </View>
              </View>
            )}
          </View>

          {/* Activity Impact */}
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Activity Impact</Text>
            <Text style={[
              styles.sectionValue,
              activityCoefficient < 1 ? styles.negativeImpact : activityCoefficient > 1 ? styles.positiveImpact : null
            ]}>
              {((activityCoefficient - 1) * 100).toFixed(1)}%
              {activityCoefficient !== 1 && (activityCoefficient > 1 ? ' Increase' : ' Decrease')}
            </Text>
          </View>

          {/* Pharmacodynamic Adjustments */}
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Pharmacodynamic Adjustments</Text>
            {hasAdjustments ? (
              <>
                <Text style={styles.sectionValue}>Adjustments applied: {safeToFixed(adjustedInsulin, 1)} units</Text>
                <View style={styles.subSection}>
                  <View style={styles.subRow}>
                    <Text style={styles.subLabel}>Absorption Factor</Text>
                    <Text style={styles.subValue}>{safeToFixed(absorptionFactor, 2)}x</Text>
                  </View>
                  <View style={styles.subRow}>
                    <Text style={styles.subLabel}>Meal Timing</Text>
                    <Text style={styles.subValue}>{safeToFixed(mealTimingFactor, 2)}x</Text>
                  </View>
                  <View style={styles.subRow}>
                    <Text style={styles.subLabel}>Activity Impact</Text>
                    <Text style={styles.subValue}>{safeToFixed(activityCoefficient, 2)}x</Text>
                  </View>
                </View>
              </>
            ) : (
              <Text style={styles.sectionValue}>0.0% (no adjustment)</Text>
            )}
          </View>

          {/* Correction Insulin */}
          {correctionInsulin !== 0 && (
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Correction Insulin</Text>
              <Text style={styles.sectionValue}>{safeToFixed(correctionInsulin, 1)} units</Text>
            </View>
          )}

          {/* Active Insulin */}
          {activeInsulinValue > 0 && (
            <View style={[styles.sectionCard, styles.activeInsulinCard]}>
              <Text style={styles.sectionTitle}>Active Insulin (IOB)</Text>
              <Text style={[styles.sectionValue, styles.activeInsulinValue]}>
                -{safeToFixed(activeInsulinValue, 1)} units
              </Text>
            </View>
          )}

          {/* Health Multiplier */}
          {healthMultiplier !== 1 && (
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Health Multiplier</Text>
              <Text style={styles.sectionValue}>{safeToFixed(healthMultiplier, 2)}x</Text>
            </View>
          )}

          {/* Final Calculation Summary */}
          <View style={[styles.sectionCard, styles.finalCard]}>
            <Text style={styles.sectionTitle}>Suggested Insulin Dose</Text>
            <Text style={[styles.sectionValue, styles.finalValue]}>{safeToFixed(suggestedInsulin, 1)} units</Text>

            <View style={styles.formulaSection}>
              <Text style={styles.formulaLabel}>Calculation breakdown:</Text>
              <Text style={styles.formulaText}>Adjusted Insulin: {safeToFixed(adjustedInsulin, 1)} units</Text>
              {correctionInsulin !== 0 && (
                <Text style={styles.formulaText}>Correction: {safeToFixed(correctionInsulin, 1)} units</Text>
              )}
              {activeInsulinValue > 0 && (
                <Text style={styles.formulaText}>Active Insulin: -{safeToFixed(activeInsulinValue, 1)} units</Text>
              )}
              <Text style={styles.formulaText}>Subtotal: {safeToFixed(postActiveTotal, 1)} units</Text>
              <Text style={styles.formulaText}>Health Multiplier: ×{safeToFixed(healthMultiplier, 2)}</Text>
              <Text style={[styles.formulaText, styles.formulaFinal]}>
                Formula: ({safeToFixed(adjustedInsulin, 1)} + {safeToFixed(correctionInsulin, 1)}
                {activeInsulinValue > 0 ? ` - ${safeToFixed(activeInsulinValue, 1)}` : ''}) × {safeToFixed(healthMultiplier, 2)} = {safeToFixed(suggestedInsulin, 1)} units
              </Text>
            </View>
          </View>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16
  },
  mainCard: {
    backgroundColor: '#e8f5e9',
    padding: 20,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 12
  },
  label: {
    fontSize: 14,
    color: '#2e7d32',
    marginBottom: 8,
    fontWeight: '500'
  },
  value: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#1b5e20'
  },
  nutritionSummary: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#a5d6a7'
  },
  nutritionText: {
    fontSize: 12,
    color: '#2e7d32',
    textAlign: 'center'
  },
  calculatingText: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    padding: 20
  },
  toggleButton: {
    padding: 12,
    alignItems: 'center'
  },
  toggleText: {
    color: '#1976d2',
    fontSize: 14,
    fontWeight: '600'
  },
  detailsContainer: {
    marginTop: 12,
    gap: 12
  },
  sectionCard: {
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e0e0e0'
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 8
  },
  sectionValue: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1976d2'
  },
  negativeImpact: {
    color: '#f44336'
  },
  positiveImpact: {
    color: '#4caf50'
  },
  subSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0'
  },
  subRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4
  },
  subLabel: {
    fontSize: 13,
    color: '#666'
  },
  subValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333'
  },
  totalRow: {
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
    marginTop: 4,
    paddingTop: 8
  },
  totalLabel: {
    fontWeight: '700',
    color: '#333'
  },
  totalValue: {
    fontWeight: '700',
    color: '#1976d2'
  },
  activeInsulinCard: {
    backgroundColor: '#ffebee',
    borderColor: '#f44336'
  },
  activeInsulinValue: {
    color: '#f44336'
  },
  finalCard: {
    backgroundColor: '#e3f2fd',
    borderColor: '#1976d2',
    borderWidth: 2
  },
  finalValue: {
    fontSize: 28,
    color: '#1b5e20'
  },
  formulaSection: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#90caf9'
  },
  formulaLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1976d2',
    marginBottom: 8
  },
  formulaText: {
    fontSize: 12,
    color: '#555',
    marginBottom: 4
  },
  formulaFinal: {
    marginTop: 8,
    fontWeight: '600',
    color: '#1976d2',
    fontSize: 13
  },

  // ── Insulin type suggestion ─────────────────────────────────────────────
  suggestionCard: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderLeftWidth: 4,
    backgroundColor: '#fafafa',
    padding: 14,
    marginBottom: 12,
  },
  suggestionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    gap: 8,
  },
  suggestionIcon: {
    fontSize: 22,
  },
  suggestionHeaderText: {
    flex: 1,
  },
  suggestionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  suggestionType: {
    fontSize: 15,
    fontWeight: '700',
  },
  absorptionBadge: {
    paddingVertical: 3,
    paddingHorizontal: 9,
    borderRadius: 8,
  },
  absorptionBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  suggestionExamples: {
    fontSize: 12,
    color: '#555',
    marginBottom: 6,
    lineHeight: 17,
  },
  suggestionExamplesLabel: {
    fontWeight: '700',
    color: '#333',
  },
  suggestionRationale: {
    fontSize: 12,
    color: '#666',
    lineHeight: 18,
    marginBottom: 8,
  },
  suggestionDisclaimer: {
    fontSize: 11,
    color: '#999',
    fontStyle: 'italic',
  },

  // ── IOB surplus warning ─────────────────────────────────────────────────
  iobWarningCard: {
    backgroundColor: '#fff3e0',
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#e65100',
    borderLeftWidth: 5,
    borderLeftColor: '#e65100',
    padding: 14,
    marginBottom: 12,
  },
  iobWarningTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#bf360c',
    marginBottom: 6,
  },
  iobWarningBody: {
    fontSize: 13,
    color: '#5d4037',
    lineHeight: 19,
    marginBottom: 10,
  },
  iobWarningRow: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    paddingVertical: 4,
  },
  iobWarningRowHighlight: {
    backgroundColor: '#ffe0b2',
    borderRadius: 6,
    paddingHorizontal: 8,
    marginTop: 4,
    marginBottom: 4,
  },
  iobWarningLabel: {
    fontSize: 13,
    color: '#5d4037',
  },
  iobWarningLabelBold: {
    fontWeight: '700',
    color: '#e65100',
  },
  iobWarningValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#bf360c',
  },
  iobWarningCarbValue: {
    fontSize: 16,
    color: '#e65100',
  },
  iobWarningNote: {
    fontSize: 11,
    color: '#795548',
    fontStyle: 'italic',
    lineHeight: 16,
    marginTop: 6,
  },
});

export default InsulinBreakdown;