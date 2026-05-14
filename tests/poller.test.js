import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../sensorpush.js', () => ({
  getToken:      vi.fn(),
  fetchSensors:  vi.fn(),
  fetchSamples:  vi.fn(),
  fetchGateways: vi.fn(),
}));

vi.mock('../weather.js', () => ({
  fetchCurrentWeather: vi.fn(),
  fetchHourlyWeather:  vi.fn(),
}));

import { getToken, fetchSensors, fetchSamples, fetchGateways } from '../sensorpush.js';
import { fetchCurrentWeather, fetchHourlyWeather } from '../weather.js';
import { openDb, upsertSensors, insertReadings, recomputeHourlyAgg, getLatestOutdoorTs } from '../db.js';
import { triggerPoll, getPollStatus, triggerBackfill, triggerGapBackfill, getBackfillStatus, _resetPollerState, _snapshotDb, triggerWeatherPoll } from '../poller.js';

function makeDb() { return openDb(':memory:'); }

const CREDS = { sensorpush: { email: 'a@b.com', password: 'pw' } };

function sensor(id = 's1') {
  return { id, name: 'Test', type: 'HT1', active: true, batteryVoltage: 2.9 };
}

function sample(tsOffset = 3600) {
  const ts = Math.floor(Date.now() / 1000) - tsOffset;
  return {
    observed:            new Date(ts * 1000).toISOString(),
    temperature:         70,
    humidity:            50,
    barometric_pressure: null,
    battery_voltage:     2.9,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetPollerState();
  // Default: no gateways. Tests that care override this.
  fetchGateways.mockResolvedValue([]);
  // Default: weather endpoints return empty so tests that don't care don't
  // accidentally insert outdoor rows.
  fetchCurrentWeather.mockResolvedValue([]);
  fetchHourlyWeather.mockResolvedValue([]);
});

describe('triggerPoll — credential guards', () => {
  it('skips when sensorpush config is absent', async () => {
    await triggerPoll(makeDb(), {});
    expect(getToken).not.toHaveBeenCalled();
  });

  it('skips when email is a placeholder', async () => {
    await triggerPoll(makeDb(), { sensorpush: { email: 'YOUR_SENSORPUSH_EMAIL', password: 'x' } });
    expect(getToken).not.toHaveBeenCalled();
  });

  it('does not set lastPollTime when skipped', async () => {
    await triggerPoll(makeDb(), {});
    expect(getPollStatus().lastPollTime).toBeNull();
  });
});

describe('triggerPoll — auth failure', () => {
  it('throws and records error when getToken returns null', async () => {
    getToken.mockResolvedValue(null);
    await expect(triggerPoll(makeDb(), CREDS)).rejects.toThrow('SensorPush auth failed');
    expect(getPollStatus().lastPollError).toMatch('SensorPush auth failed');
  });
});

describe('triggerPoll — empty sensor list', () => {
  it('returns without fetching samples when cloud returns no sensors', async () => {
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([]);
    await triggerPoll(makeDb(), CREDS);
    expect(fetchSamples).not.toHaveBeenCalled();
    expect(getPollStatus().lastPollTime).toBeNull();
  });
});

describe('triggerPoll — first-run backfill', () => {
  it('fetches 30 days in 2-day chunks (15 calls)', async () => {
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor()]);
    fetchSamples.mockResolvedValue([]);

    await triggerPoll(makeDb(), CREDS);

    expect(fetchSamples).toHaveBeenCalledTimes(15);
  });

  it('first chunk starts near now and last chunk reaches ~30 days back', async () => {
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor()]);
    fetchSamples.mockResolvedValue([]);

    const before = Math.floor(Date.now() / 1000);
    await triggerPoll(makeDb(), CREDS);
    const after = Math.floor(Date.now() / 1000);

    const calls = fetchSamples.mock.calls.map(c => c[1]);
    const firstStop  = calls[0].stopTs;
    const lastStart  = calls[14].startTs;

    expect(firstStop).toBeGreaterThanOrEqual(before);
    expect(firstStop).toBeLessThanOrEqual(after + 1);
    expect(lastStart).toBeGreaterThanOrEqual(before - 30 * 86400 - 1);
    expect(lastStart).toBeLessThanOrEqual(after  - 28 * 86400);
  });

  it('inserts returned samples into the DB', async () => {
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor('ins1')]);
    fetchSamples.mockResolvedValueOnce([sample()]).mockResolvedValue([]);

    const db = makeDb();
    await triggerPoll(db, CREDS);

    const row = db.prepare('SELECT COUNT(*) AS n FROM readings WHERE sensor_id = ?').get('ins1');
    expect(row.n).toBe(1);
  });

  it('sets lastPollTime and clears lastPollError on success', async () => {
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor()]);
    fetchSamples.mockResolvedValue([]);

    const before = Date.now();
    await triggerPoll(makeDb(), CREDS);

    const { lastPollTime, lastPollError } = getPollStatus();
    expect(lastPollTime).toBeGreaterThanOrEqual(before);
    expect(lastPollError).toBeNull();
  });
});

