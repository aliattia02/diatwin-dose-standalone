/**
 * The suggestion review contract, as executable rules.
 *
 * `docs/engineering/2026-09-05-suggestion-review-contract.md` §4 states four
 * rules. Three of them are about what must *not* happen to the data on its way
 * to a clinician, and those are the ones tested hardest here — a view that
 * quietly turns a missing decision into a zero, or a signed disagreement into a
 * magnitude, still renders, still looks plausible, and is wrong in a way no
 * screenshot shows.
 */

import {
  toSuggestionRecord,
  toSuggestionRecords,
  summarizeDisagreement,
  toTimeSeries,
  DISPOSITION,
  RULES_ENGINE_PRODUCER,
} from '../utils/suggestionReview';

const T = (h) => new Date(Date.UTC(2026, 2, 1, h, 0, 0)).toISOString();

const meal = (over) => ({
  id: 'm1',
  mealType: 'lunch',
  timestamp: T(12),
  suggestedInsulin: 6,
  intendedInsulin: 6,
  nutrition: { carbs: 60 },
  insulinCalculation: { base: 5 },
  ...over,
});

// ---------------------------------------------------------------------------
// Rule 1 — sign and nulls survive to the display
// ---------------------------------------------------------------------------

describe('rule 1: the disagreement keeps its sign', () => {
  it('is positive when the patient took more than suggested', () => {
    const r = toSuggestionRecord(meal({ suggestedInsulin: 4, intendedInsulin: 6.5 }));
    expect(r.delta).toBeCloseTo(2.5, 10);
  });

  it('is negative when the patient took less', () => {
    const r = toSuggestionRecord(meal({ suggestedInsulin: 6.5, intendedInsulin: 4 }));
    expect(r.delta).toBeCloseTo(-2.5, 10);
  });

  it('never collapses opposite disagreements into the same summary', () => {
    // The failure this guards: taking an absolute value somewhere in the
    // pipeline. A cohort that splits evenly over and under would then look
    // identical to one that consistently over-doses, and the second is a
    // clinical finding while the first is noise.
    const consistentlyOver = toSuggestionRecords([
      meal({ id: 'a', suggestedInsulin: 4, intendedInsulin: 6 }),
      meal({ id: 'b', suggestedInsulin: 4, intendedInsulin: 6 }),
    ]);
    const evenlySplit = toSuggestionRecords([
      meal({ id: 'a', suggestedInsulin: 4, intendedInsulin: 6 }),
      meal({ id: 'b', suggestedInsulin: 6, intendedInsulin: 4 }),
    ]);

    expect(summarizeDisagreement(consistentlyOver).signedMeanDelta).toBeCloseTo(2, 10);
    expect(summarizeDisagreement(evenlySplit).signedMeanDelta).toBeCloseTo(0, 10);
  });
});

