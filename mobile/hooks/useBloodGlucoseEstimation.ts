/**
 * Blood Glucose Estimation Hook - UNIFIED WITH WEB CONTEXT
 * Matches BloodSugarDataContext.js logic exactly
 * Location: mobile/hooks/useBloodGlucoseEstimation.ts
 *
 * Single source of truth for baseline blood glucose estimation with decay
 * DEFAULT: Returns to target glucose over 3 hours using exponential decay
 *
 * Changes (fix C-1, fix 11.5):
 *   - Imports fetchStackedActivityEffectSafe from activity-pharmacodynamics service.
 *   - Adds lastActivityFetchTimeRef and lastActivityPDRef for 30-second debounce.
 *   - Fetches activityPD inside the data-fetch cycle with the same guard as
 *     BloodSugarDataContext.js (§6.2 of spec).
 *   - Passes activityPD into calculateNetEffect (if/when called downstream).
 *   - Exposes cumulativeActivityEffect, activitySensitivityMultiplier, activityOnBoard
 *     on the hook return value.
 *   - Null result from network failure is treated as zero effect — never breaks
 *     the BG pipeline.
 *
 * Changes (P8 — §9-M-13, glucose buffer inlined):
 *   - useGlucoseBuffer is no longer a separate file or import. All of its
 *     state (buffer, bufferLoading, bufferError), refs (bufferRangeStartRef),
 *     fetch logic (fetchBuffer), minute-boundary polling useEffect, and
 *     client-side filter (bufferReadings useMemo) are inlined directly here.
 *   - Removed: import from '@/hooks/useGlucoseBuffer'.
 *   - Added:   import { parseUTCMs } from '@/utils/ChartUtils'
 *              import apiClient from '@/services/api/client'
 *              import API from '@/services/api/endpoints'
 *   - GlucoseReading interface is now defined locally in the Types section.
 *   - GlucoseReading[] from the buffer is mapped to BloodSugarResponse[] via
 *     useMemo and synced into recentReadings via useEffect so all downstream
 *     estimation logic (generateLast24hEstimatedData, calculateBaselineFromData)
 *     is unchanged.
 *   - fetchRecentReadings renamed to fetchActivityPD; it handles only the
 *     activity-pharmacodynamics fetch (30 s debounce retained).
 *   - refresh() resets the activity debounce, calls refreshBuffer (= fetchBuffer),
 *     and calls fetchActivityPD() — matching the previous full-refresh contract.
 *   - isLoading is derived from bufferLoading || activityFetching.
 *   - error is derived from bufferError ?? activityError.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { parseUTCMs } from '@/utils/ChartUtils';
import apiClient from '@/services/api/client';
import API from '@/services/api/endpoints';
import {
  getCircadianBaseline,
  BASELINE_MODES,
  type BaselineMode,
  type CircadianProfile,
  type PatientConstants,
} from '@/constants/shared-constants';
import type { BloodSugarResponse } from '@/types/api';
import {
  fetchStackedActivityEffectSafe,
  type ActivityPDResult,
} from '@/services/api/activity-pharmacodynamics';

// ─── 30-second activity fetch debounce (fix 11.5) ────────────────────────────
// Prevents hammering the PD endpoint on rapid re-renders / retroactive-data
// events within a single poll cycle, complementing the backend's 60-second
// TTL cache.  Mirrors the ACTIVITY_FETCH_MIN_INTERVAL_MS guard in
// BloodSugarDataContext.js.
const ACTIVITY_FETCH_MIN_INTERVAL_MS = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Normalised glucose reading shared by useGlucoseBuffer and the inlined buffer
 * inside useBloodGlucoseEstimation.
 *
 * Migrated from @/hooks/useGlucoseBuffer → here (P8 — §9-M-13).
 * BloodGlucoseChart and BloodGlucoseVisualization import this type from
 * @/hooks/useBloodGlucoseEstimation (the shim at useGlucoseBuffer re-exports it
 * for backward compatibility during the transition).
 */
export interface GlucoseReading {
  timestamp:  number;   // ms since epoch
  bloodSugar: number;
  source?:    string;
}

export interface EstimatedBG {
  value: number;
  timestamp: number;
  source: 'actual' | 'last_actual' | 'estimated' | 'target' | 'loading';
  isActual: boolean;
  confidence: 'high' | 'medium' | 'low' | 'initializing';
  dataPoint?: BloodSugarResponse;
}