describe('triggerPoll — incremental fetch', () => {
  it('fetches only once with 24h lookback when readings already exist', async () => {
    const db  = makeDb();
    const now = Math.floor(Date.now() / 1000);

    upsertSensors(db, [sensor('inc1')]);
    insertReadings(db, 'inc1', [sample(3600)]);

    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor('inc1')]);
    fetchSamples.mockResolvedValue([]);

    await triggerPoll(db, CREDS);

    expect(fetchSamples).toHaveBeenCalledTimes(1);
    const { startTs } = fetchSamples.mock.calls[0][1];
    // lookback = latestTs - 24h; latestTs ≈ now - 3600, so startTs ≈ now - 3600 - 86400
    expect(startTs).toBeGreaterThan(now - 30 * 3600);
    expect(startTs).toBeLessThan(now - 23 * 3600);
  });

});

describe('triggerGapBackfill', () => {
  it('treats an empty DB as one big gap covering the whole range', async () => {
    // Empty DB now reports the full window as a single missing gap (a dead
    // sensor, in effect). Backfill should fetch chunks covering it.
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor('g1')]);
    fetchSamples.mockResolvedValue([]);

    await triggerGapBackfill(makeDb(), CREDS, { range: '24h' });

    expect(fetchSamples).toHaveBeenCalled();
    const st = getBackfillStatus();
    expect(st.status).toBe('done');
    expect(st.progress.total).toBeGreaterThan(0);
  });

  it('fetches only the gap windows derived from local DB state', async () => {
    const db  = makeDb();
    const now = Math.floor(Date.now() / 1000);

    upsertSensors(db, [sensor('g2')]);
    // Two readings 2h apart at the start of a 24h window, then nothing —
    // creates a single gap from t-86400+7200 to t-0 (well, until last reading).
    insertReadings(db, 'g2', [
      { observed: new Date((now - 23 * 3600) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: 2.9 },
      { observed: new Date((now - 21 * 3600) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: 2.9 },
    ]);

    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor('g2')]);
    fetchSamples.mockResolvedValue([]);

    await triggerGapBackfill(db, CREDS, { range: '24h' });

    // Three gap windows: leading (now-86400 → now-23h), interior (now-23h →
    // now-21h, 2h), trailing (now-21h → now). All targeted at sensor 'g2',
    // none broader than 2 days.
    expect(fetchSamples).toHaveBeenCalled();
    for (const [, w] of fetchSamples.mock.calls) {
      expect(w.sensorId).toBe('g2');
      expect(w.stopTs - w.startTs).toBeLessThanOrEqual(2 * 86400);
    }
    // Confirm the interior gap is covered by at least one fetch
    const hasInterior = fetchSamples.mock.calls.some(([, w]) =>
      w.startTs <= now - 23 * 3600 + 1 && w.stopTs >= now - 21 * 3600 - 1);
    expect(hasInterior).toBe(true);
  });

  it('chunks gap windows longer than 2 days into <=2-day pieces', async () => {
    const db  = makeDb();
    const now = Math.floor(Date.now() / 1000);

    upsertSensors(db, [sensor('g3')]);
    // Two readings 7 days apart inside a 30d range — gap is ~7d.
    // For ranges > 24h, getGaps reads hourly_agg, so populate it.
    const ts1 = now - 29 * 86400, ts2 = now - 22 * 86400;
    insertReadings(db, 'g3', [
      { observed: new Date(ts1 * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: 2.9 },
      { observed: new Date(ts2 * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: 2.9 },
    ]);
    recomputeHourlyAgg(db, 'g3', ts1 - (ts1 % 3600));
    recomputeHourlyAgg(db, 'g3', ts2 - (ts2 % 3600));

    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor('g3')]);
    fetchSamples.mockResolvedValue([]);

    await triggerGapBackfill(db, CREDS, { range: '30d' });

    // 7-day gap → ceil(7/2) = 4 chunks. Allow ±1 for boundary chunking.
    expect(fetchSamples.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [, w] of fetchSamples.mock.calls) {
      expect(w.stopTs - w.startTs).toBeLessThanOrEqual(2 * 86400);
    }
  });

  it('inserts returned samples and counts them in progress.inserted', async () => {
    const db  = makeDb();
    const now = Math.floor(Date.now() / 1000);

    upsertSensors(db, [sensor('g4')]);
    insertReadings(db, 'g4', [
      { observed: new Date((now - 23 * 3600) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: 2.9 },
      { observed: new Date((now - 21 * 3600) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: 2.9 },
    ]);

    const filledSample = {
      observed: new Date((now - 12 * 3600) * 1000).toISOString(),
      temperature: 71, humidity: 51, barometric_pressure: null, battery_voltage: 2.9,
    };
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor('g4')]);
    fetchSamples.mockResolvedValueOnce([filledSample]).mockResolvedValue([]);

    await triggerGapBackfill(db, CREDS, { range: '24h' });

    const row = db.prepare('SELECT COUNT(*) AS n FROM readings WHERE sensor_id = ?').get('g4');
    expect(row.n).toBe(3);
    expect(getBackfillStatus().progress.inserted).toBe(1);
  });

  it('throws when auth fails', async () => {
    getToken.mockResolvedValue(null);
    await expect(triggerGapBackfill(makeDb(), CREDS, { range: '24h' })).rejects.toThrow('SensorPush auth failed');
  });
});

