/**
 * Dashboard / Home Tab Screen - DEBUG VERSION
 * Enhanced with detailed MOB/IOB debugging information
 * Location: mobile/app/(app)/(tabs)/index.tsx
 *
 * INSTRUCTIONS:
 * 1. Backup your current index.tsx
 * 2. Replace it with this debug version
 * 3. Run the app and check console logs
 * 4. Look at the new debug sections in the UI
 */

import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RecentMeals, QuickActions } from '@/components/dashboard';
import ActiveEffectsDisplay from '@/components/dashboard/ActiveEffectsDisplay';
import { Card } from '@/components/ui';
import { useAuthStore } from '@/store/auth.store';
import { usePatientConstants } from '@/hooks/usePatientConstants';
import { useBloodGlucoseEstimation } from '@/hooks/useBloodGlucoseEstimation';
import { getMeals } from '@/services/api/meals';
import { getActiveDoses } from '@/services/api/insulin';
// ── CHANGED: import from calculations.ts directly (mob.ts has been deleted) ──
import {
  getMealOnBoard,
  getMealTimingAssessment,
  type MealOnBoardResult,
  type MealTimingAssessment,
} from '@/services/api/calculations';
import { colors, spacing, typography } from '@/constants/theme';
import type { MealResponse, ActiveInsulinResponse } from '@/types/api';
import { TimeManager } from '@/utils/time';