export interface UseBloodGlucoseEstimationOptions {
  targetGlucose?: number;
  refreshInterval?: number; // milliseconds
  maxReadingAge?: number; // minutes (unused in web context logic)
  stabilizationHours?: number; // hours to return to target (DEFAULT: 3 hours)
  /**
   * When false, all API calls and intervals are skipped entirely.
   * Use this to prevent patient-only endpoints being hit during doctor sessions.
   * React hook rules are satisfied — the hook is still called, but is inert.
   * Default: true
   */
  enabled?: boolean;
  /**
   * 🆕 v4.3: Patient constants — used to read baseline_mode and circadian_profile.
   * When baseline_mode === 'preset', calculateBaselineFromData() returns the
   * circadian profile value at the current local hour instead of interpolating
   * between readings. Omitting this prop defaults to 'dynamic' mode.
   *
   * ✅ IMPORTANT: Pass the `constants` object from `usePatientConstants()` (or
   * directly from `usePatientStore()`) — NOT a locally cached snapshot.  The
   * `baselineModeRef` inside this hook stays in sync on every render only when
   * the parent re-renders with the freshly Zustand-updated value.  If the caller
   * passes a stale reference, mode changes from the settings screen will not
   * propagate here until the next re-render triggered by something else.
   *
   * Correct usage:
   *   const { constants } = usePatientConstants();
   *   useBloodGlucoseEstimation({ patientConstants: constants });
   */
  patientConstants?: PatientConstants;
}

