// The mold alert: damp hours in a window on a sensor's coldest surface.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('node-fetch', () => ({ default: vi.fn() }));
import fetch from 'node-fetch';

import { openDb, upsertSensors, grainsPerLb, getNotifState } from '../db.js';
import { evaluateMold, runNotifications, validateNotifConfig } from '../notifications.js';

const NOW = Date.UTC(2026, 10, 2, 12, 30);
const NOW_SECS = Math.floor(NOW / 1000);
const HOUR = Math.floor(NOW / 3600000) * 3600;

const DAMP = 53; // dew point, °F: 83% on a 56°F surface
const DRY  = 45; // 66% on it

function makeDb(id = 'crawl', name = 'Crawl Space') {
  const db = openDb(':memory:');
  upsertSensors(db, [{ id, name, type: 'HT1', active: true, batteryVoltage: 2.9 }]);
  return db;
}

// `pattern(hoursAgo)` gives the hour's dew point, or null for no data.
function seed(db, id, pattern, { temp = 64, hours = 48, excluded = 0 } = {}) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO hourly_agg (sensor_id, hour_ts, temp_avg, hum_avg, dewpoint_avg, sample_count, excluded)
    VALUES (?, ?, ?, 60, ?, 12, ?)
  `);
  for (let ago = 0; ago < hours; ago++) {
    const dew = pattern(ago);
    if (dew != null) stmt.run(id, HOUR - ago * 3600, temp, dew, excluded);
  }
}

const sensor = (over = {}) => ({ id: 'crawl', name: 'Crawl Space', temperature: 64, humidity: 60, lastTs: NOW_SECS - 60, ...over });
const config = (mold = { enabled: true }) => ({
  enabled: true,
  webhook: { enabled: true, url: 'https://x/y' },
  conditions: { mold },
});
const SURFACE = { sensors: { crawl: { surfaceF: 56 } } };

function run(db, over = {}) {
  return runNotifications(db, {
    sensors: [sensor()],
    gateways: [],
    notifConfig: config(),
    comfort: SURFACE,
    nowMs: NOW,
    ...over,
  });
}
const moldResult = (results) => results.find(r => r.kind === 'mold');

beforeEach(() => {
  vi.clearAllMocks();
  fetch.mockResolvedValue({ ok: true, status: 200 });
});

describe('evaluateMold', () => {
  it('counts the hours at the limit on the cold surface', () => {
    const db = makeDb();
    seed(db, 'crawl', ago => ago < 30 ? DAMP : DRY);
    const m = evaluateMold(db, { id: 'crawl' }, { surfaceF: 56, nowMs: NOW });
    expect(m.hoursAbove).toBe(30);
  });

  it('puts the limit of a 56.3°F crawl space at a 50.2°F dew point', () => {
    const db = makeDb();
    const m = evaluateMold(db, { id: 'crawl' }, { surfaceF: 56.3, nowMs: NOW });
    expect(m.limitDewF).toBeCloseTo(50.2, 1);
    expect(grainsPerLb(m.limitDewF)).toBeCloseTo(53.7, 0);
  });

  it('judges the air when no surface is set', () => {
    const db = makeDb();
    seed(db, 'crawl', () => 60, { temp: 66 }); // 81% in the air
    expect(evaluateMold(db, { id: 'crawl' }, { nowMs: NOW }).hoursAbove).toBe(48);
    expect(evaluateMold(db, { id: 'crawl' }, { nowMs: NOW }).limitDewF).toBeNull();
  });

  it('calls the same air damp on a cold surface and fine in the room', () => {
    const db = makeDb();
    seed(db, 'crawl', () => DAMP, { temp: 72 });
    expect(evaluateMold(db, { id: 'crawl' }, { nowMs: NOW }).hoursAbove).toBe(0);
    expect(evaluateMold(db, { id: 'crawl' }, { surfaceF: 56, nowMs: NOW }).hoursAbove).toBe(48);
  });

  it('leaves out excluded hours and hours before the window', () => {
    const db = makeDb();
    seed(db, 'crawl', () => DAMP, { excluded: 1, hours: 10 });
    seed(db, 'crawl', ago => ago >= 48 ? DAMP : null, { hours: 72 });
    expect(evaluateMold(db, { id: 'crawl' }, { surfaceF: 56, nowMs: NOW }).hoursAbove).toBe(0);
  });

  it('works out the dew point for an hour that has none stored', () => {
    const db = makeDb();
    seed(db, 'crawl', () => DAMP, { hours: 1 });
    db.prepare('UPDATE hourly_agg SET dewpoint_avg = NULL, hum_avg = 90, temp_avg = 56').run();
    expect(evaluateMold(db, { id: 'crawl' }, { surfaceF: 56, nowMs: NOW }).hoursAbove).toBe(1);
  });
});

describe('the mold condition', () => {
  it('fires at 24 of 48 hours and not at 23', async () => {
    const short = makeDb();
    seed(short, 'crawl', ago => ago < 23 ? DAMP : DRY);
    expect(moldResult(await run(short)).transition).toBe('skip');

    const db = makeDb();
    seed(db, 'crawl', ago => ago < 24 ? DAMP : DRY);
    expect(moldResult(await run(db)).transition).toBe('fire');
  });

  it('fires on a space that dips below the limit every morning', async () => {
    const db = makeDb();
    seed(db, 'crawl', ago => ago % 8 === 0 ? DRY : DAMP); // never damp for 8 hours straight
    expect(moldResult(await run(db)).transition).toBe('fire');
  });

  it('names dew point and gr/lb, with RH only on the surface', async () => {
    const db = makeDb();
    seed(db, 'crawl', () => DAMP);
    const { payload } = moldResult(await run(db));
    expect(payload.title).toBe('[Mold risk] Crawl Space');
    expect(payload.message).toContain('48 of the last 48 h at 80% RH or above on its 56°F surface');
    expect(payload.message).toContain('Dew point now 53.0°F');
    expect(payload.message).toContain('Limit 49.9°F, 53.2 gr/lb');
    expect(payload.detail).toMatchObject({ sensorId: 'crawl', hoursAbove: 48, surfaceF: 56, rhPct: 80 });
  });

  it('says it judged the room air when no surface is set', async () => {
    const db = makeDb();
    seed(db, 'crawl', () => 60, { temp: 66 });
    const { payload } = moldResult(await run(db, { comfort: undefined }));
    expect(payload.message).toContain('in the room air');
    expect(payload.message).not.toContain('Limit');
  });

  it('buzzes once while it stays damp', async () => {
    const db = makeDb();
    seed(db, 'crawl', () => DAMP);
    await run(db);
    expect(moldResult(await run(db)).transition).toBe('skip');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('holds until half the hours, so a room at the limit doesn\'t flap', async () => {
    const db = makeDb();
    seed(db, 'crawl', ago => ago < 24 ? DAMP : DRY);
    await run(db);

    seed(db, 'crawl', ago => ago < 12 ? DAMP : DRY);
    expect(moldResult(await run(db)).transition).toBe('skip');
    expect(getNotifState(db, 'mold:crawl').active).toBeTruthy();

    seed(db, 'crawl', ago => ago < 11 ? DAMP : DRY);
    const { transition, payload } = moldResult(await run(db));
    expect(transition).toBe('recover');
    expect(payload.title).toBe('[Recovered] Crawl Space drying out');
  });

  it('neither fires nor recovers on a sensor that has gone quiet', async () => {
    const db = makeDb();
    seed(db, 'crawl', () => DAMP);
    await run(db);
    seed(db, 'crawl', ago => ago < 3 ? null : DRY);
    db.prepare('DELETE FROM hourly_agg WHERE hour_ts > ?').run(HOUR - 3 * 3600);

    const quiet = sensor({ lastTs: NOW_SECS - 3 * 3600 });
    expect(moldResult(await run(db, { sensors: [quiet] }))).toBeUndefined();
    expect(getNotifState(db, 'mold:crawl').active).toBeTruthy();
    expect(moldResult(await run(db, { sensors: [sensor({ lastTs: null })] }))).toBeUndefined();
  });

  it('scores house sensors only', async () => {
    const db = makeDb('o', 'Outdoor Patio');
    seed(db, 'o', () => 70);
    const r = await run(db, { sensors: [sensor({ id: 'o', name: 'Outdoor Patio' })] });
    expect(moldResult(r)).toBeUndefined();
  });

  it('honours a user rule that moves a sensor into the house', async () => {
    const db = makeDb('o', 'Glacier');
    seed(db, 'o', () => 70);
    const r = await run(db, {
      sensors: [sensor({ id: 'o', name: 'Glacier' })],
      groupRules: [{ match: 'glacier', group: 'house' }],
    });
    expect(moldResult(r).transition).toBe('fire');
  });

  it('uses the house group\'s surface when the sensor has none, and its own over that', async () => {
    const db = makeDb();
    seed(db, 'crawl', () => DAMP, { temp: 72 });
    const group = { groups: { house: { surfaceF: 56 } } };
    expect(moldResult(await run(db, { comfort: group })).payload.detail.surfaceF).toBe(56);

    const other = makeDb();
    seed(other, 'crawl', () => DAMP, { temp: 72 });
    const both = { groups: { house: { surfaceF: 56 } }, sensors: { crawl: { surfaceF: 40 } } };
    expect(moldResult(await run(other, { comfort: both })).payload.detail.surfaceF).toBe(40);
  });

  it('reads its own limit and hours', async () => {
    const db = makeDb();
    seed(db, 'crawl', ago => ago < 6 ? DRY : 40);
    const r = await run(db, { notifConfig: config({ enabled: true, rhPct: 60, hours: 6 }) });
    expect(moldResult(r).transition).toBe('fire');
  });

  it('stays off unless it is turned on', async () => {
    const db = makeDb();
    seed(db, 'crawl', () => DAMP);
    expect(moldResult(await run(db, { notifConfig: config({ enabled: false }) }))).toBeUndefined();
    const none = { enabled: true, webhook: config().webhook, conditions: {} };
    expect(moldResult(await run(db, { notifConfig: none }))).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('validating the setting', () => {
  const valid = (mold) => validateNotifConfig({ conditions: { mold } });

  it('takes a plain setting', () => {
    expect(valid({ enabled: true })).toBe(true);
    expect(valid({ enabled: true, rhPct: 80, hours: 24 })).toBe(true);
    expect(valid({ enabled: false, rhPct: null, hours: null })).toBe(true);
  });

  it('refuses a limit or window that makes no sense', () => {
    expect(valid({ enabled: true, rhPct: 49 })).toBe(false);
    expect(valid({ enabled: true, rhPct: 101 })).toBe(false);
    expect(valid({ enabled: true, hours: 0 })).toBe(false);
    expect(valid({ enabled: true, hours: 49 })).toBe(false);
    expect(valid({ enabled: true, thresholdSecs: 60 })).toBe(false);
  });
});
