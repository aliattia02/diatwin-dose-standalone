import React, { useState } from 'react';
import InsulinDisagreementView from './InsulinDisagreementView';
import CohortQualityView from './CohortQualityView';
import { RULES_ENGINE_PRODUCER } from '../utils/suggestionReview';
import './Charts/clinical-validation.css';

/**
 * The clinician's review surface.
 *
 * This file was 0 bytes and was still imported and rendered as a tab labelled
 * "Clinical Validation Dashboard" by `PatientDashboard.js` — D25. The build was
 * green throughout, because webpack bundles an empty module happily; the
 * failure was deferred to whoever clicked the tab, where the empty module
 * reaches `React.createElement` and React rejects it with "Element type is
 * invalid". An empty file rendering as a named tab is worse than an absent
 * feature, and a *clinical validation* view is precisely what a review surface
 * needs, so it is implemented rather than removed.
 *
 * What it validates today is the **rules engine**, not a model, because there
 * is no model: `diatwin/ml/` contains one file, `export.py`, with no training
 * code, no artifact and no prediction endpoint. That is deliberate rather than
 * a placeholder. The suggestion review contract
 * (`docs/engineering/2026-09-05-suggestion-review-contract.md`) is written so a
 * learned model arrives as a second `provenance.producer` and this surface does
 * not change.
 *
 * Sections that would need a model — error grids, predicted-vs-actual,
 * calibration — are named below as absent rather than mocked up. A clinical
 * surface that shows a plausible-looking empty chart is worse than one that
 * says what it does not have.
 */

const TABS = [
  { id: 'disagreement', label: 'Algorithm vs. patient' },
  { id: 'cohort', label: 'Cohort data quality' },
  { id: 'provenance', label: 'What this is built on' },
];

const ClinicalValidationDashboard = ({
  patientId = null,
  isDoctor = false,
  timeRange: initialTimeRange = '7d',
  refreshTrigger = 0,
}) => {
  const [tab, setTab] = useState('disagreement');
  const [timeRange, setTimeRange] = useState(initialTimeRange);

  return (
    <div className="viz-container clinical-validation-dashboard">
      <header className="viz-header">
        <h2>Clinical validation</h2>
        <p className="viz-subtitle">
          Reviewing what the insulin suggestion engine proposed against what
          actually happened.
        </p>
      </header>

      <nav className="viz-tabbar" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'viz-tab viz-tab-active' : 'viz-tab'}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}

        {tab === 'disagreement' && (
          <select
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value)}
            className="viz-time-range-select"
            aria-label="Time range"
          >
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
        )}
      </nav>

      {tab === 'disagreement' && (
        <InsulinDisagreementView
          patientId={patientId}
          isDoctor={isDoctor}
          timeRange={timeRange}
          refreshTrigger={refreshTrigger}
        />
      )}

      {tab === 'cohort' && <CohortQualityView />}

      {tab === 'provenance' && (
        <section className="viz-provenance-panel">
          <h3>What produced the numbers on this screen</h3>
          <dl className="viz-definition-list">
            <dt>Producer</dt>
            <dd>
              <code>{RULES_ENGINE_PRODUCER}</code>
              <p className="viz-note">
                The rules-based suggestion engine. There is no trained model in
                this system yet, so nothing here is a machine-learning
                prediction.
              </p>
            </dd>

            <dt>Data</dt>
            <dd>
              Live, read from the meal records through the API.
              <p className="viz-note">
                Not a snapshot. When a view is computed from an immutable
                training snapshot it names that snapshot&rsquo;s id here
                instead, so a clinical claim can always name its data.
              </p>
            </dd>

            <dt>The comparison</dt>
            <dd>
              <code>intendedInsulin</code> (what was taken) minus{' '}
              <code>suggestedInsulin</code> (what was proposed), per meal,
              signed.
              <p className="viz-note">
                The sign is the finding: consistently taking more than suggested
                and consistently taking less are different clinical problems.
                Meals where either value is missing are counted separately and
                never treated as a zero.
              </p>
            </dd>
          </dl>

          <h3>What is not here yet</h3>
          <ul className="viz-note-list">
            <li>
              <strong>Error grids, predicted-vs-actual and calibration.</strong>{' '}
              These compare a model&rsquo;s predictions against measured
              glucose. There is no model to compare, so they are absent rather
              than shown empty.
            </li>
            <li>
              <strong>Doses given outside a meal.</strong> No suggestion is
              recorded against them, so they cannot appear in the comparison.
            </li>
          </ul>
        </section>
      )}
    </div>
  );
};

export default ClinicalValidationDashboard;
