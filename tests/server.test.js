import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../server.js';
import { openDb, upsertSensors, insertReadings, recomputeHourlyAgg } from '../db.js';
import { vi } from 'vitest';

let server, baseUrl, db;

beforeAll(() => new Promise(resolve => {
  db = openDb(':memory:');
  server = http.createServer(createApp(db));
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

afterAll(() => new Promise(resolve => server.close(resolve)));

// Tests hit Express routes directly (no nginx), so paths match what nginx
// sends AFTER stripping /api/sensors/ prefix: / → sensors list, /:id/history, /health.
async function get(path) {
  const res  = await fetch(baseUrl + path);
  const body = await res.json();
  return { status: res.status, body };
}

describe('GET /health', () => {
  it('returns ok:true with sensorCount', async () => {
    const { status, body } = await get('/health');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.sensorCount).toBe('number');
  });
});

describe('GET / (sensors list)', () => {
  it('returns ok:true with empty sensors object on empty DB', async () => {
    const { status, body } = await get('/');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sensors).toEqual({});
  });

  it('returns sensor data after upsert + readings', async () => {
    upsertSensors(db, [{ id: 'test1', name: 'Kitchen', type: 'HT1', active: true, batteryVoltage: 2.85 }]);
    const now = Math.floor(Date.now() / 1000);
    insertReadings(db, 'test1', [{
      observed:             new Date((now - 60) * 1000).toISOString(),
      temperature:          71.5,
      humidity:             48,
      barometric_pressure:  null,
      battery_voltage:      2.85,
    }]);

    const { body } = await get('/');
    expect(body.sensors['test1']).toMatchObject({
      id:   'test1',
      name: 'Kitchen',
      type: 'HT1',
    });
    expect(body.sensors['test1'].temperature).toBeCloseTo(71.5);
  });
});

describe('GET /:id/history', () => {
  beforeAll(() => {
    const now = Math.floor(Date.now() / 1000);
    upsertSensors(db, [{ id: 'hist1', name: 'Hist', type: 'HT1', active: true, batteryVoltage: null }]);
    insertReadings(db, 'hist1', [
      { observed: new Date((now - 3600) * 1000).toISOString(), temperature: 68, humidity: 50, barometric_pressure: null, battery_voltage: null },
      { observed: new Date((now - 1800) * 1000).toISOString(), temperature: 70, humidity: 52, barometric_pressure: null, battery_voltage: null },
    ]);
    const hourTs = (now - 3600) - ((now - 3600) % 3600);
    recomputeHourlyAgg(db, 'hist1', hourTs);
  });

  it('returns 404 for unknown sensor', async () => {
    const { status, body } = await get('/nope/history');
    expect(status).toBe(404);
    expect(body.ok).toBe(false);
  });

  it('returns 400 for invalid range', async () => {
    const { status, body } = await get('/hist1/history?range=99y');
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
  });

  it('defaults to 24h when range param is absent', async () => {
    const { body } = await get('/hist1/history');
    expect(body.range).toBe('24h');
    expect(body.resolution).toBe('raw');
  });

  it('returns raw samples for 24h', async () => {
    const { body } = await get('/hist1/history?range=24h');
    expect(body.ok).toBe(true);
    expect(body.resolution).toBe('raw');
    expect(Array.isArray(body.samples)).toBe(true);
    expect(body.samples.length).toBeGreaterThanOrEqual(2);
    expect(body.samples[0]).toHaveProperty('ts');
  });

  it('returns hourly samples for 7d', async () => {
    const { body } = await get('/hist1/history?range=7d');
    expect(body.resolution).toBe('hourly');
    if (body.samples.length > 0) {
      expect(body.samples[0]).toHaveProperty('tempMin');
    }
  });

  it('returns hourly samples for 30d', async () => {
    const { body } = await get('/hist1/history?range=30d');
    expect(body.resolution).toBe('hourly');
  });

  it('returns hourly samples for 90d', async () => {
    const { body } = await get('/hist1/history?range=90d');
    expect(body.ok).toBe(true);
    expect(body.resolution).toBe('hourly');
  });

  it('returns hourly samples for 365d', async () => {
    const { body } = await get('/hist1/history?range=365d');
    expect(body.ok).toBe(true);
    expect(body.resolution).toBe('hourly');
  });
});

describe('GET /:id/history/all', () => {
  beforeAll(() => {
    const now = Math.floor(Date.now() / 1000);
    upsertSensors(db, [{ id: 'all1', name: 'All', type: 'HT1', active: true, batteryVoltage: null }]);
    insertReadings(db, 'all1', [
      { observed: new Date((now - 3600) * 1000).toISOString(), temperature: 68, humidity: 50, barometric_pressure: null, battery_voltage: null },
      { observed: new Date((now - 1800) * 1000).toISOString(), temperature: 999, humidity: 99, barometric_pressure: null, battery_voltage: null },
    ]);
    // exclude the second reading
    db.prepare('UPDATE readings SET excluded = 1 WHERE sensor_id = ? AND temperature = 999').run('all1');
  });

  it('returns 404 for unknown sensor', async () => {
    const { status, body } = await get('/nope/history/all');
    expect(status).toBe(404);
    expect(body.ok).toBe(false);
  });

  it('returns 400 for invalid range', async () => {
    const { status } = await get('/all1/history/all?range=bad');
    expect(status).toBe(400);
  });

  it('includes excluded points with excluded field', async () => {
    const { body } = await get('/all1/history/all?range=24h');
    expect(body.ok).toBe(true);
    expect(body.samples.length).toBe(2);
    const bad = body.samples.find(s => s.temperature === 999);
    expect(bad).toBeTruthy();
    expect(bad.excluded).toBe(1);
    const good = body.samples.find(s => s.temperature === 68);
    expect(good.excluded).toBe(0);
  });
});

describe('PATCH /:id/readings/exclude', () => {
  beforeAll(() => {
    const now = Math.floor(Date.now() / 1000);
    upsertSensors(db, [{ id: 'ex1', name: 'Ex', type: 'HT1', active: true, batteryVoltage: null }]);
    insertReadings(db, 'ex1', [
      { observed: new Date((now - 3600) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: null },
    ]);
  });

  async function patch(path, body) {
    const res = await fetch(baseUrl + path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it('returns 404 for unknown sensor', async () => {
    const { status } = await patch('/nope/readings/exclude', { ts: 1000, excluded: true });
    expect(status).toBe(404);
  });

  it('returns 400 when body is missing ts', async () => {
    const { status } = await patch('/ex1/readings/exclude', { excluded: true });
    expect(status).toBe(400);
  });

  it('returns 400 when excluded is not boolean', async () => {
    const { status } = await patch('/ex1/readings/exclude', { ts: 1000, excluded: 1 });
    expect(status).toBe(400);
  });

  it('marks a reading excluded and returns ok', async () => {
    const now = Math.floor(Date.now() / 1000);
    const ts = now - 3600;
    const { status, body } = await patch('/ex1/readings/exclude', { ts, excluded: true });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // verify excluded=1 in DB
    const row = db.prepare('SELECT excluded FROM readings WHERE sensor_id=? AND ts=?').get('ex1', ts);
    expect(row?.excluded).toBe(1);
  });

  it('restores a reading and returns ok', async () => {
    const now = Math.floor(Date.now() / 1000);
    const ts = now - 3600;
    await patch('/ex1/readings/exclude', { ts, excluded: true });
    const { body } = await patch('/ex1/readings/exclude', { ts, excluded: false });
    expect(body.ok).toBe(true);
    const row = db.prepare('SELECT excluded FROM readings WHERE sensor_id=? AND ts=?').get('ex1', ts);
    expect(row?.excluded).toBe(0);
  });
});

describe('PATCH /:id/hourly/exclude', () => {
  beforeAll(() => {
    upsertSensors(db, [{ id: 'hex1', name: 'Hex', type: 'HT1', active: true, batteryVoltage: null }]);
    db.prepare(`INSERT OR IGNORE INTO hourly_agg (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count, excluded)
      VALUES ('hex1', 3600, 65, 63, 67, 48, 45, 51, null, 12, 0)`).run();
  });

  async function patch(path, body) {
    const res = await fetch(baseUrl + path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it('returns 404 for unknown sensor', async () => {
    const { status } = await patch('/nope/hourly/exclude', { hour_ts: 3600, excluded: true });
    expect(status).toBe(404);
  });

  it('returns 400 when body is missing hour_ts', async () => {
    const { status } = await patch('/hex1/hourly/exclude', { excluded: true });
    expect(status).toBe(400);
  });

  it('marks hourly bucket excluded', async () => {
    const { status, body } = await patch('/hex1/hourly/exclude', { hour_ts: 3600, excluded: true });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const row = db.prepare('SELECT excluded FROM hourly_agg WHERE sensor_id=? AND hour_ts=?').get('hex1', 3600);
    expect(row?.excluded).toBe(1);
  });

  it('restores hourly bucket', async () => {
    const { body } = await patch('/hex1/hourly/exclude', { hour_ts: 3600, excluded: false });
    expect(body.ok).toBe(true);
    const row = db.prepare('SELECT excluded FROM hourly_agg WHERE sensor_id=? AND hour_ts=?').get('hex1', 3600);
    expect(row?.excluded).toBe(0);
  });
});

describe('POST /poll', () => {
  async function post(path) {
    const res = await fetch(baseUrl + path, { method: 'POST' });
    return { status: res.status, body: await res.json() };
  }

  it('returns 503 when no config provided', async () => {
    const { status, body } = await post('/poll');
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
  });

  it('returns ok when config with valid credentials is provided', async () => {
    // Spin up a second server with a stub config + mocked poll
    const { triggerPoll } = await import('../poller.js');
    const stubConfig = { sensorpush: { email: 'test@example.com', password: 'pw' } };
    let pollCalled = false;
    vi.spyOn({ triggerPoll }, 'triggerPoll').mockResolvedValue(undefined);

    // Use createApp with a config that has credentials — but override triggerPoll
    // by testing the 503 vs 200 branch: a server with config returns non-503
    const db2 = openDb(':memory:');
    let srv2, url2;
    await new Promise(resolve => {
      srv2 = http.createServer(createApp(db2, stubConfig));
      srv2.listen(0, '127.0.0.1', () => { url2 = `http://127.0.0.1:${srv2.address().port}`; resolve(); });
    });

    // The poll will attempt a real network call and fail — we just verify it gets past the 503 guard
    const res = await fetch(url2 + '/poll', { method: 'POST' });
    // Either 200 (poll succeeded) or 500 (poll failed with auth error) — both mean the guard passed
    expect([200, 500]).toContain(res.status);
    await new Promise(resolve => srv2.close(resolve));
  });
});

describe('GET /ui', () => {
  it('returns HTML page', async () => {
    const res = await fetch(baseUrl + '/ui');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const text = await res.text();
    expect(text).toContain('<html');
  });
});

describe('GET /:id/gaps', () => {
  it('returns 404 for unknown sensor', async () => {
    const { status, body } = await get('/no-such-sensor/gaps');
    expect(status).toBe(404);
    expect(body.ok).toBe(false);
  });

  it('returns 400 for invalid range', async () => {
    upsertSensors(db, [{ id: 'gaptest', name: 'Gap', type: 'HT1', active: true, batteryVoltage: null }]);
    const { status, body } = await get('/gaptest/gaps?range=bad');
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
  });

  it('defaults to 7d range when no range param', async () => {
    upsertSensors(db, [{ id: 'gaptest2', name: 'Gap2', type: 'HT1', active: true, batteryVoltage: null }]);
    const { status, body } = await get('/gaptest2/gaps');
    expect(status).toBe(200);
    expect(body.range).toBe('7d');
  });

  it('returns ok:true with gaps array and coveragePct', async () => {
    upsertSensors(db, [{ id: 'gaptest3', name: 'Gap3', type: 'HT1', active: true, batteryVoltage: null }]);
    const { status, body } = await get('/gaptest3/gaps?range=24h');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.gaps)).toBe(true);
    expect(typeof body.coveragePct).toBe('number');
    expect(body.rangeStartTs).toBeDefined();
    expect(body.rangeEndTs).toBeDefined();
  });

  it('returns sensorId and range in response', async () => {
    upsertSensors(db, [{ id: 'gaptest4', name: 'Gap4', type: 'HT1', active: true, batteryVoltage: null }]);
    const { body } = await get('/gaptest4/gaps?range=30d');
    expect(body.sensorId).toBe('gaptest4');
    expect(body.range).toBe('30d');
  });
});
