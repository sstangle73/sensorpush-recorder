import { describe, it, expect, beforeEach } from 'vitest';
import {
  openDb, upsertSensors, getLatestTs, insertReadings,
  recomputeHourlyAgg, getSensors, getHistory, getHistoryAll,
  setReadingExcluded, setHourlyExcluded, setLastPollTime, getLastPollTime, getGaps,
  upsertGateways, recordGatewayStatus, getGateways, gatewayOnlineDuringWindow, pruneGatewayStatus,
  getSensorPrimaryGateway, getGatewayUptime, countSensorsByPrimaryGateway,
  getBatteryHistory, computeBatteryForecast, getOldestReadingTs, pruneReadingsOlderThan,
  listSensorPairs, getSensorPair, createSensorPair, deleteSensorPair, getPairAlignedHourly,
  createEvent, listEvents, getEventById, updateEvent, deleteEvent,
  insertOutdoorReadings, getLatestOutdoorTs, getOutdoorHistory, getLatestOutdoorReading,
} from '../db.js';

function makeDb() {
  return openDb(':memory:');
}

function makeSamples(sensorId, count, baseTs, interval = 300) {
  return Array.from({ length: count }, (_, i) => ({
    observed:             new Date((baseTs + i * interval) * 1000).toISOString(),
    temperature:          68 + i * 0.1,
    humidity:             50 + i * 0.05,
    barometric_pressure:  29.9 + i * 0.001,
    battery_voltage:      2.85,
  }));
}

describe('openDb', () => {
  it('initializes without error and creates all tables', () => {
    const db = makeDb();
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
    expect(tables).toContain('sensors');
    expect(tables).toContain('readings');
    expect(tables).toContain('hourly_agg');
    expect(tables).toContain('meta');
  });
});

describe('upsertSensors', () => {
  it('inserts new sensors', () => {
    const db = makeDb();
    upsertSensors(db, [{ id: 's1', name: 'Living Room', type: 'HT1', active: true, batteryVoltage: 2.85 }]);
    const rows = db.prepare('SELECT * FROM sensors').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Living Room');
  });

  it('updates existing sensor on conflict', () => {
    const db = makeDb();
    upsertSensors(db, [{ id: 's1', name: 'Old Name', type: 'HT1', active: true, batteryVoltage: 2.8 }]);
    upsertSensors(db, [{ id: 's1', name: 'New Name', type: 'HT1', active: true, batteryVoltage: 2.9 }]);
    const rows = db.prepare('SELECT * FROM sensors').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('New Name');
    expect(rows[0].battery_voltage).toBeCloseTo(2.9);
  });
});

describe('getLatestTs', () => {
  it('returns null for unknown sensor', () => {
    expect(getLatestTs(makeDb(), 'nope')).toBeNull();
  });

  it('returns max ts after inserts', () => {
    const db = makeDb();
    insertReadings(db, 's1', makeSamples('s1', 3, 1000));
    expect(getLatestTs(db, 's1')).toBe(1000 + 2 * 300);
  });

  it('ignores excluded readings — returns last non-excluded ts', () => {
    const db = makeDb();
    insertReadings(db, 's1', makeSamples('s1', 3, 1000)); // ts: 1000, 1300, 1600
    db.prepare('UPDATE readings SET excluded = 1 WHERE ts = 1600').run();
    expect(getLatestTs(db, 's1')).toBe(1300);
  });
});

describe('insertReadings', () => {
  it('inserts rows and returns inserted set', () => {
    const db = makeDb();
    const inserted = insertReadings(db, 's1', makeSamples('s1', 5, 2000));
    expect(inserted).toHaveLength(5);
    expect(db.prepare('SELECT COUNT(*) AS n FROM readings').get().n).toBe(5);
  });

  it('ignores duplicate (sensor_id, ts) — no error', () => {
    const db = makeDb();
    insertReadings(db, 's1', makeSamples('s1', 3, 2000));
    const second = insertReadings(db, 's1', makeSamples('s1', 3, 2000));
    expect(second).toHaveLength(0); // all ignored
    expect(db.prepare('SELECT COUNT(*) AS n FROM readings').get().n).toBe(3);
  });

  it('overlapping batch only inserts new rows', () => {
    const db = makeDb();
    insertReadings(db, 's1', makeSamples('s1', 3, 2000)); // ts 2000, 2300, 2600
    const inserted = insertReadings(db, 's1', makeSamples('s1', 3, 2300)); // ts 2300(dup), 2600(dup), 2900(new)
    expect(inserted).toHaveLength(1);
  });
});

describe('recomputeHourlyAgg', () => {
  it('computes correct AVG/MIN/MAX for an hour', () => {
    const db = makeDb();
    const hourTs = 3600; // 1970-01-01 01:00:00 UTC
    // 3 samples within this hour
    const samples = [
      { observed: new Date(3600000).toISOString(), temperature: 60, humidity: 40, barometric_pressure: 29.8, battery_voltage: 2.8 },
      { observed: new Date(3900000).toISOString(), temperature: 62, humidity: 42, barometric_pressure: 29.9, battery_voltage: 2.8 },
      { observed: new Date(4200000).toISOString(), temperature: 64, humidity: 44, barometric_pressure: 30.0, battery_voltage: 2.8 },
    ];
    insertReadings(db, 's1', samples);
    recomputeHourlyAgg(db, 's1', hourTs);

    const row = db.prepare('SELECT * FROM hourly_agg WHERE sensor_id=? AND hour_ts=?').get('s1', hourTs);
    expect(row).toBeTruthy();
    expect(row.temp_avg).toBeCloseTo(62);
    expect(row.temp_min).toBeCloseTo(60);
    expect(row.temp_max).toBeCloseTo(64);
    expect(row.hum_avg).toBeCloseTo(42);
    expect(row.sample_count).toBe(3);
  });

  it('updates aggregate when new readings arrive for the same hour', () => {
    const db = makeDb();
    const hourTs = 3600;
    insertReadings(db, 's1', [
      { observed: new Date(3600000).toISOString(), temperature: 60, humidity: 40, barometric_pressure: null, battery_voltage: null },
    ]);
    recomputeHourlyAgg(db, 's1', hourTs);
    expect(db.prepare('SELECT sample_count FROM hourly_agg WHERE sensor_id=?').get('s1').sample_count).toBe(1);

    insertReadings(db, 's1', [
      { observed: new Date(3900000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: null },
    ]);
    recomputeHourlyAgg(db, 's1', hourTs);
    const row = db.prepare('SELECT * FROM hourly_agg WHERE sensor_id=?').get('s1');
    expect(row.sample_count).toBe(2);
    expect(row.temp_avg).toBeCloseTo(65);
  });
});

describe('getSensors', () => {
  it('returns empty array when no sensors', () => {
    expect(getSensors(makeDb())).toEqual([]);
  });

  it('returns sensor with latest reading joined', () => {
    const db = makeDb();
    upsertSensors(db, [{ id: 's1', name: 'Room', type: 'HT1', active: true, batteryVoltage: 2.85 }]);
    insertReadings(db, 's1', makeSamples('s1', 2, 5000));

    const rows = getSensors(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('s1');
    expect(rows[0].last_ts).toBe(5300); // 5000 + 1*300 = most recent
    expect(rows[0].temperature).toBeCloseTo(68.1);
  });
});

describe('getHistory', () => {
  it('returns raw readings for 24h range', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    const samples = [
      { observed: new Date((now - 3600) * 1000).toISOString(), temperature: 68, humidity: 50, barometric_pressure: null, battery_voltage: null },
      { observed: new Date((now - 1800) * 1000).toISOString(), temperature: 69, humidity: 51, barometric_pressure: null, battery_voltage: null },
    ];
    upsertSensors(db, [{ id: 's1', name: 'R', type: 'HT1', active: true, batteryVoltage: null }]);
    insertReadings(db, 's1', samples);
    const rows = getHistory(db, 's1', '24h');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveProperty('ts');
    expect(rows[0]).toHaveProperty('temperature');
    expect(rows[0].tempMin).toBeNull();
  });

  it('returns hourly_agg rows for 7d range', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    const hourTs = now - 3600 - (now % 3600);
    upsertSensors(db, [{ id: 's1', name: 'R', type: 'HT1', active: true, batteryVoltage: null }]);
    db.prepare(`INSERT INTO hourly_agg (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count)
      VALUES ('s1', ?, 65, 63, 67, 48, 45, 51, null, 12)`).run(hourTs);
    const rows = getHistory(db, 's1', '7d');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toHaveProperty('tempMin');
    expect(rows[0].tempMin).toBeCloseTo(63);
  });
});

