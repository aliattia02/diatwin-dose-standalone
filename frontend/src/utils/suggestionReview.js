/**
 * The suggestion review contract, implemented.
 *
 * Turns meal documents into the reviewable objects described in
 * `docs/engineering/2026-09-05-suggestion-review-contract.md`, and summarises a
 * collection of them for a clinician.
 *
 * Why this is a plain module with no React in it: the arithmetic here is the
 * part a clinical claim rests on, and it should be testable without a DOM, a
 * chart library or a network. The component that renders it is a thin shell.
 *
 * The pair this module exists for is `suggestedInsulin` (what the rules engine
 * proposed, written by `backend/meal_insulin.py:795`) against `intendedInsulin`
 * (what the patient actually took). `diatwin/data/schema.py:113` calls it "the
 * behavioural-cloning target and the single most valuable column for the later
 * RL step: it is a logged record of where the patient disagreed with the
 * model." Nothing displayed it before this.
 *
 * When a learned model replaces the rules engine, `provenance.producer` is the
 * field that changes. Nothing else here does.
 */

/** The only producer there is today. There is no model yet — `diatwin/ml/`
 *  holds one file, `export.py`, and no training code or artifact. */
export const RULES_ENGINE_PRODUCER = 'rules:meal_insulin.calculate_suggested_insulin';

/** What a record's `observed`/`suggested` pair says happened. */
export const DISPOSITION = {
  /** Both present — the reviewable case. */
  REVIEWABLE: 'reviewable',
  /** A suggestion exists but nothing was taken yet, or nothing was recorded. */
  PENDING: 'pending',
  /** A dose was taken with no suggestion attached. */
  UNADVISED: 'unadvised',
  /** Neither — the meal carries no insulin decision at all. */
  NONE: 'none',
};

/**
 * Coerce a stored numeric field to a number or null.
 *
 * Deliberately strict about what counts as absent. `null` and `undefined` mean
 * "no decision was recorded", which the contract (§1.1) says must survive to
 * the display — it is not the same fact as a recorded zero, and rule 1 forbids
 * zero-filling it. An empty string is treated as absent for the same reason:
 * it is what an unfilled form field serialises to, not a dose of nothing.
 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Parse a stored timestamp to epoch milliseconds, or null if unparseable.
 *
 *  Never falls back to the current time — Arm 5 rule 5: "a bad row silently
 *  becoming the newest record on a timeline is worse than dropping it." */
function timestampOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * One meal document -> one suggestion review record.
 *
 * @param {object} meal   a meal as returned by /api/meals or
 *                        /api/doctor/meal-history/:id
 * @param {object} [opts] { producer, snapshotId, subjectId }
 */
export function toSuggestionRecord(meal, opts = {}) {
  const {
    producer = RULES_ENGINE_PRODUCER,
    snapshotId = null,
    subjectId = null,
  } = opts;

  const suggested = numberOrNull(meal?.suggestedInsulin);
  const observed = numberOrNull(meal?.intendedInsulin);

  // decided_at and observed_at are stored separately rather than derived from
  // one another (contract §1.2) — rule 6's leakage guard is stated in terms of
  // the difference between them. The meal document records one timestamp for
  // both today, so observed_at repeats it rather than inventing a second one;
  // when doses carry their own recorded time this is where it goes.
  const decidedAt = timestampOrNull(meal?.timestamp ?? meal?.mealTime);
  const observedAt = timestampOrNull(meal?.mealTime ?? meal?.timestamp);

  let disposition;
  if (suggested !== null && observed !== null) disposition = DISPOSITION.REVIEWABLE;
  else if (suggested !== null) disposition = DISPOSITION.PENDING;
  else if (observed !== null) disposition = DISPOSITION.UNADVISED;
  else disposition = DISPOSITION.NONE;

  return {
    subject_id: subjectId,
    event_id: meal?.id ?? meal?._id ?? null,
    kind: 'insulin_units',

    suggested,
    observed,
    unit: 'U',

    // Signed, always (contract rule 1). The direction is the clinical finding:
    // systematic under-dosing and systematic over-dosing are different problems.
    // null whenever either side is missing — not 0.
    delta: disposition === DISPOSITION.REVIEWABLE ? observed - suggested : null,
    disposition,

    decided_at: decidedAt,
    observed_at: observedAt,

    state: {
      mealType: meal?.mealType ?? null,
      bloodSugar: numberOrNull(meal?.bloodSugar),
      nutrition: meal?.nutrition ?? null,
      activities: meal?.activities ?? [],
      insulinCalculation: meal?.insulinCalculation ?? null,
    },

    provenance: {
      producer: producer || 'unknown',
      version: null,
      snapshot_id: snapshotId,
    },
  };
}