describe('triggerBackfill (broad)', () => {
  it('throws when auth fails', async () => {
    getToken.mockResolvedValue(null);
    const fromTs = Math.floor(Date.now() / 1000) - 7 * 86400;
    await expect(triggerBackfill(makeDb(), CREDS, fromTs)).rejects.toThrow('SensorPush auth failed');
  });

  it('chunks the [fromTs, now] range into 2-day windows per sensor', async () => {
    const db = makeDb();
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor('b1')]);
    fetchSamples.mockResolvedValue([]);

    const fromTs = Math.floor(Date.now() / 1000) - 6 * 86400;
    await triggerBackfill(db, CREDS, fromTs);

    // 6 days / 2-day chunks = 3 windows for one sensor
    expect(fetchSamples).toHaveBeenCalledTimes(3);
    for (const [, w] of fetchSamples.mock.calls) {
      expect(w.stopTs - w.startTs).toBeLessThanOrEqual(2 * 86400);
    }
  });

  it('throws "already running" when a backfill is in progress', async () => {
    const db = makeDb();
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor('b2')]);
    // Make fetchSamples never resolve so the backfill stays running.
    let release;
    const blocker = new Promise(r => { release = r; });
    fetchSamples.mockImplementation(() => blocker);

    const fromTs = Math.floor(Date.now() / 1000) - 86400;
    const first = triggerBackfill(db, CREDS, fromTs);

    // Wait one tick so the first call enters the "running" state.
    await new Promise(r => setImmediate(r));
    await expect(triggerBackfill(db, CREDS, fromTs)).rejects.toThrow(/already running/i);

    release([]);
    await first;
  });
});

describe('triggerGapBackfill — already-running guard', () => {
  it('refuses when another backfill is in progress', async () => {
    const db = makeDb();
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor('gb1')]);
    let release;
    fetchSamples.mockImplementation(() => new Promise(r => { release = r; }));

    const first = triggerGapBackfill(db, CREDS, { range: '24h' });
    await new Promise(r => setImmediate(r));
    await expect(triggerGapBackfill(db, CREDS, { range: '24h' })).rejects.toThrow(/already running/i);
    release([]);
    await first;
  });
});

