import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import API_BASE_URL from '../config';
import {
  summarizeManifest,
  perPatientRows,
  zeroFetchedWarnings,
  insulinDedupWarning,
  toSnapshotListRow,
  CANONICAL_STREAMS,
} from '../utils/cohortQuality';
import './Charts/clinical-validation.css';

/**
 * The table the pre-ML audit says to read before training anything.
 *
 * `scripts/measure_drop_rates.py` and `diatwin/ml/export.py` have produced
 * this accounting since they were written; until now it only existed as
 * terminal output. `GET /api/ml/snapshots/<id>/manifest` serves the same
 * `manifest.json` those tools already write — nothing here computes a new
 * number, it renders the one that already exists.
 *
 * Restricted to admins in the API, because a snapshot names every patient in
 * the cohort rather than one doctor's own. This component does not attempt to
 * hide behind that — a non-admin viewer sees the 403 as a message, not a
 * disguised empty state.
 *
 * The audit's finding (§4) is the reason this exists at all: a stream's drop
 * rate can read a perfect 0.00% because nothing was ever converted into it,
 * which is the most dangerous reading a quality metric can give. That is why
 * `zeroFetchedWarnings` — a stream with nothing fetched cohort-wide — is
 * rendered ahead of the drop-rate table rather than folded into it.
 */

const fmtPct = (rate) => (rate === null ? '—' : `${(rate * 100).toFixed(2)}%`);
const fmtInt = (n) => (n === null || n === undefined ? '—' : n.toLocaleString());

