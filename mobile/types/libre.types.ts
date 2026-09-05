/**
 * LibreLinkUp CGM type definitions for DiaTwin
 * Location: mobile/types/libre.types.ts
 *
 * Mirrors glucose.types.ts patterns. All readings stored as mg/dL.
 */

// ─── Trend ────────────────────────────────────────────────────────────────────

/**
 * LibreLinkUp numeric trend arrow codes (1–5)
 *  1 = rapidly rising  ↑↑
 *  2 = rising          ↑
 *  3 = stable          →
 *  4 = falling         ↓
 *  5 = rapidly falling ↓↓
 */
export type LibreTrendCode = 1 | 2 | 3 | 4 | 5;

export const TREND_ARROW: Record<LibreTrendCode, string> = {
  1: '↑↑',
  2: '↑',
  3: '→',
  4: '↓',
  5: '↓↓',
};

export const TREND_LABEL: Record<LibreTrendCode, string> = {
  1: 'Rapidly Rising',
  2: 'Rising',
  3: 'Stable',
  4: 'Falling',
  5: 'Rapidly Falling',
};

// ─── Reading ──────────────────────────────────────────────────────────────────

/** 0 = automatic CGM scan, 1 = manual NFC scan, 2 = fingerstick calibration */
export type LibreReadingType = 0 | 1 | 2;

export const READING_TYPE_LABEL: Record<LibreReadingType, string> = {
  0: 'CGM',
  1: 'Scan',
  2: 'Fingerstick',
};

export interface LibreReading {
  /** MongoDB _id of blood_sugar document */
  _id: string;
  /** Blood glucose value in mg/dL */
  bloodSugar: number;
  /** ISO 8601 string — actual sensor reading time */
  bloodSugarTimestamp: string;
  /** Status relative to patient target */
  status: 'low' | 'normal' | 'high' | 'unknown';
  /** LibreLinkUp trend code 1–5 (null if unavailable) */
  trend: LibreTrendCode | null;
  /** Human-readable trend label */
  trend_label: string;
  /** True if reading exceeded high threshold */
  is_high: boolean;
  /** True if reading was below low threshold */
  is_low: boolean;
  /** How the reading was captured */
  reading_type: LibreReadingType;
  /** Always 'libre_cgm' */
  source: 'libre_cgm';
}

// ─── Connection ───────────────────────────────────────────────────────────────

export type LibreRegion =
  | 'EU' | 'EU2' | 'US' | 'DE' | 'FR' | 'JP' | 'AP' | 'AU' | 'AE';

export interface LibreRegionOption {
  value: LibreRegion;
  label: string;
}

export const LIBRE_REGION_OPTIONS: LibreRegionOption[] = [
  { value: 'EU',  label: 'Europe (default)' },
  { value: 'EU2', label: 'Europe 2' },
  { value: 'US',  label: 'United States' },
  { value: 'DE',  label: 'Germany' },
  { value: 'FR',  label: 'France' },
  { value: 'JP',  label: 'Japan' },
  { value: 'AP',  label: 'Asia Pacific' },
  { value: 'AU',  label: 'Australia' },
  { value: 'AE',  label: 'UAE / Middle East' },
];

export interface LibreConnectionStatus {
  connected: boolean;
  first_name?: string;
  last_name?: string;
  country?: string;
  region?: LibreRegion;
  patient_id?: string;
  auto_sync_enabled?: boolean;
  sync_interval_minutes?: number;
  /** ISO string of last successful sync */
  last_sync?: string | null;
  total_readings_synced?: number;
  /** ISO string — when the auth token expires */
  token_expires?: string | null;
  connected_at?: string;
  live_fetch_error?: string;
  /** Latest reading (only present when fetch_latest=true) */
  latest_reading?: LibreReading | null;
}

// ─── API payloads / responses ─────────────────────────────────────────────────

export interface LibreConnectPayload {
  email: string;
  password: string;
  region?: LibreRegion;
}

