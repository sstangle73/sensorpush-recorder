// Outbound notification dispatch.
//
// Two sinks: generic JSON webhook (POST application/json) and ntfy.sh (POST
// text body with Title/Priority/Tags headers, optional bearer token).
//
// State machine: per-(condition, target) row in notification_state. A
// notification fires on the *transition* into the active state and again on
// the transition out (recovered). While the condition stays active, we
// don't re-notify — the user's phone shouldn't buzz every 5 minutes for a
// stuck-warm fridge. State is DB-backed so a container redeploy doesn't
// reset our memory of "this was already firing before the restart".
//
// Conditions evaluated each poll cycle:
//   - threshold:{sensorId}     — SensorPush alert thresholds (.alerts.{temperature,humidity})
//   - anomaly:{sensorId}       — hour-of-day baseline ±2σ
//   - sensor-offline:{sensorId} — last reading older than thresholdSecs
//   - gateway-offline:{gwId}   — last_seen older than thresholdSecs
//
// Sinks are independent: enabling webhook with ntfy disabled (or vice versa)
// works fine; both off short-circuits dispatch even if conditions are active
// (state machine still updates so the first notification after re-enabling
// fires on the next transition, not the current static state).

import fetch from 'node-fetch';
import { getNotifState, setNotifState, getHourlyBaseline } from './db.js';

// Same floors the Live tab uses — at very stable baselines a ±2σ trip would
// fire on natural minute-to-minute jitter, so we floor σ at a value bigger
// than typical short-term noise for each metric.
export const ANOMALY_TEMP_SD_FLOOR = 0.4;
export const ANOMALY_HUM_SD_FLOOR  = 1.0;

export const DEFAULT_SENSOR_OFFLINE_SECS  = 30 * 60;
export const DEFAULT_GATEWAY_OFFLINE_SECS = 15 * 60;

// ── Sink dispatchers ────────────────────────────────────────────────────────
//
// All dispatchers return { ok, error? } and never throw — caller logs
// per-sink failures but a webhook outage shouldn't propagate up and break
// the poll. AbortSignal.timeout caps the wait so a black-holed URL doesn't
// stall the loop for the full default Node fetch timeout.

export async function dispatchWebhook(url, payload, { timeoutMs = 8000 } = {}) {
  if (!url) return { ok: false, error: 'no webhook url' };
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || 'fetch failed' };
  }
}

export async function dispatchNtfy(url, payload, { token, timeoutMs = 8000 } = {}) {
  if (!url) return { ok: false, error: 'no ntfy url' };
  // ntfy reads the body as the message text; metadata rides in headers.
  // Priority: 4 (high) when firing, 3 (default) on recovery.
  const headers = {
    'Title':    payload.title || 'SensorPush',
    'Priority': payload.transition === 'firing' ? '4' : '3',
    'Tags':     payload.transition === 'firing' ? 'warning' : 'white_check_mark',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers,
      body:    payload.message || '',
      signal:  AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || 'fetch failed' };
  }
}

// Fan a single payload out to every enabled sink. Returns a per-sink result
// map; missing keys mean "sink not enabled / no URL configured".
export async function dispatchAll(payload, notifConfig) {
  const results = {};
  const wh = notifConfig?.webhook;
  if (wh?.enabled && wh.url) {
    results.webhook = await dispatchWebhook(wh.url, payload);
  }
  const nf = notifConfig?.ntfy;
  if (nf?.enabled && nf.url) {
    results.ntfy = await dispatchNtfy(nf.url, payload, { token: nf.token });
  }
  return results;
}

// ── State machine ──────────────────────────────────────────────────────────
//
// Pure function: given the previous DB state and whether the condition is
// currently active, returns one of:
//   'fire'    — was inactive, now active → send a firing notification
//   'recover' — was active, now inactive → send a recovery notification
//   'skip'    — no change → do nothing
//
// First-ever observation of an active condition is 'fire' (prev is null →
// wasActive=false). First-ever observation of an inactive condition is
// 'skip' (no false alarms on startup).
export function decideTransition(prev, isActive) {
  const wasActive = !!(prev && prev.active);
  if (isActive && !wasActive) return 'fire';
  if (!isActive && wasActive) return 'recover';
  return 'skip';
}