export default function DashboardScreen() {
  const router = useRouter();
  const { user } = useAuthStore();
  const { constants, isLoading: constantsLoading } = usePatientConstants();

  // 🔥 Use the unified blood glucose estimation hook
  const {
    estimatedBG,
    recentReadings,
    combinedData,
    isLoading: bgEstimationLoading,
    error: bgEstimationError,
    refresh: refreshBGEstimation,
  } = useBloodGlucoseEstimation({
    targetGlucose: constants?.target_glucose ?? 100,
    refreshInterval: 2 * 60 * 1000, // 2 minutes
    stabilizationHours: 3,
  });

  const [refreshing, setRefreshing] = useState(false);
  const [recentMeals, setRecentMeals] = useState<MealResponse[]>([]);
  const [activeInsulin, setActiveInsulin] = useState<ActiveInsulinResponse | null>(null);
  const [mealOnBoard, setMealOnBoard] = useState<MealOnBoardResult | null>(null);
  const [mealTiming, setMealTiming] = useState<MealTimingAssessment | null>(null);
  const [isLoadingData, setIsLoadingData] = useState(true);

  // 🔍 DEBUG: Track last fetch time
  const [lastFetchTime, setLastFetchTime] = useState<string>('');
  const [debugExpanded, setDebugExpanded] = useState(true);

  const loadDashboardData = useCallback(async () => {
    try {
      const fetchStartTime = new Date().toISOString();
      console.log('='.repeat(80));
      console.log('🔄 DASHBOARD DATA FETCH - DEBUG VERSION');
      console.log('='.repeat(80));
      console.log('📅 Fetch started at:', fetchStartTime);
      console.log('🕐 Local time:', new Date().toLocaleString());
      console.log('🌍 UTC time:', new Date().toISOString());
      console.log('👤 User ID:', user?.id || user?._id || 'unknown');

      // Load all data in parallel
      const [meals, insulin, mob, timing] = await Promise.all([
        getMeals({ limit: 5 }).catch((err) => {
          console.error('❌ Failed to load recent meals:', err.message);
          return { meals: [], pagination: { total: 0, limit: 5, skip: 0 } };
        }),
        getActiveDoses().catch((err) => {
          console.error('❌ Failed to load active insulin:', err.message);
          return null;
        }),
        getMealOnBoard({ max_hours_back: 12 }).catch((err) => {
          console.error('❌ Failed to load meal on board:', err.message);
          return null;
        }),
        getMealTimingAssessment().catch((err) => {
          console.error('❌ Failed to load meal timing:', err.message);
          return null;
        }),
      ]);

      // 🔍 DETAILED MOB DEBUG LOGGING
      console.log('');
      console.log('━'.repeat(80));
      console.log('🍽️  MEAL ON BOARD (MOB) DATA - DETAILED BREAKDOWN');
      console.log('━'.repeat(80));

      if (mob) {
        console.log('📊 MOB Summary:');
        console.log('  Total Active Carbs:', mob.total_active_carbs, 'g');
        console.log('  Total Absorbed Carbs:', mob.total_absorbed_carbs || 0, 'g');
        console.log('  Current BG Elevation:', mob.current_bg_elevation || 0, 'mg/dL');
        console.log('  Pending BG Rise:', mob.pending_bg_rise || 0, 'mg/dL');
        console.log('  Active Meal Count:', mob.active_meal_count);
        console.log('  Calculation Time:', mob.calculation_time);
        console.log('  Calculation Timezone:', mob.calculation_timezone);

        if (mob.contributions && mob.contributions.length > 0) {
          console.log('');
          console.log('🍽️  Individual Meal Contributions:');
          mob.contributions.forEach((contrib, idx) => {
            console.log(`  Meal ${idx + 1}:`);
            console.log('    Meal Type:', contrib.meal_type);
            console.log('    Meal Time:', contrib.meal_time);
            console.log('    Hours Elapsed:', contrib.hours_elapsed);
            console.log('    Total Carbs:', contrib.total_carbs, 'g');
            console.log('    Active Carbs (MOB):', contrib.active_carbs || contrib.mob, 'g');
            console.log('    Absorbed Carbs:', contrib.absorbed_carbs, 'g');
            console.log('    Absorption %:', contrib.absorbed_percent || contrib.activity_percent, '%');
            console.log('    Absorption Type:', contrib.absorption_type);
            console.log('    Duration Remaining:', contrib.duration_remaining, 'hours');
            console.log('    Current BG Impact:', contrib.current_bg_elevation, 'mg/dL');
            console.log('    Pending BG Rise:', contrib.pending_bg_rise, 'mg/dL');

            // Calculate time since meal
            const mealTime = new Date(contrib.meal_time);
            const now = new Date();
            const hoursSince = (now.getTime() - mealTime.getTime()) / (1000 * 60 * 60);
            console.log('    ⏱️  Time since meal:', hoursSince.toFixed(2), 'hours ago');
            console.log('    ⏱️  Meal logged at:', mealTime.toLocaleString());
            console.log('');
          });
        } else {
          console.log('');
          console.log('⚠️  NO ACTIVE MEAL CONTRIBUTIONS');
          console.log('   This means either:');
          console.log('   1. No meals logged in the last 12 hours, OR');
          console.log('   2. All meals have been fully absorbed (>7 hours old)');
        }
      } else {
        console.log('❌ MOB data is NULL - API call failed or returned no data');
      }

      // 🔍 DETAILED IOB DEBUG LOGGING
      console.log('');
      console.log('━'.repeat(80));
      console.log('💉 INSULIN ON BOARD (IOB) DATA - DETAILED BREAKDOWN');
      console.log('━'.repeat(80));

      if (insulin) {
        console.log('📊 IOB Summary:');
        console.log('  Total Active Insulin:', insulin.total_active_insulin, 'units');
        console.log('  Active Doses:', insulin.active_doses);
        console.log('  Calculation Time:', insulin.calculation_time);
        console.log('  Calculation Timezone:', insulin.calculation_timezone);

        if (insulin.insulin_contributions && insulin.insulin_contributions.length > 0) {
          console.log('');
          console.log('💉 Individual Insulin Contributions:');
          insulin.insulin_contributions.forEach((contrib, idx) => {
            console.log(`  Dose ${idx + 1}:`);
            console.log('    Medication:', contrib.medication);
            console.log('    Initial Dose:', contrib.initial_dose, 'units');
            console.log('    Active Units:', contrib.active_units, 'units');
            console.log('    Taken At:', contrib.taken_at);
            console.log('    Hours Since Dose:', contrib.hours_since_dose);
            console.log('    Activity %:', contrib.activity_percent, '%');

            const doseTime = new Date(contrib.taken_at);
            console.log('    ⏱️  Dose given at:', doseTime.toLocaleString());
            console.log('');
          });
        } else {
          console.log('');
          console.log('⚠️  NO ACTIVE INSULIN CONTRIBUTIONS');
        }
      } else {
        console.log('❌ IOB data is NULL - API call failed or returned no data');
      }

      // 🔍 RECENT MEALS DEBUG
      console.log('');
      console.log('━'.repeat(80));
      console.log('📋 RECENT MEALS LIST');
      console.log('━'.repeat(80));
      console.log('Total meals fetched:', meals.meals.length);

      if (meals.meals.length > 0) {
        meals.meals.forEach((meal, idx) => {
          console.log(`Meal ${idx + 1}:`);
          console.log('  ID:', meal.id);
          console.log('  Type:', meal.mealType);
          console.log('  Timestamp:', meal.timestamp);
          console.log('  Logged at:', new Date(meal.timestamp).toLocaleString());

          const mealTime = new Date(meal.timestamp);
          const now = new Date();
          const hoursSince = (now.getTime() - mealTime.getTime()) / (1000 * 60 * 60);
          console.log('  ⏱️  Hours ago:', hoursSince.toFixed(2));

          if (meal.foodItems && meal.foodItems.length > 0) {
            const totalCarbs = meal.foodItems.reduce((sum, item) => sum + (item.carbs || 0), 0);
            console.log('  Total Carbs:', totalCarbs, 'g');
          }
          console.log('');
        });
      } else {
        console.log('⚠️  No recent meals found');
      }

      console.log('');
      console.log('━'.repeat(80));
      console.log('✅ Dashboard Data Fetch Complete');
      console.log('━'.repeat(80));
      console.log('Summary:');
      console.log('  Meals:', meals.meals.length);
      console.log('  IOB:', insulin?.total_active_insulin || 0, 'units');
      console.log('  MOB:', mob?.total_active_carbs || 0, 'g');
      console.log('  Timing:', timing?.safety || 'unknown');
      console.log('  Baseline:', estimatedBG?.value || 'calculating', 'mg/dL');
      console.log('  BG Source:', estimatedBG?.source || 'unknown');
      console.log('='.repeat(80));
      console.log('');

      setLastFetchTime(fetchStartTime);
      setRecentMeals(meals.meals);
      setActiveInsulin(insulin);
      setMealOnBoard(mob);
      setMealTiming(timing);
    } catch (error) {
      console.error('❌ Error loading dashboard data:', error);
    } finally {
      setIsLoadingData(false);
    }
  }, [estimatedBG, recentReadings, combinedData, user]);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    console.log('🔄 Manual refresh triggered at:', new Date().toISOString());
    await Promise.all([loadDashboardData(), refreshBGEstimation()]);
    setRefreshing(false);
  }, [loadDashboardData, refreshBGEstimation]);

  const handleLogMeal = () => router.push('/(app)/log/meal');
  const handleLogGlucose = () => router.push('/(app)/log/glucose');
  const handleLogInsulin = () => router.push('/(app)/log/insulin');
  const handleLogActivity = () => router.push('/(app)/log/activity');
  const handleViewHistory = () => router.push('/(app)/(tabs)/history');
  const handleViewVisualization = () => router.push('/(app)/(tabs)/profile');

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} />
        }
      >
        {/* Welcome Section */}
        <View style={styles.welcomeSection}>
          <Text style={styles.greeting}>
            Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}
          </Text>
          <Text style={styles.userName}>{user?.firstName || 'User'}</Text>
          <Text style={styles.debugMode}>🔍 DEBUG MODE ACTIVE</Text>
        </View>

        {/* 🔍 ENHANCED DEBUG PANEL - ALWAYS VISIBLE */}
        <Card variant="outlined" padding="medium" style={styles.enhancedDebugCard}>
          <TouchableOpacity onPress={() => setDebugExpanded(!debugExpanded)}>
            <View style={styles.debugHeader}>
              <Text style={styles.debugHeaderTitle}>
                🔍 MOB/IOB DEBUG PANEL {debugExpanded ? '▼' : '▶'}
              </Text>
              <Text style={styles.debugHeaderSubtitle}>
                Tap to {debugExpanded ? 'collapse' : 'expand'}
              </Text>
            </View>
          </TouchableOpacity>

          {debugExpanded && (
            <>
              {/* Current Time Info */}
              <View style={styles.debugSection}>
                <Text style={styles.debugSectionTitle}>⏰ Time Information</Text>
                <Text style={styles.debugText}>Local Time: {new Date().toLocaleString()}</Text>
                <Text style={styles.debugText}>UTC Time: {new Date().toISOString()}</Text>
                <Text style={styles.debugText}>Last Fetch: {lastFetchTime || 'Not yet fetched'}</Text>
                <Text style={styles.debugText}>
                  Fetch Age: {lastFetchTime
                    ? `${Math.round((Date.now() - new Date(lastFetchTime).getTime()) / 1000)}s ago`
                    : 'N/A'}
                </Text>
              </View>

              {/* MOB Debug Section */}
              <View style={styles.debugSection}>
                <Text style={styles.debugSectionTitle}>🍽️ Meal On Board (MOB)</Text>
                <Text style={[styles.debugValue, { color: colors.warning }]}>
                  {mealOnBoard?.total_active_carbs?.toFixed(1) || '0.0'}g
                </Text>
                <Text style={styles.debugText}>
                  Active Meals: {mealOnBoard?.active_meal_count || 0}
                </Text>
                <Text style={styles.debugText}>
                  Absorbed Carbs: {mealOnBoard?.total_absorbed_carbs?.toFixed(1) || '0.0'}g
                </Text>
                <Text style={styles.debugText}>
                  Current BG Impact: +{mealOnBoard?.current_bg_elevation?.toFixed(0) || '0'} mg/dL
                </Text>
                <Text style={styles.debugText}>
                  Pending BG Rise: +{mealOnBoard?.pending_bg_rise?.toFixed(0) || '0'} mg/dL
                </Text>
                <Text style={styles.debugText}>
                  Calc Time: {mealOnBoard?.calculation_time
                    ? new Date(TimeManager.parseTimestamp(mealOnBoard.calculation_time)).toLocaleString()
                    : 'N/A'}
                </Text>

                {/* Individual Meal Contributions */}
                {mealOnBoard?.contributions && mealOnBoard.contributions.length > 0 && (
                  <View style={styles.contributionsSection}>
                    <Text style={styles.debugSubtitle}>📊 Meal Breakdown:</Text>
                    {mealOnBoard.contributions.map((contrib, idx) => {
                      // Use TimeManager to parse UTC ISO string correctly
                      const timestamp = TimeManager.parseTimestamp(contrib.meal_time);
                      const mealTime = new Date(timestamp);
                      const hoursSince = (Date.now() - mealTime.getTime()) / (1000 * 60 * 60);
                      const isFullyAbsorbed = (contrib.active_carbs || contrib.mob || 0) === 0;

                      return (
                        <View key={idx} style={styles.contributionItem}>
                          <Text style={styles.contributionHeader}>
                            {contrib.meal_type} - {mealTime.toLocaleTimeString()}
                          </Text>
                          <Text style={styles.debugText}>
                            ⏱️ {hoursSince.toFixed(1)}h ago
                          </Text>
                          <Text style={styles.debugText}>
                            Total: {contrib.total_carbs}g | Active: {contrib.active_carbs || contrib.mob || 0}g
                          </Text>
                          <Text style={styles.debugText}>
                            Absorbed: {contrib.absorbed_carbs}g ({contrib.absorbed_percent || contrib.activity_percent}%)
                          </Text>
                          <Text style={styles.debugText}>
                            Type: {contrib.absorption_type} | Remaining: {contrib.duration_remaining}h
                          </Text>
                          {isFullyAbsorbed && (
                            <Text style={[styles.debugText, { color: colors.success, fontWeight: 'bold' }]}>
                              ✅ FULLY ABSORBED (This is why MOB = 0)
                            </Text>
                          )}
                        </View>
                      );
                    })}
                  </View>
                )}

                {mealOnBoard?.active_meal_count === 0 && (
                  <Text style={[styles.debugText, { color: colors.warning, fontStyle: 'italic' }]}>
                    ⚠️ No active meals - either none logged in last 12h or all fully absorbed
                  </Text>
                )}
              </View>

              {/* IOB Debug Section */}
              <View style={styles.debugSection}>
                <Text style={styles.debugSectionTitle}>💉 Insulin On Board (IOB)</Text>
                <Text style={[styles.debugValue, { color: colors.secondary }]}>
                  {activeInsulin?.total_active_insulin?.toFixed(2) || '0.00'}u
                </Text>
                <Text style={styles.debugText}>
                  Active Doses: {activeInsulin?.active_doses || 0}
                </Text>
                <Text style={styles.debugText}>
                  Calc Time: {activeInsulin?.calculation_time
                    ? new Date(TimeManager.parseTimestamp(activeInsulin.calculation_time)).toLocaleString()
                    : 'N/A'}
                </Text>

                {/* Individual Insulin Contributions */}
                {activeInsulin?.insulin_contributions && activeInsulin.insulin_contributions.length > 0 && (
                  <View style={styles.contributionsSection}>
                    <Text style={styles.debugSubtitle}>📊 Insulin Breakdown:</Text>
                    {activeInsulin.insulin_contributions.map((contrib, idx) => {
                      // Use TimeManager to parse UTC ISO string correctly
                      const timestamp = TimeManager.parseTimestamp(contrib.taken_at);
                      const doseTime = new Date(timestamp);

                      return (
                        <View key={idx} style={styles.contributionItem}>
                          <Text style={styles.contributionHeader}>
                            {contrib.medication} - {doseTime.toLocaleTimeString()}
                          </Text>
                          <Text style={styles.debugText}>
                            ⏱️ {contrib.hours_since_dose.toFixed(1)}h ago
                          </Text>
                          <Text style={styles.debugText}>
                            Initial: {contrib.initial_dose}u | Active: {contrib.active_units}u
                          </Text>
                          <Text style={styles.debugText}>
                            Activity: {contrib.activity_percent}%
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>

              {/* Recent Meals Preview */}
              <View style={styles.debugSection}>
                <Text style={styles.debugSectionTitle}>📋 Recent Meals in Database</Text>
                <Text style={styles.debugText}>Found: {recentMeals.length} meals</Text>
                {recentMeals.slice(0, 3).map((meal, idx) => {
                  // Use TimeManager to parse UTC ISO string correctly
                  const timestamp = TimeManager.parseTimestamp(meal.timestamp);
                  const mealTime = new Date(timestamp);
                  const hoursSince = (Date.now() - mealTime.getTime()) / (1000 * 60 * 60);

                  return (
                    <View key={idx} style={styles.mealPreviewItem}>
                      <Text style={styles.debugText}>
                        {idx + 1}. {meal.mealType} - {mealTime.toLocaleString()}
                      </Text>
                      <Text style={[styles.debugText, { fontSize: 11 }]}>
                        ({hoursSince.toFixed(1)}h ago)
                      </Text>
                    </View>
                  );
                })}
              </View>

              {/* Baseline Info */}
              <View style={styles.debugSection}>
                <Text style={styles.debugSectionTitle}>📊 Baseline Glucose</Text>
                <Text style={[styles.debugValue, {
                  color: estimatedBG && estimatedBG.value > 130 ? colors.danger
                    : estimatedBG && estimatedBG.value < 70 ? colors.warning
                    : colors.success
                }]}>
                  {estimatedBG?.value?.toFixed(0) || 'N/A'} mg/dL
                </Text>
                <Text style={styles.debugText}>Source: {estimatedBG?.source || 'unknown'}</Text>
                <Text style={styles.debugText}>Confidence: {estimatedBG?.confidence || 'unknown'}</Text>
                <Text style={styles.debugText}>Readings (24h): {recentReadings.length}</Text>
              </View>
            </>
          )}
        </Card>

        {/* Active Effects Display - UNIFIED VERSION with estimatedBG */}
        <ActiveEffectsDisplay
          iobData={activeInsulin}
          mobData={mealOnBoard}
          estimatedBG={estimatedBG}
          timingAssessment={mealTiming}
          correctionFactor={constants?.correction_factor ?? 50}
          isLoading={isLoadingData || bgEstimationLoading}
          compact={false}
          onRefresh={onRefresh}
        />

        {/* BG Estimation Status */}
        {estimatedBG && estimatedBG.source !== 'loading' && (
          <Card variant="filled" padding="small" style={styles.bgStatusCard}>
            <View style={styles.bgStatusRow}>
              <Text style={styles.bgStatusLabel}>Baseline Source:</Text>
              <View style={styles.bgStatusBadge}>
                <Text
                  style={[
                    styles.bgStatusText,
                    {
                      color:
                        estimatedBG.confidence === 'high'
                          ? colors.success
                          : estimatedBG.confidence === 'medium'
                          ? colors.warning
                          : colors.text.secondary,
                    },
                  ]}
                >
                  {estimatedBG.source === 'actual'
                    ? '🎯 Current Reading'
                    : estimatedBG.source === 'last_actual'
                    ? '📍 Recent Reading'
                    : estimatedBG.source === 'estimated'
                    ? '📈 Estimated'
                    : estimatedBG.source === 'target'
                    ? '🎯 Target Glucose'
                    : '⏳ Calculating...'}
                </Text>
              </View>
            </View>
            {estimatedBG.confidence !== 'high' && estimatedBG.source !== 'target' && (
              <Text style={styles.bgStatusHint}>
                💡 Take a blood sugar reading for more accurate predictions
              </Text>
            )}

            <View style={styles.dataQualityRow}>
              <Text style={styles.dataQualityLabel}>
                📊 {recentReadings.length} readings (24h)
              </Text>
              <Text style={styles.dataQualityLabel}>
                📈 {combinedData.length} data points
              </Text>
            </View>
          </Card>
        )}

        {/* Quick Actions */}
        <QuickActions
          onLogMeal={handleLogMeal}
          onLogGlucose={handleLogGlucose}
          onLogInsulin={handleLogInsulin}
          onLogActivity={handleLogActivity}
        />

        {/* Recent Meals */}
        <RecentMeals
          meals={recentMeals}
          onMealPress={(meal) => router.push(`/(app)/meal/${meal.id}`)}
          onViewAll={handleViewHistory}
          isLoading={isLoadingData}
        />

        {/* Target Info */}
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

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
  },
  content: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  welcomeSection: {
    marginBottom: spacing.lg,
  },
  greeting: {
    ...typography.body,
    color: colors.text.secondary,
  },
  userName: {
    ...typography.h1,
    color: colors.text.primary,
  },
  debugMode: {
    ...typography.small,
    color: colors.danger,
    fontWeight: 'bold',
    marginTop: spacing.xs,
  },
  enhancedDebugCard: {
    marginBottom: spacing.md,
    backgroundColor: '#FFF3CD',
    borderColor: colors.warning,
    borderWidth: 2,
  },
  debugHeader: {
    marginBottom: spacing.sm,
  },
  debugHeaderTitle: {
    ...typography.h3,
    color: colors.text.primary,
    fontWeight: 'bold',
  },
  debugHeaderSubtitle: {
    ...typography.caption,
    color: colors.text.secondary,
    fontStyle: 'italic',
  },
  debugSection: {
    marginTop: spacing.md,
    padding: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
  },
  debugSectionTitle: {
    ...typography.body,
    fontWeight: 'bold',
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  debugSubtitle: {
    ...typography.small,
    fontWeight: '600',
    color: colors.text.primary,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  debugValue: {
    fontSize: 24,
    fontWeight: 'bold',
    marginVertical: spacing.xs,
  },
  debugText: {
    ...typography.small,
    color: colors.text.secondary,
    fontFamily: 'monospace',
    marginVertical: 2,
  },
  contributionsSection: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  contributionItem: {
    padding: spacing.sm,
    marginVertical: spacing.xs,
    backgroundColor: colors.background,
    borderRadius: 6,
    borderLeftWidth: 3,
    borderLeftColor: colors.secondary,
  },
  contributionHeader: {
    ...typography.small,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: 4,
  },
  mealPreviewItem: {
    marginVertical: 2,
  },
  bgStatusCard: {
    marginBottom: spacing.md,
  },
  bgStatusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  bgStatusLabel: {
    ...typography.small,
    color: colors.text.secondary,
  },
  bgStatusBadge: {
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: 12,
    backgroundColor: colors.background,
  },
  bgStatusText: {
    ...typography.small,
    fontWeight: '600',
  },
  bgStatusHint: {
    ...typography.caption,
    color: colors.text.secondary,
    marginTop: spacing.xs,
    fontStyle: 'italic',
  },
  dataQualityRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  dataQualityLabel: {
    ...typography.caption,
    color: colors.text.secondary,
  },
  targetCard: {
    marginTop: spacing.md,
  },
  targetRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  targetItem: {
    alignItems: 'center',
    flex: 1,
  },
  targetValue: {
    ...typography.h3,
    color: colors.text.primary,
  },
  targetLabel: {
    ...typography.small,
    color: colors.text.secondary,
    marginTop: 2,
  },
  targetDivider: {
    width: 1,
    height: 40,
    backgroundColor: colors.border,
  },
});