const CohortQualityView = () => {
  const [snapshots, setSnapshots] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [listState, setListState] = useState('loading'); // loading | ok | forbidden | error
  const [manifestState, setManifestState] = useState('idle'); // idle | loading | ok | error
  const [errorMessage, setErrorMessage] = useState(null);

  const fetchSnapshots = useCallback(async () => {
    setListState('loading');
    try {
      const token = localStorage.getItem('token');
      if (!token) throw new Error('Authentication token not found');

      const response = await axios.get(`${API_BASE_URL}/api/ml/snapshots`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const rows = (response.data?.snapshots || []).map(toSnapshotListRow);
      setSnapshots(rows);
      setListState('ok');
      if (rows.length && !rows[0].error) setSelectedId(rows[rows.length - 1].snapshotId);
    } catch (err) {
      if (err.response?.status === 403) {
        setListState('forbidden');
      } else {
        setErrorMessage(err.response?.data?.message || err.message || 'Failed to load snapshots');
        setListState('error');
      }
    }
  }, []);

  useEffect(() => { fetchSnapshots(); }, [fetchSnapshots]);

  useEffect(() => {
    if (!selectedId) return undefined;
    let cancelled = false;

    (async () => {
      setManifestState('loading');
      try {
        const token = localStorage.getItem('token');
        const response = await axios.get(
          `${API_BASE_URL}/api/ml/snapshots/${selectedId}/manifest`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (cancelled) return;
        setManifest(response.data?.manifest ?? null);
        setManifestState('ok');
      } catch (err) {
        if (cancelled) return;
        setErrorMessage(err.response?.data?.message || err.message || 'Failed to load manifest');
        setManifestState('error');
      }
    })();

    return () => { cancelled = true; };
  }, [selectedId]);

  const summary = useMemo(() => (manifest ? summarizeManifest(manifest) : null), [manifest]);
  const patientRows = useMemo(() => (manifest ? perPatientRows(manifest) : []), [manifest]);
  const zeroWarnings = useMemo(
    () => (summary ? zeroFetchedWarnings(summary.streams) : []),
    [summary],
  );
  const dedupWarning = useMemo(
    () => (summary ? insulinDedupWarning(summary.streams, summary.insulinDeduped) : null),
    [summary],
  );

  if (listState === 'loading') {
    return <div className="viz-loading">Loading available snapshots…</div>;
  }

  if (listState === 'forbidden') {
    return (
      <div className="viz-empty">
        <p>Cohort quality is visible to admin accounts only.</p>
        <p className="viz-note">
          A snapshot names every patient in the cohort, not only the ones a
          given doctor is authorized for.
        </p>
      </div>
    );
  }

  if (listState === 'error') {
    return <div className="viz-error">Could not load snapshots: {errorMessage}</div>;
  }

  if (snapshots.length === 0) {
    return (
      <div className="viz-empty">
        <p>No snapshot has been exported yet.</p>
        <p className="viz-note">
          Snapshots are written by <code>diatwin/ml/export.py</code>. This
          deployment&rsquo;s database holds no clinical data to export from —
          see the pre-ML audit for the AZT1D cohort numbers this view is built
          to show once a real snapshot exists.
        </p>
      </div>
    );
  }

  return (
    <div className="viz-container cohort-quality-view">
      <header className="viz-header">
        <h3>Cohort data quality</h3>
        <p className="viz-subtitle">
          What was fetched, kept and dropped on the way into a training
          snapshot — the artifact to read before training anything, not the
          drop rate alone.
        </p>
      </header>

      <div className="viz-stat-row">
        <div className="viz-stat">
          <label htmlFor="cqv-snapshot-select" className="viz-stat-label">
            Snapshot
          </label>
          <select
            id="cqv-snapshot-select"
            value={selectedId || ''}
            onChange={(e) => setSelectedId(e.target.value)}
            className="viz-time-range-select"
          >
            {snapshots.map((s) => (
              <option key={s.snapshotId} value={s.snapshotId} disabled={!!s.error}>
                {s.snapshotId}{s.error ? ' (unreadable)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {manifestState === 'loading' && (
        <div className="viz-loading">Loading snapshot manifest…</div>
      )}

      {manifestState === 'error' && (
        <div className="viz-error">Could not load this snapshot: {errorMessage}</div>
      )}

      {manifestState === 'ok' && summary && (
        <>
          <div className="viz-stat-row">
            <div className="viz-stat">
              <span className="viz-stat-value">{fmtInt(summary.patientCount)}</span>
              <span className="viz-stat-label">patients in snapshot</span>
            </div>
            <div className="viz-stat">
              <span className="viz-stat-value">{summary.createdAt ? summary.createdAt.slice(0, 10) : '—'}</span>
              <span className="viz-stat-label">created</span>
            </div>
            <div className="viz-stat">
              <span className="viz-stat-value">{summary.missingProfile.length}</span>
              <span className="viz-stat-label">patients with no constants profile</span>
            </div>
          </div>

          {zeroWarnings.length > 0 && (
            <div className="viz-error" role="alert">
              <strong>Stream{zeroWarnings.length === 1 ? '' : 's'} with zero rows fetched:</strong>
              <ul className="viz-note-list">
                {zeroWarnings.map((w) => (
                  <li key={w.stream}>{w.message}</li>
                ))}
              </ul>
            </div>
          )}

          {dedupWarning && (
            <div className="viz-warning-block">
              {dedupWarning.message}
            </div>
          )}

          <div className="viz-table-wrap">
            <h4>Cohort totals by stream</h4>
            <table className="viz-table">
              <thead>
                <tr>
                  <th>Stream</th>
                  <th>Fetched</th>
                  <th>Kept</th>
                  <th>Dropped (normalize)</th>
                  <th>Dropped (window)</th>
                  <th>Fail rate</th>
                </tr>
              </thead>
              <tbody>
                {CANONICAL_STREAMS.map((name) => {
                  const s = summary.streams[name];
                  const isZero = s.fetched === 0;
                  return (
                    <tr key={name} className={isZero ? 'viz-row-warning' : undefined}>
                      <td>{name}</td>
                      <td>{fmtInt(s.fetched)}</td>
                      <td>{fmtInt(s.kept)}</td>
                      <td>{fmtInt(s.droppedNormalize)}</td>
                      <td>{fmtInt(s.droppedWindow)}</td>
                      <td>{fmtPct(s.failRate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="viz-note">
              A fail rate at or near 0% is meaningful on its own only for
              glucose. For meals and activity a high rate is normal and
              by-design (zero-carb meals and sedentary rows are refused
              deliberately) — see the pre-ML audit §4 before reading a high
              number here as a problem.
            </p>
          </div>

          <div className="viz-table-wrap">
            <h4>Per-patient breakdown</h4>
            <table className="viz-table">
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>Profile</th>
                  {CANONICAL_STREAMS.map((name) => (
                    <th key={name}>{name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {patientRows.map((row) => (
                  <tr key={row.patientId}>
                    <td>{row.patientId}</td>
                    <td className={row.profileFound ? undefined : 'viz-delta-over'}>
                      {row.profileFound ? 'ok' : 'missing'}
                    </td>
                    {CANONICAL_STREAMS.map((name) => {
                      const s = row.streams[name];
                      return (
                        <td key={name} className={s.fetched === 0 ? 'viz-delta-over' : undefined}>
                          {fmtInt(s.fetched)} / {fmtInt(s.kept)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="viz-note">fetched / kept, per stream.</p>
          </div>

          <footer className="viz-provenance">
            <span>snapshot: <code>{summary.snapshotId}</code></span>
            {summary.contentHash && (
              <span>{' '}· content hash <code>{summary.contentHash.slice(0, 12)}</code></span>
            )}
            {summary.span.from && summary.span.to && (
              <span>{' '}· data span {summary.span.from.slice(0, 10)} to {summary.span.to.slice(0, 10)}</span>
            )}
          </footer>
        </>
      )}
    </div>
  );
};

export default CohortQualityView;