describe('getHistory — extended ranges', () => {
  it('returns hourly rows for 30d range', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    const hourTs = now - 3600 - (now % 3600);
    upsertSensors(db, [{ id: 's1', name: 'R', type: 'HT1', active: true, batteryVoltage: null }]);
    db.prepare(`INSERT INTO hourly_agg (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count, excluded)
      VALUES ('s1', ?, 65, 63, 67, 48, 45, 51, null, 12, 0)`).run(hourTs);
    const rows = getHistory(db, 's1', '30d');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toHaveProperty('tempMin');
  });

  it('returns hourly rows for 90d range', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    const hourTs = now - 3600 - (now % 3600);
    upsertSensors(db, [{ id: 's1', name: 'R', type: 'HT1', active: true, batteryVoltage: null }]);
    db.prepare(`INSERT INTO hourly_agg (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count, excluded)
      VALUES ('s1', ?, 72, 70, 74, 55, 52, 58, null, 10, 0)`).run(hourTs);
    const rows = getHistory(db, 's1', '90d');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].temperature).toBeCloseTo(72);
  });

  it('returns hourly rows for 365d range', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    const hourTs = now - 3600 - (now % 3600);
    upsertSensors(db, [{ id: 's1', name: 'R', type: 'HT1', active: true, batteryVoltage: null }]);
    db.prepare(`INSERT INTO hourly_agg (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count, excluded)
      VALUES ('s1', ?, 60, 58, 62, 45, 43, 47, null, 8, 0)`).run(hourTs);
    const rows = getHistory(db, 's1', '365d');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].temperature).toBeCloseTo(60);
  });

  it('filters out excluded hourly rows', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    const hour1 = now - 3600 - (now % 3600);
    const hour2 = hour1 - 3600;
    upsertSensors(db, [{ id: 's1', name: 'R', type: 'HT1', active: true, batteryVoltage: null }]);
    db.prepare(`INSERT INTO hourly_agg (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count, excluded)
      VALUES ('s1', ?, 65, 63, 67, 48, 45, 51, null, 12, 0)`).run(hour1);
    db.prepare(`INSERT INTO hourly_agg (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count, excluded)
      VALUES ('s1', ?, 999, 999, 999, 99, 99, 99, null, 1, 1)`).run(hour2); // excluded
    const rows = getHistory(db, 's1', '7d');
    expect(rows.every(r => r.temperature !== 999)).toBe(true);
  });

  it('filters out excluded raw readings for 24h', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    upsertSensors(db, [{ id: 's1', name: 'R', type: 'HT1', active: true, batteryVoltage: null }]);
    insertReadings(db, 's1', [
      { observed: new Date((now - 3600) * 1000).toISOString(), temperature: 68, humidity: 50, barometric_pressure: null, battery_voltage: null },
      { observed: new Date((now - 1800) * 1000).toISOString(), temperature: 999, humidity: 99, barometric_pressure: null, battery_voltage: null },
    ]);
    setReadingExcluded(db, 's1', now - 1800, true);
    const rows = getHistory(db, 's1', '24h');
    expect(rows.every(r => r.temperature !== 999)).toBe(true);
    expect(rows.length).toBe(1);
  });
});

describe('getHistory — endTs anchor (YoY overlay)', () => {
  it('returns rows ending at endTs, not "now"', () => {
    // Three raw readings: a year ago, last week, and now. With endTs anchored
    // a year ago, only the year-ago reading should be in a 24h window.
    const db = makeDb();
    const now    = Math.floor(Date.now() / 1000);
    const yearAgo = now - 365 * 86400;
    upsertSensors(db, [{ id: 's1', name: 'R', type: 'HT1', active: true, batteryVoltage: null }]);
    insertReadings(db, 's1', [
      { observed: new Date((yearAgo - 1800) * 1000).toISOString(), temperature: 50, humidity: 40, barometric_pressure: null, battery_voltage: null },
      { observed: new Date((now - 7 * 86400) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: null },
      { observed: new Date((now - 60)  * 1000).toISOString(),       temperature: 75, humidity: 55, barometric_pressure: null, battery_voltage: null },
    ]);
    const rows = getHistory(db, 's1', '24h', yearAgo);
    expect(rows).toHaveLength(1);
    expect(rows[0].temperature).toBe(50);
  });

  it('omitting endTs preserves the "anchored at now" behavior', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    upsertSensors(db, [{ id: 's1', name: 'R', type: 'HT1', active: true, batteryVoltage: null }]);
    insertReadings(db, 's1', [
      { observed: new Date((now - 60) * 1000).toISOString(), temperature: 72, humidity: 50, barometric_pressure: null, battery_voltage: null },
    ]);
    expect(getHistory(db, 's1', '24h')).toHaveLength(1);
    expect(getHistory(db, 's1', '24h', null)).toHaveLength(1);
  });

  it('endTs respects hourly_agg resolution for d-unit ranges', () => {
    // Two hourly buckets: one inside a year-ago window, one inside a now-window.
    const db = makeDb();
    const now      = Math.floor(Date.now() / 1000);
    const yearAgo  = now - 365 * 86400;
    const hourPast = yearAgo - (yearAgo % 3600);
    const hourNow  = now - 3600 - (now % 3600);
    upsertSensors(db, [{ id: 's1', name: 'R', type: 'HT1', active: true, batteryVoltage: null }]);
    db.prepare(`INSERT INTO hourly_agg (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count, excluded)
      VALUES ('s1', ?, 55, 53, 57, 60, 58, 62, null, 12, 0)`).run(hourPast);
    db.prepare(`INSERT INTO hourly_agg (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count, excluded)
      VALUES ('s1', ?, 75, 73, 77, 40, 38, 42, null, 12, 0)`).run(hourNow);
    // Anchored at yearAgo, 7d window — should only see the year-ago bucket.
    const rows = getHistory(db, 's1', '7d', yearAgo);
    expect(rows).toHaveLength(1);
    expect(rows[0].temperature).toBe(55);
  });
});

describe('getOldestReadingTs', () => {
  it('returns null on an empty DB', () => {
    expect(getOldestReadingTs(makeDb())).toBeNull();
  });

  it('returns the smallest ts across all sensors, ignoring excluded rows', () => {
    const db = makeDb();
    const base = 1_700_000_000; // arbitrary fixed timestamp
    upsertSensors(db, [
      { id: 'a', name: 'A', type: 'HT1', active: true, batteryVoltage: null },
      { id: 'b', name: 'B', type: 'HT1', active: true, batteryVoltage: null },
    ]);
    insertReadings(db, 'a', [
      { observed: new Date((base + 1000) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: null },
    ]);
    insertReadings(db, 'b', [
      { observed: new Date(base * 1000).toISOString(),          temperature: 60, humidity: 40, barometric_pressure: null, battery_voltage: null },
      { observed: new Date((base + 500) * 1000).toISOString(),  temperature: 61, humidity: 41, barometric_pressure: null, battery_voltage: null },
    ]);
    // No hourly aggregates built yet → oldest is the raw minimum.
    expect(getOldestReadingTs(db)).toBe(base);

    // setReadingExcluded recomputes the affected hour, which still holds the
    // non-excluded base+500 reading, so an hourly_agg row now exists at the
    // hour floor. getOldestReadingTs also considers hourly_agg (so the Stats
    // YoY "≥1 year" check survives raw-readings retention pruning), and that
    // aggregate — for an hour we still have data in — anchors the result.
    setReadingExcluded(db, 'b', base, true);
    expect(getOldestReadingTs(db)).toBe(base - (base % 3600));
  });

  it('falls back to hourly_agg when raw readings have been pruned', async () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    upsertSensors(db, [{ id: 'o1', name: 'O', type: 'HT1', active: true }]);

    const oldTs = now - 400 * 86400;   // beyond a 365-day raw retention window
    const newTs = now - 3600;
    insertReadings(db, 'o1', [
      { observed: new Date(oldTs * 1000).toISOString(), temperature: 60, humidity: 40 },
      { observed: new Date(newTs * 1000).toISOString(), temperature: 70, humidity: 50 },
    ]);
    const oldHour = oldTs - (oldTs % 3600);
    recomputeHourlyAgg(db, 'o1', oldHour);
    recomputeHourlyAgg(db, 'o1', newTs - (newTs % 3600));

    // Prune the old raw row; its hourly aggregate remains.
    await pruneReadingsOlderThan(db, now - 365 * 86400);

    // Oldest *raw* reading is now newTs, but hourly_agg still reaches back to
    // the old hour — getOldestReadingTs must report the older aggregate ts so
    // the YoY overlay still sees ≥1 year of history.
    expect(getOldestReadingTs(db)).toBe(oldHour);
  });
});

describe('pruneReadingsOlderThan', () => {
  it('deletes rows older than cutoff in batches and leaves hourly_agg intact', async () => {
    const db = makeDb();
    const base = 1_600_000_000;
    upsertSensors(db, [{ id: 'p', name: 'P', type: 'HT1', active: true }]);
    // 25 readings 1h apart; cutoff falls in the middle.
    insertReadings(db, 'p', makeSamples('p', 25, base, 3600));
    // Build hourly aggregates for all touched hours.
    const hours = new Set();
    for (let i = 0; i < 25; i++) { const t = base + i * 3600; hours.add(t - (t % 3600)); }
    for (const h of hours) recomputeHourlyAgg(db, 'p', h);
    const aggBefore = db.prepare('SELECT COUNT(*) AS n FROM hourly_agg WHERE sensor_id = ?').get('p').n;

    const cutoff = base + 10 * 3600;
    // batchSize:4 forces multiple batches; count the yields.
    let yields = 0;
    const deleted = await pruneReadingsOlderThan(db, cutoff, { batchSize: 4, yieldFn: () => { yields++; } });

    expect(deleted).toBe(10);                                   // rows with ts < cutoff
    expect(yields).toBeGreaterThan(0);                          // ran in >1 batch, yielding
    const remaining = db.prepare('SELECT MIN(ts) AS mn, COUNT(*) AS n FROM readings WHERE sensor_id = ?').get('p');
    expect(remaining.n).toBe(15);
    expect(remaining.mn).toBe(cutoff);
    expect(db.prepare('SELECT COUNT(*) AS n FROM hourly_agg WHERE sensor_id = ?').get('p').n).toBe(aggBefore);
  });

  it('deletes nothing when no rows precede the cutoff', async () => {
    const db = makeDb();
    const base = 1_600_000_000;
    upsertSensors(db, [{ id: 'q', name: 'Q', type: 'HT1', active: true }]);
    insertReadings(db, 'q', makeSamples('q', 5, base, 3600));
    const deleted = await pruneReadingsOlderThan(db, base - 1);
    expect(deleted).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM readings WHERE sensor_id = ?').get('q').n).toBe(5);
  });
});

