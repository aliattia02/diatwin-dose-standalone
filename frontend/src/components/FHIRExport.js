// frontend/src/components/FHIRExport.js
// FHIR R4 Export + GDPR Delete panel
// Drop inside ImportExport.js or PatientDashboard.js

import React, { useState } from 'react';

const API_BASE = process.env.REACT_APP_API_URL || '';

// ─── helper ──────────────────────────────────────────────────────────────────
function authHeaders() {
  const token = localStorage.getItem('token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// ─── FHIR Export Panel ────────────────────────────────────────────────────────
function FHIRExportPanel() {
  const [days, setDays]       = useState(30);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [meta, setMeta]       = useState(null);   // entry counts after export

  async function handleExport() {
    if (days < 1 || days > 90) {
      setError('Days must be between 1 and 90.');
      return;
    }
    setLoading(true);
    setError('');
    setMeta(null);

    try {
      const res = await fetch(`${API_BASE}/api/export/fhir?days=${days}`, {
        headers: authHeaders(),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      // Read entry count from header before consuming body
      const entryCount = res.headers.get('X-DiaTwin-Entry-Count') || '?';
      const pseudonym  = res.headers.get('X-DiaTwin-Pseudonymized') === 'true';

      const blob     = await res.blob();
      const url      = URL.createObjectURL(blob);
      const anchor   = document.createElement('a');
      const today    = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      anchor.href     = url;
      anchor.download = `diatwin_fhir_r4_${today}.json`;
      anchor.click();
      URL.revokeObjectURL(url);

      setMeta({ entryCount, pseudonym });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.card}>
      <div style={styles.headerRow}>
        <span style={styles.fhirBadge}>FHIR R4</span>
        <h3 style={styles.cardTitle}>Clinical Data Export</h3>
      </div>

      <p style={styles.subtitle}>
        Export your data as a FHIR R4 Bundle — pseudonymised identifiers
        compatible with <strong>MII Treuhandstelle</strong> workflows.
      </p>

      <div style={styles.row}>
        <label style={styles.label}>Look-back window</label>
        <div style={styles.daysRow}>
          {[7, 14, 30, 60, 90].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              style={d === days ? styles.dayBtnActive : styles.dayBtn}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div style={styles.infoBox}>
        <span style={styles.infoIcon}>🔒</span>
        <span>
          Export uses <strong>pseudonymised</strong> identifiers.
          No name, email, or personal identifiers are included.
        </span>
      </div>

      <div style={styles.loincRow}>
        <span style={styles.loincTag}>LOINC 15074-8 · Blood Glucose</span>
        <span style={styles.loincTag}>SNOMED 67866001 · Insulin</span>
        <span style={styles.loincTag}>LOINC 9059-7 · Carb Intake</span>
      </div>

      {error && <p style={styles.errorText}>{error}</p>}

      {meta && (
        <p style={styles.successText}>
          ✓ Exported {meta.entryCount} FHIR entries · Pseudonymised: {meta.pseudonym ? 'Yes' : 'No'}
        </p>
      )}

      <button
        onClick={handleExport}
        disabled={loading}
        style={loading ? styles.btnDisabled : styles.btn}
      >
        {loading ? 'Generating…' : `Download FHIR Bundle (${days} days)`}
      </button>
    </div>
  );
}

// ─── GDPR Delete Panel ────────────────────────────────────────────────────────
function GDPRDeletePanel() {
  const [phase, setPhase]         = useState('idle');   // idle | confirm_data | confirm_account | deleting | done
  const [deleteType, setDeleteType] = useState(null);   // 'data' | 'account'
  const [result, setResult]       = useState(null);
  const [error, setError]         = useState('');

  function startDelete(type) {
    setDeleteType(type);
    setPhase(type === 'data' ? 'confirm_data' : 'confirm_account');
    setError('');
  }

  async function confirmDelete() {
    setPhase('deleting');
    setError('');
    try {
      const endpoint = deleteType === 'account'
        ? '/api/patient/account'
        : '/api/patient/data';
      const confirmText = deleteType === 'account'
        ? 'DELETE MY ACCOUNT'
        : 'DELETE MY DATA';

      const res = await fetch(`${API_BASE}${endpoint}`, {
        method:  'DELETE',
        headers: authHeaders(),
        body:    JSON.stringify({ confirm: confirmText }),
      });

      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

      setResult(body);
      setPhase('done');

      // If account deleted, sign out after 3 seconds
      if (deleteType === 'account') {
        setTimeout(() => {
          localStorage.clear();
          window.location.href = '/';
        }, 3000);
      }
    } catch (err) {
      setError(err.message);
      setPhase('idle');
    }
  }

  if (phase === 'done') {
    return (
      <div style={styles.card}>
        <p style={styles.successText}>
          ✓ {result?.message}
        </p>
        {result?.deleted_at && (
          <p style={styles.metaText}>
            Deleted at: {new Date(result.deleted_at).toLocaleString()}
            &nbsp;·&nbsp;GDPR {result.gdpr_article}
          </p>
        )}
        {deleteType === 'account' && (
          <p style={styles.metaText}>Redirecting to sign-in…</p>
        )}
      </div>
    );
  }

  if (phase === 'confirm_data' || phase === 'confirm_account') {
    const isAccount = phase === 'confirm_account';
    return (
      <div style={{ ...styles.card, borderColor: '#ef4444' }}>
        <h3 style={{ ...styles.cardTitle, color: '#ef4444' }}>
          {isAccount ? '⚠️ Delete Account' : '⚠️ Delete All Medical Data'}
        </h3>
        <p style={styles.warningText}>
          {isAccount
            ? 'This will permanently delete ALL your medical data AND your account. This cannot be undone.'
            : 'This will permanently delete all your blood glucose, meal, insulin, and activity data. Your account login will remain active.'}
        </p>
        {error && <p style={styles.errorText}>{error}</p>}
        <div style={styles.confirmRow}>
          <button
            onClick={() => setPhase('idle')}
            style={styles.cancelBtn}
          >
            Cancel
          </button>
          <button
            onClick={confirmDelete}
            style={styles.deleteBtn}
            disabled={phase === 'deleting'}
          >
            {phase === 'deleting' ? 'Deleting…' : 'Yes, delete permanently'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.card}>
      <div style={styles.headerRow}>
        <span style={styles.gdprBadge}>GDPR Art. 17</span>
        <h3 style={styles.cardTitle}>Right to Erasure</h3>
      </div>
      <p style={styles.subtitle}>
        Under GDPR Article 17, you have the right to have your personal data
        erased.
      </p>
      {error && <p style={styles.errorText}>{error}</p>}
      <div style={styles.gdprRow}>
        <button onClick={() => startDelete('data')} style={styles.softDeleteBtn}>
          🗑 Delete all medical data
          <span style={styles.btnSub}>Keep account active</span>
        </button>
        <button onClick={() => startDelete('account')} style={styles.hardDeleteBtn}>
          ✕ Delete account & all data
          <span style={styles.btnSub}>Permanent — cannot undo</span>
        </button>
      </div>
    </div>
  );
}

// ─── Combined export ──────────────────────────────────────────────────────────
export default function FHIRExport() {
  return (
    <div style={styles.wrapper}>
      <FHIRExportPanel />
      <GDPRDeletePanel />
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = {
  wrapper:      { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 },
  card:         { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,.07)' },
  headerRow:    { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
  cardTitle:    { margin: 0, fontSize: 16, fontWeight: 600, color: '#111' },
  subtitle:     { margin: '0 0 14px', fontSize: 13, color: '#6b7280', lineHeight: 1.5 },
  fhirBadge:    { background: '#dbeafe', color: '#1d4ed8', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4 },
  gdprBadge:    { background: '#fef3c7', color: '#92400e', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4 },
  row:          { marginBottom: 12 },
  label:        { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 },
  daysRow:      { display: 'flex', gap: 6 },
  dayBtn:       { padding: '4px 10px', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 5, background: '#f9fafb', cursor: 'pointer', color: '#374151' },
  dayBtnActive: { padding: '4px 10px', fontSize: 12, border: '1px solid #2563eb', borderRadius: 5, background: '#2563eb', cursor: 'pointer', color: '#fff', fontWeight: 600 },
  infoBox:      { display: 'flex', alignItems: 'flex-start', gap: 8, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: '8px 12px', marginBottom: 10, fontSize: 12, color: '#166534' },
  infoIcon:     { fontSize: 14, flexShrink: 0 },
  loincRow:     { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 },
  loincTag:     { fontSize: 10, background: '#f1f5f9', color: '#475569', padding: '2px 7px', borderRadius: 3, fontFamily: 'monospace' },
  btn:          { width: '100%', padding: '10px 0', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  btnDisabled:  { width: '100%', padding: '10px 0', background: '#93c5fd', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 14, cursor: 'not-allowed' },
  errorText:    { color: '#dc2626', fontSize: 12, margin: '6px 0' },
  successText:  { color: '#16a34a', fontSize: 13, margin: '6px 0', fontWeight: 500 },
  metaText:     { color: '#6b7280', fontSize: 12, margin: '4px 0' },
  warningText:  { color: '#374151', fontSize: 13, lineHeight: 1.5, margin: '0 0 14px' },
  confirmRow:   { display: 'flex', gap: 10 },
  cancelBtn:    { flex: 1, padding: '9px 0', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 7, fontWeight: 500, fontSize: 13, cursor: 'pointer', color: '#374151' },
  deleteBtn:    { flex: 1, padding: '9px 0', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  gdprRow:      { display: 'flex', flexDirection: 'column', gap: 8 },
  softDeleteBtn:{ display: 'flex', flexDirection: 'column', padding: '10px 14px', background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 7, cursor: 'pointer', textAlign: 'left', fontSize: 13, fontWeight: 600, color: '#713f12' },
  hardDeleteBtn:{ display: 'flex', flexDirection: 'column', padding: '10px 14px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 7, cursor: 'pointer', textAlign: 'left', fontSize: 13, fontWeight: 600, color: '#991b1b' },
  btnSub:       { fontSize: 11, fontWeight: 400, color: '#9ca3af', marginTop: 2 },
};
