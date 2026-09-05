/**
 * PureGlucoseVisualization.js
 *
 * A clean, biological-curve visualization for blood glucose readings only.
 * No meal effects, no insulin effects, no cumulative baseline — just the
 * raw glucose signal rendered as a smooth physiological curve.
 *
 * Data source: last24hData from BloodSugarDataContext
 *   Each reading: { readingTime: number (ms), bloodSugar: number, isActualReading: bool }
 *
 * Supports both:
 *   - CGM mode  (dataSource === 'cgm')  → dense continuous line
 *   - SMBG mode (dataSource === 'smbg') → dots + smooth monotone interpolation
 */

import React, {
  useState, useEffect, useCallback, useMemo, useRef
} from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
  Dot,
} from 'recharts';
import { useBloodSugarData } from '../contexts/BloodSugarDataContext';
import { useConstants } from '../contexts/ConstantsContext';
import TimeManager from '../utils/TimeManager';
import {
  useCurrentMinute,
  useChartTimeRange,
  generateXAxisTicks,
  createXAxisFormatter,
  VIEW_CONFIGS,
} from '../utils/ChartUtils';
import { FaSync, FaExpand, FaCompress } from 'react-icons/fa';
import './Charts/global-visualization.css';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const GLUCOSE_BANDS = {
  veryHigh:  { min: 250, max: 400,  color: '#ef4444', label: 'Very High', bg: '#fef2f2' },
  high:      { min: 180, max: 250,  color: '#f97316', label: 'High',      bg: '#fff7ed' },
  target:    { min: 70,  max: 180,  color: '#22c55e', label: 'Target',    bg: '#f0fdf4' },
  low:       { min: 54,  max: 70,   color: '#f97316', label: 'Low',       bg: '#fff7ed' },
  veryLow:   { min: 40,  max: 54,   color: '#ef4444', label: 'Very Low',  bg: '#fef2f2' },
};

function getBandForValue(value) {
  if (value >= 250)  return GLUCOSE_BANDS.veryHigh;
  if (value >= 180)  return GLUCOSE_BANDS.high;
  if (value >= 70)   return GLUCOSE_BANDS.target;
  if (value >= 54)   return GLUCOSE_BANDS.low;
  return GLUCOSE_BANDS.veryLow;
}

function getLineColor(value) {
  return getBandForValue(value).color;
}

const VIEW_BUTTONS = [
  { key: '3h',  label: '3H'  },
  { key: '6h',  label: '6H'  },
  { key: '12h', label: '12H' },
  { key: '24h', label: '24H' },
  { key: '3d',  label: '3D'  },
];