describe('getHistoryAll', () => {
  it('includes excluded raw readings with excluded field', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    upsertSensors(db, [{ id: 's1', name: 'R', type: 'HT1', active: true, batteryVoltage: null }]);
    insertReadings(db, 's1', [
      { observed: new Date((now - 3600) * 1000).toISOString(), temperature: 68, humidity: 50, barometric_pressure: null, battery_voltage: null },
      { observed: new Date((now - 1800) * 1000).toISOString(), temperature: 999, humidity: 99, barometric_pressure: null, battery_voltage: null },
    ]);
    setReadingExcluded(db, 's1', now - 1800, true);
    const rows = getHistoryAll(db, 's1', '24h');
    expect(rows.length).toBe(2);
    const bad = rows.find(r => r.temperature === 999);
    expect(bad).toBeTruthy();
    expect(bad.excluded).toBe(1);
    const good = rows.find(r => r.temperature === 68);
    expect(good.excluded).toBe(0);
  });

  it('includes excluded hourly rows with excluded field', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    const hour1 = now - 3600 - (now % 3600);
    upsertSensors(db, [{ id: 's1', name: 'R', type: 'HT1', active: true, batteryVoltage: null }]);
    db.prepare(`INSERT INTO hourly_agg (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count, excluded)
      VALUES ('s1', ?, 65, 63, 67, 48, 45, 51, null, 12, 1)`).run(hour1);
    const rows = getHistoryAll(db, 's1', '7d');
    expect(rows.length).toBe(1);
    expect(rows[0].excluded).toBe(1);
  });
});

describe('setReadingExcluded', () => {
  it('marks a reading excluded and recomputes hourly_agg', () => {
    const db = makeDb();
    const hourTs = 3600;
    upsertSensors(db, [{ id: 's1', name: 'R', type: 'HT1', active: true, batteryVoltage: null }]);
    insertReadings(db, 's1', [
      { observed: new Date(3600000).toISOString(), temperature: 60, humidity: 40, barometric_pressure: null, battery_voltage: null },
      { observed: new Date(3900000).toISOString(), temperature: 80, humidity: 60, barometric_pressure: null, battery_voltage: null },
    ]);
    recomputeHourlyAgg(db, 's1', hourTs);
    const before = db.prepare('SELECT temp_avg FROM hourly_agg WHERE sensor_id=?').get('s1');
    expect(before.temp_avg).toBeCloseTo(70);

    setReadingExcluded(db, 's1', 3600, true);
    const after = db.prepare('SELECT temp_avg FROM hourly_agg WHERE sensor_id=?').get('s1');
    expect(after.temp_avg).toBeCloseTo(80); // only the non-excluded reading
  });

  it('restoring a reading re-includes it in hourly_agg', () => {
    const db = makeDb();
    const hourTs = 3600;
    upsertSensors(db, [{ id: 's1', name: 'R', type: 'HT1', active: true, batteryVoltage: null }]);
    insertReadings(db, 's1', [
      { observed: new Date(3600000).toISOString(), temperature: 60, humidity: 40, barometric_pressure: null, battery_voltage: null },
      { observed: new Date(3900000).toISOString(), temperature: 80, humidity: 60, barometric_pressure: null, battery_voltage: null },
    ]);
    recomputeHourlyAgg(db, 's1', hourTs);
    setReadingExcluded(db, 's1', 3600, true);
    setReadingExcluded(db, 's1', 3600, false);
    const row = db.prepare('SELECT temp_avg FROM hourly_agg WHERE sensor_id=?').get('s1');
    expect(row.temp_avg).toBeCloseTo(70);
  });
});

describe('setHourlyExcluded', () => {
  it('marks an hourly bucket excluded', () => {
    const db = makeDb();
    upsertSensors(db, [{ id: 's1', name: 'R', type: 'HT1', active: true, batteryVoltage: null }]);
    db.prepare(`INSERT INTO hourly_agg (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count, excluded)
      VALUES ('s1', 3600, 65, 63, 67, 48, 45, 51, null, 12, 0)`).run();
    setHourlyExcluded(db, 's1', 3600, true);
    const row = db.prepare('SELECT excluded FROM hourly_agg WHERE sensor_id=?').get('s1');
    expect(row.excluded).toBe(1);
  });

  it('restores an excluded hourly bucket', () => {
    const db = makeDb();
    upsertSensors(db, [{ id: 's1', name: 'R', type: 'HT1', active: true, batteryVoltage: null }]);
    db.prepare(`INSERT INTO hourly_agg (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count, excluded)
      VALUES ('s1', 3600, 65, 63, 67, 48, 45, 51, null, 12, 1)`).run();
    setHourlyExcluded(db, 's1', 3600, false);
    const row = db.prepare('SELECT excluded FROM hourly_agg WHERE sensor_id=?').get('s1');
    expect(row.excluded).toBe(0);
  });
});

describe('setLastPollTime / getLastPollTime', () => {
  it('round-trips the poll timestamp', () => {
    const db = makeDb();
    const ts = Date.now();
    setLastPollTime(db, ts);
    expect(getLastPollTime(db)).toBe(ts);
  });

  it('returns null when never set', () => {
    expect(getLastPollTime(makeDb())).toBeNull();
  });
});

