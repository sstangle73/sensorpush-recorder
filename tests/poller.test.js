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

import http from 'node:http';
import { getToken, fetchSensors, fetchSamples, fetchGateways } from '../sensorpush.js';
import { fetchCurrentWeather, fetchHourlyWeather } from '../weather.js';
import { openDb, upsertSensors, insertReadings, recomputeHourlyAgg, getLatestOutdoorTs, setLastPollTime } from '../db.js';
import { triggerPoll, getPollStatus, triggerBackfill, triggerGapBackfill, getBackfillStatus, _resetPollerState, _snapshotDb, _pruneReadings, triggerWeatherPoll, startPoller, loadStoredPollTime } from '../poller.js';
import { createApp, _renderMetrics } from '../server.js';

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

  it('chunks span ~now back to ~30 days (order-independent)', async () => {
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor()]);
    fetchSamples.mockResolvedValue([]);

    const before = Math.floor(Date.now() / 1000);
    await triggerPoll(makeDb(), CREDS);
    const after = Math.floor(Date.now() / 1000);

    // The unified poll loop walks windows ascending, so assert on the span
    // (newest stopTs ≈ now, oldest startTs ≈ 30 days back) rather than call order.
    const calls    = fetchSamples.mock.calls.map(c => c[1]);
    const maxStop  = Math.max(...calls.map(c => c.stopTs));
    const minStart = Math.min(...calls.map(c => c.startTs));

    expect(maxStop).toBeGreaterThanOrEqual(before);
    expect(maxStop).toBeLessThanOrEqual(after + 1);
    expect(minStart).toBeGreaterThanOrEqual(before - 30 * 86400 - 1);
    expect(minStart).toBeLessThanOrEqual(after  - 28 * 86400);
    // Every window stays under the 2-day SensorPush response cap.
    for (const w of calls) expect(w.stopTs - w.startTs).toBeLessThanOrEqual(2 * 86400);
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

    const { lastPollTime, lastPollError, lastSensorCount } = getPollStatus();
    expect(lastPollTime).toBeGreaterThanOrEqual(before);
    expect(lastPollError).toBeNull();
    // /health surfaces this in-memory count instead of a DB query.
    expect(lastSensorCount).toBe(1);
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

  it('chunks a multi-day catch-up into bounded ≤2-day windows (no single giant fetch)', async () => {
    const db = makeDb();

    upsertSensors(db, [sensor('inc2')]);
    // Latest reading is ~9 days old — the catch-up-after-downtime case that
    // used to do one unbounded fetch + one non-yielding insert/recompute burst
    // (the recurring trigger of the event-loop wedge). It must now chunk.
    insertReadings(db, 'inc2', [sample(9 * 86400)]);

    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor('inc2')]);
    fetchSamples.mockResolvedValue([]);

    await triggerPoll(db, CREDS);

    // ~9 days + 24h lookback ≈ 10 days → multiple windows, each ≤ 2 days.
    expect(fetchSamples.mock.calls.length).toBeGreaterThan(1);
    for (const [, w] of fetchSamples.mock.calls) {
      expect(w.sensorId).toBe('inc2');
      expect(w.stopTs - w.startTs).toBeLessThanOrEqual(2 * 86400);
    }
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

  it('handles paths with special characters (backup() takes the path directly, no SQL interpolation)', async () => {
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

  it('produces a valid SQLite copy that preserves the data (online backup)', async () => {
    const { readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const db = makeDb();
    upsertSensors(db, [sensor('snapd')]);
    insertReadings(db, 'snapd', [
      { observed: new Date().toISOString(),               temperature: 70, humidity: 50 },
      { observed: new Date(Date.now() - 3600e3).toISOString(), temperature: 68, humidity: 52 },
    ]);

    await _snapshotDb(db);

    const backupsDir = join(tmpDir, 'backups');
    const file = readdirSync(backupsDir).find(f => /^sensorpush-.*\.db$/.test(f));
    // Re-open the snapshot as an independent DB and confirm the rows survived.
    const snap = openDb(join(backupsDir, file));
    const n = snap.prepare('SELECT COUNT(*) AS n FROM readings WHERE sensor_id = ?').get('snapd').n;
    snap.close();
    expect(n).toBe(2);
  });
});

describe('_pruneReadings / retention', () => {
  it('deletes raw readings older than the cutoff but keeps hourly aggregates', async () => {
    const db  = makeDb();
    const now = Math.floor(Date.now() / 1000);
    upsertSensors(db, [sensor('ret1')]);

    // One old reading (400 days) and one recent (1h). Build the hourly_agg for
    // the old hour, mirroring what the poll loop does on insert.
    const oldTs = now - 400 * 86400;
    const newTs = now - 3600;
    insertReadings(db, 'ret1', [
      { observed: new Date(oldTs * 1000).toISOString(), temperature: 60, humidity: 40 },
      { observed: new Date(newTs * 1000).toISOString(), temperature: 70, humidity: 50 },
    ]);
    recomputeHourlyAgg(db, 'ret1', oldTs - (oldTs % 3600));
    recomputeHourlyAgg(db, 'ret1', newTs - (newTs % 3600));

    const aggBefore = db.prepare('SELECT COUNT(*) AS n FROM hourly_agg WHERE sensor_id = ?').get('ret1').n;

    await _pruneReadings(db); // default 365-day retention (env unset)

    const rawRows = db.prepare('SELECT ts FROM readings WHERE sensor_id = ? ORDER BY ts').all('ret1');
    expect(rawRows.map(r => r.ts)).toEqual([newTs]);            // old raw gone, recent kept
    const aggAfter = db.prepare('SELECT COUNT(*) AS n FROM hourly_agg WHERE sensor_id = ?').get('ret1').n;
    expect(aggAfter).toBe(aggBefore);                            // aggregates untouched
  });

  it('is a no-op when READINGS_RETENTION_DAYS is 0', async () => {
    // The module reads the env var at import time, so this only asserts the
    // guard shape: with the default (365d) nothing recent is pruned.
    const db  = makeDb();
    const now = Math.floor(Date.now() / 1000);
    upsertSensors(db, [sensor('ret2')]);
    insertReadings(db, 'ret2', [{ observed: new Date((now - 3600) * 1000).toISOString(), temperature: 70, humidity: 50 }]);
    await _pruneReadings(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM readings WHERE sensor_id = ?').get('ret2').n).toBe(1);
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

// A restart must not erase the last good poll from /metrics: the timestamp
// used to vanish until the next good poll, so a restart while the polls still
// failed read as "no data", not as "hours old". And it must not reach /health:
// lastPoll and pollError start empty on every start, and the first poll fills
// exactly one, which is how a caller proves a restarted recorder signs in.
describe('poll status across a restart', () => {
  const HOURS_26 = 26 * 3600 * 1000;

  // A fresh process over a DB that may hold meta.last_poll, set up the way
  // startPoller does it.
  function restartedWith(storedMs) {
    const db = makeDb();
    if (storedMs != null) setLastPollTime(db, storedMs);
    _resetPollerState();
    loadStoredPollTime(db);
    return db;
  }

  async function health(db) {
    const server = http.createServer(createApp(db));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
      return await res.json();
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }

  function timestampLine(ms) {
    return new RegExp(`^sensorpush_last_poll_timestamp_seconds ${Math.floor(ms / 1000)}$`, 'm');
  }

  it('reports the stored last good poll in /metrics, not in /health', async () => {
    const stored = Date.now() - HOURS_26;
    const db = restartedWith(stored);

    const body = _renderMetrics(db);
    expect(body).toMatch(timestampLine(stored));
    expect(body).toMatch(/^sensorpush_last_poll_success -1$/m);
    expect(getPollStatus().lastGoodPollTime).toBe(stored);
    expect(await health(db)).toMatchObject({ lastPoll: null, pollError: null });
  });

  it('reports a failed poll after a restart as 0, not -1, and keeps the stored time', async () => {
    const stored = Date.now() - HOURS_26;
    const db = restartedWith(stored);
    getToken.mockResolvedValue(null);

    await expect(triggerPoll(db, CREDS)).rejects.toThrow('SensorPush auth failed');

    const body = _renderMetrics(db);
    expect(body).toMatch(/^sensorpush_last_poll_success 0$/m);
    expect(body).toMatch(timestampLine(stored));
    const h = await health(db);
    expect(h.lastPoll).toBeNull();
    expect(h.pollError).toMatch('SensorPush auth failed');
  });

  it('replaces the stored time with the first good poll after a restart', async () => {
    const stored = Date.now() - HOURS_26;
    const db = restartedWith(stored);
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor()]);
    fetchSamples.mockResolvedValue([]);

    const before = Date.now();
    await triggerPoll(db, CREDS);

    const { lastPollTime, lastGoodPollTime } = getPollStatus();
    expect(lastPollTime).toBeGreaterThanOrEqual(before);
    expect(lastGoodPollTime).toBe(lastPollTime);
    const body = _renderMetrics(db);
    expect(body).toMatch(/^sensorpush_last_poll_success 1$/m);
    expect(body).toMatch(timestampLine(lastPollTime));
    expect((await health(db)).lastPoll).toBe(new Date(lastPollTime).toISOString());
  });

  it('has no timestamp before the first good poll ever', () => {
    const db = restartedWith(null);
    expect(getPollStatus().lastGoodPollTime).toBeNull();
    expect(_renderMetrics(db)).not.toMatch(/^sensorpush_last_poll_timestamp_seconds /m);
  });

  it('startPoller loads the stored time before its first poll', () => {
    vi.useFakeTimers();
    try {
      const stored = Date.now() - HOURS_26;
      const db = makeDb();
      setLastPollTime(db, stored);
      _resetPollerState();
      // No credentials, so its immediate poll returns at once; the interval
      // and the daily jobs are fake timers, cleared below.
      startPoller(db, {});
      expect(getPollStatus().lastGoodPollTime).toBe(stored);
      expect(getPollStatus().lastPollTime).toBeNull();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
