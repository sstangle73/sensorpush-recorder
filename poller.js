import { backup } from 'node:sqlite';
import { getToken, fetchSensors, fetchSamples, fetchGateways } from './sensorpush.js';
import { fetchCurrentWeather, fetchHourlyWeather } from './weather.js';
import { upsertSensors, insertReadings, recomputeHourlyAgg, getLatestTs, setLastPollTime, getLastPollTime, getGaps, upsertGateways, recordGatewayStatus, pruneGatewayStatus, getUiSettings, getSensors, getGateways, insertOutdoorReadings, getLatestOutdoorTs, pruneReadingsOlderThan } from './db.js';
import { connect as mqttConnect, publishReading, publishDiscovery, isConnected as mqttIsConnected } from './mqtt.js';
import { runNotifications } from './notifications.js';

let _lastPollError     = null;
// The last successful poll *since this process started*. Per-process on
// purpose: /health reports it as lastPoll, and lastPoll and pollError both
// start empty on every start, so the first poll (made at once) fills exactly
// one of them. External checks read that as "did the restarted recorder sign
// in?"; a value carried over from before the restart would answer yes.
let _lastPollTime      = null;
// The last successful poll as stored in meta.last_poll, read once at start,
// so /metrics reports the true last success across a restart. Without it,
// sensorpush_last_poll_timestamp_seconds vanished until the next good poll,
// and a restart while every poll still failed (a changed password) read as
// "no data" instead of as a poll that was hours old.
let _storedLastPollTime = null;
let _lastSensorCount   = null;
let _backfillState     = { status: 'idle', progress: null, error: null };
let _lastDiscoveryAt   = 0;
const DISCOVERY_INTERVAL_MS = 3600 * 1000;
let _lastWeatherPollTime = null;
let _lastWeatherError    = null;

// Re-entrancy guard for the 5-minute poll loop. node:sqlite is fully
// synchronous, so a poll's insert+recompute bursts occupy the single event
// loop. When the underlying disk goes slow (the nightly hypervisor backup
// fsync-freezes this guest and drives await from ~2ms to ~1200ms), a poll can
// easily outlast its 5-minute interval. Without a guard, setInterval keeps
// launching more, and the overlapping polls multiply exactly the synchronous
// DB work that is already the bottleneck. Skipping a tick is always correct:
// the poll window is anchored on getLatestTs, so the next successful poll
// picks up whatever the skipped one would have fetched.
let _pollInFlight  = false;
let _pollSkipped   = 0;
// Last "nothing to do" reason we logged, so a persistent misconfiguration
// reports once instead of every 5 minutes forever.
let _lastIssueLogged = null;

// Raw-readings retention. Older rows are pruned daily (in yielding batches);
// hourly aggregates survive forever, so long-term history is preserved. Bounds
// DB growth so fsync-heavy ops (snapshot, catch-up insert, WAL recovery) stay
// fast over time. Override via env; set 0 to disable pruning entirely.
const READINGS_RETENTION_DAYS = Number(process.env.READINGS_RETENTION_DAYS ?? 365);

