/**
 * DoctorBGChart
 * Location: mobile/components/doctor/DoctorBGChart.tsx
 *
 * A data-driven adaptation of BloodGlucoseChart for use inside the doctor
 * patient view. Accepts pre-fetched BloodSugarResponse[] instead of calling
 * the patient's own /blood-sugar endpoints, so the doctor sees the patient's
 * actual readings rather than their own.
 *
 * Visual language is intentionally identical to BloodGlucoseChart:
 *   • Multi-color banded line (red / orange / green by glucose zone)
 *   • Zone background fills
 *   • Reference lines — High, Target, Low
 *   • "Now" vertical axis marker
 *   • Actual reading scatter dots
 *   • Stats bar — Avg, Min, Max, TIR%, Count
 *   • View mode selector — 6H / 12H / 24H
 *
 * KEY DIFFERENCE FROM BloodGlucoseChart:
 *   BloodGlucoseChart uses useGlucoseBuffer() to self-fetch.
 *   DoctorBGChart takes `readings` as a prop (already fetched via doctor API).
 */

import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  Modal,
  Platform,
} from 'react-native';
import {
  VictoryChart,
  VictoryArea,
  VictoryLine,
  VictoryAxis,
  VictoryScatter,
} from 'victory-native';
import type { BloodSugarResponse } from '@/types/api';
import { parseUTCMs, formatXAxis, useCurrentMinute, getLastResetTimeMs } from '@/utils/ChartUtils';
import UnifiedTimePicker from '@/components/forms/UnifiedTimePicker';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CHART_HEIGHT = 300;
const CHART_WIDTH  = SCREEN_WIDTH - 48;
const BG_DOMAIN: [number, number] = [40, 400];

const GLUCOSE_BANDS = {
  veryHigh: { min: 250, max: 400, color: '#ef4444', bgColor: 'rgba(239,68,68,0.08)',  label: 'Very High' },
  high:     { min: 180, max: 250, color: '#f97316', bgColor: 'rgba(249,115,22,0.08)', label: 'High'      },
  target:   { min: 70,  max: 180, color: '#22c55e', bgColor: 'rgba(34,197,94,0.10)',  label: 'Target'    },
  low:      { min: 54,  max: 70,  color: '#f97316', bgColor: 'rgba(249,115,22,0.08)', label: 'Low'       },
  veryLow:  { min: 40,  max: 54,  color: '#ef4444', bgColor: 'rgba(239,68,68,0.08)',  label: 'Very Low'  },
} as const;

type BandKey = keyof typeof GLUCOSE_BANDS;

const VIEW_CONFIGS: Record<string, { label: string; pastHours: number; tickInterval: number; tickFormat: string }> = {
  '3h':   { label: '3H',   pastHours: 3,   tickInterval: 1,  tickFormat: 'HH:mm' },
  '6h':   { label: '6H',   pastHours: 6,   tickInterval: 1,  tickFormat: 'HH:mm' },
  '12h':  { label: '12H',  pastHours: 12,  tickInterval: 2,  tickFormat: 'HH:mm' },
  '24h':  { label: '24H',  pastHours: 24,  tickInterval: 3,  tickFormat: 'HH:mm' },
  'week': { label: 'Week', pastHours: 168, tickInterval: 24, tickFormat: 'DD/MM' },
  'month':{ label: 'Month',pastHours: 720, tickInterval: 72, tickFormat: 'DD/MM' },
};

const LINE_COLORS = { red: '#ef4444', orange: '#f97316', green: '#22c55e' } as const;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface PlotPoint {
  timestamp: number;
  glucose:   number;
  isActual:  boolean;
  bandKey:   BandKey;
  color:     string;
}

interface Stats {
  avg: number; min: number; max: number; tir: number; count: number;
}

