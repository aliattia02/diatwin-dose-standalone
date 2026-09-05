/**
 * Patient Data View Component
 * Location: mobile/components/doctor/PatientDataView.tsx
 *
 * Tabs:
 *  - Overview:    Summary stats, active conditions/medications at a glance
 *  - Charts:      BG chart + meal-effects pharmacodynamics chart
 *  - Blood Sugar: Readings list with avg/TIR stats header + date-range filter ← UPDATED
 *  - Insulin:     Dose history with totals header                              ← NEW
 *  - Meals:       Meal history with nutrition averages header
 *  - Activities:  Activity log
 *  - Settings:    Edit patient constants, manage conditions & medications
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'expo-router';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  TextInput,
  Alert,
  Platform,
  Switch,
} from 'react-native';

import { Card } from '@/components/ui';
import { DoctorBGChart } from './DoctorBGChart';
import { DoctorEffectsChart } from './DoctorEffectsChart';
import { DoctorBGVisualization } from './DoctorBGVisualization';

import {
  getDoctorPatientMeals,
  getPatientBloodSugar,
  getPatientActivities,
  getPatientConstants,
  getPatientInsulinDoses,
  updatePatientConstants,
  resetPatientConstants,
  updatePatientConditions,
  updatePatientMedications,
  type PatientConstantsData,
  type InsulinDoseResponse,
} from '@/services/api/doctor';

import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import type { DoctorPatient } from '@/services/api/doctor';
import type { MealResponse, BloodSugarResponse, ActivityResponse } from '@/types/api';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type TabType = 'overview' | 'charts' | 'bloodSugar' | 'insulin' | 'meals' | 'activities' | 'settings';

/** Days of BG history to show in the Blood Sugar tab */
type BGDaysFilter = 7 | 14 | 30;

interface PatientDataViewProps {
  patient: DoctorPatient;
  onBack?: () => void;
}

interface EditableConstants {
  insulin_to_carb_ratio: string;
  correction_factor: string;
  target_glucose: string;
  protein_factor: string;
  fat_factor: string;
  carb_to_bg_factor: string;
  baseline_mode: 'dynamic' | 'preset';
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const showConfirm = (
  title: string,
  message: string,
  onConfirm: () => void,
  destructive = false
) => {
  if (Platform.OS === 'web') {
    if (window.confirm(`${title}\n\n${message}`)) onConfirm();
  } else {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: destructive ? 'Reset' : 'Confirm', style: destructive ? 'destructive' : 'default', onPress: onConfirm },
    ]);
  }
};