export interface LibreSyncResult {
  new_count: number;
  skipped_count: number;
  latest_reading: LibreReading | null;
  error?: string;
}

export interface LibreConnectResponse {
  message: string;
  status: LibreConnectionStatus;
  sync_result: LibreSyncResult;
}

export interface LibreReadingsResponse {
  readings: LibreReading[];
  count: number;
  synced: boolean;
  sync_result: LibreSyncResult | null;
}

export interface LibreSettingsPayload {
  auto_sync_enabled?: boolean;
  sync_interval_minutes?: number;
}

// ─── Display helpers ──────────────────────────────────────────────────────────

export function getTrendArrow(trend: LibreTrendCode | null | undefined): string {
  if (!trend) return '–';
  return TREND_ARROW[trend] ?? '–';
}

export function getTrendLabel(trend: LibreTrendCode | null | undefined): string {
  if (!trend) return 'Unknown';
  return TREND_LABEL[trend] ?? 'Unknown';
}

/** Returns a hex colour for a reading based on status */
export function getReadingColor(reading: LibreReading): string {
  if (reading.is_low  || reading.status === 'low')  return '#ef4444';
  if (reading.is_high || reading.status === 'high') return '#f97316';
  return '#22c55e';
}

/** Returns a hex colour for a trend arrow */
export function getTrendColor(trend: LibreTrendCode | null | undefined): string {
  if (!trend) return '#6b7280';
  if (trend === 1 || trend === 5) return '#ef4444'; // rapidly up/down
  if (trend === 2 || trend === 4) return '#f97316'; // up/down
  return '#22c55e';                                  // stable
}

/** Return a local-timezone YYYY-MM-DD string for a Date object.
 *  Uses device-local getFullYear/Month/Date — same timezone as toLocaleTimeString
 *  used by formatReadingTime — so day-bucket keys are consistent with display. */
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Groups an array of readings by calendar date string (YYYY-MM-DD, device local time). */
export function groupReadingsByDay(
  readings: LibreReading[]
): { date: string; readings: LibreReading[] }[] {
  const map = new Map<string, LibreReading[]>();

  for (const r of readings) {
    // toUtcDate parses the stored UTC ISO string; getFullYear() etc. return
    // device-local date — consistent with formatReadingTime's display timezone.
    const day = localDateStr(toUtcDate(r.bloodSugarTimestamp));
    if (!map.has(day)) map.set(day, []);
    map.get(day)!.push(r);
  }

  // Newest day first, readings within each day newest first
  return Array.from(map.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, readings]) => ({
      date,
      readings: readings.sort((a, b) =>
        b.bloodSugarTimestamp.localeCompare(a.bloodSugarTimestamp)
      ),
    }));
}

/** Format a date string like 'YYYY-MM-DD' → 'Today', 'Yesterday', or 'Mon 12 Jan' */
export function formatDayLabel(dateStr: string): string {
  const now       = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  // FIX: compare against local-date strings, not today.toISOString() (which is
  // UTC date and diverges from local date near midnight for UTC+2/+3 users).
  if (dateStr === localDateStr(now))       return 'Today';
  if (dateStr === localDateStr(yesterday)) return 'Yesterday';

  const d = new Date(dateStr + 'T12:00:00'); // noon anchor avoids DST edge cases
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Ensure ISO string is parsed as UTC (adds Z if missing) */
function toUtcDate(isoString: string): Date {
  const s = isoString.endsWith('Z') || isoString.includes('+') ? isoString : isoString + 'Z';
  return new Date(s);
}

/** Format a full ISO timestamp to HH:MM in local time */
export function formatReadingTime(isoString: string): string {
  return toUtcDate(isoString).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Human-readable relative time: '3 min ago', '2 hr ago', etc. */
export function timeAgo(isoString: string): string {
  const diffMs  = Date.now() - toUtcDate(isoString).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 2)   return 'just now';
  if (diffMin < 60)  return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24)   return `${diffHr} hr ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
}