describe('getGaps', () => {
  const NOW = Math.floor(Date.now() / 1000);

  function sensorDb(id = 'g1') {
    const db = makeDb();
    upsertSensors(db, [{ id, name: 'Test', type: 'HT1', active: true, batteryVoltage: null }]);
    return db;
  }

  // 24h range tests
  describe('24h range — raw readings', () => {
    it('returns no gaps and 100% coverage when readings are continuous', () => {
      const db = sensorDb();
      // 288 readings every 5 min over 24h
      const start = NOW - 86400;
      insertReadings(db, 'g1', makeSamples('g1', 289, start, 300));
      const { gaps, coveragePct } = getGaps(db, 'g1', '24h');
      expect(gaps).toHaveLength(0);
      expect(coveragePct).toBeCloseTo(100, 0);
    });

    it('reports the entire window as one gap on empty DB (dead-sensor case)', () => {
      const { gaps, sparseHours, coveragePct } = getGaps(sensorDb(), 'g1', '24h');
      expect(gaps).toHaveLength(1);
      expect(gaps[0].durationSecs).toBeGreaterThanOrEqual(86400 - 1);
      expect(sparseHours).toHaveLength(0);
      expect(coveragePct).toBeLessThan(1);
    });

    it('detects a 10-minute gap (> 5 min threshold)', () => {
      const db = sensorDb();
      const start = NOW - 86400;
      // Two clusters with a 10-min gap between them
      insertReadings(db, 'g1', makeSamples('g1', 10, start, 300));
      insertReadings(db, 'g1', makeSamples('g1', 10, start + 10 * 300 + 600, 300));
      const { gaps } = getGaps(db, 'g1', '24h');
      expect(gaps.length).toBeGreaterThanOrEqual(1);
      const bigGap = gaps[0];
      expect(bigGap.durationSecs).toBeGreaterThanOrEqual(600);
    });

    it('does NOT include interior gaps shorter than 5 minutes', () => {
      const db = sensorDb();
      const start = NOW - 86400;
      // Two readings 4 min apart — below the 5-min threshold for interior gaps.
      // (Leading/trailing gaps will still be reported; we only check that no
      // gap spans this 4-min interior window.)
      insertReadings(db, 'g1', [
        { observed: new Date((start) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: 2.9 },
        { observed: new Date((start + 240) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: 2.9 },
      ]);
      const { gaps } = getGaps(db, 'g1', '24h');
      const interior = gaps.filter(g => g.startTs >= start && g.endTs <= start + 240 + 1);
      expect(interior).toHaveLength(0);
    });

    it('returns gaps sorted by duration descending (including leading/trailing)', () => {
      const db = sensorDb();
      const start = NOW - 86400;
      // Three clusters with interior gaps of 30 min and 60 min, plus the
      // leading/trailing gaps the new logic detects. Just assert overall sort.
      insertReadings(db, 'g1', makeSamples('g1', 5, start, 300));
      insertReadings(db, 'g1', makeSamples('g1', 5, start + 5 * 300 + 1800, 300));
      insertReadings(db, 'g1', makeSamples('g1', 5, start + 10 * 300 + 1800 + 3600, 300));
      const { gaps } = getGaps(db, 'g1', '24h');
      expect(gaps.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < gaps.length; i++) {
        expect(gaps[i - 1].durationSecs).toBeGreaterThanOrEqual(gaps[i].durationSecs);
      }
      // Two interior gaps in the data: ~35min (last of cluster 1 → first of
      // cluster 2 is 1800s plus the 300s sample spacing) and ~65min between
      // cluster 2 and cluster 3. Don't assert exact durations — just that
      // both interior gaps are present and distinct from leading/trailing.
      const interior = gaps.filter(g => g.startTs >= start && g.endTs <= start + 86400);
      expect(interior.length).toBeGreaterThanOrEqual(2);
    });

    it('detects a leading gap when readings start well after the window start', () => {
      const db = sensorDb();
      // Single reading at end of window — leading gap should cover ~24h
      insertReadings(db, 'g1', [{
        observed: new Date((NOW - 60) * 1000).toISOString(),
        temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: 2.9,
      }]);
      const { gaps } = getGaps(db, 'g1', '24h');
      const leading = gaps.find(g => g.startTs <= NOW - 86000);
      expect(leading).toBeDefined();
      expect(leading.durationSecs).toBeGreaterThan(86000);
    });

    it('returns sparseHours even at raw resolution (≤24h ranges)', () => {
      const db = sensorDb();
      const hour = NOW - 3600;
      const hourTs = hour - (hour % 3600);
      // Insert a sparse hour (5 readings) — should appear in sparseHours
      // regardless of whether the requested range uses raw or hourly path.
      db.prepare(`
        INSERT OR REPLACE INTO hourly_agg
          (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count)
        VALUES ('g1', ?, 70, 68, 72, 50, 48, 52, null, 5)
      `).run(hourTs);

      const { sparseHours } = getGaps(db, 'g1', '24h');
      expect(sparseHours.some(h => h.hourTs === hourTs && h.sampleCount === 5)).toBe(true);
    });

    it('detects a trailing gap when last reading is well before now', () => {
      const db = sensorDb();
      // Single reading at start of window — trailing gap should cover ~24h
      insertReadings(db, 'g1', [{
        observed: new Date((NOW - 86000) * 1000).toISOString(),
        temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: 2.9,
      }]);
      const { gaps } = getGaps(db, 'g1', '24h');
      const trailing = gaps.find(g => g.endTs >= NOW - 60);
      expect(trailing).toBeDefined();
      expect(trailing.durationSecs).toBeGreaterThan(80000);
    });
  });

  // 7d range tests
  describe('7d range — hourly aggregates', () => {
    function insertHour(db, sensorId, hourTs, sampleCount = 30) {
      db.prepare(`
        INSERT OR REPLACE INTO hourly_agg
          (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count)
        VALUES (?, ?, 70, 68, 72, 50, 48, 52, null, ?)
      `).run(sensorId, hourTs, sampleCount);
    }

    it('detects a missing hour block in hourly_agg', () => {
      const db = sensorDb();
      const startHour = (NOW - 7 * 86400) - ((NOW - 7 * 86400) % 3600);
      // Insert hours 0,1,2 then skip hour 3, insert hours 4,5
      insertHour(db, 'g1', startHour);
      insertHour(db, 'g1', startHour + 3600);
      insertHour(db, 'g1', startHour + 7200);
      // gap: skip startHour + 10800
      insertHour(db, 'g1', startHour + 14400);
      insertHour(db, 'g1', startHour + 18000);
      const { gaps } = getGaps(db, 'g1', '7d');
      expect(gaps.length).toBeGreaterThanOrEqual(1);
      const found = gaps.find(g => g.durationSecs > 3600);
      expect(found).toBeDefined();
    });

    it('returns sparse hours with sample_count < 20', () => {
      const db = sensorDb();
      const startHour = (NOW - 86400) - ((NOW - 86400) % 3600);
      insertHour(db, 'g1', startHour, 5);
      insertHour(db, 'g1', startHour + 3600, 30);
      const { sparseHours } = getGaps(db, 'g1', '7d');
      expect(sparseHours.some(h => h.sampleCount === 5)).toBe(true);
      expect(sparseHours.every(h => h.sampleCount < 20)).toBe(true);
    });

    it('does NOT include hours with sample_count >= 20 in sparseHours', () => {
      const db = sensorDb();
      const startHour = (NOW - 86400) - ((NOW - 86400) % 3600);
      insertHour(db, 'g1', startHour, 25);
      const { sparseHours } = getGaps(db, 'g1', '7d');
      expect(sparseHours).toHaveLength(0);
    });

    it('coveragePct calculation is correct for a known mid-range gap', () => {
      const db = sensorDb();
      // Fill hours 0–47 and 72–167 (skip hours 48–71 = 24-hour gap in the middle)
      const startHour = Math.floor((NOW - 7 * 86400) / 3600) * 3600;
      for (let i = 0; i < 48; i++) insertHour(db, 'g1', startHour + i * 3600, 30);
      for (let i = 72; i < 7 * 24; i++) insertHour(db, 'g1', startHour + i * 3600, 30);
      const { gaps, coveragePct } = getGaps(db, 'g1', '7d');
      // LAG detects gap between hour 47 and hour 72 (24-hour block = 86400s)
      const bigGap = gaps.find(g => g.durationSecs >= 86400);
      expect(bigGap).toBeDefined();
      // ~1 day missing out of 7 → ~85.7% coverage
      expect(coveragePct).toBeGreaterThan(70);
      expect(coveragePct).toBeLessThan(100);
    });
  });

  // rangeStartTs / rangeEndTs
  it('returns rangeStartTs and rangeEndTs', () => {
    const before = Math.floor(Date.now() / 1000);
    const { rangeStartTs, rangeEndTs } = getGaps(sensorDb(), 'g1', '24h');
    const after = Math.floor(Date.now() / 1000);
    expect(rangeEndTs).toBeGreaterThanOrEqual(before);
    expect(rangeEndTs).toBeLessThanOrEqual(after + 1);
    expect(rangeEndTs - rangeStartTs).toBeCloseTo(86400, -2);
  });
});

describe('gateways', () => {
  const NOW = Math.floor(Date.now() / 1000);

  function gw(id, lastSeen) {
    return { id, name: id, lastSeen, lastAlert: null, version: '1.0', paired: true, message: null };
  }

  it('upsertGateways inserts then updates fields on conflict', () => {
    const db = makeDb();
    upsertGateways(db, [gw('g1', NOW - 60)]);
    upsertGateways(db, [{ ...gw('g1', NOW - 30), version: '2.0' }]);
    const rows = getGateways(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].last_seen).toBe(NOW - 30);
    expect(rows[0].version).toBe('2.0');
  });

  it('recordGatewayStatus appends one row per gateway per call', () => {
    const db = makeDb();
    recordGatewayStatus(db, [gw('g1', NOW - 60), gw('g2', NOW - 90)], NOW);
    recordGatewayStatus(db, [gw('g1', NOW - 30)], NOW + 300);
    const n = db.prepare(`SELECT COUNT(*) AS n FROM gateway_status`).get().n;
    expect(n).toBe(3);
  });

  describe('gatewayOnlineDuringWindow', () => {
    it('returns true when a poll inside the window saw a fresh gateway', () => {
      const db = makeDb();
      // Polled at T, last_seen at T-60 → fresh (within 600s)
      recordGatewayStatus(db, [gw('g1', NOW - 60)], NOW);
      expect(gatewayOnlineDuringWindow(db, NOW - 100, NOW + 100)).toBe(true);
    });

    it('returns false when polls inside the window all show stale gateway', () => {
      const db = makeDb();
      // Polled at T, last_seen at T-1800 → stale (>600s)
      recordGatewayStatus(db, [gw('g1', NOW - 1800)], NOW);
      expect(gatewayOnlineDuringWindow(db, NOW - 100, NOW + 100)).toBe(false);
    });

    it('returns null when no poll data covers the window', () => {
      const db = makeDb();
      recordGatewayStatus(db, [gw('g1', NOW)], NOW);
      // window entirely before any recorded poll
      expect(gatewayOnlineDuringWindow(db, NOW - 1000, NOW - 500)).toBeNull();
    });

    it('returns true if any of multiple gateways was fresh in the window', () => {
      const db = makeDb();
      recordGatewayStatus(db, [gw('g1', NOW - 1800), gw('g2', NOW - 60)], NOW);
      expect(gatewayOnlineDuringWindow(db, NOW - 100, NOW + 100)).toBe(true);
    });
  });

  it('pruneGatewayStatus removes rows older than the cutoff', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO gateway_status (gateway_id, polled_at, last_seen) VALUES (?, ?, ?)`)
      .run('g1', NOW - 31 * 86400, NOW - 31 * 86400);
    db.prepare(`INSERT INTO gateway_status (gateway_id, polled_at, last_seen) VALUES (?, ?, ?)`)
      .run('g1', NOW - 100, NOW - 100);
    pruneGatewayStatus(db, 30 * 86400);
    const rows = db.prepare(`SELECT polled_at FROM gateway_status`).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].polled_at).toBe(NOW - 100);
  });
});

describe('per-sample gateway + dewpoint/vpd capture', () => {
  const NOW = Math.floor(Date.now() / 1000);

  it('insertReadings stores gateway_id, dewpoint, vpd from sample', () => {
    const db = makeDb();
    upsertSensors(db, [{ id: 's1', name: 'X', type: 'HT1', active: true, batteryVoltage: 2.9 }]);
    insertReadings(db, 's1', [{
      observed: new Date((NOW - 60) * 1000).toISOString(),
      temperature: 70, humidity: 50, barometric_pressure: 1013, battery_voltage: 2.9,
      gateways: 'gw1;gw2', dewpoint: 50.1, vpd: 1.05,
    }]);
    const row = db.prepare('SELECT gateway_id, dewpoint, vpd FROM readings WHERE sensor_id=?').get('s1');
    expect(row.gateway_id).toBe('gw1;gw2');
    expect(row.dewpoint).toBeCloseTo(50.1);
    expect(row.vpd).toBeCloseTo(1.05);
  });

  it('recomputeHourlyAgg includes dewpoint_avg and vpd_avg', () => {
    const db = makeDb();
    upsertSensors(db, [{ id: 's2', name: 'X', type: 'HT1', active: true, batteryVoltage: 2.9 }]);
    const hour = NOW - (NOW % 3600);
    insertReadings(db, 's2', [
      { observed: new Date((hour + 60) * 1000).toISOString(),  temperature: 70, humidity: 50, dewpoint: 50, vpd: 1.0 },
      { observed: new Date((hour + 120) * 1000).toISOString(), temperature: 72, humidity: 52, dewpoint: 52, vpd: 1.1 },
    ]);
    recomputeHourlyAgg(db, 's2', hour);
    const row = db.prepare('SELECT dewpoint_avg, vpd_avg FROM hourly_agg WHERE sensor_id=? AND hour_ts=?').get('s2', hour);
    expect(row.dewpoint_avg).toBeCloseTo(51);
    expect(row.vpd_avg).toBeCloseTo(1.05);
  });

  describe('getSensorPrimaryGateway', () => {
    it('returns null when no readings have gateway_id', () => {
      const db = makeDb();
      upsertSensors(db, [{ id: 's3', name: 'X', type: 'HT1', active: true, batteryVoltage: 2.9 }]);
      insertReadings(db, 's3', [{
        observed: new Date((NOW - 60) * 1000).toISOString(),
        temperature: 70, humidity: 50,
      }]);
      expect(getSensorPrimaryGateway(db, 's3')).toBeNull();
    });

    it('returns the most-frequent first segment of gateway_id', () => {
      const db = makeDb();
      upsertSensors(db, [{ id: 's4', name: 'X', type: 'HT1', active: true, batteryVoltage: 2.9 }]);
      const samples = [
        { gw: 'gw_A;gw_B', t: NOW - 600 },
        { gw: 'gw_A',      t: NOW - 500 },
        { gw: 'gw_A;gw_B', t: NOW - 400 },
        { gw: 'gw_B',      t: NOW - 300 },
      ];
      insertReadings(db, 's4', samples.map(s => ({
        observed: new Date(s.t * 1000).toISOString(),
        temperature: 70, humidity: 50, gateways: s.gw,
      })));
      expect(getSensorPrimaryGateway(db, 's4')).toBe('gw_A');
    });

    it('ignores readings older than the window', () => {
      const db = makeDb();
      upsertSensors(db, [{ id: 's5', name: 'X', type: 'HT1', active: true, batteryVoltage: 2.9 }]);
      insertReadings(db, 's5', [
        { observed: new Date((NOW - 30 * 86400) * 1000).toISOString(), temperature: 70, humidity: 50, gateways: 'gw_old' },
        { observed: new Date((NOW - 60) * 1000).toISOString(),         temperature: 70, humidity: 50, gateways: 'gw_new' },
      ]);
      expect(getSensorPrimaryGateway(db, 's5', 7 * 86400)).toBe('gw_new');
    });
  });

  it('gatewayOnlineDuringWindow filters by gateway_id when provided', () => {
    const db = makeDb();
    // gwA stale, gwB fresh, both polled inside window
    recordGatewayStatus(db, [
      { id: 'gwA', lastSeen: NOW - 1800 },
      { id: 'gwB', lastSeen: NOW - 60 },
    ], NOW);
    expect(gatewayOnlineDuringWindow(db, NOW - 100, NOW + 100, 'gwA')).toBe(false);
    expect(gatewayOnlineDuringWindow(db, NOW - 100, NOW + 100, 'gwB')).toBe(true);
    // No filter → any gateway online
    expect(gatewayOnlineDuringWindow(db, NOW - 100, NOW + 100)).toBe(true);
  });
});

describe('recomputeHourlyAgg preserves setHourlyExcluded override', () => {
  it('keeps excluded=1 across a recompute triggered by a new reading', () => {
    const db = makeDb();
    upsertSensors(db, [{ id: 's_pres', name: 'X', type: 'HT1', active: true, batteryVoltage: 2.9 }]);
    const hour = Math.floor(Date.now() / 1000);
    const hourTs = hour - (hour % 3600);
    insertReadings(db, 's_pres', [{ observed: new Date((hourTs + 60) * 1000).toISOString(), temperature: 70, humidity: 50 }]);
    recomputeHourlyAgg(db, 's_pres', hourTs);

    // User excludes the noisy hour
    setHourlyExcluded(db, 's_pres', hourTs, true);
    expect(db.prepare(`SELECT excluded FROM hourly_agg WHERE sensor_id=? AND hour_ts=?`).get('s_pres', hourTs).excluded).toBe(1);

    // Late sample arrives → poller calls recompute
    insertReadings(db, 's_pres', [{ observed: new Date((hourTs + 120) * 1000).toISOString(), temperature: 71, humidity: 51 }]);
    recomputeHourlyAgg(db, 's_pres', hourTs);

    // Override must survive
    expect(db.prepare(`SELECT excluded FROM hourly_agg WHERE sensor_id=? AND hour_ts=?`).get('s_pres', hourTs).excluded).toBe(1);
  });
});

describe('recomputeHourlyAgg zombie-row prevention', () => {
  it('DELETEs the hourly_agg row when no non-excluded readings remain', () => {
    const db = makeDb();
    upsertSensors(db, [{ id: 's_zombie', name: 'X', type: 'HT1', active: true, batteryVoltage: 2.9 }]);
    const hour = Math.floor(Date.now() / 1000);
    const ts = hour - (hour % 3600) + 60;
    insertReadings(db, 's_zombie', [{ observed: new Date(ts * 1000).toISOString(), temperature: 70, humidity: 50 }]);
    recomputeHourlyAgg(db, 's_zombie', ts - (ts % 3600));
    expect(db.prepare(`SELECT COUNT(*) AS n FROM hourly_agg WHERE sensor_id=?`).get('s_zombie').n).toBe(1);

    // Exclude the only reading → recompute should DELETE the row, not leave
    // a sample_count=0 ghost that surfaces as a sparseHour.
    setReadingExcluded(db, 's_zombie', ts, true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM hourly_agg WHERE sensor_id=?`).get('s_zombie').n).toBe(0);
  });
});

