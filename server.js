import express from 'express';
import compression from 'compression';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { openDb, getSensors, getHistory, getHistoryAll, getGaps, setReadingExcluded, setHourlyExcluded, rangeToSeconds, rangeUnit, getUiSettings, setUiSettings, getGateways, gatewayOnlineDuringWindow, getSensorPrimaryGateway, getGatewayUptime, countSensorsByPrimaryGateway, getBatteryHistory, computeBatteryForecast, listSensorPairs, getSensorPair, createSensorPair, deleteSensorPair, getPairAlignedHourly, createEvent, listEvents, updateEvent, deleteEvent, getEventById, listNotifStates, getOldestReadingTs, getOutdoorHistory, getLatestOutdoorReading } from './db.js';
import { computeDriftStats } from './drift.js';
import { startPoller, getPollStatus, triggerPoll, triggerBackfill, triggerGapBackfill, getBackfillStatus, triggerWeatherPoll } from './poller.js';
import { loadConfig, DB_PATH, PORT } from './config.js';
import { getToken, getTokenSource, setToken, clearStoredToken, generateToken, tokenMatches, createSession, verifySession, readSessionCookie, sessionCookieHeader } from './auth.js';
import { detectCycles, pickDefaultThermostatSensor, combineZoneSeries } from './hvac.js';
import { validateNotifConfig, dispatchWebhook, dispatchNtfy } from './notifications.js';
import { listBackups, isRestorableName, restoreBackup } from './backups.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_HTML = readFileSync(join(__dirname, 'ui.html'), 'utf8');

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="108" fill="#1a1a1a"/>
  <rect x="216" y="76" width="80" height="240" rx="40" fill="#252525"/>
  <rect x="216" y="76" width="80" height="240" rx="40" fill="none" stroke="#4db8ff" stroke-width="14"/>
  <rect x="232" y="196" width="48" height="132" rx="24" fill="#ff6b5b"/>
  <circle cx="256" cy="380" r="66" fill="#252525"/>
  <circle cx="256" cy="380" r="66" fill="none" stroke="#4db8ff" stroke-width="14"/>
  <circle cx="256" cy="380" r="50" fill="#ff6b5b"/>
  <rect x="296" y="128" width="22" height="9" rx="4" fill="#4db8ff" opacity="0.65"/>
  <rect x="296" y="168" width="22" height="9" rx="4" fill="#4db8ff" opacity="0.65"/>
  <rect x="296" y="208" width="22" height="9" rx="4" fill="#4db8ff" opacity="0.5"/>
  <rect x="296" y="248" width="14" height="9" rx="4" fill="#4db8ff" opacity="0.4"/>
  <path d="M 182 202 Q 148 228 182 254" fill="none" stroke="#4db8ff" stroke-width="14" stroke-linecap="round" opacity="0.8"/>
  <path d="M 160 176 Q 112 228 160 280" fill="none" stroke="#4db8ff" stroke-width="14" stroke-linecap="round" opacity="0.45"/>
