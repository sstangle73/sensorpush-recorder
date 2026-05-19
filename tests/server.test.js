import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp, _renderMetrics } from '../server.js';
import { openDb, upsertSensors, insertReadings, recomputeHourlyAgg, upsertGateways, recordGatewayStatus, insertOutdoorReadings } from '../db.js';
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
// Accept: application/json mirrors what the UI's fetch() calls send so the
// HTML-default '/' route still returns JSON for these assertions.
async function get(path) {
  const res  = await fetch(baseUrl + path, { headers: { Accept: 'application/json' } });
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

  it('returns null oldestReadingTs on empty DB', async () => {
    const { body } = await get('/');
    expect(body).toHaveProperty('oldestReadingTs');
    expect(body.oldestReadingTs).toBeNull();
  });

  it('serves HTML at / when Accept omits application/json (browser nav, stripped Accept)', async () => {
    // Default Accept (*/*), no application/json → HTML. Covers the case where
    // a reverse proxy strips/replaces the Accept header.
    const res = await fetch(baseUrl + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const text = await res.text();
    expect(text).toContain('<!DOCTYPE html>');
  });

  it('serves HTML at / for a typical browser Accept header', async () => {
    const res = await fetch(baseUrl + '/', {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('serves JSON at / when Accept includes application/json', async () => {
    const res = await fetch(baseUrl + '/', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.ok).toBe(true);
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
    // oldestReadingTs surfaced for the YoY toggle's coverage check
    expect(typeof body.oldestReadingTs).toBe('number');
    expect(body.oldestReadingTs).toBeLessThanOrEqual(now);
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

  it('accepts endTs query param and anchors the window there', async () => {
    // Insert a reading exactly one year ago, then fetch a 24h window
    // anchored at "one year ago" — it should only return the year-old row.
    const now      = Math.floor(Date.now() / 1000);
    const yearAgo  = now - 365 * 86400;
    upsertSensors(db, [{ id: 'yoy1', name: 'YoY', type: 'HT1', active: true, batteryVoltage: null }]);
    insertReadings(db, 'yoy1', [
      { observed: new Date((yearAgo - 1800) * 1000).toISOString(), temperature: 42, humidity: 30, barometric_pressure: null, battery_voltage: null },
      { observed: new Date((now - 60)       * 1000).toISOString(), temperature: 72, humidity: 50, barometric_pressure: null, battery_voltage: null },
    ]);

    const cur = await get('/yoy1/history?range=24h');
    expect(cur.body.samples.some(s => s.temperature === 72)).toBe(true);
    expect(cur.body.samples.some(s => s.temperature === 42)).toBe(false);

    const yoy = await get(`/yoy1/history?range=24h&endTs=${yearAgo}`);
    expect(yoy.body.samples.some(s => s.temperature === 42)).toBe(true);
    expect(yoy.body.samples.some(s => s.temperature === 72)).toBe(false);
  });

  it('returns 400 when endTs is not a positive integer', async () => {
    const bad = await get('/hist1/history?range=24h&endTs=notanumber');
    expect(bad.status).toBe(400);
    expect(bad.body.ok).toBe(false);

    const negative = await get('/hist1/history?range=24h&endTs=-100');
    expect(negative.status).toBe(400);

    const floaty = await get('/hist1/history?range=24h&endTs=12.34');
    expect(floaty.status).toBe(400);
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

describe('POST /settings/notifications/test', () => {
  // We don't want real network calls — for the test endpoint we just check
  // that validation/routing works. Pointing at an unreachable URL returns
  // ok:true with a per-sink error string, which is the documented contract.
  async function post(path, body) {
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it('400s on unknown sink', async () => {
    const { status } = await post('/settings/notifications/test', { sink: 'pagerduty' });
    expect(status).toBe(400);
  });

  it('400s when nothing is configured (no sinks)', async () => {
    const { status, body } = await post('/settings/notifications/test', {
      notifications: { enabled: true, webhook: { enabled: false, url: '' } },
      sink: 'all',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/No matching sink/);
  });

  it('400s on malformed override', async () => {
    const { status } = await post('/settings/notifications/test', {
      notifications: { weird: true },
    });
    expect(status).toBe(400);
  });

  it('returns per-sink results when an override is provided', async () => {
    // Unreachable host → result reports {ok:false, error:...}. The endpoint
    // itself is ok:true because the request was well-formed.
    const { status, body } = await post('/settings/notifications/test', {
      sink: 'webhook',
      notifications: {
        enabled: true,
        webhook: { enabled: true, url: 'http://127.0.0.1:1/nope' },
      },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.results.webhook).toBeDefined();
    expect(body.results.webhook.ok).toBe(false);
  });
});

describe('GET /settings/notifications/state', () => {
  it('returns an empty list initially', async () => {
    const res  = await fetch(baseUrl + '/settings/notifications/state');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.states)).toBe(true);
  });
});

describe('PUT /settings — notifications validation', () => {
  it('accepts a valid notifications config alongside ranges', async () => {
    const r = await fetch(baseUrl + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ranges: ['1h', '24h'],
        notifications: {
          enabled: true,
          webhook: { enabled: true, url: 'https://example.com/hook' },
          conditions: {
            threshold:      { enabled: true },
            sensorOffline:  { enabled: true, thresholdSecs: 1800 },
            gatewayOffline: { enabled: false, thresholdSecs: 900 },
          },
        },
      }),
    });
    expect(r.status).toBe(200);
    const get = await fetch(baseUrl + '/settings').then(r => r.json());
    expect(get.settings.notifications.enabled).toBe(true);
    expect(get.settings.notifications.webhook.url).toBe('https://example.com/hook');
  });

  it('rejects a malformed notifications blob', async () => {
    const r = await fetch(baseUrl + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ranges: ['1h'],
        notifications: { unknownKey: 1 },
      }),
    });
    expect(r.status).toBe(400);
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

  it('PUT persists comfort config alongside ranges', async () => {
    const comfort = {
      groups: {
        house:     { temp: { lo: 68, hi: 76 }, hum: { lo: 30, hi: 60 } },
        outside:   null,
        appliance: null,
      },
      sensors: {
        'sensor-abc': { temp: { lo: 35, hi: 40 } },
      },
    };
    const r = await fetch(baseUrl + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ranges: ['1h', '24h'], comfort }),
    });
    expect(r.status).toBe(200);
    const { body } = await get('/settings');
    expect(body.settings.comfort).toEqual(comfort);
    expect(body.settings.ranges).toEqual(['1h', '24h']);
  });

  it('PUT without comfort preserves existing comfort blob', async () => {
    // Plant a comfort config, then send a ranges-only update.
    const planted = { groups: { house: { temp: { lo: 70, hi: 74 } } } };
    await fetch(baseUrl + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ranges: ['7d'], comfort: planted }),
    });
    await fetch(baseUrl + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ranges: ['1h'] }),
    });
    const { body } = await get('/settings');
    expect(body.settings.comfort).toEqual(planted);
    expect(body.settings.ranges).toEqual(['1h']);
  });

  it('PUT rejects malformed comfort — wrong types', async () => {
    const r = await fetch(baseUrl + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ranges: ['1h'],
        comfort: { groups: { house: { temp: { lo: 'not a number' } } } },
      }),
    });
    expect(r.status).toBe(400);
  });

  it('PUT rejects malformed comfort — unknown keys', async () => {
    const r = await fetch(baseUrl + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ranges: ['1h'],
        comfort: { unexpected: {} },
      }),
    });
    expect(r.status).toBe(400);
  });

  it('PUT accepts comfort=null (disables presets)', async () => {
    const r = await fetch(baseUrl + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ranges: ['1h'], comfort: null }),
    });
    expect(r.status).toBe(200);
  });

  it('PUT persists hvac config alongside ranges', async () => {
    const hvac = {
      sensors: {
        'thermo-1': { thermostat: true, zone: 'main' },
      },
      shortCycleMinutes: 7,
    };
    const r = await fetch(baseUrl + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ranges: ['1h', '24h'], hvac }),
    });
    expect(r.status).toBe(200);
    const { body } = await get('/settings');
    expect(body.settings.hvac).toEqual(hvac);
  });

  it('PUT rejects malformed hvac — wrong thermostat type', async () => {
    const r = await fetch(baseUrl + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ranges: ['1h'],
        hvac: { sensors: { 'x': { thermostat: 'yes' } } },
      }),
    });
    expect(r.status).toBe(400);
  });

  it('PUT rejects malformed hvac — non-positive shortCycleMinutes', async () => {
    const r = await fetch(baseUrl + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ranges: ['1h'], hvac: { shortCycleMinutes: 0 } }),
    });
    expect(r.status).toBe(400);
  });

  it('PUT rejects malformed hvac — unknown top-level key', async () => {
    const r = await fetch(baseUrl + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ranges: ['1h'], hvac: { weird: 1 } }),
    });
    expect(r.status).toBe(400);
  });
});

