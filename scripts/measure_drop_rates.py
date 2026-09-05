#!/usr/bin/env python3
"""
Measure normalizer drop rates before anything is trained.

``MongoRepository.load`` has returned a :class:`LoadReport` since it was
written, and ``aggregate_reports`` has been able to print a cohort table. Until
now neither had ever run against a real corpus, because the deployed database
holds one test user and no clinical records. A drop rate nobody has measured is
not a low drop rate.

This script measures two different things, and keeps them apart because they
answer different questions.

**Pass 1 — the historical quirks.** A synthetic corpus written deliberately in
the shapes the collections have actually held: all four ``bloodSugarTimestamp``
encodings, the insulin dual write, the ``meals`` / ``meals_only`` split, and a
set of records that *should* be dropped (out-of-range glucose, carb-less meals,
sedentary activity). This measures the quarantine boundary against input chosen
to break it. The expected legitimate-drop count is known in advance, so any
divergence is a defect rather than a data-quality finding.

**Pass 2 — real data.** The AZT1D 2025 cohort: 25 subjects on automated insulin
delivery, ~307k rows. The CSVs are converted into the document shapes the
backend actually writes, then read back through the repository. This measures
what a real corpus loses on the way into a training set.

The AZT1D data is real subject data and is **not** in this repository. Point
``--azt1d`` at a local copy. Nothing is written to disk and nothing is
committed; the corpus is built in memory and discarded.

    python scripts/measure_drop_rates.py
    python scripts/measure_drop_rates.py --azt1d "/path/to/AZT1D 2025/CGM Records"

Stdlib only. ``MongoRepository`` takes a database *handle*, so the fake below
is enough and no driver is imported (Arm 5 rule 1).
"""

from __future__ import annotations

import argparse
import csv
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from diatwin.data.repository import MongoRepository, aggregate_reports  # noqa: E402

UTC = timezone.utc


# ─── A database handle that is a dict ────────────────────────────────────────

class FakeCollection:
    def __init__(self, docs: Iterable[Dict[str, Any]] = ()):
        self.docs = list(docs)

    def find(self, query=None):
        query = query or {}
        uid = query.get("user_id") or query.get("patient_id")
        out = []
        for d in self.docs:
            if uid is not None and d.get("user_id") != uid and d.get("patient_id") != uid:
                continue
            out.append(d)
        return out

    def find_one(self, query=None):
        for d in self.find(query):
            if all(d.get(k) == v for k, v in (query or {}).items()
                   if k not in ("user_id", "patient_id")):
                return d
        return None

    def distinct(self, field):
        return sorted({d.get(field) for d in self.docs if d.get(field)})


class FakeDB:
    def __init__(self):
        self._c: Dict[str, FakeCollection] = {}

    def __getitem__(self, name):
        return self._c.setdefault(name, FakeCollection())

    def add(self, name, docs):
        self[name].docs.extend(docs)


# ─── Pass 1: the historical quirks ───────────────────────────────────────────

