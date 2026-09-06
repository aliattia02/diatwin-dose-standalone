/**
 * The cohort-quality view, implemented.
 *
 * Turns a snapshot's `manifest.json` (produced by `diatwin/ml/export.py`,
 * served by `GET /api/ml/snapshots/<id>/manifest`) into the shapes a clinical
 * or ops reviewer looks at. The manifest already carries the per-patient,
 * per-stream `LoadReport` accounting — nothing here recomputes drop rates, it
 * only aggregates and flags what the manifest already states.
 *
 * The reason this view exists at all is the pre-ML audit §4, and its finding
 * is the one thing this module is built to not let a reader miss:
 *
 *   "The conclusion is not that the converter was bad. It is that drop rate is
 *   the wrong instrument for the failure that actually happens... A perfect
 *   drop rate for a stream is the most dangerous possible reading, because it
 *   is what you get when nothing arrives at all."
 *
 * Two real bugs hid behind clean-looking numbers in that audit: 60% of the
 * insulin signal lost to a truthy `"0"` string (drop rate read 0.38%, not
 * remotely 60%), and an entire subject's glucose stream silently empty because
 * one file named its column differently (drop rate read 0.00%, the cleanest
 * possible reading for the worst possible outcome). Both were catchable only
 * by looking at `fetched`, not at the failure rate.
 *
 * So `zeroFetchedWarnings` below is the one automatic verdict this module
 * renders as unambiguous — a canonical stream with zero rows fetched across
 * the whole cohort. Everything else is numbers and captions, not verdicts,
 * because the audit's other finding is that the 5% "investigate" threshold
 * `aggregate_reports` (Python) applies is noise for three of the four streams:
 * meals, activity and even insulin can show high normalize-drop rates that are
 * entirely correct by-design refusals (zero-carb meals, sedentary rows,
 * genuine dual-write collapses). Only glucose's threshold is trustworthy on its
 * own, so this module does not invent a second heuristic to replace the one the
 * audit already showed misleads.
 */

/** The four streams `MongoRepository.load` accounts for. Order matches the
 *  Python `aggregate_reports` table so the two read the same either side. */
export const CANONICAL_STREAMS = ['glucose', 'insulin', 'meals', 'activity'];

function emptyStreamTotal() {
  return { fetched: 0, kept: 0, droppedNormalize: 0, droppedWindow: 0 };
}

/**
 * Aggregate every patient's `load_reports` entry into cohort-wide per-stream
 * totals, plus the manifest-level facts a reviewer needs alongside them.
 *
 * Never throws on a manifest missing a field — a manifest is data written by
 * another process at another time, and a reviewer should see what is missing
 * rather than get an error page for it.
 */
export function summarizeManifest(manifest) {
  const m = manifest || {};
  const reports = Array.isArray(m.load_reports) ? m.load_reports : [];

  const streams = {};
  for (const name of CANONICAL_STREAMS) streams[name] = emptyStreamTotal();

  let insulinDeduped = 0;
  const missingProfile = [];

  for (const report of reports) {
    const patientId = report?.patient_id ?? null;
    insulinDeduped += Number(report?.insulin_deduped) || 0;
    if (report?.profile_found === false) missingProfile.push(patientId);

    const reportStreams = report?.streams || {};
    for (const name of CANONICAL_STREAMS) {
      const s = reportStreams[name];
      if (!s) continue;
      const acc = streams[name];
      acc.fetched += Number(s.fetched) || 0;
      acc.kept += Number(s.kept) || 0;
      acc.droppedNormalize += Number(s.dropped_normalize) || 0;
      acc.droppedWindow += Number(s.dropped_window) || 0;
    }
  }

  // failRate is null rather than 0 when nothing was fetched — a 0% failure
  // rate on zero attempts is not a fact about data quality, it is an absence,
  // and the two must never be displayed identically.
  for (const name of CANONICAL_STREAMS) {
    const s = streams[name];
    s.failRate = s.fetched > 0 ? s.droppedNormalize / s.fetched : null;
  }

  return {
    snapshotId: m.snapshot_id ?? null,
    contentHash: m.content_hash ?? null,
    createdAt: m.created_at ?? null,
    note: m.note ?? '',
    patients: typeof m.patients === 'number' ? m.patients : reports.length,
    span: {
      from: m.span?.from ?? null,
      to: m.span?.to ?? null,
    },
    streams,
    insulinDeduped,
    missingProfile,
    patientCount: reports.length,
    leakageNote: m.leakage_note ?? null,
  };
}

/**
 * The single most load-bearing check this module makes: a canonical stream
 * with zero rows fetched anywhere in the cohort.
 *
 * Deliberately separate from a "high fail rate" warning — the two are
 * opposite failure modes. A high fail rate means data arrived and was
 * refused; zero fetched means nothing arrived to refuse, which is what a
 * converter bug that never emits a row looks like, and which no drop-rate
 * threshold can ever catch because the denominator is also zero.
 */
export function zeroFetchedWarnings(streams) {
  const s = streams || {};
  return CANONICAL_STREAMS
    .filter((name) => (s[name]?.fetched ?? 0) === 0)
    .map((name) => ({
      stream: name,
      message: `No ${name} rows were fetched for this cohort. This reads as a `
        + `0% drop rate, which is indistinguishable from "nothing to drop" — `
        + `check whether ${name} was ever converted before trusting the drop `
        + `rate for it.`,
    }));
}

/**
 * The insulin dual-write check `aggregate_reports` (Python) prints as text.
 * Reproduced as structured data: a large insulin load with nothing deduped
 * means the dual write (medication_logs + meals) is not being read from both
 * sides, which would HALVE the insulin signal rather than double-count it —
 * the opposite failure from what dedup exists to guard against.
 */
export function insulinDedupWarning(streams, insulinDeduped, { largeLoadThreshold = 100 } = {}) {
  const fetched = streams?.insulin?.fetched ?? 0;
  if (insulinDeduped === 0 && fetched > largeLoadThreshold) {
    return {
      message: `0 insulin doses collapsed as duplicates across ${fetched} fetched, `
        + `which is large enough that some are expected. Check that both `
        + `medication_logs and meals are being read (Arm 5 rule 8).`,
    };
  }
  return null;
}

/** One row per patient, for the per-patient breakdown table. */
export function perPatientRows(manifest) {
  const reports = Array.isArray(manifest?.load_reports) ? manifest.load_reports : [];
  return reports.map((report) => {
    const reportStreams = report?.streams || {};
    const streams = {};
    for (const name of CANONICAL_STREAMS) {
      const s = reportStreams[name];
      const fetched = Number(s?.fetched) || 0;
      const droppedNormalize = Number(s?.dropped_normalize) || 0;
      streams[name] = {
        fetched,
        kept: Number(s?.kept) || 0,
        droppedNormalize,
        droppedWindow: Number(s?.dropped_window) || 0,
        failRate: fetched > 0 ? droppedNormalize / fetched : null,
      };
    }
    return {
      patientId: report?.patient_id ?? null,
      profileFound: report?.profile_found !== false,
      insulinDeduped: Number(report?.insulin_deduped) || 0,
      streams,
    };
  });
}

/** A light row for the snapshot list — no per-patient breakdown. */
export function toSnapshotListRow(entry) {
  return {
    snapshotId: entry?.snapshot_id ?? null,
    createdAt: entry?.created_at ?? null,
    patients: typeof entry?.patients === 'number' ? entry.patients : null,
    note: entry?.note ?? '',
    error: entry?.error ?? null,
  };
}