interface ProcessedReading extends BloodSugarResponse {
  readingTime: number;
  isActualReading: boolean;
  isInterpolated: boolean;
  isEstimated: boolean;
  dataType: 'actual' | 'estimated';
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export const useBloodGlucoseEstimation = (
  options: UseBloodGlucoseEstimationOptions = {}
) => {
  const {
    targetGlucose = 100,
    refreshInterval = 2 * 60 * 1000, // 2 minutes
    stabilizationHours = 3, // 🔥 DEFAULT: 3 HOURS to return to target
    enabled = true,
    patientConstants,
  } = options;

  // 🆕 v4.3: Resolve baseline mode from patient constants.
  // Stored in a ref so calculateBaselineFromData (a useCallback) always reads
  // the CURRENT value without needing to be in its dependency array.
  // Previously this was a plain const, meaning the callback closed over the
  // initial value and never saw mode changes until the component re-mounted.
  const baselineModeRef = useRef<BaselineMode>(
    (patientConstants?.baseline_mode ?? 'dynamic') as BaselineMode
  );
  // Keep the ref in sync on every render so fresh renders always see the latest.
  baselineModeRef.current = (patientConstants?.baseline_mode ?? 'dynamic') as BaselineMode;
  // Expose as a plain const for the existing inline usage below.
  const baselineMode = baselineModeRef.current;

  // ── Inlined glucose buffer (P8 — §9-M-13) ────────────────────────────────
  // Previously useGlucoseBuffer(@/hooks/useGlucoseBuffer). All fetch,
  // normalisation, polling, and client-filter logic lives inline here.
  //
  // Fetch strategy — double-bound start time:
  //   startTime = Math.min(rangeStart − 30 min, now − 26 h)
  // Guarantees the full 24 h estimation window is always covered regardless
  // of wall-clock drift since mount.
  //
  // Polling: fires immediately on mount, snaps to the next :00 minute
  // boundary, then re-fires every refreshInterval — co-firing with the
  // recalculateBaseline interval below.
  //
  // Client filter: bufferReadings is derived synchronously from the
  // in-memory buffer — zero network cost for the live "now" tick advance.

  // rangeStart is fixed at mount; the double-bound formula still covers the
  // full window as wall-clock time advances.
  const [rangeStart]    = useState(() => Date.now() - 24 * 3_600_000);
  const [buffer,        setBuffer]        = useState<GlucoseReading[]>([]);
  const [bufferLoading, setBufferLoading] = useState(true);
  const [bufferError,   setBufferError]   = useState<string | null>(null);

  // Ref keeps fetchBuffer stable (empty useCallback deps) while always
  // reading the latest rangeStart on every invocation.
  const bufferRangeStartRef = useRef(rangeStart);
  bufferRangeStartRef.current = rangeStart;

  const fetchBuffer = useCallback(async () => {
    setBufferLoading(true);
    setBufferError(null);
    try {
      const now          = Date.now();
      const rangeBasedMs = bufferRangeStartRef.current - 30 * 60_000;
      const minimumMs    = now - 26 * 3_600_000; // max(24, pastHours=24 + 2) h
      const startTime    = Math.min(rangeBasedMs, minimumMs);

      const response: any = await (apiClient as any).get(API.BLOOD_SUGAR.LIST, {
        params: {
          start_time: new Date(startTime).toISOString(),
          end_time:   new Date(now).toISOString(),
          filter_by:  'reading_time',
        },
      });

      const raw: any[] = Array.isArray(response)
        ? response
        : response?.data ?? response?.readings ?? [];

      const normalised: GlucoseReading[] = raw
        .map((r: any) => {
          // bloodSugarTimestamp checked first — primary field for both
          // LibreLinkUp CGM readings and manual /api/blood-sugar entries.
          // Without this ordering every reading falls back to NaN and is
          // discarded by the filter below.
          const ts =
            r.bloodSugarTimestamp != null ? parseUTCMs(r.bloodSugarTimestamp) :
            r.timestamp           != null ? parseUTCMs(r.timestamp)           :
            r.readingTime         != null ? parseUTCMs(r.readingTime)         :
            r.reading_time        != null ? parseUTCMs(r.reading_time)        :
            r.taken_at            != null ? parseUTCMs(r.taken_at)            : NaN;

          const bg = r.bloodSugar ?? r.blood_sugar ?? r.value ?? r.glucose_value ?? NaN;

          return { timestamp: ts, bloodSugar: Number(bg), source: r.source ?? 'meter' };
        })
        .filter(r => !isNaN(r.timestamp) && !isNaN(r.bloodSugar) && r.bloodSugar > 0)
        .sort((a, b) => a.timestamp - b.timestamp);

      setBuffer(normalised);
      console.log(
        `[BGEstimation] fetched ${normalised.length} readings ` +
        `from ${new Date(startTime).toISOString()} → now (${raw.length} raw)`,
      );
    } catch (err: any) {
      console.warn('[BGEstimation] readings fetch failed:', err?.message);
      setBufferError(err?.message ?? 'Failed to load readings');
    } finally {
      setBufferLoading(false);
    }
  }, []); // empty — mutable deps accessed via refs

  // Fire immediately on mount / rangeStart change; snap to the next minute
  // boundary before arming the recurring interval so periodic fetches
  // co-fire with recalculateBaseline on the same wall-clock tick.
  useEffect(() => {
    fetchBuffer();
    const msUntilNextMinute = 60_000 - (Date.now() % 60_000);
    let intervalId: ReturnType<typeof setInterval>;
    const timeoutId = setTimeout(() => {
      fetchBuffer();
      intervalId = setInterval(fetchBuffer, refreshInterval);
    }, msUntilNextMinute);
    return () => {
      clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
    };
  // rangeStart: new fetch required when the visible window shifts.
  // refreshInterval: interval must be re-armed if cadence changes.
  // fetchBuffer: stable ref (empty useCallback deps) — listed for exhaustive-deps.
  }, [fetchBuffer, refreshInterval, rangeStart]);

  // Client-side slice of the buffer — synchronous, zero network cost.
  const bufferReadings = useMemo(
    () => buffer.filter(r => r.timestamp >= rangeStart && r.timestamp <= Date.now()),
    [buffer, rangeStart],
  );

  // Alias so refresh() and the comment below read naturally.
  const refreshBuffer = fetchBuffer;

  const [estimatedBG, setEstimatedBG] = useState<EstimatedBG>({
    value: targetGlucose,
    timestamp: Date.now(),
    source: 'loading',
    isActual: false,
    confidence: 'initializing',
  });

  const [recentReadings, setRecentReadings] = useState<BloodSugarResponse[]>([]);
  const [combinedData, setCombinedData] = useState<ProcessedReading[]>([]);

  // isLoading / error are derived — not primary state.
  // bufferLoading / bufferError come from the inlined glucose buffer above.
  const [activityFetching, setActivityFetching] = useState(false);
  const [activityError,    setActivityError]    = useState<string | null>(null);

  const isLoading = bufferLoading || activityFetching;
  const error     = bufferError   ?? activityError;

  // ── Activity PD state ─────────────────────────────────────────────────────
  // Exposed on the hook return value; initialised to zero-effect defaults so
  // the UI renders safely before the first successful fetch.
  const [activityPD, setActivityPD] = useState<ActivityPDResult | null>(null);

  // ── Internal refs ─────────────────────────────────────────────────────────
  const processing24hData = useRef(false);
  const baselineCalculatedRef = useRef(false);

  // fix 11.5: debounce refs for activity PD fetch
  const lastActivityFetchTimeRef = useRef<number>(0);
  const lastActivityPDRef = useRef<ActivityPDResult | null>(null);

  /**
   * Model blood glucose decay - MATCHES WEB APP LOGIC EXACTLY
   * Returns to target glucose over stabilizationHours using exponential decay
   *
   * Formula: BG(t) = target + (initial - target) * (1 - exponentialReturn)
   * where exponentialReturn = 1 - e^(-3 * ratio)
   */
  const modelBloodGlucose = useCallback(
    (startReading: BloodSugarResponse, elapsedMinutes: number): number => {
      const baseValue = startReading.bloodSugar;
      const stabilizationMinutes = stabilizationHours * 60;

      if (elapsedMinutes < stabilizationMinutes) {
        const stabilizationRatio = elapsedMinutes / stabilizationMinutes;
        const exponentialReturn = 1 - Math.exp(-3 * stabilizationRatio);
        return targetGlucose + (baseValue - targetGlucose) * (1 - exponentialReturn);
      }

      return targetGlucose;
    },
    [targetGlucose, stabilizationHours]
  );

  /**
   * 🔥 UNIFIED: Calculate baseline from combined data (MATCHES WEB CONTEXT)
   */
  const calculateBaselineFromData = useCallback(
    (combinedDataToUse: ProcessedReading[]): EstimatedBG => {
      // ── 🆕 v4.3: Preset (circadian) mode ──────────────────────────────────
      // Read from ref — not the closed-over const — so mode changes are
      // always picked up without recreating this callback.
      if (baselineModeRef.current === 'preset') {
        const now = new Date();
        const tzOffsetMin = patientConstants?.timezone_offset_minutes ?? 0;
        const localHour = (
          now.getUTCHours() +
          now.getUTCMinutes() / 60 +
          now.getUTCSeconds() / 3600 +
          tzOffsetMin / 60
        ) % 24;

        const circadianValue = getCircadianBaseline(
          localHour,
          patientConstants?.circadian_profile as CircadianProfile | undefined
        );

        console.log(
          '[BG Estimation] Preset circadian baseline:',
          circadianValue,
          'mg/dL @ local hour',
          localHour.toFixed(2)
        );

        return {
          value: Math.round(circadianValue),
          timestamp: Date.now(),
          source: 'estimated',
          isActual: false,
          confidence: 'medium',
        };
      }

      // ── Dynamic mode — original reading-interpolation logic ────────────────
      if (!combinedDataToUse || combinedDataToUse.length === 0) {
        console.log('[BG Estimation] No combined data available for baseline calculation');
        return {
          value: targetGlucose,
          timestamp: Date.now(),
          source: 'target',
          isActual: false,
          confidence: 'low'
        };
      }

      const now = Date.now();

      let closestPoint: ProcessedReading | null = null;
      let minDiff = Infinity;

      for (const point of combinedDataToUse) {
        const diff = Math.abs(point.readingTime - now);
        if (diff < minDiff && diff <= 15 * 60 * 1000) {
          minDiff = diff;
          closestPoint = point;
        }
      }

      if (closestPoint) {
        const estimatedValue = closestPoint.bloodSugar || targetGlucose;
        console.log('[BG Estimation] Found closest point for baseline:', {
          value: Math.round(estimatedValue),
          source: closestPoint.isActualReading ? 'actual' : 'estimated',
          timeDiff: Math.round(minDiff / 60000) + ' min'
        });
        return {
          value: Math.round(estimatedValue),
          timestamp: closestPoint.readingTime,
          source: closestPoint.isActualReading ? 'actual' : 'estimated',
          isActual: closestPoint.isActualReading,
          dataPoint: closestPoint,
          confidence: minDiff < 5 * 60 * 1000 ? 'high' : 'medium'
        };
      }

      for (let i = combinedDataToUse.length - 1; i >= 0; i--) {
        const point = combinedDataToUse[i];
        if (point.isActualReading && point.bloodSugar && point.readingTime <= now) {
          console.log('[BG Estimation] Using last actual reading for baseline:', Math.round(point.bloodSugar));
          return {
            value: Math.round(point.bloodSugar),
            timestamp: point.readingTime,
            source: 'last_actual',
            isActual: true,
            dataPoint: point,
            confidence: 'medium'
          };
        }
      }

      const lastPoint = combinedDataToUse[combinedDataToUse.length - 1];
      if (lastPoint && lastPoint.bloodSugar) {
        console.log('[BG Estimation] Using last point for baseline:', Math.round(lastPoint.bloodSugar));
        return {
          value: Math.round(lastPoint.bloodSugar),
          timestamp: lastPoint.readingTime,
          source: 'estimated',
          isActual: false,
          dataPoint: lastPoint,
          confidence: 'low'
        };
      }

      console.log('[BG Estimation] No suitable point found, using target glucose');
      return {
        value: targetGlucose,
        timestamp: now,
        source: 'target',
        isActual: false,
        confidence: 'low'
      };
    },
    [targetGlucose, baselineMode, patientConstants]
  );

  /**
   * 🔥 UNIFIED: Generate 24h estimated data (MATCHES WEB CONTEXT EXACTLY)
   */
  const generateLast24hEstimatedData = useCallback(() => {
    if (processing24hData.current || recentReadings.length === 0) {
      console.log('[BG Estimation] Skipping 24h data generation - already processing or no data');
      return;
    }

    processing24hData.current = true;
    console.log('[BG Estimation] Starting 24h data generation with', recentReadings.length, 'actual readings');

    try {
      const now = Date.now();
      const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);
      const minimumMinutesBetweenPoints = 15;
      const intervalMs = minimumMinutesBetweenPoints * 60 * 1000;

      const generateEstimatedPoints = (
        startPoint: ProcessedReading,
        endTime: number,
        actualReadings: ProcessedReading[]
      ): ProcessedReading[] => {
        const points: ProcessedReading[] = [];
        const startTime = startPoint.readingTime;
        const totalGapMinutes = (endTime - startTime) / (60 * 1000);

        if (totalGapMinutes < minimumMinutesBetweenPoints / 2) return points;

        let currentTime = startTime + intervalMs;

        if (startPoint.isActualReading) {
          const thirtyMinutesAfterActual = startTime + (30 * 60 * 1000);
          const hasNearbyReading = actualReadings.some(reading => {
            const timeDiff = reading.readingTime - startTime;
            return timeDiff > 0 && timeDiff < 29 * 60 * 1000;
          });

          if (!hasNearbyReading && thirtyMinutesAfterActual < endTime) {
            const glucoseValue = modelBloodGlucose(startPoint, 30);
            points.push({
              ...startPoint,
              readingTime: thirtyMinutesAfterActual,
              bloodSugar: glucoseValue,
              isActualReading: false,
              isInterpolated: true,
              isEstimated: true,
              dataType: 'estimated'
            });
            currentTime = Math.ceil((thirtyMinutesAfterActual + intervalMs) / intervalMs) * intervalMs;
          }
        }

        while (currentTime < endTime) {
          const elapsedMinutes = (currentTime - startTime) / (60 * 1000);
          const glucoseValue = modelBloodGlucose(startPoint, elapsedMinutes);

          points.push({
            ...startPoint,
            readingTime: currentTime,
            bloodSugar: glucoseValue,
            isActualReading: false,
            isInterpolated: true,
            isEstimated: true,
            dataType: 'estimated'
          });

          currentTime += intervalMs;
        }

        return points;
      };

      let estimatedPoints: ProcessedReading[] = [];

      const sortedActualReadings: ProcessedReading[] = [...recentReadings]
        .sort((a, b) =>
          new Date(a.bloodSugarTimestamp || a.timestamp).getTime() -
          new Date(b.bloodSugarTimestamp || b.timestamp).getTime()
        )
        .map(reading => ({
          ...reading,
          readingTime: new Date(reading.bloodSugarTimestamp || reading.timestamp).getTime(),
          isActualReading: true,
          isInterpolated: false,
          isEstimated: false,
          dataType: 'actual' as const
        }));

      if (sortedActualReadings.length > 0 && sortedActualReadings[0].readingTime > twentyFourHoursAgo) {
        const startPoint: ProcessedReading = {
          ...sortedActualReadings[0],
          readingTime: twentyFourHoursAgo,
          bloodSugar: targetGlucose,
          isActualReading: false,
          isInterpolated: true,
          isEstimated: true,
          dataType: 'estimated'
        };

        estimatedPoints.push(startPoint);
        const pointsToFirst = generateEstimatedPoints(
          startPoint,
          sortedActualReadings[0].readingTime,
          sortedActualReadings
        );
        estimatedPoints = [...estimatedPoints, ...pointsToFirst];
      }

      for (let i = 0; i < sortedActualReadings.length; i++) {
        estimatedPoints.push({
          ...sortedActualReadings[i],
          isEstimated: true
        });

        if (i < sortedActualReadings.length - 1) {
          const pointsBetween = generateEstimatedPoints(
            sortedActualReadings[i],
            sortedActualReadings[i + 1].readingTime,
            sortedActualReadings
          );
          estimatedPoints = [...estimatedPoints, ...pointsBetween];
        } else {
          if (sortedActualReadings[i].readingTime < now) {
            const pointsToNow = generateEstimatedPoints(
              sortedActualReadings[i],
              now,
              sortedActualReadings
            );
            estimatedPoints = [...estimatedPoints, ...pointsToNow];
          }
        }
      }

      const combined = [...sortedActualReadings, ...estimatedPoints.filter(p => p.isInterpolated)];
      combined.sort((a, b) => a.readingTime - b.readingTime);

      console.log(`[BG Estimation] Generated ${combined.length} points for 24h baseline (${sortedActualReadings.length} actual, ${estimatedPoints.filter(p => p.isInterpolated).length} estimated)`);

      const newBaseline = calculateBaselineFromData(combined);

      console.log('[BG Estimation] Calculated baseline BEFORE state update:', {
        value: newBaseline.value,
        source: newBaseline.source
      });

      setCombinedData(combined);
      setEstimatedBG(newBaseline);
      baselineCalculatedRef.current = true;

      console.log('[BG Estimation] 24h data generation complete, baseline set to:', newBaseline.value);

    } catch (err) {
      console.error('[BG Estimation] Error generating 24h estimated data:', err);
    } finally {
      processing24hData.current = false;
    }
  }, [recentReadings, targetGlucose, stabilizationHours, modelBloodGlucose, calculateBaselineFromData]);