def build_quirk_corpus(db: FakeDB, patient_id: str, *, n_days: int = 14) -> Dict[str, int]:
    """
    A corpus written in every shape the collections have held.

    Returns the number of records deliberately made undroppable-or-droppable,
    so the measured drop count can be checked against an expectation rather
    than merely reported.
    """
    base = datetime(2026, 3, 1, 0, 0, tzinfo=UTC)
    rng = random.Random(20260905)

    glucose: List[Dict[str, Any]] = []
    meals: List[Dict[str, Any]] = []
    meds: List[Dict[str, Any]] = []
    acts: List[Dict[str, Any]] = []

    expected_drops = {"glucose": 0, "meals": 0, "activity": 0}

    # ── Glucose: one reading every 5 minutes, cycling the four encodings ──
    #
    # These are the four shapes bloodSugarTimestamp has been written in. Any
    # of them failing to parse would bias the dataset toward whichever era
    # used the surviving encoding.
    n_readings = n_days * 24 * 12
    for i in range(n_readings):
        t = base + timedelta(minutes=5 * i)
        naive = t.replace(tzinfo=None)
        encoding = i % 4
        if encoding == 0:
            ts: Any = naive                                   # naive datetime
        elif encoding == 1:
            ts = naive.isoformat()                            # ISO string
        elif encoding == 2:
            ts = naive.isoformat() + "Z"                      # ISO + Z
        else:
            ts = naive.strftime("%Y-%m-%d %H:%M:%S")          # space-separated

        value = 120 + 40 * rng.random() - 20
        glucose.append({
            "_id": f"bg{i}", "user_id": patient_id,
            "bloodSugar": round(value, 1),
            "bloodSugarTimestamp": ts,
            "timestamp": naive + timedelta(seconds=30),       # write time
            "source": "libre_cgm",
        })

    # The fourth encoding the docstring names: no timestamp at all. These
    # cannot be placed on a time axis and must be dropped, not defaulted.
    for i in range(12):
        glucose.append({
            "_id": f"bg-nots{i}", "user_id": patient_id,
            "bloodSugar": 130, "source": "libre_cgm",
        })
    expected_drops["glucose"] += 12

    # Sensor artifacts: physiologically impossible values.
    for i, bad in enumerate([0, 5, 700, 1200, -20]):
        glucose.append({
            "_id": f"bg-bad{i}", "user_id": patient_id,
            "bloodSugar": bad,
            "bloodSugarTimestamp": (base + timedelta(hours=i)).replace(tzinfo=None),
            "timestamp": (base + timedelta(hours=i)).replace(tzinfo=None),
            "source": "libre_cgm",
        })
    expected_drops["glucose"] += 5

    # ── Meals, and the insulin dual write ─────────────────────────────────
    #
    # A bolus lands in medication_logs AND as a meals document. Both are
    # written here for every meal, which is what the backend does.
    for d in range(n_days):
        for hour, carbs in ((8, 45), (13, 60), (19, 55)):
            t = (base + timedelta(days=d, hours=hour)).replace(tzinfo=None)
            mid = f"meal-{d}-{hour}"
            units = round(carbs / 10.0, 1)
            meals.append({
                "_id": mid, "user_id": patient_id,
                "timestamp": t, "created_at": t,
                "mealType": "normal",
                "nutrition": {"carbs": carbs, "protein": 20, "fat": 15,
                              "absorption_type": "medium"},
                "intendedInsulin": units,
                "intendedInsulinType": "rapid_acting",
                "suggestedInsulin": units + 0.5,
                "insulinAdministrationTime": t,
            })
            meds.append({
                "_id": f"med-{d}-{hour}", "user_id": patient_id,
                "patient_id": patient_id,
                "is_insulin": True, "dose": units,
                "medication": "rapid_acting",
                "taken_at": t, "created_at": t,
            })

    # Meals carrying no carbohydrate are not meals for absorption purposes.
    for d in range(n_days):
        t = (base + timedelta(days=d, hours=22)).replace(tzinfo=None)
        meals.append({
            "_id": f"meal-zero-{d}", "user_id": patient_id,
            "timestamp": t, "created_at": t, "mealType": "normal",
            "nutrition": {"carbs": 0, "protein": 0, "fat": 0},
        })
    expected_drops["meals"] += n_days

    # The marker documents the CGM and activity write paths create in `meals`.
    # They are not meals and must not be counted as zero-carb ones either.
    for d in range(n_days):
        t = (base + timedelta(days=d, hours=6)).replace(tzinfo=None)
        meals.append({"_id": f"bs-only-{d}", "user_id": patient_id,
                      "timestamp": t, "created_at": t,
                      "mealType": "blood_sugar_only", "nutrition": {"carbs": 0}})
        meals.append({"_id": f"ins-only-{d}", "user_id": patient_id,
                      "timestamp": t, "created_at": t,
                      "mealType": "insulin_only", "nutrition": {"carbs": 0},
                      "intendedInsulin": 2.0, "intendedInsulinType": "rapid_acting",
                      "insulinAdministrationTime": t})
    expected_drops["meals"] += 2 * n_days

    # The projection collection. Written, and never read.
    db.add("meals_only", [{"_id": f"proj-{m['_id']}", "user_id": patient_id,
                           "timestamp": m["timestamp"]} for m in meals])

    # ── Activity ──────────────────────────────────────────────────────────
    for d in range(n_days):
        t = (base + timedelta(days=d, hours=17)).replace(tzinfo=None)
        acts.append({
            "_id": f"act-{d}", "user_id": patient_id,
            "startTime": t, "created_at": t,
            "duration_minutes": 45, "level": 2, "mean_hr": 128,
        })
        # The legacy 'HH:MM' duration encoding.
        acts.append({
            "_id": f"act-legacy-{d}", "user_id": patient_id,
            "startTime": (t + timedelta(hours=2)), "created_at": t + timedelta(hours=2),
            "duration": "01:30", "intensity": "light",
        })
        # Sedentary levels modulate sensitivity elsewhere; as bouts they
        # would double-count, so they must drop.
        acts.append({
            "_id": f"act-sed-{d}", "user_id": patient_id,
            "startTime": (t + timedelta(hours=4)), "created_at": t + timedelta(hours=4),
            "duration_minutes": 60, "level": 0,
        })
    expected_drops["activity"] += n_days

    db.add("blood_sugar", glucose)
    db.add("meals", meals)
    db.add("medication_logs", meds)
    db.add("activities", acts)
    db.add("users", [{"_id": patient_id, "user_id": patient_id,
                      "timezone_offset_minutes": 0}])

    return expected_drops


