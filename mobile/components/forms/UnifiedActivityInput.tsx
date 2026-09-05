/**
 * Unified Activity Input
 * Location: mobile/components/forms/UnifiedActivityInput.tsx
 * v2.0 — Synced with web ActivityRecording.js
 *
 * New in v2.0:
 *   - LEVEL_TO_INTENSITY map — intensity field on all activities
 *   - hr_base / hr_max / hr_trace / duration_minutes on completed activities
 *   - HrSection — collapsible HR keypoint form (rest HR, max HR, per-minute readings)
 *   - WatchSessionPanel — live wearable HR streaming, standalone-only
 *   - PdResultPanel — pharmacodynamics result display, standalone-only
 *   - ✅ FIX M-4: intensity derived from activity.intensity first, then level lookup
 *   - ✅ FIX C-2: crash recovery uses status.started_at (not total_raw * 1000)
 *   - ✅ FIX H-1: sensitivity_multiplier displayed once above breakdown, not per-session
 *
 * Features carried forward from v1:
 *   - Activity level selection with impact coefficients
 *   - Start/end time selection with UTC handling
 *   - Duration calculation (HH:MM)
 *   - Multiple activity support
 *   - Expected vs completed tracking
 *   - calcTotalImpactFrom pure helper (avoids stale-memo on parent notification)
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Switch,
  ActivityIndicator,
} from 'react-native';
import { colors, spacing, borderRadius, typography } from '@/constants/theme';
import { SHARED_CONSTANTS } from '@/constants/shared-constants'; // I-14: use runtime-overridable shared constants
import { TimeManager } from '@/utils/time';
import {
  startWatchSession,
  streamHrSamples,
  endWatchSession,
  getWatchSessionStatus,
} from '@/services/api/watch-hr';
import { fetchStackedActivityEffectSafe } from '@/services/api/activity-pharmacodynamics';
import type { ActivityPDResult } from '@/services/api/activity-pharmacodynamics';
// I-18 NOTE: The audit references apiClient.post('/api/record-activities', ...) as a
// hardcoded endpoint in this file, but this component delegates activity data upward
// via onActivityUpdate() and makes no direct API calls. The hardcoded string likely
// lives in the standalone screen that wraps this component. When found, replace with
// API.ACTIVITIES.CREATE from '@/services/api/endpoints'.
import API from '@/services/api/endpoints'; // I-18: pre-import so the fix is ready when the call site is found

// ─── Constants ────────────────────────────────────────────────────────────────

const LEVEL_TO_INTENSITY: Record<string, 'light' | 'moderate' | 'vigorous'> = {
  '-2': 'light',
  '-1': 'light',
  '0':  'light',
  '1':  'moderate',
  '2':  'vigorous',
};

/** How often buffered HR samples are flushed to the backend during a watch session */
const STREAM_INTERVAL_MS = 5000;

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface HrTracePoint {
  t_min: number;
  hr_bpm: number;
}

export interface UnifiedActivity {
  level: number;
  /** Categorical intensity derived from level via LEVEL_TO_INTENSITY */
  intensity: 'light' | 'moderate' | 'vigorous';
  duration: string;            // "HH:MM"
  duration_minutes: number;    // for the ODE pharmacodynamics engine
  startTime: string;           // ISO UTC
  endTime: string;             // ISO UTC
  impact: number;
  notes?: string;
  isExpected: boolean;
  // HR fields — only populated for completed (non-expected) activities
  hr_base?: number;
  hr_max?: number;
  hr_trace?: HrTracePoint[];
}

