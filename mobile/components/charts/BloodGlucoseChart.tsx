/**
 * ============================================================================
 * BLOOD GLUCOSE CHART — Mobile Port (React Native / TypeScript)
 * ============================================================================
 *
 * Ported from: frontend/src/components/PureGlucoseVisualization.js
 * Location:    mobile/components/charts/BloodGlucoseChart.tsx
 *
 * A clean, biological-curve visualization showing raw blood glucose readings
 * only. No meal effects, no insulin effects, no cumulative baseline —
 * just the glucose signal as a smooth physiological curve.
 *
 * KEY DIFFERENCES FROM WEB VERSION:
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. DATA SOURCE
 *    Web:    last24hData from BloodSugarDataContext
 *    Mobile: Shared useGlucoseBuffer() from @/hooks/useBloodGlucoseEstimation (P8 —
 *            migrated from @/hooks/useGlucoseBuffer, §9-M-13).
 *
 * 2. CHART LIBRARY
 *    Web:    Recharts ComposedChart + Line/Area/ReferenceArea
 *    Mobile: victory-native — VictoryChart + VictoryLine/VictoryArea/VictoryAxis
 *
 * 3. GRADIENT LINE → BANDED COLOR SEGMENTS
 *    Web:    stroke="url(#glucoseLineGradient)" — SVG vertical gradient on stroke.
 *    Mobile: Victory-native does not support SVG gradient strokes. Instead, the
 *            plot points are split into three arrays (one per colour band: red,
 *            orange, green) and rendered as separate VictoryLine components.
 *            Transition points are shared between adjacent bands so the joins
 *            are seamless at dense (CGM) data density.
 *
 * 4. REFERENCE AREAS → VICTORY AREA BANDS
 *    Web:    <ReferenceArea y1={…} y2={…} /> per zone.
 *    Mobile: Two-point VictoryArea datasets [{x: start, y: top, y0: bottom},
 *            {x: end, y: top, y0: bottom}] produce horizontal band fills.
 *
 * 5. TOOLTIP
 *    Web:    Recharts custom <Tooltip content={…} />
 *    Mobile: React Native Modal triggered by tapping scatter dots.
 *
 * 6. FULLSCREEN
 *    Web:    document.requestFullscreen()
 *    Mobile: Removed — no browser API.
 *
 * FEATURES:
 *   📊 Stats bar   — Current reading, Avg, Min, Max, Time in Range, Count
 *   🎨 Color bands — Red (very high/very low), Orange (high/low), Green (target)
 *   🏔 Soft fill   — Gradient area under the glucose curve
 *   🟩 Zone shading — Background tints for low / target / high zones
 *   ─── Reference lines — High, Target, Low thresholds
 *   │   Now line   — Current time marker
 *   🔵 Actual dots — Coloured reading markers (larger for SMBG, tiny for CGM)
 *   ⏱ View modes  — 3H / 6H / 12H / 24H / 3D
 * ============================================================================
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Dimensions,
  Modal,
  Platform,
} from 'react-native';

// ── Chart library ──────────────────────────────────────────────────────────────
import {
  VictoryChart,
  VictoryArea,
  VictoryLine,
  VictoryAxis,
  VictoryScatter,
  VictoryTheme,
} from 'victory-native';

// ── Hooks / utilities ──────────────────────────────────────────────────────────
import { usePatientConstants } from '@/hooks/usePatientConstants';
import UnifiedTimePicker from '@/components/forms/UnifiedTimePicker';
import apiClient from '@/services/api/client';
import API from '@/services/api/endpoints';
import { useGlucoseBuffer, type GlucoseReading } from '@/hooks/useBloodGlucoseEstimation'; // P8 — migrated from useGlucoseBuffer (§9-M-13)
import {
  useCurrentMinute,
  useChartTimeRange,
  generateXAxisTicks,
  parseUTCMs,
  VIEW_CONFIGS,
  formatXAxis,
  type TimeRange,
} from '@/utils/ChartUtils';

// ============================================================
// CONSTANTS
// ============================================================

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CHART_HEIGHT  = 320;
const CHART_WIDTH   = SCREEN_WIDTH - 32;
const BG_DOMAIN: [number, number] = [40, 400];

// ── Glucose bands (mirrors PureGlucoseVisualization.js) ──────────────────────
const GLUCOSE_BANDS = {
  veryHigh: { min: 250, max: 400, color: '#ef4444', label: 'Very High', bgColor: 'rgba(239,68,68,0.08)'  },
  high:     { min: 180, max: 250, color: '#f97316', label: 'High',      bgColor: 'rgba(249,115,22,0.08)' },
  target:   { min: 70,  max: 180, color: '#22c55e', label: 'Target',    bgColor: 'rgba(34,197,94,0.10)'  },
  low:      { min: 54,  max: 70,  color: '#f97316', label: 'Low',       bgColor: 'rgba(249,115,22,0.08)' },
  veryLow:  { min: 40,  max: 54,  color: '#ef4444', label: 'Very Low',  bgColor: 'rgba(239,68,68,0.08)'  },
} as const;

type BandKey = keyof typeof GLUCOSE_BANDS;

// VIEW_CONFIGS is imported from ChartUtils (merges shared-constants with safe defaults).
// View buttons are derived dynamically so adding a new mode to shared-constants
// automatically appears here — no manual list to keep in sync.

// ============================================================
// TYPES
// ============================================================

interface PlotPoint {
  timestamp:  number;
  glucose:    number;
  isActual:   boolean;
  source:     string;
  band:       typeof GLUCOSE_BANDS[BandKey];
  bandKey:    BandKey;
}

interface GlucoseStats {
  avg:    number;
  min:    number;
  max:    number;
  tir:    number;     // % time in range (70–180)
  count:  number;
  latest: PlotPoint;
}

interface TooltipPoint {
  point: PlotPoint;
}

export interface BloodGlucoseChartProps {
  height?:       number;
  showControls?: boolean;
  embedded?:     boolean;
  defaultView?:  string;
}

// ============================================================
// HELPERS
// ============================================================

// parseUTCMs is imported from ChartUtils

function getBandKey(value: number): BandKey {
  if (value >= 250) return 'veryHigh';
  if (value >= 180) return 'high';
  if (value >= 70)  return 'target';
  if (value >= 54)  return 'low';
  return 'veryLow';
}

function getBand(value: number) {
  return GLUCOSE_BANDS[getBandKey(value)];
}

/** Colour group: veryHigh+veryLow → red, high+low → orange, target → green */
function getLineColorGroup(key: BandKey): 'red' | 'orange' | 'green' {
  if (key === 'veryHigh' || key === 'veryLow') return 'red';
  if (key === 'high'     || key === 'low')     return 'orange';
  return 'green';
}