# ─── Pass 2: AZT1D ───────────────────────────────────────────────────────────

#: The glucose column is not named the same in every AZT1D file.
#:
#: 24 of the 25 subjects use ``CGM``. Subject 14 alone uses
#: ``Readings (CGM / BGM)`` and orders its columns differently. A converter
#: keying only on ``CGM`` produces **zero** glucose rows for that subject —
#: 13,003 rows, 4% of the cohort — with no error and nothing in the
#: ``LoadReport``, because a record that is never emitted cannot be counted as
#: dropped. That is the single clearest illustration of why this script audits
#: the source as well as the load.
_CGM_COLUMNS = ("CGM", "Readings (CGM / BGM)")


def _num(value: Any) -> float:
    """
    A CSV cell as a number, treating empty, ``"0"`` and unparseable as zero.

    Exists because ``"0"`` is a *truthy string*. Every place this converter
    needs to ask "is there a value here?" it must ask of the number, not the
    cell — see the comment in :func:`load_azt1d`.
    """
    text = (value or "").strip()
    if not text:
        return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def load_azt1d(db: FakeDB, records_dir: Path, *, limit: int | None = None) -> List[str]:
    """
    Convert the AZT1D CGM records into the document shapes the backend writes.

    Times in the source are Arizona local (UTC-7, no DST). They are converted
    to UTC on the way in, because the canonical schema has exactly one time
    axis and ``tz_offset_min`` carries the local view.

    Columns: EventDateTime, DeviceMode, BolusType, Basal, CorrectionDelivered,
    TotalBolusInsulinDelivered, FoodDelivered, CarbSize, CGM.
    """
    ARIZONA_OFFSET = timedelta(hours=-7)
    patient_ids: List[str] = []

    files = sorted(records_dir.glob("Subject *.csv"),
                   key=lambda p: int(p.stem.split()[-1]))
    if limit:
        files = files[:limit]

    for path in files:
        pid = f"azt1d-{path.stem.split()[-1]}"
        patient_ids.append(pid)

        glucose, meals, meds = [], [], []
        with path.open(newline="", encoding="utf-8-sig") as fh:
            for i, row in enumerate(csv.DictReader(fh)):
                raw = (row.get("EventDateTime") or "").strip()
                if not raw:
                    continue
                try:
                    local = datetime.strptime(raw, "%Y-%m-%d %H:%M:%S")
                except ValueError:
                    try:
                        local = datetime.strptime(raw, "%Y-%m-%d %H:%M")
                    except ValueError:
                        continue
                utc_naive = local - ARIZONA_OFFSET

                cgm = ""
                for col in _CGM_COLUMNS:
                    if col in row:
                        cgm = (row.get(col) or "").strip()
                        break
                if cgm:
                    try:
                        value = float(cgm)
                    except ValueError:
                        value = None
                    if value is not None:
                        glucose.append({
                            "_id": f"{pid}-bg{i}", "user_id": pid,
                            "bloodSugar": value,
                            "bloodSugarTimestamp": utc_naive,
                            "timestamp": utc_naive,
                            "source": "libre_cgm",
                            "timezone_offset_minutes": -420,
                        })

                # Branch on the parsed *values*, never on string truthiness.
                #
                # AZT1D writes a literal "0" in CarbSize on 14,463 rows. An
                # earlier version of this converter used `if carbs:` / `if not
                # carbs:` and therefore sent every one of those rows down the
                # meal branch, where a zero-carb meal is discarded — taking its
                # bolus with it. That silently lost 6,664 of 11,118 boluses,
                # 60% of the insulin signal, while the LoadReport showed a
                # 0.38% insulin drop rate. See the session report: it is the
                # clearest available demonstration that a drop rate cannot see
                # a record the converter never emitted.
                carb_g = _num(row.get("CarbSize"))
                units = _num(row.get("TotalBolusInsulinDelivered"))

                if carb_g > 0:
                    doc = {
                        "_id": f"{pid}-meal{i}", "user_id": pid,
                        "timestamp": utc_naive, "created_at": utc_naive,
                        "mealType": "normal",
                        "nutrition": {"carbs": carb_g, "protein": 0, "fat": 0,
                                      "absorption_type": "medium"},
                        "timezone_offset_minutes": -420,
                    }
                    if units > 0:
                        doc["intendedInsulin"] = units
                        doc["intendedInsulinType"] = "rapid_acting"
                        doc["insulinAdministrationTime"] = utc_naive
                    meals.append(doc)
                elif units > 0:
                    # A bolus with no carbohydrate: a correction, or a bolus
                    # the patient logged without food. It is still insulin.
                    meds.append({
                        "_id": f"{pid}-med{i}", "user_id": pid,
                        "patient_id": pid,
                        "is_insulin": True, "dose": units,
                        "medication": "rapid_acting",
                        "taken_at": utc_naive, "created_at": utc_naive,
                        "timezone_offset_minutes": -420,
                    })

        # A subject that converts to nothing is a converter fault, not a quiet
        # patient — the files all have thousands of rows. Say so here, where it
        # is still attributable, rather than letting it show up as a smaller
        # cohort with a perfect drop rate.
        if not glucose:
            print(f"  !! {path.name}: {pid} produced NO glucose rows "
                  f"(columns: {', '.join(list(row.keys())[:4])}...)",
                  file=sys.stderr)

        db.add("blood_sugar", glucose)
        db.add("meals", meals)
        db.add("medication_logs", meds)
        db.add("users", [{"_id": pid, "user_id": pid,
                          "timezone_offset_minutes": -420}])

    return patient_ids


