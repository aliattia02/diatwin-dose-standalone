import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Cell,
} from 'recharts';
import API_BASE_URL from '../config';
import TimeManager from '../utils/TimeManager';
import {
  toSuggestionRecords,
  summarizeDisagreement,
  toTimeSeries,
  DISPOSITION,
  RULES_ENGINE_PRODUCER,
} from '../utils/suggestionReview';
import './Charts/clinical-validation.css';

/**
 * Where the patient disagreed with the algorithm.
 *
 * `suggestedInsulin` is what the rules engine proposed; `intendedInsulin` is
 * what was actually taken. `diatwin/data/schema.py:113` calls that pair "the
 * behavioural-cloning target and the single most valuable column for the later
 * RL step". Both are already returned by the meal endpoints and nothing
 * displayed them until now.
 *
 * Built against the rules engine deliberately. There is no model yet —
 * `diatwin/ml/` holds one file — and this is the surface a learned model plugs
 * into unchanged when there is one: same contract, same views, same
 * disagreement arithmetic, a different `provenance.producer`. See
 * `docs/engineering/2026-09-05-suggestion-review-contract.md`.
 *
 * All arithmetic lives in `utils/suggestionReview.js` so it can be tested
 * without a DOM. This file fetches and draws.
 */

const RANGE_HOURS = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };

/** Enough rows to fill a 30-day window for a patient logging every meal. */
const FETCH_LIMIT = 500;

const fmt = (n, digits = 2) =>
  (n === null || n === undefined ? '—' : Number(n).toFixed(digits));

const fmtSigned = (n, digits = 2) => {
  if (n === null || n === undefined) return '—';
  const s = Number(n).toFixed(digits);
  return Number(n) > 0 ? `+${s}` : s;
};