  /**
   * Fetch activity pharmacodynamics only.
   * Glucose readings are now handled entirely by the inlined buffer above;
   * this callback is responsible solely for the 30-second-debounced activity
   * PD fetch that runs in parallel with the buffer's own polling.
   *
   * A null activityPD result (network failure) is treated as zero effect.
   */
  const fetchActivityPD = useCallback(async () => {
    const nowMs = Date.now();
    if (nowMs - lastActivityFetchTimeRef.current < ACTIVITY_FETCH_MIN_INTERVAL_MS) {
      console.log('[BG Estimation] Activity PD: serving from debounce ref');
      return;
    }

    setActivityFetching(true);
    setActivityError(null);
    try {
      console.log('[BG Estimation] Fetching activity PD...');
      const result = await fetchStackedActivityEffectSafe(new Date());
      lastActivityFetchTimeRef.current = nowMs;
      lastActivityPDRef.current = result;
      setActivityPD(result);
      console.log('[BG Estimation] Activity PD:', result
        ? `effect=${result.cumulative_activity_effect} mg/dL, cached=${result.cached}`
        : 'null (zero effect applied)',
      );
    } catch (err: any) {
      console.warn('[BG Estimation] Activity PD fetch failed:', err?.message);
      setActivityError(err?.message ?? 'Failed to fetch activity PD');
    } finally {
      setActivityFetching(false);
    }
  }, []);

