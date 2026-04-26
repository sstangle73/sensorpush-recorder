import fetch from 'node-fetch';

const SP_BASE = 'https://api.sensorpush.com/api/v1';

let _tokenCache = { token: null, expires: 0 };

// Returns a valid access token (cached), or null on failure.
export async function getToken(email, password) {
  if (_tokenCache.token && _tokenCache.expires > Date.now() + 60_000) {
    return _tokenCache.token;
  }
  try {
    // Step 1: email + password → authorization code
    const r1 = await fetch(`${SP_BASE}/oauth/authorize`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify({ email, password }),
      signal:  AbortSignal.timeout(12000),
    });
    if (!r1.ok) return null;
    const body1 = await r1.json();
    if (!body1.authorization) return null;

    // Step 2: authorization code → access token (12h TTL, cache for 11h)
    const r2 = await fetch(`${SP_BASE}/oauth/accesstoken`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify({ authorization: body1.authorization }),
      signal:  AbortSignal.timeout(12000),
    });
    if (!r2.ok) return null;
    const body2 = await r2.json();
    if (!body2.accesstoken) return null;

    _tokenCache = { token: body2.accesstoken, expires: Date.now() + 11 * 3600 * 1000 };
    return _tokenCache.token;
  } catch (_) {
    return null;
  }
}

// Returns array of { id, name, type, active, batteryVoltage }.
export async function fetchSensors(token) {
  const r = await fetch(`${SP_BASE}/devices/sensors`, {
    method:  'POST',
    headers: { 'Authorization': token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body:    '{}',
    signal:  AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`sensors HTTP ${r.status}`);
  const data = await r.json();
  return Object.entries(data).map(([id, s]) => ({
    id,
    name:           s.name           || id,
    type:           s.type           || null,
    active:         s.active         !== false,
    batteryVoltage: s.battery_voltage ?? null,
    alerts:         s.alerts         ?? null,
  }));
}

// Returns raw samples array for one sensor between startTs and stopTs (epoch seconds).
export async function fetchSamples(token, { sensorId, startTs, stopTs }) {
  const stop  = stopTs  ? new Date(stopTs  * 1000) : new Date();
  const start = startTs ? new Date(startTs * 1000) : new Date(stop - 24 * 3600 * 1000);
  const r = await fetch(`${SP_BASE}/samples`, {
    method:  'POST',
    headers: { 'Authorization': token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body:    JSON.stringify({
      startTime: start.toISOString(),
      stopTime:  stop.toISOString(),
      limit:     10000,
      sensors:   [sensorId],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`samples HTTP ${r.status}`);
  const data = await r.json();
  return data.sensors?.[sensorId] || [];
}

// Exposed for testing: reset the in-memory token cache.
export function _resetTokenCache() {
  _tokenCache = { token: null, expires: 0 };
}
