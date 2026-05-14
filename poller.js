import { getToken, fetchSensors, fetchSamples, fetchGateways } from './sensorpush.js';
import { fetchCurrentWeather, fetchHourlyWeather } from './weather.js';
import { upsertSensors, insertReadings, recomputeHourlyAgg, getLatestTs, setLastPollTime, getGaps, upsertGateways, recordGatewayStatus, pruneGatewayStatus, getUiSettings, getSensors, getGateways, insertOutdoorReadings, getLatestOutdoorTs } from './db.js';
import { connect as mqttConnect, publishReading, publishDiscovery, isConnected as mqttIsConnected } from './mqtt.js';
import { runNotifications } from './notifications.js';

let _lastPollError     = null;
let _lastPollTime      = null;
let _backfillState     = { status: 'idle', progress: null, error: null };
let _lastDiscoveryAt   = 0;
const DISCOVERY_INTERVAL_MS = 3600 * 1000;
let _lastWeatherPollTime = null;
let _lastWeatherError    = null;

// Run one poll immediately, then every 5 minutes. Errors are intentionally
// swallowed here so a transient cloud outage doesn't stop the interval — the
// failure surfaces via /health (lastPollError) and the next tick retries.
//
// Also schedules two daily clock-aligned jobs:
//   03:00 — auto gap-backfill over the last 7 days (self-healing data)
//   03:30 — SQLite snapshot to /data/backups/sensorpush-YYYY-MM-DD.db
//           with retention pruning beyond 7 daily snapshots
export function startPoller(db, config) {
  // Bring up the optional MQTT publisher. No-op when MQTT_URL is unset.
  // Failures here must not block sample polling — wrap in try/catch.
  try { mqttConnect(config?.mqtt || {}); } catch (err) { console.error('[poller] mqtt connect:', err.message); }

  _poll(db, config).catch(err => {
    _lastPollError = err.message;
    console.error('[poller] error:', err.message);
  });
  setInterval(() => {
    _poll(db, config).catch(err => {
      _lastPollError = err.message;
      console.error('[poller] error:', err.message);
    });
  }, 5 * 60 * 1000);

  // Outdoor weather is a separate hourly loop. It only runs when
  // config.weather.{lat,lon} are configured — otherwise the table stays
  // empty and the UI's Outdoor toggle hides itself.
  if (config?.weather?.lat != null && config?.weather?.lon != null) {
    _pollWeather(db, config).catch(err => {
      _lastWeatherError = err.message;
      console.error('[poller] weather error:', err.message);
    });
    setInterval(() => {
      _pollWeather(db, config).catch(err => {
        _lastWeatherError = err.message;
        console.error('[poller] weather error:', err.message);
      });
    }, 60 * 60 * 1000);
  }

  scheduleDaily(3,  0, () => _autoGapBackfill(db, config));
  scheduleDaily(3, 30, () => _snapshotDb(db));
}

// scheduleDaily(hour, minute, fn) — runs `fn` once per day at the next
// occurrence of the given clock position in the host's local time zone,
// then every 24h after. (Container hosts running UTC will see 03:00 fire
// at 03:00 UTC; set TZ in compose if you want a different anchor.)
// We use a one-shot setTimeout that re-arms on completion so the schedule
// stays aligned even if the host clock drifts or `fn` runs long.
function scheduleDaily(hour, minute, fn) {
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  const delay = next.getTime() - Date.now();
  setTimeout(async () => {
    try { await fn(); } catch (err) { console.error('[poller] scheduled job error:', err.message); }
    scheduleDaily(hour, minute, fn);
  }, delay);
}

// Daily self-healing: re-fetch any windows the local DB shows as missing
// over the last 7 days. Skips silently if a manual backfill is in progress.
async function _autoGapBackfill(db, config) {
  if (_backfillState.status === 'running') {
    console.log('[poller] skipping auto gap-backfill — another backfill is running');
    return;
  }
  const sp = config?.sensorpush;
  if (!sp?.email || sp.email.includes('YOUR_')) return;
  console.log('[poller] auto gap-backfill starting (7d)');
  await triggerGapBackfill(db, config, { range: '7d' });
}

