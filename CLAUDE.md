# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repository.

> If a `CLAUDE.local.md` exists alongside this file, read it too — it carries
> deployment-specific context (hostnames, deploy commands, internal CORS
> origins) for the local operator and is gitignored.

## What this is

A standalone Node service that polls the SensorPush cloud every 5 minutes, stores readings in SQLite, and exposes a REST API + self-contained Explorer UI on port 3003.

## Deployment

Runs as a single-container compose stack. After source changes:

```bash
git pull && docker compose up -d --build
```

The Dockerfile uses an explicit `COPY server.js config.js db.js sensorpush.js poller.js auth.js drift.js mqtt.js hvac.js notifications.js weather.js backups.js ui.html ./` list (not `COPY . .`). **Adding a new module without updating the Dockerfile causes `ERR_MODULE_NOT_FOUND` and crash-loops.**

CORS allowlist is configured via the `CORS_ORIGINS` env var in `docker-compose.yml`. Comma-separated; each value must match a request's `Origin` header exactly. Empty is fine for same-origin / reverse-proxy setups.

## Layout

```
server.js       — Express bootstrap, all routes, CORS middleware, PWA assets, procedural PNG icons
config.js       — loadConfig() reads /config/config.local.js via new Function sandbox; parseConfig() exported for tests
db.js           — node:sqlite schema + queries; migrations on every openDb(); excluded flag; gateway tracking; battery history + forecast; gateway uptime + primary-sensor counts; outdoor_readings (Open-Meteo)
sensorpush.js   — 2-step OAuth + fetchSensors / fetchSamples / fetchGateways; samples API has 10000-row hard limit, chunked in 2-day windows
weather.js      — Open-Meteo (no API key): fetchCurrentWeather (current_weather) + fetchHourlyWeather (past_days 1..92); both soft-fail to []
poller.js       — 5-min sensor poll loop; 24h lookback; 30-day initial backfill; triggerBackfill (broad), triggerGapBackfill (targeted); separate hourly weather loop (skipped when weather.{lat,lon} absent); daily clock-aligned jobs at 03:00 (auto gap-fill 7d) and 03:30 (SQLite VACUUM INTO /data/backups/, 7-day retention); gateway-status recording + 30-day prune; per-poll MQTT publish + hourly HA discovery; accepts registerSwap callback for restore-driven handle hot-swap
auth.js         — recorder-token resolution (env > /data/recorder-token > null); generate/set/clear helpers; bearer middleware in server.js calls getToken() on every request
drift.js        — pure-function drift detector: computeDriftStats(samples) → mean delta + linear-regression slope per day; classifyDrift() returns 'drifting'|'stable'|'unknown'
mqtt.js         — optional publish-only MQTT bridge (HA discovery + retained state). No-op when MQTT_URL is unset. Env-configured (MQTT_URL/USERNAME/PASSWORD/TOPIC_PREFIX/DISCOVERY_PREFIX). Failures isolated from poll path
hvac.js         — pure-function module: detectCycles(readings, opts) infers HVAC on/off cycles by smoothing the temperature series, sign-thresholding the slope, and grouping contiguous same-sign runs into heating/cooling cycles; pickDefaultThermostatSensor picks the lowest-variance indoor sensor
notifications.js — outbound webhook + ntfy dispatch with per-(condition, target) DB-backed state machine; fires on transition→active and transition→recovered, dedupes while stuck; condition evaluators for threshold breach, hour-of-day anomaly, sensor-offline, gateway-offline; runNotifications() is called from the poll loop after each successful poll
backups.js      — listBackups()/restoreBackup()/isRestorableName() for /data/backups/*.db; strict daily-pattern regex + resolve-stays-in-dir gate; restore closes handle, copies pre-restore safety snapshot, removes WAL/SHM sidecars, copies chosen backup over live DB, re-opens
ui.html         — self-contained 5-tab SPA: Live (real-time cards, feels-like, alert thresholds, anomalies, recent events), Stats (records, hour-of-day + minute-of-hour heatmaps, correlation, mold/HVAC, battery forecast, breach history, comfort presets, year-over-year overlay, HVAC zone analysis panel, indoor-vs-outdoor weather delta), Explorer (multi-sensor chart, exclusion, zoom, event markers, outdoor overlay), Analytics (coverage timeline, gap detail, gateway panel with uptime), Settings (comfort presets, HVAC thermostat flags, security/token, notification sinks + condition toggles, backups list + restore)
tests/          — vitest test suite (in-memory SQLite + http.createServer for route tests; filesystem fixture for backups.test.js since restore is fs-level). Run `npm test` for the current count.
.gitlab-ci.yml  — runs npm test on every push/MR (Node 22-alpine)
Dockerfile      — explicit COPY list — update when adding new files
```

