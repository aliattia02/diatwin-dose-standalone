/**
 * History Tab Screen
 * Location: mobile/app/(app)/(tabs)/history.tsx
 *
 * Features:
 * - Multi-type filtering (all, meals, glucose, insulin, activities)
 * - Proper sorting using Unix timestamps for accuracy
 * - Pull-to-refresh and infinite scroll
 * - Filters out non-meal entries (insulin_only, activity_only)
 * - Data source badges for item categorization
 * - Per-item delete — inline confirm row (cross-platform, no Alert.alert)
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card, Loading, Button } from '@/components/ui';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import { getMeals } from '@/services/api/meals';
import { getReadings } from '@/services/api/glucose';
import { getDoses } from '@/services/api/insulin';
import { getActivityHistory } from '@/services/api/activities';
import { getGlucoseStatus } from '@/services/api/glucose';
import { TimeManager } from '@/utils/time';
import apiClient from '@/services/api/client';
import API from '@/services/api/endpoints';
import type { MealResponse, BloodSugarResponse, InsulinLogResponse } from '@/types/api';
import type { ActivityHistoryResponse } from '@/services/api/activities';

type FilterType = 'all' | 'meals' | 'glucose' | 'insulin' | 'activities';

interface HistoryItem {
  id: string;
  type: 'meal' | 'glucose' | 'insulin' | 'activity';
  timestamp: string;
  sortTimestamp: number;
  dataSource: string;
  data: MealResponse | BloodSugarResponse | InsulinLogResponse | ActivityHistoryResponse;
}

const FILTERS: { id: FilterType; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'meals', label: 'Meals' },
  { id: 'glucose', label: 'Glucose' },
  { id: 'insulin', label: 'Insulin' },
  { id: 'activities', label: 'Activities' },
];

// ─── Delete helpers ───────────────────────────────────────────────────────────

function getRawId(item: HistoryItem): string {
  switch (item.type) {
    case 'meal':     return (item.data as MealResponse).id;
    case 'glucose':  return (item.data as BloodSugarResponse)._id ?? item.id.replace('glucose-', '');
    case 'insulin':  return (item.data as InsulinLogResponse).id ?? item.id.replace('insulin-', '');
    case 'activity': return (item.data as ActivityHistoryResponse).id;
    default:         return item.id;
  }
}

/**
 * Maps each type to its DELETE endpoint (all exist in patient_routes.py):
 *   meal     → DELETE /api/meal/<id>
 *   glucose  → DELETE /api/blood-sugar/<id>
 *   insulin  → DELETE /api/insulin/log/<id>
 *   activity → DELETE /api/activity/<id>
 */
function getDeleteEndpoint(item: HistoryItem): string {
  const id = getRawId(item);
  switch (item.type) {
    case 'meal':     return API.MEALS.DELETE(id);
    case 'glucose':  return API.BLOOD_SUGAR.DELETE(id);
    case 'insulin':  return API.INSULIN.DELETE_LOG(id);
    case 'activity': return API.ACTIVITIES.DELETE(id);
  }
}