const formatDate = (dateString: string) => {
  if (!dateString) return '—';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const getBloodSugarStatus = (value: number) => {
  if (value < 70)  return { label: 'Low',      color: colors.glucose?.low  ?? '#E53E3E' };
  if (value > 180) return { label: 'High',     color: colors.glucose?.high ?? '#DD6B20' };
  return              { label: 'In Range', color: colors.glucose?.normal ?? '#38A169' };
};

const computeBGStats = (readings: BloodSugarResponse[]) => {
  if (!readings.length) return null;
  const values = readings.map(r => r.bloodSugar).filter(Boolean);
  const avg    = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  const low    = values.filter(v => v < 70).length;
  const high   = values.filter(v => v > 180).length;
  const inRange = values.filter(v => v >= 70 && v <= 180).length;
  const tir    = Math.round((inRange / values.length) * 100);
  return { avg, low, high, inRange, tir, total: values.length };
};

const computeNutritionAverages = (meals: MealResponse[]) => {
  if (!meals.length) return null;
  const totals = meals.reduce(
    (acc, m) => ({
      carbs:    acc.carbs    + (m.nutrition?.carbs    ?? 0),
      protein:  acc.protein  + (m.nutrition?.protein  ?? 0),
      fat:      acc.fat      + (m.nutrition?.fat      ?? 0),
      calories: acc.calories + (m.nutrition?.calories ?? 0),
    }),
    { carbs: 0, protein: 0, fat: 0, calories: 0 }
  );
  const n = meals.length;
  return {
    carbs:    Math.round(totals.carbs / n),
    protein:  Math.round(totals.protein / n),
    fat:      Math.round(totals.fat / n),
    calories: Math.round(totals.calories / n),
  };
};

/** Total units and dose count from an insulin array */
const computeInsulinStats = (doses: InsulinDoseResponse[]) => {
  if (!doses.length) return null;
  const totalUnits = doses.reduce((s, d) => s + (d.units ?? 0), 0);
  const byType = doses.reduce<Record<string, { count: number; units: number }>>((acc, d) => {
    const key = d.insulinType ?? 'Unknown';
    if (!acc[key]) acc[key] = { count: 0, units: 0 };
    acc[key].count  += 1;
    acc[key].units  += d.units ?? 0;
    return acc;
  }, {});
  return { totalUnits: Math.round(totalUnits * 10) / 10, count: doses.length, byType };
};

const constantsToEditable = (c: PatientConstantsData): EditableConstants => ({
  insulin_to_carb_ratio: String(c.insulin_to_carb_ratio ?? ''),
  correction_factor:     String(c.correction_factor     ?? ''),
  target_glucose:        String(c.target_glucose        ?? ''),
  protein_factor:        String(c.protein_factor        ?? ''),
  fat_factor:            String(c.fat_factor            ?? ''),
  carb_to_bg_factor:     String(c.carb_to_bg_factor     ?? ''),
  baseline_mode:         ((c as any).baseline_mode      ?? 'dynamic') as 'dynamic' | 'preset',
});

/** Convert snake_case / hyphen-case keys to Title Case */
const formatLabel = (key: string) =>
  key
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

/** Format insulin type for display */
const formatInsulinType = (type: string) => {
  const map: Record<string, string> = {
    rapid_acting:       '⚡ Rapid-Acting',
    short_acting:       '🔵 Short-Acting',
    intermediate_acting:'🟡 Intermediate',
    long_acting:        '🔴 Long-Acting',
    ultra_long_acting:  '🟣 Ultra-Long',
  };
  return map[type] ?? formatLabel(type);
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const PatientDataView: React.FC<PatientDataViewProps> = ({ patient, onBack }) => {
  const [activeTab,  setActiveTab]  = useState<TabType>('overview');
  const [refreshing, setRefreshing] = useState(false);
  const [isLoading,  setIsLoading]  = useState(true);
  const [error,      setError]      = useState<string | null>(null);

  // Data
  const router = useRouter();
  const [meals,       setMeals]       = useState<MealResponse[]>([]);
  const [bloodSugar,  setBloodSugar]  = useState<BloodSugarResponse[]>([]);
  const [activities,  setActivities]  = useState<ActivityResponse[]>([]);
  const [constants,   setConstants]   = useState<PatientConstantsData | null>(null);
  const [insulinDoses, setInsulinDoses] = useState<InsulinDoseResponse[]>([]);

  // BG date-range filter state
  const [bgDays, setBgDays] = useState<BGDaysFilter>(14);

  // Settings editing state
  const [editableConstants,     setEditableConstants]     = useState<EditableConstants | null>(null);
  const [isSavingConstants,     setIsSavingConstants]     = useState(false);
  const [isResettingConstants,  setIsResettingConstants]  = useState(false);
  const [activeConditions,      setActiveConditions]      = useState<string[]>([]);
  const [activeMedications,     setActiveMedications]     = useState<string[]>([]);
  const [isSavingConditions,    setIsSavingConditions]    = useState(false);
  const [isSavingMedications,   setIsSavingMedications]  = useState(false);
  const [settingsFeedback, setSettingsFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // ── Data Loading ────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setError(null);
    try {
      // Fetch 31 days so the doctor's Week and Month chart views have enough data.
      // The chart's own rangeStart/rangeEnd window then filters down to whatever
      // the doctor selects (3h → month). Without this, only the backend default
      // (~24 h) is returned and all views longer than that appear empty.
      const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

      const [mealsData, bloodSugarData, activitiesData, constantsData, insulinData] = await Promise.all([
        getDoctorPatientMeals(patient.id, { limit: 200, start_time: thirtyOneDaysAgo }).catch(() => ({ meals: [] })),
        getPatientBloodSugar(patient.id, { start_time: thirtyOneDaysAgo }).catch(() => []),
        getPatientActivities(patient.id, { limit: 50 }).catch(() => []),
        getPatientConstants(patient.id).catch(() => null),
        getPatientInsulinDoses(patient.id, { limit: 100 }).catch(() => []),
      ]);

      setMeals(mealsData.meals ?? []);
      setBloodSugar(Array.isArray(bloodSugarData) ? bloodSugarData : []);
      setActivities(Array.isArray(activitiesData) ? activitiesData : []);
      setInsulinDoses(Array.isArray(insulinData) ? insulinData : []);

      if (constantsData) {
        setConstants(constantsData);
        setEditableConstants(constantsToEditable(constantsData));
        setActiveConditions(constantsData.active_conditions ?? patient.activeConditions ?? []);
        setActiveMedications(constantsData.active_medications ?? patient.activeMedications ?? []);
      } else {
        setActiveConditions(patient.activeConditions ?? []);
        setActiveMedications(patient.activeMedications ?? []);
      }
    } catch (err) {
      setError('Failed to load patient data');
      console.error('Error loading patient data:', err);
    } finally {
      setIsLoading(false);
    }
  }, [patient.id]);

  useEffect(() => {
    setIsLoading(true);
    loadData();
  }, [loadData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  // ── Settings Actions ────────────────────────────────────────────────────────

  const showFeedback = (type: 'success' | 'error', message: string) => {
    setSettingsFeedback({ type, message });
    setTimeout(() => setSettingsFeedback(null), 3000);
  };

  const handleSaveConstants = async () => {
    if (!editableConstants) return;
    setIsSavingConstants(true);
    try {
      const payload: Partial<PatientConstantsData> = {
        insulin_to_carb_ratio: parseFloat(editableConstants.insulin_to_carb_ratio),
        correction_factor:     parseFloat(editableConstants.correction_factor),
        target_glucose:        parseFloat(editableConstants.target_glucose),
        protein_factor:        parseFloat(editableConstants.protein_factor),
        fat_factor:            parseFloat(editableConstants.fat_factor),
        carb_to_bg_factor:     parseFloat(editableConstants.carb_to_bg_factor),
        baseline_mode:         editableConstants.baseline_mode,
      } as any;
      const updated = await updatePatientConstants(patient.id, payload);
      setConstants(updated);
      setEditableConstants(constantsToEditable(updated));
      showFeedback('success', 'Constants saved successfully');
    } catch (err: any) {
      showFeedback('error', err?.message ?? 'Failed to save constants');
    } finally {
      setIsSavingConstants(false);
    }
  };

  const handleResetConstants = () => {
    showConfirm(
      'Reset Constants',
      "Reset all of this patient's clinical constants to system defaults?",
      async () => {
        setIsResettingConstants(true);
        try {
          const reset = await resetPatientConstants(patient.id);
          setConstants(reset);
          setEditableConstants(constantsToEditable(reset));
          setActiveConditions(reset.active_conditions ?? []);
          setActiveMedications(reset.active_medications ?? []);
          showFeedback('success', 'Constants reset to defaults');
        } catch (err: any) {
          showFeedback('error', err?.message ?? 'Failed to reset constants');
        } finally {
          setIsResettingConstants(false);
        }
      },
      true
    );
  };

  const handleToggleCondition = async (condition: string) => {
    const next = activeConditions.includes(condition)
      ? activeConditions.filter(c => c !== condition)
      : [...activeConditions, condition];
    setActiveConditions(next);
    setIsSavingConditions(true);
    try {
      await updatePatientConditions(patient.id, next);
      showFeedback('success', 'Conditions updated');
    } catch (err: any) {
      setActiveConditions(activeConditions);
      showFeedback('error', err?.message ?? 'Failed to update conditions');
    } finally {
      setIsSavingConditions(false);
    }
  };

  const handleToggleMedication = async (medication: string) => {
    const next = activeMedications.includes(medication)
      ? activeMedications.filter(m => m !== medication)
      : [...activeMedications, medication];
    setActiveMedications(next);
    setIsSavingMedications(true);
    try {
      await updatePatientMedications(patient.id, next);
      showFeedback('success', 'Medications updated');
    } catch (err: any) {
      setActiveMedications(activeMedications);
      showFeedback('error', err?.message ?? 'Failed to update medications');
    } finally {
      setIsSavingMedications(false);
    }
  };

  // ── Derived data ─────────────────────────────────────────────────────────────

  /** Blood sugar filtered to the selected date range */
  const filteredBG = (() => {
    const cutoff = Date.now() - bgDays * 24 * 60 * 60 * 1000;
    return bloodSugar.filter(r => {
      const ts = r.timestamp || r.bloodSugarTimestamp || '';
      return ts ? new Date(ts).getTime() >= cutoff : true;
    });
  })();

  const bgStats          = computeBGStats(filteredBG);
  const nutritionAvg     = computeNutritionAverages(meals);
  const insulinStats     = computeInsulinStats(insulinDoses);

  const availableConditions  = constants ? Object.keys(constants.disease_factors  ?? {}) : [];
  const availableMedications = constants ? Object.keys(constants.medication_factors ?? {}) : [];

  // ── Tab Renderers ────────────────────────────────────────────────────────────

  const renderOverviewTab = () => {
    const recentBG = bloodSugar[0];
    return (
      <ScrollView style={styles.tabContent} showsVerticalScrollIndicator={false}>
        {/* Stats Row */}
        <View style={styles.statsGrid}>
          <Card variant="outlined" padding="small" style={styles.statCard}>
            <Text style={styles.statIcon}>📊</Text>
            <Text style={[styles.statValue, bgStats && { color: getBloodSugarStatus(bgStats.avg).color }]}>
              {bgStats ? `${bgStats.avg}` : '—'}
            </Text>
            <Text style={styles.statLabel}>Avg BG{'\n'}mg/dL</Text>
          </Card>
          <Card variant="outlined" padding="small" style={styles.statCard}>
            <Text style={styles.statIcon}>🎯</Text>
            <Text style={[styles.statValue, { color: colors.success }]}>
              {bgStats ? `${bgStats.tir}%` : '—'}
            </Text>
            <Text style={styles.statLabel}>Time{'\n'}In Range</Text>
          </Card>
          <Card variant="outlined" padding="small" style={styles.statCard}>
            <Text style={styles.statIcon}>💉</Text>
            <Text style={styles.statValue}>{insulinStats ? `${insulinStats.totalUnits}u` : '—'}</Text>
            <Text style={styles.statLabel}>Insulin{'\n'}Total</Text>
          </Card>
          <Card variant="outlined" padding="small" style={styles.statCard}>
            <Text style={styles.statIcon}>🍽️</Text>
            <Text style={styles.statValue}>{meals.length}</Text>
            <Text style={styles.statLabel}>Meals{'\n'}Logged</Text>
          </Card>
        </View>

        {/* Latest Reading */}
        {recentBG && (
          <Card variant="outlined" padding="medium" style={styles.overviewSection}>
            <Text style={styles.overviewSectionTitle}>Latest Blood Sugar</Text>
            <View style={styles.latestBGRow}>
              {(() => {
                const status = getBloodSugarStatus(recentBG.bloodSugar);
                return (
                  <>
                    <Text style={[styles.latestBGValue, { color: status.color }]}>
                      {recentBG.bloodSugar} mg/dL
                    </Text>
                    <View style={[styles.statusBadge, { backgroundColor: status.color + '20' }]}>
                      <Text style={[styles.statusText, { color: status.color }]}>{status.label}</Text>
                    </View>
                  </>
                );
              })()}
            </View>
            <Text style={styles.latestBGDate}>
              {formatDate(recentBG.timestamp || recentBG.bloodSugarTimestamp || '')}
            </Text>
          </Card>
        )}

        {/* BG Distribution */}
        {bgStats && bgStats.total > 0 && (
          <Card variant="outlined" padding="medium" style={styles.overviewSection}>
            <Text style={styles.overviewSectionTitle}>BG Distribution ({bgStats.total} readings)</Text>
            <View style={styles.distributionBar}>
              {bgStats.low > 0 && (
                <View style={[styles.distributionSegment, { flex: bgStats.low, backgroundColor: colors.glucose?.low ?? '#E53E3E' }]} />
              )}
              {bgStats.inRange > 0 && (
                <View style={[styles.distributionSegment, { flex: bgStats.inRange, backgroundColor: colors.glucose?.normal ?? '#38A169' }]} />
              )}
              {bgStats.high > 0 && (
                <View style={[styles.distributionSegment, { flex: bgStats.high, backgroundColor: colors.glucose?.high ?? '#DD6B20' }]} />
              )}
            </View>
            <View style={styles.distributionLegend}>
              <Text style={[styles.legendItem, { color: colors.glucose?.low ?? '#E53E3E' }]}>Low: {bgStats.low}</Text>
              <Text style={[styles.legendItem, { color: colors.glucose?.normal ?? '#38A169' }]}>In Range: {bgStats.inRange}</Text>
              <Text style={[styles.legendItem, { color: colors.glucose?.high ?? '#DD6B20' }]}>High: {bgStats.high}</Text>
            </View>
          </Card>
        )}

        {/* Clinical Constants Summary */}
        {constants && (
          <Card variant="outlined" padding="medium" style={styles.overviewSection}>
            <Text style={styles.overviewSectionTitle}>Clinical Constants</Text>
            <View style={styles.constantsGrid}>
              <View style={styles.constantItem}>
                <Text style={styles.constantValue}>1:{constants.insulin_to_carb_ratio}</Text>
                <Text style={styles.constantLabel}>I:C Ratio</Text>
              </View>
              <View style={styles.constantDivider} />
              <View style={styles.constantItem}>
                <Text style={styles.constantValue}>{constants.correction_factor}</Text>
                <Text style={styles.constantLabel}>Correction</Text>
              </View>
              <View style={styles.constantDivider} />
              <View style={styles.constantItem}>
                <Text style={styles.constantValue}>{constants.target_glucose}</Text>
                <Text style={styles.constantLabel}>Target BG</Text>
              </View>
            </View>
          </Card>
        )}

        {/* Active Conditions */}
        <Card variant="outlined" padding="medium" style={styles.overviewSection}>
          <Text style={styles.overviewSectionTitle}>Active Conditions</Text>
          {activeConditions.length === 0 ? (
            <Text style={styles.noneText}>None recorded</Text>
          ) : (
            <View style={styles.tagsRow}>
              {activeConditions.map(c => (
                <View key={c} style={[styles.tag, styles.conditionTag]}>
                  <Text style={styles.conditionTagText}>{formatLabel(c)}</Text>
                </View>
              ))}
            </View>
          )}
        </Card>

        {/* Active Medications */}
        <Card variant="outlined" padding="medium" style={[styles.overviewSection, styles.lastSection]}>
          <Text style={styles.overviewSectionTitle}>Active Medications</Text>
          {activeMedications.length === 0 ? (
            <Text style={styles.noneText}>None recorded</Text>
          ) : (
            <View style={styles.tagsRow}>
              {activeMedications.map(m => (
                <View key={m} style={[styles.tag, styles.medicationTag]}>
                  <Text style={styles.medicationTagText}>{formatLabel(m)}</Text>
                </View>
              ))}
            </View>
          )}
        </Card>
      </ScrollView>
    );
  };

  // ─── Blood Sugar tab ────────────────────────────────────────────────────────
  const renderBloodSugarTab = () => (
    <ScrollView
      style={styles.tabContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} />}
    >
      {/* Date-range filter */}
      <View style={styles.filterRow}>
        {([7, 14, 30] as BGDaysFilter[]).map(d => (
          <TouchableOpacity
            key={d}
            style={[styles.filterBtn, bgDays === d && styles.filterBtnActive]}
            onPress={() => setBgDays(d)}
          >
            <Text style={[styles.filterBtnText, bgDays === d && styles.filterBtnTextActive]}>
              {d}d
            </Text>
          </TouchableOpacity>
        ))}
        <Text style={styles.filterCount}>{filteredBG.length} readings</Text>
      </View>

      {/* Stats Header */}
      {bgStats && (
        <Card variant="filled" padding="medium" style={styles.statsHeader}>
          <View style={styles.statsHeaderRow}>
            <View style={styles.statsHeaderItem}>
              <Text style={styles.statsHeaderValue}>{bgStats.avg}</Text>
              <Text style={styles.statsHeaderLabel}>Avg mg/dL</Text>
            </View>
            <View style={styles.statsHeaderDivider} />
            <View style={styles.statsHeaderItem}>
              <Text style={[styles.statsHeaderValue, { color: colors.success }]}>{bgStats.tir}%</Text>
              <Text style={styles.statsHeaderLabel}>Time in Range</Text>
            </View>
            <View style={styles.statsHeaderDivider} />
            <View style={styles.statsHeaderItem}>
              <Text style={[styles.statsHeaderValue, { color: colors.glucose?.low ?? '#E53E3E' }]}>{bgStats.low}</Text>
              <Text style={styles.statsHeaderLabel}>Low Events</Text>
            </View>
            <View style={styles.statsHeaderDivider} />
            <View style={styles.statsHeaderItem}>
              <Text style={[styles.statsHeaderValue, { color: colors.glucose?.high ?? '#DD6B20' }]}>{bgStats.high}</Text>
              <Text style={styles.statsHeaderLabel}>High Events</Text>
            </View>
          </View>
        </Card>
      )}

      {filteredBG.length === 0 ? (
        <View style={styles.emptyContent}>
          <Text style={styles.emptyIcon}>📊</Text>
          <Text style={styles.emptyText}>No readings in last {bgDays} days</Text>
        </View>
      ) : (
        <View style={styles.dataList}>
          {filteredBG.slice(0, 50).map((reading, index) => {
            const status = getBloodSugarStatus(reading.bloodSugar);
            const key = reading._id ?? `${reading.timestamp}-${index}`;
            return (
              <Card key={key} variant="outlined" padding="small" style={styles.dataCard}>
                <View style={styles.dataRow}>
                  <View style={styles.dataMain}>
                    <Text style={[styles.dataValue, { color: status.color }]}>
                      {reading.bloodSugar} mg/dL
                    </Text>
                    <View style={[styles.statusBadge, { backgroundColor: status.color + '20' }]}>
                      <Text style={[styles.statusText, { color: status.color }]}>{status.label}</Text>
                    </View>
                  </View>
                  <Text style={styles.dataDate}>
                    {formatDate(reading.timestamp || reading.bloodSugarTimestamp || '')}
                  </Text>
                </View>
                {reading.notes && (
                  <Text style={styles.dataNotes}>{reading.notes}</Text>
                )}
              </Card>
            );
          })}
        </View>
      )}
    </ScrollView>
  );

  // ─── Insulin tab ────────────────────────────────────────────────────────────
  const renderInsulinTab = () => (
    <ScrollView
      style={styles.tabContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} />}
    >
      {/* Totals header */}
      {insulinStats && (
        <Card variant="filled" padding="medium" style={styles.statsHeader}>
          <Text style={styles.statsHeaderTitle}>Last {insulinDoses.length} doses</Text>
          <View style={styles.statsHeaderRow}>
            <View style={styles.statsHeaderItem}>
              <Text style={styles.statsHeaderValue}>{insulinStats.totalUnits}u</Text>
              <Text style={styles.statsHeaderLabel}>Total Units</Text>
            </View>
            <View style={styles.statsHeaderDivider} />
            <View style={styles.statsHeaderItem}>
              <Text style={styles.statsHeaderValue}>{insulinStats.count}</Text>
              <Text style={styles.statsHeaderLabel}>Doses</Text>
            </View>
            {/* Per-type breakdown */}
            {Object.entries(insulinStats.byType).slice(0, 2).map(([type, info]) => (
              <React.Fragment key={type}>
                <View style={styles.statsHeaderDivider} />
                <View style={styles.statsHeaderItem}>
                  <Text style={styles.statsHeaderValue}>{Math.round(info.units * 10) / 10}u</Text>
                  <Text style={styles.statsHeaderLabel}>{formatLabel(type.replace('_acting', ''))}</Text>
                </View>
              </React.Fragment>
            ))}
          </View>
        </Card>
      )}

      {insulinDoses.length === 0 ? (
        <View style={styles.emptyContent}>
          <Text style={styles.emptyIcon}>💉</Text>
          <Text style={styles.emptyText}>No insulin doses recorded</Text>
          <Text style={styles.emptySubText}>
            Insulin history will appear here once the patient logs doses
          </Text>
        </View>
      ) : (
        <View style={styles.dataList}>
          {insulinDoses.map((dose, index) => {
            const key = dose.id ?? dose._id ?? `${dose.timestamp}-${index}`;
            return (
              <Card key={key} variant="outlined" padding="small" style={styles.dataCard}>
                <View style={styles.dataRow}>
                  <View style={styles.dataMain}>
                    <Text style={styles.insulinType}>
                      {formatInsulinType(dose.insulinType)}
                    </Text>
                    <Text style={styles.insulinUnits}>{dose.units} units</Text>
                  </View>
                  <View style={styles.insulinRight}>
                    <Text style={styles.dataDate}>
                      {formatDate(dose.timestamp || dose.doseTime || '')}
                    </Text>
                    {dose.iobContribution !== undefined && dose.iobContribution > 0 && (
                      <View style={styles.iobBadge}>
                        <Text style={styles.iobBadgeText}>
                          {Math.round(dose.iobContribution * 10) / 10}u IOB
                        </Text>
                      </View>
                    )}
                  </View>
                </View>
                {dose.notes && (
                  <Text style={styles.dataNotes}>{dose.notes}</Text>
                )}
              </Card>
            );
          })}
        </View>
      )}
    </ScrollView>
  );

  // ─── Meals tab ──────────────────────────────────────────────────────────────
  const renderMealsTab = () => (
    <ScrollView
      style={styles.tabContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} />}
    >
      {nutritionAvg && (
        <Card variant="filled" padding="medium" style={styles.statsHeader}>
          <Text style={styles.statsHeaderTitle}>Per-Meal Averages</Text>
          <View style={styles.statsHeaderRow}>
            <View style={styles.statsHeaderItem}>
              <Text style={styles.statsHeaderValue}>{nutritionAvg.carbs}g</Text>
              <Text style={styles.statsHeaderLabel}>Carbs</Text>
            </View>
            <View style={styles.statsHeaderDivider} />
            <View style={styles.statsHeaderItem}>
              <Text style={styles.statsHeaderValue}>{nutritionAvg.protein}g</Text>
              <Text style={styles.statsHeaderLabel}>Protein</Text>
            </View>
            <View style={styles.statsHeaderDivider} />
            <View style={styles.statsHeaderItem}>
              <Text style={styles.statsHeaderValue}>{nutritionAvg.fat}g</Text>
              <Text style={styles.statsHeaderLabel}>Fat</Text>
            </View>
            <View style={styles.statsHeaderDivider} />
            <View style={styles.statsHeaderItem}>
              <Text style={styles.statsHeaderValue}>{nutritionAvg.calories}</Text>
              <Text style={styles.statsHeaderLabel}>Cal</Text>
            </View>
          </View>
        </Card>
      )}

      {meals.length === 0 ? (
        <View style={styles.emptyContent}>
          <Text style={styles.emptyIcon}>🍽️</Text>
          <Text style={styles.emptyText}>No meal history</Text>
        </View>
      ) : (
        <View style={styles.dataList}>
          {meals.slice(0, 30).map((meal, index) => {
            const key = meal.id ?? `${meal.timestamp}-${index}`;
            return (
              <TouchableOpacity
                key={key}
                activeOpacity={meal.id ? 0.7 : 1}
                onPress={() => {
                  if (meal.id) {
                    router.push(`/(app)/meal/${meal.id}?patientId=${patient.id}`);
                  }
                }}
              >
                <Card variant="outlined" padding="small" style={styles.dataCard}>
                  <View style={styles.dataRow}>
                    <View style={styles.dataMain}>
                      <Text style={styles.mealType}>{meal.mealType || 'Meal'}</Text>
                      <Text style={styles.mealItems}>
                        {meal.foodItems?.slice(0, 2).map(f => f.name).join(', ')}
                        {meal.foodItems && meal.foodItems.length > 2
                          ? ` +${meal.foodItems.length - 2} more`
                          : ''}
                      </Text>
                    </View>
                    <View style={styles.mealCardRight}>
                      <Text style={styles.dataDate}>
                        {formatDate(meal.timestamp || meal.mealTime || '')}
                      </Text>
                      {meal.id && <Text style={styles.viewDetails}>View details ›</Text>}
                    </View>
                  </View>
                  <View style={styles.nutritionRow}>
                    {[
                      { v: meal.nutrition?.carbs    ?? 0, u: 'g', l: 'Carbs'   },
                      { v: meal.nutrition?.protein  ?? 0, u: 'g', l: 'Protein' },
                      { v: meal.nutrition?.fat      ?? 0, u: 'g', l: 'Fat'     },
                      { v: meal.nutrition?.calories ?? 0, u: '',  l: 'Cal'     },
                    ].map(({ v, u, l }) => (
                      <View key={l} style={styles.nutritionItem}>
                        <Text style={styles.nutritionValue}>{v}{u}</Text>
                        <Text style={styles.nutritionLabel}>{l}</Text>
                      </View>
                    ))}
                  </View>
                </Card>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </ScrollView>
  );

  // ─── Activities tab ─────────────────────────────────────────────────────────
  const renderActivitiesTab = () => (
    <ScrollView
      style={styles.tabContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} />}
    >
      {activities.length === 0 ? (
        <View style={styles.emptyContent}>
          <Text style={styles.emptyIcon}>🏃</Text>
          <Text style={styles.emptyText}>No activity history</Text>
        </View>
      ) : (
        <View style={styles.dataList}>
          {activities.slice(0, 30).map((activity, index) => {
            const key = activity.id ?? `${activity.timestamp}-${index}`;
            return (
              <Card key={key} variant="outlined" padding="small" style={styles.dataCard}>
                <View style={styles.dataRow}>
                  <View style={styles.dataMain}>
                    <Text style={styles.activityLevel}>
                      Level {activity.level} — {activity.levelLabel || 'Activity'}
                    </Text>
                    {activity.duration && (
                      <Text style={styles.activityDuration}>{activity.duration}</Text>
                    )}
                  </View>
                  <Text style={styles.dataDate}>
                    {formatDate(activity.timestamp || activity.startTime || '')}
                  </Text>
                </View>
                {activity.notes && (
                  <Text style={styles.dataNotes}>{activity.notes}</Text>
                )}
              </Card>
            );
          })}
        </View>
      )}
    </ScrollView>
  );

  // ─── Charts tab ─────────────────────────────────────────────────────────────
  const renderChartsTab = () => (
    <ScrollView style={styles.tabContent} showsVerticalScrollIndicator={false}>

      {/* 1 — Raw blood glucose readings */}
      <View style={styles.chartSection}>
        <Text style={styles.chartSectionTitle}>📊 Blood Glucose</Text>
        <Text style={styles.chartSectionSubtitle}>
          Actual readings with banded colour zones
        </Text>
        <DoctorBGChart
          readings={bloodSugar}
          targetGlucose={constants?.target_glucose ?? 100}
          highThreshold={180}
          lowThreshold={70}
        />
      </View>

      {/* 2 — Meal & insulin pharmacodynamic effects */}
      <View style={styles.chartSection}>
        <Text style={styles.chartSectionTitle}>🍽️ Meal &amp; Insulin Effects</Text>
        <Text style={styles.chartSectionSubtitle}>
          Pharmacodynamic meal-on-board curve and cumulative baseline shift
        </Text>
        <DoctorEffectsChart
          meals={meals}
          insulinDoses={insulinDoses}
          constants={constants}
        />
      </View>

      {/* 3 — BG projection with cumulative effects overlay */}
      <View style={[styles.chartSection, styles.lastSection]}>
        <Text style={styles.chartSectionTitle}>🔮 BG Projection</Text>
        <Text style={styles.chartSectionSubtitle}>
          Projected blood glucose with cumulative meal &amp; insulin effects
        </Text>
        <DoctorBGVisualization
          meals={meals}
          insulinDoses={insulinDoses}
          bloodSugar={bloodSugar}
          constants={constants}
        />
      </View>

    </ScrollView>
  );

  // ─── Settings tab ───────────────────────────────────────────────────────────
  const renderSettingsTab = () => (
    <ScrollView style={styles.tabContent} showsVerticalScrollIndicator={false}>
      {settingsFeedback && (
        <View style={[styles.feedbackBanner, settingsFeedback.type === 'success' ? styles.feedbackSuccess : styles.feedbackError]}>
          <Text style={styles.feedbackText}>
            {settingsFeedback.type === 'success' ? '✓ ' : '⚠ '}
            {settingsFeedback.message}
          </Text>
        </View>
      )}

      {/* Constants */}
      <Card variant="outlined" padding="medium" style={styles.settingsSection}>
        <View style={styles.settingsSectionHeader}>
          <Text style={styles.settingsSectionTitle}>⚙️ Clinical Constants</Text>
          <Text style={styles.settingsSectionSubtitle}>
            Adjustments affect insulin dose calculations in real time
          </Text>
        </View>

        {editableConstants ? (
          <>
            <ConstantField label="Insulin : Carb Ratio"  hint="Units of insulin per gram of carbs (e.g. 1:10)" prefix="1:"       value={editableConstants.insulin_to_carb_ratio} onChange={v => setEditableConstants(prev => prev ? { ...prev, insulin_to_carb_ratio: v } : prev)} />
            <ConstantField label="Correction Factor"     hint="mg/dL drop per 1 unit of insulin"               suffix="mg/dL"    value={editableConstants.correction_factor}     onChange={v => setEditableConstants(prev => prev ? { ...prev, correction_factor: v } : prev)} />
            <ConstantField label="Target Glucose"        hint="Patient's ideal fasting blood glucose"           suffix="mg/dL"    value={editableConstants.target_glucose}        onChange={v => setEditableConstants(prev => prev ? { ...prev, target_glucose: v } : prev)} />
            <ConstantField label="Protein Factor"        hint="BG contribution coefficient for protein"                           value={editableConstants.protein_factor}        onChange={v => setEditableConstants(prev => prev ? { ...prev, protein_factor: v } : prev)} />
            <ConstantField label="Fat Factor"            hint="BG contribution coefficient for fat"                               value={editableConstants.fat_factor}            onChange={v => setEditableConstants(prev => prev ? { ...prev, fat_factor: v } : prev)} />
            <ConstantField label="Carb → BG Factor"      hint="BG rise per gram of carbs"                                         value={editableConstants.carb_to_bg_factor}     onChange={v => setEditableConstants(prev => prev ? { ...prev, carb_to_bg_factor: v } : prev)} />

            {/* Baseline Mode selector */}
            <View style={styles.baselineModeRow}>
              <Text style={styles.baselineModeLabel}>Baseline Mode</Text>
              <Text style={styles.baselineModeHint}>
                Dynamic: derived from readings · Preset: 24h circadian profile
              </Text>
              <View style={styles.baselineModeOptions}>
                {(['dynamic', 'preset'] as const).map(mode => (
                  <TouchableOpacity
                    key={mode}
                    onPress={() => setEditableConstants(prev => prev ? { ...prev, baseline_mode: mode } : prev)}
                    style={[
                      styles.baselineModeOption,
                      editableConstants.baseline_mode === mode && styles.baselineModeOptionActive,
                    ]}
                  >
                    <Text style={[
                      styles.baselineModeOptionText,
                      editableConstants.baseline_mode === mode && styles.baselineModeOptionTextActive,
                    ]}>
                      {mode === 'dynamic' ? '📈 Dynamic (from reading)' : '🌙 Preset (circadian)'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.settingsActions}>
              <TouchableOpacity style={[styles.actionBtn, styles.saveBtn, isSavingConstants && styles.btnDisabled]} onPress={handleSaveConstants} disabled={isSavingConstants}>
                {isSavingConstants
                  ? <ActivityIndicator size="small" color={colors.text.inverse} />
                  : <Text style={styles.saveBtnText}>Save Constants</Text>}
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actionBtn, styles.resetBtn, isResettingConstants && styles.btnDisabled]} onPress={handleResetConstants} disabled={isResettingConstants}>
                {isResettingConstants
                  ? <ActivityIndicator size="small" color={colors.danger} />
                  : <Text style={styles.resetBtnText}>Reset to Defaults</Text>}
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <Text style={styles.noneText}>Constants unavailable</Text>
        )}
      </Card>

      {/* Conditions */}
      <Card variant="outlined" padding="medium" style={styles.settingsSection}>
        <View style={styles.settingsSectionHeader}>
          <Text style={styles.settingsSectionTitle}>🩺 Active Conditions</Text>
          <Text style={styles.settingsSectionSubtitle}>
            Enabled conditions apply disease-specific BG modifiers
          </Text>
          {isSavingConditions && <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: spacing.xs }} />}
        </View>

        {availableConditions.length === 0 ? (
          <Text style={styles.noneText}>No conditions available from server</Text>
        ) : (
          availableConditions.map(condition => (
            <View key={condition} style={styles.toggleRow}>
              <View style={styles.toggleInfo}>
                <Text style={styles.toggleLabel}>{formatLabel(condition)}</Text>
                {activeConditions.includes(condition) && <Text style={styles.toggleActive}>Active</Text>}
              </View>
              <Switch
                value={activeConditions.includes(condition)}
                onValueChange={() => handleToggleCondition(condition)}
                disabled={isSavingConditions}
                trackColor={{ false: colors.border, true: colors.primary + '60' }}
                thumbColor={activeConditions.includes(condition) ? colors.primary : colors.text.disabled}
              />
            </View>
          ))
        )}
      </Card>

      {/* Medications */}
      <Card variant="outlined" padding="medium" style={[styles.settingsSection, styles.lastSection]}>
        <View style={styles.settingsSectionHeader}>
          <Text style={styles.settingsSectionTitle}>💊 Active Medications</Text>
          <Text style={styles.settingsSectionSubtitle}>
            Enabled medications apply drug-specific insulin sensitivity modifiers
          </Text>
          {isSavingMedications && <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: spacing.xs }} />}
        </View>

        {availableMedications.length === 0 ? (
          <Text style={styles.noneText}>No medications available from server</Text>
        ) : (
          availableMedications.map(medication => (
            <View key={medication} style={styles.toggleRow}>
              <View style={styles.toggleInfo}>
                <Text style={styles.toggleLabel}>{formatLabel(medication)}</Text>
                {activeMedications.includes(medication) && <Text style={styles.toggleActive}>Active</Text>}
              </View>
              <Switch
                value={activeMedications.includes(medication)}
                onValueChange={() => handleToggleMedication(medication)}
                disabled={isSavingMedications}
                trackColor={{ false: colors.border, true: colors.primary + '60' }}
                thumbColor={activeMedications.includes(medication) ? colors.primary : colors.text.disabled}
              />
            </View>
          ))
        )}
      </Card>
    </ScrollView>
  );

  // ── Shell ─────────────────────────────────────────────────────────────────

  const fullName = `${patient.firstName} ${patient.lastName}`;

  const tabs: { key: TabType; label: string; icon: string }[] = [
    { key: 'overview',   label: 'Overview',  icon: '📋' },
    { key: 'charts',     label: 'Charts',    icon: '📈' },
    { key: 'bloodSugar', label: 'BG',        icon: '📊' },
    { key: 'insulin',    label: 'Insulin',   icon: '💉' },  // ← NEW
    { key: 'meals',      label: 'Meals',     icon: '🍽️' },
    { key: 'activities', label: 'Activity',  icon: '🏃' },
    { key: 'settings',   label: 'Settings',  icon: '⚙️' },
  ];

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        {onBack && (
          <TouchableOpacity onPress={onBack} style={styles.backButton}>
            <Text style={styles.backButtonText}>← Back</Text>
          </TouchableOpacity>
        )}
        <View style={styles.patientHeader}>
          <View style={styles.patientAvatar}>
            <Text style={styles.patientAvatarText}>
              {patient.firstName.charAt(0).toUpperCase()}
              {patient.lastName.charAt(0).toUpperCase()}
            </Text>
          </View>
          <View>
            <Text style={styles.patientName}>{fullName}</Text>
            <Text style={styles.patientEmail}>{patient.email}</Text>
            {activeConditions.length > 0 && (
              <Text style={styles.patientConditionsPreview}>
                {activeConditions.slice(0, 2).map(c => formatLabel(c)).join(' · ')}
                {activeConditions.length > 2 ? ` +${activeConditions.length - 2}` : ''}
              </Text>
            )}
          </View>
        </View>
      </View>

      {/* Tab Bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabBarScroll}
        contentContainerStyle={styles.tabBar}
      >
        {tabs.map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Text style={styles.tabIcon}>{tab.icon}</Text>
            <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Content */}
      {isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading patient data…</Text>
        </View>
      ) : error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={loadData}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {activeTab === 'overview'    && renderOverviewTab()}
          {activeTab === 'charts'      && renderChartsTab()}
          {activeTab === 'bloodSugar'  && renderBloodSugarTab()}
          {activeTab === 'insulin'     && renderInsulinTab()}
          {activeTab === 'meals'       && renderMealsTab()}
          {activeTab === 'activities'  && renderActivitiesTab()}
          {activeTab === 'settings'    && renderSettingsTab()}
        </>
      )}
    </View>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Constant Field
// ─────────────────────────────────────────────────────────────────────────────

interface ConstantFieldProps {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  prefix?: string;
  suffix?: string;
}

const ConstantField: React.FC<ConstantFieldProps> = ({ label, hint, value, onChange, prefix, suffix }) => (
  <View style={styles.constantFieldRow}>
    <View style={styles.constantFieldInfo}>
      <Text style={styles.constantFieldLabel}>{label}</Text>
      <Text style={styles.constantFieldHint}>{hint}</Text>
    </View>
    <View style={styles.constantFieldInputWrap}>
      {prefix && <Text style={styles.constantFieldAffix}>{prefix}</Text>}
      <TextInput
        style={styles.constantFieldInput}
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        selectTextOnFocus
      />
      {suffix && <Text style={styles.constantFieldAffix}>{suffix}</Text>}
    </View>
  </View>
);

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },

  // Header
  header: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backButton: { marginBottom: spacing.sm },
  backButtonText: { ...typography.body, color: colors.primary },
  patientHeader: { flexDirection: 'row', alignItems: 'center' },
  patientAvatar: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.primary,
    justifyContent: 'center', alignItems: 'center',
    marginRight: spacing.md,
  },
  patientAvatarText: { ...typography.h3, color: colors.text.inverse },
  patientName: { ...typography.h3, color: colors.text.primary },
  patientEmail: { ...typography.caption, color: colors.text.secondary, marginTop: 2 },
  patientConditionsPreview: { ...typography.caption, color: colors.warning, marginTop: 3, fontWeight: '500' },

  // Tab Bar
  tabBarScroll: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexGrow: 0,
  },
  tabBar: { flexDirection: 'row', paddingHorizontal: spacing.xs },
  tab: {
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
    alignItems: 'center',
    borderBottomWidth: 2, borderBottomColor: 'transparent',
    minWidth: 66,
  },
  tabActive: { borderBottomColor: colors.primary },
  tabIcon: { fontSize: 15, marginBottom: 2 },
  tabText: { ...typography.small, color: colors.text.secondary, fontSize: 10 },
  tabTextActive: { color: colors.primary, fontWeight: '600' },

  // Loading / error
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: spacing.md },
  loadingText: { ...typography.body, color: colors.text.secondary },
  errorContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  errorText: { ...typography.body, color: colors.danger, textAlign: 'center', marginBottom: spacing.md },
  retryButton: { paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, backgroundColor: colors.primary, borderRadius: borderRadius.md },
  retryButtonText: { ...typography.body, color: colors.text.inverse, fontWeight: '600' },

  // Tab content
  tabContent: { flex: 1 },

  // Date-range filter strip (BG tab)
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  filterBtn: {
    paddingVertical: 5,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surfaceVariant,
  },
  filterBtnActive: { backgroundColor: colors.primary },
  filterBtnText: { ...typography.small, color: colors.text.secondary, fontWeight: '600' },
  filterBtnTextActive: { color: colors.text.inverse },
  filterCount: { ...typography.caption, color: colors.text.secondary, marginLeft: 'auto' as any },

  // Stats header
  statsHeader: { margin: spacing.md, marginBottom: 0 },
  statsHeaderTitle: { ...typography.small, color: colors.text.secondary, marginBottom: spacing.sm, fontWeight: '500' },
  statsHeaderRow: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' },
  statsHeaderItem: { alignItems: 'center', flex: 1 },
  statsHeaderValue: { ...typography.h3, color: colors.text.primary, fontWeight: '700' },
  statsHeaderLabel: { ...typography.small, color: colors.text.secondary, marginTop: 2, fontSize: 10, textAlign: 'center' },
  statsHeaderDivider: { width: 1, height: 32, backgroundColor: colors.border },

  // Overview cards
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', padding: spacing.md, gap: spacing.sm },
  statCard: { flex: 1, minWidth: 80, alignItems: 'center' },
  statIcon: { fontSize: 22, marginBottom: spacing.xs },
  statValue: { ...typography.h2, color: colors.text.primary, fontWeight: '700' },
  statLabel: { ...typography.caption, color: colors.text.secondary, textAlign: 'center', marginTop: 2 },
  overviewSection: { margin: spacing.md, marginBottom: 0 },
  lastSection: { marginBottom: spacing.lg },
  latestBGRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  latestBGValue: { ...typography.h1, fontWeight: '700' },
  latestBGDate: { ...typography.caption, color: colors.text.secondary, marginTop: spacing.xs },
  distributionBar: { height: 16, flexDirection: 'row', borderRadius: 8, overflow: 'hidden', marginVertical: spacing.sm },
  distributionSegment: { height: '100%' },
  distributionLegend: { flexDirection: 'row', justifyContent: 'space-around' },
  legendItem: { ...typography.caption, fontWeight: '500' },
  constantsGrid: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingTop: spacing.sm },
  constantItem: { alignItems: 'center', flex: 1 },
  constantDivider: { width: 1, height: 36, backgroundColor: colors.border },
  constantValue: { ...typography.h3, color: colors.text.primary, fontWeight: '700' },
  constantLabel: { ...typography.caption, color: colors.text.secondary, marginTop: 2 },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  tag: { paddingVertical: 4, paddingHorizontal: spacing.sm, borderRadius: borderRadius.full },
  conditionTag: { backgroundColor: colors.warning + '20' },
  conditionTagText: { ...typography.caption, color: colors.warning, fontWeight: '500' },
  medicationTag: { backgroundColor: colors.primary + '20' },
  medicationTagText: { ...typography.caption, color: colors.primary, fontWeight: '500' },
  noneText: { ...typography.small, color: colors.text.disabled, fontStyle: 'italic' },

  // Data lists (BG, Insulin, Meals, Activities)
  dataList: { padding: spacing.md, gap: spacing.sm },
  dataCard: { marginBottom: spacing.xs },
  dataRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  dataMain: { flex: 1 },
  dataValue: { ...typography.body, fontWeight: '600' },
  statusBadge: { alignSelf: 'flex-start', paddingVertical: 2, paddingHorizontal: spacing.sm, borderRadius: borderRadius.full, marginTop: 4 },
  statusText: { ...typography.caption, fontWeight: '600', fontSize: 10 },
  dataDate: { ...typography.caption, color: colors.text.secondary },
  dataNotes: { ...typography.caption, color: colors.text.secondary, marginTop: spacing.xs, fontStyle: 'italic' },

  // Insulin-specific
  insulinType: { ...typography.body, fontWeight: '600', color: colors.text.primary },
  insulinUnits: { ...typography.caption, color: colors.text.secondary, marginTop: 2 },
  insulinRight: { alignItems: 'flex-end' },
  iobBadge: { marginTop: 4, backgroundColor: colors.primary + '20', paddingVertical: 2, paddingHorizontal: 6, borderRadius: borderRadius.sm },
  iobBadgeText: { ...typography.caption, color: colors.primary, fontWeight: '600', fontSize: 10 },

  // Meals
  mealCardRight: { alignItems: 'flex-end', gap: 4 },
  viewDetails: { fontSize: 11, color: colors.primary, fontWeight: '600' },
  mealType: { ...typography.body, fontWeight: '600', color: colors.text.primary },
  mealItems: { ...typography.small, color: colors.text.secondary, marginTop: 2 },
  nutritionRow: { flexDirection: 'row', marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.divider, justifyContent: 'space-around' },
  nutritionItem: { alignItems: 'center' },
  nutritionValue: { ...typography.body, color: colors.text.primary, fontWeight: '600', fontSize: 13 },
  nutritionLabel: { ...typography.small, color: colors.text.secondary, fontSize: 10 },

  // Activities
  activityLevel: { ...typography.body, fontWeight: '600', color: colors.text.primary },
  activityDuration: { ...typography.small, color: colors.text.secondary, marginTop: 2 },

  // Empty state
  emptyContent: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xl * 2 },
  emptyIcon: { fontSize: 48, marginBottom: spacing.md },
  emptyText: { ...typography.body, color: colors.text.secondary, textAlign: 'center' },
  emptySubText: { ...typography.caption, color: colors.text.disabled, textAlign: 'center', marginTop: spacing.xs },

  // Charts tab
  chartSection: { padding: spacing.md, paddingBottom: 0 },
  chartSectionTitle: { ...typography.body, fontWeight: '700', color: colors.text.primary, marginBottom: spacing.xs },
  chartSectionSubtitle: { ...typography.small, color: colors.text.secondary, marginBottom: spacing.sm, lineHeight: 17 },

  // Settings
  feedbackBanner: { marginHorizontal: spacing.md, marginTop: spacing.md, padding: spacing.sm, borderRadius: borderRadius.md },
  feedbackSuccess: { backgroundColor: colors.success + '15', borderLeftWidth: 3, borderLeftColor: colors.success },
  feedbackError: { backgroundColor: colors.danger + '15', borderLeftWidth: 3, borderLeftColor: colors.danger },
  feedbackText: { ...typography.body, color: colors.text.primary, fontWeight: '500' },
  settingsSection: { marginHorizontal: spacing.md, marginTop: spacing.md },
  settingsSectionHeader: { marginBottom: spacing.md },
  settingsSectionTitle: { ...typography.body, fontWeight: '700', color: colors.text.primary, marginBottom: spacing.xs },
  settingsSectionSubtitle: { ...typography.small, color: colors.text.secondary, lineHeight: 18 },
  constantFieldRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.divider },
  constantFieldInfo: { flex: 1, marginRight: spacing.md },
  constantFieldLabel: { ...typography.body, color: colors.text.primary, fontWeight: '500', fontSize: 13 },
  constantFieldHint: { ...typography.small, color: colors.text.secondary, marginTop: 2, fontSize: 11 },
  constantFieldInputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.sm, paddingHorizontal: spacing.sm, minWidth: 90 },
  constantFieldAffix: { ...typography.small, color: colors.text.secondary },
  constantFieldInput: { ...typography.body, color: colors.text.primary, paddingVertical: spacing.xs, paddingHorizontal: spacing.xs, minWidth: 52, textAlign: 'center', fontWeight: '600' },
  settingsActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  actionBtn: { flex: 1, paddingVertical: spacing.sm, borderRadius: borderRadius.md, alignItems: 'center', justifyContent: 'center', minHeight: 40 },
  saveBtn: { backgroundColor: colors.primary },
  saveBtnText: { ...typography.body, color: colors.text.inverse, fontWeight: '600' },
  resetBtn: { borderWidth: 1, borderColor: colors.danger, backgroundColor: 'transparent' },
  resetBtnText: { ...typography.body, color: colors.danger, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.divider },
  toggleInfo: { flex: 1, marginRight: spacing.md },
  toggleLabel: { ...typography.body, color: colors.text.primary, fontSize: 13 },
  toggleActive: { ...typography.small, color: colors.primary, fontWeight: '600', marginTop: 2, fontSize: 11 },
  overviewSectionTitle: {
    ...typography.body,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },

  // Baseline mode selector
  baselineModeRow: { paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.divider },
  baselineModeLabel: { ...typography.body, color: colors.text.primary, fontWeight: '600', fontSize: 13, marginBottom: 2 },
  baselineModeHint: { ...typography.small, color: colors.text.secondary, fontSize: 11, marginBottom: spacing.sm },
  baselineModeOptions: { flexDirection: 'row', gap: spacing.sm },
  baselineModeOption: {
    flex: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  baselineModeOptionActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primary + '12',
  },
  baselineModeOptionText: { ...typography.small, color: colors.text.secondary, fontWeight: '500', textAlign: 'center' },
  baselineModeOptionTextActive: { color: colors.primary, fontWeight: '700' },
});

export default PatientDataView;