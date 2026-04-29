# sensorpush-recorder

Self-hosted recorder for [SensorPush](https://www.sensorpush.com/) wireless temperature/humidity/pressure sensors.

Polls the SensorPush cloud every 5 minutes, stores all readings locally in SQLite, exposes a REST API, and ships with a self-contained Explorer UI for charting, gap analysis, and data QA.

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
- **Self-healing** — daily auto gap-fill at 03:00 plus daily SQLite snapshot to `/data/backups/` (7-day retention).
- **Battery monitoring** — UI badges sensors with low (≤2.7V) or critical (≤2.5V) battery voltage.
- **CSV export** — `GET /:id/history.csv?range=7d` for spreadsheet analysis.

## Quick start

```bash
git clone <this-repo>
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
| `config.local.js` (mounted to `/config/config.local.js`) | SensorPush credentials — file mode |
| `SENSORPUSH_EMAIL` + `SENSORPUSH_PASSWORD` env vars | SensorPush credentials — env mode (preferred for managed deploys; wins over the file when both set) |
| `CORS_ORIGINS` env var | Comma-separated allowlist of origins permitted cross-origin |
| `RECORDER_TOKEN` env var | Optional shared bearer (alternative to UI-managed file token) |
| `DB_PATH` env var (default `/data/sensorpush.db`) | SQLite location |
| `PORT` env var (default `3003`) | HTTP port |

CORS: only origins listed in `CORS_ORIGINS` get an `Access-Control-Allow-Origin` header. The header is never `*` — each origin is echoed exactly when it matches.

### SensorPush credentials — file vs env

The recorder needs your `sensorpush.com` login to call SensorPush's cloud API. Two ways to provide it:

**File mode** (LAN / single-host self-host):

```js
// /config/config.local.js
window.DASHBOARD_CONFIG = {
  sensorpush: { email: 'you@example.com', password: 'yourpassword' }
};
```

Mount that file at `/config/config.local.js`. Same shape the original storie-dashboard used; copy/paste compatible.

**Env-var mode** (managed Fly / Kubernetes / any container env that injects secrets):

```bash
SENSORPUSH_EMAIL=you@example.com
SENSORPUSH_PASSWORD=yourpassword
```

Env vars take precedence over the file when both are set, so a managed deploy can override stale mounted state without touching the file.

### Auth (bearer token)

When the recorder is reachable from the public internet (e.g. via Cloudflare Tunnel), enable bearer-token auth so origin-allowlist isn't the only line of defense:

**Easy mode — generate from the UI:**

1. Open `http://localhost:3003/` (or your public URL) in a browser.
2. Go to **Settings → Security**.
3. Click **Generate token**.
4. Copy the token shown once (it's stored at `/data/recorder-token` server-side and never displayed again).
5. Paste it into your client (e.g. the rosestorie dashboard's SensorPush settings).

The token resolution order is `RECORDER_TOKEN` env var → `/data/recorder-token` file → no auth. Same-origin requests (the Explorer UI's own JS) bypass the bearer via `Sec-Fetch-Site: same-origin` so the UI Just Works without a token in browser-accessible JS. Cross-origin programmatic callers (the rosestorie dashboard, scripts, etc.) must include `Authorization: Bearer <token>`.

**Config-as-code mode — env var:**

```yaml
# docker-compose.yml
services:
  sensorpush-recorder:
    environment:
      RECORDER_TOKEN: "$(openssl rand -hex 32)"  # paste a real value here
```

Env var wins over the file. Use this if you'd rather keep the secret out of the writable container filesystem (e.g. injected from Vault, Compose secret, etc.). To rotate when env-managed, edit compose and restart.

To rotate a UI-managed token: Settings → Security → **Rotate token**. Existing clients fail until you paste the new value into them.

## API

`GET /` returns the sensor list as JSON when called with `Accept: application/json` (default for `fetch()`), and serves the Explorer UI when called with `Accept: text/html` (default for browser navigation). The dual response on the root URL is what lets `https://sensors.example.com` work as both an API endpoint and a UI.

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{ok, sensorCount, lastPoll, pollError}` |
| GET | `/` | sensors list (JSON) or Explorer UI (HTML) |
| GET | `/gateways` | per-gateway status: name, last seen, version, paired |
| GET | `/:id/history?range=24h` | time series; ranges: `1h`, `24h`, `7d`, `30d`, `90d`, `1yr` (h=raw, d=hourly avg, yr=daily avg) |
| GET | `/:id/history/all?range=7d` | includes excluded points (data QA) |
| GET | `/:id/history.csv?range=7d` | same data as `/history`, CSV with attachment disposition |
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

192 vitest tests across `db.test.js`, `poller.test.js`, `sensorpush.test.js`, `server.test.js`, `ui-helpers.test.js`, `config.test.js`. All run in-memory (no DB or network required); `sensorpush.test.js` and `poller.test.js` mock `node-fetch` and `../sensorpush.js` respectively.

CI: `.gitlab-ci.yml` runs `npm test` on every push and merge request against a Node 22-alpine runner.

## Deploying to a public URL

Run behind a reverse proxy (Cloudflare Tunnel, nginx, Caddy) terminating TLS at e.g. `https://sensors.example.com` → `http://docker-host:3003`. Add that origin to `CORS_ORIGINS` for any frontend that fetches from it.

## License

MIT