Import graph is acyclic: `config` → `db`, `auth`, `poller`, `backups`, `server`; `sensorpush` → `poller`; `weather` → `poller`; `mqtt` → `poller`; `db` → `notifications`, `backups`; `notifications` → `poller`, `server`; `db`, `auth`, `poller`, `hvac`, `backups` → `server`.

## Configuration

- `/config/config.local.js` — bind-mounted file containing `window.DASHBOARD_CONFIG = { sensorpush: { email, password }, weather: { lat, lon } }`. The `window.` prefix is a quirk inherited from a frontend-config sharing pattern. Only `sensorpush.{email,password}` and (optionally) `weather.{lat,lon}` are read. Weather can also come from `WEATHER_LAT` / `WEATHER_LON` env vars (env overrides file independently of sensorpush creds).
- `CORS_ORIGINS` env var — comma-separated allowlist. The middleware echoes the request `Origin` only when it matches an entry; never sends `*`.
- `RECORDER_TOKEN` env var — optional shared bearer for HTTP auth. Set in `docker-compose.yml` env if you want config-as-code; otherwise leave unset and use the Settings → Security UI (see below) to generate + persist a token to `/data/recorder-token`. Resolution order: env > file > null (no auth). Bearer required on all routes except `/health`, icon/manifest/sw assets, HTML `GET /`, and same-origin requests (`Sec-Fetch-Site: same-origin`).
- `DB_PATH` (default `/data/sensorpush.db`)
- `PORT` (default `3003`)

## Routes

- **Auth**: `GET /settings/auth` (state), `POST /settings/auth/generate` (bootstrap-only), `POST /settings/auth/rotate` (requires bearer), `DELETE /settings/auth` (clear file token)
- **Sensors / data**: `GET /` (JSON or HTML; response includes `oldestReadingTs` so the Stats YoY toggle can decide whether ≥1y of data exists), `GET /:id/history` (optional `endTs` query param anchors the window at an arbitrary epoch — used by the YoY overlay), `GET /:id/history/all`, `GET /:id/gaps`
- **Battery forecast**: `GET /battery` — per-sensor voltage trend + projected days-until-replacement
- **HVAC**: `GET /hvac?range=24h` — duty-cycle inference for thermostat-reference sensors; returns per-cycle list, heating/cooling runtime %, daily breakdown for the last 7 days, and short-cycle warnings. Reference sensors come from `settings.hvac.sensors.<id>.thermostat=true`; with none flagged, the most-stable indoor sensor over 24 h is auto-selected.
- **Outdoor weather**: `GET /weather?range=Xd` — Open-Meteo samples + latest reading (returns `configured: false` when no `weather.{lat,lon}` is configured); `POST /weather/poll` for a manual fetch
- **Gateways**: `GET /gateways` (optional `?range=Xd` adds uptime % + primary-sensor count per gateway)
- **Mutations**: `PATCH /:id/readings/exclude`, `PATCH /:id/hourly/exclude`
- **Polling / backfill**: `POST /poll`, `POST /backfill` (broad, fromDate), `POST /backfill-gaps` (targeted, range), `GET /backfill/status`
- **Backups**: `GET /backups` (list daily + pre-restore snapshots), `POST /backups/:filename/restore` (daily pattern only — swaps live DB to chosen snapshot, returns pre-restore safety filename)
- **Settings**: `GET /settings`, `PUT /settings`
- **Notifications**: `POST /settings/notifications/test` (one-off test dispatch to webhook/ntfy/all; bypasses state machine), `GET /settings/notifications/state` (per-condition firing state map)
- **Export**: `GET /:id/history.csv?range=7d`
- **Sensor pairs / drift**: `GET /sensor-pairs`, `POST /sensor-pairs`, `DELETE /sensor-pairs/:id`, `GET /sensor-pairs/:id/drift?range=30d`
- **Health / PWA**: `GET /health`, `GET /ui`, `GET /icon.svg`, `GET /icon-{192,512}.png`, `GET /sw.js`, `GET /manifest.json`

`GET /` content-negotiates: `Accept: text/html` → Explorer UI; otherwise JSON sensor list. This lets the root URL serve both API callers and browsers landing at the same hostname.

## Schema (key invariants)