function getDeleteLabel(type: HistoryItem['type']): string {
  switch (type) {
    case 'meal':     return 'meal entry';
    case 'glucose':  return 'glucose reading';
    case 'insulin':  return 'insulin dose';
    case 'activity': return 'activity';
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export default function HistoryScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterType>('all');
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId,   setDeletingId]   = useState<string | null>(null);
  const [deleteError,  setDeleteError]  = useState<string | null>(null);

  const loadData = useCallback(async (reset = false) => {
    if (!reset && !hasMore) return;
    try {
      const currentPage = reset ? 0 : page;
      const limit = 20;
      const skip  = currentPage * limit;
      let newItems: HistoryItem[] = [];

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const startDate = thirtyDaysAgo.toISOString().split('T')[0];
      const endDate   = new Date().toISOString().split('T')[0];

      if (filter === 'all' || filter === 'meals') {
        const mealsData = await getMeals({ limit, skip });
        const actualMeals = mealsData.meals.filter((m) => {
          const hasFoodItems = m.foodItems && Array.isArray(m.foodItems) && m.foodItems.length > 0;
          return hasFoodItems && m.mealType !== 'insulin_only' && m.mealType !== 'activity_only';
        });
        newItems = [
          ...newItems,
          ...actualMeals.map((m) => {
            const displayTime = m.mealTime || m.timestamp;
            return {
              id: `meal-${m.id}`,
              type: 'meal' as const,
              timestamp: displayTime,
              sortTimestamp: new Date(displayTime).getTime(),
              dataSource: 'Meals Database',
              data: m,
            };
          }),
        ];
        console.log(`[History] ✅ Loaded ${actualMeals.length} meals`);
      }

      if (filter === 'all' || filter === 'glucose') {
        const readings = await getReadings({ start_date: startDate, end_date: endDate, filter_by: 'reading_time' });
        newItems = [
          ...newItems,
          ...readings.map((r) => {
            const displayTime = r.bloodSugarTimestamp || r.timestamp;
            return {
              id: `glucose-${r._id}`,
              type: 'glucose' as const,
              timestamp: displayTime,
              sortTimestamp: new Date(displayTime).getTime(),
              dataSource: 'Blood Sugar Log',
              data: r,
            };
          }),
        ];
        console.log(`[History] ✅ Loaded ${readings.length} glucose readings`);
      }

      if (filter === 'all' || filter === 'insulin') {
        const insulinData = await getDoses({ days: 30 });
        newItems = [
          ...newItems,
          ...insulinData.insulin_logs.map((d) => ({
            id: `insulin-${d.id}`,
            type: 'insulin' as const,
            timestamp: d.taken_at,
            sortTimestamp: new Date(d.taken_at).getTime(),
            dataSource: 'Medication Log',
            data: d,
          })),
        ];
        console.log(`[History] ✅ Loaded ${insulinData.insulin_logs.length} insulin doses`);
      }

      if (filter === 'all' || filter === 'activities') {
        const activitiesData = await getActivityHistory({ start_date: startDate, end_date: endDate });
        newItems = [
          ...newItems,
          ...activitiesData.map((a) => {
            const displayTime = a.startTime || a.timestamp;
            return {
              id: `activity-${a.id}`,
              type: 'activity' as const,
              timestamp: displayTime,
              sortTimestamp: new Date(displayTime).getTime(),
              dataSource: 'Activity Log',
              data: a,
            };
          }),
        ];
        console.log(`[History] ✅ Loaded ${activitiesData.length} activities`);
      }

      newItems.sort((a, b) => b.sortTimestamp - a.sortTimestamp);

      if (reset) {
        setItems(newItems);
        setPage(1);
      } else {
        setItems((prev) => [...prev, ...newItems]);
        setPage((prev) => prev + 1);
      }
      setHasMore(newItems.length === limit);
    } catch (error) {
      console.error('[History] Error loading history:', error);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, [filter, page, hasMore]);

  useEffect(() => {
    setIsLoading(true);
    setItems([]);
    setPage(0);
    setHasMore(true);
    loadData(true);
  }, [filter]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setItems([]);
    setPage(0);
    setHasMore(true);
    loadData(true);
  }, [loadData]);

  // ─── Delete flow ─────────────────────────────────────────────────────────────

  const handleDeletePress = useCallback((item: HistoryItem) => {
    setDeleteError(null);
    setConfirmingId(item.id);
  }, []);

  const handleDeleteCancel = useCallback(() => {
    setConfirmingId(null);
    setDeleteError(null);
  }, []);

  const handleDeleteConfirm = useCallback(async (item: HistoryItem) => {
    setDeletingId(item.id);
    setDeleteError(null);
    try {
      await apiClient.delete(getDeleteEndpoint(item));
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setConfirmingId(null);
    } catch (error: any) {
      const msg =
        error?.response?.data?.error ||
        error?.message ||
        'Delete failed. Please try again.';
      setDeleteError(msg);
    } finally {
      setDeletingId(null);
    }
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────

  const formatDate = (timestamp: string) => TimeManager.formatDateTimeDisplay(timestamp);

  const getItemIcon = (type: string) => {
    switch (type) {
      case 'meal':     return '🍽️';
      case 'glucose':  return '🩸';
      case 'insulin':  return '💉';
      case 'activity': return '🏃';
      default:         return '•';
    }
  };

  const renderItem = ({ item }: { item: HistoryItem }) => {
    const isConfirming = confirmingId === item.id;
    const isDeleting   = deletingId   === item.id;

    const renderContent = () => {
      switch (item.type) {
        case 'meal': {
          const meal = item.data as MealResponse;
          const foodNames   = meal.foodItems.slice(0, 2).map((f) => f.name).join(', ');
          const hasMoreFood = meal.foodItems.length > 2;
          return (
            <>
              <Text style={styles.itemTitle}>{meal.mealType} meal</Text>
              <Text style={styles.itemSubtitle} numberOfLines={1}>
                {foodNames}{hasMoreFood ? ` +${meal.foodItems.length - 2} more` : ''}
              </Text>
              {meal.nutrition && (
                <View style={styles.itemStats}>
                  {meal.nutrition.calories != null && (
                    <Text style={styles.itemStat}>{Math.round(meal.nutrition.calories)} kcal</Text>
                  )}
                  {meal.nutrition.carbs != null && (
                    <>
                      <Text style={styles.itemStat}>•</Text>
                      <Text style={styles.itemStat}>{Math.round(meal.nutrition.carbs)}g carbs</Text>
                    </>
                  )}
                </View>
              )}
              {meal.intendedInsulin != null && (
                <Text style={styles.itemContext}>Insulin: {meal.intendedInsulin} U</Text>
              )}
              {meal.notes ? <Text style={styles.itemNotes} numberOfLines={1}>{meal.notes}</Text> : null}
            </>
          );
        }

        case 'glucose': {
          const reading = item.data as BloodSugarResponse;
          const status = getGlucoseStatus(reading.bloodSugar);
          const statusColor =
            status === 'normal'                        ? colors.success :
            status === 'high' || status === 'veryHigh' ? colors.error   :
            colors.warning;
          return (
            <>
              <Text style={[styles.glucoseValue, { color: statusColor }]}>{reading.bloodSugar} mg/dL</Text>
              <Text style={[styles.itemStatus, { color: statusColor }]}>{status}</Text>
              {reading.notes ? <Text style={styles.itemNotes} numberOfLines={1}>{reading.notes}</Text> : null}
            </>
          );
        }

        case 'insulin': {
          const dose = item.data as InsulinLogResponse;
          return (
            <>
              <Text style={styles.insulinDose}>{dose.dose} U</Text>
              <Text style={styles.itemSubtitle}>{dose.medication}</Text>
              {dose.meal_type ? <Text style={styles.itemContext}>With {dose.meal_type}</Text> : null}
              {dose.notes ? <Text style={styles.itemNotes} numberOfLines={1}>{dose.notes}</Text> : null}
            </>
          );
        }

        case 'activity': {
          const activity = item.data as ActivityHistoryResponse;
          const impactColor =
            activity.impact > 1 ? colors.warning :
            activity.impact < 1 ? colors.success :
            colors.text.secondary;
          return (
            <>
              <Text style={styles.itemTitle}>Activity</Text>
              <Text style={styles.itemSubtitle}>{activity.levelLabel} • {activity.type}</Text>
              <View style={styles.itemStats}>
                <Text style={styles.itemStat}>Duration: {activity.duration || '0h 0m'}</Text>
                <Text style={styles.itemStat}>•</Text>
                <Text style={[styles.itemStat, { color: impactColor }]}>
                  {activity.impact !== 1
                    ? `${Math.abs((activity.impact - 1) * 100).toFixed(0)}% ${activity.impact > 1 ? 'increase' : 'decrease'}`
                    : 'No impact'}
                </Text>
              </View>
              {activity.notes ? <Text style={styles.itemNotes} numberOfLines={1}>{activity.notes}</Text> : null}
            </>
          );
        }
      }
    };

    return (
      <Card
        variant="outlined"
        padding="medium"
        style={[styles.itemCard, isConfirming && styles.itemCardConfirming]}
        onPress={() => {
          if (isConfirming) return;
          if (item.type === 'meal') router.push(`/(app)/meal/${(item.data as MealResponse).id}`);
        }}
      >
        {/* ── Header row ── */}
        <View style={styles.itemHeader}>
          <View style={styles.itemHeaderLeft}>
            <Text style={styles.itemIcon}>{getItemIcon(item.type)}</Text>
            <View style={styles.dataSourceBadge}>
              <Text style={styles.dataSourceText}>{item.dataSource}</Text>
            </View>
          </View>
          <View style={styles.itemHeaderRight}>
            <Text style={styles.itemTime}>{formatDate(item.timestamp)}</Text>
            <TouchableOpacity
              style={[styles.deleteButton, isConfirming && styles.deleteButtonActive]}
              onPress={() => isConfirming ? handleDeleteCancel() : handleDeletePress(item)}
              disabled={isDeleting}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              {isDeleting ? (
                <ActivityIndicator size="small" color={colors.error} />
              ) : (
                <Text style={styles.deleteIcon}>{isConfirming ? '✕' : '🗑️'}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {renderContent()}

        {/* ── Inline confirm strip ── */}
        {isConfirming && (
          <View style={styles.confirmRow}>
            <Text style={styles.confirmText}>
              Delete this {getDeleteLabel(item.type)} permanently?
            </Text>
            {deleteError ? <Text style={styles.confirmError}>{deleteError}</Text> : null}
            <View style={styles.confirmButtons}>
              <Button
                title="Cancel"
                variant="outline"
                size="medium"
                fullWidth
                onPress={handleDeleteCancel}
                disabled={isDeleting}
              />
              <Button
                title="Delete"
                variant="danger"
                size="medium"
                fullWidth
                loading={isDeleting}
                onPress={() => handleDeleteConfirm(item)}
                disabled={isDeleting}
              />
            </View>
          </View>
        )}
      </Card>
    );
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <View style={styles.filterContainer}>
        {FILTERS.map((f) => (
          <TouchableOpacity
            key={f.id}
            style={[styles.filterButton, filter === f.id && styles.filterButtonActive]}
            onPress={() => setFilter(f.id)}
          >
            <Text style={[styles.filterText, filter === f.id && styles.filterTextActive]}>{f.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {isLoading && items.length === 0 ? (
        <Loading text="Loading history..." />
      ) : items.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyIcon}>📊</Text>
          <Text style={styles.emptyTitle}>No entries yet</Text>
          <Text style={styles.emptyText}>
            {filter === 'all' ? 'Start logging to see your history here' : `No ${filter} entries found`}
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} />
          }
          onEndReached={() => hasMore && loadData()}
          onEndReachedThreshold={0.5}
          ListFooterComponent={hasMore && items.length > 0 ? <Loading size="small" /> : null}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  filterContainer: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    padding: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  filterButton: { flex: 1, paddingVertical: spacing.sm, alignItems: 'center', borderRadius: borderRadius.md },
  filterButtonActive: { backgroundColor: colors.primary },
  filterText: { ...typography.body, color: colors.text.secondary, fontSize: 12 },
  filterTextActive: { color: colors.text.inverse, fontWeight: '600' },
  listContent: { padding: spacing.md },
  itemCard: { marginBottom: spacing.sm },
  itemCardConfirming: { borderColor: colors.error, borderWidth: 1.5 },
  itemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  itemHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flex: 1 },
  itemHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexShrink: 0 },
  itemIcon: { fontSize: 20 },
  dataSourceBadge: {
    backgroundColor: colors.primary + '15',
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  dataSourceText: { fontSize: 10, color: colors.primary, fontWeight: '600' },
  itemTime: { ...typography.small, color: colors.text.secondary },
  deleteButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.sm,
    backgroundColor: colors.error + '15',
  },
  deleteButtonActive: { backgroundColor: colors.error + '30' },
  deleteIcon: { fontSize: 14 },
  // ── Inline confirm ──────────────────────────────────────────────────────────
  confirmRow: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.error + '40',
  },
  confirmText: { ...typography.body, color: colors.error, fontWeight: '600', marginBottom: spacing.xs },
  confirmError: { ...typography.small, color: colors.error, marginBottom: spacing.xs },
  confirmButtons: { flexDirection: 'column', gap: spacing.sm, marginTop: spacing.xs },
  confirmCancelBtn: {},
  confirmCancelText: {},
  confirmDeleteBtn: {},
  confirmDeleteBtnDisabled: { opacity: 0.6 },
  confirmDeleteText: {},
  // ───────────────────────────────────────────────────────────────────────────
  itemTitle: { ...typography.body, color: colors.text.primary, fontWeight: '600', textTransform: 'capitalize' },
  itemSubtitle: { ...typography.caption, color: colors.text.secondary, marginTop: 2 },
  itemStats: { flexDirection: 'row', gap: spacing.xs, marginTop: spacing.xs, flexWrap: 'wrap', alignItems: 'center' },
  itemStat: { ...typography.small, color: colors.text.secondary },
  glucoseValue: { ...typography.h3, marginTop: spacing.xs, fontWeight: '700' },
  itemStatus: { ...typography.caption, fontWeight: '500', textTransform: 'capitalize', marginTop: 2 },
  insulinDose: { ...typography.h3, color: colors.secondary, marginTop: spacing.xs, fontWeight: '700' },
  itemContext: { ...typography.small, color: colors.text.secondary, marginTop: spacing.xs, fontStyle: 'italic' },
  itemNotes: { ...typography.small, color: colors.text.secondary, marginTop: spacing.xs, fontStyle: 'italic' },
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyIcon: { fontSize: 64, marginBottom: spacing.md },
  emptyTitle: { ...typography.h3, color: colors.text.primary, marginBottom: spacing.sm },
  emptyText: { ...typography.body, color: colors.text.secondary, textAlign: 'center' },
});