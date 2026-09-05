import API_BASE_URL from '../config';
// ActivityRecording.js — v3.2
// v3.1: Added ⌚ Watch Session panel for direct wearable HR integration.
//       Uses watchHrApi.js which maps to watch_hr_routes.py.
//       Per-second HR is stored in hr_trace_raw; the ODE model reads hr_trace
//       (per-minute averages), so no pharmacodynamics changes are needed.
//
// v3.2 — Bug fixes (audit findings):
//   ✅ FIX C-2: Crash-recovery startTimeRef now uses status.started_at (ISO wall-clock)
//      instead of Date.now() - total_raw * 1000. total_raw is a sample *count*, not
//      elapsed seconds — using it produced a startTime orders of magnitude too recent,
//      making every subsequent t_sec value wrong and corrupting the recovered session.
//   ✅ FIX H-1: PdResultPanel session breakdown table no longer shows a "Sensitivity"
//      column. sensitivity_multiplier is a single top-level value, not per-session —
//      the field never existed on activity_contributions items so the column always
//      showed "—". The aggregate multiplier is now displayed above the table instead.
//   ✅ FIX M-4 (frontend guard): ActivityCard now derives intensity from activity.intensity
//      when activity.level is undefined (watch-recorded sessions). This prevents the
//      "Level undefined" display while the backend fix (watch_hr_routes.py) propagates.

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import axios from 'axios';
import {
  FaPlus, FaMinus, FaFileImport, FaSync, FaHistory, FaInfoCircle,
  FaHeartbeat, FaChevronDown, FaChevronUp, FaFlask, FaTimes, FaStopwatch , FaStop, FaCircle
} from 'react-icons/fa';
import {
  startWatchSession,
  streamHrSamples,
  endWatchSession,
  getWatchSessionStatus,
} from '../services/watchHrApi';
import './Charts/input-components.css';
import { ACTIVITY_LEVELS } from '../constants';
import { useConstants } from '../contexts/ConstantsContext';
import TimeInput from './TimeInput';
import TimeManager from '../utils/TimeManager';
import moment from 'moment';

// ─── Constants ────────────────────────────────────────────────────────────────

const LEVEL_TO_INTENSITY = {
  '-2': 'light',
  '-1': 'light',
  '0':  'light',
  '1':  'moderate',
  '2':  'vigorous',
};

const makeEmptyForm = () => ({
  level:      0,
  startTime:  TimeManager.getCurrentTimeISOString(),
  endTime:    TimeManager.getCurrentTimeISOString(),
  isExpected: false,
  notes:      '',
  hr_base:    '',
  hr_max:     '',
  hr_trace:   [],
});

// ─── HR Trace Row ─────────────────────────────────────────────────────────────

const HrTraceRow = React.memo(({ row, index, onChange, onRemove }) => (
  <div className="hr-trace-row">
    <span className="hr-trace-label">At minute</span>
    <input
      type="number" className="hr-trace-input"
      value={row.t_min} min={0} step={1} placeholder="0"
      onChange={(e) => onChange(index, 't_min', parseFloat(e.target.value) || 0)}
    />
    <span className="hr-trace-label">HR was</span>
    <input
      type="number" className="hr-trace-input"
      value={row.hr_bpm} min={30} max={250} step={1} placeholder="120"
      onChange={(e) => onChange(index, 'hr_bpm', parseFloat(e.target.value) || 0)}
    />
    <span className="hr-trace-label">bpm</span>
    <button
      type="button" className="activity-icon-button activity-remove-btn hr-trace-remove"
      onClick={() => onRemove(index)} title="Remove reading"
    >
      <FaMinus />
    </button>
  </div>
));

// ─── HR Section ───────────────────────────────────────────────────────────────