describe('getGatewayUptime', () => {
  const NOW = Math.floor(Date.now() / 1000);
  function gw(id, lastSeen) {
    return { id, name: id, lastSeen, lastAlert: null, version: '1.0', paired: true, message: null };
  }

  it('returns null uptime when there is no recorded data in the window', () => {
    const db = makeDb();
    const r = getGatewayUptime(db, 'g1', NOW - 86400);
    expect(r.uptimePct).toBeNull();
    expect(r.total).toBe(0);
  });

  it('counts polls where last_seen is fresh as online', () => {
    const db = makeDb();
    // 4 polls, 5 min apart. last_seen=fresh on 3 of them, stale on the 4th.
    recordGatewayStatus(db, [gw('g1', NOW - 60)],     NOW);             // fresh
    recordGatewayStatus(db, [gw('g1', NOW - 240)],    NOW + 300);       // fresh (300 - (-240) = 540 ≤ 600)
    recordGatewayStatus(db, [gw('g1', NOW + 540)],    NOW + 600);       // fresh
    recordGatewayStatus(db, [gw('g1', NOW - 5000)],   NOW + 900);       // stale
    const r = getGatewayUptime(db, 'g1', NOW - 86400);
    expect(r.total).toBe(4);
    expect(r.online).toBe(3);
    expect(r.uptimePct).toBeCloseTo(0.75, 4);
  });

  it('respects the freshThresholdSecs parameter', () => {
    const db = makeDb();
    // last_seen exactly 1200s old: stale at 600s threshold, fresh at 1800s.
    recordGatewayStatus(db, [gw('g1', NOW - 1200)], NOW);
    expect(getGatewayUptime(db, 'g1', NOW - 86400, 600).online).toBe(0);
    expect(getGatewayUptime(db, 'g1', NOW - 86400, 1800).online).toBe(1);
  });

  it('treats null last_seen as offline', () => {
    const db = makeDb();
    recordGatewayStatus(db, [gw('g1', null)], NOW);
    const r = getGatewayUptime(db, 'g1', NOW - 86400);
    expect(r.online).toBe(0);
    expect(r.total).toBe(1);
  });

  it('only counts polls inside sinceTs', () => {
    const db = makeDb();
    recordGatewayStatus(db, [gw('g1', NOW - 60)], NOW - 86400 * 2); // outside
    recordGatewayStatus(db, [gw('g1', NOW - 60)], NOW);             // inside
    const r = getGatewayUptime(db, 'g1', NOW - 86400);
    expect(r.total).toBe(1);
  });
});