- `readings (sensor_id, ts, …, gateway_id, dewpoint, vpd, excluded)` — `UNIQUE(sensor_id, ts)` + `INSERT OR IGNORE` makes re-fetching free. `gateway_id` is the raw `;`-separated string from the API (multi-gateway reception).
- `hourly_agg (sensor_id, hour_ts, *_avg, *_min, *_max, dewpoint_avg, vpd_avg, sample_count, excluded)` — recomputed by `recomputeHourlyAgg()` after any reading change. **Empty hours are DELETEd, not persisted as sample_count=0** (otherwise they'd show up as sparseHours forever).
- `sensors (id, name, type, active, battery_voltage, alerts, rssi, address, device_id, last_updated)` — upserted from `/devices/sensors` each poll.
- `gateways (id, name, last_seen, last_alert, version, paired, message, last_synced)` — current state, upserted each poll.
- `gateway_status (gateway_id, polled_at, last_seen)` — append-only per poll, pruned to 30 days. Used by `gatewayOnlineDuringWindow()` to answer "was this gateway online during this gap?"
- `notification_state (key, active, last_notified_at, last_transition_at, last_payload)` — one row per (condition, target). `key` shape is `"condition:targetId"` (e.g. `threshold:sensor123`, `gateway-offline:gw1`). State persists across container restarts so a stuck-firing condition isn't re-buzzed after redeploy; `evaluateAndNotify` fires only on transitions in/out of `active`.
- `outdoor_readings (ts PRIMARY KEY, temp, humidity, dewpoint)` — Open-Meteo hourly samples for the configured `weather.{lat,lon}`. `INSERT OR IGNORE` matches the readings table's de-dup semantics; the hourly poller can safely overlap. No location_id column — one recorder = one location.

## Testing

```bash
npm test                       # full vitest run
npx vitest run tests/db.test.js
npm run test:watch
```

- Test files: `auth.test.js`, `backups.test.js`, `config.test.js`, `db.test.js`, `events-auth.test.js`, `hvac.test.js`, `mqtt.test.js`, `notifications.test.js`, `poller.test.js`, `sensorpush.test.js`, `server.test.js`, `ui-helpers.test.js`, `weather.test.js`.
- Server tests use `http.createServer(createApp(db))` on port 0 with an in-memory SQLite.
- `sensorpush.test.js` mocks `node-fetch` to drive the OAuth + samples flows.
- `poller.test.js` mocks `../sensorpush.js` (getToken / fetchSensors / fetchSamples / fetchGateways) — the default `fetchGateways.mockResolvedValue([])` is set in `beforeEach` so tests that don't care about gateways don't have to.
- Module-level caches (`_tokenCache` in `sensorpush.js`, `_lastPollTime` etc. in `poller.js`) persist across tests in the same file — use `_resetTokenCache()` / `_resetPollerState()` between tests.
- Server-test `db` is shared module-wide. Tests asserting on empty state (e.g. "GET / returns empty sensors list") only pass because they run before any `upsertSensors` — be careful adding new tests above them.

## Known issues / tricky bits

- **SensorPush OAuth is two-step**: `/oauth/authorize` returns an `authorization` code; `/oauth/accesstoken` exchanges it for an 11h-cached token. There is no `/oauth/refresh` — we redo the full 2-step on cache expiry.
- **Sample API has a 10000-row hard limit** — `fetchSamples` chunks into 2-day windows. HTP sensors emit more series than HT1, so 2-day is a safe ceiling.
- **Always look back 24h on incremental polls** — the SensorPush cloud sometimes publishes readings minutes-to-hours late; `INSERT OR IGNORE` makes the overlap free.
- **`getLatestTs` filters `excluded = 0`** so excluded readings never push the poll window past valid data.
- **Hourly aggregates auto-recompute** when readings or hourly buckets are excluded — `setReadingExcluded` calls `recomputeHourlyAgg`. `setHourlyExcluded` does NOT recompute and is a manual override (it'll be reset on the next reading-driven recompute).
- **`recomputeHourlyAgg` deletes empty hours** instead of leaving sample_count=0 ghosts; otherwise those rows surface as sparseHours forever.
- **`recomputeHourlyAgg` preserves the `excluded` flag** set by `setHourlyExcluded` — without this, every late-arriving sample would silently flip excluded=0 via INSERT OR REPLACE and erase the user's hourly override.
- **`getGaps` detects leading + trailing gaps** by checking `MIN(ts) - startTs` and `now - MAX(ts)` against the gap threshold; without this, a dead sensor reports 100% coverage.
- **Per-sample `gateway_id`** is the raw API value (semicolon-separated when multiple gateways heard the same sample). `getSensorPrimaryGateway` takes the most-frequent first segment over the last 7d.
- **`gatewayOnlineDuringWindow` only consults post-gap polls.** Because gateway `last_seen` is monotonically non-decreasing, only a poll at or after gap-start can carry a `last_seen` value reaching the gap; pre-gap polls' freshness is information about pre-gap state, not gap state. Returns true iff some recorded `last_seen ≥ startTs`. POST_GAP_LOOKAHEAD (5 min) extends the upper bound so a gap shorter than the poll cadence can still be answered by the first poll after it.
- **`/backfill` parses fromDate as UTC midnight** (`Z` suffix) — without it, the same fromDate gives different start epochs on a UTC container vs a local-TZ host.
- **CORS sends echoed origin, not `*`** — adding a new caller means adding it to `CORS_ORIGINS` (or running behind a same-origin reverse proxy that strips/sets CORS itself).
- **Service worker bypasses caching for `/health`, `/history`, `/gaps`, `/poll`, `/gateways`, `/backfill`, `/backups`, `/settings`** — anything dynamic. Bump the `CACHE` version string in `SW_JS` (server.js) when changing static assets so existing PWA installs pick up the new version.
- **Scheduled jobs** (`scheduleDaily` in poller.js) align to host-local clock time, not relative offsets. The schedule re-arms after each run so a long-running job doesn't drift the cadence.
- **Daily snapshots use `VACUUM INTO`** which produces a clean single-file copy of the SQLite DB without taking a long write lock. Files land in `/data/backups/sensorpush-YYYY-MM-DD.db`; only the 7 most recent are kept (mtime-sorted, then unlinked beyond 7).
- **Auto gap-fill (03:00) skips silently** if a manual `/backfill` or `/backfill-gaps` is already running — it doesn't queue or retry.
- **Notification state machine advances even on dispatch failure.** When a webhook or ntfy POST fails (HTTP 5xx, timeout, DNS), we still flip `notification_state.active` and bump `last_notified_at` — otherwise a transient outage would re-fire every 5 minutes forever. Failed deliveries are logged per sink; the firing payload is in `last_payload` for inspection. Recovery transitions follow the same rule.
- **Anomaly evaluator reads `hourly_agg` for the baseline.** A sensor that's only just joined (< ~5 hours of data for the current hour-of-day) gets `evaluateAnomaly() === []` and never fires; once the bucket has ≥ 5 points, ±2σ checks engage. The SD floor (0.4°F / 1%) prevents naturally-quiet sensors from tripping on minor noise.
- **Webhook vs ntfy payload shape differs.** Webhook receives the full JSON `{timestamp, key, transition, title, message, detail}` as the POST body. ntfy receives `message` as the body and uses `title`, `transition` → Priority+Tags headers — that's what the ntfy clients render natively.
- **Restore swaps the live DB handle in-place** via let-mutable params + an `onSwap` callback. `createApp(db, config, onSwap)` reassigns its `db` param on restore; ESM's let-style parameter bindings mean route closures pick up the new handle without further plumbing. `startPoller(db, config, registerSwap)` registers a callback so its captured `db` (used by setInterval/scheduleDaily) also swaps. In-flight requests using the old handle error out — acknowledged trade-off for an admin operation. Retention pruning only touches `sensorpush-YYYY-MM-DD.db`; pre-restore snapshots (`sensorpush-pre-restore-<ts>.db`) survive forever and are accessible via shell.

## SensorPush API surface — what we use vs. don't

**Used**:
- `/oauth/authorize` + `/oauth/accesstoken` — auth (2-step)
- `/devices/sensors` — full mapping incl. rssi, address, deviceId, alerts
- `/devices/gateways` — current status incl. last_seen
- `/samples` — samples incl. dewpoint, vpd, gateways (per-sample gateway attribution)

**Available but unused** (low value):
- `/reports/list` — empty for users who haven't configured reports in the SensorPush app
- `/tags` — endpoint exists but minimal API surface
- Sample fields `altitude` and `altimeter_pressure` (barometer-derived, sparse use case)
- Sensor `calibration` offsets (already applied server-side to samples, informational only)
- Top-level `last_time` on `/samples` responses (duplicate of local `MAX(ts)`)

**Doesn't exist** (probed and confirmed 400 from API Gateway):
- `/oauth/refresh`, `/devices`, `/alerts`, `/notifications`, `/users/me`, per-sensor edit routes, push subscription, CSV export
