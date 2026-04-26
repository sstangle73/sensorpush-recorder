// Uses Node's built-in node:sqlite (stable since Node 22.13 / Node 24).
// No native compilation needed — works on any platform Node 22+ runs on.
import { DatabaseSync } from 'node:sqlite';

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sensors (
      id              TEXT PRIMARY KEY,
      name            TEXT,
      type            TEXT,
      active          INTEGER NOT NULL DEFAULT 1,
      battery_voltage REAL,
      last_updated    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS readings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sensor_id       TEXT NOT NULL,
      ts              INTEGER NOT NULL,
      temperature     REAL,
      humidity        REAL,
      baro_pressure   REAL,
      battery_voltage REAL,
      excluded        INTEGER NOT NULL DEFAULT 0,
      UNIQUE(sensor_id, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_readings_sensor_ts ON readings(sensor_id, ts);

    CREATE TABLE IF NOT EXISTS hourly_agg (
      sensor_id     TEXT NOT NULL,
      hour_ts       INTEGER NOT NULL,
      temp_avg      REAL,
      temp_min      REAL,
      temp_max      REAL,
      hum_avg       REAL,
      hum_min       REAL,
      hum_max       REAL,
      baro_avg      REAL,
      sample_count  INTEGER NOT NULL DEFAULT 0,
      excluded      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (sensor_id, hour_ts)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  // Migrate existing DBs that predate the excluded columns.
  for (const [table, col] of [['readings', 'excluded'], ['hourly_agg', 'excluded']]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
  }
  // Migrate: alerts column on sensors (added when SensorPush alert thresholds were surfaced).
  {
    const cols = db.prepare(`PRAGMA table_info(sensors)`).all().map(r => r.name);
    if (!cols.includes('alerts')) db.exec(`ALTER TABLE sensors ADD COLUMN alerts TEXT`);
  }
  return db;
}

export function upsertSensors(db, sensors) {
  const stmt = db.prepare(`
    INSERT INTO sensors (id, name, type, active, battery_voltage, last_updated, alerts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name            = excluded.name,
      type            = excluded.type,
      active          = excluded.active,
      battery_voltage = excluded.battery_voltage,
      last_updated    = excluded.last_updated,
      alerts          = excluded.alerts
  `);
  const now = Math.floor(Date.now() / 1000);
  db.exec('BEGIN');
  try {
    for (const s of sensors) {
      stmt.run(s.id, s.name, s.type ?? null, s.active ? 1 : 0, s.batteryVoltage ?? null, now, s.alerts ? JSON.stringify(s.alerts) : null);
    }
    db.exec('COMMIT');
  } catch(e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getLatestTs(db, sensorId) {
  const row = db.prepare('SELECT MAX(ts) AS ts FROM readings WHERE sensor_id = ? AND excluded = 0').get(sensorId);
  return row?.ts ?? null;
}

// Returns array of { ts } for each newly inserted row.
export function insertReadings(db, sensorId, samples) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO readings (sensor_id, ts, temperature, humidity, baro_pressure, battery_voltage)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const inserted = [];
  db.exec('BEGIN');
  try {
    for (const s of samples) {
      const ts = Math.floor(new Date(s.observed).getTime() / 1000);
      const result = stmt.run(
        sensorId, ts,
        s.temperature         ?? null,
        s.humidity            ?? null,
        s.barometric_pressure ?? null,
        s.battery_voltage     ?? null,
      );
      if (result.changes > 0) inserted.push({ ts });
    }
    db.exec('COMMIT');
  } catch(e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return inserted;
}

export function recomputeHourlyAgg(db, sensorId, hourTs) {
  db.prepare(`
    INSERT OR REPLACE INTO hourly_agg
      (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count)
    SELECT ?, ?,
      AVG(temperature), MIN(temperature), MAX(temperature),
      AVG(humidity),    MIN(humidity),    MAX(humidity),
      AVG(baro_pressure),
      COUNT(*)
    FROM readings
    WHERE sensor_id = ? AND ts >= ? AND ts < ? AND excluded = 0
  `).run(sensorId, hourTs, sensorId, hourTs, hourTs + 3600);
}

export function getSensors(db) {
  return db.prepare(`
    SELECT s.id, s.name, s.type, s.active, s.battery_voltage, s.alerts,
           r.temperature, r.humidity, r.baro_pressure, r.ts AS last_ts
    FROM sensors s
    LEFT JOIN readings r ON r.sensor_id = s.id
      AND r.ts = (SELECT MAX(ts) FROM readings WHERE sensor_id = s.id AND excluded = 0)
      AND r.excluded = 0
  `).all();
}

// Parse e.g. '24h', '7d', '1yr' → seconds. Returns null for invalid input.
export function rangeToSeconds(range) {
  const m = /^(\d+)(h|d|yr)$/.exec(range);
  if (!m) return null;
  const n = parseInt(m[1]);
  if (n <= 0) return null;
  return m[2] === 'h' ? n * 3600 : m[2] === 'd' ? n * 86400 : n * 31536000;
}

// Returns the unit character: 'h' | 'd' | 'yr', or null for invalid input.
export function rangeUnit(range) {
  return /^(\d+)(h|d|yr)$/.exec(range)?.[2] ?? null;
}

export function getHistory(db, sensorId, range) {
  const rangeSeconds = rangeToSeconds(range) ?? 86400;
  const since = Math.floor(Date.now() / 1000) - rangeSeconds;
  const unit  = rangeUnit(range) ?? 'h';

  if (unit === 'h') {
    return db.prepare(`
      SELECT ts, temperature, humidity, baro_pressure AS baroPressure,
             NULL AS tempMin, NULL AS tempMax, NULL AS humMin, NULL AS humMax
      FROM readings WHERE sensor_id = ? AND ts >= ? AND excluded = 0
      ORDER BY ts
    `).all(sensorId, since);
  }
  if (unit === 'd') {
    return db.prepare(`
      SELECT hour_ts AS ts, temp_avg AS temperature, hum_avg AS humidity, baro_avg AS baroPressure,
             temp_min AS tempMin, temp_max AS tempMax, hum_min AS humMin, hum_max AS humMax
      FROM hourly_agg WHERE sensor_id = ? AND hour_ts >= ? AND excluded = 0
      ORDER BY hour_ts
    `).all(sensorId, since);
  }
  // yr → daily aggregates computed from hourly_agg (no schema change needed)
  return db.prepare(`
    SELECT (hour_ts / 86400 * 86400) AS ts,
           AVG(temp_avg) AS temperature, MIN(temp_min) AS tempMin, MAX(temp_max) AS tempMax,
           AVG(hum_avg)  AS humidity,    MIN(hum_min)  AS humMin,  MAX(hum_max)  AS humMax,
           AVG(baro_avg) AS baroPressure
    FROM hourly_agg WHERE sensor_id = ? AND hour_ts >= ? AND excluded = 0
    GROUP BY (hour_ts / 86400 * 86400)
    ORDER BY ts
  `).all(sensorId, since);
}

// Returns all readings including excluded ones — used by the data explorer UI.
export function getHistoryAll(db, sensorId, range) {
  const rangeSeconds = rangeToSeconds(range) ?? 86400;
  const since = Math.floor(Date.now() / 1000) - rangeSeconds;
  const unit  = rangeUnit(range) ?? 'h';

  if (unit === 'h') {
    return db.prepare(`
      SELECT ts, temperature, humidity, baro_pressure AS baroPressure,
             NULL AS tempMin, NULL AS tempMax, NULL AS humMin, NULL AS humMax, excluded
      FROM readings WHERE sensor_id = ? AND ts >= ?
      ORDER BY ts
    `).all(sensorId, since);
  }
  if (unit === 'd') {
    return db.prepare(`
      SELECT hour_ts AS ts, temp_avg AS temperature, hum_avg AS humidity, baro_avg AS baroPressure,
             temp_min AS tempMin, temp_max AS tempMax, hum_min AS humMin, hum_max AS humMax, excluded
      FROM hourly_agg WHERE sensor_id = ? AND hour_ts >= ?
      ORDER BY hour_ts
    `).all(sensorId, since);
  }
  // yr → daily; exclusion not meaningful at this granularity (excluded always 0)
  return db.prepare(`
    SELECT (hour_ts / 86400 * 86400) AS ts,
           AVG(temp_avg) AS temperature, MIN(temp_min) AS tempMin, MAX(temp_max) AS tempMax,
           AVG(hum_avg)  AS humidity,    MIN(hum_min)  AS humMin,  MAX(hum_max)  AS humMax,
           AVG(baro_avg) AS baroPressure, 0 AS excluded
    FROM hourly_agg WHERE sensor_id = ? AND hour_ts >= ? AND excluded = 0
    GROUP BY (hour_ts / 86400 * 86400)
    ORDER BY ts
  `).all(sensorId, since);
}

export function setReadingExcluded(db, sensorId, ts, excluded) {
  db.prepare('UPDATE readings SET excluded = ? WHERE sensor_id = ? AND ts = ?')
    .run(excluded ? 1 : 0, sensorId, ts);
  recomputeHourlyAgg(db, sensorId, ts - (ts % 3600));
}

export function setHourlyExcluded(db, sensorId, hourTs, excluded) {
  db.prepare('UPDATE hourly_agg SET excluded = ? WHERE sensor_id = ? AND hour_ts = ?')
    .run(excluded ? 1 : 0, sensorId, hourTs);
}

// Returns gap analysis for a sensor: missing windows + sparse hours + coverage %.
export function getGaps(db, sensorId, range) {
  const rangeSeconds = rangeToSeconds(range) ?? 604800;
  const now     = Math.floor(Date.now() / 1000);
  const startTs = now - rangeSeconds;

  let gaps = [], sparseHours = [];

  if (rangeSeconds <= 86400) {
    gaps = db.prepare(`
      WITH r AS (
        SELECT ts, LAG(ts) OVER (ORDER BY ts) AS prev_ts
        FROM readings WHERE sensor_id = ? AND excluded = 0 AND ts >= ?
      )
      SELECT prev_ts AS startTs, ts AS endTs, ts - prev_ts AS durationSecs
      FROM r WHERE prev_ts IS NOT NULL AND ts - prev_ts > 300
      ORDER BY durationSecs DESC
    `).all(sensorId, startTs);
  } else {
    gaps = db.prepare(`
      WITH h AS (
        SELECT hour_ts, LAG(hour_ts) OVER (ORDER BY hour_ts) AS prev_hour_ts
        FROM hourly_agg WHERE sensor_id = ? AND excluded = 0 AND hour_ts >= ?
      )
      SELECT prev_hour_ts AS startTs, hour_ts AS endTs, hour_ts - prev_hour_ts AS durationSecs
      FROM h WHERE prev_hour_ts IS NOT NULL AND hour_ts - prev_hour_ts > 3600
      ORDER BY durationSecs DESC
    `).all(sensorId, startTs);

    sparseHours = db.prepare(`
      SELECT hour_ts AS hourTs, sample_count AS sampleCount
      FROM hourly_agg
      WHERE sensor_id = ? AND excluded = 0 AND hour_ts >= ? AND sample_count < 20
      ORDER BY sample_count ASC
    `).all(sensorId, startTs);
  }

  const gapSecs    = gaps.reduce((s, g) => s + g.durationSecs, 0);
  const coveragePct = Math.max(0, Math.min(100, (rangeSeconds - gapSecs) / rangeSeconds * 100));

  return { gaps, sparseHours, coveragePct, rangeStartTs: startTs, rangeEndTs: now };
}

export function getUiSettings(db) {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get('ui_settings');
  return row ? JSON.parse(row.value) : null;
}

export function setUiSettings(db, settings) {
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
    .run('ui_settings', JSON.stringify(settings));
}

export function setLastPollTime(db, epochMs) {
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
    .run('last_poll', epochMs.toString());
}

export function getLastPollTime(db) {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get('last_poll');
  return row ? parseInt(row.value, 10) : null;
}