// Apply the transition: build the payload, dispatch to enabled sinks,
// persist the new state. `buildEvent(transition)` is a caller-supplied
// closure that produces { title, message, detail } based on whether we're
// firing or recovering — keeps the threshold/anomaly/offline event shapes
// flexible without bloating this function's signature.
export async function evaluateAndNotify(db, key, isActive, buildEvent, notifConfig) {
  const prev       = getNotifState(db, key);
  const transition = decideTransition(prev, isActive);
  if (transition === 'skip') {
    return { transition, dispatched: null, payload: null };
  }
  const event = buildEvent(transition);
  const payload = {
    timestamp:   new Date().toISOString(),
    key,
    transition,
    ...event,
  };
  const dispatched = await dispatchAll(payload, notifConfig);
  const now = Math.floor(Date.now() / 1000);
  setNotifState(db, key, {
    active:           isActive,
    lastNotifiedAt:   now,
    lastTransitionAt: now,
    lastPayload:      payload,
  });
  return { transition, dispatched, payload };
}

// ── Condition evaluators ────────────────────────────────────────────────────
//
// Each returns either null (no breach) or an array of human-readable detail
// strings describing every active breach for the sensor. The aggregate
// is-active boolean is "any details non-empty".

// Mirrors the UI's alertBreaches(). Reads the same SensorPush alerts blob
// the cloud returns on /devices/sensors and compares the latest reading
// against the configured min/max for each metric where alerts.enabled.
export function evaluateThreshold(sensor) {
  const a = sensor.alerts;
  if (!a) return [];
  const out = [];
  if (a.temperature?.enabled && sensor.temperature != null) {
    if (a.temperature.min != null && sensor.temperature < a.temperature.min)
      out.push(`T ${sensor.temperature.toFixed(1)}°F < ${a.temperature.min}°F`);
    if (a.temperature.max != null && sensor.temperature > a.temperature.max)
      out.push(`T ${sensor.temperature.toFixed(1)}°F > ${a.temperature.max}°F`);
  }
  if (a.humidity?.enabled && sensor.humidity != null) {
    if (a.humidity.min != null && sensor.humidity < a.humidity.min)
      out.push(`RH ${Math.round(sensor.humidity)}% < ${a.humidity.min}%`);
    if (a.humidity.max != null && sensor.humidity > a.humidity.max)
      out.push(`RH ${Math.round(sensor.humidity)}% > ${a.humidity.max}%`);
  }
  return out;
}

// Mirrors the UI's anomaliesForSensor(). Compares the latest reading
// against the 14-day per-hour-of-day baseline; flags any metric whose
// deviation exceeds 2σ (with an absolute SD floor to avoid spurious
// firings on naturally-quiet sensors).
export function evaluateAnomaly(db, sensor, { nowMs = Date.now() } = {}) {
  if (sensor.temperature == null && sensor.humidity == null) return [];
  const hour = new Date(nowMs).getHours();
  const b = getHourlyBaseline(db, sensor.id, hour, 14);
  const out = [];
  if (sensor.temperature != null && b.tempMean != null && b.tempSd != null && b.nT >= 5) {
    const sd  = Math.max(b.tempSd, ANOMALY_TEMP_SD_FLOOR);
    const dev = sensor.temperature - b.tempMean;
    if (Math.abs(dev) >= 2 * sd) {
      const dir = dev > 0 ? 'warm' : 'cool';
      out.push(`T ${sensor.temperature.toFixed(1)}°F unusually ${dir} for ${hour}:00 (baseline ${b.tempMean.toFixed(1)}°F ±${b.tempSd.toFixed(1)}, n=${b.nT})`);
    }
  }
  if (sensor.humidity != null && b.humMean != null && b.humSd != null && b.nH >= 5) {
    const sd  = Math.max(b.humSd, ANOMALY_HUM_SD_FLOOR);
    const dev = sensor.humidity - b.humMean;
    if (Math.abs(dev) >= 2 * sd) {
      const dir = dev > 0 ? 'humid' : 'dry';
      out.push(`RH ${Math.round(sensor.humidity)}% unusually ${dir} for ${hour}:00 (baseline ${Math.round(b.humMean)}% ±${b.humSd.toFixed(1)}, n=${b.nH})`);
    }
  }
  return out;
}

