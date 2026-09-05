/**
 * Dashboard / Home Tab Screen
 * Location: mobile/app/(app)/(tabs)/index.tsx
 *
 * ─── CHANGES IN THIS REVISION ────────────────────────────────────────────────
 *
 * FIX 1 — Dead props on ActiveEffectsDisplay (breaking interface mismatch)
 *   The component was called with 8 props that no longer exist in its interface:
 *     iobData, mobData, estimatedBG, timingAssessment, correctionFactor,
 *     isLoading, compact, onRefresh
 *   React silently drops unknown props, so ActiveEffectsDisplay was ignoring
 *   everything the screen computed and running its own independent 60 s fetch
 *   loop regardless.  The component's actual interface has exactly ONE prop:
 *     activityPDResult?: ActivityPDResult | null
 *   This is now the only prop we pass.
 *
 * FIX 2 — Duplicate fetch loops (N×60 s API calls to the same Render worker)
 *   Before this change, on every 60-second tick the dashboard fired:
 *     • ActiveEffectsDisplay.fetchAndCalculate   → meals + insulin + blood-sugar + activityPD
 *     • useActiveEffects (EffectsVisualizationChart) → meals + insulin + blood-sugar + activityPD
 *     • useActiveEffects (BloodGlucoseVisualization)  → meals + insulin + blood-sugar + activityPD
 *     • loadDashboardData                         → meals + insulin + MOB + timing
 *   That is 4× meals, 4× insulin, 3× blood-sugar, 3× activityPD ODE on a single
 *   gunicorn worker — easily causing request queuing / timeouts.
 *
 *   Phase 1 fix (previous revision):
 *     a. Lifted useActiveEffects to the screen level.
 *     b. Passed activityPDResult to ActiveEffectsDisplay — activates the D-3 fix
 *        already coded inside that component: it skips the ODE fetch when the
 *        prop is provided.
 *     c. Passed activityPD to EffectsVisualizationChart — same deduplication.
 *     d. Passed activityPD to BloodGlucoseVisualization — same deduplication.
 *   Result: 3 activityPD ODE calls per minute → 1.
 *
 *   Phase 2 fix (THIS revision):
 *     e. Destructure meals + insulinDoses from the screen-level useActiveEffects.
 *     f. Pass meals + insulinDoses to ActiveEffectsDisplay — activates the
 *        prop-path in fetchAndCalculate() so it skips GET /api/meals-only and
 *        GET /api/insulin-data entirely when both arrays are provided.
 *     g. Pass meals + insulinDoses to EffectsVisualizationChart for the default
 *        24h view — it uses the props directly as rawMeals/rawInsulin and skips
 *        its internal fetch when windowHours matches the screen-level window.
 *        Note: EVC IGNORES these props and re-fetches for 3D/7D views (by design —
 *        it needs a wider window than the 24h data owned by this screen).
 *   Result: duplicate meals + insulin fetches per minute dropped from 3 → 1
 *   for the default 24h dashboard view.
 *
 * FIX 3 — Dead state and dead fetches removed
 *   activeInsulin, mealOnBoard, mealTiming were only used to populate the now-
 *   removed dead props.  Their fetch calls (getActiveDoses, getMealOnBoard,
 *   getMealTimingAssessment) are also removed.  loadDashboardData now only
 *   fetches the 5 most-recent meal summaries for <RecentMeals>.
 *
 * FIX 4 — useFocusEffect now triggers activeEffects.refresh()
 *   Previously only loadDashboardData + refreshBGEstimation ran on focus.
 *   The screen-level useActiveEffects was never told to refresh when the user
 *   navigated back from meal/insulin/activity logging screens.
 *
 * FIX 5 — Activity card zero-flash on first render
 *   useActiveEffects initialises activityPDResult to null.  Passing null to
 *   ActiveEffectsDisplay immediately activated the D-3 short-circuit guard:
 *     propPDResult !== undefined  →  true (null !== undefined)
 *     propPDResult ? ...          →  false (null is falsy)
 *     → Promise.resolve(null)     →  zero activity effect on first render
 *   The card showed zeros, then updated correctly once the real PD fetch
 *   completed and propPDResult changed to a real value — causing a visible
 *   "flash" of wrong data.
 *   Fix: gate the prop on `lastUpdate`.  Until the parent's first fetch
 *   resolves, pass `undefined` (not null).  `undefined` means "prop not wired"
 *   to AED, so it safely falls back to its own fetch rather than short-
 *   circuiting to zero.  After the first fetch, `lastUpdate` is set and the
 *   real activityPDResult is passed normally.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RecentMeals, QuickActions } from '@/components/dashboard';
import ActiveEffectsDisplay from '@/components/dashboard/ActiveEffectsDisplay';
import { Card } from '@/components/ui';
import { useAuthStore } from '@/store/auth.store';
import { usePatientConstants } from '@/hooks/usePatientConstants';
import { useBloodGlucoseEstimation } from '@/hooks/useBloodGlucoseEstimation';
import { useActiveEffects } from '@/hooks/useActiveEffects';
import { getMeals } from '@/services/api/meals';
import { getLibreStatus } from '@/services/api/libre';

import EffectsVisualizationChart from '@/components/charts/EffectsVisualizationChart';
import BloodGlucoseVisualization  from '@/components/charts/BloodGlucoseVisualization';
import BloodGlucoseChart          from '@/components/charts/BloodGlucoseChart';

import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import type { MealResponse } from '@/types/api';

// ─── Chart tab type ────────────────────────────────────────────────────────────
type ActiveChart = 'glucose_chart' | 'effects' | 'blood_glucose';

const CHART_TABS: { key: ActiveChart; icon: string; label: string }[] = [
  { key: 'glucose_chart', icon: '📈', label: 'Glucose'      },
  { key: 'effects',       icon: '⚡', label: 'Effects'      },
  { key: 'blood_glucose', icon: '🩸', label: 'BG Projected' },
];

// ─────────────────────────────────────────────────────────────────────────────

export default function DashboardScreen() {
  const router = useRouter();
  const { user } = useAuthStore();

  // ── Doctor guard ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (user?.user_type === 'doctor' || user?.user_type === 'admin') {
      router.replace('/(app)/(tabs)/doctor-dashboard');
    }
  }, [user?.user_type]);

  const isDoctor = user?.user_type === 'doctor' || user?.user_type === 'admin';

  const { constants } = usePatientConstants(!isDoctor);

  // ── useBloodGlucoseEstimation ─────────────────────────────────────────────
  // Kept for pull-to-refresh of BloodGlucoseChart (which manages its own
  // internal state via this hook or a shared store).  Only `refresh` is used
  // here — estimatedBG and combinedData are no longer consumed at screen level.
  const { refresh: refreshBGEstimation } = useBloodGlucoseEstimation({
    targetGlucose:      constants?.target_glucose ?? 100,
    refreshInterval:    2 * 60 * 1000,
    stabilizationHours: 3,
  });

  // ── Screen-level active effects ───────────────────────────────────────────
  // This is the SINGLE polling loop that owns meals, insulin, blood-sugar, and
  // the Activity PD ODE for the dashboard.  Its results are passed down to
  // child components so they can skip their own duplicate fetches.
  //
  // windowHours: 24 matches ActiveEffectsDisplay's hardcoded 24 h window and
  // the default chart view, so data passed from here is consistent with what
  // each component would independently compute.
  //
  // skipIobCutoff: false — live IOB display needs the 48h cutoff filter to
  // exclude pharmacologically inactive doses from the BG estimate.
  const {
    activityPDResult,
    meals,
    insulinDoses,
    lastUpdate,                 // FIX (zero-flash): gate activityPDResult below
    refresh: refreshActiveEffects,
  } = useActiveEffects({
    autoRefresh:     !isDoctor,
    refreshInterval: 60_000,
    windowHours:     24,
    skipIobCutoff:   false,
  });

  const [refreshing,    setRefreshing]    = useState(false);
  const [recentMeals,   setRecentMeals]   = useState<MealResponse[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(true);

  // ── Chart tab state ────────────────────────────────────────────────────────
  const [activeChart, setActiveChart] = useState<ActiveChart>('glucose_chart');

  // ── Dashboard data ────────────────────────────────────────────────────────
  // Only fetches the 5 most-recent meal summaries for the <RecentMeals>
  // quick-access list.  All PK data (meals + insulin + blood-sugar for
  // pharmacodynamic calculations) is owned by the screen-level useActiveEffects
  // above — nothing else should be fetched here.
  const loadDashboardData = useCallback(async () => {
    if (isDoctor) return;
    try {
      // Fire-and-forget LibreLinkUp connection check (non-blocking).
      getLibreStatus(true).catch(() => {});

      const mealData = await getMeals({ limit: 5 }).catch(() => ({
        meals:      [] as MealResponse[],
        pagination: { total: 0, limit: 5, skip: 0 },
      }));
      setRecentMeals(mealData.meals);
    } catch (error) {
      console.error('Error loading dashboard data:', error);
    } finally {
      setIsLoadingData(false);
    }
  }, [isDoctor]);

  // Re-fetch every time the screen comes into focus so doses/meals logged on
  // other screens are reflected immediately on return.  Also triggers
  // activeEffects.refresh() so the PK calculations update too.
  useFocusEffect(
    useCallback(() => {
      loadDashboardData();
      refreshActiveEffects();
      refreshBGEstimation();
    }, [loadDashboardData, refreshActiveEffects, refreshBGEstimation])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      loadDashboardData(),
      refreshActiveEffects(),
      refreshBGEstimation(),
    ]);
    setRefreshing(false);
  }, [loadDashboardData, refreshActiveEffects, refreshBGEstimation]);

  const handleLogMeal      = () => router.push('/(app)/log/meal');
  const handleLogGlucose   = () => router.push('/(app)/log/glucose');
  const handleLogInsulin   = () => router.push('/(app)/log/insulin');
  const handleLogActivity  = () => router.push('/(app)/log/activity');
  const handleViewHistory  = () => router.push('/(app)/(tabs)/history');

  if (isDoctor) return <View style={styles.safeArea} />;

  return (
    <SafeAreaView style={styles.safeArea} edges={[]}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
          />
        }
      >
        {/* ── Welcome ── */}
        <View style={styles.welcomeSection}>
          <Text style={styles.greeting}>
            {`Good ${
              new Date().getHours() < 12 ? 'morning' :
              new Date().getHours() < 17 ? 'afternoon' : 'evening'
            }`}
          </Text>
          <Text style={styles.userName}>{user?.firstName || 'User'}</Text>
        </View>

        {/* ════════════════════════════════════════════════════════════════════
            CHARTS SECTION
        ════════════════════════════════════════════════════════════════════ */}

        {/* Tab selector */}
        <Card variant="outlined" padding="small" style={styles.selectorCard}>
          <View style={styles.chartSelector}>
            {CHART_TABS.map(({ key, icon, label }) => (
              <TouchableOpacity
                key={key}
                style={[styles.chartTab, activeChart === key && styles.chartTabActive]}
                onPress={() => setActiveChart(key)}
              >
                <Text style={styles.chartTabIcon}>{icon}</Text>
                <Text style={[
                  styles.chartTabText,
                  activeChart === key && styles.chartTabTextActive,
                ]}>
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </Card>

        {/* All three charts are mounted simultaneously; inactive ones are hidden
            with display:none so their data-fetch state survives tab switching. */}
        <Card variant="elevated" padding="none" style={styles.chartCard}>

          {/* 📈 Raw glucose curve */}
          <View style={activeChart !== 'glucose_chart' ? styles.hidden : undefined}>
            <BloodGlucoseChart
              height={300}
              showControls
              embedded
              defaultView="12h"
            />
          </View>

          {/* ⚡ Effects visualization
              activityPD — D-3 deduplication: skips GET /api/activity/pharmacodynamics.
              meals / insulinDoses — Phase 2: skips GET /api/meals-only and
              GET /api/insulin-data for the default 24h view.  EVC ignores these
              props and re-fetches when the user switches to 3D/7D (by design —
              it needs a wider window than the 24h arrays we hold here). */}
          <View style={activeChart !== 'effects' ? styles.hidden : undefined}>
            <EffectsVisualizationChart
              height={300}
              showControls
              embedded
              activityPD={activityPDResult}
              meals={meals}
              insulinDoses={insulinDoses}
              debug={true}   // ← TEMP: cumulative line debug; remove after diagnosis
            />
          </View>

          {/* 🩸 Projected BG
              activityPD — same D-3 deduplication as EVC.
              meals / insulinDoses — same Phase 2 deduplication. */}
          <View style={activeChart !== 'blood_glucose' ? styles.hidden : undefined}>
            <BloodGlucoseVisualization
              height={300}
              showControls
              embedded
              activityPD={activityPDResult}
              meals={meals}
              insulinDoses={insulinDoses}
            />
          </View>
        </Card>

        {/* ════════════════════════════════════════════════════════════════════
            ACTIVE EFFECTS DISPLAY
            activityPDResult — skips ODE fetch (D-3 fix inside the component).
              ⚠️  GATED on lastUpdate: pass `undefined` (not null) until the
              parent's first fetch completes.  `null` means "fetched, no sessions
              today" — AED short-circuits to zero activity immediately.
              `undefined` means "prop not wired" — AED does its own safe fetch.
              Without this gate, AED's first render always shows zeros because
              activityPDResult is initialised to null in useActiveEffects state.
            meals / insulinDoses — Phase 2: skips meals + insulin fetches when
            both arrays are provided, reducing fetchAndCalculate() to only
            GET /api/blood-sugar (the latest single reading it still needs).
              ⚠️  GATED on lastUpdate for the same reason as activityPDResult:
              useActiveEffects initialises meals/insulinDoses to [] (empty arrays).
              Passing [] immediately causes AED's propMeals/propInsulinDoses
              reactive effects to fire fetchAndCalculate() with no data, producing
              a stale zero-calculation before the real fetch resolves.
              Gating on lastUpdate ensures AED falls back to its own fetch until
              the parent has real populated arrays to offer.
        ════════════════════════════════════════════════════════════════════ */}
        <ActiveEffectsDisplay
          activityPDResult={lastUpdate ? activityPDResult : undefined}
          meals={lastUpdate ? meals : undefined}
          insulinDoses={lastUpdate ? insulinDoses : undefined}
        />

        {/* ── Quick Actions ── */}
        <QuickActions
          onLogMeal={handleLogMeal}
          onLogGlucose={handleLogGlucose}
          onLogInsulin={handleLogInsulin}
          onLogActivity={handleLogActivity}
        />

        {/* ── Recent Meals ── */}
        <RecentMeals
          meals={recentMeals}
          onMealPress={(meal) => router.push(`/(app)/meal/${meal.id}`)}
          onViewAll={handleViewHistory}
          isLoading={isLoadingData}
        />

        {/* ── Target constants row ── */}
        <Card variant="filled" padding="small" style={styles.targetCard}>
          <View style={styles.targetRow}>
            <View style={styles.targetItem}>
              <Text style={styles.targetValue}>{constants?.target_glucose ?? 100}</Text>
              <Text style={styles.targetLabel}>Target mg/dL</Text>
            </View>
            <View style={styles.targetDivider} />
            <View style={styles.targetItem}>
              <Text style={styles.targetValue}>1:{constants?.insulin_to_carb_ratio ?? 10}</Text>
              <Text style={styles.targetLabel}>I:C Ratio</Text>
            </View>
            <View style={styles.targetDivider} />
            <View style={styles.targetItem}>
              <Text style={styles.targetValue}>{constants?.correction_factor ?? 50}</Text>
              <Text style={styles.targetLabel}>Correction Factor</Text>
            </View>
          </View>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea:  { flex: 1, backgroundColor: colors.background },
  container: { flex: 1 },
  content:   { padding: spacing.md, paddingBottom: spacing.xl },

  welcomeSection: { marginBottom: spacing.lg },
  greeting:       { ...typography.body, color: colors.text.secondary },
  userName:       { ...typography.h1,   color: colors.text.primary },

  // Chart tab selector
  selectorCard: { marginBottom: spacing.sm },
  chartSelector: {
    flexDirection:   'row',
    backgroundColor: colors.background,
    borderRadius:    borderRadius.md,
    padding:         4,
  },
  chartTab: {
    flex:              1,
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'center',
    paddingVertical:   spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius:      borderRadius.sm,
    gap:               4,
  },
  chartTabActive:     { backgroundColor: colors.primary },
  chartTabIcon:       { fontSize: 16 },
  chartTabText:       { ...typography.small, color: colors.text.secondary, fontWeight: '500', fontSize: 11 },
  chartTabTextActive: { color: colors.text.inverse, fontWeight: '600' },

  chartCard: { marginBottom: spacing.sm, overflow: 'hidden' },

  // Hide inactive chart without unmounting (preserves data + state)
  hidden: { display: 'none' },

  // Target constants row
  targetCard:    { marginTop: spacing.md },
  targetRow:     { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' },
  targetItem:    { alignItems: 'center', flex: 1 },
  targetValue:   { ...typography.h3, color: colors.text.primary },
  targetLabel:   { ...typography.small, color: colors.text.secondary, marginTop: 2 },
  targetDivider: { width: 1, height: 40, backgroundColor: colors.border },
});