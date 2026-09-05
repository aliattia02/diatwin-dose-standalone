/**
 * MealTimingGuidelines component for displaying insulin timing recommendations
 * Based on food absorption types
 * Location: mobile/components/meal/MealTimingGuidelines.tsx
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { colors, spacing, borderRadius, typography } from '@/constants/theme';
import { Card } from '@/components/ui';
import type { SelectedFood } from '@/types/food';
import type { AbsorptionType } from '../../../shared/src/types';
import { SHARED_CONSTANTS } from '@/constants/shared-constants';

export interface TimingGuideline {
  /** Description of when to take insulin */
  description: string;
  /** Minutes before/after meal */
  minutes?: number;
}

export interface PatientTimingGuidelines {
  very_fast?: TimingGuideline;
  fast?: TimingGuideline;
  medium?: TimingGuideline;
  slow?: TimingGuideline;
  very_slow?: TimingGuideline;
  [key: string]: TimingGuideline | undefined;
}

export interface MealTimingGuidelinesProps {
  /** Selected foods to show guidelines for */
  selectedFoods: SelectedFood[];
  /** Patient's timing guidelines from constants */
  timingGuidelines?: PatientTimingGuidelines;
  /** Meal type used in the overall timing recommendation (e.g. 'breakfast') */
  mealType?: string;
  /**
   * Render mode:
   *   "banner"  – only the ⏰ overall timing banner (shown in main dose card)
   *   "details" – only the per-food collapsible card (shown in breakdown section)
   *   "full"    – both (legacy default)
   */
  mode?: 'banner' | 'details' | 'full';
}

// Derived from shared-constants — single source of truth with constants.py
const DEFAULT_GUIDELINES: PatientTimingGuidelines = Object.fromEntries(
  Object.entries(SHARED_CONSTANTS.DEFAULT_PATIENT_CONSTANTS.insulin_timing_guidelines).map(
    ([key, val]) => [key, { description: val.description, minutes: val.timing_minutes }]
  )
);

const getAbsorptionColor = (type: AbsorptionType): string => {
  switch (type) {
    case 'very_fast': return colors.danger;
    case 'fast':      return colors.warning;
    case 'medium':    return colors.success;
    case 'slow':      return colors.secondary;
    case 'very_slow': return colors.primary;
    default:          return colors.text.secondary;
  }
};

const formatAbsorption = (type: string): string =>
  type.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper
// ─────────────────────────────────────────────────────────────────────────────

const getOverallTiming = (
  selectedFoods: SelectedFood[],
  timingGuidelines: PatientTimingGuidelines,
  mealType?: string,
): { text: string; minutes: number } => {
  const absorptionPriority: Record<string, number> = {
    very_slow: 5, slow: 4, medium: 3, fast: 2, very_fast: 1,
  };
  const absorptionTypes = selectedFoods
    .map((f) => f.details?.absorption_type || 'medium');
  const slowestType = absorptionTypes.reduce(
    (s, c) => (absorptionPriority[c] || 3) > (absorptionPriority[s] || 3) ? c : s,
    absorptionTypes[0], // seed with first food's actual type, not hardcoded 'medium'
  ) as AbsorptionType;

  const overallMinutes =
    timingGuidelines[slowestType]?.minutes ??
    DEFAULT_GUIDELINES[slowestType]?.minutes ??
    15;

  const mealLabel = mealType
    ? mealType.charAt(0).toUpperCase() + mealType.slice(1)
    : 'meal';

  const text =
    overallMinutes === 0
      ? `Inject your bolus insulin, then start your ${mealLabel} immediately`
      : `Inject your bolus insulin, then eat your ${mealLabel} ${overallMinutes} min later`;

  const splitAdvisory =
    slowestType === 'very_slow'
      ? 'Very slow meal: consider a split bolus (50% now, 50% at +90 min) or regular insulin to cover the full absorption window.'
      : slowestType === 'slow'
      ? 'Slow meal: a 20–30 min pre-bolus is important — bolus analogs may leave a short uncovered tail.'
      : null;

  return { text, minutes: overallMinutes, splitAdvisory };
};

// ─────────────────────────────────────────────────────────────────────────────
// Banner — ⏰ strip shown in the main dose card
// ─────────────────────────────────────────────────────────────────────────────