  /**
   * Recalculate baseline periodically (every minute)
   */
  const recalculateBaseline = useCallback(() => {
    if (combinedData.length > 0) {
      const baseline = calculateBaselineFromData(combinedData);
      setEstimatedBG(baseline);

      console.log('[BG Estimation] Recalculated baseline:', {
        value: baseline.value,
        source: baseline.source,
      });
    }
  }, [combinedData, calculateBaselineFromData]);

  /**
   * Manual refresh function
   */
  const refresh = useCallback(() => {
    console.log('[BG Estimation] Manual refresh triggered');
    // Reset the activity debounce ref so a manual pull-to-refresh always
    // triggers a fresh activityPD fetch, matching the previous behaviour
    // (Goal 10c / audit).
    lastActivityFetchTimeRef.current = 0;
    // Re-fetch both glucose (via buffer) and activity PD.
    refreshBuffer();
    return fetchActivityPD();
  }, [refreshBuffer, fetchActivityPD]);

  // ── Map GlucoseReading[] → BloodSugarResponse[] ───────────────────────────
  // The inlined buffer normalises timestamps to plain ms numbers (GlucoseReading);
  // downstream processing (generateLast24hEstimatedData) expects the
  // BloodSugarResponse shape with bloodSugarTimestamp / timestamp as ISO strings.
  const mappedBufferReadings = useMemo<BloodSugarResponse[]>(
    () => bufferReadings.map((r: GlucoseReading) => ({
      bloodSugar:          r.bloodSugar,
      bloodSugarTimestamp: new Date(r.timestamp).toISOString(),
      timestamp:           new Date(r.timestamp).toISOString(),
      source:              r.source ?? 'meter',
    } as BloodSugarResponse)),
    [bufferReadings],
  );