const LINE_GROUP_COLORS: Record<'red' | 'orange' | 'green', string> = {
  red:    '#ef4444',
  orange: '#f97316',
  green:  '#22c55e',
};

// formatTimestamp is replaced by formatXAxis imported from ChartUtils

// ============================================================
// BUILD PLOT POINTS (mirrors buildPlotPoints from JS)
// ============================================================

/** 5-minute smoothstep interpolation between sparse SMBG readings. */
function buildPlotPoints(
  readings: GlucoseReading[],
  timeRange: TimeRange,
  isCGM: boolean,
  interpolationIntervalMin = 5,
): PlotPoint[] {
  if (!readings || readings.length === 0) return [];

  const { start, end } = timeRange;

  const visible = readings
    .filter(r => r.timestamp >= start && r.timestamp <= end && r.bloodSugar > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (visible.length === 0) return [];

  if (isCGM) {
    return visible.map(r => ({
      timestamp: r.timestamp,
      glucose:   r.bloodSugar,
      isActual:  true,
      source:    r.source ?? 'cgm',
      band:      getBand(r.bloodSugar),
      bandKey:   getBandKey(r.bloodSugar),
    }));
  }

  // SMBG: smooth interpolation between readings
  if (visible.length === 1) {
    return [{
      timestamp: visible[0].timestamp,
      glucose:   visible[0].bloodSugar,
      isActual:  true,
      source:    'smbg',
      band:      getBand(visible[0].bloodSugar),
      bandKey:   getBandKey(visible[0].bloodSugar),
    }];
  }

  const points: PlotPoint[] = [];
  const INTERVAL_MS = interpolationIntervalMin * 60 * 1_000;

  for (let i = 0; i < visible.length - 1; i++) {
    const a    = visible[i];
    const b    = visible[i + 1];
    const span = b.timestamp - a.timestamp;
    const steps = Math.round(span / INTERVAL_MS);

    points.push({
      timestamp: a.timestamp,
      glucose:   a.bloodSugar,
      isActual:  true,
      source:    'smbg',
      band:      getBand(a.bloodSugar),
      bandKey:   getBandKey(a.bloodSugar),
    });

    for (let s = 1; s < steps; s++) {
      const t      = s / steps;
      // Smoothstep (S-curve) — mimics physiological rise/fall
      const smooth = t * t * (3 - 2 * t);
      const interp = a.bloodSugar + smooth * (b.bloodSugar - a.bloodSugar);
      points.push({
        timestamp: a.timestamp + s * INTERVAL_MS,
        glucose:   interp,
        isActual:  false,
        source:    'interpolated',
        band:      getBand(interp),
        bandKey:   getBandKey(interp),
      });
    }
  }

  const last = visible[visible.length - 1];
  points.push({
    timestamp: last.timestamp,
    glucose:   last.bloodSugar,
    isActual:  true,
    source:    'smbg',
    band:      getBand(last.bloodSugar),
    bandKey:   getBandKey(last.bloodSugar),
  });

  return points;
}

// ============================================================
// BANDED DATA ARRAYS for multi-color Victory lines
//
// Each plotPoint appears in its own color group.
// At color-group transitions (point i is green, point i+1 is orange),
// the transition point is included in BOTH adjacent color arrays so the
// lines join seamlessly with no visible gap at the boundary.
// ============================================================

function buildBandedData(points: PlotPoint[]): Record<'red' | 'orange' | 'green', Array<{ x: number; y: number | null }>> {
  const red:    Array<{ x: number; y: number | null }> = [];
  const orange: Array<{ x: number; y: number | null }> = [];
  const green:  Array<{ x: number; y: number | null }> = [];

  const groups = (['red', 'orange', 'green'] as const);

  points.forEach((p, i) => {
    const myGroup  = getLineColorGroup(p.bandKey);
    const prevGroup = i > 0                    ? getLineColorGroup(points[i - 1].bandKey) : myGroup;
    const nextGroup = i < points.length - 1    ? getLineColorGroup(points[i + 1].bandKey) : myGroup;

    for (const g of groups) {
      const isMyGroup  = g === myGroup;
      // Bridge: include in the adjacent group at color-change boundaries
      const isBridgeIn  = g === prevGroup && prevGroup !== myGroup;
      const isBridgeOut = g === nextGroup && nextGroup !== myGroup;

      const arr = g === 'red' ? red : g === 'orange' ? orange : green;
      arr.push({ x: p.timestamp, y: (isMyGroup || isBridgeIn || isBridgeOut) ? p.glucose : null });
    }
  });

  return { red, orange, green };
}

// ============================================================
// STATS
// ============================================================

function computeStats(points: PlotPoint[], targetGlucose: number): GlucoseStats | null {
  const actual = points.filter(p => p.isActual);
  if (actual.length === 0) return null;

  const values  = actual.map(p => p.glucose);
  const avg     = values.reduce((s, v) => s + v, 0) / values.length;
  const min     = Math.min(...values);
  const max     = Math.max(...values);
  const inRange = actual.filter(p => p.glucose >= 70 && p.glucose <= 180).length;
  const tir     = Math.round((inRange / actual.length) * 100);

  return {
    avg:    Math.round(avg),
    min:    Math.round(min),
    max:    Math.round(max),
    tir,
    count:  actual.length,
    latest: actual[actual.length - 1],
  };
}
// ============================================================
// TOOLTIP MODAL
// ============================================================

interface GlucoseTooltipModalProps {
  point:         PlotPoint;
  targetGlucose: number;
  onClose:       () => void;
}

const GlucoseTooltipModal: React.FC<GlucoseTooltipModalProps> = ({
  point, targetGlucose, onClose,
}) => {
  const { band, glucose, timestamp, source } = point;
  const delta    = glucose - targetGlucose;
  const deltaStr = `${delta >= 0 ? '+' : ''}${Math.round(delta)} mg/dL vs target`;
  const timeStr  = new Date(timestamp).toLocaleString('en-GB', {
    hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short',
  });

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity
        style={ttStyles.overlay}
        activeOpacity={1}
        onPress={onClose}
      >
        <TouchableOpacity activeOpacity={1} style={[ttStyles.card, { borderColor: band.color }]}>
          <Text style={ttStyles.time}>{timeStr}</Text>

          <View style={ttStyles.valueRow}>
            <Text style={[ttStyles.value, { color: band.color }]}>
              {Math.round(glucose)}
            </Text>
            <Text style={ttStyles.unit}> mg/dL</Text>
          </View>

          <View style={[ttStyles.bandBadge, { backgroundColor: band.bgColor }]}>
            <Text style={[ttStyles.bandLabel, { color: band.color }]}>
              {band.label}
            </Text>
          </View>

          <Text style={ttStyles.delta}>{deltaStr}</Text>

          {source === 'interpolated' && (
            <Text style={ttStyles.interpolated}>↗ Interpolated point</Text>
          )}

          <Text style={ttStyles.close}>Tap outside to close</Text>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

const ttStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 2,
    padding: 20,
    minWidth: 200,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  time:         { fontSize: 11, color: '#6b7280', marginBottom: 8 },
  valueRow:     { flexDirection: 'row', alignItems: 'baseline' },
  value:        { fontSize: 42, fontWeight: '800', lineHeight: 48 },
  unit:         { fontSize: 14, color: '#6b7280' },
  bandBadge:    { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 4, marginTop: 8 },
  bandLabel:    { fontSize: 13, fontWeight: '700' },
  delta:        { fontSize: 12, color: '#9ca3af', marginTop: 8 },
  interpolated: { fontSize: 11, color: '#d1d5db', marginTop: 4, fontStyle: 'italic' },
  close:        { fontSize: 11, color: '#d1d5db', marginTop: 12 },
});

