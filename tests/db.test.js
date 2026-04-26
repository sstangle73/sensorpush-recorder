import { describe, it, expect, beforeEach } from 'vitest';
import {
  openDb, upsertSensors, getLatestTs, insertReadings,
  recomputeHourlyAgg, getSensors, getHistory, getHistoryAll,
  setReadingExcluded, setHourlyExcluded, setLastPollTime, getLastPollTime, getGaps,
  upsertGateways, recordGatewayStatus, getGateways, gatewayOnlineDuringWindow, pruneGatewayStatus,
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

    it('returns empty result on empty DB', () => {
      const { gaps, sparseHours, coveragePct } = getGaps(sensorDb(), 'g1', '24h');
      expect(gaps).toHaveLength(0);
      expect(sparseHours).toHaveLength(0);
      expect(coveragePct).toBeGreaterThanOrEqual(0);
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

    it('does NOT return gaps shorter than 5 minutes', () => {
      const db = sensorDb();
      const start = NOW - 86400;
      // Two readings 4 min apart — below threshold
      insertReadings(db, 'g1', [
        { observed: new Date((start) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: 2.9 },
        { observed: new Date((start + 240) * 1000).toISOString(), temperature: 70, humidity: 50, barometric_pressure: null, battery_voltage: 2.9 },
      ]);
      const { gaps } = getGaps(db, 'g1', '24h');
      expect(gaps).toHaveLength(0);
    });

    it('returns gaps sorted by duration descending', () => {
      const db = sensorDb();
      const start = NOW - 86400;
      // Insert three clusters with gaps of 30 min and 60 min
      insertReadings(db, 'g1', makeSamples('g1', 5, start, 300));
      insertReadings(db, 'g1', makeSamples('g1', 5, start + 5 * 300 + 1800, 300)); // +30 min gap
      insertReadings(db, 'g1', makeSamples('g1', 5, start + 10 * 300 + 1800 + 3600, 300)); // +60 min gap
      const { gaps } = getGaps(db, 'g1', '24h');
      expect(gaps.length).toBe(2);
      expect(gaps[0].durationSecs).toBeGreaterThan(gaps[1].durationSecs);
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