// True when `lastTs` is null or older than thresholdSecs ago.
export function isOffline(lastTs, thresholdSecs, nowSecs) {
  if (lastTs == null) return true;
  return (nowSecs - lastTs) > thresholdSecs;
}

// ── Top-level runner ────────────────────────────────────────────────────────
//
// Called once per poll cycle from poller.js. Pulls live sensor/gateway state
// from the DB (so the eval sees the data the poll just wrote), walks every
// configured condition, and dispatches transitions through evaluateAndNotify.
//
// Errors per-sensor are caught so one bad config can't break the rest of
// the run. Returns a summary array for logging/debug.
export async function runNotifications(db, { sensors, gateways, notifConfig, nowMs = Date.now() } = {}) {
  if (!notifConfig?.enabled) return [];
  const conditions = notifConfig.conditions || {};
  const results    = [];
  const nowSecs    = Math.floor(nowMs / 1000);

  for (const s of (sensors || [])) {
    // Threshold breach
    if (conditions.threshold?.enabled) {
      try {
        const breaches = evaluateThreshold(s);
        const active   = breaches.length > 0;
        const r = await evaluateAndNotify(
          db,
          `threshold:${s.id}`,
          active,
          (transition) => transition === 'fire'
            ? { title: `[Alert] ${s.name} out of bounds`,
                message: `${s.name} is outside configured thresholds:\n${breaches.join('\n')}`,
                detail: { sensorId: s.id, sensorName: s.name, breaches } }
            : { title: `[Recovered] ${s.name} back in bounds`,
                message: `${s.name} is back within configured thresholds.`,
                detail: { sensorId: s.id, sensorName: s.name } },
          notifConfig,
        );
        results.push({ kind: 'threshold', sensorId: s.id, ...r });
      } catch (e) { console.error('[notif] threshold error', s.id, e?.message); }
    }

    // Anomaly (hour-of-day baseline)
    if (conditions.anomaly?.enabled) {
      try {
        const anomalies = evaluateAnomaly(db, s, { nowMs });
        const active    = anomalies.length > 0;
        const r = await evaluateAndNotify(
          db,
          `anomaly:${s.id}`,
          active,
          (transition) => transition === 'fire'
            ? { title: `[Anomaly] ${s.name}`,
                message: `${s.name} reads outside its typical pattern:\n${anomalies.join('\n')}`,
                detail: { sensorId: s.id, sensorName: s.name, anomalies } }
            : { title: `[Recovered] ${s.name} back to typical`,
                message: `${s.name} is back within its typical pattern.`,
                detail: { sensorId: s.id, sensorName: s.name } },
          notifConfig,
        );
        results.push({ kind: 'anomaly', sensorId: s.id, ...r });
      } catch (e) { console.error('[notif] anomaly error', s.id, e?.message); }
    }

    // Sensor offline (last reading too old)
    if (conditions.sensorOffline?.enabled) {
      try {
        const thresholdSecs = conditions.sensorOffline.thresholdSecs ?? DEFAULT_SENSOR_OFFLINE_SECS;
        const active = isOffline(s.lastTs ?? null, thresholdSecs, nowSecs);
        const r = await evaluateAndNotify(
          db,
          `sensor-offline:${s.id}`,
          active,
          (transition) => transition === 'fire'
            ? { title: `[Offline] ${s.name}`,
                message: `${s.name} has not reported in ${Math.round(thresholdSecs / 60)} min.`,
                detail: { sensorId: s.id, sensorName: s.name, lastTs: s.lastTs } }
            : { title: `[Recovered] ${s.name} reporting again`,
                message: `${s.name} is reporting again.`,
                detail: { sensorId: s.id, sensorName: s.name } },
          notifConfig,
        );
        results.push({ kind: 'sensor-offline', sensorId: s.id, ...r });
      } catch (e) { console.error('[notif] sensor-offline error', s.id, e?.message); }
    }
  }

  // Gateway offline
  if (conditions.gatewayOffline?.enabled) {
    const thresholdSecs = conditions.gatewayOffline.thresholdSecs ?? DEFAULT_GATEWAY_OFFLINE_SECS;
    for (const g of (gateways || [])) {
      try {
        const active = isOffline(g.lastSeen ?? null, thresholdSecs, nowSecs);
        const r = await evaluateAndNotify(
          db,
          `gateway-offline:${g.id}`,
          active,
          (transition) => transition === 'fire'
            ? { title: `[Offline] Gateway ${g.name}`,
                message: `Gateway "${g.name}" has not been seen in ${Math.round(thresholdSecs / 60)} min.`,
                detail: { gatewayId: g.id, gatewayName: g.name, lastSeen: g.lastSeen } }
            : { title: `[Recovered] Gateway ${g.name} online`,
                message: `Gateway "${g.name}" is online again.`,
                detail: { gatewayId: g.id, gatewayName: g.name } },
          notifConfig,
        );
        results.push({ kind: 'gateway-offline', gatewayId: g.id, ...r });
      } catch (e) { console.error('[notif] gateway-offline error', g.id, e?.message); }
    }
  }

  return results;
}