// Daily snapshot via SQLite's `VACUUM INTO`, which produces a clean
// single-file copy without locking the live DB for long. Snapshots land
// in /data/backups/ alongside the live DB; the most recent 7 are kept.
// Exported for tests.
export async function _snapshotDb(db) {
  const { mkdirSync, readdirSync, statSync, unlinkSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const liveDb = process.env.DB_PATH || '/data/sensorpush.db';
  const dir    = join(dirname(liveDb), 'backups');
  mkdirSync(dir, { recursive: true });

  const datestamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dest      = join(dir, `sensorpush-${datestamp}.db`);
  // Quoting: VACUUM INTO accepts a string-literal path. We control it.
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  console.log(`[poller] snapshot written: ${dest}`);

  // Retention: keep the 7 newest sensorpush-*.db files, delete the rest.
  const files = readdirSync(dir)
    .filter(f => /^sensorpush-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { f } of files.slice(7)) {
    try { unlinkSync(join(dir, f)); } catch (_) {}
  }
}

async function _poll(db, config) {
  const sp = config?.sensorpush;
  if (!sp?.email || sp.email.includes('YOUR_')) return;

  const token = await getToken(sp.email, sp.password);
  if (!token) throw new Error('SensorPush auth failed — check email/password in config');

  const sensors = await fetchSensors(token);
  if (!sensors.length) return;

  upsertSensors(db, sensors);

  // Record gateway status alongside the sensor poll. Failures here should not
  // break sample ingestion — log and continue.
  try {
    const gateways = await fetchGateways(token);
    if (gateways.length) {
      upsertGateways(db, gateways);
      recordGatewayStatus(db, gateways, Math.floor(Date.now() / 1000));
      pruneGatewayStatus(db);
    }
  } catch (err) {
    console.error('[poller] gateway fetch failed:', err.message);
  }

  for (const sensor of sensors) {
    const latestTs = getLatestTs(db, sensor.id);
    let allSamples = [];

    if (!latestTs) {
      // First run: backfill 30 days in 2-day chunks. The SensorPush /samples
      // API caps at 10000 rows per response; at ~1 reading/min that's ~7 days
      // for an HT1, but HTP sensors emit more series so we stay well under
      // with 2-day windows.
      const now     = Math.floor(Date.now() / 1000);
      const oldest  = now - 30 * 86400;
      const chunk   = 2 * 86400;
      for (let end = now; end > oldest; end -= chunk) {
        const start   = Math.max(end - chunk, oldest);
        const samples = await fetchSamples(token, { sensorId: sensor.id, startTs: start, stopTs: end });
        allSamples = allSamples.concat(samples);
      }
    } else {
      // Always look back 24h from the latest reading to catch late-published data
      // and gaps caused by excluded readings. INSERT OR IGNORE makes duplicates free.
      const lookbackTs = latestTs - 24 * 3600;
      allSamples = await fetchSamples(token, { sensorId: sensor.id, startTs: lookbackTs });
    }

    if (!allSamples.length) continue;
    const inserted = insertReadings(db, sensor.id, allSamples);
    if (inserted.length) {
      const affectedHours = [...new Set(inserted.map(r => r.ts - (r.ts % 3600)))];
      for (const hourTs of affectedHours) {
        recomputeHourlyAgg(db, sensor.id, hourTs);
      }
    }
  }

  _lastPollError = null;
  _lastPollTime  = Date.now();
  setLastPollTime(db, _lastPollTime);

  // MQTT publish. Failures must not surface as poll errors — the readings are
  // already in the DB. We always publish the latest known reading per sensor
  // (heartbeat semantics), even on polls that yielded no new samples, so HA
  // entities stay "fresh" with retained messages.
  if (mqttIsConnected()) {
    try {
      if (Date.now() - _lastDiscoveryAt > DISCOVERY_INTERVAL_MS) {
        publishDiscovery(sensors);
        _lastDiscoveryAt = Date.now();
      }
      const latestStmt = db.prepare(
        `SELECT ts, temperature, humidity, dewpoint, vpd, battery_voltage
         FROM readings WHERE sensor_id = ? AND excluded = 0
         ORDER BY ts DESC LIMIT 1`,
      );
      for (const sensor of sensors) {
        const reading = latestStmt.get(sensor.id);
        if (reading) publishReading(sensor, reading);
      }
    } catch (err) {
      console.error('[poller] mqtt publish:', err.message);
    }
  }

  // Fire outbound notifications for any threshold breach / anomaly / offline
  // sensor or gateway. State machine in notifications.js dedupes so a stuck
  // condition only buzzes once per transition. Errors are swallowed — a
  // webhook outage shouldn't break ingestion.
  try {
    await _runNotifications(db);
  } catch (err) {
    console.error('[poller] notifications error:', err?.message);
  }
}

async function _runNotifications(db) {
  const settings = getUiSettings(db);
  const notifConfig = settings?.notifications;
  if (!notifConfig?.enabled) return;
  // Shape getSensors() rows into the {id, name, temperature, humidity, alerts,
  // lastTs} fields the evaluators expect.
  const sensorRows = getSensors(db).map(r => ({
    id:          r.id,
    name:        r.name,
    temperature: r.temperature,
    humidity:    r.humidity,
    alerts:      r.alerts ? JSON.parse(r.alerts) : null,
    lastTs:      r.last_ts,
  }));
  const gatewayRows = getGateways(db).map(r => ({
    id:       r.id,
    name:     r.name,
    lastSeen: r.last_seen,
  }));
  await runNotifications(db, {
    sensors:     sensorRows,
    gateways:    gatewayRows,
    notifConfig,
    nowMs:       Date.now(),
  });
}

export function getPollStatus() {
  return {
    lastPollTime:        _lastPollTime,
    lastPollError:       _lastPollError,
    lastWeatherPollTime: _lastWeatherPollTime,
    lastWeatherError:    _lastWeatherError,
  };
}

export function _resetPollerState() {
  _lastPollError       = null;
  _lastPollTime        = null;
  _lastDiscoveryAt     = 0;
  _lastWeatherPollTime = null;
  _lastWeatherError    = null;
}

// Hourly weather poll. On first run (no outdoor_readings yet) backfills a
// week of past_days hours from Open-Meteo's forecast endpoint; thereafter
// just fetches the current reading. INSERT OR IGNORE makes the inevitable
// overlap free.
async function _pollWeather(db, config) {
  const { lat, lon } = config?.weather ?? {};
  if (lat == null || lon == null) return;

  const haveAny = getLatestOutdoorTs(db) != null;
  const samples = haveAny
    ? await fetchCurrentWeather(lat, lon)
    : await fetchHourlyWeather(lat, lon, 7);

  if (samples.length) {
    insertOutdoorReadings(db, samples);
  }
  _lastWeatherError    = null;
  _lastWeatherPollTime = Date.now();
}

// Manual trigger — exposed for a future POST /weather/poll route or test use.
export function triggerWeatherPoll(db, config) {
  return _pollWeather(db, config).catch(err => {
    _lastWeatherError = err.message;
    console.error('[poller] weather manual error:', err.message);
    throw err;
  });
}

// Expose manual trigger so the dashboard refresh button can force an immediate poll.
// Returns a promise that resolves when the poll completes.
export function triggerPoll(db, config) {
  return _poll(db, config).catch(err => {
    _lastPollError = err.message;
    console.error('[poller] manual poll error:', err.message);
    throw err;
  });
}

export function getBackfillStatus() {
  return { ..._backfillState };
}

// Fetch all samples for all sensors from fromTs to now in 2-day chunks.
// Fire-and-forget from the route handler — progress tracked in _backfillState.
export async function triggerBackfill(db, config, fromTs) {
  if (_backfillState.status === 'running') throw new Error('Backfill already running');

  const sp = config?.sensorpush;
  if (!sp?.email || sp.email.includes('YOUR_')) throw new Error('No SensorPush credentials');

  const token = await getToken(sp.email, sp.password);
  if (!token) throw new Error('SensorPush auth failed — check email/password in config');

  const sensors = await fetchSensors(token);
  if (!sensors.length) throw new Error('No sensors found');

  const now   = Math.floor(Date.now() / 1000);
  const chunk = 2 * 86400;
  const chunksPerSensor = Math.ceil((now - fromTs) / chunk);
  const total = chunksPerSensor * sensors.length;

  _backfillState = { status: 'running', progress: { done: 0, total, inserted: 0 }, startedAt: Date.now(), error: null };
  console.log(`[backfill] starting: ${sensors.length} sensors, ${total} chunks from ${new Date(fromTs * 1000).toISOString().slice(0, 10)}`);

  try {
    upsertSensors(db, sensors);
    for (const sensor of sensors) {
      for (let end = now; end > fromTs; end -= chunk) {
        const start   = Math.max(end - chunk, fromTs);
        const samples = await fetchSamples(token, { sensorId: sensor.id, startTs: start, stopTs: end });
        if (samples.length) {
          const inserted = insertReadings(db, sensor.id, samples);
          if (inserted.length) {
            const hours = [...new Set(inserted.map(r => r.ts - (r.ts % 3600)))];
            for (const h of hours) recomputeHourlyAgg(db, sensor.id, h);
            _backfillState.progress.inserted += inserted.length;
          }
        }
        _backfillState.progress.done++;
      }
    }
    console.log(`[backfill] done — ${_backfillState.progress.inserted} new readings`);
    _backfillState = { status: 'done', progress: _backfillState.progress, error: null };
  } catch (err) {
    console.error('[backfill] error:', err.message);
    _backfillState = { status: 'error', progress: _backfillState.progress, error: err.message };
    throw err;
  }
}

// Targeted backfill: fetch only the windows the local DB shows as missing
// (gaps + sparse hours from getGaps) instead of broadly re-pulling the whole
// range. Iterates all sensors. Reuses _backfillState so the existing
// /backfill/status endpoint reports progress.
export async function triggerGapBackfill(db, config, { range = '7d' } = {}) {
  if (_backfillState.status === 'running') throw new Error('Backfill already running');

  const sp = config?.sensorpush;
  if (!sp?.email || sp.email.includes('YOUR_')) throw new Error('No SensorPush credentials');

  const token = await getToken(sp.email, sp.password);
  if (!token) throw new Error('SensorPush auth failed — check email/password in config');

  const sensors = await fetchSensors(token);
  if (!sensors.length) throw new Error('No sensors found');

  // Build a flat list of fetch windows across all sensors, splitting any
  // window longer than 2 days to stay under the SensorPush 10000-row limit.
  const MAX_CHUNK = 2 * 86400;
  const work = [];
  for (const sensor of sensors) {
    const { gaps, sparseHours } = getGaps(db, sensor.id, range);
    const windows = [];
    for (const g of gaps) windows.push({ startTs: g.startTs, stopTs: g.endTs });
    for (const sh of (sparseHours || [])) windows.push({ startTs: sh.hourTs, stopTs: sh.hourTs + 3600 });
    for (const w of windows) {
      for (let end = w.stopTs; end > w.startTs; end -= MAX_CHUNK) {
        const start = Math.max(end - MAX_CHUNK, w.startTs);
        work.push({ sensorId: sensor.id, startTs: start, stopTs: end });
      }
    }
  }

  const total = work.length;
  _backfillState = { status: 'running', progress: { done: 0, total, inserted: 0 }, startedAt: Date.now(), error: null };
  console.log(`[gap-backfill] starting: ${sensors.length} sensors, ${total} windows over ${range}`);

  if (!total) {
    _backfillState = { status: 'done', progress: { done: 0, total: 0, inserted: 0 }, error: null };
    return;
  }

  try {
    upsertSensors(db, sensors);
    for (const w of work) {
      const samples = await fetchSamples(token, w);
      if (samples.length) {
        const inserted = insertReadings(db, w.sensorId, samples);
        if (inserted.length) {
          const hours = [...new Set(inserted.map(r => r.ts - (r.ts % 3600)))];
          for (const h of hours) recomputeHourlyAgg(db, w.sensorId, h);
          _backfillState.progress.inserted += inserted.length;
        }
      }
      _backfillState.progress.done++;
    }
    console.log(`[gap-backfill] done — ${_backfillState.progress.inserted} new readings`);
    _backfillState = { status: 'done', progress: _backfillState.progress, error: null };
  } catch (err) {
    console.error('[gap-backfill] error:', err.message);
    _backfillState = { status: 'error', progress: _backfillState.progress, error: err.message };
    throw err;
  }
}
