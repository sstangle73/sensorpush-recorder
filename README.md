# sensorpush-recorder

Self-hosted recorder for [SensorPush](https://www.sensorpush.com/) wireless temperature/humidity/pressure sensors.

Polls the SensorPush cloud every 5 minutes, stores all readings locally in SQLite, exposes a REST API, and ships with a self-contained Explorer UI for charting, gap analysis, and data QA.

Originally extracted from [storie-dashboard](https://gitlab.com/sstangle73/storie-dashboard).

## Features

- **Continuous polling** — every 5 min, with 24h lookback to absorb late-published cloud data.
- **30-day initial backfill** — first run pulls a month of history per sensor.
- **Full schema** — temperature, humidity, barometric pressure, dewpoint, VPD, battery, RSSI, plus the gateway each sample arrived through.
- **Gateway tracking** — polls `/devices/gateways` alongside sensors; appends a `gateway_status` row per poll so you can answer "was the gateway online during this gap window?" after the fact.
- **Gap analysis** — detects missing windows (interior, leading, and trailing), sparse hours, and per-gap gateway-online status. A dead sensor reports as one big trailing gap, not as 100% coverage.
- **Targeted backfill** — "Fix all gaps" button re-fetches only the windows the local DB shows as missing, instead of broadly re-pulling the whole range.
- **Data QA** — exclude individual readings or whole hourly buckets from charts and aggregates; hourly aggregates auto-recompute on exclusion.
- **Explorer UI** — multi-sensor chart with toggleable series (temp, humidity, pressure, dewpoint, heat index, VPD), zoom, edit mode, analytics view with coverage timeline.
- **PWA** — installable, offline-shell cached via service worker.
- **Cross-origin friendly** — explicit CORS allowlist so the same recorder can serve a primary dashboard, a kiosk, and local dev.

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
| GET | `/gateways` | per-gateway status: name, last seen, version, paired |
| GET | `/:id/history?range=24h` | time series; ranges: `1h`, `24h`, `7d`, `30d`, `90d`, `1yr` (h=raw, d=hourly avg, yr=daily avg) |
| GET | `/:id/history/all?range=7d` | includes excluded points (data QA) |
| GET | `/:id/gaps?range=7d` | missing windows + sparse hours + coverage %; each gap annotated with `gatewayOnline: true \| false \| null` |
| PATCH | `/:id/readings/exclude` | toggle reading exclusion (auto-recomputes hourly bucket) |
| PATCH | `/:id/hourly/exclude` | toggle hourly bucket exclusion |
| POST | `/poll` | trigger immediate cloud poll |
| POST | `/backfill` | start broad historical re-fetch from `{fromDate: 'YYYY-MM-DD'}` (UTC midnight) |
| POST | `/backfill-gaps` | start targeted gap-only re-fetch over `{range}` |
| GET | `/backfill/status` | poll backfill progress (shared by both backfill modes) |
| GET / PUT | `/settings` | persist Explorer UI preferences |

PWA assets: `/icon.svg`, `/icon-192.png`, `/icon-512.png`, `/sw.js`, `/manifest.json`.

## Architecture

```
config.js → db.js (SQLite + schema)
              ↑
sensorpush.js (cloud) → poller.js → server.js (Express + ui.html)
```

- **`sensorpush.js`** — 2-step OAuth (email/pw → authorization code → access token, cached 11h); `fetchSensors`, `fetchSamples`, `fetchGateways`.
- **`poller.js`** — 5-minute loop. On first run backfills 30 days in 2-day chunks. On subsequent runs looks back 24h before the latest reading to catch late-published cloud data (`INSERT OR IGNORE` makes the overlap free). Also pulls gateway status and appends to `gateway_status`. Exposes `triggerPoll`, `triggerBackfill` (broad), `triggerGapBackfill` (targeted).
- **`db.js`** — schema (`sensors`, `readings`, `hourly_agg`, `gateways`, `gateway_status`, `meta`); migrations on every `openDb()`. Hourly buckets auto-recompute on insert/exclusion changes; zombie rows (sample_count=0) are deleted rather than persisted.
- **`server.js`** — Express bootstrap + all routes + CORS middleware + procedurally-rendered PNG icons + service worker JS.
- **`ui.html`** — single-page Explorer with multi-sensor chart, exclusion toggle, zoom, edit mode, analytics view (coverage timeline, gap detail, gateway panel), targeted "Fix all gaps" button.

## Tests

```bash
npm install
npm test
```

183 vitest tests across `db.test.js`, `poller.test.js`, `sensorpush.test.js`, `server.test.js`, `ui-helpers.test.js`, `config.test.js`. All run in-memory (no DB or network required); `sensorpush.test.js` and `poller.test.js` mock `node-fetch` and `../sensorpush.js` respectively.

## Deploying to a public URL

Run behind a reverse proxy (Cloudflare Tunnel, nginx, Caddy) terminating TLS at e.g. `https://sensors.example.com` → `http://docker-host:3003`. Add that origin to `CORS_ORIGINS` for any frontend that fetches from it.

## License

MIT
