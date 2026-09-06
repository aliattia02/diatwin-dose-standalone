/**
 * The cohort-quality arithmetic, exercised against the two failure modes the
 * pre-ML audit §4 actually found — a stream that never arrives, and a stream
 * that arrives and is silently halved — because a passing test against a
 * happy-path manifest proves nothing about the reason this view exists.
 */

import {
  summarizeManifest,
  zeroFetchedWarnings,
  insulinDedupWarning,
  perPatientRows,
  toSnapshotListRow,
  CANONICAL_STREAMS,
} from '../utils/cohortQuality';

const streamReport = (over) => ({
  collection: 'x', fetched: 100, kept: 100, dropped_normalize: 0, dropped_window: 0,
  ...over,
});

const patientReport = (patientId, over) => ({
  patient_id: patientId,
  profile_found: true,
  insulin_deduped: 0,
  streams: {
    glucose: streamReport(),
    insulin: streamReport(),
    meals: streamReport(),
    activity: streamReport(),
  },
  ...over,
});

const manifest = (over) => ({
  snapshot_id: 'snap-1',
  content_hash: 'abc123',
  created_at: '2026-03-01T00:00:00Z',
  note: 'test',
  patients: 2,
  span: { from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' },
  load_reports: [patientReport('p1'), patientReport('p2')],
  leakage_note: 'Every row carries observed_at.',
  ...over,
});

// ---------------------------------------------------------------------------
// The audit's actual bug 2: a stream that never arrives reads as 0% drop
// ---------------------------------------------------------------------------

describe('zeroFetchedWarnings — the case a drop-rate threshold cannot see', () => {
  it('flags a canonical stream with zero rows fetched cohort-wide', () => {
    const m = manifest({
      load_reports: [
        patientReport('p1', {
          streams: {
            glucose: streamReport({ fetched: 0, kept: 0 }), // the AZT1D subject-14 bug
            insulin: streamReport(),
            meals: streamReport(),
            activity: streamReport({ fetched: 0, kept: 0 }),
          },
        }),
      ],
    });
    const { streams } = summarizeManifest(m);
    const warnings = zeroFetchedWarnings(streams);
    expect(warnings.map((w) => w.stream)).toEqual(['glucose', 'activity']);
  });

  it('does not flag a stream that fetched rows and dropped none', () => {
    const { streams } = summarizeManifest(manifest());
    expect(zeroFetchedWarnings(streams)).toEqual([]);
  });

  it('a stream with a clean 0% drop rate and real data is not confused with one that never arrived', () => {
    // The distinction the whole module exists to preserve: 100 fetched, 0
    // dropped is a genuinely good stream; 0 fetched, 0 dropped is silence.
    const good = summarizeManifest(manifest()).streams.glucose;
    const silent = summarizeManifest(manifest({
      load_reports: [patientReport('p1', {
        streams: { glucose: streamReport({ fetched: 0, kept: 0 }), insulin: streamReport(), meals: streamReport(), activity: streamReport() },
      })],
    })).streams.glucose;

    expect(good.failRate).toBe(0);
    expect(silent.failRate).toBeNull(); // not 0 — there was nothing to compute a rate from
  });
});

// ---------------------------------------------------------------------------
// The audit's bug 1: a stream that is fetched and silently halved
// ---------------------------------------------------------------------------

describe('cohort totals reflect a partial loss, not just a total one', () => {
  it('aggregates fetched/kept/dropped across patients rather than per-patient', () => {
    const m = manifest({
      load_reports: [
        patientReport('p1', { streams: { insulin: streamReport({ fetched: 4471, kept: 4471, dropped_normalize: 0 }), glucose: streamReport(), meals: streamReport(), activity: streamReport() } }),
      ],
    });
    // Reproduces the audit's own before/after numbers for the insulin bug.
    const before = summarizeManifest(m).streams.insulin;
    expect(before.fetched).toBe(4471);

    const after = summarizeManifest(manifest({
      load_reports: [
        patientReport('p1', { streams: { insulin: streamReport({ fetched: 11135, kept: 10518, dropped_normalize: 17 }), glucose: streamReport(), meals: streamReport(), activity: streamReport() } }),
      ],
    })).streams.insulin;
    expect(after.fetched).toBe(11135);
    expect(after.failRate).toBeCloseTo(17 / 11135, 10);
  });

  it('sums correctly across a multi-patient cohort', () => {
    const m = manifest({
      load_reports: [
        patientReport('p1', { streams: { glucose: streamReport({ fetched: 100, kept: 90, dropped_normalize: 10 }), insulin: streamReport(), meals: streamReport(), activity: streamReport() } }),
        patientReport('p2', { streams: { glucose: streamReport({ fetched: 200, kept: 200, dropped_normalize: 0 }), insulin: streamReport(), meals: streamReport(), activity: streamReport() } }),
      ],
    });
    const { streams } = summarizeManifest(m);
    expect(streams.glucose.fetched).toBe(300);
    expect(streams.glucose.droppedNormalize).toBe(10);
    expect(streams.glucose.failRate).toBeCloseTo(10 / 300, 10);
  });
});

// ---------------------------------------------------------------------------
// The insulin dual-write check
// ---------------------------------------------------------------------------

describe('insulinDedupWarning', () => {
  it('warns when a large load collapsed nothing', () => {
    const streams = { insulin: { fetched: 5000 } };
    const w = insulinDedupWarning(streams, 0);
    expect(w).not.toBeNull();
    expect(w.message).toMatch(/rule 8/);
  });

  it('does not warn on a small load — 0 deduped is expected there', () => {
    const streams = { insulin: { fetched: 20 } };
    expect(insulinDedupWarning(streams, 0)).toBeNull();
  });

  it('does not warn when deduping did happen', () => {
    const streams = { insulin: { fetched: 5000 } };
    expect(insulinDedupWarning(streams, 600)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Per-patient rows and missing profiles
// ---------------------------------------------------------------------------

describe('perPatientRows', () => {
  it('produces one row per patient with per-stream numbers', () => {
    const rows = perPatientRows(manifest());
    expect(rows).toHaveLength(2);
    expect(rows[0].patientId).toBe('p1');
    expect(CANONICAL_STREAMS.every((s) => s in rows[0].streams)).toBe(true);
  });

  it('surfaces a patient with no constants profile rather than silently defaulting', () => {
    const m = manifest({
      load_reports: [patientReport('p1', { profile_found: false })],
    });
    expect(perPatientRows(m)[0].profileFound).toBe(false);
    expect(summarizeManifest(m).missingProfile).toEqual(['p1']);
  });
});

// ---------------------------------------------------------------------------
// Robustness against a manifest that is missing fields
// ---------------------------------------------------------------------------

describe('a manifest with missing or malformed fields does not throw', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty object', {}],
    ['load_reports not an array', { load_reports: 'nope' }],
    ['a report with no streams object', { load_reports: [{ patient_id: 'p1' }] }],
  ])('%s', (_label, value) => {
    expect(() => summarizeManifest(value)).not.toThrow();
    expect(() => perPatientRows(value)).not.toThrow();
  });

  it('reports zero patients and no data for an empty manifest, not an error state', () => {
    const s = summarizeManifest({});
    expect(s.patientCount).toBe(0);
    expect(zeroFetchedWarnings(s.streams)).toHaveLength(CANONICAL_STREAMS.length);
  });
});

describe('toSnapshotListRow', () => {
  it('carries the error flag through for a broken manifest entry', () => {
    const row = toSnapshotListRow({ snapshot_id: 'broken', error: 'manifest could not be read' });
    expect(row.error).toBe('manifest could not be read');
  });

  it('handles a normal entry', () => {
    const row = toSnapshotListRow({ snapshot_id: 's1', created_at: 't', patients: 3, note: 'n' });
    expect(row).toEqual({ snapshotId: 's1', createdAt: 't', patients: 3, note: 'n', error: null });
  });
});