// ============================================================
// STATS BAR
// ============================================================

interface StatsBarProps {
  stats:         GlucoseStats;
  targetGlucose: number;
}

const StatsBar: React.FC<StatsBarProps> = ({ stats, targetGlucose }) => {
  const latestBand = stats.latest.band;
  const tirColor   = stats.tir >= 70 ? '#22c55e' : stats.tir >= 50 ? '#f97316' : '#ef4444';

  return (
    <View style={sbStyles.container}>
      {/* Most recent reading — prominent, band-colored */}
      <View style={[sbStyles.currentSection, { backgroundColor: latestBand.bgColor, borderRightColor: latestBand.color }]}>
        <Text style={sbStyles.currentLabel}>Most Recent</Text>
        <View style={sbStyles.currentValueRow}>
          <Text style={[sbStyles.currentValue, { color: latestBand.color }]}>
            {Math.round(stats.latest.glucose)}
          </Text>
          <Text style={sbStyles.currentUnit}>mg/dL</Text>
        </View>
        <Text style={[sbStyles.currentBand, { color: latestBand.color }]}>
          {latestBand.label === 'Target' ? '' : latestBand.label}
        </Text>
        <Text style={sbStyles.currentTimestamp}>
          {new Date(stats.latest.timestamp).toLocaleString('en-GB', {
            day: '2-digit', month: 'short',
            hour: '2-digit', minute: '2-digit',
          })}
        </Text>
      </View>

      {/* Stats pills */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={sbStyles.pillsScroll}>
        <View style={sbStyles.pillsRow}>
          {[
            { label: 'Avg',       value: `${stats.avg}`,     color: '#4b5563' },
            { label: 'Min',       value: `${stats.min}`,     color: GLUCOSE_BANDS.low.color  },
            { label: 'Max',       value: `${stats.max}`,     color: GLUCOSE_BANDS.high.color },
            { label: 'TIR',       value: `${stats.tir}%`,    color: tirColor },
            { label: 'Readings',  value: `${stats.count}`,   color: '#6b7280' },
          ].map(({ label, value, color }) => (
            <View key={label} style={sbStyles.pill}>
              <Text style={[sbStyles.pillValue, { color }]}>{value}</Text>
              <Text style={sbStyles.pillLabel}>{label}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
};

const sbStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    overflow: 'hidden',
    marginHorizontal: 12,
    marginBottom: 8,
    backgroundColor: '#f9fafb',
  },
  currentSection: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRightWidth: 3,
    minWidth: 112,
    justifyContent: 'center',
  },
  currentLabel:     { fontSize: 10, color: '#6b7280' },
  currentValueRow:  { flexDirection: 'row', alignItems: 'baseline', marginTop: 2 },
  currentValue:     { fontSize: 20, fontWeight: '800', lineHeight: 26 },
  currentUnit:      { fontSize: 11, color: '#6b7280', marginLeft: 3 },
  currentBand:      { fontSize: 11, fontWeight: '600', marginTop: 2 },
  currentTimestamp: { fontSize: 10, color: '#9ca3af', marginTop: 3 },
  pillsScroll:     { flex: 1 },
  pillsRow:        { flexDirection: 'row', alignItems: 'stretch', paddingHorizontal: 4 },
  pill: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRightWidth: 1,
    borderRightColor: '#f0f0f0',
    minWidth: 64,
  },
  pillValue: { fontSize: 16, fontWeight: '700' },
  pillLabel: { fontSize: 10, color: '#9ca3af', marginTop: 2 },
});