/** Map a list of meals to records, dropping nothing. */
export function toSuggestionRecords(meals, opts = {}) {
  if (!Array.isArray(meals)) return [];
  return meals.map((m) => toSuggestionRecord(m, opts));
}

/**
 * Summarise a set of records for a clinician.
 *
 * Everything here is computed from the records passed in, never from a stored
 * aggregate (contract §3): a pre-aggregated mean cannot be checked against the
 * window it was computed over, which makes the leakage rule unverifiable.
 *
 * `tolerance` is the dose difference below which a disagreement is not treated
 * as one. It exists because insulin is dosed in half-unit steps on most pens,
 * so a 0.2 U difference is rounding, not a decision. It is a display parameter
 * and is reported back in the result so a reader knows what produced the split.
 */
export function summarizeDisagreement(records, { tolerance = 0.5 } = {}) {
  const all = Array.isArray(records) ? records : [];

  const reviewable = all.filter((r) => r.disposition === DISPOSITION.REVIEWABLE);
  const pending = all.filter((r) => r.disposition === DISPOSITION.PENDING);
  const unadvised = all.filter((r) => r.disposition === DISPOSITION.UNADVISED);
  const none = all.filter((r) => r.disposition === DISPOSITION.NONE);

  const deltas = reviewable.map((r) => r.delta);

  // A dose above the suggestion and a dose below it are separate findings, so
  // they are counted separately rather than folded into one magnitude.
  const over = deltas.filter((d) => d > tolerance);
  const under = deltas.filter((d) => d < -tolerance);
  const within = deltas.filter((d) => Math.abs(d) <= tolerance);

  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  /** Median rather than mean for the headline, because a single mistyped dose
   *  moves a mean over a small cohort and a clinician reads the headline. */
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  return {
    tolerance,

    counts: {
      total: all.length,
      reviewable: reviewable.length,
      pending: pending.length,
      unadvised: unadvised.length,
      none: none.length,
    },

    // Signed. Positive means the patient took MORE than suggested.
    signedMeanDelta: mean(deltas),
    signedMedianDelta: median(deltas),

    direction: {
      over: over.length,
      under: under.length,
      within: within.length,
      // The share of reviewable decisions where the patient overrode the
      // engine at all. null rather than 0 when there is nothing to divide by:
      // "no data" and "never overrode" are different answers.
      overrideRate: reviewable.length
        ? (over.length + under.length) / reviewable.length
        : null,
    },

    // Reported so a reader can see the spread behind the headline rather than
    // only its centre.
    meanOverBy: mean(over),
    meanUnderBy: mean(under),

    totalSuggested: reviewable.reduce((a, r) => a + r.suggested, 0),
    totalObserved: reviewable.reduce((a, r) => a + r.observed, 0),
  };
}

/**
 * Records ordered oldest-first for plotting.
 *
 * Records with no `decided_at` cannot be placed on a time axis and are returned
 * separately rather than dropped silently or bunched at the epoch — a row the
 * chart cannot show is a fact about the data, and the caller is told the count
 * so it can say so.
 */
export function toTimeSeries(records) {
  const all = Array.isArray(records) ? records : [];
  const placeable = all.filter((r) => r.decided_at !== null);
  const undateable = all.length - placeable.length;
  return {
    points: [...placeable].sort((a, b) => a.decided_at - b.decided_at),
    undateable,
  };
}
