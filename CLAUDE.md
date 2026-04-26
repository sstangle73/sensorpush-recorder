# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

A standalone Node service that polls the SensorPush cloud every 5 minutes, stores readings in SQLite, and exposes a REST API + self-contained Explorer UI on port 3003. Originally extracted from [storie-dashboard](https://gitlab.com/sstangle73/storie-dashboard); the dashboard's frontend pane fetches from this service cross-origin at `https://sensors.sstangle.in`.

## Production deployment

- **Repo**: <https://gitlab.com/sstangle73/sensorpush-recorder> (private)
- **Host**: docker2 VM (Proxmox), at `/home/sstangle73/stacks/sensorpush-recorder`
- **Container**: `sensorpush-recorder` listening on `0.0.0.0:3003`
- **Public URL**: `https://sensors.sstangle.in` via Cloudflare Tunnel → docker2:3003
- **DB**: `./data/sensorpush.db` (relative to the compose file)
- **Allowed CORS origins** (set via `CORS_ORIGINS` env var in compose):
  - `https://dashboard.sstangle.in` (production dashboard)
  - `http://10.73.37.22:8080` (LAN kiosk)
  - `http://localhost:8080` (local dev)

Add a new caller by appending its origin to `CORS_ORIGINS` in `docker-compose.yml`, then `docker compose up -d` to recreate the container with the new env.

After source changes:

```bash
ssh sstangle73@docker2 "cd ~/stacks/sensorpush-recorder && git pull && docker compose up -d --build"
```

The Dockerfile uses an explicit `COPY server.js config.js db.js sensorpush.js poller.js ui.html ./` list — adding a new module without updating the Dockerfile causes `ERR_MODULE_NOT_FOUND` and crash-loops.

## Layout

```
server.js       — Express bootstrap, all routes, CORS middleware, PWA assets
config.js       — loadConfig() reads /config/config.local.js via new Function sandbox
db.js           — node:sqlite schema + queries; excluded flag + migrations
sensorpush.js   — 2-step OAuth + fetchSensors / fetchSamples (2-day chunks, limit 10000)
poller.js       — 5-min poll loop, 24h lookback, 30-day initial backfill, triggerBackfill
ui.html         — self-contained Explorer SPA (multi-sensor chart, exclusion, zoom)
tests/          — 103 vitest tests; in-memory SQLite + http.createServer for route tests
Dockerfile      — explicit COPY list — update when adding new files
```

Import graph is acyclic: `config` → `db`, `sensorpush` → `poller` → `server`.

## Configuration

- `/config/config.local.js` — bind-mounted file containing `window.DASHBOARD_CONFIG = { sensorpush: { email, password } }`. Format kept compatible with the dashboard's config.local.js so the same file can be reused if desired.
- `CORS_ORIGINS` env var — comma-separated allowlist. The middleware echoes the request `Origin` only when it matches an entry; never sends `*`.
- `DB_PATH` (default `/data/sensorpush.db`)
- `PORT` (default `3003`)

## Routes

`/`, `/health`, `/:id/history`, `/:id/history/all`, `/:id/gaps`, `/:id/readings/exclude` (PATCH), `/:id/hourly/exclude` (PATCH), `/poll` (POST), `/backfill` (POST), `/backfill/status`, `/settings` (GET/PUT), `/ui`, `/icon.svg`, `/icon-{192,512}.png`, `/sw.js`, `/manifest.json`.

`GET /` content-negotiates: `Accept: text/html` → Explorer UI; otherwise JSON sensor list. This lets the root URL serve both API callers and browsers landing at the public hostname.

## Testing

```bash
npm test                       # all 103 tests
npx vitest run tests/db.test.js
npm run test:watch
```

- Server tests use `http.createServer(createApp(db))` on port 0 with an in-memory SQLite.
- `sensorpush.test.js` mocks `node-fetch` to drive the OAuth + samples flows.
- Module-level caches (`_tokenCache` in `sensorpush.js`, `_lastPollTime` etc. in `poller.js`) persist across tests in the same file — use `_resetTokenCache()` / `_resetPollerState()` between tests.

## Deployment

Run as its own compose stack:

```bash
docker compose up -d --build
```

After source changes:

```bash
git pull && docker compose up -d --build
```

**Dockerfile gotcha**: uses an explicit `COPY server.js config.js db.js sensorpush.js poller.js ui.html ./` list, not `COPY . .`. Adding a new module without updating the Dockerfile causes `ERR_MODULE_NOT_FOUND` and crash-loops.

## Known issues / tricky bits

- **SensorPush OAuth is two-step**: `/oauth/authorize` returns an `authorization` code; `/oauth/accesstoken` exchanges it for an 11h-cached token. Don't try to skip the first step.
- **Sample API has a 10000-row hard limit** — `fetchSamples` chunks into 2-day windows.
- **Always look back 24h on incremental polls** — the SensorPush cloud sometimes publishes readings minutes-to-hours late; `INSERT OR IGNORE` makes the overlap free.
- **`getLatestTs` filters `excluded = 0`** so excluded readings never push the poll window past valid data.
- **Hourly aggregates auto-recompute** when readings or hourly buckets are excluded — `setReadingExcluded` calls `recomputeHourlyAgg`.
- **CORS sends echoed origin, not `*`** — adding a new caller means adding it to `CORS_ORIGINS` (or running behind a same-origin reverse proxy that strips/sets CORS itself).