export interface DoctorBGChartProps {
  readings:      BloodSugarResponse[];
  targetGlucose?: number;
  highThreshold?: number;
  lowThreshold?:  number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — identical logic to BloodGlucoseChart internals
// ─────────────────────────────────────────────────────────────────────────────

// parseUTCMs imported from ChartUtils

function getBandKey(v: number): BandKey {
  if (v >= 250) return 'veryHigh';
  if (v >= 180) return 'high';
  if (v >= 70)  return 'target';
  if (v >= 54)  return 'low';
  return 'veryLow';
}

function getLineGroup(k: BandKey): 'red' | 'orange' | 'green' {
  if (k === 'veryHigh' || k === 'veryLow') return 'red';
  if (k === 'high'     || k === 'low')     return 'orange';
  return 'green';
}

// formatXAxis imported from ChartUtils

/** Smoothstep interpolation between SMBG readings (5-min steps). */
function buildPlotPoints(
  readings: { timestamp: number; bloodSugar: number }[],
  rangeStart: number,
  rangeEnd: number,
): PlotPoint[] {
  const visible = readings
    .filter(r => r.timestamp >= rangeStart && r.timestamp <= rangeEnd && r.bloodSugar > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (!visible.length) return [];

  // Detect CGM (> 4 readings per hour on average)
  const spanHours = (visible[visible.length - 1].timestamp - visible[0].timestamp) / 3_600_000;
  const isCGM = spanHours > 0 && (visible.length / spanHours) > 4;

  if (isCGM) {
    return visible.map(r => ({
      timestamp: r.timestamp,
      glucose:   r.bloodSugar,
      isActual:  true,
      bandKey:   getBandKey(r.bloodSugar),
      color:     LINE_COLORS[getLineGroup(getBandKey(r.bloodSugar))],
    }));
  }

  const STEP = 5 * 60_000;
  const points: PlotPoint[] = [];

  for (let i = 0; i < visible.length - 1; i++) {
    const a = visible[i], b = visible[i + 1];
    points.push({ timestamp: a.timestamp, glucose: a.bloodSugar, isActual: true, bandKey: getBandKey(a.bloodSugar), color: LINE_COLORS[getLineGroup(getBandKey(a.bloodSugar))] });
    const steps = Math.round((b.timestamp - a.timestamp) / STEP);
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const smooth = t * t * (3 - 2 * t);
      const v = a.bloodSugar + smooth * (b.bloodSugar - a.bloodSugar);
      points.push({ timestamp: a.timestamp + s * STEP, glucose: v, isActual: false, bandKey: getBandKey(v), color: LINE_COLORS[getLineGroup(getBandKey(v))] });
    }
  }
  const last = visible[visible.length - 1];
  points.push({ timestamp: last.timestamp, glucose: last.bloodSugar, isActual: true, bandKey: getBandKey(last.bloodSugar), color: LINE_COLORS[getLineGroup(getBandKey(last.bloodSugar))] });
  return points;
}

/** Split points into 3 color arrays with bridging at transitions. */
function buildBandedLines(points: PlotPoint[]) {
  const red:    { x: number; y: number | null }[] = [];
  const orange: { x: number; y: number | null }[] = [];
  const green:  { x: number; y: number | null }[] = [];

  points.forEach((p, i) => {
    const my   = getLineGroup(p.bandKey);
    const prev = i > 0              ? getLineGroup(points[i - 1].bandKey) : my;
    const next = i < points.length - 1 ? getLineGroup(points[i + 1].bandKey) : my;

    for (const g of ['red', 'orange', 'green'] as const) {
      const arr = g === 'red' ? red : g === 'orange' ? orange : green;
      const active = g === my || (g === prev && prev !== my) || (g === next && next !== my);
      arr.push({ x: p.timestamp, y: active ? p.glucose : null });
    }
  });

  return { red, orange, green };
}

function computeStats(points: PlotPoint[]): Stats | null {
  const actual = points.filter(p => p.isActual).map(p => p.glucose);
  if (!actual.length) return null;
  const avg = actual.reduce((s, v) => s + v, 0) / actual.length;
  const inRange = actual.filter(v => v >= 70 && v <= 180).length;
  return {
    avg:   Math.round(avg),
    min:   Math.round(Math.min(...actual)),
    max:   Math.round(Math.max(...actual)),
    tir:   Math.round((inRange / actual.length) * 100),
    count: actual.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom view config — derives tick density from selected date range
// ─────────────────────────────────────────────────────────────────────────────

function getCustomViewConfig(start: Date, end: Date): typeof VIEW_CONFIGS[string] {
  const durationHours = (end.getTime() - start.getTime()) / 3_600_000;
  const pastHours     = Math.max(0, (Date.now() - start.getTime()) / 3_600_000);
  let tickFormat: string;
  let tickInterval: number;
  if (durationHours <= 6)        { tickFormat = 'HH:mm'; tickInterval = 1;  }
  else if (durationHours <= 24)  { tickFormat = 'HH:mm'; tickInterval = 3;  }
  else if (durationHours <= 72)  { tickFormat = 'DD/MM'; tickInterval = 12; }
  else if (durationHours <= 168) { tickFormat = 'DD/MM'; tickInterval = 24; }
  else                           { tickFormat = 'DD/MM'; tickInterval = 72; }
  return { label: 'Custom', pastHours, tickInterval, tickFormat };
}

// ─────────────────────────────────────────────────────────────────────────────
// 24H range helper — mirrors the patient chart which starts at the daily reset
// (default 7 AM) rather than a rolling 24-hour window.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * For the '24h' view mode, snap the range start to the most recent daily-reset
 * (e.g. today at 07:00 local) so the chart always shows "today since 7 AM".
 * All other modes use the standard rolling window.
 */
function get24hAwareRangeStart(
  viewMode: string,
  now: number,
  pastHours: number,
  resetHour: number = 7,
  tzOffset: number  = 0,
): number {
  if (viewMode !== '24h') return now - pastHours * 3_600_000;
  return getLastResetTimeMs(new Date(now), resetHour, tzOffset);
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const DoctorBGChart: React.FC<DoctorBGChartProps> = ({
  readings,
  targetGlucose = 100,
  highThreshold  = 180,
  lowThreshold   = 70,
}) => {
  const [viewMode, setViewMode] = useState<'3h' | '6h' | '12h' | '24h' | 'week' | 'month' | 'custom'>('12h');

  // ── Custom date-range filter ────────────────────────────────────────────
  const [customRangeStart, setCustomRangeStart] = useState<Date>(() => new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000));
  const [customRangeEnd,   setCustomRangeEnd]   = useState<Date>(() => new Date());
  const [customApplied,    setCustomApplied]    = useState(true);

  const [tooltip, setTooltip]   = useState<PlotPoint | null>(null);

  const viewCfg = viewMode === 'custom'
    ? getCustomViewConfig(customRangeStart, customRangeEnd)
    : VIEW_CONFIGS[viewMode];
  // useCurrentMinute() updates at each :00 wall-clock tick so the "now" line
  // and visible time window advance automatically without a manual refresh.
  const now        = useCurrentMinute();
  const rangeEnd   = viewMode === 'custom' && customApplied ? customRangeEnd.getTime()   : now;
  const rangeStart = viewMode === 'custom' && customApplied
    ? customRangeStart.getTime()
    : get24hAwareRangeStart(viewMode, now, viewCfg.pastHours);

  // Normalise BloodSugarResponse → simple shape
  const normalised = useMemo(() =>
    readings
      .map(r => ({
        timestamp:  parseUTCMs(r.bloodSugarTimestamp ?? r.timestamp ?? null),
        bloodSugar: r.bloodSugar,
      }))
      .filter(r => !isNaN(r.timestamp) && r.bloodSugar > 0),
  [readings]);

  const plotPoints = useMemo(
    () => buildPlotPoints(normalised, rangeStart, rangeEnd),
    [normalised, rangeStart, rangeEnd],
  );

  const { red, orange, green } = useMemo(
    () => plotPoints.length > 0 ? buildBandedLines(plotPoints) : { red: [], orange: [], green: [] },
    [plotPoints],
  );

  const stats   = useMemo(() => computeStats(plotPoints), [plotPoints]);
  const xTicks  = useMemo(() => {
    const ticks: number[] = [];
    const step = viewCfg.tickInterval * 3_600_000;
    let t = Math.ceil(rangeStart / step) * step;
    while (t <= rangeEnd) { ticks.push(t); t += step; }
    return ticks;
  }, [rangeStart, rangeEnd, viewCfg.tickInterval]);

  const actualDots = useMemo(
    () => plotPoints.filter(p => p.isActual).map(p => ({ x: p.timestamp, y: p.glucose, color: p.color, point: p })),
    [plotPoints],
  );

  // Zone bands as two-point VictoryArea (same pattern as BloodGlucoseChart)
  const zoneBand = (y0: number, y1: number, fill: string) => [
    { x: rangeStart, y: y1, y0 },
    { x: rangeEnd,   y: y1, y0 },
  ];

  const fillData = plotPoints.map(p => ({ x: p.timestamp, y: p.glucose }));

  if (!readings.length) {
    return (
      <View style={s.empty}>
        <Text style={s.emptyIcon}>📊</Text>
        <Text style={s.emptyTitle}>No blood glucose readings</Text>
        <Text style={s.emptySubtitle}>No data available for this patient</Text>
      </View>
    );
  }

  return (
    <View style={s.container}>
      {/* Stats bar */}
      {stats && (
        <View style={s.statsBar}>
          {[
            { v: `${stats.avg}`,    l: 'Avg mg/dL',    c: stats.avg > highThreshold ? '#ef4444' : stats.avg < lowThreshold ? '#f97316' : '#22c55e' },
            { v: `${stats.min}`,    l: 'Min',           c: stats.min < lowThreshold ? '#f97316' : '#374151' },
            { v: `${stats.max}`,    l: 'Max',           c: stats.max > highThreshold ? '#ef4444' : '#374151' },
            { v: `${stats.tir}%`,   l: 'Time in Range', c: stats.tir >= 70 ? '#22c55e' : stats.tir >= 50 ? '#f97316' : '#ef4444' },
            { v: `${stats.count}`,  l: 'Readings',      c: '#374151' },
          ].map(({ v, l, c }) => (
            <View key={l} style={s.statItem}>
              <Text style={[s.statValue, { color: c }]}>{v}</Text>
              <Text style={s.statLabel}>{l}</Text>
            </View>
          ))}
        </View>
      )}

      {/* View mode */}
      <View style={s.viewModeRow}>
        {(['3h', '6h', '12h', '24h', 'week', 'month'] as const).map(m => (
          <TouchableOpacity
            key={m}
            style={[s.viewBtn, viewMode === m && s.viewBtnActive]}
            onPress={() => setViewMode(m)}
          >
            <Text style={[s.viewBtnText, viewMode === m && s.viewBtnTextActive]}>
              {VIEW_CONFIGS[m].label}
            </Text>
          </TouchableOpacity>
        ))}
        {/* 📅 Custom date-range button */}
        <TouchableOpacity
          style={[s.viewBtn, s.viewBtnCustom, viewMode === 'custom' && s.viewBtnActive]}
          onPress={() => setViewMode('custom')}
        >
          <Text style={[s.viewBtnText, viewMode === 'custom' && s.viewBtnTextActive]}>
            📅 Range
          </Text>
        </TouchableOpacity>
      </View>

      {/* Custom date-range panel */}
      {viewMode === 'custom' && (
        <View style={s.customRangePanel}>
          <View style={s.customRangeRow}>
            <View style={s.customRangePicker}>
              <UnifiedTimePicker
                label="From"
                value={customRangeStart}
                onChange={(iso) => { setCustomRangeStart(new Date(iso)); setCustomApplied(false); }}
                mode="custom"
                showModeSelector
                displayFormat="datetime"
              />
            </View>
            <View style={s.customRangePicker}>
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
            style={[s.customRangeApplyBtn, customApplied && s.customRangeAppliedBtn]}
            onPress={() => setCustomApplied(true)}
            disabled={customApplied}
          >
            <Text style={s.customRangeApplyText}>
              {customApplied ? '✓ Applied' : 'Apply Range'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Chart */}
      {plotPoints.length > 0 ? (
        <View style={s.chartWrap}>
          <VictoryChart
            width={CHART_WIDTH}
            height={CHART_HEIGHT}
            domain={{ x: [rangeStart, rangeEnd], y: BG_DOMAIN }}
            padding={{ top: 16, bottom: 36, left: 52, right: 16 }}
          >
            {/* Zone fills */}
            <VictoryArea data={zoneBand(250, 400, '#ef4444')} style={{ data: { fill: '#ef4444', fillOpacity: 0.06, stroke: 'none' } }} />
            <VictoryArea data={zoneBand(180, 250, '#f97316')} style={{ data: { fill: '#f97316', fillOpacity: 0.06, stroke: 'none' } }} />
            <VictoryArea data={zoneBand(70,  180, '#22c55e')} style={{ data: { fill: '#22c55e', fillOpacity: 0.06, stroke: 'none' } }} />
            <VictoryArea data={zoneBand(54,   70, '#f97316')} style={{ data: { fill: '#f97316', fillOpacity: 0.06, stroke: 'none' } }} />
            <VictoryArea data={zoneBand(40,   54, '#ef4444')} style={{ data: { fill: '#ef4444', fillOpacity: 0.06, stroke: 'none' } }} />

            {/* Axes */}
            <VictoryAxis
              tickValues={xTicks}
              tickFormat={ts => formatXAxis(ts, viewCfg.tickFormat)}
              style={{ axis: { stroke: '#e5e7eb' }, tickLabels: { fontSize: 9, fill: '#9ca3af' }, grid: { stroke: '#f3f4f6', strokeWidth: 0.5 } }}
            />
            <VictoryAxis
              dependentAxis
              tickValues={[54, 70, 100, 140, 180, 250, 350]}
              style={{ axis: { stroke: '#e5e7eb' }, tickLabels: { fontSize: 9, fill: '#9ca3af' }, grid: { stroke: '#f3f4f6', strokeWidth: 0.5 } }}
            />

            {/* Soft curve fill */}
            <VictoryArea
              data={fillData}
              interpolation="monotoneX"
              style={{ data: { fill: '#22c55e', fillOpacity: 0.07, stroke: 'none' } }}
            />

            {/* Reference lines */}
            <VictoryLine data={[{ x: rangeStart, y: highThreshold  }, { x: rangeEnd, y: highThreshold  }]} style={{ data: { stroke: '#f97316', strokeWidth: 1.5, strokeDasharray: '5 3' } }} />
            <VictoryLine data={[{ x: rangeStart, y: targetGlucose }, { x: rangeEnd, y: targetGlucose }]} style={{ data: { stroke: '#22c55e', strokeWidth: 1.5, strokeDasharray: '4 2' } }} />
            <VictoryLine data={[{ x: rangeStart, y: lowThreshold  }, { x: rangeEnd, y: lowThreshold  }]} style={{ data: { stroke: '#ef4444', strokeWidth: 1.5, strokeDasharray: '5 3' } }} />

            {/* Now line */}
            <VictoryAxis
              dependentAxis
              axisValue={now}
              tickFormat={() => ''}
              style={{ axis: { stroke: '#6b7280', strokeWidth: 1.5, strokeDasharray: '6 3' }, grid: { stroke: 'none' }, ticks: { size: 0 }, tickLabels: { fontSize: 0 } }}
            />

            {/* Banded glucose lines */}
            <VictoryLine data={green}  defined={(d: any) => d.y !== null} interpolation="monotoneX" style={{ data: { stroke: '#22c55e', strokeWidth: 2.5 } }} />
            <VictoryLine data={orange} defined={(d: any) => d.y !== null} interpolation="monotoneX" style={{ data: { stroke: '#f97316', strokeWidth: 2.5 } }} />
            <VictoryLine data={red}    defined={(d: any) => d.y !== null} interpolation="monotoneX" style={{ data: { stroke: '#ef4444', strokeWidth: 2.5 } }} />

            {/* Reading dots */}
            {actualDots.length > 0 && (
              <VictoryScatter
                data={actualDots}
                size={2.5}
                style={{ data: { fill: ({ datum }: any) => datum.color, stroke: '#fff', strokeWidth: 1 } }}
                events={Platform.OS !== 'web' ? [{
                  target: 'data',
                  eventHandlers: {
                    onPress: () => [{ target: 'data', mutation: ({ datum }: any) => { setTooltip(datum.point); return null; } }],
                  },
                }] : []}
              />
            )}
          </VictoryChart>
        </View>
      ) : (
        <View style={s.noDataInRange}>
          <Text style={s.noDataText}>No readings in the selected {viewCfg.label} window</Text>
        </View>
      )}

      {/* Legend */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.legendRow}>
        {[
          { color: '#ef4444', label: 'Very High (>250)' },
          { color: '#f97316', label: 'High (180–250)'   },
          { color: '#22c55e', label: 'Target (70–180)'  },
          { color: '#f97316', label: 'Low (54–70)'      },
          { color: '#ef4444', label: 'Very Low (<54)'   },
        ].map(({ color, label }) => (
          <View key={label} style={s.legendItem}>
            <View style={[s.legendDot, { backgroundColor: color }]} />
            <Text style={s.legendLabel}>{label}</Text>
          </View>
        ))}
      </ScrollView>

      {/* Tooltip modal */}
      {tooltip && (
        <Modal transparent animationType="fade" onRequestClose={() => setTooltip(null)}>
          <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={() => setTooltip(null)}>
            <View style={s.tooltipCard}>
              <Text style={[s.tooltipValue, { color: LINE_COLORS[getLineGroup(tooltip.bandKey)] }]}>
                {Math.round(tooltip.glucose)} mg/dL
              </Text>
              <Text style={s.tooltipBand}>{GLUCOSE_BANDS[tooltip.bandKey].label}</Text>
              <Text style={s.tooltipTime}>{formatXAxis(tooltip.timestamp, 'HH:mm')}</Text>
              <Text style={s.tooltipClose}>Tap to close</Text>
            </View>
          </TouchableOpacity>
        </Modal>
      )}
    </View>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden' },

  statsBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  statItem:  { alignItems: 'center', flex: 1 },
  statValue: { fontSize: 15, fontWeight: '700' },
  statLabel: { fontSize: 9,  color: '#9ca3af', marginTop: 2, textAlign: 'center' },

  viewModeRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  viewBtn:          { paddingHorizontal: 14, paddingVertical: 5, borderRadius: 20, backgroundColor: '#f5f5f5' },
  viewBtnActive:    { backgroundColor: '#22c55e' },
  viewBtnText:      { fontSize: 13, fontWeight: '600', color: '#555' },
  viewBtnTextActive:{ color: '#fff' },

  // ── Custom date-range panel ──
  viewBtnCustom:         { borderWidth: 1.5, borderColor: '#22c55e', backgroundColor: 'transparent' },
  customRangePanel:      { paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0', backgroundColor: '#f9fff9' },
  customRangeRow:        { flexDirection: 'row' as const, gap: 8, marginBottom: 4 },
  customRangePicker:     { flex: 1 },
  customRangeApplyBtn:   { backgroundColor: '#22c55e', borderRadius: 8, paddingVertical: 10, alignItems: 'center' as const },
  customRangeAppliedBtn: { backgroundColor: '#16a34a' },
  customRangeApplyText:  { color: '#fff', fontWeight: '700' as const, fontSize: 14 },

  chartWrap:   { paddingHorizontal: 0 },
  noDataInRange: { paddingVertical: 48, alignItems: 'center' },
  noDataText:    { fontSize: 13, color: '#9ca3af' },

  legendRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 12 },
  legendItem:{ flexDirection: 'row', alignItems: 'center' },
  legendDot: { width: 10, height: 10, borderRadius: 5, marginRight: 4 },
  legendLabel: { fontSize: 10, color: '#6b7280' },

  empty:        { paddingVertical: 48, alignItems: 'center' },
  emptyIcon:    { fontSize: 40, marginBottom: 12 },
  emptyTitle:   { fontSize: 15, fontWeight: '600', color: '#6b7280' },
  emptySubtitle:{ fontSize: 12, color: '#9ca3af', marginTop: 4 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  tooltipCard:  { backgroundColor: '#fff', borderRadius: 12, padding: 20, alignItems: 'center', minWidth: 160, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 12, elevation: 8 },
  tooltipValue: { fontSize: 28, fontWeight: '700' },
  tooltipBand:  { fontSize: 13, color: '#6b7280', marginTop: 4 },
  tooltipTime:  { fontSize: 12, color: '#9ca3af', marginTop: 4 },
  tooltipClose: { fontSize: 11, color: '#d1d5db', marginTop: 12 },
});

export default DoctorBGChart;