</svg>`;

// Procedurally generate the PWA icon: a thermometer (capsule body + bulb) on
// a rounded-rect dark background, at the given size. Pure built-ins (no PNG
// encoder dependency) — we hand-roll a single-IDAT, no-filter PNG chunk.
//
// Layout (all coords scale with `f = size / 512`):
//   tW/tH           — thermometer body width / height
//   tX/tY           — body top-left
//   bR / bCY        — bulb radius / center-Y (bulb sits below body)
//   bord            — outline thickness (blue border around body and bulb)
//   tRx             — body's capsule radius (= half its width)
//   filY            — y-coord above which body is empty (dark) and below
//                     which it's filled with mercury red
//   rc              — corner radius of the dark-grey rounded-rect background
function makePNG(size) {
  const W = size, H = size, cx = W / 2, f = size / 512;
  const tW = Math.round(80*f), tH = Math.round(248*f);
  const tX = cx - tW/2,        tY = Math.round(72*f);
  const bR = Math.round(66*f), bCY = Math.round(380*f);
  const bord = Math.max(2, Math.round(14*f)), tRx = tW/2;
  const filY = Math.round(tY + tH*0.38), rc = Math.round(108*f);

  // CRC32 table + per-chunk PNG writer (length, type, data, CRC).
  const crcTable = new Uint32Array(256);
  for (let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c&1)?0xedb88320^(c>>>1):(c>>>1);crcTable[i]=c;}
  const crc32 = buf => { let c=0xffffffff; for(const b of buf)c=crcTable[(c^b)&0xff]^(c>>>8); return(c^0xffffffff)>>>0; };
  const pngChunk = (type,data) => {
    const t=Buffer.from(type,'ascii'),l=Buffer.alloc(4),cv=Buffer.alloc(4);
    l.writeUInt32BE(data.length); cv.writeUInt32BE(crc32(Buffer.concat([t,data])));
    return Buffer.concat([l,t,data,cv]);
  };

  // px(x, y) → [r, g, b, a]. Tested in order: rounded-rect background corner
  // (anti-aliased fall-off), bulb (red interior + blue ring), thermometer
  // body (capsule shape: rectangle middle, semicircular caps top + bottom),
  // else the dark-grey background.
  function px(x,y) {
    const ddx=Math.min(x,W-1-x), ddy=Math.min(y,H-1-y); let a=255;
    // Rounded-rect alpha: corner pixels outside the corner radius are
    // transparent; a 1.5-pixel ramp near the radius gives soft edges.
    if(ddx<rc&&ddy<rc){const d=Math.sqrt((rc-ddx)**2+(rc-ddy)**2);if(d>rc)return[0,0,0,0];if(d>rc-1.5)a=Math.round(255*(rc-d)/1.5);}
    // Bulb: red fill inside (bR-bord), blue ring outside.
    const bx=x-cx,by=y-bCY,bd=Math.sqrt(bx*bx+by*by);
    if(bd<=bR){if(bd<=bR-bord)return[255,107,91,a];return[77,184,255,a];}
    // Thermometer body capsule.
    if(y>=tY&&y<=tY+tH){
      const tCT=tY+tRx,tCB=tY+tH-tRx,tx=x-cx; let inT=false;
      if(y>=tCT&&y<=tCB)inT=Math.abs(tx)<=tRx;
      else if(y<tCT)inT=Math.sqrt(tx*tx+(y-tCT)**2)<=tRx;
      else           inT=Math.sqrt(tx*tx+(y-tCB)**2)<=tRx;
      if(inT){
        // Edge band → blue border; below filY → mercury red; above → empty grey.
        if(Math.abs(tx)>tRx-bord||y<tCT)return[77,184,255,a];
        if(y>=filY)return[255,107,91,a];
        return[37,37,37,a];
      }
    }
    return[26,26,26,a];
  }

  const ihdr=Buffer.alloc(13);
  ihdr.writeUInt32BE(W,0); ihdr.writeUInt32BE(H,4); ihdr[8]=8; ihdr[9]=6;
  const rows=Buffer.alloc(H*(1+W*4));
  for(let y=0;y<H;y++){
    rows[y*(1+W*4)]=0;
    for(let x=0;x<W;x++){const[r,g,b,al]=px(x,y),i=y*(1+W*4)+1+x*4;rows[i]=r;rows[i+1]=g;rows[i+2]=b;rows[i+3]=al;}
  }
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk('IHDR',ihdr),
    pngChunk('IDAT',deflateSync(rows,{level:6})),
    pngChunk('IEND',Buffer.alloc(0)),
  ]);
}

const ICON_PNG_192 = makePNG(192);
const ICON_PNG_512 = makePNG(512);

const SW_JS = `'use strict';
const CACHE='sensorpush-v23';
// Pre-cache the root so the UI is offline-available on first nav.
// Server now defaults '/' to HTML (only returns JSON when Accept includes
// application/json), so we no longer need to set Accept: text/html here —
// but doing so costs nothing and keeps intent obvious.
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.add(new Request(self.registration.scope,{cache:'reload',headers:{'Accept':'text/html'}}))).catch(()=>{}));
  self.skipWaiting();
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const url=new URL(e.request.url);
  if(url.pathname.match(/\\/(history|gaps|poll|health|gateways|backfill|backups|settings|battery|hvac|weather|auth)\\b/))return;
  // Root path serves HTML for navigation but JSON for data fetches — let data fetches bypass SW
  if(url.pathname==='/'&&!(e.request.headers.get('Accept')||'').includes('text/html'))return;
  e.respondWith(caches.match(e.request).then(cached=>{
    const net=fetch(e.request).then(r=>{if(r.ok)caches.open(CACHE).then(c=>c.put(e.request,r.clone()));return r;}).catch(()=>null);
    return cached||net||new Response('Offline',{status:503});
  }));
});
`;

// Comma-separated allowlist, e.g. CORS_ORIGINS="https://app.example.com,http://localhost:8080".
// Echoes the request Origin only when it's in the allowlist; never sends "*".
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// How long /health tolerates a silent poll loop before reporting unhealthy.
// Default 1800s — six missed 5-minute polls. Set 0 to disable the check
// entirely (pure liveness, the pre-2026-09 behaviour). Only applies once a
// first poll has succeeded — see the /health route for why. Read per request
// rather than captured at import so it can be tuned without a rebuild.
const DEFAULT_HEALTH_MAX_POLL_AGE_SECS = 1800;
function healthMaxPollAgeSecs() {
  const raw = Number(process.env.HEALTH_MAX_POLL_AGE_SECS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_HEALTH_MAX_POLL_AGE_SECS;
}

// Max age of the cached /metrics body before the next scrape triggers a
// re-render. Default 15s — comfortably under a 30s scrape interval, so a
// scraper normally sees data at most one interval old. Read per request so it
// can be tuned without a rebuild.
const DEFAULT_METRICS_MAX_AGE_MS = 15000;
function metricsMaxAgeMs() {
  const raw = Number(process.env.METRICS_MAX_AGE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_METRICS_MAX_AGE_MS;
}

// Bearer token resolution: env (RECORDER_TOKEN) > /data/recorder-token file
// (managed via Settings → Security in the UI) > null (no auth). See auth.js.
//
// Public bypass paths — health, metrics, UI assets, and the browser sign-in
// endpoint (each of its methods checks the token or session itself). The
// auth-bootstrap endpoint needs no entry: with no token set, nothing is gated.
const PUBLIC_PATHS = new Set([
  '/health',
  '/metrics',
  '/ui',
  '/icon.svg', '/icon-192.png', '/icon-512.png',
  '/sw.js', '/manifest.json', '/favicon.ico',
  '/auth/session',
]);

// True when the request reached us over TLS, directly or through a proxy that
// says so. It only decides the session cookie's Secure flag.
function requestIsTls(req) {
  if (req.secure) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

// How a request proves it holds the token: 'bearer', 'session', or null.
// A bearer, when present, is the only thing checked. A session cookie counts
// only when a browser didn't mark the request as coming from another site:
// SameSite=Strict already keeps other sites' requests from carrying it, but a
// sibling subdomain is the "same site", so Sec-Fetch-Site: same-site is refused
// too. That header only ever narrows access here. Any client can send it, so it
// never grants any (GHSA-j7mj-3739-5mg9).
function authVia(req, token) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (m) return tokenMatches(m[1], token) ? 'bearer' : null;
  if (!verifySession(readSessionCookie(req.headers.cookie), token)) return null;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return null;
  return 'session';
}

// ── Comfort-config validation ───────────────────────────────────────────────
// Used by PUT /settings to reject malformed comfort blobs before they hit
// the meta JSON column. Shape:
//   { groups?: { [groupKey]: ComfortEntry|null }, sensors?: { [id]: ComfortEntry|null } }
// where a ComfortEntry is { temp?: { lo?: number, hi?: number }, hum?: same }
// (null disables comfort for that group/sensor; absent fields fall through).
function _validRange(r) {
  if (r == null) return true;
  if (typeof r !== 'object' || Array.isArray(r)) return false;
  for (const k of Object.keys(r)) {
    if (k !== 'lo' && k !== 'hi') return false;
    if (r[k] != null && (typeof r[k] !== 'number' || !isFinite(r[k]))) return false;
  }
  return true;
}
function _validComfortEntry(e) {
  if (e == null) return true;
  if (typeof e !== 'object' || Array.isArray(e)) return false;
  for (const k of Object.keys(e)) {
    if (k !== 'temp' && k !== 'hum') return false;
    if (!_validRange(e[k])) return false;
  }
  return true;
}
function _validComfortConfig(c) {
  if (c == null) return true;
  if (typeof c !== 'object' || Array.isArray(c)) return false;
  for (const k of Object.keys(c)) {
    if (k !== 'groups' && k !== 'sensors') return false;
    const v = c[k];
    if (v == null) continue;
    if (typeof v !== 'object' || Array.isArray(v)) return false;
    for (const k2 of Object.keys(v)) {
      if (!_validComfortEntry(v[k2])) return false;
    }
  }
  return true;
}

// Drift thresholds shape:
//   { temp?: number, hum?: number }
// Both keys are positive finite numbers (°F/day and %RH/day). Null or
// missing means "use defaults".
function _validDriftThresholds(d) {
  if (d == null) return true;
  if (typeof d !== 'object' || Array.isArray(d)) return false;
  for (const k of Object.keys(d)) {
    if (k !== 'temp' && k !== 'hum') return false;
    const v = d[k];
    if (v == null) continue;
    if (typeof v !== 'number' || !isFinite(v) || v < 0) return false;
  }
  return true;
}

// HVAC config validation. Shape (all fields optional):
//   {
//     sensors?: { [sensorId]: { thermostat?: boolean, zone?: string } | null },
//     shortCycleMinutes?: number > 0,
//     slopeThresholdF?:   number > 0,
//   }
function _validHvacConfig(c) {
  if (c == null) return true;
  if (typeof c !== 'object' || Array.isArray(c)) return false;
  for (const k of Object.keys(c)) {
    if (k === 'sensors') {
      const v = c.sensors;
      if (v == null) continue;
      if (typeof v !== 'object' || Array.isArray(v)) return false;
      for (const id of Object.keys(v)) {
        const e = v[id];
        if (e == null) continue;
        if (typeof e !== 'object' || Array.isArray(e)) return false;
        for (const k2 of Object.keys(e)) {
          if (k2 === 'thermostat') {
            if (typeof e.thermostat !== 'boolean') return false;
          } else if (k2 === 'zone' || k2 === 'coolingZone') {
            if (e[k2] != null && typeof e[k2] !== 'string') return false;
          } else {
            return false;
          }
        }
      }
    } else if (k === 'shortCycleMinutes' || k === 'slopeThresholdF' || k === 'outdoorMarginF') {
      const v = c[k];
      if (v == null) continue;
      if (typeof v !== 'number' || !isFinite(v) || v <= 0) return false;
    } else {
      return false;
    }
  }
  return true;
}

// Server-side mirror of ui.html's classifySensor (top-level group only),
// kept in sync with the keyword set there. Used to scope the auto-default
// thermostat reference to indoor sensors only. If you tweak the keyword
// lists in ui.html, update them here too.
// Compute (epochMs - "wall clock as if it were UTC") for a given IANA tz at a
// given instant — i.e. the tz's offset in seconds, with DST applied. Returns
// 0 for an unknown tz so callers degrade to UTC behavior rather than
// erroring. Uses Intl.DateTimeFormat for tz arithmetic (no library deps).
function _tzOffsetSecs(epochMs, tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    const parts = fmt.formatToParts(new Date(epochMs));
    const get = k => parts.find(p => p.type === k)?.value;
    const h = +get('hour') === 24 ? 0 : +get('hour');
    const localAsUtc = Date.UTC(+get('year'), +get('month') - 1, +get('day'),
                                h, +get('minute'), +get('second'));
    return Math.round((localAsUtc - epochMs) / 1000);
  } catch {
    return 0;
  }
}

// Format a UTC epoch-seconds value as a YYYY-MM-DD string in the given tz.
// Used so daily-breakdown date labels match the user's calendar day.
function _localDateStr(epochSecs, tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    return fmt.format(new Date(epochSecs * 1000));
  } catch {
    return new Date(epochSecs * 1000).toISOString().slice(0, 10);
  }
}

function _classifySensorGroup(name) {
  const n = name || '';
  if (/\b(fridge|refrig|freezer|cabinet|rack|server|cooler|wine|incubator|pantry)\b/i.test(n))
    return 'appliance';
  if (/\b(outside|outdoor|yard|patio|deck|shed|garage|exterior|porch)\b/i.test(n))
    return 'outside';
  if (/\b(attic|bedroom|bedrm|bath|nursery|loft|master|kids?|living|kitchen|dining|family|foyer|den|study|office|main|hallway|entry|mudroom|basement|cellar|crawl)\b/i.test(n))
    return 'house';
  return 'other';
}

// Escape a Prometheus label value per the text exposition spec: backslash,
// double-quote, and newline are the only required escapes.
function _escapeLabel(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// Render the /metrics body as Prometheus text exposition format. Pulled out
// of the route so server.test.js can assert content without an HTTP roundtrip.
export function _renderMetrics(db) {
  const lines = [];
  const sensors  = getSensors(db);
  const gateways = getGateways(db);
  const { lastPollTime, lastGoodPollTime, lastPollError, pollSkipped } = getPollStatus();

  // Per-sensor gauges. Skip inactive sensors and per-metric nulls so the
  // scraper doesn't see NaN. Labels carry enough context (id+name+type) for
  // dashboard queries without forcing the user to JOIN against a sidecar.
  const SENSOR_METRICS = [
    { name: 'sensorpush_temperature_fahrenheit',          help: 'Latest reading temperature in degrees Fahrenheit.',                   key: 'temperature' },
    { name: 'sensorpush_humidity_percent',                help: 'Latest reading relative humidity (0-100).',                           key: 'humidity' },
    { name: 'sensorpush_dewpoint_fahrenheit',             help: 'Latest reading dewpoint in degrees Fahrenheit.',                      key: 'dewpoint' },
    { name: 'sensorpush_vapor_pressure_deficit_kpa',      help: 'Latest reading vapor pressure deficit in kilopascals.',               key: 'vpd' },
    { name: 'sensorpush_battery_volts',                   help: 'Most-recent reported battery voltage from the sensor record.',        key: 'battery_voltage' },
    { name: 'sensorpush_rssi_dbm',                        help: 'Most-recent reported RSSI to the gateway in dBm.',                    key: 'rssi' },
    { name: 'sensorpush_last_reading_timestamp_seconds',  help: 'Unix epoch (seconds) of the most recent non-excluded reading.',       key: 'last_ts' },
  ];
  const activeSensors = sensors.filter(s => s.active);
  for (const m of SENSOR_METRICS) {
    lines.push(`# HELP ${m.name} ${m.help}`);
    lines.push(`# TYPE ${m.name} gauge`);
    for (const s of activeSensors) {
      const v = s[m.key];
      if (v == null) continue;
      const labels = `sensor_id="${_escapeLabel(s.id)}",sensor_name="${_escapeLabel(s.name)}",sensor_type="${_escapeLabel(s.type)}"`;
      lines.push(`${m.name}{${labels}} ${v}`);
    }
  }

  // Per-gateway last-seen, for "did the gateway go offline?" alerting.
  lines.push(`# HELP sensorpush_gateway_last_seen_timestamp_seconds Unix epoch (seconds) when the gateway last reported in.`);
  lines.push(`# TYPE sensorpush_gateway_last_seen_timestamp_seconds gauge`);
  for (const g of gateways) {
    if (g.last_seen == null) continue;
    lines.push(`sensorpush_gateway_last_seen_timestamp_seconds{gateway_id="${_escapeLabel(g.id)}",gateway_name="${_escapeLabel(g.name)}"} ${g.last_seen}`);
  }

  // Poll-health gauges.
  // _timestamp_seconds is the last SUCCESSFUL poll, carried across restarts
  // (meta.last_poll, read at start), so its age keeps growing through a
  // restart while the polls still fail. It is absent only before the first
  // good poll ever.
  // _success is about the latest poll since this start: 1 it succeeded, 0 it
  // failed, -1 none has finished yet — VM/alerts can `== 0` or `< 0`
  // distinctly. The error is checked first: when it was checked second, a
  // restart whose polls all failed reported -1 for as long as they failed.
  const successVal = lastPollError ? 0 : (lastPollTime == null ? -1 : 1);
  lines.push(`# HELP sensorpush_last_poll_timestamp_seconds Unix epoch (seconds) of the last successful poll, kept across restarts.`);
  lines.push(`# TYPE sensorpush_last_poll_timestamp_seconds gauge`);
  if (lastGoodPollTime != null) lines.push(`sensorpush_last_poll_timestamp_seconds ${Math.floor(lastGoodPollTime / 1000)}`);

  lines.push(`# HELP sensorpush_last_poll_success 1 if the latest poll since the recorder started succeeded, 0 if it failed, -1 if none has finished yet.`);
  lines.push(`# TYPE sensorpush_last_poll_success gauge`);
  lines.push(`sensorpush_last_poll_success ${successVal}`);

  lines.push(`# HELP sensorpush_sensors_total Number of registered sensors.`);
  lines.push(`# TYPE sensorpush_sensors_total gauge`);
  lines.push(`sensorpush_sensors_total ${sensors.length}`);

  lines.push(`# HELP sensorpush_sensors_active Number of sensors marked active.`);
  lines.push(`# TYPE sensorpush_sensors_active gauge`);
  lines.push(`sensorpush_sensors_active ${activeSensors.length}`);

  // Poll ticks dropped because the previous poll was still running. Non-zero
  // means polls are outrunning their 5-minute interval — the early warning of
  // a slow-disk window, well before the poller actually stops producing data.
  lines.push(`# HELP sensorpush_poll_skipped_ticks Poll ticks skipped because the previous poll was still in flight.`);
  lines.push(`# TYPE sensorpush_poll_skipped_ticks gauge`);
  lines.push(`sensorpush_poll_skipped_ticks ${pollSkipped ?? 0}`);

  // When this body was actually rendered. /metrics serves from a cache (see
  // the route), so a scraper that wants to know the underlying data is fresh
  // should check `time() - sensorpush_metrics_rendered_timestamp_seconds`
  // rather than trusting the scrape timestamp.
  lines.push(`# HELP sensorpush_metrics_rendered_timestamp_seconds Unix epoch (seconds) when this metrics body was rendered.`);
  lines.push(`# TYPE sensorpush_metrics_rendered_timestamp_seconds gauge`);
  lines.push(`sensorpush_metrics_rendered_timestamp_seconds ${Math.floor(Date.now() / 1000)}`);

  return lines.join('\n') + '\n';
}