def audit_azt1d_source(records_dir: Path, *, limit: int | None = None) -> None:
    """
    Count the signal present in the source, next to the signal the converter
    emits.

    A ``LoadReport`` can only account for records it was offered. A converter
    that never emits a stream produces a *perfect* drop rate for it, which is
    the most dangerous possible reading: the number says "nothing was lost"
    precisely because everything was.

    This counts the source columns directly so that gap is visible as a number
    rather than an assumption.
    """
    files = sorted(records_dir.glob("Subject *.csv"),
                   key=lambda p: int(p.stem.split()[-1]))
    if limit:
        files = files[:limit]

    rows = 0
    have = {"CGM": 0, "CarbSize": 0, "TotalBolusInsulinDelivered": 0,
            "Basal": 0, "CorrectionDelivered": 0}
    device_modes: Dict[str, int] = {}
    extended_boluses = 0
    literal_zero_strings = {"DeviceMode": 0, "BolusType": 0}

    for path in files:
        with path.open(newline="", encoding="utf-8-sig") as fh:
            for row in csv.DictReader(fh):
                rows += 1
                for col in have:
                    v = (row.get(col) or "").strip()
                    if v and v != "0":
                        have[col] += 1
                mode = (row.get("DeviceMode") or "").strip()
                if mode:
                    device_modes[mode] = device_modes.get(mode, 0) + 1
                    if mode == "0":
                        literal_zero_strings["DeviceMode"] += 1
                btype = (row.get("BolusType") or "").strip()
                if btype == "0":
                    literal_zero_strings["BolusType"] += 1
                if btype.startswith("Extended"):
                    extended_boluses += 1

    print(f"\n{'-' * 78}\nAZT1D source coverage — what the converter offers vs. what is there"
          f"\n{'-' * 78}")
    print(f"source rows: {rows}\n")
    print(f"{'column':32}{'rows with signal':>18}{'converted?':>14}")
    converted = {"CGM": "yes", "CarbSize": "yes",
                 "TotalBolusInsulinDelivered": "yes",
                 "Basal": "NO", "CorrectionDelivered": "NO"}
    for col, n in have.items():
        print(f"{col:32}{n:>18}{converted[col]:>14}")

    print(f"\nDeviceMode values: {device_modes}")
    print(f"  'exercise' rows: {device_modes.get('exercise', 0)} — converted? NO "
          f"(the activity stream loads empty)")
    print(f"  'sleepsleep': {device_modes.get('sleepsleep', 0)} — a corrupt enum "
          f"value present in the real data")
    print(f"  literal '0' strings: {literal_zero_strings} — truthy in Python; "
          f"code testing `if row[col]:` treats these as present")
    print(f"\nextended / dual-wave boluses: {extended_boluses} — the canonical "
          f"schema has no representation for these;\n  each is loaded as a single "
          f"instantaneous dose, which front-loads its modelled action.")


