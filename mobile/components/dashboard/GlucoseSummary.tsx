/**
 * Dashboard widget showing recent glucose readings
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Card } from '@/components/ui';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import { getGlucoseStatus } from '@/services/api/glucose';
import type { BloodSugarResponse } from '@/types/api';

export interface GlucoseSummaryProps {
  latestReading: BloodSugarResponse | null;
  recentReadings?: BloodSugarResponse[];
  estimatedBloodGlucose?: number;
  insulinOnBoard?: number;
  onPress?: () => void;
  isLoading?: boolean;
}

export const GlucoseSummary: React.FC<GlucoseSummaryProps> = ({
  latestReading,
  recentReadings = [],
  estimatedBloodGlucose,
  insulinOnBoard,
  onPress,
  isLoading = false,
}) => {
  const getStatusColor = (value: number) => {
    const status = getGlucoseStatus(value);
    switch (status) {
      case 'veryLow':
      case 'veryHigh':
        return colors.danger;
      case 'low':
      case 'high':
        return colors.warning;
      case 'normal':
        return colors.success;
      default:
        return colors.text.secondary;
    }
  };

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    
    return date.toLocaleDateString();
  };

  if (isLoading) {
    return (
      <Card variant="elevated" padding="medium" onPress={onPress}>
        <Text style={styles.title}>Blood Glucose</Text>
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      </Card>
    );
  }

  if (!latestReading) {
    return (
      <Card variant="elevated" padding="medium" onPress={onPress}>
        <Text style={styles.title}>Blood Glucose</Text>
        <View style={styles.noDataContainer}>
          <Text style={styles.noDataText}>No recent readings</Text>
          <Text style={styles.noDataHint}>Tap to log a reading</Text>
        </View>
      </Card>
    );
  }

  const statusColor = getStatusColor(latestReading.bloodSugar);
  const timestamp = latestReading.bloodSugarTimestamp || latestReading.timestamp;

  return (
    <Card variant="elevated" padding="medium" onPress={onPress}>
      <View style={styles.header}>
        <Text style={styles.title}>Blood Glucose</Text>
        <Text style={styles.timestamp}>{formatTime(timestamp)}</Text>
      </View>

      <View style={styles.mainReading}>
        <Text style={[styles.value, { color: statusColor }]}>
          {latestReading.bloodSugar}
        </Text>
        <Text style={styles.unit}>mg/dL</Text>
      </View>

      <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
        <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
        <Text style={[styles.statusText, { color: statusColor }]}>
          {latestReading.status.charAt(0).toUpperCase() + latestReading.status.slice(1)}
        </Text>
      </View>

      {/* Mini trend display */}
      {recentReadings.length > 0 && (
        <View style={styles.trendContainer}>
          <Text style={styles.trendLabel}>Recent:</Text>
          <View style={styles.trendValues}>
            {recentReadings.slice(0, 4).map((reading, index) => (
              <View key={index} style={styles.trendItem}>
                <View 
                  style={[
                    styles.trendDot, 
                    { backgroundColor: getStatusColor(reading.bloodSugar) }
                  ]} 
                />
                <Text style={styles.trendValue}>{reading.bloodSugar}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      <View style={styles.targetInfo}>
        <Text style={styles.targetLabel}>Target: {latestReading.target} mg/dL</Text>
      </View>

      {/* Additional metrics */}
      {(estimatedBloodGlucose !== undefined || insulinOnBoard !== undefined) && (
        <View style={styles.metricsContainer}>
          {estimatedBloodGlucose !== undefined && (
            <View style={styles.metricItem}>
              <Text style={styles.metricLabel}>Estimated BG</Text>
              <Text style={styles.metricValue}>{estimatedBloodGlucose.toFixed(0)} mg/dL</Text>
            </View>
          )}
          {insulinOnBoard !== undefined && insulinOnBoard > 0 && (
            <View style={styles.metricItem}>
              <Text style={styles.metricLabel}>Active Insulin</Text>
              <Text style={styles.metricValue}>{insulinOnBoard.toFixed(2)} units</Text>
            </View>
          )}
        </View>
      )}
    </Card>
  );
};

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  title: {
    ...typography.h3,
    color: colors.text.primary,
  },
  timestamp: {
    ...typography.small,
    color: colors.text.secondary,
  },
  mainReading: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  value: {
    fontSize: 48,
    fontWeight: 'bold',
    lineHeight: 56,
  },
  unit: {
    ...typography.body,
    color: colors.text.secondary,
    marginLeft: spacing.xs,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.full,
    alignSelf: 'center',
    marginBottom: spacing.md,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: spacing.xs,
  },
  statusText: {
    ...typography.caption,
    fontWeight: '600',
  },
  loadingContainer: {
    alignItems: 'center',
    padding: spacing.lg,
  },
  loadingText: {
    ...typography.body,
    color: colors.text.secondary,
  },
  noDataContainer: {
    alignItems: 'center',
    padding: spacing.lg,
  },
  noDataText: {
    ...typography.body,
    color: colors.text.secondary,
    marginBottom: spacing.xs,
  },
  noDataHint: {
    ...typography.small,
    color: colors.primary,
  },
  trendContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  trendLabel: {
    ...typography.small,
    color: colors.text.secondary,
    marginRight: spacing.sm,
  },
  trendValues: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  trendItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  trendDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: spacing.xs,
  },
  trendValue: {
    ...typography.small,
    color: colors.text.secondary,
  },
  targetInfo: {
    alignItems: 'center',
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  targetLabel: {
    ...typography.small,
    color: colors.text.secondary,
  },
  metricsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  metricItem: {
    alignItems: 'center',
  },
  metricLabel: {
    ...typography.small,
    color: colors.text.secondary,
    marginBottom: spacing.xs,
  },
  metricValue: {
    ...typography.body,
    fontWeight: '600',
    color: colors.primary,
  },
});

export default GlucoseSummary;