const TimingBanner: React.FC<{
  selectedFoods: SelectedFood[];
  timingGuidelines: PatientTimingGuidelines;
  mealType?: string;
}> = ({ selectedFoods, timingGuidelines, mealType }) => {
  if (selectedFoods.length === 0) return null;
  const { text, splitAdvisory } = getOverallTiming(selectedFoods, timingGuidelines, mealType);
  return (
    <View style={bannerStyles.container}>
      <Text style={bannerStyles.icon}>⏰</Text>
      <View style={{ flex: 1 }}>
        <Text style={bannerStyles.text}>{text}</Text>
        {!!splitAdvisory && (
          <Text style={bannerStyles.advisory}>{splitAdvisory}</Text>
        )}
      </View>
    </View>
  );
};

const bannerStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff3cd',
    borderRadius: borderRadius.sm,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginHorizontal: spacing.md,
    marginBottom: 6,
    borderLeftWidth: 3,
    borderLeftColor: '#ff9800',
  },
  icon: {
    fontSize: 13,
    marginRight: 6,
  },
  text: {
    fontSize: 12,
    color: '#856404',
    fontWeight: '500',
  },
  advisory: {
    fontSize: 11,
    color: '#6d4c00',
    marginTop: 3,
    fontStyle: 'italic',
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Details card — collapsible, styled to match FullInsulinBreakdown cards
// ─────────────────────────────────────────────────────────────────────────────

const TimingDetailsCard: React.FC<{
  selectedFoods: SelectedFood[];
  timingGuidelines: PatientTimingGuidelines;
  mealType?: string;
}> = ({ selectedFoods, timingGuidelines, mealType }) => {
  const [expanded, setExpanded] = useState(false);

  if (selectedFoods.length === 0) return null;

  const absorptionTypes = new Set<AbsorptionType>(
    selectedFoods.map((f) => (f.details?.absorption_type || 'medium') as AbsorptionType),
  );

  const hasSlowFood = absorptionTypes.has('slow') || absorptionTypes.has('very_slow');
  const hasVerySlowFood = absorptionTypes.has('very_slow');

  return (
    <TouchableOpacity
      style={detailStyles.card}
      onPress={() => setExpanded((v) => !v)}
      activeOpacity={0.85}
    >
      {/* Header row — always visible */}
      <View style={detailStyles.cardHeader}>
        <View style={detailStyles.cardLabelContainer}>
          <Text style={detailStyles.cardLabel}>Meal Timing Guidelines</Text>
          <Text style={detailStyles.cardSubLabel}>
            ⏰ Per-food bolus insulin timing breakdown
          </Text>
        </View>
        <Text style={detailStyles.chevron}>{expanded ? '▲' : '▼'}</Text>
      </View>

      {/* Expanded body */}
      {expanded && (
        <View style={detailStyles.cardBody}>
          {selectedFoods.map((food) => {
            const absorptionType = (food.details?.absorption_type || 'medium') as AbsorptionType;
            const guideline =
              timingGuidelines[absorptionType] || DEFAULT_GUIDELINES[absorptionType];
            const color = getAbsorptionColor(absorptionType);

            return (
              <View key={food.id} style={detailStyles.foodRow}>
                <View style={detailStyles.foodHeader}>
                  <Text style={detailStyles.foodName} numberOfLines={1}>
                    {food.name}
                  </Text>
                  <View style={[detailStyles.badge, { backgroundColor: color + '20' }]}>
                    <Text style={[detailStyles.badgeText, { color }]}>
                      {formatAbsorption(absorptionType)}
                    </Text>
                  </View>
                </View>
                <Text style={detailStyles.guidelineText}>
                  {guideline?.description || 'Take bolus insulin as usual'}
                </Text>
              </View>
            );
          })}

          {/* Mixed meal note — only when multiple absorption rates present */}
          {absorptionTypes.size > 1 && (
            <View style={detailStyles.mixedNote}>
              <Text style={detailStyles.mixedTitle}>Mixed Meal</Text>
              <Text style={detailStyles.mixedText}>
                Your meal contains foods with different absorption rates. Time your bolus
                insulin to the slowest food.{' '}
                {Array.from(absorptionTypes).includes('very_fast') ||
                Array.from(absorptionTypes).includes('fast')
                  ? 'Eat within 0–5 minutes of your bolus injection to avoid an early hypo.'
                  : 'Eat 10–15 minutes after your bolus injection.'}
              </Text>
            </View>
          )}

          {/* Coverage gap advisory — slow or very_slow foods */}
          {hasSlowFood && (
            <View style={detailStyles.coverageNote}>
              <Text style={detailStyles.coverageTitle}>
                {hasVerySlowFood ? '⚠️ Coverage gap — split bolus recommended' : '⚠️ Extended absorption'}
              </Text>
              {hasVerySlowFood ? (
                <>
                  <Text style={detailStyles.coverageText}>
                    Rapid-acting bolus analogs (duration ~4.5 h) leave a <Text style={detailStyles.coverageBold}>3-hour uncovered tail</Text> on very slow meals (duration ~7 h). Two options close this gap:
                  </Text>
                  <Text style={detailStyles.coverageOption}>
                    {'1. Regular insulin (Humulin R / Novolin R) — single injection, peak ~3 h, duration ~8 h. Closest pharmacodynamic match.'}
                  </Text>
                  <Text style={detailStyles.coverageOption}>
                    {'2. Split bolus — inject 50% of your dose now, set a reminder, inject the remaining 50% at +90 min.'}
                  </Text>
                  <Text style={detailStyles.coverageDisclaimer}>
                    Discuss with your care team before changing insulin type.
                  </Text>
                </>
              ) : (
                <>
                  <Text style={detailStyles.coverageText}>
                    Rapid-acting bolus analogs may leave a short uncovered tail on slow meals. A 20–30 min pre-bolus significantly reduces this gap. Regular insulin (peak ~3 h) is also a good match.
                  </Text>
                  <Text style={detailStyles.coverageDisclaimer}>
                    Discuss with your care team before changing insulin type.
                  </Text>
                </>
              )}
            </View>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
};

const detailStyles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    marginBottom: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e0e0e0',
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
  },
  cardLabelContainer: {
    flex: 1,
    paddingRight: 8,
  },
  cardLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },
  cardSubLabel: {
    fontSize: 11,
    color: '#888',
    marginTop: 2,
  },
  chevron: {
    fontSize: 12,
    color: '#888',
  },
  cardBody: {
    backgroundColor: '#fafafa',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    gap: 8,
  },
  foodRow: {
    backgroundColor: '#f3f4f6',
    borderRadius: 8,
    padding: 10,
  },
  foodHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  foodName: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
    flex: 1,
    marginRight: 8,
  },
  badge: {
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  guidelineText: {
    fontSize: 12,
    color: '#666',
  },
  mixedNote: {
    marginTop: 4,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  mixedTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.primary,
    marginBottom: 2,
  },
  mixedText: {
    fontSize: 12,
    color: '#666',
  },
  coverageNote: {
    marginTop: 8,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#ffe0b2',
    backgroundColor: '#fff8f0',
    borderRadius: 6,
    padding: 10,
  },
  coverageTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#e65100',
    marginBottom: 6,
  },
  coverageText: {
    fontSize: 12,
    color: '#5d4037',
    lineHeight: 18,
    marginBottom: 4,
  },
  coverageBold: {
    fontWeight: '700',
  },
  coverageOption: {
    fontSize: 11,
    color: '#5d4037',
    lineHeight: 17,
    marginTop: 3,
    paddingLeft: 4,
  },
  coverageDisclaimer: {
    fontSize: 10,
    color: '#999',
    fontStyle: 'italic',
    marginTop: 6,
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

export const MealTimingGuidelines: React.FC<MealTimingGuidelinesProps> = ({
  selectedFoods,
  timingGuidelines = DEFAULT_GUIDELINES,
  mealType,
  mode = 'full',
}) => {
  if (selectedFoods.length === 0) return null;

  const showBanner  = mode === 'banner'  || mode === 'full';
  const showDetails = mode === 'details' || mode === 'full';

  // Legacy "full" mode wraps both in an outlined Card
  if (mode === 'full') {
    return (
      <Card variant="outlined" padding="medium" style={{ marginBottom: spacing.md }}>
        <TimingBanner
          selectedFoods={selectedFoods}
          timingGuidelines={timingGuidelines}
          mealType={mealType}
        />
        <TimingDetailsCard
          selectedFoods={selectedFoods}
          timingGuidelines={timingGuidelines}
          mealType={mealType}
        />
      </Card>
    );
  }

  return (
    <>
      {showBanner && (
        <TimingBanner
          selectedFoods={selectedFoods}
          timingGuidelines={timingGuidelines}
          mealType={mealType}
        />
      )}
      {showDetails && (
        <TimingDetailsCard
          selectedFoods={selectedFoods}
          timingGuidelines={timingGuidelines}
          mealType={mealType}
        />
      )}
    </>
  );
};

export default MealTimingGuidelines;