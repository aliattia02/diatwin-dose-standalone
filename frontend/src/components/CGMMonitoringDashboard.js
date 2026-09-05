/**
 * LibreCGM.js — LibreLinkUp CGM Panel (Connect + History in one file)
 * Location: frontend/src/components/LibreCGM.js
 *
 * State machine:
 *   Not connected  →  ConnectForm  (shown once until credentials are saved)
 *   Connected      →  ReadingsView (live banner + day-grouped history)
 *                     with an inline "manage connection" drawer
 *
 * All data flows through LibreContext — no local fetching.
 *
 * Usage:
 *   <LibreProvider>
 *     <LibreCGM />
 *   </LibreProvider>
 */

import React, { useEffect, useState } from 'react';
import {
  useLibre,
  LIBRE_REGION_OPTIONS,
  formatDayLabel,
  formatReadingTime,
  getReadingColor,
  getTrendArrow,
  getTrendColor,
  timeAgo,
} from '../contexts/LibreContext';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const HOUR_OPTIONS = [
  { label: '6 h',  value: 6   },
  { label: '24 h', value: 24  },
  { label: '3 d',  value: 72  },
  { label: '7 d',  value: 168 },
];

const READING_TYPE_LABEL = { 0: 'CGM', 1: 'Scan', 2: 'Fingerstick' };

// ─────────────────────────────────────────────────────────────────────────────
// Shared primitives
// ─────────────────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="lcgm-loading">
      <span className="lcgm-spinner" />
      <span>Loading…</span>
    </div>
  );
}

function ErrorBanner({ message }) {
  if (!message) return null;
  return <div className="lcgm-error-banner">⚠ {message}</div>;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── CONNECT FORM (shown only when not connected) ──────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

function RegionPicker({ selected, onChange, disabled }) {
  return (
    <div className="lcgm-field">
      <label className="lcgm-label">Server Region</label>
      <div className="lcgm-region-row">
        {LIBRE_REGION_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`lcgm-region-chip ${selected === opt.value ? 'active' : ''}`}
            onClick={() => onChange(opt.value)}
            disabled={disabled}
          >
            {opt.value}
          </button>
        ))}
      </div>
      <span className="lcgm-hint">
        {LIBRE_REGION_OPTIONS.find((o) => o.value === selected)?.label ?? ''}
      </span>
    </div>
  );
}

