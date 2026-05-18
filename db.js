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

    CREATE TABLE IF NOT EXISTS gateways (
      id           TEXT PRIMARY KEY,
      name         TEXT,
      last_seen    INTEGER,
      last_alert   INTEGER,
      version      TEXT,
      paired       INTEGER NOT NULL DEFAULT 1,
      message      TEXT,
      last_synced  INTEGER NOT NULL DEFAULT 0
    );

    -- One row appended per poll per gateway; lets us answer "was the gateway
    -- online during this gap window?" by inspecting (polled_at, last_seen) pairs.
    CREATE TABLE IF NOT EXISTS gateway_status (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      gateway_id  TEXT NOT NULL,
      polled_at   INTEGER NOT NULL,
      last_seen   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_gw_status_polled ON gateway_status(polled_at);

    -- User-defined pairs of sensors meant to be measuring the same environment.
    -- The Calibration panel compares their hourly readings and flags pairs
    -- whose delta is trending (i.e. one sensor's calibration is drifting).
    -- UNIQUE prevents the same A→B mapping being registered twice; B→A is
    -- a separate row (and the same data, since deltas just flip sign).
    CREATE TABLE IF NOT EXISTS sensor_pairs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      sensor_a_id  TEXT NOT NULL,
      sensor_b_id  TEXT NOT NULL,
      label        TEXT,
      created_at   INTEGER NOT NULL,
      UNIQUE(sensor_a_id, sensor_b_id)
    );

    -- User-annotated events. sensor_id is NULL for global events (visible on
    -- every sensor's chart); non-NULL events are sensor-scoped and only show
    -- when that sensor is selected.
    CREATE TABLE IF NOT EXISTS events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        INTEGER NOT NULL,
      sensor_id TEXT,
      label     TEXT NOT NULL,
      note      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts        ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_sensor_id ON events(sensor_id);

    -- Per-(target, condition) firing state for outbound notifications.
    -- The "key" column is "condition:targetId" (e.g. "threshold:sensor123",
    -- "gateway-offline:gw1"). "active" = condition is currently true;
    -- last_payload is the most recent dispatched payload as JSON, kept for
    -- debugging from the UI / test buttons.
    CREATE TABLE IF NOT EXISTS notification_state (
      key                TEXT PRIMARY KEY,
      active             INTEGER NOT NULL DEFAULT 0,
      last_notified_at   INTEGER,
      last_transition_at INTEGER,
      last_payload       TEXT
    );

    -- Outdoor weather samples from Open-Meteo. Single-location series (we only
    -- track one lat/lon per recorder), so no location_id column. UNIQUE(ts)
    -- + INSERT OR IGNORE matches the readings table's de-dup semantics, so
    -- the hourly poller can safely overlap the previous fetch window.
    CREATE TABLE IF NOT EXISTS outdoor_readings (
      ts        INTEGER PRIMARY KEY,
      temp      REAL,
      humidity  REAL,
      dewpoint  REAL
    );
  `);
  // Migrate existing DBs that predate the excluded columns.
  for (const [table, col] of [['readings', 'excluded'], ['hourly_agg', 'excluded']]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
  }
  // Migrate: alerts column on sensors (added when SensorPush alert thresholds were surfaced).
  // Then rssi/address/device_id (added with the gateway-status feature).
  {
    const cols = db.prepare(`PRAGMA table_info(sensors)`).all().map(r => r.name);
    if (!cols.includes('alerts'))    db.exec(`ALTER TABLE sensors ADD COLUMN alerts    TEXT`);
    if (!cols.includes('rssi'))      db.exec(`ALTER TABLE sensors ADD COLUMN rssi      INTEGER`);
    if (!cols.includes('address'))   db.exec(`ALTER TABLE sensors ADD COLUMN address   TEXT`);
    if (!cols.includes('device_id')) db.exec(`ALTER TABLE sensors ADD COLUMN device_id TEXT`);
  }
  // Migrate: per-sample gateway attribution + derived metrics (dewpoint, VPD)
  // exposed by /samples. Stored raw — gateway_id is the API's value, which is
  // ";"-separated when multiple gateways heard the same sample.
  {
    const cols = db.prepare(`PRAGMA table_info(readings)`).all().map(r => r.name);
    if (!cols.includes('gateway_id')) db.exec(`ALTER TABLE readings ADD COLUMN gateway_id TEXT`);
    if (!cols.includes('dewpoint'))   db.exec(`ALTER TABLE readings ADD COLUMN dewpoint   REAL`);
    if (!cols.includes('vpd'))        db.exec(`ALTER TABLE readings ADD COLUMN vpd        REAL`);
  }
  {
    const cols = db.prepare(`PRAGMA table_info(hourly_agg)`).all().map(r => r.name);
    if (!cols.includes('dewpoint_avg')) db.exec(`ALTER TABLE hourly_agg ADD COLUMN dewpoint_avg REAL`);
    if (!cols.includes('vpd_avg'))      db.exec(`ALTER TABLE hourly_agg ADD COLUMN vpd_avg      REAL`);
  }
  return db;
}

export function upsertSensors(db, sensors) {
  const stmt = db.prepare(`
    INSERT INTO sensors (id, name, type, active, battery_voltage, last_updated, alerts, rssi, address, device_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name            = excluded.name,
      type            = excluded.type,
      active          = excluded.active,
      battery_voltage = excluded.battery_voltage,
      last_updated    = excluded.last_updated,
      alerts          = excluded.alerts,
      rssi            = excluded.rssi,
      address         = excluded.address,
      device_id       = excluded.device_id
  `);
  const now = Math.floor(Date.now() / 1000);
  db.exec('BEGIN');
  try {
    for (const s of sensors) {
      stmt.run(
        s.id, s.name, s.type ?? null, s.active ? 1 : 0,
        s.batteryVoltage ?? null, now,
        s.alerts ? JSON.stringify(s.alerts) : null,
        s.rssi ?? null, s.address ?? null, s.deviceId ?? null,
      );
    }
    db.exec('COMMIT');
  } catch(e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function upsertGateways(db, gateways) {
  const stmt = db.prepare(`
    INSERT INTO gateways (id, name, last_seen, last_alert, version, paired, message, last_synced)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name        = excluded.name,
      last_seen   = excluded.last_seen,
      last_alert  = excluded.last_alert,
      version     = excluded.version,
      paired      = excluded.paired,
      message     = excluded.message,
      last_synced = excluded.last_synced
  `);
  const now = Math.floor(Date.now() / 1000);
  db.exec('BEGIN');
  try {
    for (const g of gateways) {
      stmt.run(
        g.id, g.name, g.lastSeen ?? null, g.lastAlert ?? null,
        g.version ?? null, g.paired ? 1 : 0, g.message ?? null, now,
      );
    }
    db.exec('COMMIT');
  } catch(e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Append one (gateway_id, polled_at, last_seen) row per gateway. Used at every
// poll so we can later determine whether a gateway was online during a gap.
export function recordGatewayStatus(db, gateways, polledAt) {
  const stmt = db.prepare(`INSERT INTO gateway_status (gateway_id, polled_at, last_seen) VALUES (?, ?, ?)`);
  db.exec('BEGIN');
  try {
    for (const g of gateways) stmt.run(g.id, polledAt, g.lastSeen ?? null);
    db.exec('COMMIT');
  } catch(e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Drop gateway_status rows older than `olderThanSecs` to keep the table bounded.
export function pruneGatewayStatus(db, olderThanSecs = 30 * 86400) {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSecs;
  db.prepare(`DELETE FROM gateway_status WHERE polled_at < ?`).run(cutoff);
}

// Compute gateway uptime % over the window starting at sinceTs. A poll is
// counted as "online" when (polled_at - last_seen) ≤ freshThresholdSecs;
// i.e., the gateway was last heard within freshThresholdSecs of that poll.
// 10 min default lines up with the 5-min poll cadence + some slack.
//
// Returns null uptime when there's no recorded data (gateway wasn't around
// during the window) — caller distinguishes "0% uptime" from "no data".
export function getGatewayUptime(db, gatewayId, sinceTs, freshThresholdSecs = 600) {
  const rows = db.prepare(`
    SELECT polled_at, last_seen FROM gateway_status
    WHERE gateway_id = ? AND polled_at >= ?
  `).all(gatewayId, sinceTs);
  if (!rows.length) return { uptimePct: null, total: 0, online: 0 };
  let online = 0;
  for (const r of rows) {
    if (r.last_seen != null && r.polled_at - r.last_seen <= freshThresholdSecs) online++;
  }
  return {
    uptimePct: online / rows.length,
    total:     rows.length,
    online,
  };
}

// Count sensors whose primary gateway resolves to this gatewayId over the
// last `lookbackSecs`. Lets the UI show "primary for N sensors" so the user
// knows whose data flow depends on each gateway.
export function countSensorsByPrimaryGateway(db, gatewayId, lookbackSecs = 7 * 86400) {
  const since = Math.floor(Date.now() / 1000) - lookbackSecs;
  // Sensors with at least one reading in the lookback that came through this
  // gateway (as the most-frequent first segment of the semicolon list).
  // For each sensor, getSensorPrimaryGateway already encapsulates the logic;
  // do it inline here for efficiency.
  const sensors = db.prepare(`SELECT DISTINCT sensor_id FROM readings WHERE ts >= ?`).all(since);
  let count = 0;
  for (const { sensor_id } of sensors) {
    const top = db.prepare(`
      SELECT TRIM(SUBSTR(gateway_id, 1, INSTR(gateway_id || ';', ';') - 1)) AS gw, COUNT(*) AS n
      FROM readings
      WHERE sensor_id = ? AND ts >= ? AND gateway_id IS NOT NULL AND gateway_id != ''
      GROUP BY gw ORDER BY n DESC LIMIT 1
    `).get(sensor_id, since);
    if (top?.gw === gatewayId) count++;
  }
  return count;
}

export function getGateways(db) {
  return db.prepare(`SELECT id, name, last_seen, last_alert, version, paired, message, last_synced FROM gateways ORDER BY name`).all();
}

// For a [startTs, endTs] window, return whether a gateway was online at any
// point within the window. If gatewayId is provided, only that gateway
// counts; otherwise any gateway.
//
//   true  → some recorded last_seen falls in [startTs, ∞), i.e. the gateway
//           was alive at or after gap-start, proving it was online at least
//           briefly during the gap
//   false → polls covering the area exist, but every recorded last_seen is
//           strictly before startTs (gateway was already down before gap)
//   null  → no poll data covers the area (can't tell — gap predates tracking
//           or is so recent no post-gap poll has happened yet)
//
// Why only post-gap polls inform the answer:
// gateway_status.last_seen is monotonically non-decreasing per gateway (it's
// the high-water mark of "I heard the gateway at time T"). A poll BEFORE the
// gap necessarily has last_seen ≤ polled_at < startTs, so it can never prove
// the gateway was alive ≥ startTs. Only a poll *after* gap-start can carry a
// last_seen value reaching into the gap. POST_GAP_LOOKAHEAD widens the
// upstream bound so a sub-poll-interval gap can be answered by the first
// poll after it lands.
const POST_GAP_LOOKAHEAD = 5 * 60;
export function gatewayOnlineDuringWindow(db, startTs, endTs, gatewayId = null) {
  const hi = endTs + POST_GAP_LOOKAHEAD;
  const rows = gatewayId
    ? db.prepare(`SELECT last_seen FROM gateway_status WHERE polled_at >= ? AND polled_at <= ? AND gateway_id = ?`).all(startTs, hi, gatewayId)
    : db.prepare(`SELECT last_seen FROM gateway_status WHERE polled_at >= ? AND polled_at <= ?`).all(startTs, hi);
  if (!rows.length) return null;
  for (const r of rows) {
    if (r.last_seen != null && r.last_seen >= startTs) return true;
  }
  return false;
}

// The sensor's "primary" gateway — the most-frequent first-segment of the
// readings.gateway_id field over the last `windowSecs` seconds. Returns
// null when no gateway-tagged readings exist (e.g. older readings predate
// the gateway_id column).
export function getSensorPrimaryGateway(db, sensorId, windowSecs = 7 * 86400) {
  const since = Math.floor(Date.now() / 1000) - windowSecs;
  const rows = db.prepare(`
    SELECT gateway_id FROM readings
    WHERE sensor_id = ? AND ts >= ? AND gateway_id IS NOT NULL
  `).all(sensorId, since);
  if (!rows.length) return null;
  const counts = new Map();
  for (const r of rows) {
    const first = r.gateway_id.split(';')[0];
    if (!first) continue;
    counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [id, n] of counts) if (n > bestN) { best = id; bestN = n; }
  return best;
}

export function getLatestTs(db, sensorId) {
  const row = db.prepare('SELECT MAX(ts) AS ts FROM readings WHERE sensor_id = ? AND excluded = 0').get(sensorId);
  return row?.ts ?? null;
}

// Returns array of { ts } for each newly inserted row.
export function insertReadings(db, sensorId, samples) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO readings (sensor_id, ts, temperature, humidity, baro_pressure, battery_voltage, gateway_id, dewpoint, vpd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        s.gateways            ?? null,
        s.dewpoint            ?? null,
        s.vpd                 ?? null,
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
  // Count non-excluded readings first. If zero, DELETE any existing row
  // rather than INSERT OR REPLACE-ing it with all-NULL aggregates and
  // sample_count = 0 — such "zombie" rows would show up in sparseHours
  // (sample_count < 20) on every gap query and trigger pointless backfills.
  const { n } = db.prepare(`
    SELECT COUNT(*) AS n FROM readings
    WHERE sensor_id = ? AND ts >= ? AND ts < ? AND excluded = 0
  `).get(sensorId, hourTs, hourTs + 3600);

  if (n === 0) {
    db.prepare(`DELETE FROM hourly_agg WHERE sensor_id = ? AND hour_ts = ?`).run(sensorId, hourTs);
    return;
  }

  // Preserve a manual setHourlyExcluded(..., true) override across recomputes —
  // INSERT OR REPLACE would otherwise silently flip excluded back to 0 on the
  // next late sample arriving in this hour.
  const existing = db.prepare(`SELECT excluded FROM hourly_agg WHERE sensor_id = ? AND hour_ts = ?`).get(sensorId, hourTs);
  const excluded = existing?.excluded ?? 0;

  db.prepare(`
    INSERT OR REPLACE INTO hourly_agg
      (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, dewpoint_avg, vpd_avg, sample_count, excluded)
    SELECT ?, ?,
      AVG(temperature), MIN(temperature), MAX(temperature),
      AVG(humidity),    MIN(humidity),    MAX(humidity),
      AVG(baro_pressure),
      AVG(dewpoint),
      AVG(vpd),
      COUNT(*),
      ?
    FROM readings
    WHERE sensor_id = ? AND ts >= ? AND ts < ? AND excluded = 0
  `).run(sensorId, hourTs, excluded, sensorId, hourTs, hourTs + 3600);
}

export function getSensors(db) {
  return db.prepare(`
    SELECT s.id, s.name, s.type, s.active, s.battery_voltage, s.alerts,
           s.rssi, s.address, s.device_id,
           r.temperature, r.humidity, r.baro_pressure, r.dewpoint, r.vpd,
           r.ts AS last_ts
    FROM sensors s
    LEFT JOIN readings r ON r.sensor_id = s.id
      AND r.ts = (SELECT MAX(ts) FROM readings WHERE sensor_id = s.id AND excluded = 0)
      AND r.excluded = 0
  `).all();
}

// Per-reading battery voltage history over the last `lookbackDays` days,
// non-null voltages only. Used to fit a discharge slope and project a
// replacement date. Returns `[{ ts, v }]` sorted by ts.
export function getBatteryHistory(db, sensorId, lookbackDays = 30) {
  const since = Math.floor(Date.now() / 1000) - lookbackDays * 86400;
  return db.prepare(`
    SELECT ts, battery_voltage AS v
    FROM readings
    WHERE sensor_id = ? AND ts >= ? AND battery_voltage IS NOT NULL
    ORDER BY ts
  `).all(sensorId, since);
}

// Fit a linear decline to daily-aggregated battery voltage and project the
// days remaining until it falls below the warn (2.7V), replace (2.5V), and
// critical (2.4V) thresholds.
//
// Method:
//   1. Average voltages per UTC day. Daily aggregation washes out the
//      diurnal cycle (CR2477 voltage dips a bit when the sensor's cold)
//      and gives the regression evenly-weighted points.
//   2. Detect battery replacement: if any day-over-day voltage jump is
//      > 0.2V upward, the cell was swapped — discard everything before
//      the most recent jump so the fit reflects the current cell only.
//   3. Fit voltage = slope·day + intercept by least squares. Project the
//      day on which voltage crosses each threshold and subtract today.
//
// Returns null when there's too little post-replacement data (<7 daily
// points) or the slope is non-negative (battery stable/rising — happens
// briefly after a fresh cell, or for sensors that just never discharge
// measurably over the window). A null forecast means "no projection
// possible right now", not "battery healthy" — callers should still
// inspect `currentV` for the absolute level.
export function computeBatteryForecast(samples) {
  if (!Array.isArray(samples) || samples.length < 7) return null;

  // Daily mean voltage, sorted by day.
  const byDay = new Map();
  for (const s of samples) {
    if (s.v == null) continue;
    const day = Math.floor(s.ts / 86400);
    const cur = byDay.get(day) || { sum: 0, n: 0 };
    cur.sum += s.v; cur.n++;
    byDay.set(day, cur);
  }
  const daily = [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, agg]) => ({ day, v: agg.sum / agg.n }));

  // Drop everything at or before the most recent ≥0.2V upward jump.
  let cutIdx = 0;
  for (let i = 1; i < daily.length; i++) {
    if (daily[i].v - daily[i - 1].v > 0.2) cutIdx = i;
  }
  const trimmed = daily.slice(cutIdx);
  if (trimmed.length < 7) return null;

  // Least-squares fit: v = slope·day + intercept.
  const xs = trimmed.map(d => d.day);
  const ys = trimmed.map(d => d.v);
  const xm = xs.reduce((a, b) => a + b, 0) / xs.length;
  const ym = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - xm) * (ys[i] - ym);
    den += (xs[i] - xm) ** 2;
  }
  if (den === 0) return null;
  const slope     = num / den;
  const intercept = ym - slope * xm;
  const currentV  = trimmed[trimmed.length - 1].v;
  const today     = Math.floor(Date.now() / 1000 / 86400);

  if (slope >= 0) {
    // No discharge detectable over the window.
    return {
      slopeVPerDay: slope,
      currentV,
      sampleDays:   trimmed.length,
      daysTo27:     null,
      daysTo25:     null,
      daysTo24:     null,
    };
  }

  // V_target = slope·day_target + intercept → day_target = (V_target − intercept) / slope
  const project = vTarget => {
    const dayTarget = (vTarget - intercept) / slope;
    return Math.max(0, dayTarget - today);
  };

  return {
    slopeVPerDay: slope,
    currentV,
    sampleDays:   trimmed.length,
    daysTo27:     project(2.7),
    daysTo25:     project(2.5),
    daysTo24:     project(2.4),
  };
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

// Optional `endTs` anchors the window at an arbitrary epoch (seconds) — used
// by the Stats YoY overlay to fetch the same `range` ending one calendar
// year ago. Omitted/null = anchor at "now" (the original behavior).
export function getHistory(db, sensorId, range, endTs = null) {
  const rangeSeconds = rangeToSeconds(range) ?? 86400;
  const end   = endTs != null ? endTs : Math.floor(Date.now() / 1000);
  const since = end - rangeSeconds;
  const unit  = rangeUnit(range) ?? 'h';

  if (unit === 'h') {
    return db.prepare(`
      SELECT ts, temperature, humidity, baro_pressure AS baroPressure, dewpoint, vpd,
             NULL AS tempMin, NULL AS tempMax, NULL AS humMin, NULL AS humMax
      FROM readings WHERE sensor_id = ? AND ts >= ? AND ts <= ? AND excluded = 0
      ORDER BY ts
    `).all(sensorId, since, end);
  }
  if (unit === 'd') {
    return db.prepare(`
      SELECT hour_ts AS ts, temp_avg AS temperature, hum_avg AS humidity, baro_avg AS baroPressure,
             dewpoint_avg AS dewpoint, vpd_avg AS vpd,
             temp_min AS tempMin, temp_max AS tempMax, hum_min AS humMin, hum_max AS humMax
      FROM hourly_agg WHERE sensor_id = ? AND hour_ts >= ? AND hour_ts <= ? AND excluded = 0
      ORDER BY hour_ts
    `).all(sensorId, since, end);
  }
  // yr → daily aggregates computed from hourly_agg (no schema change needed)
  return db.prepare(`
    SELECT (hour_ts / 86400 * 86400) AS ts,
           AVG(temp_avg) AS temperature, MIN(temp_min) AS tempMin, MAX(temp_max) AS tempMax,
           AVG(hum_avg)  AS humidity,    MIN(hum_min)  AS humMin,  MAX(hum_max)  AS humMax,
           AVG(baro_avg) AS baroPressure,
           AVG(dewpoint_avg) AS dewpoint, AVG(vpd_avg) AS vpd
    FROM hourly_agg WHERE sensor_id = ? AND hour_ts >= ? AND hour_ts <= ? AND excluded = 0
    GROUP BY (hour_ts / 86400 * 86400)
    ORDER BY ts
  `).all(sensorId, since, end);
}

// Oldest non-excluded reading ts across all sensors, or null when the DB is
// empty. The Stats YoY overlay uses this to decide whether the recorder has
// enough history (≥ 1 year) before offering the comparison.
export function getOldestReadingTs(db) {
  const row = db.prepare(`SELECT MIN(ts) AS ts FROM readings WHERE excluded = 0`).get();
  return row?.ts ?? null;
}

// Returns all readings including excluded ones — used by the data explorer UI.
export function getHistoryAll(db, sensorId, range) {
  const rangeSeconds = rangeToSeconds(range) ?? 86400;
  const since = Math.floor(Date.now() / 1000) - rangeSeconds;
  const unit  = rangeUnit(range) ?? 'h';

  if (unit === 'h') {
    return db.prepare(`
      SELECT ts, temperature, humidity, baro_pressure AS baroPressure, dewpoint, vpd,
             NULL AS tempMin, NULL AS tempMax, NULL AS humMin, NULL AS humMax, excluded
      FROM readings WHERE sensor_id = ? AND ts >= ?
      ORDER BY ts
    `).all(sensorId, since);
  }
  if (unit === 'd') {
    return db.prepare(`
      SELECT hour_ts AS ts, temp_avg AS temperature, hum_avg AS humidity, baro_avg AS baroPressure,
             dewpoint_avg AS dewpoint, vpd_avg AS vpd,
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
           AVG(baro_avg) AS baroPressure,
           AVG(dewpoint_avg) AS dewpoint, AVG(vpd_avg) AS vpd, 0 AS excluded
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

// Hourly-bucket exclusion is an explicit override that masks a whole hour
// from charts/aggregates without touching individual readings. The override
// survives subsequent recomputeHourlyAgg() calls — recompute reads the
// existing excluded flag and preserves it. The override is lost only if the
// hour empties out entirely (all underlying readings excluded), in which
// case recompute DELETEs the row.
export function setHourlyExcluded(db, sensorId, hourTs, excluded) {
  db.prepare('UPDATE hourly_agg SET excluded = ? WHERE sensor_id = ? AND hour_ts = ?')
    .run(excluded ? 1 : 0, sensorId, hourTs);
}

// Returns gap analysis for a sensor: missing windows + sparse hours + coverage %.
//
// Three classes of gap are detected:
//   1. Leading gap   — first reading is significantly after the window start
//                      (or no readings at all, in which case the whole window
//                      is one big gap)
//   2. Interior gaps — pairs of adjacent readings >5 min (or >1 hr at >24h
//                      ranges) apart, found via SQL window-function LAG
//   3. Trailing gap  — last reading is significantly before "now"
//
// Without (1)/(3) a dead sensor would silently report 100% coverage, since
// LAG-based detection only finds gaps *between* readings.
export function getGaps(db, sensorId, range) {
  const rangeSeconds = rangeToSeconds(range) ?? 604800;
  const now     = Math.floor(Date.now() / 1000);
  const startTs = now - rangeSeconds;
  const useRaw  = rangeSeconds <= 86400;
  // Gap-detection threshold: 5 min for raw resolution, 1 hr for hourly buckets.
  const gapThreshold = useRaw ? 300 : 3600;

  let gaps = [], sparseHours = [];

  if (useRaw) {
    gaps = db.prepare(`
      WITH r AS (
        SELECT ts, LAG(ts) OVER (ORDER BY ts) AS prev_ts
        FROM readings WHERE sensor_id = ? AND excluded = 0 AND ts >= ?
      )
      SELECT prev_ts AS startTs, ts AS endTs, ts - prev_ts AS durationSecs
      FROM r WHERE prev_ts IS NOT NULL AND ts - prev_ts > ?
      ORDER BY durationSecs DESC
    `).all(sensorId, startTs, gapThreshold);
  } else {
    gaps = db.prepare(`
      WITH h AS (
        SELECT hour_ts, LAG(hour_ts) OVER (ORDER BY hour_ts) AS prev_hour_ts
        FROM hourly_agg WHERE sensor_id = ? AND excluded = 0 AND hour_ts >= ?
      )
      SELECT prev_hour_ts AS startTs, hour_ts AS endTs, hour_ts - prev_hour_ts AS durationSecs
      FROM h WHERE prev_hour_ts IS NOT NULL AND hour_ts - prev_hour_ts > ?
      ORDER BY durationSecs DESC
    `).all(sensorId, startTs, gapThreshold);
  }

  // Sparse hours come from hourly_agg regardless of the chosen range —
  // even at raw-resolution ranges, "hours with fewer readings than expected"
  // is useful diagnostic info for the analytics view.
  sparseHours = db.prepare(`
    SELECT hour_ts AS hourTs, sample_count AS sampleCount
    FROM hourly_agg
    WHERE sensor_id = ? AND excluded = 0 AND hour_ts >= ? AND sample_count < 20
    ORDER BY sample_count ASC
  `).all(sensorId, startTs);

  // Detect leading + trailing gaps using min/max in the window.
  const bounds = useRaw
    ? db.prepare(`SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM readings  WHERE sensor_id = ? AND excluded = 0 AND ts      >= ?`).get(sensorId, startTs)
    : db.prepare(`SELECT MIN(hour_ts) AS lo, MAX(hour_ts) AS hi FROM hourly_agg WHERE sensor_id = ? AND excluded = 0 AND hour_ts >= ?`).get(sensorId, startTs);

  if (bounds.lo == null) {
    // No readings at all in the window — one big gap covering everything.
    gaps.push({ startTs, endTs: now, durationSecs: now - startTs });
  } else {
    if (bounds.lo - startTs > gapThreshold) {
      gaps.push({ startTs, endTs: bounds.lo, durationSecs: bounds.lo - startTs });
    }
    if (now - bounds.hi > gapThreshold) {
      gaps.push({ startTs: bounds.hi, endTs: now, durationSecs: now - bounds.hi });
    }
  }
  // Re-sort: leading/trailing additions may not have landed in duration order.
  gaps.sort((a, b) => b.durationSecs - a.durationSecs);

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

// ── Sensor pairs (drift detection) ──────────────────────────────────────────
// Pairs are user-defined "these two sensors are measuring the same thing".
// We compare them at the hourly_agg level (both sensors share the same
// hour_ts buckets, so alignment is trivial) and surface the delta + slope
// so calibration drift is obvious.

export function listSensorPairs(db) {
  return db.prepare(`
    SELECT p.id, p.sensor_a_id, p.sensor_b_id, p.label, p.created_at,
           sa.name AS sensor_a_name, sb.name AS sensor_b_name
    FROM sensor_pairs p
    LEFT JOIN sensors sa ON sa.id = p.sensor_a_id
    LEFT JOIN sensors sb ON sb.id = p.sensor_b_id
    ORDER BY p.created_at ASC, p.id ASC
  `).all();
}

export function getSensorPair(db, id) {
  return db.prepare(`SELECT id, sensor_a_id, sensor_b_id, label, created_at FROM sensor_pairs WHERE id = ?`).get(id);
}

// Returns the newly created row (incl. id), or throws on UNIQUE conflict.
export function createSensorPair(db, { sensorAId, sensorBId, label }) {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    INSERT INTO sensor_pairs (sensor_a_id, sensor_b_id, label, created_at)
    VALUES (?, ?, ?, ?)
  `).run(sensorAId, sensorBId, label ?? null, now);
  return getSensorPair(db, Number(result.lastInsertRowid));
}

export function deleteSensorPair(db, id) {
  const result = db.prepare(`DELETE FROM sensor_pairs WHERE id = ?`).run(id);
  return result.changes > 0;
}

// Pull aligned hourly deltas between two sensors over the given window.
// Both sensors must have a non-excluded hourly_agg row at the same hour_ts
// to contribute. Returns `[{ ts, deltaTemp, deltaHumidity }]` sorted by ts
// ascending. Empty array when either sensor has no overlap in the window.
export function getPairAlignedHourly(db, sensorAId, sensorBId, sinceTs) {
  return db.prepare(`
    SELECT a.hour_ts AS ts,
           a.temp_avg - b.temp_avg AS deltaTemp,
           a.hum_avg  - b.hum_avg  AS deltaHumidity
    FROM hourly_agg a
    JOIN hourly_agg b ON a.hour_ts = b.hour_ts AND b.sensor_id = ?
    WHERE a.sensor_id = ? AND a.hour_ts >= ?
      AND a.excluded = 0 AND b.excluded = 0
    ORDER BY a.hour_ts
  `).all(sensorBId, sensorAId, sinceTs);
}

// ── Events ───────────────────────────────────────────────────────────────
// User-annotated events overlaid on the Explorer chart. sensor_id NULL =
// global (shown on every chart); non-NULL = sensor-scoped.

export function createEvent(db, { ts, sensorId, label, note }) {
  const r = db.prepare(`
    INSERT INTO events (ts, sensor_id, label, note) VALUES (?, ?, ?, ?)
  `).run(ts, sensorId ?? null, label, note ?? null);
  return getEventById(db, r.lastInsertRowid);
}

export function getEventById(db, id) {
  return db.prepare(`SELECT id, ts, sensor_id AS sensorId, label, note FROM events WHERE id = ?`).get(id) ?? null;
}

// Filter by [from, to] ts bounds and/or sensor_id. When sensorId is provided,
// returns events for that sensor AND global events (sensor_id IS NULL) — the
// UI shows global events on every chart. Pass sensorId='__global__' to fetch
// only globals; omit the param to fetch everything.
export function listEvents(db, { from, to, sensorId } = {}) {
  const conds = [];
  const args  = [];
  if (from != null) { conds.push('ts >= ?'); args.push(from); }
  if (to   != null) { conds.push('ts <= ?'); args.push(to);   }
  if (sensorId === '__global__') {
    conds.push('sensor_id IS NULL');
  } else if (sensorId) {
    conds.push('(sensor_id = ? OR sensor_id IS NULL)');
    args.push(sensorId);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return db.prepare(`
    SELECT id, ts, sensor_id AS sensorId, label, note
    FROM events ${where}
    ORDER BY ts DESC
  `).all(...args);
}

export function updateEvent(db, id, patch) {
  const cur = getEventById(db, id);
  if (!cur) return null;
  const ts       = patch.ts       !== undefined ? patch.ts       : cur.ts;
  const sensorId = patch.sensorId !== undefined ? patch.sensorId : cur.sensorId;
  const label    = patch.label    !== undefined ? patch.label    : cur.label;
  const note     = patch.note     !== undefined ? patch.note     : cur.note;
  db.prepare(`UPDATE events SET ts = ?, sensor_id = ?, label = ?, note = ? WHERE id = ?`)
    .run(ts, sensorId ?? null, label, note ?? null, id);
  return getEventById(db, id);
}

export function deleteEvent(db, id) {
  const r = db.prepare(`DELETE FROM events WHERE id = ?`).run(id);
  return r.changes > 0;
}

// ── Notification state helpers ─────────────────────────────────────────────
// One row per (condition, target). Survives process restarts so the dedupe
// state machine in notifications.js can decide on transition→firing vs.
// transition→recovered after a crash or container redeploy.
export function getNotifState(db, key) {
  const row = db.prepare(`
    SELECT key, active, last_notified_at, last_transition_at, last_payload
    FROM notification_state WHERE key = ?
  `).get(key);
  if (!row) return null;
  return {
    key:              row.key,
    active:           !!row.active,
    lastNotifiedAt:   row.last_notified_at,
    lastTransitionAt: row.last_transition_at,
    lastPayload:      row.last_payload ? JSON.parse(row.last_payload) : null,
  };
}

export function setNotifState(db, key, { active, lastNotifiedAt, lastTransitionAt, lastPayload }) {
  db.prepare(`
    INSERT INTO notification_state (key, active, last_notified_at, last_transition_at, last_payload)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      active             = excluded.active,
      last_notified_at   = excluded.last_notified_at,
      last_transition_at = excluded.last_transition_at,
      last_payload       = excluded.last_payload
  `).run(
    key,
    active ? 1 : 0,
    lastNotifiedAt   ?? null,
    lastTransitionAt ?? null,
    lastPayload ? JSON.stringify(lastPayload) : null,
  );
}

export function listNotifStates(db) {
  return db.prepare(`SELECT key, active, last_notified_at, last_transition_at FROM notification_state`).all();
}

// 14-day per-hour-of-day baseline (mean + sample SD) for temperature and
// humidity from hourly_agg. Used by the anomaly evaluator on the latest
// reading — mirrors the UI's loadLiveBaselines() but reads aggregate rows
// already in the local DB. Returns null when the bucket has < 5 hours of
// data (not enough to estimate variance).
export function getHourlyBaseline(db, sensorId, hourOfDay, lookbackDays = 14) {
  const since = Math.floor(Date.now() / 1000) - lookbackDays * 86400;
  const rows = db.prepare(`
    SELECT temp_avg AS t, hum_avg AS h
    FROM hourly_agg
    WHERE sensor_id = ? AND excluded = 0 AND hour_ts >= ?
      AND ((hour_ts / 3600) % 24) = ?
  `).all(sensorId, since, hourOfDay);
  let tSum = 0, tSum2 = 0, tN = 0;
  let hSum = 0, hSum2 = 0, hN = 0;
  for (const r of rows) {
    if (r.t != null) { tSum += r.t; tSum2 += r.t * r.t; tN++; }
    if (r.h != null) { hSum += r.h; hSum2 += r.h * r.h; hN++; }
  }
  const sd = (sum, sum2, n) => {
    if (n < 2) return null;
    const v = Math.max(0, (sum2 - sum * sum / n) / (n - 1));
    return Math.sqrt(v);
  };
  return {
    tempMean: tN > 0 ? tSum / tN : null,
    tempSd:   sd(tSum, tSum2, tN),
    humMean:  hN > 0 ? hSum / hN : null,
    humSd:    sd(hSum, hSum2, hN),
    nT: tN, nH: hN,
  };
}

// ── Outdoor weather (Open-Meteo) ──────────────────────────────────────────
// Samples come in shaped as { ts, temp, humidity, dewpoint }. INSERT OR
// IGNORE makes overlapping fetches free, same as the sensor readings path.
// Returns the number of rows newly inserted (the rest were duplicates).
export function insertOutdoorReadings(db, samples) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO outdoor_readings (ts, temp, humidity, dewpoint)
    VALUES (?, ?, ?, ?)
  `);
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const s of samples) {
      if (s == null || !Number.isFinite(s.ts)) continue;
      const r = stmt.run(s.ts, s.temp ?? null, s.humidity ?? null, s.dewpoint ?? null);
      if (r.changes > 0) inserted++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return inserted;
}

// MAX(ts) of outdoor_readings, or null if empty. Mirrors getLatestTs.
export function getLatestOutdoorTs(db) {
  const row = db.prepare('SELECT MAX(ts) AS ts FROM outdoor_readings').get();
  return row?.ts ?? null;
}

// Hourly-cadence outdoor history over the same range parser used for sensor
// history. Returns [{ ts, temp, humidity, dewpoint }]. The shape mirrors
// getHistory's sensor rows so the UI can plot them on the same axes with
// minimal special-casing.
export function getOutdoorHistory(db, range) {
  const rangeSeconds = rangeToSeconds(range) ?? 86400;
  const since = Math.floor(Date.now() / 1000) - rangeSeconds;
  return db.prepare(`
    SELECT ts, temp, humidity, dewpoint
    FROM outdoor_readings
    WHERE ts >= ?
    ORDER BY ts
  `).all(since);
}

// Most recent outdoor reading, or null. Used by the live Stats panel.
export function getLatestOutdoorReading(db) {
  const row = db.prepare(`
    SELECT ts, temp, humidity, dewpoint
    FROM outdoor_readings
    ORDER BY ts DESC LIMIT 1
  `).get();
  return row ?? null;
}