  // Sync mapped readings into local state so the existing downstream effects
  // (generateLast24hEstimatedData) react exactly as before.
  useEffect(() => {
    if (!enabled) return;
    setRecentReadings(mappedBufferReadings);
  }, [enabled, mappedBufferReadings]);

  // Generate 24h data when readings change
  useEffect(() => {
    if (!enabled) return;
    if (recentReadings.length > 0) {
      console.log('[BG Estimation] recentReadings changed, triggering generation');
      generateLast24hEstimatedData();
    }
  }, [enabled, recentReadings, generateLast24hEstimatedData]);

  // ── Baseline-mode change: immediate recalculation ──────────────────────────
  // When patientConstants.baseline_mode flips between 'dynamic' and 'preset',
  // the estimatedBG must update right away.  calculateBaselineFromData already
  // reads baselineModeRef.current (not the stale closed-over const), so calling
  // recalculateBaseline() here is sufficient — no data refetch needed.
  useEffect(() => {
    if (!enabled || combinedData.length === 0) return;
    console.log('[BG Estimation] baseline_mode changed to', baselineModeRef.current, '— recalculating immediately');
    const newBaseline = calculateBaselineFromData(combinedData);
    setEstimatedBG(newBaseline);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientConstants?.baseline_mode]); // intentionally narrow: only react to mode changes