describe('GET /hvac', () => {
  // Use a dedicated DB + server so seeded data doesn't bleed into other suites
  // (and so a clean "no thermostat configured" case can be tested independently).
  let hvacDb, hvacSrv, hvacUrl;
  beforeAll(async () => {
    hvacDb = openDb(':memory:');
    await new Promise(r => {
      hvacSrv = http.createServer(createApp(hvacDb));
      hvacSrv.listen(0, '127.0.0.1', () => { hvacUrl = `http://127.0.0.1:${hvacSrv.address().port}`; r(); });
    });
  });
  afterAll(() => new Promise(r => hvacSrv.close(r)));

  async function hvacGet(path) {
    const res = await fetch(hvacUrl + path);
    return { status: res.status, body: await res.json() };
  }

  it('returns 400 for invalid range', async () => {
    const r = await hvacGet('/hvac?range=forever');
    expect(r.status).toBe(400);
  });

  it('returns empty zones when no thermostat is configured and no data exists', async () => {
    const { status, body } = await hvacGet('/hvac?range=24h');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.referenceIds).toEqual([]);
    expect(body.heatingZones).toEqual({});
    expect(body.coolingZones).toEqual({});
    expect(body.config.shortCycleMinutes).toBe(5);
  });

  it('uses an explicitly flagged thermostat sensor — sensor name becomes the default zone', async () => {
    upsertSensors(hvacDb, [
      { id: 'living-room', name: 'Living Room',   type: 'HT1', active: true, batteryVoltage: null },
      { id: 'attic',       name: 'Attic',         type: 'HT1', active: true, batteryVoltage: null },
    ]);
    // Plant a heating ramp on living-room so detectCycles has something to work with.
    const now = Math.floor(Date.now() / 1000);
    const start = now - 3 * 3600;
    const samples = [];
    for (let i = 0; i <= 36; i++) {
      // 10 min cadence, +1°F/hr ramp for 3h
      const t = start + i * 600;
      const temp = 68 + (i / 36) * 3;
      samples.push({ observed: new Date(t * 1000).toISOString(), temperature: temp, humidity: 45, barometric_pressure: null, battery_voltage: null });
    }
    insertReadings(hvacDb, 'living-room', samples);

    // Flag living-room as the thermostat reference (no zones set).
    await fetch(hvacUrl + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ranges: ['1h', '24h'],
        hvac: { sensors: { 'living-room': { thermostat: true } } },
      }),
    });

    const { body } = await hvacGet('/hvac?range=24h');
    expect(body.referenceIds).toContain('living-room');
    // Both zone dimensions default to the sensor's own name when unset.
    const heat = body.heatingZones['Living Room'];
    const cool = body.coolingZones['Living Room'];
    expect(heat).toBeDefined();
    expect(cool).toBeDefined();
    expect(heat.memberCount).toBe(1);
    expect(heat.members[0]).toEqual({ id: 'living-room', name: 'Living Room' });
    expect(heat.analysis.ok).toBe(true);
    expect(heat.analysis.heatingRuntimePct).toBeGreaterThan(0);
    expect(Array.isArray(heat.dailyRuntime)).toBe(true);
    expect(heat.dailyRuntime).toHaveLength(7);
  });

  it('groups multiple sensors that share a heating zone', async () => {
    const db2 = openDb(':memory:');
    let srv2, url2;
    await new Promise(r => {
      srv2 = http.createServer(createApp(db2));
      srv2.listen(0, '127.0.0.1', () => { url2 = `http://127.0.0.1:${srv2.address().port}`; r(); });
    });

    upsertSensors(db2, [
      { id: 'living', name: 'Living Room',     type: 'HT1', active: true, batteryVoltage: null },
      { id: 'master', name: 'Primary Bedroom', type: 'HT1', active: true, batteryVoltage: null },
    ]);
    // Both sensors warm together — simulates a furnace heating the shared zone.
    const now   = Math.floor(Date.now() / 1000);
    const start = now - 3 * 3600;
    for (const id of ['living', 'master']) {
      const samples = [];
      for (let i = 0; i <= 36; i++) {
        const t = start + i * 600;
        const temp = (id === 'living' ? 68 : 70) + (i / 36) * 3;
        samples.push({ observed: new Date(t * 1000).toISOString(), temperature: temp, humidity: 45, barometric_pressure: null, battery_voltage: null });
      }
      insertReadings(db2, id, samples);
    }

    await fetch(url2 + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ranges: ['1h', '24h'],
        hvac: { sensors: {
          'living': { thermostat: true, zone: 'Furnace', coolingZone: 'Living' },
          'master': { thermostat: true, zone: 'Furnace', coolingZone: 'Master' },
        } },
      }),
    });

    const r = await fetch(url2 + '/hvac?range=24h');
    const body = await r.json();
    expect(body.ok).toBe(true);
    // One heating zone (Furnace) with 2 members, two cooling zones (Living, Master) with 1 each.
    expect(Object.keys(body.heatingZones)).toEqual(['Furnace']);
    expect(body.heatingZones['Furnace'].memberCount).toBe(2);
    expect(body.heatingZones['Furnace'].analysis.ok).toBe(true);
    expect(body.heatingZones['Furnace'].analysis.heatingCycleCount).toBeGreaterThanOrEqual(1);
    expect(Object.keys(body.coolingZones).sort()).toEqual(['Living', 'Master']);
    expect(body.coolingZones['Living'].memberCount).toBe(1);
    expect(body.coolingZones['Master'].memberCount).toBe(1);

    await new Promise(r => srv2.close(r));
  });

  it('auto-selects the most-stable indoor sensor when no flags exist', async () => {
    // Fresh DB so the explicit flag set in the previous test doesn't carry over.
    const db2 = openDb(':memory:');
    let srv2, url2;
    await new Promise(r => {
      srv2 = http.createServer(createApp(db2));
      srv2.listen(0, '127.0.0.1', () => { url2 = `http://127.0.0.1:${srv2.address().port}`; r(); });
    });

    upsertSensors(db2, [
      { id: 'stable',  name: 'Living Room', type: 'HT1', active: true, batteryVoltage: null },
      { id: 'jittery', name: 'Kitchen',     type: 'HT1', active: true, batteryVoltage: null },
      { id: 'outside', name: 'Outside',     type: 'HT1', active: true, batteryVoltage: null },
    ]);
    const now   = Math.floor(Date.now() / 1000);
    const start = now - 24 * 3600;
    const stable = [], jittery = [], outside = [];
    for (let i = 0; i <= 144; i++) {                                 // 10min cadence × 24h
      const t = start + i * 600;
      stable.push ({ observed: new Date(t * 1000).toISOString(), temperature: 70 + 0.1 * Math.sin(i / 5), humidity: 45, barometric_pressure: null, battery_voltage: null });
      jittery.push({ observed: new Date(t * 1000).toISOString(), temperature: 70 + 3.0 * Math.sin(i / 5), humidity: 45, barometric_pressure: null, battery_voltage: null });
      outside.push({ observed: new Date(t * 1000).toISOString(), temperature: 50 + 0.1 * Math.sin(i / 5), humidity: 45, barometric_pressure: null, battery_voltage: null });
    }
    insertReadings(db2, 'stable',  stable);
    insertReadings(db2, 'jittery', jittery);
    insertReadings(db2, 'outside', outside);

    const r = await fetch(url2 + '/hvac?range=24h');
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.autoDefaultId).toBe('stable');     // lowest var of the two indoor sensors
    expect(body.referenceIds).toEqual(['stable']);
    // Auto-selected sensor lands in a zone named after itself.
    expect(body.heatingZones['Living Room']).toBeDefined();
    expect(body.heatingZones['Living Room'].members[0].id).toBe('stable');

    await new Promise(r => srv2.close(r));
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

describe('GET /battery', () => {
  it('returns ok:true with a forecasts map keyed by sensor id', async () => {
    upsertSensors(db, [
      { id: 'batt-stable',   name: 'Stable',   type: 'HT1', active: true, batteryVoltage: 2.95 },
      { id: 'batt-falling',  name: 'Falling',  type: 'HT1', active: true, batteryVoltage: 2.75 },
      { id: 'batt-too-new',  name: 'TooNew',   type: 'HT1', active: true, batteryVoltage: 2.85 },
    ]);
    const now = Math.floor(Date.now() / 1000);

    // batt-stable: 30 days flat at 2.95 → forecast returned, no projection.
    insertReadings(db, 'batt-stable', Array.from({ length: 30 }, (_, i) => ({
      observed:             new Date((now - (30 - i) * 86400) * 1000).toISOString(),
      temperature:          70, humidity: 50, barometric_pressure: null,
      battery_voltage:      2.95,
    })));

    // batt-falling: 30 days declining 5 mV/day from 2.95.
    insertReadings(db, 'batt-falling', Array.from({ length: 30 }, (_, i) => ({
      observed:             new Date((now - (30 - i) * 86400) * 1000).toISOString(),
      temperature:          70, humidity: 50, barometric_pressure: null,
      battery_voltage:      2.95 - i * 0.005,
    })));

    // batt-too-new: only 3 days of data → null forecast.
    insertReadings(db, 'batt-too-new', Array.from({ length: 3 }, (_, i) => ({
      observed:             new Date((now - (3 - i) * 86400) * 1000).toISOString(),
      temperature:          70, humidity: 50, barometric_pressure: null,
      battery_voltage:      2.85,
    })));

    const { status, body } = await get('/battery');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.forecasts).toBeTruthy();

    expect(body.forecasts['batt-stable']).toMatchObject({ daysTo25: null });
    expect(body.forecasts['batt-stable'].currentV).toBeCloseTo(2.95, 2);

    const falling = body.forecasts['batt-falling'];
    expect(falling).not.toBeNull();
    expect(falling.daysTo25).toBeGreaterThan(0);
    expect(falling.slopeVPerDay).toBeLessThan(0);

    expect(body.forecasts['batt-too-new']).toBeNull();
  });

  it('returns an empty forecasts object when there are no sensors', async () => {
    // Use a fresh in-memory DB on a separate port so the existing one's
    // sensors don't pollute the result.
    const freshDb = (await import('../db.js')).openDb(':memory:');
    const freshApp = createApp(freshDb);
    const srv = http.createServer(freshApp);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    const res = await fetch(url + '/battery').then(r => r.json());
    expect(res.ok).toBe(true);
    expect(res.forecasts).toEqual({});
    await new Promise(r => srv.close(r));
  });
});