describe('countSensorsByPrimaryGateway', () => {
  const NOW = Math.floor(Date.now() / 1000);

  it('returns 0 when no readings have a matching primary gateway', () => {
    const db = makeDb();
    upsertSensors(db, [{ id: 's1', name: 's1', type: 'HT', active: true, batteryVoltage: 2.9 }]);
    insertReadings(db, 's1', [
      { observed: new Date(NOW * 1000).toISOString(), temperature: 70, humidity: 50, baro_pressure: null, dewpoint: null, vpd: null, gateways: 'gW;gX', battery_voltage: 2.9 },
    ]);
    expect(countSensorsByPrimaryGateway(db, 'gZ')).toBe(0);
  });

  it('counts each sensor at most once even with many readings', () => {
    const db = makeDb();
    upsertSensors(db, [{ id: 's1', name: 's1', type: 'HT', active: true, batteryVoltage: 2.9 }]);
    insertReadings(db, 's1', [0, 1, 2, 3].map(i => ({
      observed: new Date((NOW + i) * 1000).toISOString(),
      temperature: 70, humidity: 50, baro_pressure: null, dewpoint: null, vpd: null,
      gateways: 'gA;gB', battery_voltage: 2.9,
    })));
    expect(countSensorsByPrimaryGateway(db, 'gA')).toBe(1);
  });

  it('attributes a sensor to its most-frequent first-segment gateway', () => {
    const db = makeDb();
    upsertSensors(db, [
      { id: 's1', name: 's1', type: 'HT', active: true, batteryVoltage: 2.9 },
      { id: 's2', name: 's2', type: 'HT', active: true, batteryVoltage: 2.9 },
    ]);
    // s1 primarily through gA (2x) over gB (1x)
    insertReadings(db, 's1', [
      { observed: new Date((NOW + 1) * 1000).toISOString(), temperature: 70, humidity: 50, baro_pressure: null, dewpoint: null, vpd: null, gateways: 'gA', battery_voltage: 2.9 },
      { observed: new Date((NOW + 2) * 1000).toISOString(), temperature: 70, humidity: 50, baro_pressure: null, dewpoint: null, vpd: null, gateways: 'gA', battery_voltage: 2.9 },
      { observed: new Date((NOW + 3) * 1000).toISOString(), temperature: 70, humidity: 50, baro_pressure: null, dewpoint: null, vpd: null, gateways: 'gB', battery_voltage: 2.9 },
    ]);
    // s2 primarily through gB
    insertReadings(db, 's2', [
      { observed: new Date((NOW + 4) * 1000).toISOString(), temperature: 70, humidity: 50, baro_pressure: null, dewpoint: null, vpd: null, gateways: 'gB', battery_voltage: 2.9 },
    ]);
    expect(countSensorsByPrimaryGateway(db, 'gA')).toBe(1);
    expect(countSensorsByPrimaryGateway(db, 'gB')).toBe(1);
  });
});

