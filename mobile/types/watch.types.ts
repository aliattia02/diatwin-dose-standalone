/**
 * watch.types.ts — Google Fit HR Sync type definitions for DiaTwin
 * Location: mobile/types/watch.types.ts
 *
 * Mirrors libre.types.ts patterns.
 */

// ─── Connection ───────────────────────────────────────────────────────────────

export interface WatchConnectionStatus {
  connected: boolean;
  google_email?: string;
  google_name?: string;
  auto_sync_enabled?: boolean;
  sync_interval_minutes?: number;
  /** ISO string of last successful sync */
  last_sync?: string | null;
  connected_at?: string;
}

// ─── Sync result ─────────────────────────────────────────────────────────────

export interface WatchSyncResult {
  new_count: number;
  skipped_count: number;
  latest_session: WatchSyncSession | null;
  message?: string;
}

export interface WatchSyncSession {
  session_id: string;
  intensity: 'light' | 'moderate' | 'vigorous';
  start_time: string;
  duration_minutes: number;
}

// ─── API payloads / responses ─────────────────────────────────────────────────

export interface WatchConnectPayload {
  /** OAuth authorisation code returned by Google's consent screen */
  code: string;
}

export interface WatchConnectResponse {
  message: string;
  status: WatchConnectionStatus;
  sync_result: WatchSyncResult;
}

export interface WatchOAuthUrlResponse {
  url: string;
}

export interface WatchSettingsPayload {
  auto_sync_enabled?: boolean;
  sync_interval_minutes?: number;
  hr_base?: number;
  hr_max?: number;
}

// ─── Display helpers ──────────────────────────────────────────────────────────

export function getIntensityColor(intensity: string): string {
  switch (intensity) {
    case 'vigorous': return '#ef4444';
    case 'moderate': return '#f97316';
    case 'light':    return '#22c55e';
    default:         return '#6b7280';
  }
}

export function getIntensityLabel(intensity: string): string {
  return intensity.charAt(0).toUpperCase() + intensity.slice(1);
}

/** Human-readable relative time: '3 min ago', '2 hr ago', etc. */
export function timeAgo(isoString: string): string {
  const diffMs  = Date.now() - new Date(isoString).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 2)   return 'just now';
  if (diffMin < 60)  return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24)   return `${diffHr} hr ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
}