describe('_snapshotDb (daily DB backup)', () => {
  let tmpDir, prevDbPath;

  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    tmpDir = mkdtempSync(join(tmpdir(), 'sp-snapshot-'));
    prevDbPath = process.env.DB_PATH;
    // _snapshotDb derives the backups dir from dirname(DB_PATH)
    process.env.DB_PATH = join(tmpDir, 'sensorpush.db');
  });

  afterEach(async () => {
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    const { rmSync } = await import('node:fs');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a dated snapshot file and creates the backups/ directory', async () => {
    const { existsSync, statSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const db = makeDb();
    upsertSensors(db, [sensor('snap1')]);
    insertReadings(db, 'snap1', [{
      observed: new Date().toISOString(), temperature: 70, humidity: 50,
    }]);

    await _snapshotDb(db);

    const backupsDir = join(tmpDir, 'backups');
    expect(existsSync(backupsDir)).toBe(true);
    const files = readdirSync(backupsDir).filter(f => f.endsWith('.db'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^sensorpush-\d{4}-\d{2}-\d{2}\.db$/);
    expect(statSync(join(backupsDir, files[0])).size).toBeGreaterThan(0);
  });

  it('keeps only the 7 most-recent dated snapshots', async () => {
    const { writeFileSync, mkdirSync, readdirSync, utimesSync } = await import('node:fs');
    const { join } = await import('node:path');
    const backupsDir = join(tmpDir, 'backups');
    mkdirSync(backupsDir);
    // Plant 10 dummy snapshots with mtimes spaced 1 day apart, oldest first.
    const NOW = Date.now() / 1000;
    for (let i = 0; i < 10; i++) {
      const d = new Date(Date.now() - (10 - i) * 86400 * 1000).toISOString().slice(0, 10);
      const p = join(backupsDir, `sensorpush-${d}.db`);
      writeFileSync(p, 'fake');
      const t = NOW - (10 - i) * 86400;
      utimesSync(p, t, t);
    }
    // A non-snapshot file should NOT be touched by retention pruning.
    writeFileSync(join(backupsDir, 'unrelated.txt'), 'keep me');

    const db = makeDb();
    await _snapshotDb(db);

    const files = readdirSync(backupsDir).filter(f => /^sensorpush-.*\.db$/.test(f));
    expect(files.length).toBe(7);
    // unrelated.txt survives
    expect(readdirSync(backupsDir)).toContain('unrelated.txt');
  });

  it('handles single-quoted paths safely (escapes for VACUUM INTO)', async () => {
    const { mkdtempSync, existsSync, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const trickyDir = mkdtempSync(join(tmpdir(), `sp-quote'-`));
    process.env.DB_PATH = join(trickyDir, 'sensorpush.db');
    try {
      const db = makeDb();
      await _snapshotDb(db);
      const files = readdirSync(join(trickyDir, 'backups'));
      expect(files.some(f => /^sensorpush-.*\.db$/.test(f))).toBe(true);
    } finally {
      const { rmSync } = await import('node:fs');
      rmSync(trickyDir, { recursive: true, force: true });
    }
  });
});

describe('poller invokes pruneGatewayStatus', () => {
  it('removes gateway_status rows older than 30 days each successful poll', async () => {
    const db = makeDb();
    const NOW = Math.floor(Date.now() / 1000);
    // Pre-seed an old row that should be pruned.
    db.prepare(`INSERT INTO gateway_status (gateway_id, polled_at, last_seen) VALUES (?, ?, ?)`)
      .run('old_gw', NOW - 31 * 86400, NOW - 31 * 86400);

    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor('p1')]);
    fetchSamples.mockResolvedValue([]);
    fetchGateways.mockResolvedValue([{ id: 'gw1', name: 'A', lastSeen: NOW, lastAlert: null, version: '1', paired: true, message: null }]);

    await triggerPoll(db, CREDS);

    const oldRow = db.prepare(`SELECT 1 FROM gateway_status WHERE gateway_id = ?`).get('old_gw');
    expect(oldRow).toBeUndefined();
  });
});