# ─── Reporting ───────────────────────────────────────────────────────────────

def run(db: FakeDB, patient_ids: List[str], title: str):
    repo = MongoRepository(db)
    loaded = repo.load_many(patient_ids)
    print(f"\n{'=' * 78}\n{title}\n{'=' * 78}")
    print(aggregate_reports([rep for _, rep in loaded]))
    return loaded


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--azt1d", type=Path, default=None,
                    help="path to 'AZT1D 2025/CGM Records'")
    ap.add_argument("--subjects", type=int, default=None,
                    help="limit the number of AZT1D subjects (default: all)")
    args = ap.parse_args()

    # ── Pass 1 ────────────────────────────────────────────────────────────
    db = FakeDB()
    pid = "quirk-patient-1"
    expected = build_quirk_corpus(db, pid)
    loaded = run(db, [pid], "PASS 1 — synthetic corpus, historical quirks")

    _, report = loaded[0]
    print("\nExpected legitimate drops (records that SHOULD be refused):")
    for stream, n in sorted(expected.items()):
        actual = report.streams[stream].dropped_normalize
        verdict = "ok" if actual == n else f"MISMATCH (expected {n})"
        print(f"  {stream:10} dropped {actual:>5}   {verdict}")
    print(f"\ninsulin dual-write collapsed: {report.insulin_deduped}"
          f"   (0 would mean the dual write is not being read)")

    # ── Pass 2 ────────────────────────────────────────────────────────────
    if args.azt1d:
        if not args.azt1d.exists():
            print(f"\n--azt1d path does not exist: {args.azt1d}", file=sys.stderr)
            return 2
        db2 = FakeDB()
        ids = load_azt1d(db2, args.azt1d, limit=args.subjects)
        run(db2, ids, f"PASS 2 — AZT1D 2025, {len(ids)} subjects (real data)")
        audit_azt1d_source(args.azt1d, limit=args.subjects)
    else:
        print("\n(no --azt1d path given; pass 2 skipped)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