const InsulinDisagreementView = ({
  patientId = null,
  isDoctor = false,
  timeRange = '7d',
  refreshTrigger = 0,
  tolerance = 0.5,
}) => {
  const [meals, setMeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // The PATIENT's offset, not the viewer's. Null until it is known, which is
  // not the same as 0 — see the timezone note below.
  const [tzOffsetMinutes, setTzOffsetMinutes] = useState(null);

  const fetchMeals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('token');
      if (!token) throw new Error('Authentication token not found');

      const url = (isDoctor && patientId)
        ? `${API_BASE_URL}/api/doctor/meal-history/${patientId}`
        : `${API_BASE_URL}/api/meals`;

      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        params: { skip: 0, limit: FETCH_LIMIT },
      });

      setMeals(Array.isArray(response.data?.meals) ? response.data.meals : []);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to load meals');
      setMeals([]);
    } finally {
      setLoading(false);
    }
  }, [isDoctor, patientId]);

  /**
   * The patient's timezone offset, so every timestamp on this screen is
   * rendered in the patient's local clock rather than the clinician's.
   *
   * Without it a doctor in London reviewing a patient in Auckland sees that
   * patient's breakfast stamped 20:00 the previous day — the display-side form
   * of D24. `/api/doctor/patient/<id>/constants` did not return the field until
   * this session; it does now, and a client talking to an older backend simply
   * gets null here and falls back to the browser, which is the previous
   * behaviour rather than a crash.
   */
  const fetchTimezone = useCallback(async () => {
    if (!isDoctor || !patientId) {
      setTzOffsetMinutes(null);
      return;
    }
    try {
      const token = localStorage.getItem('token');
      if (!token) return;
      const response = await axios.get(
        `${API_BASE_URL}/api/doctor/patient/${patientId}/constants`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const offset = response.data?.constants?.timezone_offset_minutes;
      setTzOffsetMinutes(typeof offset === 'number' ? offset : null);
    } catch (err) {
      // A missing timezone is not worth failing the whole view over; the
      // provenance footer says which clock the timestamps are in.
      setTzOffsetMinutes(null);
    }
  }, [isDoctor, patientId]);

  useEffect(() => { fetchMeals(); }, [fetchMeals, refreshTrigger]);
  useEffect(() => { fetchTimezone(); }, [fetchTimezone, refreshTrigger]);

  /** Format an instant in the patient's clock, falling back to the browser's. */
  const at = useCallback(
    (t, format) => TimeManager.formatDateInZone(t, format, tzOffsetMinutes),
    [tzOffsetMinutes],
  );

  const { records, summary, series, windowStart } = useMemo(() => {
    const all = toSuggestionRecords(meals, { subjectId: patientId });

    // The window is applied here rather than in the query because the meal
    // endpoints page by skip/limit and take no date bound. Rows with no
    // parseable timestamp cannot be placed in a window and are excluded from
    // it rather than assumed recent — toTimeSeries reports how many.
    const hours = RANGE_HOURS[timeRange] ?? RANGE_HOURS['7d'];
    const start = Date.now() - hours * 3600 * 1000;
    const inWindow = all.filter((r) => r.decided_at !== null && r.decided_at >= start);

    return {
      records: inWindow,
      summary: summarizeDisagreement(inWindow, { tolerance }),
      series: toTimeSeries(inWindow),
      windowStart: start,
    };
  }, [meals, patientId, timeRange, tolerance]);

  const points = useMemo(
    () => series.points
      .filter((r) => r.disposition === DISPOSITION.REVIEWABLE)
      .map((r) => ({
        x: r.decided_at,
        y: r.delta,
        suggested: r.suggested,
        observed: r.observed,
        mealType: r.state.mealType,
      })),
    [series],
  );

  /** The rows a clinician should look at first: largest absolute override.
   *  Sorted by magnitude but displayed signed — the ordering is a convenience,
   *  the sign is the finding. */
  const largest = useMemo(
    () => records
      .filter((r) => r.disposition === DISPOSITION.REVIEWABLE && Math.abs(r.delta) > tolerance)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 10),
    [records, tolerance],
  );

  if (loading) {
    return <div className="viz-loading">Loading insulin decisions…</div>;
  }

  if (error) {
    return <div className="viz-error">Could not load insulin decisions: {error}</div>;
  }

  const c = summary.counts;

  return (
    <div className="viz-container insulin-disagreement-view">
      <header className="viz-header">
        <h3>Where the patient disagreed with the algorithm</h3>
        <p className="viz-subtitle">
          Insulin actually taken minus insulin suggested, per meal. Positive means
          the patient took <strong>more</strong> than suggested.
        </p>
      </header>

      {c.reviewable === 0 ? (
        <div className="viz-empty">
          <p>
            No meal in this window carries both a suggestion and a recorded dose,
            so there is nothing to compare.
          </p>
          <p className="viz-note">
            {c.total} meal{c.total === 1 ? '' : 's'} in window ·{' '}
            {c.pending} suggested but not acted on ·{' '}
            {c.unadvised} dosed without a suggestion ·{' '}
            {c.none} with no insulin decision
          </p>
        </div>
      ) : (
        <>
          <div className="viz-stat-row">
            <div className="viz-stat">
              <span className="viz-stat-value">{c.reviewable}</span>
              <span className="viz-stat-label">decisions compared</span>
            </div>
            <div className="viz-stat">
              <span className="viz-stat-value">
                {summary.direction.overrideRate === null
                  ? '—'
                  : `${(summary.direction.overrideRate * 100).toFixed(0)}%`}
              </span>
              <span className="viz-stat-label">
                overridden by more than {tolerance} U
              </span>
            </div>
            <div className="viz-stat">
              <span className="viz-stat-value">{fmtSigned(summary.signedMedianDelta)}</span>
              <span className="viz-stat-label">median difference (U)</span>
            </div>
            <div className="viz-stat">
              <span className="viz-stat-value">{fmtSigned(summary.signedMeanDelta)}</span>
              <span className="viz-stat-label">mean difference (U)</span>
            </div>
          </div>

          <div className="viz-stat-row viz-stat-row-secondary">
            <div className="viz-stat">
              <span className="viz-stat-value">{summary.direction.over}</span>
              <span className="viz-stat-label">
                took more (avg {fmtSigned(summary.meanOverBy)} U)
              </span>
            </div>
            <div className="viz-stat">
              <span className="viz-stat-value">{summary.direction.under}</span>
              <span className="viz-stat-label">
                took less (avg {fmtSigned(summary.meanUnderBy)} U)
              </span>
            </div>
            <div className="viz-stat">
              <span className="viz-stat-value">{summary.direction.within}</span>
              <span className="viz-stat-label">followed the suggestion</span>
            </div>
          </div>

          <ResponsiveContainer width="100%" height={320}>
            <ScatterChart margin={{ top: 16, right: 24, bottom: 24, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="x"
                type="number"
                domain={[windowStart, Date.now()]}
                name="time"
                tickFormatter={(t) => at(t, TimeManager.formats.CHART_TICKS_LONG)}
              />
              <YAxis
                dataKey="y"
                type="number"
                name="difference"
                label={{ value: 'taken − suggested (U)', angle: -90, position: 'insideLeft' }}
              />
              <ZAxis range={[60, 60]} />
              {/* Agreement is the line, not a band — the sign either side of it
                  is the clinical reading. */}
              <ReferenceLine y={0} stroke="#333" strokeWidth={1.5} />
              <ReferenceLine y={tolerance} stroke="#999" strokeDasharray="4 4" />
              <ReferenceLine y={-tolerance} stroke="#999" strokeDasharray="4 4" />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={({ payload }) => {
                  if (!payload || !payload.length) return null;
                  const p = payload[0].payload;
                  return (
                    <div className="viz-tooltip">
                      <div>{at(p.x, TimeManager.formats.CHART_TICKS_MEDIUM)}</div>
                      <div>{p.mealType || 'meal'}</div>
                      <div>suggested {fmt(p.suggested, 1)} U</div>
                      <div>taken {fmt(p.observed, 1)} U</div>
                      <div><strong>{fmtSigned(p.y, 1)} U</strong></div>
                    </div>
                  );
                }}
              />
              <Scatter data={points} fill="#8884d8">
                {points.map((p, i) => (
                  <Cell
                    key={`pt-${i}`}
                    fill={p.y > tolerance ? '#d9534f' : p.y < -tolerance ? '#4a90d9' : '#8a8a8a'}
                  />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>

          {largest.length > 0 && (
            <div className="viz-table-wrap">
              <h4>Largest overrides</h4>
              <table className="viz-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Meal</th>
                    <th>Suggested</th>
                    <th>Taken</th>
                    <th>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {largest.map((r) => (
                    <tr key={r.event_id || `${r.decided_at}-${r.delta}`}>
                      <td>{at(r.decided_at, TimeManager.formats.CHART_TICKS_MEDIUM)}</td>
                      <td>{r.state.mealType || '—'}</td>
                      <td>{fmt(r.suggested, 1)} U</td>
                      <td>{fmt(r.observed, 1)} U</td>
                      <td className={r.delta > 0 ? 'viz-delta-over' : 'viz-delta-under'}>
                        {fmtSigned(r.delta, 1)} U
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Contract rule 2 and rule 4: a displayed suggestion names what produced
          it and what data it came from. "live" is naming it. */}
      <footer className="viz-provenance">
        <span>
          Suggestions produced by <code>{RULES_ENGINE_PRODUCER}</code>
        </span>
        <span> · data: live (no snapshot)</span>
        <span>
          {' '}· times shown in{' '}
          {tzOffsetMinutes === null
            ? "this browser's timezone"
            : `the patient's timezone (UTC${tzOffsetMinutes >= 0 ? '+' : '-'}${
              String(Math.floor(Math.abs(tzOffsetMinutes) / 60)).padStart(2, '0')}:${
              String(Math.abs(tzOffsetMinutes) % 60).padStart(2, '0')})`}
        </span>
        {series.undateable > 0 && (
          <span className="viz-warning">
            {' '}· {series.undateable} record{series.undateable === 1 ? '' : 's'} had
            no usable timestamp and could not be placed in this window
          </span>
        )}
        <span>
          {' '}· a dose given outside a meal has no suggestion recorded against it
          and does not appear here
        </span>
      </footer>
    </div>
  );
};

export default InsulinDisagreementView;