// ============================================================
// CUSTOM VIEW CONFIG  — auto-selects tick density from duration
// ============================================================

function getCustomViewConfig(start: Date, end: Date): any {
  const durationHours = (end.getTime() - start.getTime()) / 3_600_000;
  const futureHours   = Math.max(0, (end.getTime() - Date.now()) / 3_600_000);
  const pastHours     = Math.max(0, (Date.now() - start.getTime()) / 3_600_000);
  let tickFormat: string;
  let tickInterval: number;
  let interpolationInterval: number;
  if (durationHours <= 6)        { tickFormat = 'HH:mm'; tickInterval = 1;  interpolationInterval = 5;  }
  else if (durationHours <= 24)  { tickFormat = 'HH:mm'; tickInterval = 3;  interpolationInterval = 15; }
  else if (durationHours <= 72)  { tickFormat = 'DD/MM'; tickInterval = 12; interpolationInterval = 30; }
  else if (durationHours <= 168) { tickFormat = 'DD/MM'; tickInterval = 24; interpolationInterval = 60; }
  else                           { tickFormat = 'DD/MM'; tickInterval = 72; interpolationInterval = 60; }
  return { label: 'Custom', pastHours, futureHours, tickInterval, tickFormat, interpolationInterval, mealLookback: pastHours, insulinLookback: pastHours };
}

// ============================================================
// MAIN COMPONENT
// ============================================================

