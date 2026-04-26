import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { openDb, getSensors, getHistory, getHistoryAll, getGaps, setReadingExcluded, setHourlyExcluded, rangeToSeconds, rangeUnit, getUiSettings, setUiSettings, getGateways, gatewayOnlineDuringWindow } from './db.js';
import { startPoller, getPollStatus, triggerPoll, triggerBackfill, triggerGapBackfill, getBackfillStatus } from './poller.js';
import { loadConfig, DB_PATH, PORT } from './config.js';

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

// Generate a thermometer PNG icon at the given size using only built-in modules
function makePNG(size) {
  const W = size, H = size, cx = W / 2, f = size / 512;
  const tW = Math.round(80*f), tH = Math.round(248*f);
  const tX = cx - tW/2,        tY = Math.round(72*f);
  const bR = Math.round(66*f), bCY = Math.round(380*f);
  const bord = Math.max(2, Math.round(14*f)), tRx = tW/2;
  const filY = Math.round(tY + tH*0.38), rc = Math.round(108*f);

  const crcTable = new Uint32Array(256);
  for (let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c&1)?0xedb88320^(c>>>1):(c>>>1);crcTable[i]=c;}
  const crc32 = buf => { let c=0xffffffff; for(const b of buf)c=crcTable[(c^b)&0xff]^(c>>>8); return(c^0xffffffff)>>>0; };
  const pngChunk = (type,data) => {
    const t=Buffer.from(type,'ascii'),l=Buffer.alloc(4),cv=Buffer.alloc(4);
    l.writeUInt32BE(data.length); cv.writeUInt32BE(crc32(Buffer.concat([t,data])));
    return Buffer.concat([l,t,data,cv]);
  };

  function px(x,y) {
    const ddx=Math.min(x,W-1-x), ddy=Math.min(y,H-1-y); let a=255;
    if(ddx<rc&&ddy<rc){const d=Math.sqrt((rc-ddx)**2+(rc-ddy)**2);if(d>rc)return[0,0,0,0];if(d>rc-1.5)a=Math.round(255*(rc-d)/1.5);}
    const bx=x-cx,by=y-bCY,bd=Math.sqrt(bx*bx+by*by);
    if(bd<=bR){if(bd<=bR-bord)return[255,107,91,a];return[77,184,255,a];}
    if(y>=tY&&y<=tY+tH){
      const tCT=tY+tRx,tCB=tY+tH-tRx,tx=x-cx; let inT=false;
      if(y>=tCT&&y<=tCB)inT=Math.abs(tx)<=tRx;
      else if(y<tCT)inT=Math.sqrt(tx*tx+(y-tCT)**2)<=tRx;
      else           inT=Math.sqrt(tx*tx+(y-tCB)**2)<=tRx;
      if(inT){if(Math.abs(tx)>tRx-bord||y<tCT)return[77,184,255,a];if(y>=filY)return[255,107,91,a];return[37,37,37,a];}
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
const CACHE='sensorpush-v5';
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.add(new Request(self.registration.scope,{cache:'reload'}))).catch(()=>{}));
  self.skipWaiting();
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const url=new URL(e.request.url);
  if(url.pathname.match(/\\/(history|gaps|poll|health)/))return;
  // Root path serves HTML for navigation but JSON for data fetches — let data fetches bypass SW
  if(url.pathname==='/'&&!(e.request.headers.get('Accept')||'').includes('text/html'))return;
  e.respondWith(caches.match(e.request).then(cached=>{
    const net=fetch(e.request).then(r=>{if(r.ok)caches.open(CACHE).then(c=>c.put(e.request,r.clone()));return r;}).catch(()=>null);
    return cached||net||new Response('Offline',{status:503});
  }));
});
`;

// CORS_ORIGINS=https://dashboard.sstangle.in,http://10.73.37.22:8080,...
// Echoes the request Origin only when it's in the allowlist; never sends "*".
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

export function createApp(db, config = null) {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && CORS_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/health', (_req, res) => {
    const { lastPollTime, lastPollError } = getPollStatus();
    const row = db.prepare('SELECT COUNT(*) AS n FROM sensors').get();
    res.json({
      ok:          true,
      lastPoll:    lastPollTime ? new Date(lastPollTime).toISOString() : null,
      pollError:   lastPollError,
      sensorCount: row.n,
    });
  });

  // GET / → sensors list (JSON) for fetch() callers, ui.html for browsers.
  // The Accept-header check lets sensors.sstangle.in serve the Explorer UI
  // at the root while still answering API calls at the same URL.
  app.get('/', (req, res) => {
    if ((req.headers.accept || '').includes('text/html')) {
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
    res.json({ ok: true, sensors });
  });

  app.get('/:id/history', (req, res) => {
    const sensorId = req.params.id;
    const range    = req.query.range || '24h';
    const rangeSecs = rangeToSeconds(range);
    if (!rangeSecs) return res.status(400).json({ ok: false, error: 'Invalid range. Use e.g. 2h, 24h, 7d, 30d, 1yr.' });
    const sensor = db.prepare('SELECT id FROM sensors WHERE id = ?').get(sensorId);
    if (!sensor) return res.status(404).json({ ok: false, error: 'Sensor not found' });
    const samples = getHistory(db, sensorId, range);
    res.json({ ok: true, sensorId, range, resolution: rangeUnit(range) === 'h' ? 'raw' : rangeUnit(range) === 'd' ? 'hourly' : 'daily', samples });
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
    // Annotate each gap with whether any gateway was online during the window.
    // null = no gateway poll history covers this window (e.g. older than tracking).
    result.gaps = result.gaps.map(g => ({
      ...g,
      gatewayOnline: gatewayOnlineDuringWindow(db, g.startTs, g.endTs),
    }));
    res.json({ ok: true, sensorId, range, ...result });
  });

  app.get('/gateways', (_req, res) => {
    const rows = getGateways(db);
    res.json({
      ok: true,
      gateways: rows.map(r => ({
        id:         r.id,
        name:       r.name,
        lastSeen:   r.last_seen   ? new Date(r.last_seen   * 1000).toISOString() : null,
        lastAlert:  r.last_alert  ? new Date(r.last_alert  * 1000).toISOString() : null,
        version:    r.version,
        paired:     !!r.paired,
        message:    r.message,
        lastSynced: r.last_synced ? new Date(r.last_synced * 1000).toISOString() : null,
      })),
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
    const fromTs = Math.floor(new Date(fromDate + 'T00:00:00').getTime() / 1000);
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
    const { ranges } = req.body ?? {};
    if (!Array.isArray(ranges) || !ranges.every(r => /^\d+(h|d|yr)$/.test(r))) {
      return res.status(400).json({ ok: false, error: 'Invalid settings' });
    }
    setUiSettings(db, { ranges });
    res.json({ ok: true });
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

  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const config = loadConfig();
  const db     = openDb(DB_PATH);
  const app    = createApp(db, config);
  startPoller(db, config);
  app.listen(PORT, () => console.log(`[sensorpush-recorder] listening on :${PORT}`));
}
