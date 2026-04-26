import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../sensorpush.js', () => ({
  getToken:     vi.fn(),
  fetchSensors: vi.fn(),
  fetchSamples: vi.fn(),
}));

import { getToken, fetchSensors, fetchSamples } from '../sensorpush.js';
import { openDb, upsertSensors, insertReadings, recomputeHourlyAgg } from '../db.js';
import { triggerPoll, getPollStatus, triggerGapBackfill, getBackfillStatus, _resetPollerState } from '../poller.js';

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
  it('does nothing and reports zero windows when DB is empty', async () => {
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([sensor('g1')]);

    await triggerGapBackfill(makeDb(), CREDS, { range: '24h' });

    expect(fetchSamples).not.toHaveBeenCalled();
    const st = getBackfillStatus();
    expect(st.status).toBe('done');
    expect(st.progress.total).toBe(0);
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

    // One gap window now-23h → now-21h (2h, single chunk)
    expect(fetchSamples).toHaveBeenCalledTimes(1);
    const [, w] = fetchSamples.mock.calls[0];
    expect(w.sensorId).toBe('g2');
    expect(w.startTs).toBeGreaterThanOrEqual(now - 23 * 3600 - 1);
    expect(w.stopTs).toBeLessThanOrEqual(now - 21 * 3600 + 1);
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