// The `db` parameter is intentionally mutable inside this function — the
// /backups/:filename/restore route reassigns it to the freshly-reopened
// handle after a restore, and ESM's let-style parameter bindings let the
// other route closures pick up the new value without further plumbing.
// `onSwap` is fired after the local reassignment so the bootstrap can
// propagate the new handle to the poller (which captured its own `db`).
export function createApp(db, config = null, onSwap = null) {
  const app = express();
  // gzip/deflate all eligible responses (text/html, application/json, …).
  // Negotiates Accept-Encoding, skips already-compressed types (PNG icons),
  // and below-threshold bodies. Registered first so it wraps every route.
  app.use(compression());
  app.use(express.json());

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && CORS_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Token gate. Only enforced when a token is configured (env or /data
  // file); then a request needs `Authorization: Bearer <token>` or a valid
  // session cookie (see authVia). Bypasses:
  //   1. Public paths (health, metrics, UI assets, manifest, sw, favicon,
  //      and the /auth/session sign-in endpoint).
  //   2. HTML GET / — the Explorer UI loads via direct browser nav, then
  //      signs in with the token to get its session cookie.
  //   3. POST /settings/auth/generate when no token is set — bootstrap
  //      flow so a fresh recorder can mint its first token from the UI.
  // The rosestorie dashboard pane goes through user-api's proxy, which
  // injects the bearer server-side.
  app.use((req, res, next) => {
    const token = getToken();
    if (!token) return next();
    if (PUBLIC_PATHS.has(req.path)) return next();
    if (req.path === '/' && !(req.headers.accept || '').includes('application/json')) return next();
    if (!authVia(req, token)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  app.get('/health', (_req, res) => {
    // Still deliberately does NO database work. This is the Docker healthcheck
    // target; it once ran `SELECT COUNT(*) FROM sensors`, which coupled liveness
    // to DB responsiveness, so any heavy fsync-bound sqlite op that froze the
    // event loop ALSO failed the healthcheck and escalated a transient stall
    // into an autoheal restart loop.
    //
    // But pure liveness is blind in the other direction: it answers `ok: true`
    // however long the poll loop has produced nothing. So we now also assert,
    // from in-memory state only, that the poll loop is still producing. Two
    // deliberate constraints keep this from reintroducing the false positives
    // the DB query caused:
    //
    //   1. It engages only AFTER the first successful poll. A recorder that has
    //      never polled (fresh deploy, bad credentials) reports healthy — a
    //      restart cannot fix either, and restart-looping a new container is
    //      exactly the old failure. That case is caught by the poll-health
    //      gauges on /metrics instead (last_poll_success 0), where the remedy
    //      is an alert rather than a container kill. A recorder whose polls
    //      start failing while it runs (a changed password) therefore gets one
    //      autoheal restart, then reports healthy.
    //   2. The window is generous — 30 minutes, i.e. six consecutive missed
    //      5-minute polls — so a single slow window never trips it.
    //
    // lastPoll is this process's last good poll, never the stored one /metrics
    // reports: lastPoll and pollError both start empty, and the first poll
    // fills exactly one, which is how a caller tells whether a restarted
    // recorder can sign in. Being per-process is also what keeps constraint 1
    // true after a restart.
    const { lastPollTime, lastPollError, lastSensorCount, pollSkipped } = getPollStatus();
    const limitSecs   = healthMaxPollAgeSecs();
    const pollAgeMs   = lastPollTime == null ? null : Date.now() - lastPollTime;
    const pollAgeSecs = pollAgeMs == null ? null : Math.floor(pollAgeMs / 1000);
    const stale = limitSecs > 0 && pollAgeMs != null && pollAgeMs > limitSecs * 1000;
    res.status(stale ? 503 : 200).json({
      ok:          !stale,
      lastPoll:    lastPollTime ? new Date(lastPollTime).toISOString() : null,
      pollAgeSecs,
      pollError:   lastPollError,
      pollSkipped: pollSkipped ?? 0,
      sensorCount: lastSensorCount ?? null,
      ...(stale ? { error: `no successful poll in ${pollAgeSecs}s (limit ${limitSecs}s)` } : {}),
    });
  });

  // GET /metrics — Prometheus text exposition for VictoriaMetrics scrape.
  // One gauge per (sensor, metric); skipped per-line when a value is null
  // so we don't emit NaN. Inactive sensors are excluded. Labels are escaped
  // per the exposition spec (backslash, double-quote, newline).
  // Bypasses the bearer middleware via PUBLIC_PATHS — LAN scrape pattern
  // matches the rest of the home-lab stack (node_exporter, dhcp_reservations_exporter).
  //
  // Served from a cache, refreshed AFTER the response is flushed. _renderMetrics
  // runs two node:sqlite queries, and node:sqlite is fully synchronous — so
  // rendering on the request path put a DB read in front of every scrape. When
  // the nightly hypervisor backup fsync-freezes this guest and disk await goes
  // from ~2ms to ~1200ms, those reads blew straight through the 10s scrape
  // timeout: during the 2026-09-02 incident scrape_duration_seconds pinned at
  // exactly 10.002s, interleaved with 0.003s successes, while /health (no DB)
  // stayed instant. Serving the last rendered body means a scrape is a string
  // write no matter what the disk is doing; the body carries its own render
  // timestamp so a stale one is visible rather than silently believed.
  const metricsCache = { text: null, renderedAt: 0, refreshing: false };
  const refreshMetrics = () => {
    metricsCache.refreshing = true;
    setImmediate(() => {
      try {
        metricsCache.text       = _renderMetrics(db);
        metricsCache.renderedAt = Date.now();
      } catch (err) {
        console.error('[metrics] refresh failed:', err.message);
      } finally {
        metricsCache.refreshing = false;
      }
    });
  };

  app.get('/metrics', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    // Cold start only: nothing cached yet, so render inline.
    if (metricsCache.text == null) {
      metricsCache.text       = _renderMetrics(db);
      metricsCache.renderedAt = Date.now();
      return res.send(metricsCache.text);
    }
    res.send(metricsCache.text);
    if (!metricsCache.refreshing && Date.now() - metricsCache.renderedAt >= metricsMaxAgeMs()) {
      refreshMetrics();
    }
  });

  // GET / → ui.html by default; JSON sensors list only when the caller
  // explicitly opts in via Accept: application/json. Defaulting to HTML
  // means a reverse proxy that strips/replaces Accept (or any new visitor
  // before the SW caches the HTML) still lands on the Explorer UI instead
  // of a raw JSON dump. The UI's own fetch() calls set Accept: application/json
  // so they continue to receive the sensor list.
  app.get('/', (req, res) => {
    if (!(req.headers.accept || '').includes('application/json')) {
      return res.setHeader('Content-Type', 'text/html').send(UI_HTML);
    }
    const rows    = getSensors(db);
    const sensors = {};
    for (const row of rows) {
      sensors[row.id] = {
        id:             row.id,
        name:           row.name,
        type:           row.type,
        active:         !!row.active,
        temperature:    row.temperature,
        humidity:       row.humidity,
        baroPressure:   row.baro_pressure,
        batteryVoltage: row.battery_voltage,
        rssi:           row.rssi,
        address:        row.address,
        deviceId:       row.device_id,
        lastSeen:       row.last_ts ? new Date(row.last_ts * 1000).toISOString() : null,
        alerts:         row.alerts ? JSON.parse(row.alerts) : null,
      };
    }
    // oldestReadingTs lets the Stats YoY toggle decide whether enough history
    // exists to show a comparison overlay (≥ 1 year + the current range).
    res.json({ ok: true, sensors, oldestReadingTs: getOldestReadingTs(db) });
  });

  app.get('/:id/history', (req, res) => {
    const sensorId = req.params.id;
    const range    = req.query.range || '24h';
    const rangeSecs = rangeToSeconds(range);
    if (!rangeSecs) return res.status(400).json({ ok: false, error: 'Invalid range. Use e.g. 2h, 24h, 7d, 30d, 1yr.' });
    // Optional endTs anchors the window at an arbitrary epoch (seconds). The
    // Stats YoY overlay passes "now - 1 year" to fetch the same range from a
    // year ago. Default anchor = "now" preserves the old behavior.
    let endTs = null;
    if (req.query.endTs != null) {
      const parsed = parseInt(req.query.endTs, 10);
      if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== String(req.query.endTs)) {
        return res.status(400).json({ ok: false, error: 'endTs must be a positive integer (Unix seconds).' });
      }
      endTs = parsed;
    }
    const sensor = db.prepare('SELECT id FROM sensors WHERE id = ?').get(sensorId);
    if (!sensor) return res.status(404).json({ ok: false, error: 'Sensor not found' });
    const samples = getHistory(db, sensorId, range, endTs);
    res.json({ ok: true, sensorId, range, resolution: rangeUnit(range) === 'h' ? 'raw' : rangeUnit(range) === 'd' ? 'hourly' : 'daily', samples });
  });

  // CSV export — same data getHistory returns (resolution depends on range
  // unit), shaped for spreadsheet import. Excluded points are filtered out
  // to match /history (use /history/all if you want excluded data; we don't
  // expose a CSV variant of that since CSV export is meant for analysis).
  app.get('/:id/history.csv', (req, res) => {
    const sensorId = req.params.id;
    const range    = req.query.range || '7d';
    if (!rangeToSeconds(range))
      return res.status(400).type('text/plain').send('Invalid range. Use e.g. 24h, 7d, 30d, 1yr.');
    const sensor = db.prepare('SELECT id, name FROM sensors WHERE id = ?').get(sensorId);
    if (!sensor) return res.status(404).type('text/plain').send('Sensor not found');

    const samples = getHistory(db, sensorId, range);
    const unit    = rangeUnit(range);
    // Column set varies by resolution: raw has dewpoint/vpd per sample,
    // hourly/daily aggregates expose min/max bands.
    const cols = unit === 'h'
      ? ['ts', 'observed_iso', 'temperature', 'humidity', 'baro_pressure', 'dewpoint', 'vpd']
      : ['ts', 'observed_iso', 'temperature', 'temp_min', 'temp_max', 'humidity', 'hum_min', 'hum_max', 'baro_pressure', 'dewpoint', 'vpd'];

    const fmt = v => v == null ? '' : (typeof v === 'number' ? v.toString() : String(v));
    const rows = samples.map(s => cols.map(c => {
      switch (c) {
        case 'ts':            return fmt(s.ts);
        case 'observed_iso':  return new Date(s.ts * 1000).toISOString();
        case 'baro_pressure': return fmt(s.baroPressure);
        case 'temp_min':      return fmt(s.tempMin);
        case 'temp_max':      return fmt(s.tempMax);
        case 'hum_min':       return fmt(s.humMin);
        case 'hum_max':       return fmt(s.humMax);
        default:              return fmt(s[c]);
      }
    }).join(','));

    const safeName = (sensor.name || sensorId).replace(/[^a-z0-9_-]+/gi, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
       .setHeader('Content-Disposition', `attachment; filename="${safeName}-${range}.csv"`)
       .send(cols.join(',') + '\n' + rows.join('\n') + (rows.length ? '\n' : ''));
  });

  // Like /history but includes excluded points (for the data explorer UI)
  app.get('/:id/history/all', (req, res) => {
    const sensorId = req.params.id;
    const range    = req.query.range || '24h';
    const rangeSecs = rangeToSeconds(range);
    if (!rangeSecs) return res.status(400).json({ ok: false, error: 'Invalid range. Use e.g. 2h, 24h, 7d, 30d, 1yr.' });
    const sensor = db.prepare('SELECT id FROM sensors WHERE id = ?').get(sensorId);
    if (!sensor) return res.status(404).json({ ok: false, error: 'Sensor not found' });
    const samples = getHistoryAll(db, sensorId, range);
    res.json({ ok: true, sensorId, range, resolution: rangeUnit(range) === 'h' ? 'raw' : rangeUnit(range) === 'd' ? 'hourly' : 'daily', samples });
  });

  app.get('/:id/gaps', (req, res) => {
    const sensorId = req.params.id;
    const range    = req.query.range || '7d';
    if (!rangeToSeconds(range))
      return res.status(400).json({ ok: false, error: 'Invalid range. Use e.g. 2h, 24h, 7d, 30d, 1yr.' });
    const sensor = db.prepare('SELECT id FROM sensors WHERE id = ?').get(sensorId);
    if (!sensor) return res.status(404).json({ ok: false, error: 'Sensor not found' });
    const result = getGaps(db, sensorId, range);
    // Annotate each gap with whether the sensor's primary gateway was online
    // during the window. Falls back to "any gateway" when the sensor has no
    // gateway attribution yet (readings predate the gateway_id column).
    const primaryId   = getSensorPrimaryGateway(db, sensorId);
    const gateways    = getGateways(db);
    const primaryName = primaryId ? (gateways.find(g => g.id === primaryId)?.name ?? null) : null;
    result.primaryGatewayId   = primaryId;
    result.primaryGatewayName = primaryName;
    result.gaps = result.gaps.map(g => ({
      ...g,
      gatewayOnline: gatewayOnlineDuringWindow(db, g.startTs, g.endTs, primaryId),
    }));
    res.json({ ok: true, sensorId, range, ...result });
  });

  // Battery-replacement forecast for every sensor. The body is keyed by
  // sensor id; values are null when there's too little data (a sensor that
  // joined < a week ago) or no measurable decline. See computeBatteryForecast
  // for the projection method.
  app.get('/battery', (_req, res) => {
    const sensors  = db.prepare('SELECT id FROM sensors').all();
    const forecasts = {};
    for (const { id } of sensors) {
      const history   = getBatteryHistory(db, id, 30);
      forecasts[id]   = computeBatteryForecast(history);
    }
    res.json({ ok: true, forecasts });
  });

  // ── Sensor pairs (calibration drift) ────────────────────────────────────
  app.get('/sensor-pairs', (_req, res) => {
    const rows = listSensorPairs(db);
    res.json({
      ok: true,
      pairs: rows.map(r => ({
        id:           r.id,
        sensorAId:    r.sensor_a_id,
        sensorBId:    r.sensor_b_id,
        sensorAName:  r.sensor_a_name,
        sensorBName:  r.sensor_b_name,
        label:        r.label,
        createdAt:    r.created_at ? new Date(r.created_at * 1000).toISOString() : null,
      })),
    });
  });

  app.post('/sensor-pairs', (req, res) => {
    const { sensorAId, sensorBId, label } = req.body ?? {};
    if (typeof sensorAId !== 'string' || typeof sensorBId !== 'string' || !sensorAId || !sensorBId) {
      return res.status(400).json({ ok: false, error: 'Body must include sensorAId and sensorBId (strings)' });
    }
    if (sensorAId === sensorBId) {
      return res.status(400).json({ ok: false, error: 'sensorAId and sensorBId must differ' });
    }
    if (label != null && typeof label !== 'string') {
      return res.status(400).json({ ok: false, error: 'label must be a string when provided' });
    }
    const a = db.prepare('SELECT id FROM sensors WHERE id = ?').get(sensorAId);
    const b = db.prepare('SELECT id FROM sensors WHERE id = ?').get(sensorBId);
    if (!a || !b) return res.status(404).json({ ok: false, error: 'One or both sensors not found' });
    try {
      const row = createSensorPair(db, { sensorAId, sensorBId, label: label ?? null });
      res.json({ ok: true, pair: {
        id:        row.id,
        sensorAId: row.sensor_a_id,
        sensorBId: row.sensor_b_id,
        label:     row.label,
        createdAt: row.created_at ? new Date(row.created_at * 1000).toISOString() : null,
      } });
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) {
        return res.status(409).json({ ok: false, error: 'pair already exists' });
      }
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.delete('/sensor-pairs/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: 'Invalid id' });
    const ok = deleteSensorPair(db, id);
    if (!ok) return res.status(404).json({ ok: false, error: 'Pair not found' });
    res.json({ ok: true });
  });

  // GET /sensor-pairs/:id/drift?range=30d
  // Returns the aligned hourly delta series + computeDriftStats summary so
  // the Calibration panel can render a sparkline and a "stable / drifting"
  // verdict for each pair.
  app.get('/sensor-pairs/:id/drift', (req, res) => {
    const id    = parseInt(req.params.id, 10);
    const range = req.query.range || '30d';
    const rangeSecs = rangeToSeconds(range);
    if (!rangeSecs) return res.status(400).json({ ok: false, error: 'Invalid range. Use e.g. 7d, 30d, 90d.' });
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: 'Invalid id' });
    const pair = getSensorPair(db, id);
    if (!pair) return res.status(404).json({ ok: false, error: 'Pair not found' });
    const sinceTs = Math.floor(Date.now() / 1000) - rangeSecs;
    const samples = getPairAlignedHourly(db, pair.sensor_a_id, pair.sensor_b_id, sinceTs);
    const stats   = computeDriftStats(samples);
    res.json({
      ok:      true,
      pairId:  id,
      range,
      samples,
      stats,
    });
  });

  // HVAC duty-cycle inference. Returns per-reference-sensor analysis:
  //   - cycle list (start/end/kind/duration) over the window
  //   - heating/cooling runtime % for the window AND a daily breakdown for
  //     the last 7 days so the UI can render bar charts
  //   - short-cycle list (cycles strictly shorter than the configured
  //     threshold, default 5 min)
  //
  // Reference-sensor selection:
  //   1. If any sensors are flagged with settings.hvac.sensors.<id>.thermostat=true,
  //      analyze only those.
  //   2. Otherwise auto-select the most-stable indoor sensor (lowest 24h
  //      temperature variance) as the default — pickDefaultThermostatSensor
  //      in hvac.js handles the variance comparison; we feed it the eligible
  //      indoor sensors classified by name.
  //
  // The window for cycle detection comes from ?range= (default 24h). The
  // 7-day daily breakdown is independent of `range` — always last 7 days,
  // one detectCycles call per UTC day.
  app.get('/hvac', (req, res) => {
    const range     = req.query.range || '24h';
    const rangeSecs = rangeToSeconds(range);
    if (!rangeSecs) return res.status(400).json({ ok: false, error: 'Invalid range. Use e.g. 24h, 7d, 30d.' });

    const settings        = getUiSettings(db) || {};
    const hvacCfg         = settings.hvac || {};
    const shortCycleMins  = hvacCfg.shortCycleMinutes != null ? hvacCfg.shortCycleMinutes : 5;
    const slopeThresholdF = hvacCfg.slopeThresholdF   != null ? hvacCfg.slopeThresholdF   : 0.5;
    const outdoorMarginF  = hvacCfg.outdoorMarginF    != null ? hvacCfg.outdoorMarginF    : 2.0;
    const flagged         = hvacCfg.sensors || {};

    const sensorRows = db.prepare('SELECT id, name FROM sensors').all();
    const explicit   = sensorRows.filter(s => flagged[s.id]?.thermostat === true).map(s => s.id);

    // Outdoor samples (when available) gate cycle classification: a heating
    // cycle requires outdoor < indoor − margin, cooling requires the reverse.
    // Without this, "AC just shut off and the room is warming back up" gets
    // labeled as a heating cycle. Source priority:
    //   1. Sensors classified as 'outside' by name — preferred because they
    //      sample at 5 min cadence with the same hardware as indoor sensors,
    //      so deltas are apples-to-apples and there's no external dependency.
    //   2. outdoor_readings (Open-Meteo) — fallback when no outside-tagged
    //      sensor exists in the install.
    // Fetch the union of the request range and the 7-day daily-breakdown
    // window so a single dataset covers every detectCycles call below.
    const outdoorLookbackSecs = Math.max(rangeSecs, 7 * 86400);
    const since = Math.floor(Date.now() / 1000) - outdoorLookbackSecs;
    const outsideIds = sensorRows
      .filter(s => _classifySensorGroup(s.name) === 'outside')
      .map(s => s.id);
    let outdoorSamples = [];
    let outdoorSource  = null;
    if (outsideIds.length) {
      // UNION across all outside sensors; ORDER BY ts so the gate's
      // sliding window can short-circuit on sorted input. If a cycle's
      // window catches readings from multiple outside sensors they're
      // averaged together — fine because two outside sensors a few feet
      // apart should agree to within a degree.
      const placeholders = outsideIds.map(() => '?').join(',');
      outdoorSamples = db.prepare(
        `SELECT ts, temperature AS temp FROM readings
         WHERE sensor_id IN (${placeholders}) AND ts >= ? AND excluded = 0
         ORDER BY ts`
      ).all(...outsideIds, since);
      if (outdoorSamples.length) outdoorSource = 'outside-sensor';
    }
    if (!outdoorSamples.length) {
      outdoorSamples = db.prepare(
        'SELECT ts, temp FROM outdoor_readings WHERE ts >= ? ORDER BY ts'
      ).all(since);
      if (outdoorSamples.length) outdoorSource = 'open-meteo';
    }

    const opts = {
      shortCycleSecs:  Math.max(1, shortCycleMins * 60),
      slopeThresholdF: slopeThresholdF,
      outdoorMarginF:  outdoorMarginF,
      outdoorSamples:  outdoorSamples.length ? outdoorSamples : undefined,
    };

    // Auto-default: most-stable indoor sensor over last 24h. Skip when the
    // user has explicit flags (they've made their choice).
    let autoDefault = null;
    if (!explicit.length) {
      const since24h = Math.floor(Date.now() / 1000) - 86400;
      const stableInputs = sensorRows.map(s => ({
        id:      s.id,
        group:   _classifySensorGroup(s.name),
        samples: db.prepare(
          'SELECT ts, temperature FROM readings WHERE sensor_id = ? AND ts >= ? AND excluded = 0 ORDER BY ts'
        ).all(s.id, since24h),
      }));
      autoDefault = pickDefaultThermostatSensor(stableInputs);
    }

    const referenceIds = explicit.length ? explicit : (autoDefault ? [autoDefault] : []);

    // Group thermostat sensors into heating and cooling zones. The two zone
    // dimensions are independent — a sensor can sit in a multi-room heating
    // zone (e.g. furnace-served rooms share "Steam") while having its own
    // cooling zone (e.g. its own window AC). When the user hasn't set a zone
    // for a direction, the sensor stands alone (zone name defaults to its
    // own sensor name).
    const sensorById = Object.fromEntries(sensorRows.map(s => [s.id, s]));
    const heatingZoneMap = {};
    const coolingZoneMap = {};
    for (const id of referenceIds) {
      const sensor = sensorById[id];
      if (!sensor) continue;
      const cfg   = flagged[id] || {};
      const hZone = (cfg.zone        || '').toString().trim() || sensor.name;
      const cZone = (cfg.coolingZone || '').toString().trim() || sensor.name;
      (heatingZoneMap[hZone] ||= []).push(sensor);
      (coolingZoneMap[cZone] ||= []).push(sensor);
    }

    // Daily buckets must align with the *user's* local calendar day, not the
    // server's UTC day — otherwise a user east of UTC sees "today's" data
    // labeled with tomorrow's date (the UTC day rolls over while their local
    // clock still shows yesterday-evening). The UI passes the browser's tz
    // as a query param; we fall back to UTC if absent or invalid.
    const tz = (req.query.tz || 'UTC').toString();
    const tzOffsetSecs = _tzOffsetSecs(Date.now(), tz);
    const todayLocalMidnightUtcSecs = (() => {
      const nowMs = Date.now();
      const m = new Date(nowMs + tzOffsetSecs * 1000);
      m.setUTCHours(0, 0, 0, 0);
      return Math.floor(m.getTime() / 1000) - tzOffsetSecs;
    })();
    const dayStart = (offsetDays) => todayLocalMidnightUtcSecs - offsetDays * 86400;
    const sinceRange = Math.floor(Date.now() / 1000) - rangeSecs;
    const sinceWeek  = dayStart(7);

    const fetchSamples = (id, since) => db.prepare(
      'SELECT ts, temperature FROM readings WHERE sensor_id=? AND ts>=? AND excluded=0 ORDER BY ts'
    ).all(id, since);

    // Analyze a zone (one or more member sensors). detectCycles runs once on
    // the cross-member mean; the caller picks which direction's cycles to
    // display. Daily breakdown uses the same mean over each UTC day.
    const analyzeZone = (members) => {
      const memberSamples = members.map(m => fetchSamples(m.id, sinceRange));
      const combined = combineZoneSeries(memberSamples, 5 * 60);
      const analysis = detectCycles(combined, opts);

      const week = members.map(m => fetchSamples(m.id, sinceWeek));
      const dailyRuntime = [];
      for (let i = 6; i >= 0; i--) {
        const d0 = dayStart(i);
        const d1 = d0 + 86400;
        const slices = week.map(arr => arr.filter(r => r.ts >= d0 && r.ts < d1));
        const dayCombined = combineZoneSeries(slices, 5 * 60);
        const day = detectCycles(dayCombined, opts);
        const iso = _localDateStr(d0, tz);
        dailyRuntime.push(day.ok
          ? { date: iso, heatingRuntimePct: day.heatingRuntimePct, coolingRuntimePct: day.coolingRuntimePct, cycleCount: day.cycleCount }
          : { date: iso, heatingRuntimePct: null, coolingRuntimePct: null, cycleCount: 0 });
      }
      return {
        members:      members.map(m => ({ id: m.id, name: m.name })),
        memberCount:  members.length,
        analysis,
        dailyRuntime,
      };
    };

    const heatingZones = {};
    for (const [name, members] of Object.entries(heatingZoneMap)) {
      heatingZones[name] = analyzeZone(members);
    }
    const coolingZones = {};
    for (const [name, members] of Object.entries(coolingZoneMap)) {
      coolingZones[name] = analyzeZone(members);
    }

    res.json({
      ok: true,
      range,
      config: { shortCycleMinutes: shortCycleMins, slopeThresholdF, outdoorMarginF },
      referenceIds,
      autoDefaultId: autoDefault,
      outdoorSource,
      heatingZones,
      coolingZones,
    });
  });

  // Outdoor weather (Open-Meteo). Returns the configured-or-not state +
  // the latest reading + a history series for the requested range. The
  // `configured` flag lets the UI hide its Outdoor controls cleanly when
  // no lat/lon was supplied.
  app.get('/weather', (req, res) => {
    const range    = req.query.range || '24h';
    const rangeSecs = rangeToSeconds(range);
    if (!rangeSecs) return res.status(400).json({ ok: false, error: 'Invalid range. Use e.g. 2h, 24h, 7d, 30d, 1yr.' });
    const configured = !!(config?.weather?.lat != null && config?.weather?.lon != null);
    const samples  = getOutdoorHistory(db, range);
    const latest   = getLatestOutdoorReading(db);
    res.json({ ok: true, configured, range, latest, samples });
  });

  // Manual weather poll (mirrors POST /poll for sensors). Skips if weather
  // isn't configured. Useful for an ops button if/when we surface one.
  app.post('/weather/poll', async (_req, res) => {
    if (!config?.weather?.lat || config.weather.lon == null) {
      return res.status(503).json({ ok: false, error: 'weather not configured' });
    }
    try {
      await triggerWeatherPoll(db, config);
      const { lastWeatherPollTime } = getPollStatus();
      res.json({ ok: true, lastPoll: lastWeatherPollTime ? new Date(lastWeatherPollTime).toISOString() : null });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/gateways', (req, res) => {
    const rows  = getGateways(db);
    // Optional ?range=Xd attaches uptime % and sensor counts. Backward-compatible:
    // omitting the param keeps the old payload shape.
    const range = req.query.range;
    const rangeSecs = range ? rangeToSeconds(range) : null;
    if (range && !rangeSecs) {
      return res.status(400).json({ ok: false, error: 'Invalid range. Use e.g. 24h, 7d, 30d.' });
    }
    const since = rangeSecs ? Math.floor(Date.now() / 1000) - rangeSecs : null;
    res.json({
      ok: true,
      gateways: rows.map(r => {
        const out = {
          id:         r.id,
          name:       r.name,
          lastSeen:   r.last_seen   ? new Date(r.last_seen   * 1000).toISOString() : null,
          lastAlert:  r.last_alert  ? new Date(r.last_alert  * 1000).toISOString() : null,
          version:    r.version,
          paired:     !!r.paired,
          message:    r.message,
          lastSynced: r.last_synced ? new Date(r.last_synced * 1000).toISOString() : null,
        };
        if (since !== null) {
          out.uptime = getGatewayUptime(db, r.id, since);
          out.primaryFor = countSensorsByPrimaryGateway(db, r.id);
        }
        return out;
      }),
    });
  });

  app.patch('/:id/readings/exclude', (req, res) => {
    const sensorId = req.params.id;
    const { ts, excluded } = req.body ?? {};
    if (typeof ts !== 'number' || typeof excluded !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'Body must include ts (number) and excluded (boolean)' });
    }
    const sensor = db.prepare('SELECT id FROM sensors WHERE id = ?').get(sensorId);
    if (!sensor) return res.status(404).json({ ok: false, error: 'Sensor not found' });
    setReadingExcluded(db, sensorId, ts, excluded);
    res.json({ ok: true });
  });

  app.patch('/:id/hourly/exclude', (req, res) => {
    const sensorId = req.params.id;
    const { hour_ts, excluded } = req.body ?? {};
    if (typeof hour_ts !== 'number' || typeof excluded !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'Body must include hour_ts (number) and excluded (boolean)' });
    }
    const sensor = db.prepare('SELECT id FROM sensors WHERE id = ?').get(sensorId);
    if (!sensor) return res.status(404).json({ ok: false, error: 'Sensor not found' });
    setHourlyExcluded(db, sensorId, hour_ts, excluded);
    res.json({ ok: true });
  });

  app.post('/backfill', (req, res) => {
    if (!config) return res.status(503).json({ ok: false, error: 'No config available' });
    const { fromDate } = req.body ?? {};
    if (!fromDate || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate))
      return res.status(400).json({ ok: false, error: 'fromDate required (YYYY-MM-DD)' });
    // Parse as UTC midnight ('Z' suffix) so the start epoch is stable across
    // server timezones — without it, a UTC container and a PT host produce
    // different boundaries for the same fromDate.
    const fromTs = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
    if (isNaN(fromTs)) return res.status(400).json({ ok: false, error: 'Invalid date' });
    if (getBackfillStatus().status === 'running')
      return res.status(409).json({ ok: false, error: 'Backfill already running' });
    triggerBackfill(db, config, fromTs).catch(err => console.error('[backfill]', err.message));
    res.json({ ok: true, status: 'started' });
  });

  app.post('/backfill-gaps', (req, res) => {
    if (!config) return res.status(503).json({ ok: false, error: 'No config available' });
    const { range = '7d' } = req.body ?? {};
    if (!rangeToSeconds(range))
      return res.status(400).json({ ok: false, error: 'Invalid range. Use e.g. 24h, 7d, 30d, 1yr.' });
    if (getBackfillStatus().status === 'running')
      return res.status(409).json({ ok: false, error: 'Backfill already running' });
    triggerGapBackfill(db, config, { range }).catch(err => console.error('[gap-backfill]', err.message));
    res.json({ ok: true, status: 'started' });
  });

  app.get('/backfill/status', (_req, res) => {
    res.json({ ok: true, ...getBackfillStatus() });
  });

  app.get('/settings', (_req, res) => {
    res.json({ ok: true, settings: getUiSettings(db) || {} });
  });

  app.put('/settings', (req, res) => {
    const { ranges, comfort, driftThresholds, hvac, notifications } = req.body ?? {};
    if (!Array.isArray(ranges) || !ranges.every(r => /^\d+(h|d|yr)$/.test(r))) {
      return res.status(400).json({ ok: false, error: 'Invalid settings: ranges' });
    }
    if (comfort !== undefined && !_validComfortConfig(comfort)) {
      return res.status(400).json({ ok: false, error: 'Invalid settings: comfort' });
    }
    if (driftThresholds !== undefined && !_validDriftThresholds(driftThresholds)) {
      return res.status(400).json({ ok: false, error: 'Invalid settings: driftThresholds' });
    }
    if (hvac !== undefined && !_validHvacConfig(hvac)) {
      return res.status(400).json({ ok: false, error: 'Invalid settings: hvac' });
    }
    if (notifications !== undefined && !validateNotifConfig(notifications)) {
      return res.status(400).json({ ok: false, error: 'Invalid settings: notifications' });
    }
    // Merge with whatever else is in the meta blob (future fields stay untouched
    // even when the client only sends ranges, and vice versa).
    const existing = getUiSettings(db) || {};
    const payload = { ...existing, ranges };
    if (comfort         !== undefined) payload.comfort         = comfort;
    if (driftThresholds !== undefined) payload.driftThresholds = driftThresholds;
    if (hvac            !== undefined) payload.hvac            = hvac;
    if (notifications   !== undefined) payload.notifications   = notifications;
    setUiSettings(db, payload);
    res.json({ ok: true });
  });

  // ── Notifications: test dispatch + state inspection ─────────────────────
  // POST /settings/notifications/test — fire a one-off test message to the
  // requested sink ('webhook' | 'ntfy' | 'all'). Bypasses the state machine
  // entirely so repeated clicks always send. Body may include `sink` (default
  // 'all') and a `notifications` blob overriding the persisted config — lets
  // the UI test unsaved settings, but defaults to the saved settings when
  // omitted.
  app.post('/settings/notifications/test', async (req, res) => {
    const { sink = 'all', notifications: override } = req.body ?? {};
    if (!['webhook', 'ntfy', 'all'].includes(sink)) {
      return res.status(400).json({ ok: false, error: 'sink must be one of: webhook, ntfy, all' });
    }
    const settings = getUiSettings(db) || {};
    const notif = override !== undefined ? override : settings.notifications;
    if (!validateNotifConfig(override)) {
      return res.status(400).json({ ok: false, error: 'Invalid notifications config' });
    }
    if (!notif) {
      return res.status(400).json({ ok: false, error: 'No notifications configured' });
    }
    const payload = {
      timestamp:  new Date().toISOString(),
      key:        'test',
      transition: 'firing',
      title:      'SensorPush test notification',
      message:    'This is a test notification from the SensorPush recorder.',
      detail:     { test: true },
    };
    const results = {};
    if ((sink === 'webhook' || sink === 'all') && notif.webhook?.url) {
      results.webhook = await dispatchWebhook(notif.webhook.url, payload);
    }
    if ((sink === 'ntfy' || sink === 'all') && notif.ntfy?.url) {
      results.ntfy = await dispatchNtfy(notif.ntfy.url, payload, { token: notif.ntfy.token });
    }
    if (!Object.keys(results).length) {
      return res.status(400).json({ ok: false, error: 'No matching sink configured (set url to enable)' });
    }
    res.json({ ok: true, results });
  });

  // GET /settings/notifications/state — diagnostic view of the per-condition
  // dedupe state. Useful from the UI to show "currently firing" alerts and
  // when they last transitioned. Read-only; resetting state is intentionally
  // not exposed (a manual SQL DELETE FROM notification_state is the escape
  // hatch and we don't want a stray click clearing the firing-flags map).
  app.get('/settings/notifications/state', (_req, res) => {
    res.json({ ok: true, states: listNotifStates(db) });
  });

  // ── Browser sign-in (session cookie) ────────────────────────────────────
  // /auth/session is in PUBLIC_PATHS; each method checks for itself.
  // GET reports whether a token is required and whether this request holds
  // it (a bearer or a valid session cookie), so the UI knows to show its
  // sign-in form. POST { token } signs this browser in. DELETE signs it out.
  app.get('/auth/session', (req, res) => {
    const token = getToken();
    res.setHeader('Cache-Control', 'no-store').json({
      ok: true,
      authRequired: token !== null,
      authenticated: token === null || authVia(req, token) !== null,
    });
  });

  app.post('/auth/session', (req, res) => {
    const token = getToken();
    if (token === null) return res.json({ ok: true, authRequired: false });
    const presented = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!tokenMatches(presented, token)) {
      return res.status(401).json({ ok: false, error: 'wrong token' });
    }
    res.setHeader('Set-Cookie', sessionCookieHeader(createSession(token), { secure: requestIsTls(req) }));
    res.json({ ok: true });
  });

  app.delete('/auth/session', (req, res) => {
    res.setHeader('Set-Cookie', sessionCookieHeader('', { secure: requestIsTls(req) }));
    res.json({ ok: true });
  });

  // ── Auth (recorder bearer token) ────────────────────────────────────────
  // GET /settings/auth — read-only metadata about the current token state.
  // Never returns the token itself; the bearer is shown ONCE on generate
  // or rotate and never again.
  app.get('/settings/auth', (_req, res) => {
    res.json({
      ok: true,
      tokenSet: getToken() !== null,
      source: getTokenSource(),               // 'env' | 'file' | null
      canRotate: getTokenSource() === 'file', // env-managed = read-only
    });
  });

  // POST /settings/auth/generate — bootstrap-only. Refuses if a token is
  // already set (use /rotate for that). The middleware whitelist above
  // lets unauthenticated calls through ONLY when getToken() returns null,
  // so a public-internet recorder with no token configured can be locked
  // down by anyone — race window is bounded by how fast the operator
  // actually clicks Generate after deploy.
  // Generate and rotate also sign in the caller with the new token, so the
  // browser that clicked the button keeps working once it's enforced.
  app.post('/settings/auth/generate', (req, res) => {
    if (getToken() !== null) {
      return res.status(409).json({ ok: false, error: 'token already set; use /settings/auth/rotate' });
    }
    try {
      const token = generateToken();
      setToken(token);
      res.setHeader('Set-Cookie', sessionCookieHeader(createSession(token), { secure: requestIsTls(req) }));
      res.json({ ok: true, token });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /settings/auth/rotate — replace the existing file-based token.
  // Requires the current bearer or a session (the auth middleware enforces
  // it). Every session signed with the old token stops verifying. 409 when
  // source is env, since file mutation is no-op while env wins.
  app.post('/settings/auth/rotate', (req, res) => {
    if (getTokenSource() === 'env') {
      return res.status(409).json({ ok: false, error: 'token is set via RECORDER_TOKEN env; remove it before rotating via UI' });
    }
    try {
      const token = generateToken();
      setToken(token);
      res.setHeader('Set-Cookie', sessionCookieHeader(createSession(token), { secure: requestIsTls(req) }));
      res.json({ ok: true, token });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // DELETE /settings/auth — clear the file-based token (auth disabled).
  // Same env-precedence guard as rotate.
  app.delete('/settings/auth', (req, res) => {
    if (getTokenSource() === 'env') {
      return res.status(409).json({ ok: false, error: 'token is set via RECORDER_TOKEN env; cannot clear via UI' });
    }
    try {
      clearStoredToken();
      res.setHeader('Set-Cookie', sessionCookieHeader('', { secure: requestIsTls(req) }));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Backups (list + restore daily snapshots) ────────────────────────────
  // The daily 03:30 _snapshotDb in poller.js drops files in /data/backups/;
  // this surface lets an operator browse and roll back without SSH.
  app.get('/backups', (_req, res) => {
    res.json({ ok: true, backups: listBackups() });
  });

  // POST /backups/:filename/restore — swap the live DB to the chosen snapshot.
  // Filename is regex-gated to the daily pattern (see backups.js) before any
  // filesystem access; the resolved path is also confirmed to stay inside
  // the backups dir as defense-in-depth.
  app.post('/backups/:filename/restore', (req, res) => {
    const filename = req.params.filename;
    if (!isRestorableName(filename)) {
      return res.status(400).json({ ok: false, error: 'invalid backup filename' });
    }
    try {
      const { newDb, preRestoreFilename } = restoreBackup(db, filename);
      db = newDb;
      if (onSwap) onSwap(newDb);
      res.json({ ok: true, preRestoreFilename });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/poll', async (_req, res) => {
    if (!config) return res.status(503).json({ ok: false, error: 'No config available' });
    try {
      await triggerPoll(db, config);
      const { lastPollTime } = getPollStatus();
      res.json({ ok: true, lastPoll: lastPollTime ? new Date(lastPollTime).toISOString() : null });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/icon.svg', (_req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml')
       .setHeader('Cache-Control', 'public, max-age=86400')
       .send(ICON_SVG);
  });

  app.get('/icon-192.png', (_req, res) => {
    res.setHeader('Content-Type', 'image/png')
       .setHeader('Cache-Control', 'public, max-age=86400')
       .send(ICON_PNG_192);
  });
  app.get('/icon-512.png', (_req, res) => {
    res.setHeader('Content-Type', 'image/png')
       .setHeader('Cache-Control', 'public, max-age=86400')
       .send(ICON_PNG_512);
  });

  app.get('/sw.js', (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript')
       .setHeader('Service-Worker-Allowed', '/')
       .send(SW_JS);
  });

  // Manifest paths adjust based on whether the UI is loaded at /ui (legacy)
  // or at the root of the dedicated subdomain.
  app.get('/manifest.json', (req, res) => {
    const via = (req.headers.referer || '').includes('/sensorpush');
    const pfx = via ? '/sensorpush' : '';
    res.setHeader('Content-Type', 'application/manifest+json')
       .json({
         name: 'SensorPush Explorer',
         short_name: 'SensorPush',
         description: 'Temperature & humidity sensor data explorer',
         start_url: via ? '/sensorpush/' : '/',
         scope:     via ? '/sensorpush/' : '/',
         display: 'standalone',
         orientation: 'any',
         theme_color: '#1f1f1f',
         background_color: '#161616',
         icons: [
           { src: pfx + '/icon-192.png', type: 'image/png', sizes: '192x192' },
           { src: pfx + '/icon-512.png', type: 'image/png', sizes: '512x512' },
           { src: pfx + '/icon.svg',     type: 'image/svg+xml', sizes: 'any' },
         ],
       });
  });

  app.get('/ui', (_req, res) => res.setHeader('Content-Type', 'text/html').send(UI_HTML));

  // ── Events ──────────────────────────────────────────────────────────────
  // User-annotated events overlaid on the Explorer chart. Bearer-protected
  // via the middleware above (not in PUBLIC_PATHS, no UI bypass).
  app.post('/events', (req, res) => {
    const { ts, sensor_id, label, note } = req.body ?? {};
    if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) {
      return res.status(400).json({ ok: false, error: 'ts (number, epoch seconds) is required' });
    }
    if (typeof label !== 'string' || !label.trim()) {
      return res.status(400).json({ ok: false, error: 'label (non-empty string) is required' });
    }
    if (sensor_id != null && typeof sensor_id !== 'string') {
      return res.status(400).json({ ok: false, error: 'sensor_id must be a string or null' });
    }
    if (note != null && typeof note !== 'string') {
      return res.status(400).json({ ok: false, error: 'note must be a string or null' });
    }
    if (sensor_id) {
      const sensor = db.prepare('SELECT id FROM sensors WHERE id = ?').get(sensor_id);
      if (!sensor) return res.status(400).json({ ok: false, error: 'sensor_id does not match any sensor' });
    }
    const ev = createEvent(db, { ts, sensorId: sensor_id ?? null, label: label.trim(), note: note ?? null });
    res.json({ ok: true, event: ev });
  });

  app.get('/events', (req, res) => {
    const opts = {};
    if (req.query.from != null) {
      const v = parseInt(req.query.from, 10);
      if (!isFinite(v)) return res.status(400).json({ ok: false, error: 'from must be an integer (epoch seconds)' });
      opts.from = v;
    }
    if (req.query.to != null) {
      const v = parseInt(req.query.to, 10);
      if (!isFinite(v)) return res.status(400).json({ ok: false, error: 'to must be an integer (epoch seconds)' });
      opts.to = v;
    }
    if (req.query.sensor_id) opts.sensorId = String(req.query.sensor_id);
    const events = listEvents(db, opts);
    res.json({ ok: true, events });
  });

  app.patch('/events/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!isFinite(id)) return res.status(400).json({ ok: false, error: 'id must be an integer' });
    if (!getEventById(db, id)) return res.status(404).json({ ok: false, error: 'event not found' });
    const patch = {};
    const { ts, sensor_id, label, note } = req.body ?? {};
    if (ts !== undefined) {
      if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) {
        return res.status(400).json({ ok: false, error: 'ts must be a positive number' });
      }
      patch.ts = ts;
    }
    if (sensor_id !== undefined) {
      if (sensor_id !== null && typeof sensor_id !== 'string') {
        return res.status(400).json({ ok: false, error: 'sensor_id must be a string or null' });
      }
      if (sensor_id) {
        const sensor = db.prepare('SELECT id FROM sensors WHERE id = ?').get(sensor_id);
        if (!sensor) return res.status(400).json({ ok: false, error: 'sensor_id does not match any sensor' });
      }
      patch.sensorId = sensor_id;
    }
    if (label !== undefined) {
      if (typeof label !== 'string' || !label.trim()) {
        return res.status(400).json({ ok: false, error: 'label must be a non-empty string' });
      }
      patch.label = label.trim();
    }
    if (note !== undefined) {
      if (note !== null && typeof note !== 'string') {
        return res.status(400).json({ ok: false, error: 'note must be a string or null' });
      }
      patch.note = note;
    }
    const ev = updateEvent(db, id, patch);
    res.json({ ok: true, event: ev });
  });

  app.delete('/events/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!isFinite(id)) return res.status(400).json({ ok: false, error: 'id must be an integer' });
    const ok = deleteEvent(db, id);
    if (!ok) return res.status(404).json({ ok: false, error: 'event not found' });
    res.json({ ok: true });
  });

  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const config = loadConfig();
  const db     = openDb(DB_PATH);
  // Bridge createApp's restore-time db swap into the poller, which captured
  // its own `db` binding at startPoller call time.
  const swapCallbacks = [];
  const app = createApp(db, config, (newDb) => {
    for (const cb of swapCallbacks) cb(newDb);
  });
  startPoller(db, config, (cb) => swapCallbacks.push(cb));
  const server = app.listen(PORT, () => {
    console.log(`[sensorpush-recorder] listening on :${PORT}`);
    // One-shot warning when no auth is configured. A LAN-only deploy can
    // ignore it; a public-internet recorder should generate a token via
    // the Settings → Security panel in the Explorer UI before letting
    // anyone hit it.
    const src = getTokenSource();
    if (!src) {
      console.warn(
        '[sensorpush-recorder] WARNING: no RECORDER_TOKEN configured — ' +
        'all routes are open to anyone with the URL. Generate a token at ' +
        '/settings/auth/generate (or via the Settings → Security panel in ' +
        'the Explorer UI) before exposing this service publicly.'
      );
    } else {
      console.log(`[sensorpush-recorder] auth enabled (source: ${src})`);
    }
  });

  // Graceful shutdown on redeploy / `docker stop`. Close the HTTP server and
  // DB handle cleanly instead of relying on SIGKILL after the stop grace
  // period. NB: this cannot help if the process is ever wedged inside an
  // uninterruptible fsync (D-state) — the handler never gets to run — which is
  // exactly why the real fixes keep heavy fsync work off the event loop.
  let _shuttingDown = false;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      if (_shuttingDown) return;
      _shuttingDown = true;
      console.log(`[sensorpush-recorder] ${sig} received — shutting down`);
      server.close(() => { try { db.close(); } catch (_) {} process.exit(0); });
      // Failsafe: exit even if an in-flight connection keeps server.close hanging.
      setTimeout(() => process.exit(0), 8000).unref();
    });
  }
}