  // Stable refs to avoid re-registering intervals on every re-render
  const fetchActivityPDRef      = useRef(fetchActivityPD);
  const recalculateBaselineRef  = useRef(recalculateBaseline);
  useEffect(() => { fetchActivityPDRef.current     = fetchActivityPD;     }, [fetchActivityPD]);
  useEffect(() => { recalculateBaselineRef.current = recalculateBaseline; }, [recalculateBaseline]);

  /**
   * Initial activity PD fetch and periodic refresh.
   * Glucose polling is handled by the inlined buffer (fetchBuffer / useEffect
   * above); only the activity PD interval is managed here.
   * Skipped entirely when enabled=false (e.g. doctor sessions).
   */
  useEffect(() => {
    if (!enabled) {
      console.log('[BG Estimation] Disabled — skipping fetch and intervals');
      return;
    }

    console.log('[BG Estimation] Hook initialized with', stabilizationHours, 'hour decay');
    fetchActivityPDRef.current();

    const activityInterval = setInterval(() => {
      console.log('[BG Estimation] Activity PD auto-refresh triggered');
      fetchActivityPDRef.current();
    }, refreshInterval);

    const recalcInterval = setInterval(() => {
      recalculateBaselineRef.current();
    }, 60 * 1000);

    return () => {
      console.log('[BG Estimation] Hook cleanup');
      clearInterval(activityInterval);
      clearInterval(recalcInterval);
    };
  }, [enabled, refreshInterval, stabilizationHours]);

  // ── Derived activity fields (zero-safe defaults) ──────────────────────────
  const cumulativeActivityEffect      = activityPD?.cumulative_activity_effect ?? 0;
  const activitySensitivityMultiplier = activityPD?.sensitivity_multiplier     ?? 1.0;
  const activityOnBoard               = activityPD?.activity_on_board          ?? 0;

  return {
    estimatedBG,
    recentReadings,
    combinedData,
    isLoading,
    error,
    refresh,
    modelBloodGlucose,
    stabilizationHours,
    // ── Activity PD fields (fix C-1) ─────────────────────────────────────────
    /** Raw activity PD response; null when unavailable (treat as zero effect) */
    activityPD,
    /**
     * Signed BG contribution from exercise (mg/dL).
     * Negative = BG-lowering. 0 when no data.
     */
    cumulativeActivityEffect,
    /**
     * Post-exercise ISF/CR sensitivity multiplier (≥ 1.0).
     * 1.0 = no boost. effective_correction_factor in PD response is pre-multiplied.
     */
    activitySensitivityMultiplier,
    /**
     * Unsigned remaining acute BG drop (mg/dL). Analogous to IOB.
     * 0 when no data.
     */
    activityOnBoard,
  };
};

export default useBloodGlucoseEstimation;

// ─────────────────────────────────────────────────────────────────────────────
// useGlucoseBuffer — migrated from @/hooks/useGlucoseBuffer (P8 — §9-M-13)
//
// BloodGlucoseChart and BloodGlucoseVisualization call this as a standalone hook
// with component-specific rangeStart / pastHours / logPrefix arguments.
// Keeping it here (rather than inlining into each chart) avoids duplicating the
// fetch pipeline a third and fourth time — the shared export is the right pattern
// for components that need a configurable, independently-polled glucose buffer.
//
// GlucoseReading is defined and exported above so both callers (the inlined
// buffer inside useBloodGlucoseEstimation and these chart consumers) share one
// canonical type definition.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch, buffer, and client-filter blood glucose readings for a given time range.
 *
 * @param rangeStart        - Visible window start (ms). Fetch extends further back
 *                            using the double-bound formula below.
 * @param rangeEnd          - Visible window end (ms). Used only for the client-side
 *                            filter — rangeEnd changes never trigger a new fetch.
 * @param pastHours         - Nominal past-hours depth for the minimum-lookback bound.
 *                            Pass viewConfig.pastHours so short views still fetch
 *                            enough data. Defaults to 24.
 * @param refreshIntervalMs - Periodic re-fetch cadence after the minute-boundary snap.
 *                            Defaults to 60 000 ms (once per minute).
 * @param logPrefix         - Component label for fetch log messages.
 *                            Defaults to 'GlucoseBuffer'.
 */
