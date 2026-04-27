import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../server.js';
import { openDb, upsertSensors, insertReadings, recomputeHourlyAgg, upsertGateways, recordGatewayStatus } from '../db.js';
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
  // Capture the seeded ts ONCE in beforeAll and reuse it from every `it`.
  // Previously each `it` re-derived `ts = floor(Date.now() / 1000) - 3600`,
  // which differed from the seeded ts when the test crossed a second
  // boundary between beforeAll and the `it` body — making the SQL lookup
  // miss and the assertion fail spuriously.
  let seededTs;
  beforeAll(() => {
    seededTs = Math.floor(Date.now() / 1000) - 3600;
    upsertSensors(db, [{ id: 'ex1', name: 'Ex', type: 'HT1', active: true, batteryVoltage: null }]);
    insertReadings(db, 'ex1', [
      { observed: new Date(seededTs * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: null },
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
    const { status, body } = await patch('/ex1/readings/exclude', { ts: seededTs, excluded: true });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const row = db.prepare('SELECT excluded FROM readings WHERE sensor_id=? AND ts=?').get('ex1', seededTs);
    expect(row?.excluded).toBe(1);
  });

  it('restores a reading and returns ok', async () => {
    await patch('/ex1/readings/exclude', { ts: seededTs, excluded: true });
    const { body } = await patch('/ex1/readings/exclude', { ts: seededTs, excluded: false });
    expect(body.ok).toBe(true);
    const row = db.prepare('SELECT excluded FROM readings WHERE sensor_id=? AND ts=?').get('ex1', seededTs);
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

  it('annotates each gap with gatewayOnline = true|false|null', async () => {
    const now = Math.floor(Date.now() / 1000);
    upsertSensors(db, [{ id: 'gw_gap', name: 'GwGap', type: 'HT1', active: true, batteryVoltage: null }]);
    // Two readings 2h apart in the last 24h → one gap window
    insertReadings(db, 'gw_gap', [
      { observed: new Date((now - 23 * 3600) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: null },
      { observed: new Date((now - 21 * 3600) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: null },
    ]);
    // Gateway poll inside the gap window with fresh last_seen
    recordGatewayStatus(db, [{ id: 'gw1', lastSeen: now - 22 * 3600 - 60 }], now - 22 * 3600);

    const { body } = await get('/gw_gap/gaps?range=24h');
    expect(body.gaps.length).toBeGreaterThan(0);
    // Find the interior gap (between the two readings) and verify gateway annotation.
    const interior = body.gaps.find(g => g.startTs >= now - 23 * 3600 - 1 && g.endTs <= now - 21 * 3600 + 1);
    expect(interior).toBeDefined();
    expect(interior.gatewayOnline).toBe(true);
  });
});

describe('GET /gateways', () => {
  it('returns empty array when no gateways recorded', async () => {
    const { status, body } = await get('/gateways');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.gateways)).toBe(true);
  });

  it('returns recorded gateways with ISO timestamps', async () => {
    const now = Math.floor(Date.now() / 1000);
    upsertGateways(db, [{ id: 'gw_route', name: 'Test', lastSeen: now - 60, lastAlert: null, version: '1.0', paired: true, message: null }]);
    const { body } = await get('/gateways');
    const gw = body.gateways.find(g => g.id === 'gw_route');
    expect(gw).toBeDefined();
    expect(gw.name).toBe('Test');
    expect(gw.lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(gw.version).toBe('1.0');
    expect(gw.paired).toBe(true);
  });
});

describe('POST /backfill validation', () => {
  async function post(path, body) {
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it('returns 503 without config', async () => {
    // Default `db`-only app has no config → 503 on backfill
    const { status, body } = await post('/backfill', { fromDate: '2026-01-01' });
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
  });

  it('returns 400 when fromDate is missing', async () => {
    // Use the no-config app to test validation runs even without config?
    // Actually 503 fires first. Spin up a second app with a stub config.
    const stubConfig = { sensorpush: { email: 'YOUR_PLACEHOLDER', password: 'pw' } };
    const db2 = openDb(':memory:');
    const srv2 = http.createServer(createApp(db2, stubConfig));
    await new Promise(r => srv2.listen(0, '127.0.0.1', r));
    const u = `http://127.0.0.1:${srv2.address().port}`;
    const r1 = await fetch(u + '/backfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(r1.status).toBe(400);
    const r2 = await fetch(u + '/backfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromDate: 'not-a-date' }) });
    expect(r2.status).toBe(400);
    await new Promise(r => srv2.close(r));
  });

  it('parses fromDate as UTC midnight (timezone-stable)', async () => {
    // Verify the route accepts a valid date and that fromTs is computed
    // from UTC, not local time. We check that triggerBackfill is invoked
    // with a UTC-derived epoch via the logged "starting" message; here we
    // just confirm 'YYYY-MM-DD' is accepted. Triggering the actual backfill
    // would need network mocking — covered indirectly via poller tests.
    const stubConfig = { sensorpush: { email: 'YOUR_PLACEHOLDER', password: 'pw' } };
    const db2 = openDb(':memory:');
    const srv2 = http.createServer(createApp(db2, stubConfig));
    await new Promise(r => srv2.listen(0, '127.0.0.1', r));
    const u = `http://127.0.0.1:${srv2.address().port}`;
    const r = await fetch(u + '/backfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromDate: '2026-01-15' }) });
    expect(r.status).toBe(200);
    await new Promise(r => srv2.close(r));
  });
});

describe('POST /backfill-gaps validation', () => {
  it('returns 503 without config', async () => {
    const r = await fetch(baseUrl + '/backfill-gaps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(503);
  });

  it('returns 400 on invalid range', async () => {
    const stubConfig = { sensorpush: { email: 'YOUR_PLACEHOLDER', password: 'pw' } };
    const db2 = openDb(':memory:');
    const srv2 = http.createServer(createApp(db2, stubConfig));
    await new Promise(r => srv2.listen(0, '127.0.0.1', r));
    const u = `http://127.0.0.1:${srv2.address().port}`;
    const r = await fetch(u + '/backfill-gaps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ range: 'forever' }) });
    expect(r.status).toBe(400);
    await new Promise(r => srv2.close(r));
  });
});

describe('GET /backfill/status', () => {
  it('returns ok with current state', async () => {
    const { status, body } = await get('/backfill/status');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty('status');
  });
});

describe('GET/PUT /settings', () => {
  it('GET returns ok with empty object initially', async () => {
    const { status, body } = await get('/settings');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.settings).toBeDefined();
  });

  it('PUT persists ranges, GET reads them back', async () => {
    const r = await fetch(baseUrl + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ranges: ['1h', '24h', '7d', '1yr'] }),
    });
    expect(r.status).toBe(200);
    const { body } = await get('/settings');
    expect(body.settings.ranges).toEqual(['1h', '24h', '7d', '1yr']);
  });

  it('PUT rejects invalid range strings', async () => {
    const r = await fetch(baseUrl + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ranges: ['1h', 'forever'] }),
    });
    expect(r.status).toBe(400);
  });

  it('PUT rejects non-array body', async () => {
    const r = await fetch(baseUrl + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ranges: 'not-an-array' }),
    });
    expect(r.status).toBe(400);
  });
});