interface UnifiedActivityInputProps {
  onActivityUpdate: (activities: UnifiedActivity[], totalImpact: number) => void;
  initialActivities?: UnifiedActivity[];
  activityCoefficients: Record<string, number>;
  standalone?: boolean;
  showNotes?: boolean;
  /**
   * Called after a standalone watch session completes with the PD result.
   * May be null if the backend fetch failed (non-fatal).
   */
  onPdResult?: (result: ActivityPDResult | null) => void;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Compute total impact synchronously from a concrete list.
 * Called immediately after adding/removing an activity to notify the parent
 * with the correct value, without relying on potentially stale useMemo state.
 */
function calcTotalImpactFrom(
  activities: UnifiedActivity[],
  activityCoefficients: Record<string, number>
): number {
  if (activities.length === 0) return 1.0;
  let total = 1.0;
  activities.forEach(activity => {
    const coefficient = activityCoefficients[activity.level.toString()] || 1.0;
    const [hours, minutes] = activity.duration.split(':').map(Number);
    const durationHours = hours + minutes / 60;
    const durationWeight = Math.min(durationHours / 2, 1);
    total *= 1.0 + ((coefficient - 1.0) * durationWeight);
  });
  return total;
}

function fmtElapsed(totalSec: number): string {
  const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// ─── HrSection ────────────────────────────────────────────────────────────────

interface HrSectionProps {
  hrBase: string;
  hrMax: string;
  hrTrace: HrTracePoint[];
  onHrBaseChange: (v: string) => void;
  onHrMaxChange: (v: string) => void;
  onHrTraceChange: (trace: HrTracePoint[]) => void;
}

const HrSection: React.FC<HrSectionProps> = ({
  hrBase, hrMax, hrTrace,
  onHrBaseChange, onHrMaxChange, onHrTraceChange,
}) => {
  const [open, setOpen] = useState(false);

  const addPoint = () =>
    onHrTraceChange([...hrTrace, { t_min: hrTrace.length * 5, hr_bpm: 120 }]);

  const updatePoint = (idx: number, field: keyof HrTracePoint, val: number) => {
    const updated = [...hrTrace];
    updated[idx] = { ...updated[idx], [field]: val };
    onHrTraceChange(updated);
  };

  const removePoint = (idx: number) =>
    onHrTraceChange(hrTrace.filter((_, i) => i !== idx));

  return (
    <View style={hrStyles.container}>
      <TouchableOpacity style={hrStyles.toggle} onPress={() => setOpen(v => !v)}>
        <Text style={hrStyles.toggleLabel}>
          {'♥ Heart Rate Data'}
          <Text style={hrStyles.optional}> (optional — improves BG accuracy)</Text>
        </Text>
        <View style={hrStyles.toggleRight}>
          {hrTrace.length > 0 && (
            <View style={hrStyles.badge}>
              <Text style={hrStyles.badgeText}>
                {hrTrace.length} pt{hrTrace.length !== 1 ? 's' : ''}
              </Text>
            </View>
          )}
          <Text style={hrStyles.chevron}>{open ? '▲' : '▼'}</Text>
        </View>
      </TouchableOpacity>

      {open && (
        <View style={hrStyles.fields}>
          <Text style={hrStyles.hint}>
            Leave empty to use estimated HR based on intensity.
            Adding real readings improves glucose prediction accuracy.
          </Text>

          {/* Resting / Max HR */}
          <View style={hrStyles.baseRow}>
            <View style={hrStyles.baseGroup}>
              <Text style={hrStyles.baseLabel}>Resting HR (bpm)</Text>
              <TextInput
                style={hrStyles.baseInput}
                value={hrBase}
                onChangeText={onHrBaseChange}
                keyboardType="number-pad"
                placeholder="70"
                placeholderTextColor={colors.text.secondary}
              />
            </View>
            <View style={hrStyles.baseGroup}>
              <Text style={hrStyles.baseLabel}>Max HR (bpm)</Text>
              <TextInput
                style={hrStyles.baseInput}
                value={hrMax}
                onChangeText={onHrMaxChange}
                keyboardType="number-pad"
                placeholder="190"
                placeholderTextColor={colors.text.secondary}
              />
            </View>
          </View>

          {/* Trace points */}
          <View style={hrStyles.traceHeader}>
            <Text style={hrStyles.traceTitle}>HR Readings during activity</Text>
            <TouchableOpacity style={hrStyles.addPointBtn} onPress={addPoint}>
              <Text style={hrStyles.addPointText}>+ Add Reading</Text>
            </TouchableOpacity>
          </View>

          {hrTrace.length === 0 ? (
            <Text style={hrStyles.emptyHint}>
              No readings added. Each records your HR at a specific minute.{'\n'}
              <Text style={hrStyles.emptyHintExample}>
                Example: "At minute 10, HR was 145 bpm"
              </Text>
            </Text>
          ) : (
            <>
              <Text style={hrStyles.rowHint}>
                "At minute __ into the activity, my heart rate was __ bpm"
              </Text>
              {hrTrace.map((pt, idx) => (
                <View key={idx} style={hrStyles.traceRow}>
                  <Text style={hrStyles.traceLabel}>Min</Text>
                  <TextInput
                    style={hrStyles.traceInput}
                    value={String(pt.t_min)}
                    onChangeText={(v) => updatePoint(idx, 't_min', parseFloat(v) || 0)}
                    keyboardType="decimal-pad"
                  />
                  <Text style={hrStyles.traceLabel}>HR</Text>
                  <TextInput
                    style={hrStyles.traceInput}
                    value={String(pt.hr_bpm)}
                    onChangeText={(v) => updatePoint(idx, 'hr_bpm', parseFloat(v) || 0)}
                    keyboardType="decimal-pad"
                  />
                  <Text style={hrStyles.traceLabel}>bpm</Text>
                  <TouchableOpacity onPress={() => removePoint(idx)} style={hrStyles.removePoint}>
                    <Text style={hrStyles.removePointText}>✕</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </>
          )}
        </View>
      )}
    </View>
  );
};

// ─── WatchSessionPanel ────────────────────────────────────────────────────────

type WatchPhase = 'idle' | 'connecting' | 'recording' | 'stopping' | 'done';

interface WatchSessionPanelProps {
  onSessionComplete: (result: any) => void;
}

/**
 * WatchSessionPanel — live wearable HR streaming panel.
 *
 * Lifecycle: idle → connecting → recording → stopping → done
 *
 * HR input:
 *   Manual: type a bpm value and tap Add — each sample is stamped with current t_sec.
 *   (CSV import requires native file access; handled by the watch session endpoint
 *   on the native side via the continuous-upload flow instead.)
 */
const WatchSessionPanel: React.FC<WatchSessionPanelProps> = ({ onSessionComplete }) => {
  const [phase, setPhase]             = useState<WatchPhase>('idle');
  const [sessionId, setSessionId]     = useState<string | null>(null);
  const [elapsedSec, setElapsedSec]   = useState(0);
  const [totalRaw, setTotalRaw]       = useState(0);
  const [hrInput, setHrInput]         = useState('');
  const [pendingSamples, setPending]  = useState<Array<{ t_sec: number; hr_bpm: number }>>([]);
  const [watchError, setWatchError]   = useState<string | null>(null);
  const [intensity, setIntensity]     = useState<'light' | 'moderate' | 'vigorous'>('moderate');
  const [hrBase, setHrBase]           = useState('');
  const [hrMax, setHrMax]             = useState('');
  const [lastSessionId, setLastSessionId] = useState<string | null>(null);

  const startTimeRef     = useRef<number | null>(null);
  const timerRef         = useRef<ReturnType<typeof setInterval> | null>(null);
  const flushRef         = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingRef       = useRef(pendingSamples);
  const sessionIdRef     = useRef(sessionId);
  pendingRef.current     = pendingSamples;
  sessionIdRef.current   = sessionId;

  // ── Elapsed timer ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase === 'recording') {
      timerRef.current = setInterval(() => {
        if (startTimeRef.current != null) {
          setElapsedSec(Math.round((Date.now() - startTimeRef.current) / 1000));
        }
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phase]);

  // ── Auto-flush buffer to backend ───────────────────────────────────────────
  const flushSamples = useCallback(async () => {
    const batch = pendingRef.current;
    if (!batch.length || !sessionIdRef.current) return;
    setPending([]);
    try {
      const res = await streamHrSamples({ session_id: sessionIdRef.current, samples: batch });
      setTotalRaw(res.total_raw || 0);
    } catch (err) {
      console.error('[WatchSession] stream error', err);
      // Re-queue failed samples — don't lose data
      setPending(prev => [...batch, ...prev]);
    }
  }, []);

  useEffect(() => {
    if (phase === 'recording') {
      flushRef.current = setInterval(flushSamples, STREAM_INTERVAL_MS);
    } else {
      if (flushRef.current) clearInterval(flushRef.current);
    }
    return () => { if (flushRef.current) clearInterval(flushRef.current); };
  }, [phase, flushSamples]);

  // ── Crash recovery on mount ────────────────────────────────────────────────
  useEffect(() => {
    getWatchSessionStatus().then(status => {
      if (status.active && status.session_id) {
        setSessionId(status.session_id);
        sessionIdRef.current = status.session_id;
        setTotalRaw(status.total_raw || 0);

        // ✅ FIX C-2: use the server's started_at ISO timestamp to reconstruct the
        // correct start time. The previous pattern (Date.now() - total_raw * 1000)
        // was wrong because total_raw is a *sample count*, not elapsed seconds.
        // A 20-min session with 40 manual taps would produce startTime = now − 40 s,
        // making every subsequent t_sec value incorrect and corrupting the ODE input.
        startTimeRef.current = status.started_at
          ? new Date(status.started_at).getTime()
          : Date.now();

        setPhase('recording');
        setWatchError('⚠ Recovered from an in-progress session.');
      }
    }).catch(() => {});
  }, []);

  const handleStart = async () => {
    setWatchError(null);
    setPhase('connecting');
    try {
      const params: any = { intensity };
      if (hrBase) params.hr_base = parseFloat(hrBase);
      if (hrMax)  params.hr_max  = parseFloat(hrMax);
      const res = await startWatchSession(params);
      setSessionId(res.session_id);
      sessionIdRef.current = res.session_id;
      startTimeRef.current = Date.now();
      setElapsedSec(0);
      setTotalRaw(0);
      setPending([]);
      setPhase('recording');
    } catch (err: any) {
      setWatchError('Failed to start: ' + (err?.response?.data?.error ?? err.message));
      setPhase('idle');
    }
  };

  const handleStop = async () => {
    setPhase('stopping');
    await flushSamples();
    try {
      const res = await endWatchSession({ session_id: sessionIdRef.current! });
      setLastSessionId(sessionIdRef.current);
      setPhase('done');
      onSessionComplete(res);
    } catch (err: any) {
      setWatchError('Failed to end: ' + (err?.response?.data?.error ?? err.message));
      setPhase('recording');
    }
  };

  const handleAddManual = () => {
    const bpm = parseFloat(hrInput);
    if (!bpm || bpm < 20 || bpm > 300) return;
    const t_sec = startTimeRef.current != null
      ? Math.round((Date.now() - startTimeRef.current) / 1000)
      : 0;
    setPending(prev => [...prev, { t_sec, hr_bpm: bpm }]);
    setHrInput('');
  };

  // ── Render: idle ───────────────────────────────────────────────────────────
  if (phase === 'idle') return (
    <View style={watchStyles.panel}>
      <Text style={watchStyles.title}>⌚ Start Watch Session</Text>
      <Text style={watchStyles.hint}>
        Stream real HR data from your wearable. The session is saved automatically
        and appears in the HR Live visualization.
      </Text>

      {/* Intensity selector */}
      <View style={watchStyles.intensityRow}>
        {(['light', 'moderate', 'vigorous'] as const).map(i => (
          <TouchableOpacity
            key={i}
            style={[watchStyles.intensityBtn, intensity === i && watchStyles.intensityBtnActive]}
            onPress={() => setIntensity(i)}
          >
            <Text style={[watchStyles.intensityText, intensity === i && watchStyles.intensityTextActive]}>
              {i === 'light' ? '🚶' : i === 'moderate' ? '🏃' : '⚡'} {i}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* HR inputs */}
      <View style={watchStyles.hrRow}>
        <View style={watchStyles.hrField}>
          <Text style={watchStyles.hrLabel}>Resting HR</Text>
          <TextInput
            style={watchStyles.hrInput}
            value={hrBase}
            onChangeText={setHrBase}
            keyboardType="number-pad"
            placeholder="70"
            placeholderTextColor={colors.text.secondary}
          />
        </View>
        <View style={watchStyles.hrField}>
          <Text style={watchStyles.hrLabel}>Max HR</Text>
          <TextInput
            style={watchStyles.hrInput}
            value={hrMax}
            onChangeText={setHrMax}
            keyboardType="number-pad"
            placeholder="185"
            placeholderTextColor={colors.text.secondary}
          />
        </View>
      </View>

      {watchError && <Text style={watchStyles.error}>{watchError}</Text>}

      <TouchableOpacity style={watchStyles.startBtn} onPress={handleStart}>
        <Text style={watchStyles.startBtnText}>● Start Session</Text>
      </TouchableOpacity>
    </View>
  );

  // ── Render: connecting ─────────────────────────────────────────────────────
  if (phase === 'connecting') return (
    <View style={watchStyles.panel}>
      <ActivityIndicator color={colors.primary} style={{ marginBottom: spacing.xs }} />
      <Text style={watchStyles.hint}>Connecting to server…</Text>
    </View>
  );

  // ── Render: recording ──────────────────────────────────────────────────────
  if (phase === 'recording') return (
    <View style={watchStyles.panel}>
      <View style={watchStyles.recordingHeader}>
        <Text style={watchStyles.recordingDot}>●</Text>
        <Text style={watchStyles.recordingTime}>{fmtElapsed(elapsedSec)}</Text>
        <Text style={watchStyles.sampleCount}>
          {totalRaw + pendingSamples.length} samples
        </Text>
        <TouchableOpacity style={watchStyles.stopBtn} onPress={handleStop}>
          <Text style={watchStyles.stopBtnText}>■ Stop</Text>
        </TouchableOpacity>
      </View>

      {watchError && <Text style={watchStyles.error}>{watchError}</Text>}

      {/* Manual HR entry */}
      <View style={watchStyles.manualRow}>
        <TextInput
          style={watchStyles.manualInput}
          value={hrInput}
          onChangeText={setHrInput}
          keyboardType="number-pad"
          placeholder="Type HR bpm…"
          placeholderTextColor={colors.text.secondary}
          returnKeyType="done"
          onSubmitEditing={handleAddManual}
        />
        <TouchableOpacity style={watchStyles.addSampleBtn} onPress={handleAddManual}>
          <Text style={watchStyles.addSampleText}>+ Add</Text>
        </TouchableOpacity>
      </View>

      {pendingSamples.length > 0 && (
        <Text style={watchStyles.pendingNote}>
          {pendingSamples.length} sample{pendingSamples.length !== 1 ? 's' : ''} buffered — auto-syncing…
        </Text>
      )}

      <Text style={watchStyles.sessionIdNote}>Session: {sessionId}</Text>
    </View>
  );

  // ── Render: stopping ───────────────────────────────────────────────────────
  if (phase === 'stopping') return (
    <View style={watchStyles.panel}>
      <ActivityIndicator color={colors.primary} style={{ marginBottom: spacing.xs }} />
      <Text style={watchStyles.hint}>Finalising session…</Text>
    </View>
  );

  // ── Render: done ───────────────────────────────────────────────────────────
  return (
    <View style={watchStyles.panel}>
      <Text style={watchStyles.doneTitle}>✅ Session Saved</Text>
      <Text style={watchStyles.hint}>
        {totalRaw} raw samples stored. Open the HR Live tab in Activity
        Visualization to inspect the per-second trace.
      </Text>
      {lastSessionId && (
        <Text style={watchStyles.sessionIdNote}>Session ID: {lastSessionId}</Text>
      )}
      <TouchableOpacity
        style={watchStyles.startBtn}
        onPress={() => { setPhase('idle'); setSessionId(null); setTotalRaw(0); }}
      >
        <Text style={watchStyles.startBtnText}>Start Another Session</Text>
      </TouchableOpacity>
    </View>
  );
};

// ─── PdResultPanel ────────────────────────────────────────────────────────────

interface PdResultPanelProps {
  result: ActivityPDResult;
  onDismiss: () => void;
}

const PdResultPanel: React.FC<PdResultPanelProps> = ({ result, onDismiss }) => {
  const effect   = result.cumulative_activity_effect ?? 0;
  const aob      = result.activity_on_board ?? 0;
  const mult     = result.sensitivity_multiplier ?? 1.0;
  const isf      = result.effective_correction_factor;
  const cr       = result.effective_carb_to_bg_ratio;
  const sessions = result.active_sessions ?? 0;

  return (
    <View style={pdStyles.panel}>
      <View style={pdStyles.header}>
        <Text style={pdStyles.title}>⚗ Activity PD Result</Text>
        <TouchableOpacity onPress={onDismiss} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={pdStyles.dismiss}>✕</Text>
        </TouchableOpacity>
      </View>

      <View style={pdStyles.grid}>
        <View style={pdStyles.item}>
          <Text style={pdStyles.label}>BG Effect</Text>
          <Text style={[pdStyles.value, effect < 0 ? pdStyles.negative : pdStyles.positive]}>
            {effect >= 0 ? '+' : ''}{effect.toFixed(1)} mg/dL
          </Text>
        </View>
        <View style={pdStyles.item}>
          <Text style={pdStyles.label}>Still On Board</Text>
          <Text style={pdStyles.value}>{aob.toFixed(1)} mg/dL</Text>
        </View>
        <View style={pdStyles.item}>
          <Text style={pdStyles.label}>Sensitivity Boost</Text>
          <Text style={[pdStyles.value, mult > 1 ? pdStyles.boost : null]}>
            ×{mult.toFixed(3)}
          </Text>
        </View>
        <View style={pdStyles.item}>
          <Text style={pdStyles.label}>Active Sessions</Text>
          <Text style={pdStyles.value}>{sessions}</Text>
        </View>
        {isf != null && (
          <View style={pdStyles.item}>
            <Text style={pdStyles.label}>Effective ISF</Text>
            <Text style={pdStyles.value}>{isf.toFixed(1)} mg/dL/u</Text>
          </View>
        )}
        {cr != null && (
          <View style={pdStyles.item}>
            <Text style={pdStyles.label}>Effective CR</Text>
            <Text style={pdStyles.value}>{cr.toFixed(2)} mg/dL/g</Text>
          </View>
        )}
      </View>

      {(result.activity_contributions?.length ?? 0) > 0 && (
        <View style={pdStyles.contributions}>
          {/* ✅ FIX H-1: sensitivity_multiplier is a single top-level value that applies
              to ALL sessions collectively — not a per-session field. Showing it once here
              avoids the "—" column that appeared in the previous per-row implementation. */}
          {mult > 1.0 && (
            <Text style={pdStyles.sensitivityNote}>
              Post-exercise sensitivity boost: ×{mult.toFixed(3)} (all sessions combined)
            </Text>
          )}

          <Text style={pdStyles.breakdownTitle}>
            Session breakdown ({result.activity_contributions.length})
          </Text>

          {/* Table header */}
          <View style={[pdStyles.breakdownRow, pdStyles.breakdownHeader]}>
            <Text style={[pdStyles.breakdownCell, pdStyles.breakdownHeaderText]}>Intensity</Text>
            <Text style={[pdStyles.breakdownCell, pdStyles.breakdownHeaderText]}>Duration</Text>
            <Text style={[pdStyles.breakdownCell, pdStyles.breakdownHeaderText]}>BG drop</Text>
            <Text style={[pdStyles.breakdownCell, pdStyles.breakdownHeaderText]}>Model</Text>
          </View>

          {result.activity_contributions.map((c, i) => (
            <View key={i} style={pdStyles.breakdownRow}>
              <Text style={pdStyles.breakdownCell}>{c.intensity ?? '—'}</Text>
              <Text style={pdStyles.breakdownCell}>
                {c.duration_minutes != null ? `${c.duration_minutes.toFixed(0)} min` : '—'}
              </Text>
              <Text style={[
                pdStyles.breakdownCell,
                (c.cumulative_bg_effect ?? 0) < 0 ? pdStyles.negative : null,
              ]}>
                {c.cumulative_bg_effect != null
                  ? `${c.cumulative_bg_effect.toFixed(1)}`
                  : '—'}
              </Text>
              <Text style={pdStyles.breakdownCell}>{c.model ?? 'synthetic'}</Text>
            </View>
          ))}
        </View>
      )}

      <Text style={pdStyles.meta}>
        Calculated: {result.calculated_at
          ? new Date(result.calculated_at).toLocaleTimeString()
          : '—'}
        {result.window_start && result.window_end
          ? `  ·  ${new Date(result.window_start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} → ${new Date(result.window_end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : ''}
      </Text>
    </View>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────

const UnifiedActivityInput: React.FC<UnifiedActivityInputProps> = ({
  onActivityUpdate,
  initialActivities = [],
  activityCoefficients,
  standalone = false,
  showNotes = true,
  onPdResult,
}) => {
  const [activities, setActivities]         = useState<UnifiedActivity[]>(initialActivities);
  const [showForm, setShowForm]             = useState(false);
  const [showWatchPanel, setShowWatchPanel] = useState(false);
  const [pdResult, setPdResult]             = useState<ActivityPDResult | null>(null);

  // ── Form state ─────────────────────────────────────────────────────────────
  const [currentActivity, setCurrentActivity] = useState<Partial<UnifiedActivity>>({
    level: 3,
    startTime: new Date().toISOString(),
    endTime: TimeManager.addHours(new Date(), 1).toISOString(),
    impact: 1.0,
    notes: '',
    isExpected: false,
  });

  // HR fields held separately (string-typed for TextInput)
  const [hrBase, setHrBase]   = useState('');
  const [hrMax, setHrMax]     = useState('');
  const [hrTrace, setHrTrace] = useState<HrTracePoint[]>([]);

  // Time inputs
  const [startHour, setStartHour]     = useState('');
  const [startMinute, setStartMinute] = useState('');
  const [endHour, setEndHour]         = useState('');
  const [endMinute, setEndMinute]     = useState('');

  // ── Init time inputs when form opens ───────────────────────────────────────
  useEffect(() => {
    if (showForm && currentActivity.startTime) {
      const startDate = new Date(TimeManager.parseTimestamp(currentActivity.startTime));
      const endDate   = currentActivity.endTime
        ? new Date(TimeManager.parseTimestamp(currentActivity.endTime))
        : TimeManager.addHours(startDate, 1);

      setStartHour(startDate.getHours().toString().padStart(2, '0'));
      setStartMinute(startDate.getMinutes().toString().padStart(2, '0'));
      setEndHour(endDate.getHours().toString().padStart(2, '0'));
      setEndMinute(endDate.getMinutes().toString().padStart(2, '0'));
    }
  }, [showForm]);

  // ── Impact calculation ─────────────────────────────────────────────────────
  const totalImpact = useMemo(() => {
    if (activities.length === 0) return 1.0;
    let total = 1.0;
    activities.forEach(activity => {
      const coefficient = activityCoefficients[activity.level.toString()] || 1.0;
      const [hours, minutes] = activity.duration.split(':').map(Number);
      const durationHours = hours + minutes / 60;
      const durationWeight = Math.min(durationHours / 2, 1);
      total *= 1.0 + ((coefficient - 1.0) * durationWeight);
    });
    return total;
  }, [activities, activityCoefficients]);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const getActivityImpact = (level: number) =>
    activityCoefficients[level.toString()] || 1.0;

  const handleTimeChange = (
    value: string,
    setter: React.Dispatch<React.SetStateAction<string>>,
    max: number
  ) => {
    if (value === '' || /^\d{1,2}$/.test(value)) {
      if ((parseInt(value) || 0) <= max) setter(value);
    }
  };

  const updateTimeInputs = () => {
    const now = new Date();

    const startDate = new Date(now);
    startDate.setHours(parseInt(startHour) || 0, parseInt(startMinute) || 0, 0, 0);

    const endDate = new Date(now);
    endDate.setHours(parseInt(endHour) || 0, parseInt(endMinute) || 0, 0, 0);

    // If end is before start, assume next day
    if (endDate <= startDate) endDate.setDate(endDate.getDate() + 1);

    setCurrentActivity(prev => ({
      ...prev,
      startTime: startDate.toISOString(),
      endTime:   endDate.toISOString(),
    }));
  };

  const calculateCurrentDuration = (): string => {
    if (!currentActivity.startTime || !currentActivity.endTime) return '01:00';
    const start = TimeManager.parseTimestamp(currentActivity.startTime);
    const end   = TimeManager.parseTimestamp(currentActivity.endTime);
    const dur   = TimeManager.calculateDuration(start, end);
    return `${dur.hours.toString().padStart(2, '0')}:${dur.minutes.toString().padStart(2, '0')}`;
  };

  const getLevelLabel = (level: number) =>
    SHARED_CONSTANTS.ACTIVITY_LEVELS.find(l => l.value === level)?.label || 'Unknown';

  /**
   * ✅ FIX M-4: watch-recorded sessions have intensity (string) but may have no
   * legacy level (integer). Derive from activity.intensity first, then fall back
   * to the LEVEL_TO_INTENSITY map. This prevents "Level undefined" for watch
   * sessions until the backend also writes the level field correctly.
   */
  const getIntensityLabel = (activity: UnifiedActivity): string => {
    const raw = activity.intensity || LEVEL_TO_INTENSITY[String(activity.level)] || 'light';
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  };

  const getTotalImpactDisplay = (): string => {
    if (totalImpact === 1) return 'No change';
    return `${Math.abs((totalImpact - 1) * 100).toFixed(1)}% ${totalImpact > 1 ? 'increase' : 'decrease'}`;
  };

  // ── Add activity ───────────────────────────────────────────────────────────
  const addActivity = () => {
    if (currentActivity.level == null) return;
    updateTimeInputs();

    const duration = calculateCurrentDuration();
    const [h, m]   = duration.split(':').map(Number);
    const impact   = getActivityImpact(currentActivity.level);
    const intensity = LEVEL_TO_INTENSITY[String(currentActivity.level)] || 'light';

    // Build HR payload for completed activities only
    const hrPayload: Pick<UnifiedActivity, 'hr_base' | 'hr_max' | 'hr_trace'> = {};
    if (!currentActivity.isExpected) {
      if (hrBase !== '') hrPayload.hr_base = parseFloat(hrBase);
      if (hrMax  !== '') hrPayload.hr_max  = parseFloat(hrMax);
      if (hrTrace.length > 0) {
        hrPayload.hr_trace = [...hrTrace]
          .sort((a, b) => a.t_min - b.t_min)
          .filter(pt => pt.t_min >= 0 && pt.hr_bpm > 0);
      }
    }

    const newActivity: UnifiedActivity = {
      level:            currentActivity.level,
      intensity,
      duration,
      duration_minutes: h * 60 + m,
      startTime:        currentActivity.startTime!,
      endTime:          currentActivity.endTime!,
      impact,
      notes:            currentActivity.notes || '',
      isExpected:       currentActivity.isExpected || false,
      ...hrPayload,
    };

    const newActivities = [...activities, newActivity];
    setActivities(newActivities);
    setShowForm(false);

    // Notify parent immediately with synchronous total
    const newTotalImpact = calcTotalImpactFrom(newActivities, activityCoefficients);
    onActivityUpdate(newActivities, newTotalImpact);

    // Reset form
    const now = new Date();
    setCurrentActivity({
      level: 3,
      startTime: now.toISOString(),
      endTime: TimeManager.addHours(now, 1).toISOString(),
      impact: 1.0,
      notes: '',
      isExpected: false,
    });
    setHrBase('');
    setHrMax('');
    setHrTrace([]);
    setStartHour('');
    setStartMinute('');
    setEndHour('');
    setEndMinute('');
  };

  // ── Remove activity ────────────────────────────────────────────────────────
  const removeActivity = (index: number) => {
    const newActivities = activities.filter((_, i) => i !== index);
    setActivities(newActivities);
    const newTotalImpact = calcTotalImpactFrom(newActivities, activityCoefficients);
    onActivityUpdate(newActivities, newTotalImpact);
  };

  // ── Watch session complete ─────────────────────────────────────────────────
  const handleWatchComplete = useCallback(async (result: any) => {
    setShowWatchPanel(false);
    // Non-fatal PD fetch — activity pipeline must not break if this fails
    setTimeout(async () => {
      const pd = await fetchStackedActivityEffectSafe();
      setPdResult(pd);
      onPdResult?.(pd);
    }, 800);
  }, [onPdResult]);

  const formatTime = (utcIsoString: string) =>
    TimeManager.formatTimeDisplay(utcIsoString);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>

      {/* ── Header (standalone only) ── */}
      {standalone && (
        <View style={styles.header}>
          <Text style={styles.title}>Activities</Text>
          <View style={styles.headerRight}>
            {activities.length > 0 && (
              <View style={[
                styles.impactBadge,
                totalImpact > 1 ? styles.impactIncrease :
                totalImpact < 1 ? styles.impactDecrease :
                styles.impactNeutral,
              ]}>
                <Text style={styles.impactText}>{getTotalImpactDisplay()}</Text>
              </View>
            )}
            {/* Watch session toggle */}
            <TouchableOpacity
              style={[styles.watchToggleBtn, showWatchPanel && styles.watchToggleBtnActive]}
              onPress={() => setShowWatchPanel(v => !v)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.watchToggleText}>⌚</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── Watch Session Panel (standalone only) ── */}
      {standalone && showWatchPanel && (
        <WatchSessionPanel onSessionComplete={handleWatchComplete} />
      )}

      {/* ── PD Result Panel (standalone only) ── */}
      {pdResult && (
        <PdResultPanel result={pdResult} onDismiss={() => setPdResult(null)} />
      )}

      {/* ── Activity List ── */}
      <ScrollView style={styles.activityList}>
        {activities.map((activity, index) => (
          <View
            key={index}
            style={[styles.activityItem, activity.isExpected && styles.activityItemExpected]}
          >
            <View style={styles.activityInfo}>

              {/* Level + intensity + expected badge */}
              <View style={styles.activityHeader}>
                <Text style={styles.activityLevel}>
                  {getLevelLabel(activity.level)} (Level {activity.level})
                </Text>
                <Text style={styles.intensityTag}>{getIntensityLabel(activity)}</Text>
                {activity.isExpected && (
                  <View style={styles.expectedBadge}>
                    <Text style={styles.expectedBadgeText}>Expected</Text>
                  </View>
                )}
              </View>

              {/* Time + duration */}
              <Text style={styles.activityDetails}>
                {activity.duration} • {formatTime(activity.startTime)} – {formatTime(activity.endTime)}
              </Text>

              {/* Impact */}
              <Text style={[
                styles.activityImpact,
                activity.impact > 1 ? styles.impactPositive :
                activity.impact < 1 ? styles.impactNegative : null,
              ]}>
                Impact: {((activity.impact - 1) * 100).toFixed(0)}%
              </Text>

              {/* HR summary */}
              {(activity.hr_base != null || activity.hr_max != null ||
                (activity.hr_trace?.length ?? 0) > 0) && (
                <Text style={styles.hrSummary}>
                  {'♥'}
                  {activity.hr_base != null ? ` Rest ${activity.hr_base} bpm` : ''}
                  {activity.hr_base != null && activity.hr_max != null ? ' /' : ''}
                  {activity.hr_max  != null ? ` Max ${activity.hr_max} bpm` : ''}
                  {(activity.hr_trace?.length ?? 0) > 0
                    ? ` · ${activity.hr_trace!.length} trace pts`
                    : ''}
                </Text>
              )}

              {/* Notes */}
              {activity.notes ? (
                <Text style={styles.activityNotes} numberOfLines={2}>
                  {activity.notes}
                </Text>
              ) : null}
            </View>

            <TouchableOpacity onPress={() => removeActivity(index)} style={styles.removeButton}>
              <Text style={styles.removeButtonText}>✕</Text>
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>

      {/* ── Add Activity Button ── */}
      {!showForm && (
        <TouchableOpacity style={styles.addButton} onPress={() => setShowForm(true)}>
          <Text style={styles.addButtonText}>+ Add Activity</Text>
        </TouchableOpacity>
      )}

      {/* ── Activity Form ── */}
      {showForm && (
        <View style={styles.form}>

          {/* Level */}
          <Text style={styles.formLabel}>Intensity Level</Text>
          <View style={styles.levelSelector}>
            {SHARED_CONSTANTS.ACTIVITY_LEVELS.map((level) => {
              const impact     = getActivityImpact(level.value);
              const isSelected = currentActivity.level === level.value;
              const pct        = Math.abs((impact - 1) * 100).toFixed(0);
              const dir        = impact > 1 ? '↑' : impact < 1 ? '↓' : null;

              return (
                <TouchableOpacity
                  key={level.value}
                  style={[styles.levelButton, isSelected && styles.levelButtonActive]}
                  onPress={() => setCurrentActivity({ ...currentActivity, level: level.value })}
                >
                  <Text style={[styles.levelButtonLabel, isSelected && styles.levelButtonLabelActive]}>
                    {level.label}
                  </Text>
                  <Text style={[styles.levelButtonImpact, isSelected && styles.levelButtonImpactActive]}>
                    {dir ? `${pct}% ${dir}` : 'neutral'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Time */}
          <Text style={[styles.formLabel, styles.formLabelSpacing]}>Time</Text>
          <View style={styles.timeContainer}>
            <View style={styles.timeSection}>
              <Text style={styles.timeLabel}>Start</Text>
              <View style={styles.timeInputs}>
                <TextInput
                  style={styles.timeInput}
                  value={startHour}
                  onChangeText={(t) => handleTimeChange(t, setStartHour, 23)}
                  onBlur={() => { setStartHour(p => p.padStart(2, '0')); updateTimeInputs(); }}
                  keyboardType="number-pad"
                  maxLength={2}
                  placeholder="HH"
                  placeholderTextColor={colors.text.secondary}
                  selectTextOnFocus
                />
                <Text style={styles.timeSeparator}>:</Text>
                <TextInput
                  style={styles.timeInput}
                  value={startMinute}
                  onChangeText={(t) => handleTimeChange(t, setStartMinute, 59)}
                  onBlur={() => { setStartMinute(p => p.padStart(2, '0')); updateTimeInputs(); }}
                  keyboardType="number-pad"
                  maxLength={2}
                  placeholder="MM"
                  placeholderTextColor={colors.text.secondary}
                  selectTextOnFocus
                />
              </View>
            </View>

            <View style={styles.timeSection}>
              <Text style={styles.timeLabel}>End</Text>
              <View style={styles.timeInputs}>
                <TextInput
                  style={styles.timeInput}
                  value={endHour}
                  onChangeText={(t) => handleTimeChange(t, setEndHour, 23)}
                  onBlur={() => { setEndHour(p => p.padStart(2, '0')); updateTimeInputs(); }}
                  keyboardType="number-pad"
                  maxLength={2}
                  placeholder="HH"
                  placeholderTextColor={colors.text.secondary}
                  selectTextOnFocus
                />
                <Text style={styles.timeSeparator}>:</Text>
                <TextInput
                  style={styles.timeInput}
                  value={endMinute}
                  onChangeText={(t) => handleTimeChange(t, setEndMinute, 59)}
                  onBlur={() => { setEndMinute(p => p.padStart(2, '0')); updateTimeInputs(); }}
                  keyboardType="number-pad"
                  maxLength={2}
                  placeholder="MM"
                  placeholderTextColor={colors.text.secondary}
                  selectTextOnFocus
                />
              </View>
            </View>
          </View>

          <View style={styles.durationDisplay}>
            <Text style={styles.durationText}>Duration: {calculateCurrentDuration()}</Text>
          </View>
          <Text style={styles.timezoneHint}>
            Times are in your local timezone ({TimeManager.getUserTimeZone()})
          </Text>

          {/* Expected toggle */}
          <View style={styles.expectedToggle}>
            <View style={styles.expectedToggleText}>
              <Text style={styles.formLabel}>This is an expected activity</Text>
              <Text style={styles.expectedHelp}>
                Planned ahead — can be removed if not completed
              </Text>
            </View>
            <Switch
              value={currentActivity.isExpected || false}
              onValueChange={(value) =>
                setCurrentActivity({ ...currentActivity, isExpected: value })
              }
              trackColor={{ false: colors.border, true: colors.primary + '40' }}
              thumbColor={currentActivity.isExpected ? colors.primary : colors.surface}
            />
          </View>

          {/* HR Section — completed activities only */}
          {!currentActivity.isExpected && (
            <HrSection
              hrBase={hrBase}
              hrMax={hrMax}
              hrTrace={hrTrace}
              onHrBaseChange={setHrBase}
              onHrMaxChange={setHrMax}
              onHrTraceChange={setHrTrace}
            />
          )}

          {/* Notes */}
          {showNotes && (
            <>
              <Text style={[styles.formLabel, styles.formLabelSpacing]}>Notes (Optional)</Text>
              <TextInput
                style={styles.notesInput}
                value={currentActivity.notes}
                onChangeText={(val) => setCurrentActivity({ ...currentActivity, notes: val })}
                placeholder="Add notes about this activity..."
                placeholderTextColor={colors.text.secondary}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
              />
            </>
          )}

          {/* Form buttons */}
          <View style={styles.formButtons}>
            <TouchableOpacity
              style={[styles.button, styles.cancelButton]}
              onPress={() => setShowForm(false)}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, styles.saveButton]} onPress={addActivity}>
              <Text style={styles.saveButtonText}>Add</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
};

// ─── StyleSheets ──────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  title: {
    ...typography.h3,
    color: colors.text.primary,
  },
  impactBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
  },
  impactIncrease: { backgroundColor: colors.success + '20' },
  impactDecrease: { backgroundColor: colors.danger + '20' },
  impactNeutral:  { backgroundColor: colors.surfaceVariant },
  impactText: {
    ...typography.small,
    fontWeight: '600',
    color: colors.text.primary,
  },
  watchToggleBtn: {
    width: 34,
    height: 34,
    borderRadius: borderRadius.md,
    backgroundColor: colors.surfaceVariant,
    alignItems: 'center',
    justifyContent: 'center',
  },
  watchToggleBtnActive: {
    backgroundColor: colors.danger + '20',
  },
  watchToggleText: {
    fontSize: 18,
  },
  activityList: {
    maxHeight: 300,
  },
  activityItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.sm,
    backgroundColor: colors.surfaceVariant,
    borderRadius: borderRadius.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  activityItemExpected: {
    borderColor: colors.warning,
    backgroundColor: colors.warning + '10',
  },
  activityInfo: {
    flex: 1,
  },
  activityHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  activityLevel: {
    ...typography.body,
    fontWeight: '600',
    color: colors.text.primary,
  },
  intensityTag: {
    ...typography.caption,
    color: colors.text.secondary,
    backgroundColor: colors.surfaceVariant,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
  },
  expectedBadge: {
    backgroundColor: colors.warning,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  expectedBadgeText: {
    ...typography.caption,
    color: colors.surface,
    fontWeight: '600',
  },
  activityDetails: {
    ...typography.small,
    color: colors.text.secondary,
    marginBottom: spacing.xs,
  },
  activityImpact: {
    ...typography.small,
    fontWeight: '600',
    color: colors.primary,
  },
  impactPositive: { color: colors.success },
  impactNegative: { color: colors.danger },
  hrSummary: {
    ...typography.caption,
    color: colors.text.secondary,
    marginTop: spacing.xs,
  },
  activityNotes: {
    ...typography.caption,
    color: colors.text.secondary,
    marginTop: spacing.xs,
    fontStyle: 'italic',
  },
  removeButton: {
    padding: spacing.sm,
    marginLeft: spacing.xs,
  },
  removeButtonText: {
    fontSize: 20,
    color: colors.danger,
    fontWeight: '600',
  },
  addButton: {
    backgroundColor: colors.primary + '15',
    paddingVertical: 7,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  addButtonText: {
    ...typography.body,
    color: colors.primary,
    fontWeight: '600',
  },
  form: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  formLabel: {
    ...typography.body,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: 4,
  },
  formLabelSpacing: {
    marginTop: spacing.sm,
  },
  levelSelector: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    gap: 4,
  },
  levelButton: {
    flex: 1,
    backgroundColor: colors.surfaceVariant,
    paddingVertical: 5,
    paddingHorizontal: 2,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  levelButtonActive: {
    backgroundColor: colors.primary + '15',
    borderColor: colors.primary,
  },
  levelButtonLabel: {
    ...typography.caption,
    fontSize: 10,
    color: colors.text.secondary,
    marginBottom: 1,
  },
  levelButtonLabelActive: {
    color: colors.primary,
    fontWeight: '600',
  },
  levelButtonImpact: {
    color: colors.text.secondary,
    fontSize: 9,
  },
  levelButtonImpactActive: {
    color: colors.primary,
    fontWeight: '600',
  },
  timeContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  timeSection: {
    flex: 1,
  },
  timeLabel: {
    ...typography.small,
    color: colors.text.secondary,
    marginBottom: spacing.xs,
  },
  timeInputs: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeInput: {
    ...typography.body,
    backgroundColor: colors.surfaceVariant,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: 4,
    textAlign: 'center',
    width: 42,
    color: colors.text.primary,
  },
  timeSeparator: {
    ...typography.body,
    color: colors.text.primary,
    marginHorizontal: spacing.xs,
  },
  durationDisplay: {
    alignItems: 'center',
    marginVertical: 4,
  },
  durationText: {
    ...typography.small,
    color: colors.text.secondary,
    fontWeight: '600',
  },
  timezoneHint: {
    ...typography.caption,
    color: colors.text.secondary,
    fontStyle: 'italic',
    textAlign: 'center',
    marginBottom: 4,
  },
  expectedToggle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surfaceVariant,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.md,
    marginTop: spacing.sm,
  },
  expectedToggleText: {
    flex: 1,
    marginRight: spacing.sm,
  },
  expectedHelp: {
    ...typography.caption,
    color: colors.text.secondary,
    marginTop: 2,
  },
  notesInput: {
    ...typography.body,
    backgroundColor: colors.surfaceVariant,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    minHeight: 60,
    color: colors.text.primary,
  },
  formButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  button: {
    flex: 1,
    padding: spacing.sm,
    borderRadius: borderRadius.md,
    alignItems: 'center',
  },
  cancelButton: {
    backgroundColor: colors.surfaceVariant,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelButtonText: {
    ...typography.body,
    color: colors.text.secondary,
    fontWeight: '600',
  },
  saveButton: {
    backgroundColor: colors.primary,
  },
  saveButtonText: {
    ...typography.body,
    color: colors.text.inverse,
    fontWeight: '600',
  },
});

// ─── HrSection styles ─────────────────────────────────────────────────────────

const hrStyles = StyleSheet.create({
  container: {
    marginTop: spacing.sm,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.surfaceVariant,
  },
  toggleLabel: {
    ...typography.small,
    color: colors.text.primary,
    fontWeight: '600',
    flex: 1,
  },
  optional: {
    ...typography.caption,
    color: colors.text.secondary,
    fontWeight: '400',
  },
  toggleRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  badge: {
    backgroundColor: colors.primary + '30',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  badgeText: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: '600',
  },
  chevron: {
    fontSize: 10,
    color: colors.text.secondary,
  },
  fields: {
    padding: spacing.sm,
  },
  hint: {
    ...typography.caption,
    color: colors.text.secondary,
    marginBottom: spacing.sm,
  },
  baseRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  baseGroup: {
    flex: 1,
  },
  baseLabel: {
    ...typography.caption,
    color: colors.text.secondary,
    marginBottom: 4,
  },
  baseInput: {
    ...typography.body,
    backgroundColor: colors.surfaceVariant,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: 4,
    color: colors.text.primary,
  },
  traceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  traceTitle: {
    ...typography.small,
    fontWeight: '600',
    color: colors.text.primary,
  },
  addPointBtn: {
    backgroundColor: colors.primary + '20',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: borderRadius.sm,
  },
  addPointText: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: '600',
  },
  emptyHint: {
    ...typography.caption,
    color: colors.text.secondary,
    fontStyle: 'italic',
  },
  emptyHintExample: {
    color: colors.text.secondary,
  },
  rowHint: {
    ...typography.caption,
    color: colors.text.secondary,
    marginBottom: spacing.xs,
    fontStyle: 'italic',
  },
  traceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  traceLabel: {
    ...typography.caption,
    color: colors.text.secondary,
  },
  traceInput: {
    ...typography.body,
    backgroundColor: colors.surfaceVariant,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: 3,
    width: 52,
    textAlign: 'center',
    color: colors.text.primary,
  },
  removePoint: {
    paddingHorizontal: spacing.xs,
  },
  removePointText: {
    fontSize: 16,
    color: colors.danger,
  },
});

// ─── WatchSessionPanel styles ─────────────────────────────────────────────────

const watchStyles = StyleSheet.create({
  panel: {
    backgroundColor: colors.surfaceVariant,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: {
    ...typography.body,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  doneTitle: {
    ...typography.body,
    fontWeight: '700',
    color: colors.success,
    marginBottom: spacing.xs,
  },
  hint: {
    ...typography.small,
    color: colors.text.secondary,
    marginBottom: spacing.sm,
  },
  intensityRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  intensityBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.surface,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  intensityBtnActive: {
    backgroundColor: colors.primary + '20',
    borderColor: colors.primary,
  },
  intensityText: {
    ...typography.caption,
    color: colors.text.secondary,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  intensityTextActive: {
    color: colors.primary,
  },
  hrRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  hrField: {
    flex: 1,
  },
  hrLabel: {
    ...typography.caption,
    color: colors.text.secondary,
    marginBottom: 4,
  },
  hrInput: {
    ...typography.body,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    color: colors.text.primary,
  },
  error: {
    ...typography.small,
    color: colors.danger,
    marginBottom: spacing.sm,
  },
  startBtn: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  startBtnText: {
    ...typography.body,
    color: colors.text.inverse,
    fontWeight: '700',
  },
  recordingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  recordingDot: {
    fontSize: 16,
    color: colors.danger,
  },
  recordingTime: {
    ...typography.body,
    fontWeight: '700',
    color: colors.text.primary,
    flex: 1,
  },
  sampleCount: {
    ...typography.small,
    color: colors.text.secondary,
  },
  stopBtn: {
    backgroundColor: colors.danger,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: borderRadius.sm,
  },
  stopBtnText: {
    ...typography.small,
    color: colors.text.inverse,
    fontWeight: '700',
  },
  manualRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  manualInput: {
    ...typography.body,
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    color: colors.text.primary,
  },
  addSampleBtn: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: borderRadius.sm,
    justifyContent: 'center',
  },
  addSampleText: {
    ...typography.body,
    color: colors.text.inverse,
    fontWeight: '600',
  },
  pendingNote: {
    ...typography.caption,
    color: colors.text.secondary,
    fontStyle: 'italic',
    marginBottom: spacing.xs,
  },
  sessionIdNote: {
    ...typography.caption,
    color: colors.text.secondary,
    marginTop: spacing.xs,
  },
});

// ─── PdResultPanel styles ─────────────────────────────────────────────────────

const pdStyles = StyleSheet.create({
  panel: {
    backgroundColor: colors.surfaceVariant,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  title: {
    ...typography.body,
    fontWeight: '700',
    color: colors.text.primary,
  },
  dismiss: {
    fontSize: 18,
    color: colors.text.secondary,
    paddingHorizontal: spacing.xs,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  item: {
    width: '47%',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.sm,
    padding: spacing.sm,
  },
  label: {
    ...typography.caption,
    color: colors.text.secondary,
    marginBottom: 2,
  },
  value: {
    ...typography.body,
    fontWeight: '600',
    color: colors.text.primary,
  },
  negative: { color: colors.success },   // BG-lowering is good
  positive: { color: colors.danger },    // BG-raising
  boost:    { color: colors.warning },
  contributions: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  sensitivityNote: {
    ...typography.small,
    color: colors.text.secondary,
    fontStyle: 'italic',
    marginBottom: spacing.xs,
  },
  breakdownTitle: {
    ...typography.small,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  breakdownRow: {
    flexDirection: 'row',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  breakdownHeader: {
    backgroundColor: colors.surfaceVariant,
  },
  breakdownHeaderText: {
    fontWeight: '600',
  },
  breakdownCell: {
    ...typography.caption,
    flex: 1,
    color: colors.text.primary,
  },
  meta: {
    ...typography.caption,
    color: colors.text.secondary,
    marginTop: spacing.sm,
  },
});

export default UnifiedActivityInput;