describe('triggerPoll — gateway recording', () => {
  it('upserts gateways and appends a gateway_status row each poll', async () => {
    const db = makeDb();
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor()]);
    fetchSamples.mockResolvedValue([]);
    fetchGateways.mockResolvedValue([
      { id: 'gw1', name: 'Downstairs', lastSeen: Math.floor(Date.now()/1000) - 60, lastAlert: null, version: '1.0', paired: true, message: null },
    ]);

    await triggerPoll(db, CREDS);

    const gws = db.prepare(`SELECT id, name FROM gateways`).all();
    expect(gws).toEqual([{ id: 'gw1', name: 'Downstairs' }]);
    const status = db.prepare(`SELECT COUNT(*) AS n FROM gateway_status WHERE gateway_id = ?`).get('gw1');
    expect(status.n).toBe(1);
  });

  it('does not break sample ingestion when gateway fetch fails', async () => {
    const db = makeDb();
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor('s_ok')]);
    fetchSamples.mockResolvedValue([]);
    fetchGateways.mockRejectedValue(new Error('nope'));

    await triggerPoll(db, CREDS);

    expect(getPollStatus().lastPollError).toBeNull();
  });
});

describe('triggerPoll — hourly recompute', () => {
  it('recomputes hourly aggregates for hours that received new readings', async () => {
    const db  = makeDb();
    const now = Math.floor(Date.now() / 1000);

    upsertSensors(db, [sensor('agg1')]);
    insertReadings(db, 'agg1', [sample(3600)]);

    const newSample = {
      observed:            new Date((now - 60) * 1000).toISOString(),
      temperature:         72,
      humidity:            55,
      barometric_pressure: null,
      battery_voltage:     2.9,
    };

    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor('agg1')]);
    fetchSamples.mockResolvedValue([newSample]);

    await triggerPoll(db, CREDS);

    const row = db.prepare('SELECT COUNT(*) AS n FROM hourly_agg WHERE sensor_id = ?').get('agg1');
    expect(row.n).toBeGreaterThan(0);
  });
});

describe('triggerWeatherPoll', () => {
  const WEATHER_CFG = { ...CREDS, weather: { lat: 43.65, lon: -79.38 } };

  it('skips when no weather block is configured', async () => {
    await triggerWeatherPoll(makeDb(), CREDS);
    expect(fetchCurrentWeather).not.toHaveBeenCalled();
    expect(fetchHourlyWeather).not.toHaveBeenCalled();
  });

  it('first run uses hourly backfill (DB is empty)', async () => {
    const db = makeDb();
    fetchHourlyWeather.mockResolvedValue([
      { ts: 1000, temp: 60, humidity: 50, dewpoint: 40 },
      { ts: 4600, temp: 61, humidity: 51, dewpoint: 41 },
    ]);
    await triggerWeatherPoll(db, WEATHER_CFG);
    expect(fetchHourlyWeather).toHaveBeenCalledTimes(1);
    expect(fetchCurrentWeather).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM outdoor_readings').get().n).toBe(2);
  });

  it('subsequent runs use current-weather fetch (DB has rows)', async () => {
    const db = makeDb();
    // Seed one row so the poller takes the "current" path.
    fetchHourlyWeather.mockResolvedValueOnce([{ ts: 1000, temp: 60, humidity: 50, dewpoint: 40 }]);
    await triggerWeatherPoll(db, WEATHER_CFG);
    expect(getLatestOutdoorTs(db)).toBe(1000);

    fetchCurrentWeather.mockResolvedValueOnce([{ ts: 5000, temp: 65, humidity: 55, dewpoint: 50 }]);
    await triggerWeatherPoll(db, WEATHER_CFG);
    expect(fetchCurrentWeather).toHaveBeenCalledTimes(1);
    expect(getLatestOutdoorTs(db)).toBe(5000);
  });

  it('updates lastWeatherPollTime and clears lastWeatherError on success', async () => {
    fetchHourlyWeather.mockResolvedValue([{ ts: 1000, temp: 60, humidity: 50, dewpoint: 40 }]);
    const before = Date.now();
    await triggerWeatherPoll(makeDb(), WEATHER_CFG);
    const { lastWeatherPollTime, lastWeatherError } = getPollStatus();
    expect(lastWeatherPollTime).toBeGreaterThanOrEqual(before);
    expect(lastWeatherError).toBeNull();
  });

  it('does nothing destructive when the fetch returns no samples (transient failure)', async () => {
    const db = makeDb();
    fetchHourlyWeather.mockResolvedValue([]);
    await triggerWeatherPoll(db, WEATHER_CFG);
    expect(db.prepare('SELECT COUNT(*) AS n FROM outdoor_readings').get().n).toBe(0);
    expect(getPollStatus().lastWeatherError).toBeNull();
  });
});