function ConnectForm() {
  const { connect, connecting, actionError, clearActionError } = useLibre();

  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [region,   setRegion]   = useState('EU');
  const [showPass, setShowPass] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    clearActionError();
    const trimEmail = email.trim().toLowerCase();
    if (!trimEmail || !password) return;
    await connect({ email: trimEmail, password, region });
  };

  return (
    <div className="lcgm-root">
      <h2 className="lcgm-title">🩸 Connect LibreLinkUp CGM</h2>

      {/* Explainer */}
      <div className="lcgm-info-card">
        <span className="lcgm-info-icon">ℹ️</span>
        <div>
          <p className="lcgm-info-title">How it works</p>
          <p className="lcgm-info-text">
            DiaTwin connects to <strong>LibreLinkUp</strong> — Abbott's sharing
            platform — using your <strong>LibreLinkUp follower account</strong>,
            not your LibreView patient account. Make sure you have set up a
            sharing connection in the official LibreLinkUp app first.
          </p>
        </div>
      </div>

      <form className="lcgm-form" onSubmit={handleSubmit} noValidate>

        {/* Email */}
        <div className="lcgm-field">
          <label className="lcgm-label">LibreLinkUp Email</label>
          <input
            className="lcgm-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={connecting}
            autoComplete="email"
            spellCheck={false}
          />
        </div>

        {/* Password */}
        <div className="lcgm-field">
          <label className="lcgm-label">Password</label>
          <div className="lcgm-password-row">
            <input
              className="lcgm-input"
              type={showPass ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="LibreLinkUp password"
              disabled={connecting}
              autoComplete="current-password"
            />
            <button
              type="button"
              className="lcgm-show-hide"
              onClick={() => setShowPass((v) => !v)}
              tabIndex={-1}
            >
              {showPass ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        <RegionPicker selected={region} onChange={setRegion} disabled={connecting} />

        <ErrorBanner message={actionError} />

        <button
          type="submit"
          className={`lcgm-btn lcgm-btn-primary ${connecting ? 'loading' : ''}`}
          disabled={connecting || !email.trim() || !password}
        >
          {connecting ? 'Connecting…' : 'Connect LibreLinkUp'}
        </button>
      </form>

      <p className="lcgm-privacy">
        🔒 Your credentials are encrypted and stored securely on the DiaTwin
        server. They are never shared with third parties.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── READINGS VIEW (shown when connected) ─────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/** Live reading card at the top of the readings view */
function LiveReadingCard({ reading, onSync, syncing }) {
  const valueColor = getReadingColor(reading);
  const arrowColor = getTrendColor(reading.trend);
  const arrow      = getTrendArrow(reading.trend);

  return (
    <div className="lcgm-live-card">
      <div className="lcgm-live-left">
        <span className="lcgm-live-label">Current Reading</span>
        <div className="lcgm-live-value-row">
          <span className="lcgm-live-value" style={{ color: valueColor }}>
            {reading.bloodSugar}
          </span>
          <span className="lcgm-live-unit">mg/dL</span>
          <span className="lcgm-live-arrow" style={{ color: arrowColor }}>{arrow}</span>
        </div>
        <span className="lcgm-live-time">{timeAgo(reading.bloodSugarTimestamp)}</span>
      </div>
      <button
        className={`lcgm-btn lcgm-btn-sync ${syncing ? 'loading' : ''}`}
        onClick={onSync}
        disabled={syncing}
      >
        {syncing ? '↻ Syncing…' : '↻ Sync now'}
      </button>
    </div>
  );
}

/** Summary stats bar (avg / min / max / TIR) */
function StatsBar({ readings }) {
  if (!readings.length) return null;

  const values  = readings.map((r) => r.bloodSugar);
  const avg     = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  const min     = Math.min(...values);
  const max     = Math.max(...values);
  const inRange = readings.filter((r) => r.status === 'normal').length;
  const tir     = Math.round((inRange / readings.length) * 100);

  return (
    <div className="lcgm-stats-bar">
      {[
        { label: 'Avg',           value: `${avg} mg/dL` },
        { label: 'Min',           value: `${min} mg/dL` },
        { label: 'Max',           value: `${max} mg/dL` },
        { label: 'Time in Range', value: `${tir}%`       },
      ].map(({ label, value }) => (
        <div key={label} className="lcgm-stat-item">
          <span className="lcgm-stat-label">{label}</span>
          <span className="lcgm-stat-value">{value}</span>
        </div>
      ))}
    </div>
  );
}

/** Single reading row inside a day table */
function ReadingRow({ reading }) {
  const valueColor = getReadingColor(reading);
  const arrowColor = getTrendColor(reading.trend);
  const arrow      = getTrendArrow(reading.trend);
  const typeLabel  = READING_TYPE_LABEL[reading.reading_type] ?? 'CGM';
  const time       = formatReadingTime(reading.bloodSugarTimestamp);

  const statusClass =
    reading.status === 'low'  ? 'lcgm-status-low'  :
    reading.status === 'high' ? 'lcgm-status-high' :
                                'lcgm-status-normal';

  return (
    <tr className="lcgm-row">
      <td className="lcgm-cell lcgm-cell-time">{time}</td>
      <td className="lcgm-cell">
        <span style={{ color: valueColor, fontWeight: 700 }}>{reading.bloodSugar}</span>
        <span className="lcgm-unit"> mg/dL</span>
      </td>
      <td className="lcgm-cell lcgm-cell-trend">
        <span style={{ color: arrowColor }}>{arrow}</span>
        <span className="lcgm-trend-label">{reading.trend_label || ''}</span>
      </td>
      <td className="lcgm-cell">
        <span className={`lcgm-status-pill ${statusClass}`}>
          {reading.status?.toUpperCase() ?? '–'}
        </span>
      </td>
      <td className="lcgm-cell lcgm-cell-type">
        {reading.reading_type !== 0 && (
          <span className="lcgm-type-badge">{typeLabel}</span>
        )}
      </td>
    </tr>
  );
}

/** Collapsible day section */
function DaySection({ date, readings }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="lcgm-day-section">
      <button
        className="lcgm-day-header"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span className="lcgm-day-label">{formatDayLabel(date)}</span>
        <span className="lcgm-day-count">{readings.length} readings</span>
        <span className="lcgm-day-toggle">{collapsed ? '▸' : '▾'}</span>
      </button>

      {!collapsed && (
        <table className="lcgm-table">
          <thead>
            <tr>
              {['Time', 'Glucose', 'Trend', 'Status', 'Type'].map((h) => (
                <th key={h} className="lcgm-th">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {readings.map((r) => <ReadingRow key={r._id} reading={r} />)}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Inline connection-management drawer (accessible from readings view) */
function ConnectionDrawer({ onClose }) {
  const {
    status, disconnect, disconnecting,
    updateSettings, updatingSettings, actionError,
  } = useLibre();

  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [autoSync, setAutoSync]                   = useState(status?.auto_sync_enabled ?? true);
  const [interval, setInterval]                   = useState(status?.sync_interval_minutes ?? 5);

  const handleDisconnect = async () => {
    if (!confirmDisconnect) { setConfirmDisconnect(true); return; }
    await disconnect(false);
  };

  const handleSaveSettings = () =>
    updateSettings({ auto_sync_enabled: autoSync, sync_interval_minutes: Number(interval) });

  return (
    <div className="lcgm-drawer">
      <div className="lcgm-drawer-header">
        <span className="lcgm-drawer-title">Connection Settings</span>
        <button className="lcgm-drawer-close" onClick={onClose}>✕</button>
      </div>

      {/* Account info */}
      <div className="lcgm-meta-grid">
        {[
          ['Account',  [status?.first_name, status?.last_name].filter(Boolean).join(' ') || '–'],
          ['Region',   status?.region ?? '–'],
          ['Last sync', status?.last_sync ? timeAgo(status.last_sync) : 'Never'],
          ['Readings saved', status?.total_readings_synced?.toLocaleString() ?? '0'],
        ].map(([label, value]) => (
          <div key={label} className="lcgm-meta-item">
            <span className="lcgm-meta-label">{label}</span>
            <span className="lcgm-meta-value">{value}</span>
          </div>
        ))}
      </div>

      {/* Auto-sync toggle */}
      <div className="lcgm-settings-row">
        <label className="lcgm-settings-label">
          <input
            type="checkbox"
            checked={autoSync}
            onChange={(e) => setAutoSync(e.target.checked)}
          />
          Auto-sync enabled
        </label>
        {autoSync && (
          <label className="lcgm-settings-label">
            Every{' '}
            <select
              className="lcgm-select"
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
            >
              {[5, 10, 15, 30].map((m) => (
                <option key={m} value={m}>{m} min</option>
              ))}
            </select>
          </label>
        )}
        <button
          className={`lcgm-btn lcgm-btn-ghost ${updatingSettings ? 'loading' : ''}`}
          onClick={handleSaveSettings}
          disabled={updatingSettings}
        >
          {updatingSettings ? 'Saving…' : 'Save'}
        </button>
      </div>

      <ErrorBanner message={actionError} />

      {status?.live_fetch_error && (
        <div className="lcgm-error-banner">⚠ Live fetch error: {status.live_fetch_error}</div>
      )}

      {/* Disconnect */}
      <button
        className={`lcgm-btn lcgm-btn-danger ${disconnecting ? 'loading' : ''}`}
        onClick={handleDisconnect}
        disabled={disconnecting}
      >
        {disconnecting ? 'Disconnecting…' : confirmDisconnect ? '⚠ Confirm disconnect?' : 'Disconnect LibreLinkUp'}
      </button>
      {confirmDisconnect && !disconnecting && (
        <button className="lcgm-btn lcgm-btn-ghost" onClick={() => setConfirmDisconnect(false)}>
          Cancel
        </button>
      )}
    </div>
  );
}

/** Main readings view — rendered when connected */
function ReadingsView() {
  const {
    status, readings, grouped, readingCount,
    readingsLoading, syncing, syncResult, fetchReadings, sync,
  } = useLibre();

  const [hours,       setHours]       = useState(24);
  const [showDrawer,  setShowDrawer]  = useState(false);

  const latestLive = status?.latest_reading ?? null;

  useEffect(() => {
    fetchReadings({ hours });
  }, [hours]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="lcgm-root">

      {/* Header */}
      <div className="lcgm-readings-header">
        <h2 className="lcgm-title">🩸 CGM Readings</h2>
        <button
          className="lcgm-btn lcgm-btn-ghost lcgm-manage-btn"
          onClick={() => setShowDrawer((v) => !v)}
        >
          ⚙ Manage
        </button>
      </div>

      {/* Connection management drawer */}
      {showDrawer && <ConnectionDrawer onClose={() => setShowDrawer(false)} />}

      {/* Live reading */}
      {latestLive && (
        <LiveReadingCard reading={latestLive} onSync={sync} syncing={syncing} />
      )}

      {/* Sync result notice */}
      {syncResult && (
        <div className="lcgm-sync-toast">
          ✓ Synced — {syncResult.new_count} new reading{syncResult.new_count !== 1 ? 's' : ''}
        </div>
      )}

      {/* Controls */}
      <div className="lcgm-controls">
        <div className="lcgm-hours-row">
          {HOUR_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`lcgm-hours-chip ${hours === opt.value ? 'active' : ''}`}
              onClick={() => setHours(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {!latestLive && (
          <button
            className={`lcgm-btn lcgm-btn-sync ${syncing ? 'loading' : ''}`}
            onClick={sync}
            disabled={syncing}
          >
            {syncing ? '↻ Syncing…' : '↻ Sync'}
          </button>
        )}
      </div>

      {/* Stats */}
      <StatsBar readings={readings} />

      {/* Reading list */}
      {readingsLoading ? (
        <Spinner />
      ) : grouped.length === 0 ? (
        <div className="lcgm-empty">
          No readings in the last {hours < 48 ? `${hours}h` : `${hours / 24} days`}.
          Try syncing or widening the time window.
        </div>
      ) : (
        <div className="lcgm-days">
          {grouped.map(({ date, readings: dayReadings }) => (
            <DaySection key={date} date={date} readings={dayReadings} />
          ))}
        </div>
      )}

      <p className="lcgm-footer">
        {readingCount.toLocaleString()} total readings ·{' '}
        last synced {status?.last_sync ? timeAgo(status.last_sync) : 'never'}
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── ROOT EXPORT ───────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LibreCGM — single entry point.
 *
 * Renders ConnectForm when the account isn't linked yet,
 * switches to ReadingsView permanently once connected.
 *
 * Wrap with <LibreProvider> from LibreContext.js.
 */
export default function LibreCGM() {
  const { connected, statusLoading } = useLibre();

  if (statusLoading) return <Spinner />;
  return connected ? <ReadingsView /> : <ConnectForm />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles — injected once at runtime (extract to LibreCGM.css if preferred)
// ─────────────────────────────────────────────────────────────────────────────

const CSS = `
/* ── LibreCGM shared ──────────────────────────────────────────────────────── */
.lcgm-root { max-width: 720px; margin: 0 auto; padding: 24px; font-family: system-ui, sans-serif; color: #1e293b; }
.lcgm-title { font-size: 1.4rem; font-weight: 700; margin: 0; }

/* Loading */
.lcgm-loading { display:flex; align-items:center; gap:10px; padding:40px; justify-content:center; color:#64748b; }
.lcgm-spinner { width:18px; height:18px; border:2px solid #e2e8f0; border-top-color:#6366f1; border-radius:50%; animation:lcgm-spin .7s linear infinite; flex-shrink:0; }
@keyframes lcgm-spin { to { transform:rotate(360deg); } }

/* Errors */
.lcgm-error-banner { background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:10px 14px; font-size:13px; color:#dc2626; margin-bottom:14px; }

/* ── Connect form ─────────────────────────────────────────────────────────── */
.lcgm-info-card { display:flex; gap:10px; background:#eef2ff; border:1px solid #c7d2fe; border-radius:10px; padding:14px; margin-bottom:20px; }
.lcgm-info-icon { font-size:18px; }
.lcgm-info-title { font-weight:700; font-size:13px; margin:0 0 4px; }
.lcgm-info-text { font-size:12px; color:#475569; line-height:1.5; margin:0; }

.lcgm-form { background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:20px; margin-bottom:16px; }

.lcgm-field { margin-bottom:16px; }
.lcgm-label { display:block; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:#64748b; margin-bottom:6px; }
.lcgm-input { width:100%; padding:10px 13px; border:1px solid #cbd5e1; border-radius:8px; font-size:15px; color:#1e293b; background:#fff; box-sizing:border-box; transition:border-color .15s; }
.lcgm-input:focus { outline:none; border-color:#6366f1; box-shadow:0 0 0 3px rgba(99,102,241,.12); }
.lcgm-input:disabled { opacity:.5; background:#f8fafc; }
.lcgm-hint { font-size:11px; color:#94a3b8; margin-top:4px; display:block; }

.lcgm-password-row { display:flex; gap:8px; align-items:center; }
.lcgm-password-row .lcgm-input { flex:1; }
.lcgm-show-hide { padding:10px 13px; border:1px solid #cbd5e1; border-radius:8px; background:#f8fafc; font-size:13px; font-weight:600; color:#6366f1; cursor:pointer; white-space:nowrap; }

.lcgm-region-row { display:flex; flex-wrap:wrap; gap:6px; margin-top:4px; }
.lcgm-region-chip { padding:5px 12px; border-radius:6px; border:1px solid #cbd5e1; background:#f8fafc; font-size:12px; font-weight:600; color:#64748b; cursor:pointer; transition:all .15s; }
.lcgm-region-chip.active { background:#eef2ff; border-color:#6366f1; color:#6366f1; }
.lcgm-region-chip:hover:not(.active):not(:disabled) { border-color:#94a3b8; }

.lcgm-privacy { font-size:11px; color:#94a3b8; text-align:center; line-height:1.5; }

/* ── Readings view ────────────────────────────────────────────────────────── */
.lcgm-readings-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
.lcgm-manage-btn { font-size:13px; padding:6px 12px; }

/* Live card */
.lcgm-live-card { display:flex; align-items:center; justify-content:space-between; background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:16px 20px; margin-bottom:16px; }
.lcgm-live-left { display:flex; flex-direction:column; gap:2px; }
.lcgm-live-label { font-size:11px; text-transform:uppercase; letter-spacing:.05em; font-weight:600; color:#64748b; }
.lcgm-live-value-row { display:flex; align-items:baseline; gap:6px; }
.lcgm-live-value { font-size:2rem; font-weight:800; line-height:1; }
.lcgm-live-unit { font-size:13px; color:#64748b; }
.lcgm-live-arrow { font-size:1.4rem; font-weight:700; }
.lcgm-live-time { font-size:12px; color:#94a3b8; }

/* Controls */
.lcgm-controls { display:flex; align-items:center; gap:12px; margin-bottom:14px; flex-wrap:wrap; }
.lcgm-hours-row { display:flex; gap:6px; }
.lcgm-hours-chip { padding:6px 13px; border-radius:20px; border:1px solid #cbd5e1; background:#f8fafc; font-size:13px; font-weight:600; color:#64748b; cursor:pointer; transition:all .15s; }
.lcgm-hours-chip.active { background:#eef2ff; border-color:#6366f1; color:#6366f1; }
.lcgm-hours-chip:hover:not(.active) { border-color:#94a3b8; }

/* Stats */
.lcgm-stats-bar { display:flex; border:1px solid #e2e8f0; border-radius:12px; overflow:hidden; margin-bottom:16px; }
.lcgm-stat-item { flex:1; display:flex; flex-direction:column; align-items:center; padding:10px 8px; border-right:1px solid #e2e8f0; background:#fff; }
.lcgm-stat-item:last-child { border-right:none; }
.lcgm-stat-label { font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:#94a3b8; font-weight:600; }
.lcgm-stat-value { font-size:15px; font-weight:700; color:#1e293b; }

/* Sync toast */
.lcgm-sync-toast { background:#f0fdf4; border:1px solid #bbf7d0; color:#16a34a; font-size:13px; font-weight:600; padding:8px 14px; border-radius:8px; margin-bottom:12px; }

/* Day sections */
.lcgm-days { display:flex; flex-direction:column; gap:12px; }
.lcgm-day-section { border:1px solid #e2e8f0; border-radius:10px; overflow:hidden; }
.lcgm-day-header { display:flex; align-items:center; gap:8px; width:100%; padding:11px 14px; background:#f8fafc; border:none; cursor:pointer; text-align:left; }
.lcgm-day-header:hover { background:#f1f5f9; }
.lcgm-day-label { font-size:13px; font-weight:700; color:#1e293b; flex:1; }
.lcgm-day-count { font-size:11px; color:#94a3b8; }
.lcgm-day-toggle { font-size:11px; color:#94a3b8; margin-left:6px; }

/* Table */
.lcgm-table { width:100%; border-collapse:collapse; }
.lcgm-th { padding:7px 12px; font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:#94a3b8; font-weight:600; text-align:left; border-bottom:1px solid #f1f5f9; background:#fff; }
.lcgm-row:hover td { background:#fafafa; }
.lcgm-cell { padding:9px 12px; font-size:14px; color:#374151; border-bottom:1px solid #f8fafc; }
.lcgm-cell-time { color:#64748b; font-size:13px; white-space:nowrap; }
.lcgm-unit { font-size:11px; color:#94a3b8; margin-left:2px; }
.lcgm-cell-trend { display:flex; align-items:center; gap:6px; }
.lcgm-trend-label { font-size:11px; color:#94a3b8; }
.lcgm-cell-type { min-width:70px; }
.lcgm-status-pill { display:inline-block; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:700; }
.lcgm-status-normal { background:rgba(34,197,94,.10); color:#16a34a; }
.lcgm-status-low    { background:rgba(239,68,68,.10);  color:#dc2626; }
.lcgm-status-high   { background:rgba(249,115,22,.10); color:#ea580c; }
.lcgm-type-badge { display:inline-block; padding:2px 7px; border-radius:8px; font-size:10px; font-weight:600; background:#f1f5f9; color:#64748b; }

/* Connection drawer */
.lcgm-drawer { background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:20px; margin-bottom:16px; }
.lcgm-drawer-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
.lcgm-drawer-title { font-size:14px; font-weight:700; color:#1e293b; }
.lcgm-drawer-close { background:none; border:none; font-size:16px; color:#94a3b8; cursor:pointer; padding:2px 6px; }
.lcgm-meta-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px 24px; margin-bottom:16px; }
.lcgm-meta-item { display:flex; flex-direction:column; gap:2px; }
.lcgm-meta-label { font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:#64748b; font-weight:600; }
.lcgm-meta-value { font-size:14px; font-weight:600; color:#1e293b; }
.lcgm-settings-row { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:16px; font-size:13px; color:#374151; }
.lcgm-settings-label { display:flex; align-items:center; gap:6px; cursor:pointer; }
.lcgm-select { padding:4px 8px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; color:#374151; }

/* Shared buttons */
.lcgm-btn { display:inline-flex; align-items:center; justify-content:center; padding:9px 18px; border-radius:8px; font-size:14px; font-weight:700; cursor:pointer; border:none; transition:opacity .15s; }
.lcgm-btn:disabled, .lcgm-btn.loading { opacity:.55; cursor:not-allowed; }
.lcgm-btn-primary { background:#6366f1; color:#fff; width:100%; padding:13px; font-size:15px; margin-top:4px; }
.lcgm-btn-primary:hover:not(:disabled) { background:#4f46e5; }
.lcgm-btn-danger { background:#ef4444; color:#fff; width:100%; margin-bottom:8px; }
.lcgm-btn-danger:hover:not(:disabled) { background:#dc2626; }
.lcgm-btn-ghost { background:transparent; color:#64748b; font-weight:500; }
.lcgm-btn-ghost:hover:not(:disabled) { color:#1e293b; }
.lcgm-btn-sync { background:#f1f5f9; color:#374151; border:1px solid #e2e8f0; }
.lcgm-btn-sync:hover:not(:disabled) { background:#e2e8f0; }

/* Misc */
.lcgm-empty { text-align:center; padding:40px; color:#94a3b8; font-size:14px; }
.lcgm-footer { font-size:11px; color:#94a3b8; text-align:center; margin-top:16px; }
`;

if (typeof document !== 'undefined' && !document.getElementById('lcgm-styles')) {
  const style = document.createElement('style');
  style.id = 'lcgm-styles';
  style.textContent = CSS;
  document.head.appendChild(style);
}