import { getToken, fetchSensors, fetchSamples } from './sensorpush.js';
import { upsertSensors, insertReadings, recomputeHourlyAgg, getLatestTs, setLastPollTime, getGaps } from './db.js';

let _lastPollError = null;
let _lastPollTime  = null;
let _backfillState = { status: 'idle', progress: null, error: null };

export function startPoller(db, config) {
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
}

async function _poll(db, config) {
  const sp = config?.sensorpush;
  if (!sp?.email || sp.email.includes('YOUR_')) return;

  const token = await getToken(sp.email, sp.password);
  if (!token) throw new Error('SensorPush auth failed — check email/password in config');

  const sensors = await fetchSensors(token);
  if (!sensors.length) return;

  upsertSensors(db, sensors);

  for (const sensor of sensors) {
    const latestTs = getLatestTs(db, sensor.id);
    let allSamples = [];

    if (!latestTs) {
      // First run: backfill 30 days in 7-day chunks (API limit ~2016 per request)
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
}

export function getPollStatus() {
  return { lastPollTime: _lastPollTime, lastPollError: _lastPollError };
}

export function _resetPollerState() {
  _lastPollError = null;
  _lastPollTime  = null;
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