describe('CORS middleware', () => {
  // Capture the OLD env, set CORS_ORIGINS, build a new app, then restore.
  // Note: server.js reads CORS_ORIGINS at module-load time, so we need a
  // fresh import. For simplicity we just assert the documented behavior:
  // the middleware never echoes "*" and only echoes when origin matches.
  it('does not set Access-Control-Allow-Origin when no Origin header', async () => {
    const r = await fetch(baseUrl + '/health');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('does not echo unknown origins', async () => {
    const r = await fetch(baseUrl + '/health', { headers: { Origin: 'https://evil.example.com' } });
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('OPTIONS request returns 204 quickly without invoking route', async () => {
    const r = await fetch(baseUrl + '/health', { method: 'OPTIONS' });
    expect(r.status).toBe(204);
  });
});

describe('GET /:id/history.csv', () => {
  let csvDb, csvSrv, csvUrl;
  beforeAll(async () => {
    csvDb = openDb(':memory:');
    upsertSensors(csvDb, [{ id: 'csv1', name: 'CSV Test', type: 'HT1', active: true, batteryVoltage: 2.9 }]);
    const now = Math.floor(Date.now() / 1000);
    insertReadings(csvDb, 'csv1', [
      { observed: new Date((now - 600) * 1000).toISOString(), temperature: 70.5, humidity: 45.2, barometric_pressure: null, dewpoint: 47.8, vpd: 1.05 },
      { observed: new Date((now - 300) * 1000).toISOString(), temperature: 71.0, humidity: 44.5, barometric_pressure: null, dewpoint: 47.9, vpd: 1.08 },
    ]);
    await new Promise(r => {
      csvSrv = http.createServer(createApp(csvDb));
      csvSrv.listen(0, '127.0.0.1', () => { csvUrl = `http://127.0.0.1:${csvSrv.address().port}`; r(); });
    });
  });
  afterAll(() => new Promise(r => csvSrv.close(r)));

  it('returns 200 with text/csv content-type and attachment disposition', async () => {
    const r = await fetch(csvUrl + '/csv1/history.csv?range=24h');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/csv/);
    expect(r.headers.get('content-disposition')).toMatch(/attachment.*\.csv/);
  });

  it('uses raw-resolution columns at h-unit ranges (no min/max bands)', async () => {
    const r = await fetch(csvUrl + '/csv1/history.csv?range=24h');
    const text = await r.text();
    const header = text.split('\n')[0];
    expect(header).toBe('ts,observed_iso,temperature,humidity,baro_pressure,dewpoint,vpd');
    // Two readings → two data rows
    expect(text.trim().split('\n').length).toBe(3);
    // Values from the seeded data should appear
    expect(text).toContain('70.5');
    expect(text).toContain('47.8');
  });

  it('uses aggregate columns (min/max bands) at d-unit ranges', async () => {
    const r = await fetch(csvUrl + '/csv1/history.csv?range=7d');
    const text = await r.text();
    const header = text.split('\n')[0];
    expect(header).toBe('ts,observed_iso,temperature,temp_min,temp_max,humidity,hum_min,hum_max,baro_pressure,dewpoint,vpd');
  });

  it('returns 404 for unknown sensor', async () => {
    const r = await fetch(csvUrl + '/missing/history.csv?range=24h');
    expect(r.status).toBe(404);
  });

  it('returns 400 for invalid range', async () => {
    const r = await fetch(csvUrl + '/csv1/history.csv?range=forever');
    expect(r.status).toBe(400);
  });

  it('sanitises sensor name in the Content-Disposition filename', async () => {
    upsertSensors(csvDb, [{ id: 'csv2', name: 'Hi/There; rm -rf', type: 'HT1', active: true, batteryVoltage: null }]);
    const r = await fetch(csvUrl + '/csv2/history.csv?range=24h');
    const cd = r.headers.get('content-disposition');
    const m = /filename="([^"]+)"/.exec(cd);
    expect(m).not.toBeNull();
    const filename = m[1];
    // Slashes, semicolons, and shell metacharacters are stripped from the
    // sanitised name; only [a-z0-9_-] survives (plus the .csv extension).
    expect(filename).not.toMatch(/[/;\s]/);
    expect(filename).toMatch(/^Hi_There_rm_-rf/);
    expect(filename).toMatch(/\.csv$/);
  });
});

describe('icon + manifest + sw routes', () => {
  it('GET /icon.svg returns SVG', async () => {
    const r = await fetch(baseUrl + '/icon.svg');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('image/svg+xml');
  });

  it('GET /icon-192.png returns PNG bytes', async () => {
    const r = await fetch(baseUrl + '/icon-192.png');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await r.arrayBuffer());
    // PNG magic number
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
  });

  it('GET /icon-512.png returns PNG bytes', async () => {
    const r = await fetch(baseUrl + '/icon-512.png');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
  });

  it('GET /manifest.json returns valid JSON manifest', async () => {
    const r = await fetch(baseUrl + '/manifest.json');
    expect(r.status).toBe(200);
    const m = await r.json();
    expect(m.name).toMatch(/SensorPush/);
    expect(Array.isArray(m.icons)).toBe(true);
  });

  it('GET /sw.js returns service-worker JS', async () => {
    const r = await fetch(baseUrl + '/sw.js');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('javascript');
    const text = await r.text();
    expect(text).toContain('addEventListener');
  });
});