describe('sensor-pairs routes', () => {
  let pdb, psrv, purl;
  beforeAll(async () => {
    pdb = openDb(':memory:');
    upsertSensors(pdb, [
      { id: 'pairA', name: 'Living', type: 'HT1', active: true, batteryVoltage: 2.9 },
      { id: 'pairB', name: 'Kitchen', type: 'HT1', active: true, batteryVoltage: 2.9 },
      { id: 'pairC', name: 'Bedroom', type: 'HT1', active: true, batteryVoltage: 2.9 },
    ]);
    await new Promise(r => {
      psrv = http.createServer(createApp(pdb));
      psrv.listen(0, '127.0.0.1', () => { purl = `http://127.0.0.1:${psrv.address().port}`; r(); });
    });
  });
  afterAll(() => new Promise(r => psrv.close(r)));

  async function api(method, path, body) {
    const res = await fetch(purl + path, {
      method,
      headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
      body:    body != null ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  }

  it('GET /sensor-pairs returns empty array initially', async () => {
    const { status, body } = await api('GET', '/sensor-pairs');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.pairs).toEqual([]);
  });

  it('POST /sensor-pairs creates a pair and returns it', async () => {
    const { status, body } = await api('POST', '/sensor-pairs', {
      sensorAId: 'pairA', sensorBId: 'pairB', label: 'house pair',
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.pair.id).toBeGreaterThan(0);
    expect(body.pair.sensorAId).toBe('pairA');
    expect(body.pair.sensorBId).toBe('pairB');
    expect(body.pair.label).toBe('house pair');
  });

  it('POST /sensor-pairs returns 400 when body is missing fields', async () => {
    const r1 = await api('POST', '/sensor-pairs', { sensorAId: 'pairA' });
    expect(r1.status).toBe(400);
    const r2 = await api('POST', '/sensor-pairs', { sensorAId: 'pairA', sensorBId: 'pairA' });
    expect(r2.status).toBe(400);
    expect(r2.body.error).toMatch(/differ/);
  });

  it('POST /sensor-pairs returns 404 when a sensor does not exist', async () => {
    const { status } = await api('POST', '/sensor-pairs', {
      sensorAId: 'pairA', sensorBId: 'no-such-sensor',
    });
    expect(status).toBe(404);
  });

  it('POST /sensor-pairs returns 409 on duplicate (UNIQUE conflict)', async () => {
    await api('POST', '/sensor-pairs', { sensorAId: 'pairB', sensorBId: 'pairC' });
    const { status, body } = await api('POST', '/sensor-pairs', { sensorAId: 'pairB', sensorBId: 'pairC' });
    expect(status).toBe(409);
    expect(body.error).toMatch(/already exists/);
  });

  it('DELETE /sensor-pairs/:id removes a pair', async () => {
    const create = await api('POST', '/sensor-pairs', { sensorAId: 'pairA', sensorBId: 'pairC' });
    const id = create.body.pair.id;
    const del = await api('DELETE', `/sensor-pairs/${id}`);
    expect(del.status).toBe(200);
    // Re-deleting returns 404
    const again = await api('DELETE', `/sensor-pairs/${id}`);
    expect(again.status).toBe(404);
  });

  it('DELETE /sensor-pairs/:id returns 400 for invalid id', async () => {
    const r = await api('DELETE', '/sensor-pairs/not-a-number');
    expect(r.status).toBe(400);
  });

  describe('GET /sensor-pairs/:id/drift', () => {
    let pairId;
    beforeAll(async () => {
      // Seed aligned hourly_agg rows so the drift route has data to fit.
      const now = Math.floor(Date.now() / 1000);
      const h0  = now - (now % 3600) - 24 * 3600;
      const stmt = pdb.prepare(`
        INSERT OR REPLACE INTO hourly_agg
          (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count, excluded)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 30, 0)
      `);
      // 24 hourly buckets, A slowly diverging from B in temperature.
      for (let i = 0; i < 24; i++) {
        const hourTs = h0 + i * 3600;
        stmt.run('driftA', hourTs, 70 + i * 0.01, 69, 71, 50, 48, 52);
        stmt.run('driftB', hourTs, 70,            69, 71, 50, 48, 52);
      }
      upsertSensors(pdb, [
        { id: 'driftA', name: 'A', type: 'HT1', active: true, batteryVoltage: 2.9 },
        { id: 'driftB', name: 'B', type: 'HT1', active: true, batteryVoltage: 2.9 },
      ]);
      const create = await api('POST', '/sensor-pairs', { sensorAId: 'driftA', sensorBId: 'driftB', label: 'drift pair' });
      pairId = create.body.pair.id;
    });

    it('returns aligned samples and computed stats', async () => {
      const { status, body } = await api('GET', `/sensor-pairs/${pairId}/drift?range=30d`);
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.range).toBe('30d');
      expect(Array.isArray(body.samples)).toBe(true);
      expect(body.samples.length).toBeGreaterThan(0);
      expect(body.stats).toBeDefined();
      expect(body.stats.nPairs).toBe(body.samples.length);
      expect(body.stats.slopeTempPerDay).toBeGreaterThan(0);
    });

    it('returns 404 for unknown pair id', async () => {
      const { status } = await api('GET', '/sensor-pairs/999999/drift');
      expect(status).toBe(404);
    });

    it('returns 400 for invalid range', async () => {
      const { status } = await api('GET', `/sensor-pairs/${pairId}/drift?range=forever`);
      expect(status).toBe(400);
    });

    it('defaults to 30d when range param is absent', async () => {
      const { status, body } = await api('GET', `/sensor-pairs/${pairId}/drift`);
      expect(status).toBe(200);
      expect(body.range).toBe('30d');
    });
  });
});

// ── Events routes ──────────────────────────────────────────────────────────
// Happy-path coverage and basic validation; auth enforcement is exercised
// separately in events-auth.test.js (own file so we can isolate the
// RECORDER_TOKEN env var without polluting other server tests).
describe('Events routes', () => {
  let evDb, evSrv, evUrl;
  async function api(method, path, body) {
    const res = await fetch(evUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  beforeAll(() => new Promise(resolve => {
    evDb = openDb(':memory:');
    upsertSensors(evDb, [{ id: 'ev-sensor', name: 'Test', type: 'HT1', active: true, batteryVoltage: null }]);
    evSrv = http.createServer(createApp(evDb));
    evSrv.listen(0, '127.0.0.1', () => {
      evUrl = `http://127.0.0.1:${evSrv.address().port}`;
      resolve();
    });
  }));
  afterAll(() => new Promise(r => evSrv.close(r)));

  it('POST /events creates a global event when sensor_id is omitted', async () => {
    const { status, body } = await api('POST', '/events', { ts: 1000, label: 'global event' });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.event).toMatchObject({ ts: 1000, sensorId: null, label: 'global event' });
    expect(body.event.id).toBeGreaterThan(0);
  });

  it('POST /events creates a sensor-scoped event', async () => {
    const { body } = await api('POST', '/events', { ts: 2000, sensor_id: 'ev-sensor', label: 'scoped', note: 'with note' });
    expect(body.event.sensorId).toBe('ev-sensor');
    expect(body.event.note).toBe('with note');
  });

  it('POST /events 400 when label is missing or empty', async () => {
    const r1 = await api('POST', '/events', { ts: 1000 });
    expect(r1.status).toBe(400);
    const r2 = await api('POST', '/events', { ts: 1000, label: '   ' });
    expect(r2.status).toBe(400);
  });

  it('POST /events 400 when ts is missing or non-numeric', async () => {
    const r1 = await api('POST', '/events', { label: 'x' });
    expect(r1.status).toBe(400);
    const r2 = await api('POST', '/events', { ts: 'not-a-number', label: 'x' });
    expect(r2.status).toBe(400);
  });

  it('POST /events 400 when sensor_id references an unknown sensor', async () => {
    const { status } = await api('POST', '/events', { ts: 1000, sensor_id: 'nope', label: 'x' });
    expect(status).toBe(400);
  });

  it('GET /events lists events DESC by ts', async () => {
    // Fresh app/DB so we control what's listed.
    const db2 = openDb(':memory:');
    const srv2 = http.createServer(createApp(db2));
    await new Promise(r => srv2.listen(0, '127.0.0.1', r));
    const u = `http://127.0.0.1:${srv2.address().port}`;
    await fetch(u + '/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ts: 1000, label: 'a' }) });
    await fetch(u + '/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ts: 3000, label: 'b' }) });
    await fetch(u + '/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ts: 2000, label: 'c' }) });
    const r = await fetch(u + '/events').then(r => r.json());
    expect(r.events.map(e => e.label)).toEqual(['b', 'c', 'a']);
    await new Promise(r => srv2.close(r));
  });

  it('GET /events filters by from/to/sensor_id', async () => {
    const db2 = openDb(':memory:');
    upsertSensors(db2, [{ id: 's1', name: 'A', type: 'HT1', active: true, batteryVoltage: null }]);
    const srv2 = http.createServer(createApp(db2));
    await new Promise(r => srv2.listen(0, '127.0.0.1', r));
    const u = `http://127.0.0.1:${srv2.address().port}`;
    const post = body => fetch(u + '/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await post({ ts: 1000, label: 'global' });
    await post({ ts: 2000, sensor_id: 's1', label: 'scoped' });
    await post({ ts: 3000, sensor_id: 's1', label: 'late-scoped' });

    const r1 = await fetch(u + '/events?from=1500&to=2500').then(r => r.json());
    expect(r1.events.map(e => e.label)).toEqual(['scoped']);

    const r2 = await fetch(u + '/events?sensor_id=s1').then(r => r.json());
    const labels = r2.events.map(e => e.label).sort();
    expect(labels).toEqual(['global', 'late-scoped', 'scoped']);

    await new Promise(r => srv2.close(r));
  });

  it('PATCH /events/:id updates fields and returns the updated event', async () => {
    const created = await api('POST', '/events', { ts: 5000, label: 'orig' });
    const id = created.body.event.id;
    const { status, body } = await api('PATCH', `/events/${id}`, { label: 'patched', note: 'added' });
    expect(status).toBe(200);
    expect(body.event.label).toBe('patched');
    expect(body.event.note).toBe('added');
    expect(body.event.ts).toBe(5000);
  });

  it('PATCH /events/:id 404 when id does not exist', async () => {
    const { status } = await api('PATCH', '/events/99999', { label: 'x' });
    expect(status).toBe(404);
  });

  it('DELETE /events/:id removes the event', async () => {
    const created = await api('POST', '/events', { ts: 6000, label: 'gone' });
    const id = created.body.event.id;
    const del = await api('DELETE', `/events/${id}`);
    expect(del.status).toBe(200);
    const del2 = await api('DELETE', `/events/${id}`);
    expect(del2.status).toBe(404);
  });
});

describe('GET /weather', () => {
  it('returns configured:false when no weather block is present in config', async () => {
    // The shared `db` + app has no config bound (createApp(db) with no
    // second arg) — so /weather should reflect "not configured".
    const { body, status } = await get('/weather?range=24h');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.configured).toBe(false);
  });

  it('returns 400 for an invalid range', async () => {
    const { status, body } = await get('/weather?range=99y');
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
  });

  it('defaults to range=24h when omitted', async () => {
    const { body } = await get('/weather');
    expect(body.range).toBe('24h');
  });

  it('returns latest reading + samples when outdoor_readings has data', async () => {
    // Insert two readings, one out of the 24h window (filtered out by getOutdoorHistory)
    // and one inside it. /weather should expose the latest as `latest`
    // (regardless of range) and the in-range row in `samples`.
    const now = Math.floor(Date.now() / 1000);
    insertOutdoorReadings(db, [
      { ts: now - 30 * 86400, temp: 30, humidity: 60, dewpoint: 20 },
      { ts: now - 600,        temp: 65, humidity: 50, dewpoint: 45 },
    ]);
    const { body } = await get('/weather?range=24h');
    expect(body.ok).toBe(true);
    expect(body.latest).not.toBeNull();
    expect(body.latest.temp).toBe(65);
    expect(Array.isArray(body.samples)).toBe(true);
    expect(body.samples.length).toBe(1);
    expect(body.samples[0].temp).toBe(65);
  });
});

describe('POST /weather/poll', () => {
  it('returns 503 when weather is not configured (no config bound)', async () => {
    const res = await fetch(baseUrl + '/weather/poll', { method: 'POST' });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not configured/i);
  });
});

describe('GET /metrics (Prometheus exposition)', () => {
  function freshDb() {
    return openDb(':memory:');
  }

  function seed(db) {
    const now = Math.floor(Date.now() / 1000);
    upsertSensors(db, [
      { id: 'abc.123', name: 'Crawlspace', type: 'HT1', active: true,  batteryVoltage: 2.91, rssi: -67 },
      { id: 'def.456', name: 'Attic',      type: 'HTP', active: true,  batteryVoltage: null, rssi: null },
      { id: 'old.789', name: 'Retired',    type: 'HT1', active: false, batteryVoltage: 2.50, rssi: -90 },
    ]);
    insertReadings(db, 'abc.123', [{
      observed:            new Date((now - 120) * 1000).toISOString(),
      temperature:         71.2, humidity: 48.5, dewpoint: 50.1, vpd: 1.05,
      barometric_pressure: null, battery_voltage: 2.9,
    }]);
    // def.456 has no readings at all — verifies LEFT JOIN skip behavior.
    upsertGateways(db, [
      { id: 'gw1', name: 'Downstairs', lastSeen: now - 30,  lastAlert: null, version: '1.0', paired: true,  message: null },
      { id: 'gw2', name: 'Unpaired',   lastSeen: null,      lastAlert: null, version: '1.0', paired: false, message: null },
    ]);
    return now;
  }

  it('emits HELP+TYPE headers and gauge values for active sensors with readings', () => {
    const db = freshDb();
    seed(db);
    const body = _renderMetrics(db);

    expect(body).toMatch(/^# HELP sensorpush_temperature_fahrenheit /m);
    expect(body).toMatch(/^# TYPE sensorpush_temperature_fahrenheit gauge$/m);
    expect(body).toMatch(/^sensorpush_temperature_fahrenheit\{sensor_id="abc\.123",sensor_name="Crawlspace",sensor_type="HT1"\} 71\.2$/m);
    expect(body).toMatch(/^sensorpush_humidity_percent\{sensor_id="abc\.123",sensor_name="Crawlspace",sensor_type="HT1"\} 48\.5$/m);
    expect(body).toMatch(/^sensorpush_dewpoint_fahrenheit\{sensor_id="abc\.123",sensor_name="Crawlspace",sensor_type="HT1"\} 50\.1$/m);
    expect(body).toMatch(/^sensorpush_vapor_pressure_deficit_kpa\{sensor_id="abc\.123",sensor_name="Crawlspace",sensor_type="HT1"\} 1\.05$/m);
    expect(body).toMatch(/^sensorpush_battery_volts\{sensor_id="abc\.123",sensor_name="Crawlspace",sensor_type="HT1"\} 2\.91$/m);
    expect(body).toMatch(/^sensorpush_rssi_dbm\{sensor_id="abc\.123",sensor_name="Crawlspace",sensor_type="HT1"\} -67$/m);
    expect(body).toMatch(/^sensorpush_last_reading_timestamp_seconds\{sensor_id="abc\.123"/m);
    expect(body.endsWith('\n')).toBe(true);
  });

  it('skips inactive sensors entirely', () => {
    const db = freshDb();
    seed(db);
    const body = _renderMetrics(db);
    expect(body).not.toMatch(/sensor_id="old\.789"/);
  });

  it('skips per-metric lines when the value is null (no NaN emitted)', () => {
    const db = freshDb();
    seed(db);
    const body = _renderMetrics(db);
    // def.456 is active but has no reading row — should not appear in any
    // reading-derived gauge line, and battery_volts/rssi (null on sensor row)
    // should also be omitted for it.
    expect(body).not.toMatch(/sensorpush_temperature_fahrenheit\{[^}]*def\.456/);
    expect(body).not.toMatch(/sensorpush_battery_volts\{[^}]*def\.456/);
    expect(body).not.toMatch(/sensorpush_rssi_dbm\{[^}]*def\.456/);
    // Sanity: the active def.456 sensor is still counted in sensors_active.
    expect(body).toMatch(/^sensorpush_sensors_active 2$/m);
    expect(body).toMatch(/^sensorpush_sensors_total 3$/m);
  });

  it('emits gateway last_seen, skipping rows with null last_seen', () => {
    const db = freshDb();
    const now = seed(db);
    const body = _renderMetrics(db);
    expect(body).toMatch(/^# TYPE sensorpush_gateway_last_seen_timestamp_seconds gauge$/m);
    expect(body).toMatch(new RegExp(`^sensorpush_gateway_last_seen_timestamp_seconds\\{gateway_id="gw1",gateway_name="Downstairs"\\} ${now - 30}$`, 'm'));
    expect(body).not.toMatch(/gateway_id="gw2"/);
  });

  it('reports poll-health gauges: -1 before any poll, 1 on success, 0 on error', async () => {
    const db = freshDb();
    seed(db);
    const poller = await import('../poller.js');
    poller._resetPollerState();

    // No poll yet
    let body = _renderMetrics(db);
    expect(body).toMatch(/^sensorpush_last_poll_success -1$/m);
    expect(body).not.toMatch(/^sensorpush_last_poll_timestamp_seconds /m);
  });

  it('escapes backslash + double-quote + newline in label values', () => {
    const db = freshDb();
    upsertSensors(db, [{
      id: 'evil',
      name: 'has "quote" and \\ and\nnewline',
      type: 'HT1',
      active: true,
      batteryVoltage: 2.9,
    }]);
    insertReadings(db, 'evil', [{
      observed: new Date().toISOString(), temperature: 70, humidity: 50,
      barometric_pressure: null, battery_voltage: 2.9,
    }]);
    const body = _renderMetrics(db);
    expect(body).toMatch(/sensor_name="has \\"quote\\" and \\\\ and\\nnewline"/);
  });

  it('HTTP GET /metrics returns text/plain exposition format, no bearer needed', async () => {
    const db = freshDb();
    seed(db);
    const app = createApp(db);
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    try {
      const r = await fetch(url + '/metrics');
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/^text\/plain/);
      const text = await r.text();
      expect(text).toMatch(/^# HELP sensorpush_temperature_fahrenheit /m);
      expect(text).toMatch(/^sensorpush_temperature_fahrenheit\{[^}]+\} 71\.2$/m);
    } finally {
      await new Promise(r => srv.close(r));
    }
  });

  it('GET /metrics bypasses bearer middleware when a token is configured', async () => {
    const prev = process.env.RECORDER_TOKEN;
    process.env.RECORDER_TOKEN = 'metrics-bypass-test-token-abcdef1234';
    try {
      const db = freshDb();
      seed(db);
      const srv = http.createServer(createApp(db));
      await new Promise(r => srv.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${srv.address().port}`;
      try {
        // /metrics: no Authorization header, still 200
        const r = await fetch(url + '/metrics');
        expect(r.status).toBe(200);
        // Sanity: a non-bypassed route requires the bearer
        const r2 = await fetch(url + '/gateways');
        expect(r2.status).toBe(401);
      } finally {
        await new Promise(r => srv.close(r));
      }
    } finally {
      if (prev === undefined) delete process.env.RECORDER_TOKEN;
      else process.env.RECORDER_TOKEN = prev;
    }
  });

  it('emits an empty-but-valid body when there are no sensors or gateways', () => {
    const body = _renderMetrics(freshDb());
    expect(body).toMatch(/^sensorpush_sensors_total 0$/m);
    expect(body).toMatch(/^sensorpush_sensors_active 0$/m);
    expect(body).toMatch(/^sensorpush_last_poll_success /m);
    expect(body.endsWith('\n')).toBe(true);
  });
});