export function useGlucoseBuffer(
  rangeStart:        number,
  rangeEnd:          number,
  pastHours:         number = 24,
  refreshIntervalMs: number = 60_000,
  logPrefix:         string = 'GlucoseBuffer',
): {
  readings:  GlucoseReading[];
  isLoading: boolean;
  error:     string | null;
  refresh:   () => void;
} {
  const [buffer,    setBuffer]    = useState<GlucoseReading[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error,     setError]     = useState<string | null>(null);

  // Refs keep fetchBuffer reference stable (empty useCallback deps) while
  // still reading the latest values on every invocation.
  const pastHoursRef    = useRef(pastHours);
  pastHoursRef.current  = pastHours;
  const rangeStartRef   = useRef(rangeStart);
  rangeStartRef.current = rangeStart;
  const logPrefixRef    = useRef(logPrefix);
  logPrefixRef.current  = logPrefix;

  const fetchBuffer = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const now = Date.now();

      // Double-bound fetch start:
      //   startTime = Math.min(rangeStart − 30 min, now − max(24, pastHours + 2) h)
      // Guarantees the full visible window is always covered regardless of
      // view mode or daily-reset timing.
      const rangeBasedMs = rangeStartRef.current - 30 * 60_000;
      const minimumMs    = now - Math.max(24, pastHoursRef.current + 2) * 3_600_000;
      const startTime    = Math.min(rangeBasedMs, minimumMs);

      const response: any = await (apiClient as any).get(API.BLOOD_SUGAR.LIST, {
        params: {
          start_time: new Date(startTime).toISOString(),
          end_time:   new Date(now).toISOString(),
          filter_by:  'reading_time',
        },
      });

      const raw: any[] = Array.isArray(response)
        ? response
        : response?.data ?? response?.readings ?? [];

      const normalised: GlucoseReading[] = raw
        .map((r: any) => {
          // bloodSugarTimestamp checked first — primary field for both
          // LibreLinkUp CGM readings and manual /api/blood-sugar entries.
          const ts =
            r.bloodSugarTimestamp != null ? parseUTCMs(r.bloodSugarTimestamp) :
            r.timestamp           != null ? parseUTCMs(r.timestamp)           :
            r.readingTime         != null ? parseUTCMs(r.readingTime)         :
            r.reading_time        != null ? parseUTCMs(r.reading_time)        :
            r.taken_at            != null ? parseUTCMs(r.taken_at)            : NaN;

          const bg = r.bloodSugar ?? r.blood_sugar ?? r.value ?? r.glucose_value ?? NaN;

          return {
            timestamp:  ts,
            bloodSugar: Number(bg),
            source:     r.source ?? 'meter',
          };
        })
        .filter(r => !isNaN(r.timestamp) && !isNaN(r.bloodSugar) && r.bloodSugar > 0)
        .sort((a, b) => a.timestamp - b.timestamp);

      setBuffer(normalised);
      console.log(
        `[${logPrefixRef.current}] fetched ${normalised.length} readings ` +
        `from ${new Date(startTime).toISOString()} → now (${raw.length} raw)`,
      );
    } catch (err: any) {
      console.warn(`[${logPrefixRef.current}] readings fetch failed:`, err?.message);
      setError(err?.message ?? 'Failed to load readings');
    } finally {
      setIsLoading(false);
    }
  }, []); // empty — mutable deps accessed via refs

  // Fire immediately on mount / rangeStart change; snap to next minute boundary
  // before arming the recurring interval so periodic fetches co-fire with
  // useCurrentMinute() on the same wall-clock tick.
  useEffect(() => {
    fetchBuffer();

    const msUntilNextMinute = 60_000 - (Date.now() % 60_000);
    let intervalId: ReturnType<typeof setInterval>;

    const timeoutId = setTimeout(() => {
      fetchBuffer();
      intervalId = setInterval(fetchBuffer, refreshIntervalMs);
    }, msUntilNextMinute);

    return () => {
      clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
    };
  // rangeStart: new fetch required when the visible window shifts.
  // refreshIntervalMs: interval must be re-armed if cadence changes.
  // fetchBuffer: stable ref (empty useCallback deps) — listed for exhaustive-deps.
  }, [fetchBuffer, refreshIntervalMs, rangeStart]);

  // Client-side slice — synchronous, zero network cost.
  const readings = useMemo(
    () => buffer.filter(r => r.timestamp >= rangeStart && r.timestamp <= rangeEnd),
    [buffer, rangeStart, rangeEnd],
  );

  return { readings, isLoading, error, refresh: fetchBuffer };
}