// ── Settings validation ────────────────────────────────────────────────────
// Exported so server.js's PUT /settings can reject bad payloads before they
// touch the meta JSON blob. Shape:
//   {
//     enabled: bool,
//     webhook: { enabled: bool, url: string },
//     ntfy:    { enabled: bool, url: string, token?: string },
//     conditions: {
//       threshold:       { enabled: bool },
//       anomaly:         { enabled: bool },
//       sensorOffline:   { enabled: bool, thresholdSecs: number },
//       gatewayOffline:  { enabled: bool, thresholdSecs: number },
//     },
//   }
function _isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function _isBool(v)        { return v == null || typeof v === 'boolean'; }
function _isStr(v)         { return v == null || typeof v === 'string'; }
function _isPosNum(v)      { return v == null || (typeof v === 'number' && isFinite(v) && v > 0); }

export function validateNotifConfig(c) {
  if (c == null) return true;
  if (!_isPlainObject(c)) return false;
  for (const k of Object.keys(c)) {
    if (!['enabled', 'webhook', 'ntfy', 'conditions'].includes(k)) return false;
  }
  if (!_isBool(c.enabled)) return false;
  for (const sinkKey of ['webhook', 'ntfy']) {
    if (c[sinkKey] === undefined) continue;
    if (c[sinkKey] === null) continue;
    if (!_isPlainObject(c[sinkKey])) return false;
    for (const k of Object.keys(c[sinkKey])) {
      if (!['enabled', 'url', 'token'].includes(k)) return false;
    }
    if (!_isBool(c[sinkKey].enabled)) return false;
    if (!_isStr(c[sinkKey].url))      return false;
    if (sinkKey === 'ntfy' && !_isStr(c[sinkKey].token)) return false;
    if (sinkKey === 'webhook' && c[sinkKey].token !== undefined) return false;
  }
  if (c.conditions !== undefined && c.conditions !== null) {
    if (!_isPlainObject(c.conditions)) return false;
    for (const k of Object.keys(c.conditions)) {
      if (!['threshold', 'anomaly', 'sensorOffline', 'gatewayOffline'].includes(k)) return false;
      const v = c.conditions[k];
      if (v == null) continue;
      if (!_isPlainObject(v)) return false;
      for (const k2 of Object.keys(v)) {
        if (!['enabled', 'thresholdSecs'].includes(k2)) return false;
      }
      if (!_isBool(v.enabled)) return false;
      if (!_isPosNum(v.thresholdSecs)) return false;
    }
  }
  return true;
}