describe('rule 1: a missing decision stays missing', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
  ])('%s suggested is not read as 0', (_label, value) => {
    const r = toSuggestionRecord(meal({ suggestedInsulin: value }));
    expect(r.suggested).toBeNull();
    expect(r.disposition).toBe(DISPOSITION.UNADVISED);
    // The crucial half: no delta is invented from a zero that was never there.
    expect(r.delta).toBeNull();
  });

  it('a recorded zero is a real decision and is NOT treated as missing', () => {
    // The negative case. Zero units suggested is a genuine clinical output —
    // "no insulin for this meal" — and must not be swept in with absent data.
    const r = toSuggestionRecord(meal({ suggestedInsulin: 0, intendedInsulin: 0 }));
    expect(r.suggested).toBe(0);
    expect(r.observed).toBe(0);
    expect(r.disposition).toBe(DISPOSITION.REVIEWABLE);
    expect(r.delta).toBe(0);
  });

  it('separates pending, unadvised and none rather than dropping them', () => {
    const records = toSuggestionRecords([
      meal({ id: 'a', suggestedInsulin: 5, intendedInsulin: 5 }),
      meal({ id: 'b', suggestedInsulin: 5, intendedInsulin: null }),
      meal({ id: 'c', suggestedInsulin: null, intendedInsulin: 5 }),
      meal({ id: 'd', suggestedInsulin: null, intendedInsulin: null }),
    ]);

    const s = summarizeDisagreement(records);
    expect(s.counts).toEqual({
      total: 4, reviewable: 1, pending: 1, unadvised: 1, none: 1,
    });
    // Nothing was dropped on the way in.
    expect(records).toHaveLength(4);
  });

  it('reports no override rate at all when there is nothing to divide by', () => {
    // null, not 0: "we have no reviewable decisions" and "they never overrode"
    // are different answers and a clinician must be able to tell them apart.
    const s = summarizeDisagreement(toSuggestionRecords([
      meal({ suggestedInsulin: null, intendedInsulin: null }),
    ]));
    expect(s.direction.overrideRate).toBeNull();
    expect(s.signedMeanDelta).toBeNull();
    expect(s.signedMedianDelta).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — a displayed suggestion names its producer
// ---------------------------------------------------------------------------

describe('rule 2: provenance is always present', () => {
  it('defaults to the rules engine, which is the only producer today', () => {
    expect(toSuggestionRecord(meal()).provenance.producer).toBe(RULES_ENGINE_PRODUCER);
  });

  it('carries a different producer through unchanged', () => {
    // The whole point of the contract: a learned model becomes a second
    // producer and the surface does not change.
    const r = toSuggestionRecord(meal(), { producer: 'model:bc-v1', snapshotId: 'snap-abc' });
    expect(r.provenance.producer).toBe('model:bc-v1');
    expect(r.provenance.snapshot_id).toBe('snap-abc');
  });

  it('renders an empty producer as "unknown" rather than blank', () => {
    expect(toSuggestionRecord(meal(), { producer: '' }).provenance.producer).toBe('unknown');
  });

  it('leaves snapshot_id null for a live suggestion', () => {
    expect(toSuggestionRecord(meal()).provenance.snapshot_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — both timestamps, and rule 5 on unparseable ones
// ---------------------------------------------------------------------------

describe('rule 3: timestamps', () => {
  it('stores decided_at and observed_at as epoch milliseconds', () => {
    const r = toSuggestionRecord(meal({ timestamp: T(12) }));
    expect(r.decided_at).toBe(Date.UTC(2026, 2, 1, 12, 0, 0));
    expect(r.observed_at).toBe(Date.UTC(2026, 2, 1, 12, 0, 0));
  });

  it('returns null for an unparseable timestamp, never the current time', () => {
    // Arm 5 rule 5. A bad row becoming the newest record on a timeline is
    // worse than dropping it — and here it would silently reorder a chart.
    // Null is the whole assertion: a "now" fallback would be a number.
    const r = toSuggestionRecord(meal({ timestamp: 'not a date', mealTime: undefined }));
    expect(r.decided_at).toBeNull();
    expect(r.observed_at).toBeNull();
  });
});

describe('toTimeSeries', () => {
  it('orders oldest first', () => {
    const { points } = toTimeSeries(toSuggestionRecords([
      meal({ id: 'late', timestamp: T(18) }),
      meal({ id: 'early', timestamp: T(8) }),
      meal({ id: 'mid', timestamp: T(12) }),
    ]));
    expect(points.map((p) => p.event_id)).toEqual(['early', 'mid', 'late']);
  });

  it('counts undateable rows instead of bunching them at the epoch', () => {
    const { points, undateable } = toTimeSeries(toSuggestionRecords([
      meal({ id: 'ok', timestamp: T(8) }),
      meal({ id: 'bad', timestamp: 'nonsense', mealTime: undefined }),
    ]));
    expect(points.map((p) => p.event_id)).toEqual(['ok']);
    expect(undateable).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The tolerance split
// ---------------------------------------------------------------------------

describe('the over/under split', () => {
  const records = () => toSuggestionRecords([
    meal({ id: 'over', suggestedInsulin: 4, intendedInsulin: 6 }),      // +2
    meal({ id: 'under', suggestedInsulin: 6, intendedInsulin: 4 }),     // -2
    meal({ id: 'rounding', suggestedInsulin: 5, intendedInsulin: 5.2 }), // +0.2
  ]);

  it('treats a difference within tolerance as agreement, not a disagreement', () => {
    // Insulin is dosed in half-unit steps on most pens, so 0.2 U is rounding.
    const s = summarizeDisagreement(records(), { tolerance: 0.5 });
    expect(s.direction).toMatchObject({ over: 1, under: 1, within: 1 });
    expect(s.direction.overrideRate).toBeCloseTo(2 / 3, 10);
  });

  it('reports the tolerance that produced the split', () => {
    // Otherwise a reader cannot tell what "within" meant.
    expect(summarizeDisagreement(records(), { tolerance: 0.25 }).tolerance).toBe(0.25);
  });

  it('a wider tolerance moves rows into agreement', () => {
    const s = summarizeDisagreement(records(), { tolerance: 3 });
    expect(s.direction).toMatchObject({ over: 0, under: 0, within: 3 });
    // But the signed mean is unchanged — tolerance is a display parameter and
    // must not alter the underlying arithmetic.
    expect(s.signedMeanDelta).toBeCloseTo(0.2 / 3, 10);
  });

  it('mean over-by and under-by are each computed from their own side only', () => {
    const s = summarizeDisagreement(records(), { tolerance: 0.5 });
    expect(s.meanOverBy).toBeCloseTo(2, 10);
    expect(s.meanUnderBy).toBeCloseTo(-2, 10);
  });
});

describe('the headline resists a single mistyped dose', () => {
  it('median is unmoved by one outlier that swings the mean', () => {
    const rows = [
      meal({ id: 'a', suggestedInsulin: 5, intendedInsulin: 5 }),
      meal({ id: 'b', suggestedInsulin: 5, intendedInsulin: 5 }),
      meal({ id: 'c', suggestedInsulin: 5, intendedInsulin: 5 }),
      meal({ id: 'typo', suggestedInsulin: 5, intendedInsulin: 55 }), // 5.5 mistyped
    ];
    const s = summarizeDisagreement(toSuggestionRecords(rows));
    expect(s.signedMedianDelta).toBe(0);
    expect(s.signedMeanDelta).toBeCloseTo(12.5, 10);
  });
});

// ---------------------------------------------------------------------------
// Input robustness
// ---------------------------------------------------------------------------

describe('bad input does not throw', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'meals'],
    ['an object', {}],
  ])('toSuggestionRecords(%s) is an empty list', (_label, value) => {
    expect(toSuggestionRecords(value)).toEqual([]);
  });

  it('summarizes an empty set without dividing by zero', () => {
    const s = summarizeDisagreement([]);
    expect(s.counts.total).toBe(0);
    expect(s.signedMeanDelta).toBeNull();
    expect(s.direction.overrideRate).toBeNull();
    expect(s.totalSuggested).toBe(0);
  });

  it('a meal with no id still produces a record', () => {
    // Dropping it would silently change a cohort count.
    expect(toSuggestionRecord({ suggestedInsulin: 3, intendedInsulin: 3 }).event_id).toBeNull();
  });
});
