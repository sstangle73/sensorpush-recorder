import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../sensorpush.js', () => ({
  getToken:     vi.fn(),
  fetchSensors: vi.fn(),
  fetchSamples: vi.fn(),
}));

import { getToken, fetchSensors, fetchSamples } from '../sensorpush.js';
import { openDb, upsertSensors, insertReadings } from '../db.js';
import { triggerPoll, getPollStatus, _resetPollerState } from '../poller.js';

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