describe('gatewayOnlineDuringWindow post-gap lookup semantics', () => {
  it('uses a post-gap poll whose last_seen reaches into the gap (sub-poll-interval gap)', () => {
    const db = makeDb();
    const NOW = Math.floor(Date.now() / 1000);
    // Gap is 60s long ([NOW+100, NOW+160]). Poll lands 40s after gap end, with
    // last_seen reaching back into the gap → proves the gateway was alive then.
    recordGatewayStatus(db, [{ id: 'gw1', lastSeen: NOW + 110 }], NOW + 200);
    expect(gatewayOnlineDuringWindow(db, NOW + 100, NOW + 160, 'gw1')).toBe(true);
  });

  it('returns false when the only post-gap poll has last_seen before the gap', () => {
    const db = makeDb();
    const NOW = Math.floor(Date.now() / 1000);
    // Poll just after the gap, but the gateway's last_seen is from before the
    // gap — gateway was already offline before the gap and didn't recover.
    recordGatewayStatus(db, [{ id: 'gw1', lastSeen: NOW + 50 }], NOW + 200);
    expect(gatewayOnlineDuringWindow(db, NOW + 100, NOW + 160, 'gw1')).toBe(false);
  });

  it('returns null when no poll covers the post-gap lookahead', () => {
    const db = makeDb();
    const NOW = Math.floor(Date.now() / 1000);
    recordGatewayStatus(db, [{ id: 'gw1', lastSeen: NOW }], NOW);
    // Window is 1 hour after the poll — way past POST_GAP_LOOKAHEAD (5 min).
    expect(gatewayOnlineDuringWindow(db, NOW + 3600, NOW + 3700, 'gw1')).toBeNull();
  });

  it('ignores pre-gap polls (their last_seen necessarily predates startTs)', () => {
    const db = makeDb();
    const NOW = Math.floor(Date.now() / 1000);
    // Only evidence is a poll BEFORE the gap with a fresh-looking last_seen —
    // but that last_seen is inherently < startTs, so it can't prove the
    // gateway was alive during the gap.
    recordGatewayStatus(db, [{ id: 'gw1', lastSeen: NOW + 50 }], NOW + 60);
    expect(gatewayOnlineDuringWindow(db, NOW + 100, NOW + 160, 'gw1')).toBeNull();
  });

  it('treats null last_seen as not-online (gateway never reported)', () => {
    const db = makeDb();
    const NOW = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO gateway_status (gateway_id, polled_at, last_seen) VALUES (?, ?, NULL)`).run('gw1', NOW + 50);
    expect(gatewayOnlineDuringWindow(db, NOW, NOW + 30, 'gw1')).toBe(false);
  });
});

describe('sensor migration columns', () => {
  it('upsertSensors stores rssi/address/device_id and getSensors returns them', () => {
    const db = makeDb();
    upsertSensors(db, [{
      id: 's1', name: 'X', type: 'HT1', active: true, batteryVoltage: 2.9,
      rssi: -75, address: 'AA:BB:CC', deviceId: '512345', alerts: null,
    }]);
    const rows = getSensors(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].rssi).toBe(-75);
    expect(rows[0].address).toBe('AA:BB:CC');
    expect(rows[0].device_id).toBe('512345');
  });
});

describe('getBatteryHistory', () => {
  it('returns voltages within the lookback window, oldest first', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    // 3 in-window readings + 1 stale one outside the 30-day window.
    insertReadings(db, 's1', [
      { observed: new Date((now - 31 * 86400) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: 2.95 }, // out of window
      { observed: new Date((now - 5  * 86400) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: 2.85 },
      { observed: new Date((now - 3  * 86400) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: 2.83 },
      { observed: new Date((now - 1  * 86400) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: 2.80 },
    ]);
    const rows = getBatteryHistory(db, 's1', 30);
    expect(rows).toHaveLength(3);
    expect(rows[0].v).toBeCloseTo(2.85);
    expect(rows[2].v).toBeCloseTo(2.80);
  });

  it('skips rows with NULL voltage', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    insertReadings(db, 's1', [
      { observed: new Date((now - 2 * 86400) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: null },
      { observed: new Date((now - 1 * 86400) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: 2.85 },
    ]);
    const rows = getBatteryHistory(db, 's1', 30);
    expect(rows).toHaveLength(1);
    expect(rows[0].v).toBeCloseTo(2.85);
  });
});

describe('computeBatteryForecast', () => {
  // Build N daily samples that decline by `slope` V/day from `startV`.
  function syntheticDaily(days, startV, slopePerDay) {
    const today = Math.floor(Date.now() / 1000 / 86400);
    const samples = [];
    for (let i = 0; i < days; i++) {
      const day = today - (days - 1) + i;
      // Two samples per day to make sure daily aggregation works as advertised.
      const v   = startV + slopePerDay * i;
      samples.push({ ts: day * 86400 + 100,  v: v + 0.005 });
      samples.push({ ts: day * 86400 + 50000, v: v - 0.005 });
    }
    return samples;
  }

  it('returns null when there are fewer than 7 daily points', () => {
    const samples = syntheticDaily(5, 2.95, -0.002);
    expect(computeBatteryForecast(samples)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(computeBatteryForecast([])).toBeNull();
    expect(computeBatteryForecast(null)).toBeNull();
  });

  it('projects days-to-2.5V for a declining battery', () => {
    // 30 days, dropping 5 mV/day from 2.90V. Today's V ≈ 2.756.
    // Days to 2.5: (2.5 - 2.90) / -0.005 = 80 days from start, so ~50 from today.
    const f = computeBatteryForecast(syntheticDaily(30, 2.90, -0.005));
    expect(f).not.toBeNull();
    expect(f.slopeVPerDay).toBeCloseTo(-0.005, 3);
    expect(f.currentV).toBeCloseTo(2.755, 2);
    expect(f.daysTo25).toBeGreaterThan(40);
    expect(f.daysTo25).toBeLessThan(60);
    // Thresholds line up: 2.4 always further than 2.5, 2.7 always closer.
    expect(f.daysTo24).toBeGreaterThan(f.daysTo25);
    expect(f.daysTo27).toBeLessThan(f.daysTo25);
  });

  it('returns null projections when the slope is non-negative', () => {
    const f = computeBatteryForecast(syntheticDaily(30, 2.90, 0.0));
    expect(f).not.toBeNull();
    expect(f.daysTo25).toBeNull();
    expect(f.daysTo27).toBeNull();
    expect(f.daysTo24).toBeNull();
    expect(f.currentV).toBeCloseTo(2.90, 1);
  });

  it('treats an upward jump > 0.2V as a battery replacement and refits to the new cell', () => {
    // 25 days of post-replacement decline from 2.95, preceded by 10 days
    // of an old cell ending at ~2.45 (the replacement bump is ~0.50V).
    const oldCell = syntheticDaily(10, 2.55, -0.01);  // ends ≈ 2.46
    const newCell = syntheticDaily(25, 2.95, -0.002); // ends ≈ 2.902
    // Shift oldCell ts back so newCell starts after it.
    const offset = 25 * 86400;
    const combined = [
      ...oldCell.map(s => ({ ts: s.ts - offset, v: s.v })),
      ...newCell,
    ];
    const f = computeBatteryForecast(combined);
    expect(f).not.toBeNull();
    // Slope reflects the new cell (-0.002), not the steeper old cell.
    expect(f.slopeVPerDay).toBeCloseTo(-0.002, 3);
    expect(f.currentV).toBeGreaterThan(2.85);
    // 25 days at -2 mV/day = sample window covers the new cell only.
    expect(f.sampleDays).toBe(25);
  });

  it('handles a perfectly flat history (zero variance) by returning null', () => {
    // All same voltage → linear-regression denominator is 0 → null.
    const today = Math.floor(Date.now() / 1000 / 86400);
    const samples = Array.from({ length: 10 }, (_, i) => ({
      ts: (today - 9 + i) * 86400 + 100,
      v: 2.85,
    }));
    // Note: x-variance is non-zero (different days), y-variance is zero,
    // so slope = 0 / nonzero = 0 → returned object with null projections.
    const f = computeBatteryForecast(samples);
    expect(f).not.toBeNull();
    expect(f.slopeVPerDay).toBeCloseTo(0);
    expect(f.daysTo25).toBeNull();
  });
});

describe('sensor_pairs CRUD', () => {
  function seedSensors(db) {
    upsertSensors(db, [
      { id: 'sA', name: 'Sensor A', type: 'HT1', active: true, batteryVoltage: 2.9 },
      { id: 'sB', name: 'Sensor B', type: 'HT1', active: true, batteryVoltage: 2.9 },
      { id: 'sC', name: 'Sensor C', type: 'HT1', active: true, batteryVoltage: 2.9 },
    ]);
  }

  it('createSensorPair inserts a row and returns it with the assigned id', () => {
    const db = makeDb();
    seedSensors(db);
    const row = createSensorPair(db, { sensorAId: 'sA', sensorBId: 'sB', label: 'kitchen pair' });
    expect(row.id).toBeGreaterThan(0);
    expect(row.sensor_a_id).toBe('sA');
    expect(row.sensor_b_id).toBe('sB');
    expect(row.label).toBe('kitchen pair');
    expect(row.created_at).toBeGreaterThan(0);
  });

  it('createSensorPair accepts null label', () => {
    const db = makeDb();
    seedSensors(db);
    const row = createSensorPair(db, { sensorAId: 'sA', sensorBId: 'sB', label: null });
    expect(row.label).toBeNull();
  });

  it('createSensorPair throws on UNIQUE (sensor_a_id, sensor_b_id) conflict', () => {
    const db = makeDb();
    seedSensors(db);
    createSensorPair(db, { sensorAId: 'sA', sensorBId: 'sB', label: 'one' });
    expect(() => createSensorPair(db, { sensorAId: 'sA', sensorBId: 'sB', label: 'two' }))
      .toThrowError(/UNIQUE/);
  });

  it('createSensorPair allows the inverse direction as a separate row', () => {
    const db = makeDb();
    seedSensors(db);
    const ab = createSensorPair(db, { sensorAId: 'sA', sensorBId: 'sB' });
    const ba = createSensorPair(db, { sensorAId: 'sB', sensorBId: 'sA' });
    expect(ab.id).not.toBe(ba.id);
    expect(listSensorPairs(db)).toHaveLength(2);
  });

  it('listSensorPairs returns pairs joined with sensor names, ordered by created_at', () => {
    const db = makeDb();
    seedSensors(db);
    createSensorPair(db, { sensorAId: 'sA', sensorBId: 'sB', label: 'first' });
    createSensorPair(db, { sensorAId: 'sB', sensorBId: 'sC', label: 'second' });
    const rows = listSensorPairs(db);
    expect(rows).toHaveLength(2);
    expect(rows[0].label).toBe('first');
    expect(rows[0].sensor_a_name).toBe('Sensor A');
    expect(rows[0].sensor_b_name).toBe('Sensor B');
    expect(rows[1].label).toBe('second');
  });

  it('getSensorPair returns the pair by id, or undefined when missing', () => {
    const db = makeDb();
    seedSensors(db);
    const created = createSensorPair(db, { sensorAId: 'sA', sensorBId: 'sB' });
    const found = getSensorPair(db, created.id);
    expect(found.sensor_a_id).toBe('sA');
    expect(getSensorPair(db, 999_999)).toBeUndefined();
  });

  it('deleteSensorPair removes the row and returns true; false for unknown id', () => {
    const db = makeDb();
    seedSensors(db);
    const created = createSensorPair(db, { sensorAId: 'sA', sensorBId: 'sB' });
    expect(deleteSensorPair(db, created.id)).toBe(true);
    expect(getSensorPair(db, created.id)).toBeUndefined();
    expect(deleteSensorPair(db, created.id)).toBe(false);
  });
});

describe('getPairAlignedHourly', () => {
  const NOW = Math.floor(Date.now() / 1000);

  function insertHour(db, sensorId, hourTs, tempAvg, humAvg, excluded = 0) {
    db.prepare(`
      INSERT OR REPLACE INTO hourly_agg
        (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count, excluded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 30, ?)
    `).run(sensorId, hourTs, tempAvg, tempAvg, tempAvg, humAvg, humAvg, humAvg, excluded);
  }

  it('returns aligned deltas (a - b) for hours both sensors have', () => {
    const db = makeDb();
    upsertSensors(db, [
      { id: 'sA', name: 'A', type: 'HT1', active: true, batteryVoltage: 2.9 },
      { id: 'sB', name: 'B', type: 'HT1', active: true, batteryVoltage: 2.9 },
    ]);
    const h0 = NOW - 3 * 3600 - (NOW % 3600);
    insertHour(db, 'sA', h0,        70.5, 50);
    insertHour(db, 'sB', h0,        70.0, 49);
    insertHour(db, 'sA', h0 + 3600, 71.0, 51);
    insertHour(db, 'sB', h0 + 3600, 70.0, 50);
    const rows = getPairAlignedHourly(db, 'sA', 'sB', h0);
    expect(rows).toHaveLength(2);
    expect(rows[0].deltaTemp).toBeCloseTo(0.5);
    expect(rows[0].deltaHumidity).toBeCloseTo(1);
    expect(rows[1].deltaTemp).toBeCloseTo(1.0);
  });

  it('drops hours where either sensor is missing', () => {
    const db = makeDb();
    upsertSensors(db, [
      { id: 'sA', name: 'A', type: 'HT1', active: true, batteryVoltage: 2.9 },
      { id: 'sB', name: 'B', type: 'HT1', active: true, batteryVoltage: 2.9 },
    ]);
    const h0 = NOW - 3 * 3600 - (NOW % 3600);
    insertHour(db, 'sA', h0, 70, 50);
    // Only sA at h0 — should be dropped
    insertHour(db, 'sA', h0 + 3600, 71, 51);
    insertHour(db, 'sB', h0 + 3600, 70, 50);
    const rows = getPairAlignedHourly(db, 'sA', 'sB', h0);
    expect(rows).toHaveLength(1);
    expect(rows[0].ts).toBe(h0 + 3600);
  });

  it('drops hours where either sensor has excluded=1', () => {
    const db = makeDb();
    upsertSensors(db, [
      { id: 'sA', name: 'A', type: 'HT1', active: true, batteryVoltage: 2.9 },
      { id: 'sB', name: 'B', type: 'HT1', active: true, batteryVoltage: 2.9 },
    ]);
    const h0 = NOW - 3 * 3600 - (NOW % 3600);
    insertHour(db, 'sA', h0, 70, 50);
    insertHour(db, 'sB', h0, 70, 50, 1);  // sB excluded
    insertHour(db, 'sA', h0 + 3600, 71, 51);
    insertHour(db, 'sB', h0 + 3600, 70, 50);
    const rows = getPairAlignedHourly(db, 'sA', 'sB', h0);
    expect(rows).toHaveLength(1);
    expect(rows[0].ts).toBe(h0 + 3600);
  });

  it('filters by sinceTs', () => {
    const db = makeDb();
    upsertSensors(db, [
      { id: 'sA', name: 'A', type: 'HT1', active: true, batteryVoltage: 2.9 },
      { id: 'sB', name: 'B', type: 'HT1', active: true, batteryVoltage: 2.9 },
    ]);
    const old = NOW - 7 * 86400 - (NOW % 3600);
    const recent = NOW - 3600 - (NOW % 3600);
    insertHour(db, 'sA', old, 70, 50);
    insertHour(db, 'sB', old, 70, 50);
    insertHour(db, 'sA', recent, 71, 51);
    insertHour(db, 'sB', recent, 70, 50);
    const rows = getPairAlignedHourly(db, 'sA', 'sB', NOW - 86400);
    expect(rows).toHaveLength(1);
    expect(rows[0].ts).toBe(recent);
  });

  it('returns empty array when there is no overlap', () => {
    const db = makeDb();
    upsertSensors(db, [
      { id: 'sA', name: 'A', type: 'HT1', active: true, batteryVoltage: 2.9 },
      { id: 'sB', name: 'B', type: 'HT1', active: true, batteryVoltage: 2.9 },
    ]);
    const h0 = NOW - 3 * 3600 - (NOW % 3600);
    insertHour(db, 'sA', h0, 70, 50);
    insertHour(db, 'sB', h0 + 7200, 70, 50);
    expect(getPairAlignedHourly(db, 'sA', 'sB', h0)).toEqual([]);
  });
});

describe('events CRUD', () => {
  it('openDb creates the events table with the expected columns and indexes', () => {
    const db = makeDb();
    const tables  = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map(r => r.name);
    expect(tables).toContain('events');
    expect(indexes).toContain('idx_events_ts');
    expect(indexes).toContain('idx_events_sensor_id');
    const cols = db.prepare(`PRAGMA table_info(events)`).all().map(r => r.name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'ts', 'sensor_id', 'label', 'note']));
  });

  it('createEvent persists a global event and returns it with an id', () => {
    const db = makeDb();
    const ev = createEvent(db, { ts: 1000, sensorId: null, label: 'first', note: 'hello' });
    expect(ev).toMatchObject({ ts: 1000, sensorId: null, label: 'first', note: 'hello' });
    expect(ev.id).toBeGreaterThan(0);
  });

  it('createEvent persists a sensor-scoped event', () => {
    const db = makeDb();
    upsertSensors(db, [{ id: 's1', name: 'Kitchen', type: 'HT1', active: true, batteryVoltage: null }]);
    const ev = createEvent(db, { ts: 2000, sensorId: 's1', label: 'furnace on', note: null });
    expect(ev.sensorId).toBe('s1');
    expect(ev.note).toBeNull();
  });

  it('getEventById returns null for unknown id', () => {
    expect(getEventById(makeDb(), 9999)).toBeNull();
  });

  it('listEvents returns all events DESC by ts when no filters', () => {
    const db = makeDb();
    createEvent(db, { ts: 1000, sensorId: null, label: 'a' });
    createEvent(db, { ts: 3000, sensorId: null, label: 'b' });
    createEvent(db, { ts: 2000, sensorId: null, label: 'c' });
    const rows = listEvents(db);
    expect(rows.map(r => r.label)).toEqual(['b', 'c', 'a']);
  });

  it('listEvents filters by from/to range (inclusive)', () => {
    const db = makeDb();
    createEvent(db, { ts: 1000, sensorId: null, label: 'a' });
    createEvent(db, { ts: 2000, sensorId: null, label: 'b' });
    createEvent(db, { ts: 3000, sensorId: null, label: 'c' });
    const rows = listEvents(db, { from: 1500, to: 2500 });
    expect(rows.map(r => r.label)).toEqual(['b']);
  });

  it('listEvents with sensorId returns sensor-scoped + global events', () => {
    const db = makeDb();
    upsertSensors(db, [
      { id: 's1', name: 'A', type: 'HT1', active: true, batteryVoltage: null },
      { id: 's2', name: 'B', type: 'HT1', active: true, batteryVoltage: null },
    ]);
    createEvent(db, { ts: 1000, sensorId: null, label: 'global' });
    createEvent(db, { ts: 2000, sensorId: 's1',  label: 's1-only' });
    createEvent(db, { ts: 3000, sensorId: 's2',  label: 's2-only' });
    const rows = listEvents(db, { sensorId: 's1' });
    const labels = rows.map(r => r.label).sort();
    expect(labels).toEqual(['global', 's1-only']);
  });

  it('listEvents with sensorId="__global__" returns only globals', () => {
    const db = makeDb();
    upsertSensors(db, [{ id: 's1', name: 'A', type: 'HT1', active: true, batteryVoltage: null }]);
    createEvent(db, { ts: 1000, sensorId: null, label: 'global' });
    createEvent(db, { ts: 2000, sensorId: 's1',  label: 's1-only' });
    const rows = listEvents(db, { sensorId: '__global__' });
    expect(rows.map(r => r.label)).toEqual(['global']);
  });

  it('updateEvent patches fields and leaves others intact', () => {
    const db = makeDb();
    const ev = createEvent(db, { ts: 1000, sensorId: null, label: 'orig', note: 'orig-note' });
    const updated = updateEvent(db, ev.id, { label: 'new' });
    expect(updated.label).toBe('new');
    expect(updated.note).toBe('orig-note');
    expect(updated.ts).toBe(1000);
  });

  it('updateEvent can clear sensorId (set to null)', () => {
    const db = makeDb();
    upsertSensors(db, [{ id: 's1', name: 'A', type: 'HT1', active: true, batteryVoltage: null }]);
    const ev = createEvent(db, { ts: 1000, sensorId: 's1', label: 'scoped' });
    const updated = updateEvent(db, ev.id, { sensorId: null });
    expect(updated.sensorId).toBeNull();
  });

  it('updateEvent returns null for unknown id', () => {
    expect(updateEvent(makeDb(), 9999, { label: 'x' })).toBeNull();
  });

  it('deleteEvent removes the row and returns true', () => {
    const db = makeDb();
    const ev = createEvent(db, { ts: 1000, sensorId: null, label: 'gone' });
    expect(deleteEvent(db, ev.id)).toBe(true);
    expect(getEventById(db, ev.id)).toBeNull();
  });

  it('deleteEvent returns false for unknown id', () => {
    expect(deleteEvent(makeDb(), 9999)).toBe(false);
  });
});

describe('outdoor_readings schema + helpers', () => {
  it('creates outdoor_readings table at openDb', () => {
    const db = makeDb();
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
    expect(tables).toContain('outdoor_readings');
  });

  it('insertOutdoorReadings inserts rows and returns count', () => {
    const db = makeDb();
    const n = insertOutdoorReadings(db, [
      { ts: 1000, temp: 60, humidity: 50, dewpoint: 40 },
      { ts: 1100, temp: 61, humidity: 51, dewpoint: 41 },
    ]);
    expect(n).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM outdoor_readings').get().n).toBe(2);
  });

  it('insertOutdoorReadings is idempotent on duplicate ts (INSERT OR IGNORE)', () => {
    const db = makeDb();
    insertOutdoorReadings(db, [{ ts: 1000, temp: 60, humidity: 50, dewpoint: 40 }]);
    const n2 = insertOutdoorReadings(db, [
      { ts: 1000, temp: 99, humidity: 99, dewpoint: 99 },  // dup → ignored
      { ts: 1100, temp: 61, humidity: 51, dewpoint: 41 },  // new
    ]);
    expect(n2).toBe(1);
    // Original row preserved — INSERT OR IGNORE doesn't overwrite
    const row = db.prepare('SELECT temp FROM outdoor_readings WHERE ts = 1000').get();
    expect(row.temp).toBe(60);
  });

  it('insertOutdoorReadings skips rows with non-finite ts (defensive)', () => {
    const db = makeDb();
    const n = insertOutdoorReadings(db, [
      { ts: 1000, temp: 60, humidity: 50, dewpoint: 40 },
      { ts: NaN, temp: 99, humidity: 99, dewpoint: 99 },
      null,                                              // explicit null sample
      { ts: 1100, temp: 61, humidity: 51, dewpoint: 41 },
    ]);
    expect(n).toBe(2);
  });

  it('insertOutdoorReadings coerces missing fields to null', () => {
    const db = makeDb();
    insertOutdoorReadings(db, [{ ts: 2000 }]); // no temp/humidity/dewpoint
    const row = db.prepare('SELECT * FROM outdoor_readings WHERE ts = 2000').get();
    expect(row.temp).toBeNull();
    expect(row.humidity).toBeNull();
    expect(row.dewpoint).toBeNull();
  });

  it('getLatestOutdoorTs returns null on empty table', () => {
    expect(getLatestOutdoorTs(makeDb())).toBeNull();
  });

  it('getLatestOutdoorTs returns MAX(ts) after inserts', () => {
    const db = makeDb();
    insertOutdoorReadings(db, [
      { ts: 1000, temp: 60, humidity: 50, dewpoint: 40 },
      { ts: 3000, temp: 62, humidity: 52, dewpoint: 42 },
      { ts: 2000, temp: 61, humidity: 51, dewpoint: 41 },
    ]);
    expect(getLatestOutdoorTs(db)).toBe(3000);
  });

  it('getOutdoorHistory returns rows within the requested range, in ts order', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    insertOutdoorReadings(db, [
      { ts: now - 30 * 86400, temp: 50, humidity: 60, dewpoint: 40 },  // outside 24h
      { ts: now - 3600,       temp: 60, humidity: 55, dewpoint: 45 },  // inside 24h
      { ts: now - 60,         temp: 65, humidity: 50, dewpoint: 48 },
    ]);
    const rows = getOutdoorHistory(db, '24h');
    expect(rows).toHaveLength(2);
    expect(rows[0].ts).toBeLessThan(rows[1].ts);
    expect(rows[0].temp).toBe(60);
    expect(rows[1].temp).toBe(65);
  });

  it('getOutdoorHistory respects 7d range', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    insertOutdoorReadings(db, [
      { ts: now - 8 * 86400, temp: 1, humidity: 1, dewpoint: 1 },  // outside 7d
      { ts: now - 86400,     temp: 2, humidity: 2, dewpoint: 2 },  // inside 7d
    ]);
    const rows = getOutdoorHistory(db, '7d');
    expect(rows).toHaveLength(1);
    expect(rows[0].temp).toBe(2);
  });

  it('getLatestOutdoorReading returns null on empty table', () => {
    expect(getLatestOutdoorReading(makeDb())).toBeNull();
  });

  it('getLatestOutdoorReading returns the row with max ts', () => {
    const db = makeDb();
    insertOutdoorReadings(db, [
      { ts: 1000, temp: 60, humidity: 50, dewpoint: 40 },
      { ts: 3000, temp: 70, humidity: 55, dewpoint: 48 },
      { ts: 2000, temp: 65, humidity: 53, dewpoint: 45 },
    ]);
    const row = getLatestOutdoorReading(db);
    expect(row.ts).toBe(3000);
    expect(row.temp).toBe(70);
    expect(row.humidity).toBe(55);
    expect(row.dewpoint).toBe(48);
  });
});
