// Tests for the outbound notification dispatch + state machine.
//
// Mocks node-fetch the same way sensorpush.test.js does so we never make
// real network calls. State-machine tests exercise the DB-backed dedupe
// (transition→firing fires once, second poll while still active is a no-op,
// transition→inactive fires recovery, then stays quiet again).

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('node-fetch', () => ({ default: vi.fn() }));
import fetch from 'node-fetch';

import { openDb, upsertSensors, insertReadings, recomputeHourlyAgg, getNotifState } from '../db.js';
import {
  dispatchWebhook, dispatchNtfy, dispatchAll,
  decideTransition, evaluateAndNotify,
  evaluateThreshold, evaluateAnomaly, isOffline,
  validateNotifConfig, runNotifications,
} from '../notifications.js';

function jsonResp(data = null, status = 200) {
  return {
    ok:   status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => '',
  };
}

function makeDb() { return openDb(':memory:'); }

beforeEach(() => {
  vi.clearAllMocks();
});

// ── dispatch* ──────────────────────────────────────────────────────────────

describe('dispatchWebhook', () => {
  const payload = { title: 't', message: 'm', transition: 'firing' };

  it('returns {ok:false} when url is empty', async () => {
    const r = await dispatchWebhook('', payload);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no webhook url/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('POSTs JSON to the configured URL', async () => {
    fetch.mockResolvedValueOnce(jsonResp({}, 200));
    const r = await dispatchWebhook('https://example.com/hook', payload);
    expect(r.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toMatchObject({ title: 't', message: 'm' });
  });

  it('surfaces a non-OK HTTP response', async () => {
    fetch.mockResolvedValueOnce(jsonResp({}, 502));
    const r = await dispatchWebhook('https://example.com/hook', payload);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('HTTP 502');
  });

  it('catches fetch failures and returns {ok:false}', async () => {
    fetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const r = await dispatchWebhook('https://example.com/hook', payload);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
  });
});

describe('dispatchNtfy', () => {
  const firing  = { title: 'T', message: 'M', transition: 'firing' };
  const recover = { title: 'T', message: 'M', transition: 'recovered' };

  it('sends Title/Priority/Tags headers and the message as the body', async () => {
    fetch.mockResolvedValueOnce(jsonResp({}, 200));
    await dispatchNtfy('https://ntfy.sh/topic', firing);
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe('https://ntfy.sh/topic');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Title']).toBe('T');
    expect(opts.headers['Priority']).toBe('4');
    expect(opts.headers['Tags']).toBe('warning');
    expect(opts.body).toBe('M');
  });

  it('uses lower priority + checkmark tag for recovery events', async () => {
    fetch.mockResolvedValueOnce(jsonResp({}, 200));
    await dispatchNtfy('https://ntfy.sh/topic', recover);
    const opts = fetch.mock.calls[0][1];
    expect(opts.headers['Priority']).toBe('3');
    expect(opts.headers['Tags']).toMatch(/check_mark|white_check_mark/);
  });

  it('adds Authorization: Bearer when a token is provided', async () => {
    fetch.mockResolvedValueOnce(jsonResp({}, 200));
    await dispatchNtfy('https://ntfy.sh/topic', firing, { token: 'abc' });
    expect(fetch.mock.calls[0][1].headers['Authorization']).toBe('Bearer abc');
  });

  it('omits Authorization when no token', async () => {
    fetch.mockResolvedValueOnce(jsonResp({}, 200));
    await dispatchNtfy('https://ntfy.sh/topic', firing);
    expect(fetch.mock.calls[0][1].headers['Authorization']).toBeUndefined();
  });

  it('returns {ok:false} when url is empty', async () => {
    const r = await dispatchNtfy('', firing);
    expect(r.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('surfaces non-OK HTTP responses', async () => {
    fetch.mockResolvedValueOnce(jsonResp({}, 401));
    const r = await dispatchNtfy('https://ntfy.sh/topic', firing);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('HTTP 401');
  });
});

describe('dispatchAll', () => {
  const payload = { title: 't', message: 'm', transition: 'firing' };

  it('skips sinks where enabled=false or url is missing', async () => {
    const r = await dispatchAll(payload, {
      webhook: { enabled: false, url: 'https://x/y' },
      ntfy:    { enabled: true,  url: '' },
    });
    expect(r).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });

  it('hits both sinks when both are configured + enabled', async () => {
    fetch.mockResolvedValue(jsonResp({}, 200));
    const r = await dispatchAll(payload, {
      webhook: { enabled: true, url: 'https://x/y' },
      ntfy:    { enabled: true, url: 'https://ntfy.sh/z', token: 't' },
    });
    expect(r.webhook.ok).toBe(true);
    expect(r.ntfy.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports a sink failure independently of the other', async () => {
    fetch
      .mockResolvedValueOnce(jsonResp({}, 200))   // webhook OK
      .mockResolvedValueOnce(jsonResp({}, 500));  // ntfy fails
    const r = await dispatchAll(payload, {
      webhook: { enabled: true, url: 'https://x/y' },
      ntfy:    { enabled: true, url: 'https://ntfy.sh/z' },
    });
    expect(r.webhook.ok).toBe(true);
    expect(r.ntfy.ok).toBe(false);
    expect(r.ntfy.error).toBe('HTTP 500');
  });
});

// ── decideTransition ───────────────────────────────────────────────────────

describe('decideTransition', () => {
  it('returns "fire" on first-ever active observation (no prev state)', () => {
    expect(decideTransition(null, true)).toBe('fire');
  });

  it('returns "skip" on first-ever inactive observation (no false alarm)', () => {
    expect(decideTransition(null, false)).toBe('skip');
  });

  it('returns "fire" when prev was inactive and we are now active', () => {
    expect(decideTransition({ active: false }, true)).toBe('fire');
  });

  it('returns "recover" when prev was active and we are now inactive', () => {
    expect(decideTransition({ active: true }, false)).toBe('recover');
  });

  it('returns "skip" when prev was active and we are still active (no re-buzz)', () => {
    expect(decideTransition({ active: true }, true)).toBe('skip');
  });

  it('returns "skip" when prev was inactive and we are still inactive', () => {
    expect(decideTransition({ active: false }, false)).toBe('skip');
  });
});

// ── evaluateAndNotify (state machine + dispatch integration) ───────────────

describe('evaluateAndNotify — dedupe + recovery edges', () => {
  const config = {
    enabled: true,
    webhook: { enabled: true, url: 'https://x/y' },
  };
  const buildEvent = transition => transition === 'fire'
    ? { title: 'firing', message: 'oh no' }
    : { title: 'recovered', message: 'all good' };

  it('dispatches on transition→active (first time)', async () => {
    fetch.mockResolvedValue(jsonResp({}, 200));
    const db = makeDb();
    const r = await evaluateAndNotify(db, 'cond:s1', true, buildEvent, config);
    expect(r.transition).toBe('fire');
    expect(r.dispatched.webhook.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const state = getNotifState(db, 'cond:s1');
    expect(state.active).toBe(true);
    expect(state.lastNotifiedAt).toBeGreaterThan(0);
  });

  it('does NOT dispatch on a second active observation (stuck condition)', async () => {
    fetch.mockResolvedValue(jsonResp({}, 200));
    const db = makeDb();
    await evaluateAndNotify(db, 'cond:s1', true, buildEvent, config);
    fetch.mockClear();
    const r = await evaluateAndNotify(db, 'cond:s1', true, buildEvent, config);
    expect(r.transition).toBe('skip');
    expect(r.dispatched).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('dispatches once on transition→inactive (recovery)', async () => {
    fetch.mockResolvedValue(jsonResp({}, 200));
    const db = makeDb();
    await evaluateAndNotify(db, 'cond:s1', true, buildEvent, config);
    fetch.mockClear();
    const r = await evaluateAndNotify(db, 'cond:s1', false, buildEvent, config);
    expect(r.transition).toBe('recover');
    expect(r.dispatched.webhook.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const state = getNotifState(db, 'cond:s1');
    expect(state.active).toBe(false);
  });

  it('does NOT dispatch when persistently inactive (post-recovery)', async () => {
    fetch.mockResolvedValue(jsonResp({}, 200));
    const db = makeDb();
    await evaluateAndNotify(db, 'cond:s1', true,  buildEvent, config);
    await evaluateAndNotify(db, 'cond:s1', false, buildEvent, config);
    fetch.mockClear();
    const r = await evaluateAndNotify(db, 'cond:s1', false, buildEvent, config);
    expect(r.transition).toBe('skip');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does NOT dispatch on first observation when inactive (no startup buzz)', async () => {
    const db = makeDb();
    const r = await evaluateAndNotify(db, 'cond:s1', false, buildEvent, config);
    expect(r.transition).toBe('skip');
    expect(r.dispatched).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('persists state across "process restarts" (survives reload from DB)', async () => {
    fetch.mockResolvedValue(jsonResp({}, 200));
    const db = makeDb();
    await evaluateAndNotify(db, 'cond:s1', true, buildEvent, config);

    // Simulate restart: state remains in the DB and a new active obs is no-op.
    fetch.mockClear();
    const r = await evaluateAndNotify(db, 'cond:s1', true, buildEvent, config);
    expect(r.transition).toBe('skip');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('records the firing transition even when dispatch fails', async () => {
    // Important: state machine must advance even on dispatch failure, so a
    // single transient outage doesn't cause infinite re-firing every poll.
    fetch.mockResolvedValue(jsonResp({}, 500));
    const db = makeDb();
    const r = await evaluateAndNotify(db, 'cond:s1', true, buildEvent, config);
    expect(r.transition).toBe('fire');
    expect(r.dispatched.webhook.ok).toBe(false);
    expect(getNotifState(db, 'cond:s1').active).toBe(true);

    // Next active observation does NOT re-fire (we already counted it as firing).
    fetch.mockClear();
    const r2 = await evaluateAndNotify(db, 'cond:s1', true, buildEvent, config);
    expect(r2.transition).toBe('skip');
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── Condition evaluators ──────────────────────────────────────────────────

describe('evaluateThreshold', () => {
  it('returns [] when sensor has no alerts configured', () => {
    expect(evaluateThreshold({ alerts: null, temperature: 70 })).toEqual([]);
  });

  it('returns [] when alerts present but disabled', () => {
    const s = {
      temperature: 100,
      alerts: { temperature: { enabled: false, min: 60, max: 80 } },
    };
    expect(evaluateThreshold(s)).toEqual([]);
  });

  it('flags T over max', () => {
    const s = {
      temperature: 100,
      alerts: { temperature: { enabled: true, max: 80 } },
    };
    const breaches = evaluateThreshold(s);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatch(/100.0.* > 80/);
  });

  it('flags T under min', () => {
    const s = {
      temperature: 30,
      alerts: { temperature: { enabled: true, min: 60 } },
    };
    const breaches = evaluateThreshold(s);
    expect(breaches[0]).toMatch(/30.0.* < 60/);
  });

  it('flags H over max', () => {
    const s = {
      humidity: 85,
      alerts: { humidity: { enabled: true, max: 60 } },
    };
    expect(evaluateThreshold(s)[0]).toMatch(/85.*> 60/);
  });

  it('does not flag when value is null (missing reading)', () => {
    const s = {
      temperature: null,
      alerts: { temperature: { enabled: true, max: 80 } },
    };
    expect(evaluateThreshold(s)).toEqual([]);
  });

  it('returns multiple breaches when both T and H are out of bounds', () => {
    const s = {
      temperature: 100, humidity: 90,
      alerts: {
        temperature: { enabled: true, max: 80 },
        humidity:    { enabled: true, max: 60 },
      },
    };
    expect(evaluateThreshold(s)).toHaveLength(2);
  });
});

describe('isOffline', () => {
  it('treats null lastTs as offline', () => {
    expect(isOffline(null, 600, 1000)).toBe(true);
  });

  it('returns true when lastTs is older than threshold', () => {
    expect(isOffline(1000, 600, 2000)).toBe(true);   // 1000s old, threshold 600
  });

  it('returns false when lastTs is within threshold', () => {
    expect(isOffline(1500, 600, 2000)).toBe(false);  // 500s old, threshold 600
  });

  it('returns false at exactly the threshold (strict > check)', () => {
    expect(isOffline(1400, 600, 2000)).toBe(false);  // 600s old, threshold 600
  });
});

describe('evaluateAnomaly', () => {
  // Build N hours of identical T/H so the baseline has small SD, then flag a
  // current reading far outside it. We populate hourly_agg directly.
  function seedBaseline(db, sensorId, hourOfDay, temp, hum, days = 14) {
    const now = Math.floor(Date.now() / 1000);
    upsertSensors(db, [{ id: sensorId, name: sensorId, type: 'HT1', active: true, batteryVoltage: 2.9 }]);
    for (let d = 0; d < days; d++) {
      // Each "day d" hour-of-day = hourOfDay. Pick a recent week.
      const hourTs = Math.floor((now - d * 86400) / 3600) * 3600;
      // Adjust so (hourTs / 3600) % 24 === hourOfDay
      const offsetHrs = ((hourTs / 3600) % 24) - hourOfDay;
      const aligned   = hourTs - offsetHrs * 3600;
      db.prepare(`
        INSERT OR REPLACE INTO hourly_agg
          (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count, excluded)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 12, 0)
      `).run(sensorId, aligned, temp, temp - 0.1, temp + 0.1, hum, hum - 0.5, hum + 0.5);
    }
  }

  it('returns [] when no baseline data exists', () => {
    const db = makeDb();
    upsertSensors(db, [{ id: 'sx', name: 'X', type: 'HT1', active: true, batteryVoltage: 2.9 }]);
    const r = evaluateAnomaly(db, { id: 'sx', temperature: 70, humidity: 50 });
    expect(r).toEqual([]);
  });

  it('returns [] when current reading is close to baseline (within 2σ)', () => {
    const db = makeDb();
    // Build the baseline at the current hour-of-day
    const hourOfDay = new Date().getHours();
    seedBaseline(db, 'sa', hourOfDay, 70, 50);
    const r = evaluateAnomaly(db, { id: 'sa', temperature: 70.1, humidity: 50.1 });
    expect(r).toEqual([]);
  });

  it('flags a reading far above baseline as "warm"', () => {
    const db = makeDb();
    const hourOfDay = new Date().getHours();
    seedBaseline(db, 'sb', hourOfDay, 70, 50);
    // 90°F vs baseline 70°F (SD ~0, floored at 0.4 → 2σ = 0.8). 20°F is way outside.
    const r = evaluateAnomaly(db, { id: 'sb', temperature: 90, humidity: 50 });
    expect(r.length).toBeGreaterThan(0);
    expect(r.some(s => /warm/.test(s))).toBe(true);
  });

  it('flags a reading far below baseline as "cool"', () => {
    const db = makeDb();
    const hourOfDay = new Date().getHours();
    seedBaseline(db, 'sc', hourOfDay, 70, 50);
    const r = evaluateAnomaly(db, { id: 'sc', temperature: 40, humidity: 50 });
    expect(r.some(s => /cool/.test(s))).toBe(true);
  });

  it('flags humidity anomalies independently of temperature', () => {
    const db = makeDb();
    const hourOfDay = new Date().getHours();
    seedBaseline(db, 'sd', hourOfDay, 70, 50);
    const r = evaluateAnomaly(db, { id: 'sd', temperature: 70, humidity: 90 });
    expect(r.some(s => /humid/.test(s))).toBe(true);
  });

  it('sigma scales the trip threshold', () => {
    const db = makeDb();
    const hourOfDay = new Date().getHours();
    seedBaseline(db, 'sig', hourOfDay, 70, 50);  // flat baseline → SD floored to 0.4°F
    // dev = 1.0°F. 2σ band = 0.8°F (trips); 3σ band = 1.2°F (does not).
    expect(evaluateAnomaly(db, { id: 'sig', temperature: 71, humidity: 50 }, { sigma: 2 })
      .some(s => /warm/.test(s))).toBe(true);
    expect(evaluateAnomaly(db, { id: 'sig', temperature: 71, humidity: 50 }, { sigma: 3 }))
      .toEqual([]);
  });

  it('defaults to 3σ when sigma is not supplied', () => {
    const db = makeDb();
    const hourOfDay = new Date().getHours();
    seedBaseline(db, 'def', hourOfDay, 70, 50);
    // dev = 1.0°F is inside the default 3σ band (1.2°F) → no trip.
    expect(evaluateAnomaly(db, { id: 'def', temperature: 71, humidity: 50 })).toEqual([]);
  });
});

// ── dwell-time gating ────────────────────────────────────────────────────────

describe('evaluateAndNotify dwell gating', () => {
  const cfg   = { enabled: true, webhook: { enabled: true, url: 'https://x' } };
  const build = (t) => ({ title: `t ${t}`, message: 'm' });

  it('does not fire until the condition has been active for dwellSecs', async () => {
    fetch.mockResolvedValue(jsonResp({}, 200));
    const db = makeDb();
    const t0 = 1_000_000;

    const r1 = await evaluateAndNotify(db, 'anomaly:s1', true, build, cfg, { dwellSecs: 1800, nowMs: t0 * 1000 });
    expect(r1.transition).toBe('pending');
    expect(fetch).not.toHaveBeenCalled();

    const r2 = await evaluateAndNotify(db, 'anomaly:s1', true, build, cfg, { dwellSecs: 1800, nowMs: (t0 + 900) * 1000 });
    expect(r2.transition).toBe('pending');
    expect(fetch).not.toHaveBeenCalled();

    const r3 = await evaluateAndNotify(db, 'anomaly:s1', true, build, cfg, { dwellSecs: 1800, nowMs: (t0 + 1860) * 1000 });
    expect(r3.transition).toBe('fire');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('disarms pending on a transient and restarts the window on the next spike', async () => {
    fetch.mockResolvedValue(jsonResp({}, 200));
    const db = makeDb();
    const t0 = 2_000_000;

    await evaluateAndNotify(db, 'anomaly:s2', true,  build, cfg, { dwellSecs: 1800, nowMs: t0 * 1000 });          // pending (armed at t0)
    const off = await evaluateAndNotify(db, 'anomaly:s2', false, build, cfg, { dwellSecs: 1800, nowMs: (t0 + 300) * 1000 }); // transient → disarm
    expect(off.transition).toBe('skip');
    expect(getNotifState(db, 'anomaly:s2').pendingSince).toBe(null);
    expect(fetch).not.toHaveBeenCalled();

    await evaluateAndNotify(db, 'anomaly:s2', true, build, cfg, { dwellSecs: 1800, nowMs: (t0 + 600) * 1000 });    // re-arm at t0+600
    // 1800s after the ORIGINAL t0 but only 1200s into the new window → still pending, not fired.
    const r = await evaluateAndNotify(db, 'anomaly:s2', true, build, cfg, { dwellSecs: 1800, nowMs: (t0 + 1800) * 1000 });
    expect(r.transition).toBe('pending');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fires once then recovers after the condition clears', async () => {
    fetch.mockResolvedValue(jsonResp({}, 200));
    const db = makeDb();
    const t0 = 3_000_000;

    await evaluateAndNotify(db, 'anomaly:s3', true, build, cfg, { dwellSecs: 600, nowMs: t0 * 1000 });             // pending
    const rf = await evaluateAndNotify(db, 'anomaly:s3', true, build, cfg, { dwellSecs: 600, nowMs: (t0 + 600) * 1000 }); // fire
    expect(rf.transition).toBe('fire');
    expect(getNotifState(db, 'anomaly:s3').pendingSince).toBe(null);  // cleared on fire

    fetch.mockClear();
    const rr = await evaluateAndNotify(db, 'anomaly:s3', false, build, cfg, { dwellSecs: 600, nowMs: (t0 + 900) * 1000 }); // recover
    expect(rr.transition).toBe('recover');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('dwellSecs=0 fires immediately (unchanged behavior for non-dwell conditions)', async () => {
    fetch.mockResolvedValue(jsonResp({}, 200));
    const db = makeDb();
    const r = await evaluateAndNotify(db, 'threshold:s4', true, build, cfg, { dwellSecs: 0, nowMs: 4_000_000_000 });
    expect(r.transition).toBe('fire');
  });
});

// ── validation ─────────────────────────────────────────────────────────────

describe('validateNotifConfig', () => {
  it('accepts null and undefined', () => {
    expect(validateNotifConfig(null)).toBe(true);
    expect(validateNotifConfig(undefined)).toBe(true);
  });

  it('rejects non-object / array', () => {
    expect(validateNotifConfig('hi')).toBe(false);
    expect(validateNotifConfig([])).toBe(false);
    expect(validateNotifConfig(42)).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    expect(validateNotifConfig({ enabled: true, weird: 1 })).toBe(false);
  });

  it('rejects bad sink types', () => {
    expect(validateNotifConfig({ webhook: { enabled: 'yes' } })).toBe(false);
    expect(validateNotifConfig({ webhook: { url: 42 } })).toBe(false);
  });

  it('rejects token field on webhook (only ntfy supports tokens)', () => {
    expect(validateNotifConfig({ webhook: { token: 'x' } })).toBe(false);
  });

  it('accepts the full valid shape', () => {
    expect(validateNotifConfig({
      enabled: true,
      webhook: { enabled: true, url: 'https://x' },
      ntfy:    { enabled: false, url: '', token: '' },
      conditions: {
        threshold:      { enabled: true },
        anomaly:        { enabled: false },
        sensorOffline:  { enabled: true,  thresholdSecs: 1800 },
        gatewayOffline: { enabled: false, thresholdSecs: 900 },
      },
    })).toBe(true);
  });

  it('rejects non-positive thresholdSecs', () => {
    expect(validateNotifConfig({
      conditions: { sensorOffline: { enabled: true, thresholdSecs: 0 } },
    })).toBe(false);
    expect(validateNotifConfig({
      conditions: { sensorOffline: { enabled: true, thresholdSecs: -5 } },
    })).toBe(false);
  });

  it('rejects unknown condition keys', () => {
    expect(validateNotifConfig({
      conditions: { coffeeMakerOnFire: { enabled: true } },
    })).toBe(false);
  });

  it('accepts anomaly sigma, dwellSecs, and excludeSensors', () => {
    expect(validateNotifConfig({
      conditions: { anomaly: { enabled: true, sigma: 3, dwellSecs: 1800, excludeSensors: ['a', 'b'] } },
    })).toBe(true);
    // dwellSecs 0 = fire immediately, allowed.
    expect(validateNotifConfig({
      conditions: { anomaly: { enabled: true, dwellSecs: 0 } },
    })).toBe(true);
  });

  it('rejects bad anomaly field types', () => {
    expect(validateNotifConfig({ conditions: { anomaly: { enabled: true, sigma: 0 } } })).toBe(false);
    expect(validateNotifConfig({ conditions: { anomaly: { enabled: true, sigma: -1 } } })).toBe(false);
    expect(validateNotifConfig({ conditions: { anomaly: { enabled: true, dwellSecs: -5 } } })).toBe(false);
    expect(validateNotifConfig({ conditions: { anomaly: { enabled: true, excludeSensors: 'nope' } } })).toBe(false);
    expect(validateNotifConfig({ conditions: { anomaly: { enabled: true, excludeSensors: [1, 2] } } })).toBe(false);
    // anomaly does not accept thresholdSecs (that's an offline-condition field).
    expect(validateNotifConfig({ conditions: { anomaly: { enabled: true, thresholdSecs: 10 } } })).toBe(false);
  });
});

// ── runNotifications (top-level fanout) ───────────────────────────────────

describe('runNotifications', () => {
  const baseConfig = {
    enabled: true,
    webhook: { enabled: true, url: 'https://x/y' },
    conditions: {
      threshold:      { enabled: true },
      anomaly:        { enabled: false },
      sensorOffline:  { enabled: true, thresholdSecs: 600 },
      gatewayOffline: { enabled: true, thresholdSecs: 600 },
    },
  };

  it('short-circuits when notifications.enabled = false', async () => {
    const db = makeDb();
    const r = await runNotifications(db, {
      sensors: [{ id: 's1', name: 'A', temperature: 999,
                  alerts: { temperature: { enabled: true, max: 80 } }, lastTs: Math.floor(Date.now() / 1000) }],
      gateways: [],
      notifConfig: { ...baseConfig, enabled: false },
    });
    expect(r).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fires threshold breach for a sensor whose latest reading is out of bounds', async () => {
    fetch.mockResolvedValue(jsonResp({}, 200));
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    const r = await runNotifications(db, {
      sensors: [{
        id: 's1', name: 'Hot Sensor', temperature: 100, humidity: 50,
        alerts: { temperature: { enabled: true, max: 80 } },
        lastTs: now,
      }],
      gateways: [],
      notifConfig: baseConfig,
    });
    const threshold = r.find(x => x.kind === 'threshold');
    expect(threshold.transition).toBe('fire');
    expect(fetch).toHaveBeenCalled();
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.title).toMatch(/Hot Sensor/);
  });

  it('fires gateway-offline when last_seen is stale', async () => {
    fetch.mockResolvedValue(jsonResp({}, 200));
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    const r = await runNotifications(db, {
      sensors: [],
      gateways: [{ id: 'gw1', name: 'Downstairs', lastSeen: now - 4000 }],
      notifConfig: baseConfig,
    });
    const gw = r.find(x => x.kind === 'gateway-offline');
    expect(gw.transition).toBe('fire');
  });

  it('fires sensor-offline + recovers when reading comes back', async () => {
    fetch.mockResolvedValue(jsonResp({}, 200));
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    const stale = { id: 's2', name: 'Stale', temperature: 70, humidity: 50, alerts: null, lastTs: now - 4000 };
    const fresh = { ...stale, lastTs: now - 30 };

    // First pass: stale → fire
    const r1 = await runNotifications(db, { sensors: [stale], gateways: [], notifConfig: baseConfig });
    expect(r1.find(x => x.kind === 'sensor-offline').transition).toBe('fire');

    // Second pass: still stale → skip (dedupe)
    fetch.mockClear();
    const r2 = await runNotifications(db, { sensors: [stale], gateways: [], notifConfig: baseConfig });
    expect(r2.find(x => x.kind === 'sensor-offline').transition).toBe('skip');
    expect(fetch).not.toHaveBeenCalled();

    // Third pass: fresh → recover
    const r3 = await runNotifications(db, { sensors: [fresh], gateways: [], notifConfig: baseConfig });
    expect(r3.find(x => x.kind === 'sensor-offline').transition).toBe('recover');
  });

  it('only evaluates conditions whose toggle is on', async () => {
    fetch.mockResolvedValue(jsonResp({}, 200));
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    // Hot sensor + stale lastTs, but only threshold is enabled.
    const r = await runNotifications(db, {
      sensors: [{
        id: 's3', name: 'Hot', temperature: 100, humidity: 50,
        alerts: { temperature: { enabled: true, max: 80 } }, lastTs: now - 9999,
      }],
      gateways: [{ id: 'gw1', name: 'X', lastSeen: now - 9999 }],
      notifConfig: {
        enabled: true,
        webhook: { enabled: true, url: 'https://x' },
        conditions: {
          threshold:      { enabled: true },
          sensorOffline:  { enabled: false, thresholdSecs: 600 },
          gatewayOffline: { enabled: false, thresholdSecs: 600 },
        },
      },
    });
    expect(r.find(x => x.kind === 'threshold').transition).toBe('fire');
    expect(r.find(x => x.kind === 'sensor-offline')).toBeUndefined();
    expect(r.find(x => x.kind === 'gateway-offline')).toBeUndefined();
  });

  // Seed a flat 14-day hour-of-day baseline so the anomaly evaluator has data.
  function seedFlatBaseline(db, id, temp, hum) {
    const now = Math.floor(Date.now() / 1000);
    const hourOfDay = new Date().getHours();
    upsertSensors(db, [{ id, name: id, type: 'HT1', active: true, batteryVoltage: 2.9 }]);
    for (let d = 0; d < 14; d++) {
      const hourTs    = Math.floor((now - d * 86400) / 3600) * 3600;
      const offsetHrs = ((hourTs / 3600) % 24) - hourOfDay;
      const aligned   = hourTs - offsetHrs * 3600;
      db.prepare(`INSERT OR REPLACE INTO hourly_agg
        (sensor_id, hour_ts, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max, baro_avg, sample_count, excluded)
        VALUES (?,?,?,?,?,?,?,?,NULL,12,0)`).run(id, aligned, temp, temp - 0.1, temp + 0.1, hum, hum - 0.5, hum + 0.5);
    }
  }

  it('skips anomaly for excluded sensors', async () => {
    fetch.mockResolvedValue(jsonResp({}, 200));
    const db  = makeDb();
    const now = Math.floor(Date.now() / 1000);
    seedFlatBaseline(db, 'ex1', 70, 50);
    const cfg = {
      enabled: true, webhook: { enabled: true, url: 'https://x' },
      conditions: { anomaly: { enabled: true, sigma: 3, dwellSecs: 0, excludeSensors: ['ex1'] } },
    };
    const r = await runNotifications(db, {
      sensors:  [{ id: 'ex1', name: 'Excluded', temperature: 95, humidity: 50, alerts: null, lastTs: now }],
      gateways: [], notifConfig: cfg,
    });
    expect(r.find(x => x.kind === 'anomaly')).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fires anomaly through runNotifications when not excluded (dwellSecs=0)', async () => {
    fetch.mockResolvedValue(jsonResp({}, 200));
    const db  = makeDb();
    const now = Math.floor(Date.now() / 1000);
    seedFlatBaseline(db, 'in1', 70, 50);
    const cfg = {
      enabled: true, webhook: { enabled: true, url: 'https://x' },
      conditions: { anomaly: { enabled: true, sigma: 3, dwellSecs: 0, excludeSensors: [] } },
    };
    const r = await runNotifications(db, {
      sensors:  [{ id: 'in1', name: 'Included', temperature: 95, humidity: 50, alerts: null, lastTs: now }],
      gateways: [], notifConfig: cfg,
    });
    expect(r.find(x => x.kind === 'anomaly')?.transition).toBe('fire');
  });
});
