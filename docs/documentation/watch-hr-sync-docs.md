# Google Fit Watch HR Sync — Implementation Documentation

**Feature:** Background heart-rate polling from Google Fit (or any Wear OS / Galaxy Watch / Pixel Watch that syncs to Google Fit), automatically converted into DiaTwin activity sessions that feed the ODE pharmacodynamics model.

**Pattern:** Mirrors the LibreLinkUp CGM integration exactly — one-time OAuth handshake, backend scheduler owns all subsequent syncing, mobile app is only involved at setup.

---

## Table of Contents

1. [Architecture overview](#1-architecture-overview)
2. [File tree](#2-file-tree)
3. [Data flow](#3-data-flow)
4. [File-by-file reference](#4-file-by-file-reference)
5. [Wiring checklist](#5-wiring-checklist)
6. [Environment variables](#6-environment-variables)
7. [Google Cloud Console setup](#7-google-cloud-console-setup)
8. [MongoDB collections & indexes](#8-mongodb-collections--indexes)
9. [API endpoint reference](#9-api-endpoint-reference)
10. [Parallel with LibreLinkUp](#10-parallel-with-librelinkup)
11. [What was NOT changed](#11-what-was-not-changed)

---

## 1. Architecture overview

```
┌─────────────────────────────────────────────────────┐
│                   Mobile App (Expo)                 │
│                                                     │
│  profile.tsx          WatchSyncWidget               │
│  /(settings)/watch    → watch-connect.tsx (OAuth)   │
│  services/api/        → watch-sync.ts               │
│                       → endpoints.ts  (API.WATCH.*) │
│  hooks/               → useActiveEffects.ts         │
│                         (consumes ACTIVITY_PD.*)    │
└─────────────┬───────────────────────────────────────┘
              │  POST /api/watch/connect  { code }
              │  (one time only)
              ▼
┌─────────────────────────────────────────────────────┐
│                Flask Backend (Render)               │
│                                                     │
│  watch_sync_routes.py    ← new blueprint            │
│  watch_sync_service.py   ← OAuth + Fit polling      │
│  watch_scheduler.py      ← APScheduler 15-min job   │
│                                                     │
│  [existing, unchanged]                              │
│  watch_hr_routes.py      ← live streaming           │
│  watch_hr_autosegment.py ← segment_hr_stream()      │
│  activity_pharmacodynamics_routes.py ← ODE          │
└─────────────┬───────────────────────────────────────┘
              │  GET  /fitness/v1/users/me/dataset:aggregate
              │  (every 15 min per connected user)
              ▼
┌─────────────────────────────────────────────────────┐
│             Google Fit REST API                     │
│  (aggregates HR from Pixel Watch, Galaxy Watch,     │
│   Wear OS, Fitbit-via-Health-Connect, etc.)         │
└─────────────────────────────────────────────────────┘
```

---

## 2. File tree

Files marked `[NEW]` were created by this implementation.
Files marked `[UPDATED]` received targeted additions; existing logic is unchanged.
Everything else is untouched.

```
native3/
├── backend/
│   ├── routes/
│   │   ├── watch_hr_routes.py          (existing — live HR streaming)
│   │   ├── watch_sync_routes.py        [NEW] OAuth connect/status/sync endpoints
│   │   └── watch_test_routes.py        [NEW] Dev-only test data injection (blocked on Render)
│   │
│   ├── services/
│   │   └── watch_sync_service.py       [NEW] Google OAuth + Fit REST polling
│   │
│   ├── utils/
│   │   └── watch_hr_autosegment.py     (existing — segment_hr_stream(), unchanged)
│   │
│   ├── main.py                         [UPDATED] +watch_sync_bp, +watch_scheduler
│   ├── watch_scheduler.py              [NEW] APScheduler 15-min background job
│   └── setup_watch_indexes.py          [NEW] MongoDB index creation script
│
├── mobile/
│   ├── app/
│   │   └── (app)/
│   │       └── settings/
│   │           ├── watch-connect.tsx   [NEW] Google OAuth WebView screen
│   │           └── watch.tsx           [NEW] Settings/status screen + DEV test data UI
│   │
│   ├── components/
│   │   └── (tabs)/
│   │       └── profile.tsx             [UPDATED] +WatchSyncWidget, +onWatch handler,
│   │                                             +Google Fit settings link
│   │
│   ├── hooks/
│   │   └── useActiveEffects.ts         [UPDATED] +Activity PD fetch (ACTIVITY_PD.STACKED),
│   │                                             +activityEffect / sensitivityMultiplier /
│   │                                              activityOnBoard / activityPDResult fields
│   │
│   ├── services/
│   │   └── api/
│   │       ├── watch-sync.ts           [NEW] API service (mirrors libre.ts)
│   │       └── endpoints.ts            [UPDATED] +API.WATCH block, +API.ACTIVITY_PD block
│   │
│   └── types/
│       └── watch.types.ts              [NEW] TypeScript types (mirrors libre.types.ts)
```

> **File naming note:** the types file is `watch.types.ts` (dot-separated, matching the project convention used by `libre.types.ts`). Do not use an underscore.

---

## 3. Data flow

### 3a. One-time connect (mobile → backend → Google)

```
User taps "Connect Google Fit"
        │
        ▼
GET /api/watch/oauth-url          ← API.WATCH.OAUTH_URL
        │  returns Google consent URL
        ▼
WebView opens accounts.google.com/o/oauth2/v2/auth
  ?client_id=...
  &scope=fitness.heart_rate.read fitness.activity.read
  &access_type=offline
  &prompt=consent          ← forces refresh_token on every connect
        │
        │  User grants access
        ▼
Google redirects to com.diatwin.mobile://auth/watch?code=<auth_code>
        │
        │  WebView onShouldStartLoadWithRequest intercepts redirect URI
        │  (onNavigationStateChange also fires as a fallback)
        ▼
POST /api/watch/connect  { "code": "<auth_code>" }   ← API.WATCH.CONNECT
        │
        ▼
watch_sync_service.connect_watch()
  1. exchange_auth_code()    → access_token + refresh_token from Google
  2. fetch_google_user_info() → name + email for display
  3. upsert watch_connections document
  4. _perform_sync()          → first sync immediately
        │
        ▼
Response: { message, status, sync_result }
Alert shown → navigate to /(app)/settings/watch
```

### 3b. Background auto-sync (every 15 min, no user involvement)

```
APScheduler wakes up (watch_scheduler.py)
        │
        ├── _ping_self()   GET /api/health  ← Render free-tier keep-alive
        │
        ▼
mongo.db.watch_connections.find({ auto_sync_enabled: True })
        │
        │  for each connected user:
        ▼
_ensure_valid_token()
  if access_token expired → POST /o/oauth2/token (refresh_token grant)
                          → update watch_connections with new token
        │
        ▼
fetch_google_fit_hr(access_token, since=last_sync-5min, until=now)
  POST https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate
  { aggregateBy: [heart_rate.bpm], bucketByTime: 60000ms }
  Filters out physiologically impossible values (< 20 or > 300 bpm).
  Safety cap: MAX_HR_SAMPLES_PER_SYNC = 3 600 samples per call.
        │
        │  returns list of { timestamp_iso, hr_bpm }
        ▼
segment_hr_stream(samples)         ← EXISTING function, unchanged
        │
        │  returns list of NormalisedSession dicts
        ▼
session_to_activity_doc()          ← EXISTING function, unchanged
        │
        │  [doc field normalisation — see §12]
        │  • startTime / endTime  → ISO-8601 "Z" strings  (not BSON Dates)
        │  • completedTime        = startTime
        │  • notes                = "" if missing
        │  • level / impact       mapped from intensity string
        │  • timestamp            = wall-clock UTC datetime of insertion
        ▼
mongo.db.activities.insert_one()
  source: "google_fit"
        │
        ▼
update watch_connections.last_sync = now
        │
        ▼
ODE pharmacodynamics (activity_pharmacodynamics_routes.py)
picks up new activity docs automatically — no changes needed.

useActiveEffects.ts polls GET /api/activity/pharmacodynamics (ACTIVITY_PD.STACKED)
every 30 s (debounced) and surfaces the result as activityEffect /
sensitivityMultiplier / activityOnBoard in the active-effects hook.
```

---

## 4. File-by-file reference

### `backend/routes/watch_sync_routes.py` [NEW]

Flask Blueprint (`watch_sync_bp`) registered at root prefix `''`.

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/watch/oauth-url` | GET | ✅ token | Returns Google consent URL for WebView |
| `/api/watch/connect` | POST | ✅ token | Exchange auth code; store tokens; first sync |
| `/api/watch/status` | GET | ✅ token | Connection status (no tokens exposed) |
| `/api/watch/sync` | POST | ✅ token | Manual on-demand sync |
| `/api/watch/settings` | PUT | ✅ token | Toggle auto_sync, set interval, set hr_base/hr_max |
| `/api/watch/disconnect` | DELETE | ✅ token | Remove tokens; optionally delete activity data |

---

### `backend/services/watch_sync_service.py` [NEW]

| Function | Description |
|---|---|
| `exchange_auth_code(code)` | Google token endpoint — code → access + refresh tokens |
| `refresh_access_token(refresh_token)` | Google token endpoint — refresh grant |
| `_ensure_valid_token(conn)` | Checks expiry (5-min margin), auto-refreshes, persists new token |
| `fetch_google_fit_hr(token, since, until)` | Polls Google Fit aggregate API → `[{timestamp_iso, hr_bpm}]`. Filters bpm outside 20–300; caps at 3 600 samples. |
| `fetch_google_user_info(token)` | Returns `{email, name}` from Google's userinfo endpoint |
| `_perform_sync(user_id, conn)` | Full sync cycle: token → Fit poll (with 5-min overlap on `since`) → segment → insert |
| `connect_watch(user_id, auth_code)` | One-time connect: exchange + profile + upsert + first sync. Raises `ValueError` if Google omits `refresh_token`. |

Key constants in the module:
- `SYNC_WINDOW_MINUTES = 60` — how far back to look on a user's very first sync
- `MAX_HR_SAMPLES_PER_SYNC = 3_600` — safety cap (1 Hz × 60 min)

---

### `backend/watch_scheduler.py` [NEW]

APScheduler `BackgroundScheduler` running inside the Flask process.

| Setting | Value |
|---|---|
| Wake interval | Every **15 minutes** |
| Min per-user interval | 15 minutes (enforced regardless of user setting) |
| Max parallel instances | 1 (coalesce=True prevents overlap) |
| Keep-alive | Pings `GET /api/health` on every wake (same as Libre scheduler) |
| Timezone | UTC |
| Job ID | `watch_auto_sync` |

---

### `backend/setup_watch_indexes.py` [NEW]

Run once after deploy:
```bash
python setup_watch_indexes.py
```

Creates:
- `watch_connections`: unique index on `user_id`
- `activities`: compound index on `(user_id, source, startTime DESC)` for Google Fit queries

---

### `mobile/services/api/watch-sync.ts` [NEW]

Thin Axios wrapper around `apiClient`. Functions mirror `libre.ts` exactly:

| Function | Endpoint constant | HTTP |
|---|---|---|
| `getWatchOAuthUrl()` | `API.WATCH.OAUTH_URL` | GET |
| `connectWatch(payload)` | `API.WATCH.CONNECT` | POST |
| `getWatchStatus()` | `API.WATCH.STATUS` | GET |
| `syncWatch()` | `API.WATCH.SYNC` | POST |
| `updateWatchSettings(settings)` | `API.WATCH.SETTINGS` | PUT |
| `disconnectWatch(deleteActivities?)` | `API.WATCH.DISCONNECT` | DELETE |

> **Import note:** The file ships with a local `WATCH` constant object for standalone use (the comment at the top explains how to migrate to `API.WATCH.*` from `endpoints.ts`). If you prefer to centralise endpoint paths — which is the project convention — replace the local constant with:
> ```typescript
> import API from '@/services/api/endpoints';
> // then use API.WATCH.OAUTH_URL, API.WATCH.CONNECT, etc.
> ```
> Both approaches produce identical runtime URLs. `endpoints.ts` now exports `API.WATCH` (see §4 `endpoints.ts` entry below).

---

### `mobile/services/api/endpoints.ts` [UPDATED]

Added two new blocks:

**`API.ACTIVITY_PD`** — HR ODE exercise pharmacodynamics endpoints consumed by `useActiveEffects.ts`:

| Key | Path | HTTP |
|---|---|---|
| `STACKED` | `/api/activity/pharmacodynamics` | GET |
| `AOB` | `/api/activity/pharmacodynamics/aob` | GET |
| `PREVIEW` | `/api/activity/pharmacodynamics/preview` | POST |

**`API.WATCH`** — Google Fit OAuth + background sync endpoints consumed by `watch-sync.ts`:

| Key | Path | HTTP |
|---|---|---|
| `OAUTH_URL` | `/api/watch/oauth-url` | GET |
| `CONNECT` | `/api/watch/connect` | POST |
| `STATUS` | `/api/watch/status` | GET |
| `SYNC` | `/api/watch/sync` | POST |
| `SETTINGS` | `/api/watch/settings` | PUT |
| `DISCONNECT` | `/api/watch/disconnect` | DELETE |

`logEndpoints()` was updated to log all six `WATCH.*` keys.

---

### `mobile/types/watch.types.ts` [NEW]

Key types:

```typescript
WatchConnectionStatus   // GET /api/watch/status response
WatchSyncResult         // sync summary { new_count, skipped_count, latest_session }
WatchConnectResponse    // POST /api/watch/connect response
WatchSettingsPayload    // PUT /api/watch/settings body
```

Helper functions: `getIntensityColor()`, `getIntensityLabel()`, `timeAgo()`.

---

### `mobile/app/(app)/settings/watch-connect.tsx` [NEW]

OAuth handshake screen. Flow:

1. `handlePressConnect()` → calls `getWatchOAuthUrl()` → opens `<WebView>` inside a `<Modal>` with the consent URL.
2. Both `onShouldStartLoadWithRequest` and `onNavigationStateChange` watch for the redirect URI prefix `com.diatwin.mobile://auth/watch`. `onShouldStartLoadWithRequest` fires first and returns `false` so the WebView never tries to resolve the deep link as a URL.
3. `handleWebViewNav()` extracts `?code=` from the redirect URL with a regex match.
4. Calls `connectWatch({ code })` → shows success `Alert` with account name and session count → `router.replace('/(app)/settings/watch')`.

Implementation details:
- Android only: a desktop `userAgent` string is injected so Google's consent page renders correctly (Google blocks some default Android WebView UAs).
- The `Modal` has a close button so users can abort without completing the flow.
- On error (user denies consent, network failure, etc.) an inline banner is shown instead of navigating away.

Key detail: `prompt=consent` is included in the auth URL (via the backend) so Google always returns a `refresh_token` — without this, refresh tokens are only issued on the first connect per user.

---

### `mobile/hooks/useActiveEffects.ts` [UPDATED]

This hook powers the live BG estimate displayed throughout the app. The watch HR feature feeds into it indirectly: the scheduler writes `activities` docs, the ODE backend turns those into a stacked pharmacodynamic curve, and the hook fetches that curve.

Changes in this file:

| Fix | Description |
|---|---|
| Activity PD fetch | `GET API.ACTIVITY_PD.STACKED` is fetched concurrently in `fetchData()` alongside meals, insulin, and blood sugar. Result is stored as `activityPD` in the atomic `fetchedData` state object. |
| 30-second debounce (D-6) | `lastActivityPDFetchMs` ref prevents hammering the ODE endpoint on rapid re-renders. Manual `refresh()` resets the debounce to 0 so post-session updates appear immediately. |
| `calculateNetEffect` (D-2) | Now imported from the canonical `@/utils/calculations/net-effect` wrapper, which accepts `activityPD` as a 7th argument and integrates `cumulative_activity_effect` into `estimatedBG` in one place. |
| Dynamic mode projection fix | `projectedFinalBG` is rebuilt from `estimatedBG + pendingNetEffect` to avoid double-counting IOB. Uses sensitivity-adjusted `effective_correction_factor` / `effective_carb_to_bg_ratio` when `sensitivityMultiplier > 1.0`. |
| Preset mode correction | `calculateTotalCumulativeEffects` (Phase 3-fixed version) is run after `calculateNetEffect` so `estimatedBG` includes real absorbed meal/insulin PK rather than the zeroed preset baseline values. `cumulativeActivityEffect` is added as a third signed term. |
| New public fields | `activityEffect`, `sensitivityMultiplier`, `activityOnBoard`, `activityContributions`, `activityPDResult` are now returned by the hook for display in chart components without a second API call. |

---

### `mobile/app/(app)/(tabs)/profile.tsx` [UPDATED]

Changes vs original:

| What | Where |
|---|---|
| `import { getWatchStatus }` | Top-level imports |
| `import type { WatchConnectionStatus }` | Top-level imports |
| `WatchSyncWidget` component | New component — mirrors `LibreLiveWidget`; shows Google blue badge, last sync time, sync interval |
| `<WatchSyncWidget onPress={onWatch} />` | Inside `PatientProfileContent`, below `<LibreLiveWidget>` |
| `onWatch` prop on `PatientProfileContentProps` | New prop |
| `SettingsLink` "Google Fit / Watch HR" | Inside patient settings links card, below FreeStyle Libre |
| `handleWatch` handler | `() => router.push('/(app)/settings/watch')` |
| `onWatch={handleWatch}` | Passed to `PatientProfileContent` |
| Watch widget styles | `watchWidget`, `watchSensorDot`, `watchSensorLabel`, etc. |

`WatchSyncWidget` uses a local `useState` + `useEffect` to call `getWatchStatus()` once on mount — no new hook file required. Returns `null` silently if not connected or if the call fails, so there is zero UI impact for users who haven't connected Google Fit.

---

### `backend/main.py` [UPDATED]

Two additions (marked with `# ← NEW` comments in the file):

```python
from routes.watch_sync_routes import watch_sync_bp   # in imports block
(watch_sync_bp, ''),                                  # in blueprints list

from watch_scheduler import start_watch_scheduler     # after libre scheduler
start_watch_scheduler(app)
```

---

## 5. Wiring checklist

```
Backend
  [ ] Copy watch_sync_service.py  → backend/services/
  [ ] Copy watch_sync_routes.py   → backend/routes/
  [ ] Copy watch_scheduler.py     → backend/
  [ ] Copy setup_watch_indexes.py → backend/
  [ ] Replace main.py with updated version
  [ ] pip install requests apscheduler   (already required by Libre — no new deps)
  [ ] python setup_watch_indexes.py   (run once)

Mobile
  [ ] Copy watch-connect.tsx  → mobile/app/(app)/settings/
  [ ] Copy watch.tsx          → mobile/app/(app)/settings/
  [ ] Copy watch-sync.ts      → mobile/services/api/
  [ ] Copy watch.types.ts     → mobile/types/          ← note: dot, not underscore
  [ ] Replace endpoints.ts with updated version        ← adds API.WATCH + API.ACTIVITY_PD
  [ ] Replace useActiveEffects.ts with updated version ← adds Activity PD integration
  [ ] Replace profile.tsx with updated version
  [ ] Create mobile/app/(app)/settings/watch.tsx  (status/settings screen — not yet built)
  [ ] expo install react-native-webview  (if not already installed)

Backend (dev test harness — never reaches production)
  [ ] Copy watch_test_routes.py → backend/routes/
  [ ] Add dev guard to main.py  (see §12 — blocked automatically on Render)

Google Cloud Console
  [ ] Create OAuth 2.0 client  (see Section 7)
  [ ] Add env vars to Render   (see Section 6)

One-time
  [ ] python setup_watch_indexes.py
```

---

## 6. Environment variables

Add to `backend/.env` and to Render's Environment tab:

| Variable | Example | Notes |
|---|---|---|
| `GOOGLE_CLIENT_ID` | `123456789-abc.apps.googleusercontent.com` | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | `GOCSPX-...` | From Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | `com.diatwin.mobile://auth/watch` | Must match exactly what is registered in Google Cloud Console |

Existing variables (`MONGO_URI`, `SECRET_KEY`, `RENDER_EXTERNAL_URL`) are unchanged.

---

## 7. Google Cloud Console setup

1. Go to **console.cloud.google.com** → your project (or create one)
2. **APIs & Services → Enable APIs** → enable **Fitness API**
3. **APIs & Services → Credentials → Create credentials → OAuth 2.0 Client ID**
   - Application type: **Android** (or iOS — both work for deep-link redirects)
   - Package name: `com.diatwin.mobile`
4. **Authorised redirect URIs**: add `com.diatwin.mobile://auth/watch`
5. Copy the **Client ID** and **Client Secret** into your env vars
6. **OAuth consent screen**:
   - Scopes to add: `fitness.heart_rate.read`, `fitness.activity.read`, `userinfo.email`, `userinfo.profile`
   - Publishing status: **In testing** for dev; submit for **Production** before wider release

> **Why `prompt=consent` in the auth URL?**
> Google only returns a `refresh_token` on the very first authorization per user. Adding `prompt=consent` forces the consent screen every time, which guarantees a fresh `refresh_token`. Without this, reconnecting after a disconnect would fail silently within 1 hour (when the access token expires and there is no refresh token to renew it).

> **Why `access_type=offline`?**
> Required alongside `prompt=consent` to tell Google's OAuth server the application needs long-lived offline access. Without it, no `refresh_token` is issued regardless of the `prompt` parameter.

---

## 8. MongoDB collections & indexes

### New collection: `watch_connections`

```json
{
  "user_id":               "string (unique)",
  "access_token":          "string (short-lived, ~1 hour)",
  "refresh_token":         "string (long-lived, stored encrypted in production)",
  "token_expires_at":      "float (Unix timestamp)",
  "google_email":          "string",
  "google_name":           "string",
  "auto_sync_enabled":     "bool (default true)",
  "sync_interval_minutes": "int (default 15, min 15)",
  "hr_base":               "float (optional — patient resting HR for ODE)",
  "hr_max":                "float (optional — patient max HR for ODE)",
  "autosegment_config":    "dict (optional — override swim-lane thresholds)",
  "connected_at":          "ISO string",
  "last_sync":             "ISO string | null"
}
```

Indexes created by `setup_watch_indexes.py`:
- `watch_connections.user_id` — unique
- `activities.(user_id, source, startTime DESC)` — fast time-range queries filtered to `source: "google_fit"`

### Existing collection: `activities`

New docs written by this feature are schema-identical to existing watch-streaming docs, with one additional field:

```json
"source": "google_fit"
```

This allows the UI to distinguish auto-synced sessions from live-streamed sessions if needed. The ODE model reads activity docs regardless of `source`.

---

## 9. API endpoint reference

### `GET /api/watch/oauth-url`
Returns the Google OAuth consent URL. Mobile opens this in a WebView.

**Response**
```json
{ "url": "https://accounts.google.com/o/oauth2/v2/auth?client_id=...&..." }
```

---

### `POST /api/watch/connect`
Exchange an OAuth code for tokens, store connection, run first sync.

**Request**
```json
{ "code": "<auth_code>" }
```

**Response**
```json
{
  "message": "Google Fit connected successfully",
  "status": {
    "connected": true,
    "google_email": "ali@example.com",
    "google_name": "Ali A.",
    "auto_sync_enabled": true,
    "sync_interval_minutes": 15,
    "last_sync": "2026-05-03T10:30:00Z",
    "connected_at": "2026-05-03T10:29:55Z"
  },
  "sync_result": {
    "new_count": 3,
    "skipped_count": 52,
    "latest_session": {
      "session_id": "...",
      "intensity": "moderate",
      "start_time": "2026-05-03T09:15:00",
      "duration_minutes": 22.5
    }
  }
}
```

> **Error case:** if Google did not return a `refresh_token` (i.e. `access_type=offline` or `prompt=consent` was missing from the auth URL), the backend raises a `ValueError` and returns HTTP 500 with a descriptive message. The client should prompt the user to reconnect.

---

### `GET /api/watch/status`
```json
{ "connected": false }
// or when connected:
{
  "connected": true,
  "google_name": "Ali A.",
  "google_email": "ali@example.com",
  "auto_sync_enabled": true,
  "sync_interval_minutes": 15,
  "last_sync": "2026-05-03T10:30:00Z",
  "connected_at": "2026-05-03T10:29:55Z"
}
```

---

### `POST /api/watch/sync`
On-demand sync. Same response shape as `sync_result` above.

```json
{
  "message": "Sync complete — 2 session(s) created",
  "new_count": 2,
  "skipped_count": 13,
  "latest_session": { "session_id": "...", "intensity": "light", "start_time": "...", "duration_minutes": 18.0 }
}
```

---

### `PUT /api/watch/settings`
```json
{ "auto_sync_enabled": true, "sync_interval_minutes": 30, "hr_base": 62, "hr_max": 178 }
```
All fields are optional. `sync_interval_minutes` is clamped to a minimum of 15.

---

### `DELETE /api/watch/disconnect`
```
DELETE /api/watch/disconnect?delete_activities=true
```
```json
{ "message": "Google Fit disconnected", "deleted_activities": 14 }
```
`deleted_activities` is `0` when `delete_activities` query param is omitted or false.

---

### `POST /api/watch/test/inject`  *(dev only — HTTP 403 on Render)*
Accepts synthetic HR samples, runs them through `segment_hr_stream()` + `session_to_activity_doc()` (both unchanged), and upserts a fake `watch_connections` doc so `GET /api/watch/status` returns `connected: true, test_mode: true`.

**Request**
```json
{
  "samples": [
    { "timestamp_iso": "2026-05-03T07:10:00+00:00", "hr_bpm": 122 },
    { "timestamp_iso": "2026-05-03T07:11:00+00:00", "hr_bpm": 135 }
  ]
}
```
Samples outside 20–300 bpm are silently dropped. Maximum 5 000 samples per call.

**Response** `201`
```json
{
  "new_count": 3,
  "skipped_count": 0,
  "sessions": [
    { "session_id": "...", "intensity": "vigorous", "start_time": "...", "duration_minutes": 45.0 }
  ]
}
```
Returns `200` with `"message"` if no sessions were detected (values too low / gaps too large).

---

### `DELETE /api/watch/test/inject`  *(dev only — HTTP 403 on Render)*
Removes all activity docs with `source: "fitbit_test_harness"` and the fake `watch_connections` doc.

**Response** `200`
```json
{ "deleted_sessions": 7, "message": "Test data cleared" }
```

---

### `GET /api/watch/test/status`  *(dev only — HTTP 403 on Render)*
Returns whether test mode is active and the count / date range of injected sessions.

**Response** `200`
```json
{
  "test_mode": true,
  "session_count": 3,
  "oldest_session": "2026-05-03T07:10:00",
  "newest_session": "2026-05-03T17:30:00"
}
```
```json
{ "test_mode": false, "session_count": 0 }
```

---

## 10. Parallel with LibreLinkUp

Every design decision mirrors the existing Libre integration:

| Libre | Watch HR | Notes |
|---|---|---|
| `libre_routes.py` | `watch_sync_routes.py` | Same Blueprint structure |
| `libre_service.py` | `watch_sync_service.py` | Same service module layout |
| `libre_scheduler.py` | `watch_scheduler.py` | Same APScheduler pattern |
| `libre-connect.tsx` | `watch-connect.tsx` | Credentials form → OAuth WebView |
| `libre.ts` | `watch-sync.ts` | Identical Axios wrapper pattern |
| `libre.types.ts` | `watch.types.ts` | Same type shape |
| `setup_libre_indexes.py` | `setup_watch_indexes.py` | Same index setup pattern |
| `API.LIBRE.*` in `endpoints.ts` | `API.WATCH.*` in `endpoints.ts` | Both blocks use `v()` helper |
| `LibreLiveWidget` | `WatchSyncWidget` | Same render-only-when-connected pattern |
| `libre_connections` | `watch_connections` | Same MongoDB collection shape |
| `blood_sugar` (CGM readings) | `activities` (HR sessions) | Target collections differ by data type |
| 4-min scheduler interval | 15-min scheduler interval | Google Fit granularity is 1-min buckets |

The one structural difference: Libre stores **credentials** (email + encrypted password) while Watch stores **OAuth tokens** (access + refresh). The OAuth flow adds a WebView step on mobile (the consent page) versus the simple form in `libre-connect.tsx`.

---

## 11. What was NOT changed

The following files were deliberately left untouched:

- `watch_hr_routes.py` — live watch streaming endpoints work exactly as before
- `watch.tsx` — completed (see §4); no changes needed after initial deploy
- `watch_hr_autosegment.py` — `segment_hr_stream()` is called unchanged
- `activity_pharmacodynamics_routes.py` — ODE picks up `activities` docs regardless of source
- `libre_routes.py`, `libre_service.py`, `libre_scheduler.py` — no changes
- All frontend React (web) components — no changes
- All other backend routes — no changes

New activity sessions written by the Google Fit scheduler are **schema-identical** to sessions created by the live watch streaming flow, with only `source: "google_fit"` added. The ODE model, activity visualization, and cumulative effects calculation receive them without any modification.

`useActiveEffects.ts` was updated (see §4) but only to add the Activity PD fetch and wire it into the BG estimate — the existing meals/insulin/blood-sugar pipeline inside the hook is unchanged.

---

## 12. Dev test harness

### Purpose

Allows testing the full HR segmentation + ODE pipeline on a device or simulator that has no real Google Fit account, without any CSV files or manual database seeding.

### How it works

```
Mobile tap "↑ Inject test data"
        │
        │  buildFakeHRSamples()  — runs on-device, no network
        │  Generates ~129 one-minute samples across three sessions:
        │    • Morning run  (50 min, peaks at vigorous)
        │    • Lunch walk   (24 min, light)
        │    • Evening gym  (55 min, peaks at vigorous)
        ▼
POST /api/watch/test/inject  { samples: [...] }
        │  (auth token included via apiClient — not raw axios)
        ▼
_assert_dev()  — aborts with 403 if RENDER env var is set
        │
        ▼
segment_hr_stream(samples)     ← unchanged pipeline function
session_to_activity_doc(sess)  ← unchanged pipeline function
        │
        │  [doc normalisation — see below]
        ▼
mongo.db.activities.insert_one(doc)
        source: "fitbit_test_harness"
        │
        ▼
mongo.db.watch_connections.update_one(upsert)
        test_mode: True,  access_token: None, auto_sync_enabled: False
        │  (scheduler skips this doc — no accidental real sync)
        ▼
GET /api/watch/status  →  connected: true, test_mode: true
        │
        ▼
watch.tsx renders amber "🧪 Test Mode" badge
ODE pharmacodynamics picks up the new activity docs automatically
```

### Activity doc normalisation

`session_to_activity_doc()` produces BSON-native types that the visualisation layer does not expect. The inject endpoint fixes the doc **before `insert_one()`**, leaving the pipeline function itself unchanged:

| Field | Pipeline produces | Fixed to |
|---|---|---|
| `startTime` / `endTime` | Python `datetime` → BSON Date | ISO-8601 string `"...Z"` |
| `completedTime` | equals `endTime` | equals `startTime` |
| `notes` | missing | `""` (empty string) |
| `level` | missing (pipeline stores `intensity` string) | `int` mapped from `intensity`: light→1, moderate→2, vigorous→3 |
| `impact` | missing | `float` mapped from `intensity`: light→0.6, moderate→0.8, vigorous→0.9 |
| `timestamp` | missing | `datetime.now(timezone.utc)` (wall-clock insertion time) |

The `level` / `impact` mapping is derived from observed working docs in the database. If the ODE model's intensity thresholds change, update `_INTENSITY_MAP` in `watch_test_routes.py` to match.

### Expo Go quirk — no `Alert` wrapper on inject

The "Inject test data" button in `watch.tsx` executes the API call **directly on tap**, with no `Alert.alert` confirmation dialog. The reason: on some Expo Go builds, an `Alert.alert` with multiple buttons silently swallows all `onPress` callbacks — the alert never renders and the tap appears to do nothing. The amber spinner on the button provides sufficient feedback for a dev tool. The destructive "Clear test data" button retains its `Alert` confirmation (irreversible action), but uses `apiClient` instead of raw `axios` so the auth token is always included.

### Clearing test data

```
Mobile tap "Clear test data" → confirm
        │
        ▼
DELETE /api/watch/test/inject
        │
        ▼
mongo.db.activities.delete_many({ user_id, source: "fitbit_test_harness" })
mongo.db.watch_connections.delete_one({ user_id, test_mode: True })
        │
        ▼
watch.tsx resets to not-connected view
```

### Production safety

`_assert_dev()` checks `os.environ.get("RENDER")` at the top of every handler. All three endpoints return HTTP 403 on Render regardless of any other conditions. The blueprint is not even registered in `main.py` when `RENDER` is set.
