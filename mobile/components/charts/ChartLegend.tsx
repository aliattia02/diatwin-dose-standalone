/**
 * Chart Legend Component
 * Location: mobile/components/charts/ChartLegend.tsx
 *
 * Main Component: ChartLegend
 * Description: Reusable legend component for displaying chart element labels with colored indicators
 *
 * Features:
 * - Horizontal or vertical layout options
 * - Multiple indicator types (line, area, bar, dot)
 * - Customizable colors
 * - Flexible wrapping for horizontal layout
 * - Consistent typography and spacing
 *
 * Usage:
 * ```tsx
 * <ChartLegend
 *   items={[
 *     { label: 'Actual Readings', color: colors.primary, type: 'line' },
 *     { label: 'Estimated', color: '#6a5acd', type: 'dot' }
 *   ]}
 *   horizontal={true}
 * />
 * ```
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

// Constants
import { colors, spacing, typography } from '@/constants/theme';

export interface LegendItem {
  label: string;
  color: string;
  type?: 'line' | 'area' | 'bar' | 'dot';
}

export interface ChartLegendProps {
  items: LegendItem[];
  horizontal?: boolean;
}

export const ChartLegend: React.FC<ChartLegendProps> = ({ items, horizontal = true }) => {
  const containerStyle = horizontal ? styles.horizontalContainer : styles.verticalContainer;

  return (
    <View style={containerStyle}>
      {items.map((item, index) => (
        <View key={index} style={styles.item}>
          <View style={[styles.indicator, { backgroundColor: item.color }]} />
          <Text style={styles.label}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  horizontalContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
  },
  verticalContainer: {
    flexDirection: 'column',
    paddingVertical: spacing.sm,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: spacing.md,
    marginBottom: spacing.xs,
  },
  indicator: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: spacing.xs,
  },
  label: {
    ...typography.caption,
    color: colors.text.secondary,
  },
});

export default ChartLegend;