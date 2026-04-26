# sensorpush-recorder

Self-hosted recorder for [SensorPush](https://www.sensorpush.com/) wireless temperature/humidity sensors.

Polls the SensorPush cloud every 5 minutes, stores all readings locally in SQLite, exposes a REST API, and ships with a self-contained Explorer UI for charting and data QA.

Originally extracted from [storie-dashboard](https://gitlab.com/sstangle73/storie-dashboard).

## Quick start

```bash
git clone git@gitlab.com:sstangle73/sensorpush-recorder.git
cd sensorpush-recorder
cp config.js.template config.local.js
# edit config.local.js with your sensorpush.com email + password
docker compose up -d
```

- API + Explorer UI: <http://localhost:3003/>
- Health: <http://localhost:3003/health>

The first poll backfills 30 days of history; subsequent polls run every 5 minutes.

## Configuration

| Source | Purpose |
|---|---|
| `config.local.js` (mounted to `/config/config.local.js`) | SensorPush credentials |
| `CORS_ORIGINS` env var | Comma-separated allowlist of origins permitted cross-origin |
| `DB_PATH` env var (default `/data/sensorpush.db`) | SQLite location |
| `PORT` env var (default `3003`) | HTTP port |

CORS: only origins listed in `CORS_ORIGINS` get an `Access-Control-Allow-Origin` header. The header is never `*` — each origin is echoed exactly when it matches.

## API

`GET /` returns the sensor list as JSON when called with `Accept: application/json` (default for `fetch()`), and serves the Explorer UI when called with `Accept: text/html` (default for browser navigation). The dual response on the root URL is what lets `https://sensors.example.com` work as both an API endpoint and a UI.

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{ok, sensorCount, lastPoll, pollError}` |
| GET | `/` | sensors list (JSON) or Explorer UI (HTML) |
| GET | `/:id/history?range=24h` | time series; ranges: `24h`, `7d`, `30d`, `90d`, `365d` |
| GET | `/:id/history/all?range=7d` | includes excluded points (data QA) |
| GET | `/:id/gaps?range=7d` | missing windows + coverage % |
| PATCH | `/:id/readings/exclude` | toggle reading exclusion |
| PATCH | `/:id/hourly/exclude` | toggle hourly bucket exclusion |
| POST | `/poll` | trigger immediate cloud poll |
| POST | `/backfill` | start historical re-fetch from `{fromDate: 'YYYY-MM-DD'}` |
| GET | `/backfill/status` | poll backfill progress |
| GET / PUT | `/settings` | persist Explorer UI preferences |

## Architecture

```
config.js / date-utils → sensorpush.js (cloud) → poller.js → db.js (SQLite)
                                                               │
                                                          server.js (Express + ui.html)
```

- `sensorpush.js` — 2-step OAuth (email/pw → authorization code → access token, cached 11h)
- `poller.js` — 5-minute loop; on first run backfills 30 days; on subsequent runs looks back 24h before the latest reading to catch late-published cloud data (`INSERT OR IGNORE` makes overlap free)
- `db.js` — schema (`sensors`, `readings`, `hourly_agg`, `meta`); recomputes hourly buckets on insert and exclusion changes
- `ui.html` — single-page Explorer with multi-sensor chart, exclusion toggle, zoom, edit mode

## Tests

```bash
npm install
npm test
```

103 vitest tests across `db.test.js`, `poller.test.js`, `sensorpush.test.js`, `server.test.js`, `ui-helpers.test.js`. All run in-memory (no DB or network required).

## Deploying to a public URL

Run behind a reverse proxy (Cloudflare Tunnel, nginx, Caddy) terminating TLS at e.g. `https://sensors.example.com` → `http://docker-host:3003`. Add that origin to `CORS_ORIGINS` for any frontend that fetches from it.

## License

MIT