// Extend VIEW_CONFIGS to add the 3h short view if missing
const EXTENDED_VIEW_CONFIGS = {
  ...VIEW_CONFIGS,
  '3h': {
    label: '3 Hours',
    pastHours: 2.5,
    futureHours: 0.5,
    tickInterval: 0.5,
    tickFormat: 'HH:mm',
    interpolationInterval: 1,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a dense timeline of glucose values for smooth rendering. */
function buildPlotPoints(readings, timeRange, isCGM) {
  if (!readings || readings.length === 0) return [];

  const { start, end } = timeRange;

  // Filter to the visible window
  const visible = readings
    .filter(r => r.readingTime >= start && r.readingTime <= end && r.bloodSugar)
    .sort((a, b) => a.readingTime - b.readingTime);

  if (visible.length === 0) return [];

  if (isCGM) {
    // CGM: use readings directly — they're already dense (every 5 min)
    return visible.map(r => ({
      timestamp:    r.readingTime,
      glucose:      r.bloodSugar,
      isActual:     true,
      source:       r.source || 'cgm',
      band:         getBandForValue(r.bloodSugar),
    }));
  }

  // SMBG: readings are sparse; build a smooth interpolated timeline between them
  if (visible.length === 1) {
    return [{
      timestamp: visible[0].readingTime,
      glucose:   visible[0].bloodSugar,
      isActual:  true,
      source:    'smbg',
      band:      getBandForValue(visible[0].bloodSugar),
    }];
  }

  const points = [];
  const INTERVAL_MS = 5 * 60 * 1000; // 5-min interpolation steps

  for (let i = 0; i < visible.length - 1; i++) {
    const a = visible[i];
    const b = visible[i + 1];
    const span = b.readingTime - a.readingTime;
    const steps = Math.round(span / INTERVAL_MS);

    // Always include the actual reading point
    points.push({
      timestamp: a.readingTime,
      glucose:   a.bloodSugar,
      isActual:  true,
      source:    'smbg',
      band:      getBandForValue(a.bloodSugar),
    });

    // Cubic Hermite-style smooth interpolation between readings
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      // Smooth-step (S-curve) to mimic physiological rise/fall
      const smooth = t * t * (3 - 2 * t);
      const interp = a.bloodSugar + smooth * (b.bloodSugar - a.bloodSugar);
      points.push({
        timestamp: a.readingTime + s * INTERVAL_MS,
        glucose:   interp,
        isActual:  false,
        source:    'interpolated',
        band:      getBandForValue(interp),
      });
    }
  }

  // Add the final reading
  const last = visible[visible.length - 1];
  points.push({
    timestamp: last.readingTime,
    glucose:   last.bloodSugar,
    isActual:  true,
    source:    'smbg',
    band:      getBandForValue(last.bloodSugar),
  });

  return points;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

/** Colored dot rendered only at actual (non-interpolated) SMBG readings. */
const ActualReadingDot = (props) => {
  const { cx, cy, payload } = props;
  if (!payload?.isActual || payload.source === 'interpolated') return null;
  const color = payload.band?.color || '#6b7280';
  return (
    <g>
      {/* Outer glow ring */}
      <circle cx={cx} cy={cy} r={9}  fill={color} opacity={0.18} />
      {/* Main dot */}
      <circle cx={cx} cy={cy} r={5}  fill={color} stroke="#fff" strokeWidth={2} />
    </g>
  );
};

/** For CGM: a tiny dot at each reading to anchor hover detection. */
const CGMDot = (props) => {
  const { cx, cy, payload } = props;
  if (!payload?.isActual) return null;
  const color = payload.band?.color || '#6b7280';
  return <circle cx={cx} cy={cy} r={3} fill={color} stroke="#fff" strokeWidth={1} />;
};

/** Tooltip card */
const GlucoseTooltip = ({ active, payload, targetGlucose }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;

  const band     = d.band || getBandForValue(d.glucose);
  const timeStr  = new Date(d.timestamp).toLocaleString('en-GB', {
    hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short'
  });
  const delta    = d.glucose - targetGlucose;
  const deltaStr = `${delta >= 0 ? '+' : ''}${Math.round(delta)} mg/dL vs target`;

  return (
    <div style={{
      background: '#fff',
      border: `2px solid ${band.color}`,
      borderRadius: 10,
      padding: '10px 14px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.13)',
      minWidth: 180,
      fontFamily: 'inherit',
    }}>
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{timeStr}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 26, fontWeight: 700, color: band.color, lineHeight: 1 }}>
          {Math.round(d.glucose)}
        </span>
        <span style={{ fontSize: 12, color: '#6b7280' }}>mg/dL</span>
      </div>
      <div style={{
        marginTop: 4,
        display: 'inline-block',
        background: band.bg,
        color: band.color,
        fontSize: 11,
        fontWeight: 600,
        borderRadius: 6,
        padding: '2px 8px',
      }}>
        {band.label}
      </div>
      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>{deltaStr}</div>
      {d.source === 'interpolated' && (
        <div style={{ fontSize: 10, color: '#d1d5db', marginTop: 4 }}>
          ↗ Interpolated
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Stats bar
// ─────────────────────────────────────────────────────────────────────────────

function computeStats(points, targetGlucose) {
  const actual = points.filter(p => p.isActual);
  if (actual.length === 0) return null;

  const values    = actual.map(p => p.glucose);
  const avg       = values.reduce((s, v) => s + v, 0) / values.length;
  const min       = Math.min(...values);
  const max       = Math.max(...values);
  const inRange   = actual.filter(p => p.glucose >= 70 && p.glucose <= 180).length;
  const tir       = Math.round((inRange / actual.length) * 100);
  const latest    = actual[actual.length - 1];

  return { avg: Math.round(avg), min: Math.round(min), max: Math.round(max), tir, latest, count: actual.length };
}

const StatsBar = ({ stats, targetGlucose }) => {
  if (!stats) return null;
  const latestBand = getBandForValue(stats.latest.glucose);
  const tirColor = stats.tir >= 70 ? '#22c55e' : stats.tir >= 50 ? '#f97316' : '#ef4444';

  const pill = (label, val, color) => (
    <div style={{ textAlign: 'center', padding: '6px 14px' }}>
      <div style={{ fontSize: 18, fontWeight: 700, color }}>{val}</div>
      <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{label}</div>
    </div>
  );

  return (
    <div style={{
      display: 'flex',
      alignItems: 'stretch',
      gap: 0,
      background: '#f9fafb',
      border: '1px solid #e5e7eb',
      borderRadius: 10,
      overflow: 'hidden',
      marginBottom: 12,
      flexWrap: 'wrap',
    }}>
      {/* Current reading — larger, colored */}
      <div style={{
        padding: '8px 18px',
        background: latestBand.bg,
        borderRight: `3px solid ${latestBand.color}`,
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        minWidth: 100,
      }}>
        <div style={{ fontSize: 11, color: '#6b7280' }}>Current</div>
        <div style={{ fontSize: 28, fontWeight: 800, color: latestBand.color, lineHeight: 1 }}>
          {Math.round(stats.latest.glucose)}
          <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 3 }}>mg/dL</span>
        </div>
        <div style={{ fontSize: 11, fontWeight: 600, color: latestBand.color }}>
          {latestBand.label}
        </div>
      </div>

      {/* Stats pills */}
      <div style={{ display: 'flex', flex: 1, alignItems: 'stretch', flexWrap: 'wrap' }}>
        {pill('Avg',         `${stats.avg}`,   '#4b5563')}
        {pill('Min',         `${stats.min}`,   GLUCOSE_BANDS.low.color)}
        {pill('Max',         `${stats.max}`,   GLUCOSE_BANDS.high.color)}
        {pill('Time in Range', `${stats.tir}%`, tirColor)}
        {pill('Readings',    `${stats.count}`, '#6b7280')}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

const PureGlucoseVisualization = ({
  height      = 380,
  showControls = true,
  defaultView  = '12h',
  embedded     = false,
}) => {
  const {
    last24hData,
    targetGlucose,
    fetchLast24hData,
    dataSource,
  } = useBloodSugarData();

  const { patientConstants } = useConstants();

  const [viewMode,     setViewMode]     = useState(defaultView);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [loading,      setLoading]      = useState(false);
  const containerRef = useRef(null);

  const isCGM         = dataSource === 'cgm';
  const effectiveTarget = targetGlucose || patientConstants?.target_glucose || 100;
  const highThreshold   = effectiveTarget * 1.3;  // 130% = "high"
  const lowThreshold    = effectiveTarget * 0.7;  // 70%  = "low"

  // ── Time range & axis ──────────────────────────────────────────────────────
  const currentMinute = useCurrentMinute();
  const viewConfig    = EXTENDED_VIEW_CONFIGS[viewMode] || EXTENDED_VIEW_CONFIGS['12h'];
  const timeRange     = useChartTimeRange(viewMode, currentMinute);
  const ticks         = useMemo(() => generateXAxisTicks(timeRange, viewConfig), [timeRange, viewConfig]);
  const formatXAxis   = useMemo(() => createXAxisFormatter(viewConfig),          [viewConfig]);

  // ── Build plot data ────────────────────────────────────────────────────────
  const plotPoints = useMemo(
    () => buildPlotPoints(last24hData, timeRange, isCGM),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [last24hData?.length, timeRange.start, timeRange.end, isCGM]
  );

  const stats = useMemo(
    () => computeStats(plotPoints, effectiveTarget),
    [plotPoints, effectiveTarget]
  );

  // ── Gradient stops: multi-color line based on glucose zone ────────────────
  // We use a Y-based linearGradient so the line is red at bottom, green in
  // target zone, orange/red at top. Y domain: 40–400 → 360 range.
  // gradient stop offsets = (400 - threshold) / 360
  const veryHighStop = ((400 - 250) / 360).toFixed(3);   // 0.417
  const highStop     = ((400 - 180) / 360).toFixed(3);   // 0.611
  const targetStop   = ((400 - 70)  / 360).toFixed(3);   // 0.917
  const lowStop      = ((400 - 54)  / 360).toFixed(3);   // 0.961

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleRefresh = useCallback(async () => {
    setLoading(true);
    await fetchLast24hData?.();
    setLoading(false);
  }, [fetchLast24hData]);

  const handleViewChange = useCallback((v) => {
    setViewMode(v);
  }, []);

  const toggleFullscreen = useCallback(() => setIsFullscreen(p => !p), []);

  // ── Render ─────────────────────────────────────────────────────────────────
  const chartHeight = isFullscreen ? window.innerHeight - 200 : height;

  return (
    <div
      ref={containerRef}
      className={`blood-glucose-visualization ${isFullscreen ? 'fullscreen' : ''} ${embedded ? 'embedded' : ''}`}
      style={{ position: 'relative', fontFamily: 'system-ui, sans-serif' }}
    >
      {/* ── Header ── */}
      {showControls && (
        <div className="bg-visualization-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Blood Glucose</h3>
            <p style={{ margin: '2px 0 0', fontSize: 11, color: '#6b7280' }}>
              {isCGM ? 'CGM Continuous Trace' : 'SMBG with smooth interpolation'}
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* View toggle */}
            <div className="view-mode-toggle" style={{ display: 'flex', gap: 2 }}>
              {VIEW_BUTTONS.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => handleViewChange(key)}
                  className={viewMode === key ? 'active' : ''}
                  disabled={loading}
                  style={{ padding: '4px 10px', fontSize: 12 }}
                >
                  {label}
                </button>
              ))}
            </div>

            <button onClick={handleRefresh} disabled={loading} className="bg-action-button" title="Refresh">
              <FaSync className={loading ? 'spin' : ''} />
            </button>
            <button onClick={toggleFullscreen} className="bg-action-button" title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
              {isFullscreen ? <FaCompress /> : <FaExpand />}
            </button>
          </div>
        </div>
      )}

      {/* ── Stats bar ── */}
      <StatsBar stats={stats} targetGlucose={effectiveTarget} />

      {/* ── Empty state ── */}
      {plotPoints.length === 0 ? (
        <div style={{
          height: chartHeight,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          background: '#f9fafb', borderRadius: 12,
          color: '#9ca3af',
        }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>📈</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#6b7280' }}>No glucose data in this window</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Log a blood glucose reading to see your curve</div>
        </div>
      ) : (
        <div style={{ height: chartHeight }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={plotPoints}
              margin={{ top: 16, right: 20, left: 16, bottom: 56 }}
            >
              <defs>
                {/* Multi-zone vertical gradient for the glucose line */}
                <linearGradient id="glucoseLineGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"              stopColor="#ef4444" />   {/* Very high top */}
                  <stop offset={`${(veryHighStop * 100).toFixed(1)}%`} stopColor="#ef4444" />
                  <stop offset={`${(highStop * 100).toFixed(1)}%`}     stopColor="#f97316" />
                  <stop offset={`${((highStop * 1 + targetStop * 0) / 1 * 100 * 0.5 + highStop * 100 * 0.5).toFixed(1)}%`} stopColor="#22c55e" />
                  <stop offset={`${(targetStop * 100).toFixed(1)}%`}   stopColor="#22c55e" />
                  <stop offset={`${(lowStop * 100).toFixed(1)}%`}      stopColor="#f97316" />
                  <stop offset="100%"             stopColor="#ef4444" />  {/* Very low bottom */}
                </linearGradient>

                {/* Soft gradient fill under the curve */}
                <linearGradient id="glucoseFillGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="#f97316" stopOpacity={0.15} />
                  <stop offset="30%"  stopColor="#22c55e" stopOpacity={0.12} />
                  <stop offset="80%"  stopColor="#22c55e" stopOpacity={0.06} />
                  <stop offset="100%" stopColor="#ef4444" stopOpacity={0.08} />
                </linearGradient>
              </defs>

              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />

              {/* ── Target zone background shading ── */}
              <ReferenceArea
                yAxisId="glucose"
                y1={lowThreshold}
                y2={highThreshold}
                fill="#dcfce7"
                fillOpacity={0.35}
                ifOverflow="hidden"
              />
              {/* Low zone */}
              <ReferenceArea
                yAxisId="glucose"
                y1={40}
                y2={lowThreshold}
                fill="#fef2f2"
                fillOpacity={0.4}
                ifOverflow="hidden"
              />
              {/* High zone */}
              <ReferenceArea
                yAxisId="glucose"
                y1={highThreshold}
                y2={400}
                fill="#fff7ed"
                fillOpacity={0.4}
                ifOverflow="hidden"
              />

              <XAxis
                dataKey="timestamp"
                type="number"
                scale="time"
                domain={[timeRange.start, timeRange.end]}
                ticks={ticks}
                tickFormatter={formatXAxis}
                angle={-40}
                textAnchor="end"
                height={60}
                stroke="#d1d5db"
                tick={{ fontSize: 11, fill: '#6b7280' }}
              />

              <YAxis
                yAxisId="glucose"
                domain={[40, 400]}
                ticks={[40, 54, 70, 100, 140, 180, 250, 300, 350, 400]}
                tickFormatter={v => `${v}`}
                stroke="#d1d5db"
                tick={{ fontSize: 11, fill: '#6b7280' }}
                label={{
                  value: 'mg/dL',
                  angle: -90,
                  position: 'insideLeft',
                  offset: 8,
                  style: { fontSize: 11, fill: '#9ca3af' },
                }}
                width={50}
              />

              <Tooltip
                content={<GlucoseTooltip targetGlucose={effectiveTarget} />}
                cursor={{ stroke: '#e5e7eb', strokeWidth: 1, strokeDasharray: '4 4' }}
              />

              {/* ── Reference lines ── */}
              <ReferenceLine yAxisId="glucose" y={highThreshold}  stroke="#f97316" strokeDasharray="5 3" strokeWidth={1.5}
                label={{ value: 'High',   position: 'right', fontSize: 10, fill: '#f97316' }} />
              <ReferenceLine yAxisId="glucose" y={effectiveTarget} stroke="#22c55e" strokeDasharray="4 2" strokeWidth={1.5}
                label={{ value: 'Target', position: 'right', fontSize: 10, fill: '#22c55e' }} />
              <ReferenceLine yAxisId="glucose" y={lowThreshold}   stroke="#ef4444" strokeDasharray="5 3" strokeWidth={1.5}
                label={{ value: 'Low',    position: 'right', fontSize: 10, fill: '#ef4444' }} />

              {/* ── "Now" line ── */}
              <ReferenceLine
                yAxisId="glucose"
                x={timeRange.now}
                stroke="#6b7280"
                strokeWidth={1.5}
                strokeDasharray="6 3"
                label={{ value: 'Now', position: 'top', fontSize: 10, fill: '#6b7280' }}
              />

              {/* ── Soft fill area under the curve ── */}
              <Area
                yAxisId="glucose"
                type="monotone"
                dataKey="glucose"
                stroke="none"
                fill="url(#glucoseFillGradient)"
                fillOpacity={1}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
                connectNulls
              />

              {/* ── Main glucose curve ── */}
              <Line
                yAxisId="glucose"
                type="monotone"
                dataKey="glucose"
                stroke="url(#glucoseLineGradient)"
                strokeWidth={isCGM ? 2.5 : 2}
                dot={isCGM ? <CGMDot /> : <ActualReadingDot />}
                activeDot={{
                  r: 6,
                  stroke: '#fff',
                  strokeWidth: 2,
                  fill: '#3b82f6',
                }}
                isAnimationActive={false}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Legend ── */}
      <div style={{
        display: 'flex', gap: 16, flexWrap: 'wrap',
        justifyContent: 'center', marginTop: 8,
        fontSize: 11, color: '#6b7280',
      }}>
        {[
          { color: '#ef4444', label: 'Very High (>250)' },
          { color: '#f97316', label: 'High (180–250)'   },
          { color: '#22c55e', label: 'Target (70–180)'  },
          { color: '#f97316', label: 'Low (54–70)'      },
          { color: '#ef4444', label: 'Very Low (<54)'   },
        ].map(({ color, label }) => (
          <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
            {label}
          </span>
        ))}
        {!isCGM && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#9ca3af', fontStyle: 'italic' }}>
            · dashed line = smooth interpolation between readings
          </span>
        )}
      </div>
    </div>
  );
};

export default PureGlucoseVisualization;