// Run one poll immediately, then every 5 minutes. Errors are intentionally
// swallowed here so a transient cloud outage doesn't stop the interval — the
// failure surfaces via /health (lastPollError) and the next tick retries.
//
// Also schedules three daily clock-aligned jobs:
//   03:00 — auto gap-backfill over the last 7 days (self-healing data)
//   03:30 — SQLite snapshot to /data/backups/sensorpush-YYYY-MM-DD.db
//           with retention pruning beyond 7 daily snapshots
//   04:00 — raw-readings retention prune (keeps hourly aggregates forever)
//
// `db` is a let-mutable param so `registerSwap` (called by server.js on
// /backups/:filename/restore) can swap in the post-restore handle. The
// setInterval/scheduleDaily closures reference the param binding, so the
// next tick picks up the new handle automatically.
export function startPoller(db, config, registerSwap = null) {
  if (registerSwap) registerSwap((newDb) => { db = newDb; });
  loadStoredPollTime(db);

  // Bring up the optional MQTT publisher. No-op when MQTT_URL is unset.
  // Failures here must not block sample polling — wrap in try/catch.
  try { mqttConnect(config?.mqtt || {}); } catch (err) { console.error('[poller] mqtt connect:', err.message); }

  _guardedPoll(db, config).catch(err => {
    _lastPollError = err.message;
    console.error('[poller] error:', err.message);
  });
  setInterval(() => {
    _guardedPoll(db, config).catch(err => {
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
  scheduleDaily(4,  0, () => _pruneReadings(db));
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

// Daily snapshot via node:sqlite's async online-backup API. Unlike the
// previous synchronous `VACUUM INTO` — which rewrote the entire multi-hundred-
// MB DB in one uninterruptible, fsync-bound call and FROZE the event loop
// (and /health) for its whole duration, ultimately wedging the container —
// backup() copies in small page batches and yields the event loop between
// them, so /health, MQTT, and the poll loop stay responsive throughout.
// Snapshots land in /data/backups/ alongside the live DB; the most recent 7
// are kept. Exported for tests.
export async function _snapshotDb(db) {
  const { mkdirSync, readdirSync, statSync, unlinkSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const liveDb = process.env.DB_PATH || '/data/sensorpush.db';
  const dir    = join(dirname(liveDb), 'backups');
  mkdirSync(dir, { recursive: true });

  const datestamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dest      = join(dir, `sensorpush-${datestamp}.db`);
  // rate=100 pages per batch keeps each synchronous step small (~sub-100ms)
  // so the loop breathes between batches. backup() takes the path directly,
  // so no SQL string-escaping is needed and it overwrites an existing
  // same-day snapshot cleanly (VACUUM INTO would have errored on that).
  await backup(db, dest, { rate: 100 });
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

// Daily raw-readings retention. Deletes readings older than
// READINGS_RETENTION_DAYS in bounded, yielding batches (db.pruneReadingsOlderThan)
// so the prune itself never becomes a long synchronous fsync block. Hourly
// aggregates are untouched — long-term history survives at hourly resolution.
// Exported for tests.
export async function _pruneReadings(db) {
  if (!(READINGS_RETENTION_DAYS > 0)) return;
  const cutoff  = Math.floor(Date.now() / 1000) - READINGS_RETENTION_DAYS * 86400;
  const deleted = await pruneReadingsOlderThan(db, cutoff, { batchSize: 5000 });
  if (deleted) console.log(`[poller] retention: pruned ${deleted} raw readings older than ${READINGS_RETENTION_DAYS}d`);
}

// Serialises poll attempts (scheduled, manual, and startup alike). A tick that
// arrives while one is still running is dropped rather than queued — see the
// _pollInFlight comment above. Exported state lets /health and /metrics show
// how many ticks we've had to skip, which is the early warning that polls have
// started outrunning their interval.
async function _guardedPoll(db, config) {
  if (_pollInFlight) {
    _pollSkipped++;
    console.warn(`[poller] previous poll still in flight — skipping this tick (${_pollSkipped} skipped in a row)`);
    return;
  }
  _pollInFlight = true;
  try {
    await _poll(db, config);
  } finally {
    // Any finished poll ends the streak, a failed one too: the count is about
    // polls outrunning their interval, not about whether they succeed.
    _pollInFlight = false;
    _pollSkipped  = 0;
  }
}

// Record a "the poll did nothing" condition. These used to be bare `return`s,
// which meant a recorder that was misconfigured (or getting an empty sensor
// list from the cloud) polled silently forever: no log line, no error state,
// no data — and /health still answered `ok: true`. Now the reason lands in
// lastPollError so /health, /metrics, and the UI all surface it, and it logs
// once per distinct reason instead of every 5 minutes.
function _recordPollIssue(reason) {
  _lastPollError = reason;
  if (_lastIssueLogged !== reason) {
    console.error('[poller] poll did nothing:', reason);
    _lastIssueLogged = reason;
  }
}

async function _poll(db, config) {
  const sp = config?.sensorpush;
  if (!sp?.email || sp.email.includes('YOUR_')) {
    _recordPollIssue('no SensorPush credentials configured — check the /config/config.local.js mount or SENSORPUSH_EMAIL/SENSORPUSH_PASSWORD');
    return;
  }

  const token = await getToken(sp.email, sp.password);
  if (!token) throw new Error('SensorPush auth failed — check email/password in config');

  const sensors = await fetchSensors(token);
  if (!sensors.length) {
    _recordPollIssue('SensorPush returned an empty sensor list');
    return;
  }
  _lastSensorCount = sensors.length;

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
    const now      = Math.floor(Date.now() / 1000);

    // Window to (re)fetch:
    //   first run (no data) → 30 days back
    //   incremental         → 24h back from latest (catches late-published
    //                         data and gaps left by excluded readings)
    // Either way, fetch in bounded ≤2-day windows and insert+recompute PER
    // window, awaiting the network fetch between windows. This keeps every
    // synchronous DB burst small so a long catch-up after downtime can never
    // become one giant non-yielding insert+recompute that freezes the event
    // loop and /health (the failure that wedged the recorder). The 2-day cap
    // also stays under the SensorPush /samples 10000-row response limit.
    // INSERT OR IGNORE makes the inevitable window overlap free.
    const startTs = latestTs ? latestTs - 24 * 3600 : now - 30 * 86400;
    const chunk   = 2 * 86400;

    for (let start = startTs; start < now; start += chunk) {
      const stop    = Math.min(start + chunk, now);
      const samples = await fetchSamples(token, { sensorId: sensor.id, startTs: start, stopTs: stop });
      if (!samples.length) continue;
      const inserted = insertReadings(db, sensor.id, samples);
      if (inserted.length) {
        const affectedHours = [...new Set(inserted.map(r => r.ts - (r.ts % 3600)))];
        for (const hourTs of affectedHours) {
          recomputeHourlyAgg(db, sensor.id, hourTs);
        }
      }
    }
  }

  _lastPollError   = null;
  _lastIssueLogged = null;
  _lastPollTime    = Date.now();
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

// Read the stored last-success time (meta.last_poll) into memory. startPoller
// calls it once, before the first poll; exported for tests. A failed read only
// loses the carried-over value, so it must not stop the poller from starting.
export function loadStoredPollTime(db) {
  try {
    const stored = getLastPollTime(db);
    _storedLastPollTime = Number.isFinite(stored) ? stored : null;
  } catch (err) {
    console.error('[poller] reading the stored last poll time:', err.message);
  }
}

export function getPollStatus() {
  return {
    lastPollTime:        _lastPollTime,
    // The last successful poll ever: this process's, else the stored one from
    // before it started. /metrics uses it; /health keeps lastPollTime.
    lastGoodPollTime:    _lastPollTime ?? _storedLastPollTime,
    lastPollError:       _lastPollError,
    lastSensorCount:     _lastSensorCount,
    lastWeatherPollTime: _lastWeatherPollTime,
    lastWeatherError:    _lastWeatherError,
    pollInFlight:        _pollInFlight,
    pollSkipped:         _pollSkipped,
  };
}

export function _resetPollerState() {
  _lastPollError       = null;
  _lastPollTime        = null;
  _storedLastPollTime  = null;
  _lastSensorCount     = null;
  _lastDiscoveryAt     = 0;
  _lastWeatherPollTime = null;
  _lastWeatherError    = null;
  _pollInFlight        = false;
  _pollSkipped         = 0;
  _lastIssueLogged     = null;
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
  return _guardedPoll(db, config).catch(err => {
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
