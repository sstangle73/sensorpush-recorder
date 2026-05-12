// Unit tests for pure helper functions defined in sensor-api/ui.html.
// Functions are duplicated here because ui.html has no module exports.
// If the implementations change in ui.html, update these copies.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function timeAgo(iso) {
  if (!iso) return 'never';
  const mins = (Date.now() - new Date(iso).getTime()) / 60000;
  if (mins < 1)   return 'just now';
  if (mins < 60)  return Math.round(mins) + ' min ago';
  const hrs = mins / 60;
  if (hrs < 24)   return Math.round(hrs) + ' hr ago';
  return Math.round(hrs / 24) + ' d ago';
}

function seenClass(iso) {
  if (!iso) return 'stale';
  const mins = (Date.now() - new Date(iso).getTime()) / 60000;
  if (mins > 30) return 'stale';
  if (mins > 10) return 'warn';
  return '';
}

// API_BASE logic from ui.html: pathname-based detection
function apiBase(pathname) {
  return pathname.startsWith('/sensorpush') ? '/api/sensors' : '';
}

// Pin Date.now() so relative-time assertions are deterministic
const NOW = new Date('2026-04-19T12:00:00Z').getTime();

function ago(minutes) {
  return new Date(NOW - minutes * 60 * 1000).toISOString();
}

