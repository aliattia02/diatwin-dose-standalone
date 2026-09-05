/**
 * Chart Components Barrel Export
 * Location: mobile/components/charts/index.ts
 *
 * Description: Central export point for all chart-related components.
 *
 * Components:
 * - EffectsVisualizationChart: MOB/IOB dual-area + net effect + cumulative baseline shift
 * - BloodGlucoseVisualization: Projected BG line with actual readings, confidence split,
 *                              and cumulative effect area (dual-axis style, single VictoryChart)
 * - ChartTooltip: Enhanced tooltip for data point information
 * - ChartLegend: Reusable legend component for charts
 *
 * Usage:
 * ```typescript
 * import {
 *   EffectsVisualizationChart,
 *   BloodGlucoseVisualization,
 *   ChartLegend,
 *   ChartTooltip,
 * } from '@/components/charts';
 * ```
 */

export { default as EffectsVisualizationChart } from './EffectsVisualizationChart';
export type { EffectsVisualizationChartProps } from './EffectsVisualizationChart';

export { default as BloodGlucoseVisualization } from './BloodGlucoseVisualization';
export type { BloodGlucoseVisualizationProps } from './BloodGlucoseVisualization';

export { ChartTooltip } from './ChartTooltip';
export type { ChartTooltipProps } from './ChartTooltip';

export { ChartLegend } from './ChartLegend';
export type { ChartLegendProps, LegendItem } from './ChartLegend';