const HrSection = React.memo(({ hrData, onChange }) => {
  const [open, setOpen] = useState(false);
  const traceCount = hrData.hr_trace?.length || 0;

  const addTraceRow = () =>
    onChange({ ...hrData, hr_trace: [...(hrData.hr_trace || []), { t_min: traceCount * 5, hr_bpm: 120 }] });

  const updateTraceRow = (idx, field, val) => {
    const updated = [...(hrData.hr_trace || [])];
    updated[idx] = { ...updated[idx], [field]: val };
    onChange({ ...hrData, hr_trace: updated });
  };

  const removeTraceRow = (idx) =>
    onChange({ ...hrData, hr_trace: (hrData.hr_trace || []).filter((_, i) => i !== idx) });

  return (
    <div className="hr-section">
      <button type="button" className="hr-toggle-btn" onClick={() => setOpen(v => !v)}>
        <FaHeartbeat className="hr-icon" />
        Heart Rate Data
        <span className="hr-optional"> (optional — improves BG accuracy)</span>
        {traceCount > 0 && <span className="hr-badge">{traceCount} reading{traceCount !== 1 ? 's' : ''}</span>}
        {open ? <FaChevronUp className="hr-chevron" /> : <FaChevronDown className="hr-chevron" />}
      </button>

      {open && (
        <div className="hr-fields">
          <p className="hr-hint">
            Leave empty to use an estimated HR based on intensity.
            Adding your real HR readings improves glucose prediction accuracy.
          </p>

          <div className="hr-baseline-row">
            <div className="hr-input-group">
              <label>Resting HR (bpm)</label>
              <input
                type="number" className="hr-number-input"
                value={hrData.hr_base ?? ''} min={30} max={120} placeholder="70"
                onChange={(e) => onChange({
                  ...hrData,
                  hr_base: e.target.value === '' ? '' : parseFloat(e.target.value)
                })}
              />
            </div>
            <div className="hr-input-group">
              <label>Max HR (bpm)</label>
              <input
                type="number" className="hr-number-input"
                value={hrData.hr_max ?? ''} min={100} max={250} placeholder="190"
                onChange={(e) => onChange({
                  ...hrData,
                  hr_max: e.target.value === '' ? '' : parseFloat(e.target.value)
                })}
              />
            </div>
          </div>

          <div className="hr-trace-section">
            <div className="hr-trace-header">
              <span className="hr-trace-title">HR Readings during activity</span>
              <button type="button" className="hr-add-point-btn" onClick={addTraceRow}>
                <FaPlus /> Add Reading
              </button>
            </div>

            {traceCount === 0 ? (
              <p className="hr-trace-empty">
                No readings added. Each reading records your HR at a specific minute into the activity.
                <br />
                <span style={{ color: '#aaa' }}>Example: "At minute 10, HR was 145 bpm"</span>
              </p>
            ) : (
              <>
                <p className="hr-trace-row-hint">
                  "At minute __ into the activity, my heart rate was __ bpm"
                </p>
                {(hrData.hr_trace || []).map((row, idx) => (
                  <HrTraceRow
                    key={idx} row={row} index={idx}
                    onChange={updateTraceRow} onRemove={removeTraceRow}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

// ─── Activity Card (compact, read-only) ───────────────────────────────────────

const ActivityCard = React.memo(({ activity, onRemove, activityCoefficients }) => {
  const impact     = activityCoefficients?.[activity.level] ?? 1.0;
  const impactPct  = Math.abs(((impact - 1) * 100)).toFixed(0);
  const impactDir  = impact > 1 ? 'increase' : impact < 1 ? 'decrease' : null;

  // ✅ FIX M-4: watch-recorded sessions have intensity (string) but no level (integer).
  // Derive intensity from the explicit field first, then fall back to level lookup.
  // This prevents "Level undefined" for watch sessions until the backend also writes
  // the level field correctly (see watch_hr_routes.py fix).
  const intensity = activity.intensity
    || LEVEL_TO_INTENSITY[String(activity.level)]
    || 'light';

  // Derive the human-readable label: prefer ACTIVITY_LEVELS lookup (legacy records),
  // then capitalise the intensity string (new watch records), then a safe fallback.
  const levelLabel = ACTIVITY_LEVELS.find(l => l.value === activity.level)?.label
    || (intensity.charAt(0).toUpperCase() + intensity.slice(1))
    || 'Activity';

  const startDisplay = activity.startTime
    ? (TimeManager.formatTimeDisplay?.(activity.startTime) ?? activity.startTime) : '—';
  const endDisplay = activity.endTime
    ? (TimeManager.formatTimeDisplay?.(activity.endTime)   ?? activity.endTime)   : '—';

  return (
    <div className={`ua-card ua-card--${activity.type}`}>
      <div className="ua-card-body">

        {/* Level + type badge + intensity */}
        <div className="ua-card-header">
          <span className="ua-card-level">{levelLabel}</span>
          <span className={`ua-card-badge ua-card-badge--${activity.type}`}>
            {activity.type === 'expected' ? 'Expected' : 'Completed'}
          </span>
          <span className="ua-card-intensity">{intensity}</span>
        </div>

        {/* Time range + duration */}
        <div className="ua-card-time">
          {startDisplay} – {endDisplay}
          {activity.duration && <span className="ua-card-duration"> · {activity.duration}</span>}
        </div>

        {/* Impact */}
        {impactDir && (
          <div className={`ua-card-impact ua-card-impact--${impactDir}`}>
            {impactDir === 'increase' ? '+' : '−'}{impactPct}% insulin sensitivity
          </div>
        )}

        {/* HR summary — hr_base/hr_max for session-based recordings;
             session_hr_min/session_hr_peak for continuous-upload sessions (H-2 rename) */}
        {(() => {
          const restHR = activity.hr_base ?? activity.session_hr_min;
          const peakHR = activity.hr_max  ?? activity.session_hr_peak;
          return (restHR || peakHR || activity.hr_trace?.length > 0) ? (
            <div className="ua-card-hr">
              <FaHeartbeat className="ua-card-hr-icon" />
              {restHR && `Rest ${restHR} bpm`}
              {restHR && peakHR && ' / '}
              {peakHR && `Max ${peakHR} bpm`}
              {activity.hr_trace?.length > 0 && ` · ${activity.hr_trace.length} trace pts`}
            </div>
          ) : null;
        })()}

        {/* Notes */}
        {activity.notes && <div className="ua-card-notes">{activity.notes}</div>}
      </div>

      <button type="button" className="ua-card-remove" onClick={onRemove} title="Remove">
        <FaTimes />
      </button>
    </div>
  );
});

// ─── Inline Add Form ──────────────────────────────────────────────────────────

const ActivityForm = React.memo(({ formData, onChange, onConfirm, onCancel, activityCoefficients, isLoading }) => {
  const getImpact = (level) => activityCoefficients?.[level] ?? 1.0;

  return (
    <div className="ua-form">

      {/* Intensity level pills */}
      <p className="ua-form-label">Intensity Level</p>
      <div className="ua-level-grid">
        {ACTIVITY_LEVELS.map(level => {
          const impact   = getImpact(level.value);
          const isActive = formData.level === level.value;
          const pct      = Math.abs(((impact - 1) * 100)).toFixed(0);
          const dir      = impact > 1 ? '↑' : impact < 1 ? '↓' : null;

          return (
            <button
              key={level.value}
              type="button"
              className={`ua-level-btn${isActive ? ' ua-level-btn--active' : ''}`}
              onClick={() => onChange({ ...formData, level: level.value })}
            >
              <span className="ua-level-btn-label">{level.label}</span>
              <span className="ua-level-btn-impact">
                {dir ? `${pct}% ${dir}` : 'neutral'}
              </span>
            </button>
          );
        })}
      </div>

      {/* Time range */}
      <p className="ua-form-label ua-form-label--spaced">Time</p>
      <TimeInput
        mode="range"
        value={{ start: formData.startTime, end: formData.endTime }}
        onChange={({ start, end }) => onChange({ ...formData, startTime: start, endTime: end })}
        className="ua-time-input"
        required
      />

      {/* Expected checkbox */}
      <label className="ua-expected-row">
        <input
          type="checkbox"
          className="ua-expected-native"
          checked={formData.isExpected}
          onChange={(e) => onChange({ ...formData, isExpected: e.target.checked })}
        />
        <span className={`ua-expected-box${formData.isExpected ? ' ua-expected-box--checked' : ''}`}>
          {formData.isExpected && <span className="ua-expected-tick">✓</span>}
        </span>
        <span className="ua-expected-text">
          <span className="ua-expected-label">Expected activity</span>
          <span className="ua-expected-hint">Planned ahead — can be removed if not completed</span>
        </span>
      </label>

      {/* HR section — only for completed activities */}
      {!formData.isExpected && (
        <HrSection
          hrData={{ hr_base: formData.hr_base, hr_max: formData.hr_max, hr_trace: formData.hr_trace }}
          onChange={(hr) => onChange({ ...formData, ...hr })}
        />
      )}

      {/* Form actions */}
      <div className="ua-form-actions">
        <button
          type="button" className="ua-btn ua-btn--cancel"
          onClick={onCancel} disabled={isLoading}
        >
          Cancel
        </button>
        <button
          type="button" className="ua-btn ua-btn--confirm"
          onClick={onConfirm} disabled={isLoading}
        >
          <FaPlus /> Add Activity
        </button>
      </div>
    </div>
  );
});

// ─── PD Result Panel ──────────────────────────────────────────────────────────

const PdResultPanel = ({ result, onDismiss }) => {
  if (!result) return null;

  const effect   = result.cumulative_activity_effect ?? 0;
  const aob      = result.activity_on_board ?? 0;
  const mult     = result.sensitivity_multiplier ?? 1.0;
  const isf      = result.effective_correction_factor;
  const cr       = result.effective_carb_to_bg_ratio;
  const sessions = result.active_sessions ?? 0;

  return (
    <div className="pd-result-panel">
      <div className="pd-result-header">
        <FaFlask className="pd-result-icon" />
        <span>Activity PD Result</span>
        <button type="button" className="pd-result-dismiss" onClick={onDismiss} title="Dismiss">×</button>
      </div>
      <div className="pd-result-grid">
        <div className="pd-result-item">
          <span className="pd-label">BG Effect</span>
          <span className={`pd-value ${effect < 0 ? 'pd-negative' : 'pd-positive'}`}>
            {effect >= 0 ? '+' : ''}{effect.toFixed(1)} mg/dL
          </span>
        </div>
        <div className="pd-result-item">
          <span className="pd-label">Still On Board (AOB)</span>
          <span className="pd-value">{aob.toFixed(1)} mg/dL</span>
        </div>
        <div className="pd-result-item">
          <span className="pd-label">Sensitivity Boost</span>
          <span className={`pd-value ${mult > 1 ? 'pd-boost' : ''}`}>×{mult.toFixed(3)}</span>
        </div>
        <div className="pd-result-item">
          <span className="pd-label">Active Sessions</span>
          <span className="pd-value">{sessions}</span>
        </div>
        {isf != null && (
          <div className="pd-result-item">
            <span className="pd-label">Effective ISF</span>
            <span className="pd-value">{isf.toFixed(1)} mg/dL/u</span>
          </div>
        )}
        {cr != null && (
          <div className="pd-result-item">
            <span className="pd-label">Effective CR</span>
            <span className="pd-value">{cr.toFixed(2)} mg/dL/g</span>
          </div>
        )}
      </div>

      {result.activity_contributions?.length > 0 && (
        <details className="pd-contributions">
          <summary>Session breakdown ({result.activity_contributions.length})</summary>

          {/* ✅ FIX H-1: sensitivity_multiplier is a single top-level value that
              applies to ALL sessions collectively — it does not exist per-session
              on activity_contributions items. The column was therefore always "—".
              Display the aggregate value once above the table instead. */}
          {mult > 1.0 && (
            <p className="pd-sensitivity-note">
              Post-exercise sensitivity boost: <strong>×{mult.toFixed(3)}</strong>
              {' '}(applies to all sessions combined)
            </p>
          )}

          <table className="pd-contributions-table">
            <thead>
              <tr>
                <th>Intensity</th><th>Duration</th><th>BG drop</th><th>HR source</th>
              </tr>
            </thead>
            <tbody>
              {result.activity_contributions.map((c, i) => (
                <tr key={i}>
                  <td>{c.intensity ?? '—'}</td>
                  <td>{c.duration_minutes != null ? `${c.duration_minutes.toFixed(0)} min` : '—'}</td>
                  <td className={c.bg_drop < 0 ? 'pd-negative' : ''}>
                    {c.bg_drop != null ? `${c.bg_drop.toFixed(1)} mg/dL` : '—'}
                  </td>
                  <td>{c.hr_source ?? 'synthetic'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <div className="pd-result-meta">
        Calculated at: {result.calculated_at ? new Date(result.calculated_at).toLocaleTimeString() : '—'}
        {' · '}
        Window:{' '}
        {result.window_start
          ? new Date(result.window_start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : '?'}
        {' → '}
        {result.window_end
          ? new Date(result.window_end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : '?'}
      </div>
    </div>
  );
};

// ─── Watch Session Panel ──────────────────────────────────────────────────────

/**
 * WatchSessionPanel — live wearable HR streaming UI.
 *
 * Lifecycle:
 *   idle        → user clicks "Start Watch Session"
 *   connecting  → startWatchSession() called, waiting for session_id
 *   recording   → streamHrSamples() called every STREAM_INTERVAL_MS
 *   stopping    → endWatchSession() called
 *   done        → session saved; ActivityVisualization HR Live tab can fetch it
 *
 * HR input modes:
 *   • Manual entry: user types bpm values one by one (for testing)
 *   • File import:  user selects a CSV with t_sec,hr_bpm columns
 *   • Auto (future): Bluetooth/Garmin/Apple Watch SDK pushes samples here
 */
const STREAM_INTERVAL_MS = 5000; // flush buffered samples to backend every 5 s

const WatchSessionPanel = React.memo(({ onSessionComplete }) => {
  const [phase, setPhase]             = useState('idle');   // idle | connecting | recording | stopping | done
  const [sessionId, setSessionId]     = useState(null);
  const [elapsedSec, setElapsedSec]   = useState(0);
  const [totalRaw, setTotalRaw]       = useState(0);
  const [hrInput, setHrInput]         = useState('');
  const [pendingSamples, setPending]  = useState([]);   // buffered until next flush
  const [watchError, setWatchError]   = useState(null);
  const [intensity, setIntensity]     = useState('moderate');
  const [hrBase, setHrBase]           = useState('');
  const [hrMax, setHrMax]             = useState('');
  const [lastSessionId, setLastSessionId] = useState(null);

  const startTimeRef     = useRef(null);
  const timerRef         = useRef(null);
  const flushIntervalRef = useRef(null);
  const pendingRef       = useRef(pendingSamples);
  pendingRef.current     = pendingSamples;
  const sessionIdRef     = useRef(sessionId);
  sessionIdRef.current   = sessionId;

  // ── Elapsed timer ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase === 'recording') {
      timerRef.current = setInterval(() => {
        setElapsedSec(Math.round((Date.now() - startTimeRef.current) / 1000));
      }, 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [phase]);

  // ── Auto-flush buffer to backend ───────────────────────────────────────────
  const flushSamples = useCallback(async () => {
    const batch = pendingRef.current;
    if (!batch.length || !sessionIdRef.current) return;
    setPending([]);
    try {
      const res = await streamHrSamples({ session_id: sessionIdRef.current, samples: batch });
      setTotalRaw(res.total_raw || 0);
    } catch (err) {
      console.error('[WatchSession] stream error', err);
      // re-queue failed samples — don't lose data
      setPending(prev => [...batch, ...prev]);
    }
  }, []);

  useEffect(() => {
    if (phase === 'recording') {
      flushIntervalRef.current = setInterval(flushSamples, STREAM_INTERVAL_MS);
    } else {
      clearInterval(flushIntervalRef.current);
    }
    return () => clearInterval(flushIntervalRef.current);
  }, [phase, flushSamples]);

  // ── On mount: check for a crashed in-progress session ─────────────────────
  useEffect(() => {
    getWatchSessionStatus().then(status => {
      if (status.active && status.session_id) {
        setSessionId(status.session_id);
        sessionIdRef.current = status.session_id;
        setTotalRaw(status.total_raw || 0);

        // ✅ FIX C-2: Use the server's started_at timestamp to reconstruct the
        // correct session start time. The previous code used:
        //   Date.now() - (status.total_raw || 0) * 1000
        // but total_raw is a *count of samples*, not elapsed seconds. A 20-minute
        // session where the user tapped "Add HR" 40 times would produce a recovered
        // startTime of (now − 40 s) instead of (now − 20 min), making every
        // subsequent t_sec wrong and corrupting the ODE input trace.
        startTimeRef.current = status.started_at
          ? new Date(status.started_at).getTime()
          : Date.now();

        setPhase('recording');
        setWatchError('⚠ Recovered from a previous session that was still in-progress.');
      }
    }).catch(() => {});
  }, []);

  const handleStart = async () => {
    setWatchError(null);
    setPhase('connecting');
    try {
      const params = { intensity };
      if (hrBase) params.hr_base = parseFloat(hrBase);
      if (hrMax)  params.hr_max  = parseFloat(hrMax);
      const res = await startWatchSession(params);
      setSessionId(res.session_id);
      sessionIdRef.current = res.session_id;
      startTimeRef.current = Date.now();
      setElapsedSec(0);
      setTotalRaw(0);
      setPending([]);
      setPhase('recording');
    } catch (err) {
      setWatchError('Failed to start session: ' + (err?.response?.data?.error || err.message));
      setPhase('idle');
    }
  };

  const handleStop = async () => {
    setPhase('stopping');
    await flushSamples();
    try {
      const res = await endWatchSession({ session_id: sessionIdRef.current });
      setLastSessionId(sessionIdRef.current);
      setPhase('done');
      if (onSessionComplete) onSessionComplete(res);
    } catch (err) {
      setWatchError('Failed to end session: ' + (err?.response?.data?.error || err.message));
      setPhase('recording');
    }
  };

  // Manual HR entry: add one sample at current elapsed time
  const handleAddManual = () => {
    const bpm = parseFloat(hrInput);
    if (!bpm || bpm < 20 || bpm > 300) return;
    const t_sec = Math.round((Date.now() - startTimeRef.current) / 1000);
    setPending(prev => [...prev, { t_sec, hr_bpm: bpm }]);
    setHrInput('');
  };

  // CSV file import: columns t_sec,hr_bpm  OR  t_min,hr_bpm
  const handleCsvImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const lines  = ev.target.result.split('\n').filter(Boolean);
      const header = lines[0].toLowerCase().split(',').map(s => s.trim());
      const tIdx   = header.indexOf('t_sec') !== -1 ? header.indexOf('t_sec') : header.indexOf('t_min');
      const hrIdx  = header.indexOf('hr_bpm');
      if (tIdx === -1 || hrIdx === -1) {
        setWatchError('CSV must have columns: t_sec (or t_min) and hr_bpm');
        return;
      }
      const isMin = header[tIdx] === 't_min';
      const parsed = lines.slice(1).map(line => {
        const cols = line.split(',');
        const t_raw = parseFloat(cols[tIdx]);
        const hr    = parseFloat(cols[hrIdx]);
        if (isNaN(t_raw) || isNaN(hr)) return null;
        return { t_sec: isMin ? t_raw * 60 : t_raw, hr_bpm: hr };
      }).filter(Boolean);
      setPending(prev => [...prev, ...parsed]);
      setWatchError(null);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  if (phase === 'idle') {
    return (
      <div className="watch-session-panel watch-session-idle">
        <div className="watch-session-title"><FaStopwatch  /> ⌚ Start Watch Session</div>
        <p className="watch-session-hint">
          Stream real HR data directly from your wearable or CSV file.
          The session is saved to the same activities database and auto-appears in HR Live visualization.
        </p>
        <div className="watch-session-config">
          <label>Intensity
            <select value={intensity} onChange={e => setIntensity(e.target.value)} className="watch-intensity-select">
              <option value="light">🚶 Light</option>
              <option value="moderate">🏃 Moderate</option>
              <option value="vigorous">⚡ Vigorous</option>
            </select>
          </label>
          <label>Resting HR <input type="number" placeholder="70" value={hrBase} onChange={e => setHrBase(e.target.value)} className="watch-hr-input" min={30} max={120} /></label>
          <label>Max HR <input type="number" placeholder="185" value={hrMax} onChange={e => setHrMax(e.target.value)} className="watch-hr-input" min={100} max={250} /></label>
        </div>
        {watchError && <div className="watch-error">{watchError}</div>}
        <button type="button" className="watch-start-btn" onClick={handleStart}>
          <FaCircle style={{ color: '#e53935' }} /> Start Session
        </button>
      </div>
    );
  }

  if (phase === 'connecting') {
    return (
      <div className="watch-session-panel">
        <FaSync className="activity-spin" /> Connecting to server…
      </div>
    );
  }

  if (phase === 'recording') {
    return (
      <div className="watch-session-panel watch-session-recording">
        <div className="watch-session-header">
          <span className="watch-recording-dot">●</span>
          <span className="watch-session-title">Recording — {fmtTime(elapsedSec)}</span>
          <span className="watch-sample-count">{totalRaw + pendingSamples.length} samples</span>
          <button type="button" className="watch-stop-btn" onClick={handleStop}><FaStop /> Stop</button>
        </div>

        {watchError && <div className="watch-error">{watchError}</div>}

        {/* Manual HR entry */}
        <div className="watch-manual-entry">
          <input
            type="number" className="watch-hr-live-input"
            placeholder="Type HR bpm…" value={hrInput}
            onChange={e => setHrInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAddManual()}
            min={30} max={250}
          />
          <button type="button" className="watch-add-sample-btn" onClick={handleAddManual}>
            <FaPlus /> Add
          </button>
        </div>

        {/* CSV batch import */}
        <label className="watch-csv-label">
          <FaFileImport /> Import CSV
          <input type="file" accept=".csv" style={{ display: 'none' }} onChange={handleCsvImport} />
        </label>

        {pendingSamples.length > 0 && (
          <div className="watch-pending-note">
            {pendingSamples.length} sample{pendingSamples.length !== 1 ? 's' : ''} buffered — auto-syncing…
          </div>
        )}

        <div className="watch-session-id-note">Session: {sessionId}</div>
      </div>
    );
  }

  if (phase === 'stopping') {
    return (
      <div className="watch-session-panel">
        <FaSync className="activity-spin" /> Finalising session…
      </div>
    );
  }

  // done
  return (
    <div className="watch-session-panel watch-session-done">
      <div className="watch-session-title">✅ Session Saved</div>
      <p>
        {totalRaw} raw samples stored.
        Open the <strong>HR Live</strong> tab in Activity Visualization to inspect the per-second trace.
      </p>
      {lastSessionId && (
        <div className="watch-session-id-note">Session ID: {lastSessionId}</div>
      )}
      <button type="button" className="watch-start-btn" onClick={() => { setPhase('idle'); setSessionId(null); setTotalRaw(0); }}>
        Start Another Session
      </button>
    </div>
  );
});


// ─── Main Component ───────────────────────────────────────────────────────────

const ActivityRecording = ({
  standalone = true,
  onActivityUpdate,
  initialActivities = []
}) => {
  const { patientConstants, loading, error } = useConstants();

  // ── Core state ────────────────────────────────────────────────────────────
  const [activities, setActivities]                     = useState(initialActivities);
  const [notes, setNotes]                               = useState('');
  const [status, setStatus]                             = useState({ type: '', message: '' });
  const [isLoading, setIsLoading]                       = useState(false);
  const [userTimeZone, setUserTimeZone]                 = useState('');
  const [importStatus, setImportStatus]                 = useState(null);
  const [recentActivities, setRecentActivities]         = useState([]);
  const [showRecentActivities, setShowRecentActivities] = useState(false);
  const [pdResult, setPdResult]                         = useState(null);

  // ── Add-form state ────────────────────────────────────────────────────────
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState(makeEmptyForm());

  // ── Watch session state ───────────────────────────────────────────────────
  const [showWatchPanel, setShowWatchPanel] = useState(false);

  const fileInputRef = useRef(null);

  // ── Init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    setUserTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  // ── Impact calculation ────────────────────────────────────────────────────
  const totalImpact = useMemo(() => {
    if (!activities.length || !patientConstants?.activity_coefficients) return 1.0;
    return activities.reduce((total, activity) => {
      const coefficient    = patientConstants.activity_coefficients[activity.level] || 1.0;
      const durationData   = TimeManager.calculateDuration(activity.startTime, activity.endTime);
      const durationWeight = Math.min(durationData.totalHours / 2, 1);
      return total * (1.0 + ((coefficient - 1.0) * durationWeight));
    }, 1.0);
  }, [activities, patientConstants]);

  const totalImpactText = totalImpact !== 1
    ? `Total: ${((totalImpact - 1) * 100).toFixed(1)}% ${totalImpact > 1 ? 'increase' : 'decrease'} in insulin sensitivity`
    : 'No overall impact';

  // ── Parent notification (non-standalone) ──────────────────────────────────
  const processedActivities = useMemo(() => {
    if (!patientConstants) return [];
    return activities
      .filter(a => a.type === 'expected')
      .map(activity => {
        const durationData = TimeManager.calculateDuration(activity.startTime, activity.endTime);
        return {
          ...activity,
          impact:        patientConstants.activity_coefficients[activity.level] || 1.0,
          duration:      durationData.formatted,
          durationHours: durationData.totalHours,
        };
      });
  }, [activities, patientConstants]);

  useEffect(() => {
    if (!standalone && onActivityUpdate && patientConstants && processedActivities.length > 0) {
      onActivityUpdate(processedActivities, totalImpact);
    }
  }, [standalone, onActivityUpdate, patientConstants, processedActivities, totalImpact]);

  // ── Recent activities fetch ───────────────────────────────────────────────
  const fetchRecentActivities = useCallback(async () => {
    if (!standalone) return;
    try {
      setIsLoading(true);
      const token = localStorage.getItem('token');
      if (!token) { console.warn('No authentication token found'); return; }

      const response = await axios.get(`${API_BASE_URL}/api/activity-history`, {
        headers: { 'Authorization': `Bearer ${token}` },
        params: { limit: 5 }
      });

      if (response.data && Array.isArray(response.data)) {
        const formatted = response.data.map(activity => {
          const levelInfo = ACTIVITY_LEVELS.find(l => l.value === activity.level) || {};
          return {
            ...activity,
            levelLabel:         levelInfo.label || 'Unknown',
            formattedStartTime: activity.startTime
              ? TimeManager.utcToLocalString(activity.startTime)
              : TimeManager.utcToLocalString(activity.timestamp),
            formattedEndTime:   activity.endTime ? TimeManager.utcToLocalString(activity.endTime) : '',
            impactType:         activity.impact > 1 ? 'increase' : activity.impact < 1 ? 'decrease' : 'neutral',
          };
        });
        setRecentActivities(formatted);
      }
    } catch (err) {
      console.error('[ActivityRecording] Error fetching recent activities:', err);
      setStatus({ type: 'error', message: 'Failed to load recent activities' });
    } finally {
      setIsLoading(false);
    }
  }, [standalone]);

  useEffect(() => {
    if (standalone) fetchRecentActivities();
  }, [standalone, fetchRecentActivities]);

  // ── Activity CRUD ─────────────────────────────────────────────────────────
  const confirmAddActivity = useCallback(() => {
    if (formData.level === undefined || formData.level === null) return;

    const durationData = TimeManager.calculateDuration(formData.startTime, formData.endTime);
    const type         = formData.isExpected ? 'expected' : 'completed';

    setActivities(prev => [...prev, {
      level:     formData.level,
      startTime: formData.startTime,
      endTime:   formData.endTime,
      duration:  durationData.formatted,
      type,
      notes:     formData.notes,
      hr_base:   formData.hr_base,
      hr_max:    formData.hr_max,
      hr_trace:  formData.hr_trace,
    }]);

    setShowForm(false);
    setFormData(makeEmptyForm());
  }, [formData]);

  const removeActivity = useCallback((activity) => {
    setActivities(prev => prev.filter(a => a !== activity));
  }, []);

  const toggleForm = () => {
    setShowForm(v => !v);
    setFormData(makeEmptyForm());
  };

  // ── Import ────────────────────────────────────────────────────────────────
  const handleImportClick = () => { if (fileInputRef.current) fileInputRef.current.click(); };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const fileExt = file.name.split('.').pop().toLowerCase();
    if (fileExt !== 'csv' && fileExt !== 'json') {
      setImportStatus({ type: 'error', message: 'Invalid file format. Please select a CSV or JSON file.' });
      return;
    }

    setIsLoading(true);
    setImportStatus({ type: 'info', message: 'Validating file…' });

    try {
      const fd    = new FormData();
      fd.append('file', file);
      fd.append('type', 'activities');

      const token = localStorage.getItem('token');
      if (!token) throw new Error('Authentication token not found');

      const validationResponse = await axios.post(`${API_BASE_URL}/api/import/validate`, fd, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'multipart/form-data' }
      });
      if (!validationResponse.data.valid) {
        setImportStatus({
          type: 'error', message: 'File validation failed',
          details: validationResponse.data.errors?.join('\n')
        });
        setIsLoading(false);
        return;
      }

      setImportStatus({ type: 'info', message: 'Importing data…' });
      const importResponse = await axios.post(`${API_BASE_URL}/api/import`, fd, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'multipart/form-data' }
      });

      const results = importResponse.data.results;
      setImportStatus({
        type: 'success',
        message: `Successfully imported ${results.activities_imported || 0} activities`,
      });

      if (fileInputRef.current) fileInputRef.current.value = '';
      fetchRecentActivities();

    } catch (err) {
      console.error('[ActivityRecording] Error importing data:', err);
      setImportStatus({
        type: 'error', message: 'Failed to import data',
        details: err.response?.data?.error || err.message
      });
    } finally {
      setIsLoading(false);
    }
  };

  const convertToUTCIsoString = useCallback((localTime) => {
    if (!localTime) return null;
    return moment(localTime).utc().toISOString();
  }, []);

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!standalone) return;

    setIsLoading(true);
    setPdResult(null);
    let activity_ids = [];

    try {
      const token   = localStorage.getItem('token');
      const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

      const processedActivitiesData = activities.map(activity => {
        const durationData = TimeManager.calculateDuration(activity.startTime, activity.endTime);
        return {
          level:     activity.level,
          type:      activity.type,
          startTime: convertToUTCIsoString(activity.startTime),
          endTime:   convertToUTCIsoString(activity.endTime),
          duration:  TimeManager.hoursToTimeString(durationData.totalHours),
          impact:    patientConstants.activity_coefficients[activity.level] || 1.0,
        };
      });

      const activitiesData = {
        expectedActivities: activities.filter(a => a.type === 'expected').map(activity => {
          const dur  = TimeManager.calculateDuration(activity.startTime, activity.endTime);
          const sUTC = convertToUTCIsoString(activity.startTime);
          const eUTC = convertToUTCIsoString(activity.endTime);
          return {
            level:        activity.level,
            intensity:    LEVEL_TO_INTENSITY[String(activity.level)] || 'light',
            duration:     TimeManager.hoursToTimeString(dur.totalHours),
            expectedTime: sUTC, startTime: sUTC, endTime: eUTC,
            impact:       patientConstants.activity_coefficients[activity.level] || 1.0,
            notes,
          };
        }),
        completedActivities: activities.filter(a => a.type === 'completed').map(activity => {
          const dur  = TimeManager.calculateDuration(activity.startTime, activity.endTime);
          const sUTC = convertToUTCIsoString(activity.startTime);
          const eUTC = convertToUTCIsoString(activity.endTime);

          const hrPayload = {};
          if (activity.hr_base !== '' && activity.hr_base != null)
            hrPayload.hr_base = parseFloat(activity.hr_base);
          if (activity.hr_max  !== '' && activity.hr_max  != null)
            hrPayload.hr_max  = parseFloat(activity.hr_max);
          if (activity.hr_trace?.length > 0) {
            hrPayload.hr_trace = [...activity.hr_trace]
              .sort((a, b) => a.t_min - b.t_min)
              .filter(pt => pt.t_min >= 0 && pt.hr_bpm > 0)
              .map(pt => ({ t_min: pt.t_min, hr_bpm: pt.hr_bpm }));
          }

          return {
            level:            activity.level,
            intensity:        LEVEL_TO_INTENSITY[String(activity.level)] || 'light',
            duration:         TimeManager.hoursToTimeString(dur.totalHours),
            duration_minutes: dur.totalHours * 60,
            completedTime:    sUTC, startTime: sUTC, endTime: eUTC,
            impact:           patientConstants.activity_coefficients[activity.level] || 1.0,
            notes,
            ...hrPayload,
          };
        }),
        notes,
      };

      // Step 1 — record activities
      const activityResponse = await axios.post(
        `${API_BASE_URL}/api/record-activities`, activitiesData, { headers }
      );
      if (activityResponse.data?.activity_ids) {
        activity_ids = activityResponse.data.activity_ids;
      }

      // Step 2 — create meal record
      await axios.post(`${API_BASE_URL}/api/meal`, {
        timestamp:    new Date().toISOString(),
        mealType:     'activity_only',
        foodItems:    [],
        activities:   processedActivitiesData,
        activityIds:  activity_ids,
        notes,
        recordingType: 'standalone_activity_recording',
        calculationFactors: { activityImpact: totalImpact, healthMultiplier: 0.0 },
        skipActivityDuplication: true,
      }, { headers });

      setStatus({ type: 'success', message: 'Activities recorded successfully!' });
      setActivities([]);
      setNotes('');
      fetchRecentActivities();

      // Step 3 — fetch PD result (non-fatal)
      setTimeout(async () => {
        try {
          const pdResponse = await axios.get(`${API_BASE_URL}/api/activity/pharmacodynamics`, { headers });
          setPdResult(pdResponse.data);
        } catch (pdErr) {
          console.warn('[ActivityRecording] PD fetch failed (non-fatal):', pdErr);
          setStatus(prev => ({ ...prev, message: prev.message + ' (PD fetch unavailable)' }));
        }
      }, 800);

    } catch (err) {
      console.error('[ActivityRecording] Error submitting activities:', err);
      setStatus({ type: 'error', message: err.response?.data?.message || 'Error recording activities' });
    } finally {
      setIsLoading(false);
    }
  }, [standalone, activities, notes, totalImpact, patientConstants, convertToUTCIsoString, fetchRecentActivities]);

  // ── Guards ────────────────────────────────────────────────────────────────
  if (loading) return <div className="activity-loading">Loading activity settings…</div>;
  if (error)   return <div className="activity-error">Error loading activity settings: {error}</div>;

  // ── Shared inner content ──────────────────────────────────────────────────
  const formContent = (
    <>
      {/* 1. Unified activity list */}
      {activities.length > 0 && (
        <div className="ua-list">
          {activities.map((activity, index) => (
            <ActivityCard
              key={index}
              activity={activity}
              onRemove={() => removeActivity(activity)}
              activityCoefficients={patientConstants?.activity_coefficients}
            />
          ))}
        </div>
      )}

      {/* 2. Impact summary */}
      {activities.length > 0 && (
        <div className={`ua-impact-summary ua-impact-summary--${
          totalImpact > 1 ? 'increase' : totalImpact < 1 ? 'decrease' : 'neutral'
        }`}>
          {totalImpactText}
        </div>
      )}

      {/* 3. Add button OR inline form */}
      {!showForm ? (
        <button
          type="button"
          className="ua-add-btn"
          onClick={toggleForm}
          disabled={isLoading}
        >
          <FaPlus /> Add Activity
        </button>
      ) : (
        <ActivityForm
          formData={formData}
          onChange={setFormData}
          onConfirm={confirmAddActivity}
          onCancel={toggleForm}
          activityCoefficients={patientConstants?.activity_coefficients}
          isLoading={isLoading}
        />
      )}

      {/* 4. Notes + submit (standalone only) */}
      {standalone && (
        <>
          <div className="activity-notes-section">
            <label htmlFor="activity-notes">Notes:</label>
            <textarea
              id="activity-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add any notes about your activities…"
              disabled={isLoading}
              className="activity-notes-input"
            />
          </div>
          <button type="submit" className="activity-submit-button" disabled={isLoading}>
            {isLoading ? 'Recording…' : 'Record Activities'}
          </button>
        </>
      )}
    </>
  );

  // ── Root render ───────────────────────────────────────────────────────────
  return (
    <div className={standalone ? 'activity-standalone-container' : 'activity-inline-container'}>

      {/* Toolbar */}
      {standalone && (
        <div className="activity-header">
          <div className="ua-title-row">
            <h2>Record Activities</h2>
            {activities.length > 0 && (
              <span className={`ua-header-badge ua-header-badge--${
                totalImpact > 1 ? 'increase' : totalImpact < 1 ? 'decrease' : 'neutral'
              }`}>
                {totalImpact !== 1
                  ? `${Math.abs(((totalImpact - 1) * 100)).toFixed(1)}% ${totalImpact > 1 ? 'increase' : 'decrease'}`
                  : 'No impact'}
              </span>
            )}
          </div>
          <div className="activity-action-buttons">
            <button
              type="button" className="activity-icon-button activity-refresh-btn"
              onClick={fetchRecentActivities} title="Refresh activities" disabled={isLoading}
            >
              <FaSync className={isLoading ? 'activity-spin' : ''} />
            </button>
            <button
              type="button" className="activity-icon-button activity-history-btn"
              onClick={() => { setShowRecentActivities(v => !v); if (!showRecentActivities) fetchRecentActivities(); }}
              title={showRecentActivities ? 'Hide recent activities' : 'Show recent activities'}
            >
              <FaHistory />
            </button>
            <button
              type="button" className="activity-icon-button activity-import-btn"
              onClick={handleImportClick} title="Import activities" disabled={isLoading}
            >
              <FaFileImport />
            </button>
            <button
              type="button"
              className={`activity-icon-button activity-watch-btn ${showWatchPanel ? 'active' : ''}`}
              onClick={() => setShowWatchPanel(v => !v)}
              title={showWatchPanel ? 'Hide watch session' : 'Start wearable HR session'}
              style={{ color: showWatchPanel ? '#e53935' : undefined }}
            >
              <FaStopwatch  />
            </button>
            <input
              type="file" ref={fileInputRef} style={{ display: 'none' }}
              accept=".csv,.json" onChange={handleFileUpload}
            />
          </div>
        </div>
      )}

      {/* Timezone info */}
      {standalone && (
        <div className="activity-timezone-info">
          Your timezone: {userTimeZone}
          <span className="activity-timezone-note">
            {' '}(all times stored in UTC but displayed in your local timezone)
          </span>
        </div>
      )}

      {/* Import status */}
      {importStatus && (
        <div className={`activity-message activity-msg-${importStatus.type}`}>
          <FaInfoCircle className="activity-message-icon" />
          <div className="activity-message-content">
            <h4>{importStatus.message}</h4>
            {importStatus.details && (
              <pre className="activity-message-details">{importStatus.details}</pre>
            )}
          </div>
        </div>
      )}

      {/* ⌚ Watch Session Panel */}
      {standalone && showWatchPanel && (
        <WatchSessionPanel
          onSessionComplete={(result) => {
            setShowWatchPanel(false);
            fetchRecentActivities();
            setStatus({
              type: 'success',
              message: `⌚ Watch session saved — ${result.duration_minutes} min, ${result.intensity}, ${result.total_raw_samples} raw HR samples`,
            });
          }}
        />
      )}

      {/* Recent activities panel */}
      {standalone && showRecentActivities && (
        <div className="activity-recent-activities">
          <h3>Recent Activities</h3>
          {recentActivities.length > 0 ? (
            <div className="activity-recent-activities-list">
              {recentActivities.map((activity) => (
                <div key={activity.id} className="activity-recent-activity-item">
                  <div className="activity-type-and-level">
                    <span className="activity-type-badge">{activity.type}</span>
                    <span className="activity-level-badge">{activity.levelLabel}</span>
                    {activity.intensity && (
                      <span className="activity-intensity-badge">{activity.intensity}</span>
                    )}
                  </div>
                  <div className="activity-details">
                    <span className="activity-time">
                      {new Date(activity.formattedStartTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      {activity.formattedEndTime && ` - ${new Date(activity.formattedEndTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                    </span>
                    <span className="activity-date">
                      {new Date(activity.formattedStartTime).toLocaleDateString()}
                    </span>
                    <span className="activity-duration">Duration: {activity.duration}</span>
                    {(() => {
                      const restHR = activity.hr_base ?? activity.session_hr_min;
                      const peakHR = activity.hr_max  ?? activity.session_hr_peak;
                      return (restHR || peakHR) ? (
                        <span className="activity-hr-summary">
                          <FaHeartbeat className="activity-inline-icon" />
                          {restHR && `Rest: ${restHR}`}
                          {restHR && peakHR && ' / '}
                          {peakHR && `Max: ${peakHR}`}
                          {activity.hr_trace?.length > 0 && ` · ${activity.hr_trace.length} pts`}
                        </span>
                      ) : null;
                    })()}
                  </div>
                  {activity.notes && (
                    <div className="activity-notes-display" title={activity.notes}>
                      {activity.notes}
                    </div>
                  )}
                  <div className={`activity-impact-badge activity-impact-${activity.impactType}`}>
                    {activity.impact !== 1
                      ? `${Math.abs((activity.impact - 1) * 100).toFixed(1)}% ${activity.impact > 1 ? 'Increase' : 'Decrease'}`
                      : 'No Effect'}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="activity-no-activities">
              {isLoading ? 'Loading…' : 'No recent activities found'}
            </p>
          )}
          <div className="activity-activities-footer">
            <span className="activity-import-note">
              Need to import multiple activities? Click the{' '}
              <FaFileImport className="activity-inline-icon" /> import button above.
            </span>
          </div>
        </div>
      )}

      {/* PD result */}
      {pdResult && <PdResultPanel result={pdResult} onDismiss={() => setPdResult(null)} />}

      {/* Status message */}
      {status.message && (
        <div className={`activity-message activity-msg-${status.type}`}>
          {status.message}
        </div>
      )}

      {/* Main content — wrapped in <form> for standalone, <div> when embedded */}
      {standalone ? (
        <form onSubmit={handleSubmit} className="activity-form">
          {formContent}
        </form>
      ) : (
        <div className="activity-form">
          {formContent}
        </div>
      )}
    </div>
  );
};

export default React.memo(ActivityRecording);