beforeEach(() => { vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('timeAgo', () => {
  it('returns "never" for null', () => {
    expect(timeAgo(null)).toBe('never');
  });

  it('returns "never" for undefined', () => {
    expect(timeAgo(undefined)).toBe('never');
  });

  it('returns "just now" for 0 seconds ago', () => {
    expect(timeAgo(new Date(NOW).toISOString())).toBe('just now');
  });

  it('returns "just now" for 30 seconds ago', () => {
    expect(timeAgo(new Date(NOW - 30000).toISOString())).toBe('just now');
  });

  it('returns "1 min ago" for 1 minute ago', () => {
    expect(timeAgo(ago(1))).toBe('1 min ago');
  });

  it('returns "5 min ago" for 5 minutes ago', () => {
    expect(timeAgo(ago(5))).toBe('5 min ago');
  });

  it('returns "59 min ago" for 59 minutes ago', () => {
    expect(timeAgo(ago(59))).toBe('59 min ago');
  });

  it('returns "1 hr ago" for 60 minutes ago', () => {
    expect(timeAgo(ago(60))).toBe('1 hr ago');
  });

  it('returns "3 hr ago" for 3 hours ago', () => {
    expect(timeAgo(ago(180))).toBe('3 hr ago');
  });

  it('returns "23 hr ago" for 23 hours ago', () => {
    expect(timeAgo(ago(23 * 60))).toBe('23 hr ago');
  });

  it('returns "1 d ago" for 24 hours ago', () => {
    expect(timeAgo(ago(24 * 60))).toBe('1 d ago');
  });

  it('returns "7 d ago" for 7 days ago', () => {
    expect(timeAgo(ago(7 * 24 * 60))).toBe('7 d ago');
  });
});

describe('seenClass', () => {
  it('returns "stale" for null', () => {
    expect(seenClass(null)).toBe('stale');
  });

  it('returns "stale" for undefined', () => {
    expect(seenClass(undefined)).toBe('stale');
  });

  it('returns "" (fresh) for just now', () => {
    expect(seenClass(new Date(NOW).toISOString())).toBe('');
  });

  it('returns "" (fresh) for 9 minutes ago', () => {
    expect(seenClass(ago(9))).toBe('');
  });

  it('returns "warn" for exactly 11 minutes ago', () => {
    expect(seenClass(ago(11))).toBe('warn');
  });

  it('returns "warn" for 29 minutes ago', () => {
    expect(seenClass(ago(29))).toBe('warn');
  });

  it('returns "stale" for exactly 31 minutes ago', () => {
    expect(seenClass(ago(31))).toBe('stale');
  });

  it('returns "stale" for several hours ago', () => {
    expect(seenClass(ago(120))).toBe('stale');
  });

  it('returns "stale" for a day ago', () => {
    expect(seenClass(ago(24 * 60))).toBe('stale');
  });
});

describe('API_BASE detection', () => {
  it('returns /api/sensors when served via nginx at /sensorpush/', () => {
    expect(apiBase('/sensorpush/')).toBe('/api/sensors');
  });

  it('returns /api/sensors for any /sensorpush sub-path', () => {
    expect(apiBase('/sensorpush/anything')).toBe('/api/sensors');
  });

  it('returns "" when served directly at /ui (port 3003)', () => {
    expect(apiBase('/ui')).toBe('');
  });

  it('returns "" for root path', () => {
    expect(apiBase('/')).toBe('');
  });

  it('returns "" for unrelated paths', () => {
    expect(apiBase('/dashboard')).toBe('');
  });
});

// ── _longestRunSecs / moldRisk / hvacActivity ────────────────────────────
// Duplicated from ui.html (see file header). Update both when changing.

function _longestRunSecs(samples, pred) {
  let best = 0, startTs = null, lastTs = null;
  for (const s of samples) {
    if (pred(s)) {
      if (startTs == null) startTs = s.ts;
      lastTs = s.ts;
    } else {
      if (startTs != null) best = Math.max(best, lastTs - startTs);
      startTs = null; lastTs = null;
    }
  }
  if (startTs != null) best = Math.max(best, lastTs - startTs);
  return best;
}

function moldRisk(samples) {
  const validHum    = samples.filter(s => s.humidity != null);
  const validSpread = samples.filter(s => s.temperature != null && s.dewpoint != null);
  if (!validHum.length && !validSpread.length) return null;

  const pct70 = validHum.length
    ? validHum.filter(s => s.humidity >= 70).length / validHum.length : 0;
  const pct80 = validHum.length
    ? validHum.filter(s => s.humidity >= 80).length / validHum.length : 0;
  const spread = validSpread.length
    ? validSpread.filter(s => s.temperature - s.dewpoint < 5).length / validSpread.length : 0;
  const runHrs = _longestRunSecs(samples, s => s.humidity != null && s.humidity >= 70) / 3600;

  let level = 'low';
  if (pct70 >= 0.50 || pct80 >= 0.25 || runHrs >= 168)      level = 'high';
  else if (pct70 >= 0.25 || runHrs >= 72)                   level = 'elevated';
  else if (pct70 >= 0.05 || runHrs >= 24 || spread >= 0.10) level = 'moderate';

  return { level, pct70, pct80, spread, runHrs };
}

const HVAC_ACTIVE_SLOPE   = 0.5;
const HVAC_REVERSAL_FLOOR = 0.2;
function hvacActivity(samples) {
  const valid = samples.filter(s => s.temperature != null);
  if (valid.length < 24) return null;

  const byHour = new Map();
  for (const s of valid) {
    const h   = Math.floor(s.ts / 3600);
    const cur = byHour.get(h) || { sum: 0, n: 0 };
    cur.sum += s.temperature; cur.n++;
    byHour.set(h, cur);
  }
  const hourly = [...byHour.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([h, agg]) => ({ h, t: agg.sum / agg.n }));
  if (hourly.length < 24) return null;

  const slopes = [];
  for (let i = 1; i < hourly.length; i++) {
    if (hourly[i].h - hourly[i - 1].h === 1) slopes.push(hourly[i].t - hourly[i - 1].t);
    else slopes.push(null);
  }

  let cycles = 0;
  for (let i = 1; i < slopes.length; i++) {
    const a = slopes[i - 1], b = slopes[i];
    if (a == null || b == null) continue;
    if (Math.abs(a) >= HVAC_REVERSAL_FLOOR && Math.abs(b) >= HVAC_REVERSAL_FLOOR && a * b < 0) cycles++;
  }

  const activeHrs = slopes.filter(s => s != null && Math.abs(s) >= HVAC_ACTIVE_SLOPE).length;
  const days      = hourly.length / 24;
  return { cyclesPerDay: (cycles / 2) / days, activeHrsPerDay: activeHrs / days, days };
}

describe('_longestRunSecs', () => {
  it('returns 0 for empty input', () => {
    expect(_longestRunSecs([], () => true)).toBe(0);
  });

  it('returns 0 when no sample satisfies the predicate', () => {
    const samples = [{ ts: 100, v: 1 }, { ts: 200, v: 2 }, { ts: 300, v: 3 }];
    expect(_longestRunSecs(samples, s => s.v > 100)).toBe(0);
  });

  it('returns the run duration in seconds (last - first ts)', () => {
    // Continuous run from ts=100 to ts=400 → 300s
    const samples = [
      { ts: 100, v: 80 }, { ts: 200, v: 81 }, { ts: 300, v: 82 }, { ts: 400, v: 83 },
    ];
    expect(_longestRunSecs(samples, s => s.v >= 80)).toBe(300);
  });

  it('picks the longest run when there are multiple', () => {
    // Two runs: ts 100-200 (100s), ts 400-700 (300s) → 300s
    const samples = [
      { ts: 100, v: 80 }, { ts: 200, v: 80 },
      { ts: 300, v: 0 },
      { ts: 400, v: 80 }, { ts: 500, v: 80 }, { ts: 600, v: 80 }, { ts: 700, v: 80 },
      { ts: 800, v: 0 },
    ];
    expect(_longestRunSecs(samples, s => s.v >= 80)).toBe(300);
  });

  it('closes an open run at the end of the array', () => {
    const samples = [
      { ts: 100, v: 0 },
      { ts: 200, v: 80 }, { ts: 300, v: 80 }, { ts: 400, v: 80 },
    ];
    expect(_longestRunSecs(samples, s => s.v >= 80)).toBe(200);
  });
});

describe('moldRisk', () => {
  // Build N hourly samples at temperature T, humidity H, dewpoint D.
  function build(n, T, H, D) {
    return Array.from({ length: n }, (_, i) => ({
      ts: i * 3600, temperature: T, humidity: H, dewpoint: D,
    }));
  }

  it('returns null on empty / all-null input', () => {
    expect(moldRisk([])).toBeNull();
    expect(moldRisk([{ ts: 0, temperature: null, humidity: null, dewpoint: null }])).toBeNull();
  });

  it('rates low risk for dry, warm air', () => {
    // 30 hours at 70°F, 35% RH, dewpoint 41°F (spread 29°F).
    const r = moldRisk(build(30, 70, 35, 41));
    expect(r.level).toBe('low');
    expect(r.pct70).toBe(0);
    expect(r.spread).toBe(0);
  });

  it('rates high risk when humidity stays above 70% for the whole window', () => {
    // 200 hours at 75°F, 85% RH, dewpoint 70°F (spread 5°F).
    const r = moldRisk(build(200, 75, 85, 70));
    expect(r.level).toBe('high');
    expect(r.pct70).toBeCloseTo(1.0);
    expect(r.pct80).toBeCloseTo(1.0);
    expect(r.runHrs).toBeGreaterThanOrEqual(168);
  });

  it('rates moderate when there is a ≥24h sustained-humid run on an otherwise dry sensor', () => {
    // 100 hours, with hours 30..60 at 75% RH (30h run) and the rest at 40%.
    const samples = Array.from({ length: 100 }, (_, i) => ({
      ts: i * 3600,
      temperature: 70,
      humidity: (i >= 30 && i <= 60) ? 75 : 40,
      dewpoint: 50,
    }));
    const r = moldRisk(samples);
    // pct70 = 31/100 = 0.31 → elevated tier (≥0.25)
    expect(r.level).toBe('elevated');
    expect(r.runHrs).toBeGreaterThanOrEqual(24);
  });

  it('uses the dewpoint-spread criterion to bump moderate even when humidity is borderline', () => {
    // 50 hours at 65% RH (just below the 70% line) but with very small
    // dewpoint depression (T-Tdew = 3°F) on every sample.
    const r = moldRisk(build(50, 65, 65, 62));
    expect(r.spread).toBeCloseTo(1.0);
    expect(r.level).toBe('moderate');
  });
});

describe('hvacActivity', () => {
  // 48-hour temperature trace with a configurable per-hour profile.
  function trace(profile) {
    return profile.map((t, i) => ({ ts: i * 3600 + 100, temperature: t }));
  }

  it('returns null when there are fewer than 24 valid samples', () => {
    expect(hvacActivity(trace(Array.from({ length: 20 }, () => 70)))).toBeNull();
  });

  it('rates passive (0 cycles, ~0 active hours) on a flat trace', () => {
    const r = hvacActivity(trace(Array.from({ length: 48 }, () => 70.0)));
    expect(r).not.toBeNull();
    expect(r.cyclesPerDay).toBe(0);
    expect(r.activeHrsPerDay).toBe(0);
  });

  it('counts on/off cycles from sign-reversing slopes (square-wave heating)', () => {
    // 48-hour square wave: +1°F per hour for 4 hours, then -1°F for 4 hours,
    // repeating. That's 6 on/off cycles in 48h ≈ 3 cycles/day (allowing for
    // one boundary slope being lost). Each cycle = 2 slope reversals.
    const profile = [];
    let t = 70, dir = +1;
    for (let i = 0; i < 48; i++) {
      profile.push(t);
      t += dir;
      if ((i + 1) % 4 === 0) dir = -dir;
    }
    const r = hvacActivity(trace(profile));
    expect(r).not.toBeNull();
    // Expect ≈2.75 (11 reversals / 2 / 2 days) — between 2 and 3.5.
    expect(r.cyclesPerDay).toBeGreaterThan(2);
    expect(r.cyclesPerDay).toBeLessThan(3.5);
    // Every slope is ±1°F/hr, all of them clear the ACTIVE threshold.
    expect(r.activeHrsPerDay).toBeGreaterThan(20);
  });

  it('does not count noise (sub-floor slopes) as cycles', () => {
    // 48 hours of ±0.05°F jitter — below the REVERSAL_FLOOR of 0.2°F/hr.
    const profile = Array.from({ length: 48 }, (_, i) => 70 + 0.05 * (i % 2 === 0 ? 1 : -1));
    const r = hvacActivity(trace(profile));
    expect(r.cyclesPerDay).toBe(0);
    expect(r.activeHrsPerDay).toBe(0);
  });
});
