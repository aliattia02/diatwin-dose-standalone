/**
 * Quick action buttons for the dashboard
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { colors, spacing, typography, borderRadius, shadows } from '@/constants/theme';

export interface QuickAction {
  id: string;
  label: string;
  icon: string;
  color: string;
  onPress: () => void;
}

export interface QuickActionsProps {
  actions?: QuickAction[];
  onLogMeal?: () => void;
  onLogGlucose?: () => void;
  onLogInsulin?: () => void;
  onLogActivity?: () => void;
}

const DEFAULT_ACTIONS = (props: QuickActionsProps): QuickAction[] => [
  {
    id: 'meal',
    label: 'Log Meal',
    icon: '🍽️',
    color: colors.primary,
    onPress: props.onLogMeal || (() => {}),
  },
  {
    id: 'glucose',
    label: 'Blood Sugar',
    icon: '🩸',
    color: colors.success,
    onPress: props.onLogGlucose || (() => {}),
  },
  {
    id: 'insulin',
    label: 'Insulin',
    icon: '💉',
    color: colors.secondary,
    onPress: props.onLogInsulin || (() => {}),
  },
  {
    id: 'activity',
    label: 'Activity',
    icon: '🏃',
    color: colors.warning,
    onPress: props.onLogActivity || (() => {}),
  },
];

export const QuickActions: React.FC<QuickActionsProps> = (props) => {
  const { actions } = props;
  const displayActions = actions || DEFAULT_ACTIONS(props);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Quick Log</Text>
      <View style={styles.actionsGrid}>
        {displayActions.map((action) => (
          <TouchableOpacity
            key={action.id}
            style={styles.actionButton}
            onPress={action.onPress}
            activeOpacity={0.7}
          >
            <View style={[styles.iconContainer, { backgroundColor: action.color + '15' }]}>
              <Text style={styles.icon}>{action.icon}</Text>
            </View>
            <Text style={styles.label}>{action.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md,
  },
  title: {
    ...typography.h3,
    color: colors.text.primary,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  actionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  actionButton: {
    flex: 1,
    minWidth: '45%',
    maxWidth: '48%',
    alignItems: 'center',
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    ...shadows.sm,
  },
  iconContainer: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  icon: {
    fontSize: 28,
  },
  label: {
    ...typography.caption,
    color: colors.text.primary,
    fontWeight: '500',
    textAlign: 'center',
  },
});

export default QuickActions;