const BloodGlucoseChart: React.FC<BloodGlucoseChartProps> = ({
  height       = CHART_HEIGHT,
  showControls = true,
  embedded     = false,
  defaultView  = '12h',
}) => {
  const { constants: patientConstants } = usePatientConstants();
  const effectiveTarget: number = patientConstants?.target_glucose ?? 100;
  const highThreshold = effectiveTarget * 1.3;
  const lowThreshold  = effectiveTarget * 0.7;

  const [viewMode,       setViewMode]       = useState(defaultView);
  const [tooltipData,   setTooltipData]   = useState<TooltipPoint | null>(null);
  const [aboutExpanded, setAboutExpanded] = useState(false);

  // ── Custom date-range filter ──────────────────────────────────────────────
  const [customRangeStart, setCustomRangeStart] = useState<Date>(() => new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000));
  const [customRangeEnd,   setCustomRangeEnd]   = useState<Date>(() => new Date());
  const [customApplied,    setCustomApplied]    = useState(true);


  const currentMinute  = useCurrentMinute();
  // Always call hook unconditionally; override result when custom mode is active.
  const _hookTimeRange = useChartTimeRange(viewMode === 'custom' ? '24h' : viewMode, currentMinute);

  const timeRange: TimeRange = useMemo(() => {
    if (viewMode === 'custom' && customApplied) {
      return { start: customRangeStart.getTime(), end: customRangeEnd.getTime(), now: Date.now() };
    }
    return _hookTimeRange;
  }, [viewMode, customApplied, customRangeStart, customRangeEnd, _hookTimeRange]);

  const viewConfig = useMemo(() =>
    viewMode === 'custom'
      ? getCustomViewConfig(customRangeStart, customRangeEnd)
      : (VIEW_CONFIGS[viewMode] ?? VIEW_CONFIGS['12h']),
  [viewMode, customRangeStart, customRangeEnd]);

  const { rangeStart, rangeEnd } = useMemo(() => ({
    rangeStart: timeRange.start,
    rangeEnd:   timeRange.end,
  }), [timeRange]);

  // ── Data ────────────────────────────────────────────────────────────────────
  const { readings, isLoading, error, refresh } = useGlucoseBuffer(
    rangeStart,
    rangeEnd,
    viewConfig.pastHours,
    60_000,
    'BloodGlucoseChart',
  );

  // Detect CGM mode: majority of readings sourced from a CGM device
  const isCGM = useMemo(() => {
    if (readings.length === 0) return false;
    const cgmCount = readings.filter(r =>
      r.source === 'cgm' || r.source === 'libre_cgm' || r.source === 'libre'
    ).length;
    return cgmCount / readings.length > 0.5;
  }, [readings]);

  // ── Plot points ──────────────────────────────────────────────────────────────
  const plotPoints = useMemo(
    () => buildPlotPoints(readings, timeRange, isCGM, viewConfig.interpolationInterval ?? 5),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readings.length, timeRange.start, timeRange.end, isCGM, viewConfig.interpolationInterval]
  );

  // ── Stats ────────────────────────────────────────────────────────────────────
  const stats = useMemo(
    () => computeStats(plotPoints, effectiveTarget),
    [plotPoints, effectiveTarget]
  );

  // ── Banded color data for Victory lines ──────────────────────────────────────
  const { red: redData, orange: orangeData, green: greenData } = useMemo(
    () => buildBandedData(plotPoints),
    [plotPoints]
  );

  // ── Soft fill under curve ────────────────────────────────────────────────────
  const fillData = useMemo(
    () => plotPoints.map(p => ({ x: p.timestamp, y: p.glucose, y0: BG_DOMAIN[0] })),
    [plotPoints]
  );

  // ── Actual reading dots (scatter) ────────────────────────────────────────────
  const actualDots = useMemo(
    () => plotPoints
      .filter(p => p.isActual)
      .map(p => ({
        x:     p.timestamp,
        y:     p.glucose,
        color: p.band.color,
        point: p,
      })),
    [plotPoints]
  );

  // ── Zone background bands (constant across full x range) ─────────────────────
  // Two-point VictoryArea datasets produce flat horizontal fills.
  const { xS, xE } = { xS: timeRange.start, xE: timeRange.end };
  const zoneLow    = [{ x: xS, y: lowThreshold,  y0: BG_DOMAIN[0] }, { x: xE, y: lowThreshold,  y0: BG_DOMAIN[0] }];
  const zoneTarget = [{ x: xS, y: highThreshold, y0: lowThreshold  }, { x: xE, y: highThreshold, y0: lowThreshold  }];
  const zoneHigh   = [{ x: xS, y: BG_DOMAIN[1],  y0: highThreshold }, { x: xE, y: BG_DOMAIN[1],  y0: highThreshold }];

  // ── X-axis ticks ─────────────────────────────────────────────────────────────
  const xTicks = useMemo(
    () => generateXAxisTicks(timeRange, viewConfig),
    [timeRange, viewConfig]
  );

  // ── Loading / error ───────────────────────────────────────────────────────────
  if (isLoading && plotPoints.length === 0) {
    return (
      <View style={[styles.centered, { height }]}>
        <ActivityIndicator size="large" color="#22c55e" />
        <Text style={styles.loadingText}>Loading glucose data…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.centered, { height }]}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={refresh}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.container, embedded && styles.embedded]}>

      {/* ── Header ── */}
      {showControls && (
        <View style={styles.header}>
          <View>
            <Text style={styles.headerTitle}>Blood Glucose</Text>
            <Text style={styles.headerSubtitle}>
              {isCGM ? 'CGM Continuous Trace' : 'SMBG with smooth interpolation'}
            </Text>
          </View>
          <TouchableOpacity onPress={refresh} style={styles.refreshBtn} hitSlop={8}>
            <Text style={styles.refreshIcon}>{isLoading ? '⏳' : '🔄'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── View mode selector ── */}
      {showControls && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.viewModeScroll}
          contentContainerStyle={styles.viewModeRow}
        >
          {Object.entries(VIEW_CONFIGS).map(([key, cfg]) => (
            <TouchableOpacity
              key={key}
              style={[styles.viewModeBtn, viewMode === key && styles.viewModeBtnActive]}
              onPress={() => setViewMode(key)}
            >
              <Text style={[
                styles.viewModeBtnText,
                viewMode === key && styles.viewModeBtnTextActive,
              ]}>
                {cfg.label}
              </Text>
            </TouchableOpacity>
          ))}
          {/* 📅 Custom date-range button */}
          <TouchableOpacity
            style={[styles.viewModeBtn, styles.viewModeBtnCustom, viewMode === 'custom' && styles.viewModeBtnActive]}
            onPress={() => setViewMode('custom')}
          >
            <Text style={[styles.viewModeBtnText, viewMode === 'custom' && styles.viewModeBtnTextActive]}>
              📅 Range
            </Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {/* ── Custom date-range panel ── */}
      {showControls && viewMode === 'custom' && (
        <View style={styles.customRangePanel}>
          <View style={styles.customRangeRow}>
            <View style={styles.customRangePicker}>
              <UnifiedTimePicker
                label="From"
                value={customRangeStart}
                onChange={(iso) => { setCustomRangeStart(new Date(iso)); setCustomApplied(false); }}
                mode="custom"
                showModeSelector
                displayFormat="datetime"
              />
            </View>
            <View style={styles.customRangePicker}>
              <UnifiedTimePicker
                label="To"
                value={customRangeEnd}
                onChange={(iso) => { setCustomRangeEnd(new Date(iso)); setCustomApplied(false); }}
                mode="custom"
                showModeSelector
                displayFormat="datetime"
              />
            </View>
          </View>
          <TouchableOpacity
            style={[styles.customRangeApplyBtn, customApplied && styles.customRangeAppliedBtn]}
            onPress={() => setCustomApplied(true)}
            disabled={customApplied}
          >
            <Text style={styles.customRangeApplyText}>
              {customApplied ? '✓ Applied' : 'Apply Range'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Empty state ── */}
      {plotPoints.length === 0 ? (
        <View style={[styles.centered, { height: height * 0.7 }]}>
          <Text style={styles.emptyIcon}>📈</Text>
          <Text style={styles.emptyTitle}>No glucose data in this window</Text>
          <Text style={styles.emptySubtitle}>Log a blood glucose reading to see your curve</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={refresh}>
            <Text style={styles.retryText}>Refresh</Text>
          </TouchableOpacity>
        </View>
      ) : (
        /* ── Victory Chart ── */
        <View style={styles.chartWrapper}>
          <VictoryChart
            width={CHART_WIDTH}
            height={height}
            theme={VictoryTheme.material}
            domain={{ x: [timeRange.start, timeRange.end], y: BG_DOMAIN }}
            padding={{ top: 12, bottom: 48, left: 52, right: 20 }}
          >
            {/* X Axis */}
            <VictoryAxis
              tickValues={xTicks}
              tickFormat={(t: number) => formatXAxis(t, viewConfig?.tickFormat)}
              axisValue={BG_DOMAIN[0]}
              style={{
                tickLabels: { fontSize: 9, angle: -40, textAnchor: 'end', fill: '#6b7280' },
                grid:       { stroke: '#f3f4f6', strokeDasharray: '3 3' },
                axis:       { stroke: '#d1d5db' },
              }}
            />

            {/* Y Axis (left) — Blood Glucose */}
            <VictoryAxis
              dependentAxis
              tickValues={[40, 54, 70, 100, 140, 180, 250, 300, 350, 400]}
              tickFormat={(v: number) => `${v}`}
              label="mg/dL"
              style={{
                axisLabel:  { fontSize: 10, fill: '#9ca3af', padding: 36 },
                tickLabels: { fontSize: 9,  fill: '#6b7280' },
                grid:       { stroke: '#f3f4f6', strokeDasharray: '3 3' },
                axis:       { stroke: '#d1d5db' },
              }}
            />

            {/* ── Zone background shading ── */}
            {/* Low zone — faint red */}
            <VictoryArea
              data={zoneLow}
              style={{ data: { fill: '#ef4444', fillOpacity: 0.06, stroke: 'none' } }}
            />
            {/* Target zone — faint green */}
            <VictoryArea
              data={zoneTarget}
              style={{ data: { fill: '#22c55e', fillOpacity: 0.08, stroke: 'none' } }}
            />
            {/* High zone — faint orange */}
            <VictoryArea
              data={zoneHigh}
              style={{ data: { fill: '#f97316', fillOpacity: 0.06, stroke: 'none' } }}
            />

            {/* ── Soft fill under the curve ── */}
            <VictoryArea
              data={fillData}
              defined={(d: any) => d.y !== null && !isNaN(d.y)}
              interpolation="monotoneX"
              style={{
                data: {
                  fill:        '#22c55e',
                  fillOpacity: 0.08,
                  stroke:      'none',
                },
              }}
            />

            {/* ── Reference lines (High / Target / Low) ── */}
            {/* These use axisValue on a dependentAxis to draw vertical lines —
                to draw HORIZONTAL lines we need a dependentAxis on a non-dep axis.
                Use a 2-point VictoryLine instead for horizontal reference lines. */}
            <VictoryLine
              data={[{ x: xS, y: highThreshold }, { x: xE, y: highThreshold }]}
              style={{ data: { stroke: '#f97316', strokeWidth: 1.5, strokeDasharray: '5 3' } }}
            />
            <VictoryLine
              data={[{ x: xS, y: effectiveTarget }, { x: xE, y: effectiveTarget }]}
              style={{ data: { stroke: '#22c55e', strokeWidth: 1.5, strokeDasharray: '4 2' } }}
            />
            <VictoryLine
              data={[{ x: xS, y: lowThreshold }, { x: xE, y: lowThreshold }]}
              style={{ data: { stroke: '#ef4444', strokeWidth: 1.5, strokeDasharray: '5 3' } }}
            />

            {/* ── "Now" vertical line — hidden for week/month (futureHours=0, now ≈ chart end) ── */}
            {timeRange.now && (viewConfig.futureHours ?? 1) > 0 && (
              <VictoryAxis
                dependentAxis
                axisValue={timeRange.now}
                tickFormat={() => ''}
                style={{
                  axis:       { stroke: '#6b7280', strokeWidth: 1.5, strokeDasharray: '6 3' },
                  grid:       { stroke: 'none' },
                  ticks:      { size: 0 },
                  tickLabels: { fontSize: 0, fill: 'none' },
                }}
              />
            )}

            {/* ── Multi-color glucose line (3 Victory lines, one per colour group) ──
                Each line has `defined` to skip null values and create the correct
                color segment, with transition bridging for seamless joins. */}
            <VictoryLine
              data={greenData}
              defined={(d: any) => d.y !== null && !isNaN(d.y)}
              interpolation="monotoneX"
              style={{ data: { stroke: '#22c55e', strokeWidth: isCGM ? 2.5 : 2 } }}
            />
            <VictoryLine
              data={orangeData}
              defined={(d: any) => d.y !== null && !isNaN(d.y)}
              interpolation="monotoneX"
              style={{ data: { stroke: '#f97316', strokeWidth: isCGM ? 2.5 : 2 } }}
            />
            <VictoryLine
              data={redData}
              defined={(d: any) => d.y !== null && !isNaN(d.y)}
              interpolation="monotoneX"
              style={{ data: { stroke: '#ef4444', strokeWidth: isCGM ? 2.5 : 2 } }}
            />

            {/* ── Actual reading dots ── */}
            {/* CGM: tiny dots anchor hover targets.  SMBG: larger coloured rings. */}
            {actualDots.length > 0 && (
              <VictoryScatter
                data={actualDots}
                size={isCGM ? 1.5 : 3}
                style={{
                  data: {
                    fill:        ({ datum }: any) => datum.color,
                    stroke:      '#fff',
                    strokeWidth: isCGM ? 0.5 : 1,
                    opacity:     isCGM ? 0.8 : 1,
                  },
                }}
                events={Platform.OS !== 'web' ? [{
                  target: 'data',
                  eventHandlers: {
                    onPress: () => [{
                      target: 'data',
                      mutation: ({ datum }: any) => {
                        setTooltipData({ point: datum.point });
                        return null;
                      },
                    }],
                  },
                }] : []}
              />
            )}
          </VictoryChart>
        </View>
      )}

      {/* ── Stats bar (below chart) ── */}
      {stats && <StatsBar stats={stats} targetGlucose={effectiveTarget} />}

      {/* ── About this Chart (collapsible, default collapsed) ── */}
      <View style={styles.aboutContainer}>
        <TouchableOpacity
          style={styles.aboutHeader}
          onPress={() => setAboutExpanded(prev => !prev)}
          activeOpacity={0.7}
          hitSlop={8}
        >
          <Text style={styles.aboutHeaderText}>About this Chart</Text>
          <Text style={styles.aboutChevron}>{aboutExpanded ? '▲' : '▼'}</Text>
        </TouchableOpacity>

        {aboutExpanded && (
          <View style={styles.aboutBody}>
            {/* Colour legend */}
            <Text style={styles.aboutSectionLabel}>Colour Bands</Text>
            <View style={styles.aboutLegendGrid}>
              {[
                { color: '#ef4444', label: 'Very High', range: '> 250 mg/dL'  },
                { color: '#f97316', label: 'High',      range: '180–250 mg/dL' },
                { color: '#22c55e', label: 'Target',    range: '70–180 mg/dL'  },
                { color: '#f97316', label: 'Low',       range: '54–70 mg/dL'   },
                { color: '#ef4444', label: 'Very Low',  range: '< 54 mg/dL'    },
              ].map(({ color, label, range }) => (
                <View key={label} style={styles.aboutLegendRow}>
                  <View style={[styles.aboutDot, { backgroundColor: color }]} />
                  <Text style={styles.aboutLegendLabel}>{label}</Text>
                  <Text style={styles.aboutLegendRange}>{range}</Text>
                </View>
              ))}
            </View>

            {/* Reference lines */}
            <Text style={[styles.aboutSectionLabel, { marginTop: 10 }]}>Reference Lines</Text>
            {[
              { dash: '– – –', color: '#f97316', desc: 'High threshold'   },
              { dash: '– – –', color: '#22c55e', desc: 'Target glucose'   },
              { dash: '– – –', color: '#ef4444', desc: 'Low threshold'    },
              { dash: '· · ·', color: '#6b7280', desc: 'Current time (Now)' },
            ].map(({ dash, color, desc }) => (
              <View key={desc} style={styles.aboutRefRow}>
                <Text style={[styles.aboutDash, { color }]}>{dash}</Text>
                <Text style={styles.aboutRefDesc}>{desc}</Text>
              </View>
            ))}

            {/* Data source note */}
            {!isCGM && (
              <View style={styles.aboutNoteBox}>
                <Text style={styles.aboutNoteText}>
                  ↗ Dashed segments are smoothly interpolated between manual (SMBG) readings using a physiological S-curve.
                </Text>
              </View>
            )}
          </View>
        )}
      </View>

      {/* ── Tooltip Modal ── */}
      {tooltipData !== null && (
        <GlucoseTooltipModal
          point={tooltipData.point}
          targetGlucose={effectiveTarget}
          onClose={() => setTooltipData(null)}
        />
      )}
    </View>
  );
};

// ============================================================
// STYLESHEET
// ============================================================

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  embedded: {
    borderRadius: 0,
    shadowOpacity: 0,
    elevation: 0,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  loadingText: { marginTop: 12, fontSize: 14, color: '#6b7280' },
  errorText:   { fontSize: 14, color: '#ef4444', textAlign: 'center', marginBottom: 12 },
  retryBtn:    { paddingHorizontal: 24, paddingVertical: 10, backgroundColor: '#22c55e', borderRadius: 8, marginTop: 8 },
  retryText:   { color: '#fff', fontWeight: '600' },
  emptyIcon:   { fontSize: 48, marginBottom: 12 },
  emptyTitle:  { fontSize: 15, fontWeight: '600', color: '#6b7280', textAlign: 'center' },
  emptySubtitle: { fontSize: 12, color: '#9ca3af', marginTop: 4, textAlign: 'center' },

  // ── Header ──
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  headerTitle:    { fontSize: 16, fontWeight: '700', color: '#111827' },
  headerSubtitle: { fontSize: 11, color: '#6b7280', marginTop: 2 },
  refreshBtn:     { padding: 4 },
  refreshIcon:    { fontSize: 20 },

  // ── View mode ──
  viewModeScroll:         { borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  viewModeRow:            { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8, gap: 6 },
  viewModeBtn:            { paddingHorizontal: 14, paddingVertical: 5, borderRadius: 20, backgroundColor: '#f5f5f5' },
  viewModeBtnActive:      { backgroundColor: '#22c55e' },
  viewModeBtnText:        { fontSize: 13, fontWeight: '600', color: '#555' },
  viewModeBtnTextActive:  { color: '#fff' },

  // ── Custom date-range panel ──
  viewModeBtnCustom:      { borderWidth: 1.5, borderColor: '#22c55e', backgroundColor: 'transparent' },
  customRangePanel:       { paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0', backgroundColor: '#f9fff9' },
  customRangeRow:         { flexDirection: 'row', gap: 8, marginBottom: 4 },
  customRangePicker:      { flex: 1 },
  customRangeApplyBtn:    { backgroundColor: '#22c55e', borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  customRangeAppliedBtn:  { backgroundColor: '#16a34a' },
  customRangeApplyText:   { color: '#fff', fontWeight: '700', fontSize: 14 },

  // ── Chart ──
  chartWrapper: { paddingHorizontal: 0 },

  // ── About this Chart (collapsible) ──
  aboutContainer: {
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    marginTop: 4,
  },
  aboutHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  aboutHeaderText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
  },
  aboutChevron: {
    fontSize: 11,
    color: '#9ca3af',
  },
  aboutBody: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  aboutSectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  aboutLegendGrid: {
    gap: 6,
  },
  aboutLegendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  aboutDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  aboutLegendLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
    width: 72,
  },
  aboutLegendRange: {
    fontSize: 12,
    color: '#6b7280',
  },
  aboutRefRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 5,
  },
  aboutDash: {
    fontSize: 13,
    fontWeight: '700',
    width: 36,
    letterSpacing: 1,
  },
  aboutRefDesc: {
    fontSize: 12,
    color: '#374151',
  },
  aboutNoteBox: {
    marginTop: 12,
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    padding: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#d1d5db',
  },
  aboutNoteText: {
    fontSize: 11,
    color: '#6b7280',
    lineHeight: 16,
  },
});

export default React.memo(BloodGlucoseChart);