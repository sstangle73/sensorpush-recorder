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

function minuteOfHourMeans(samples, field) {
  const sum = new Array(60).fill(0);
  const n   = new Array(60).fill(0);
  for (const s of samples) {
    if (s[field] == null) continue;
    const m = new Date(s.ts * 1000).getMinutes();
    sum[m] += s[field]; n[m]++;
  }
  return sum.map((v, m) => n[m] ? v / n[m] : null);
}

describe('minuteOfHourMeans', () => {
  it('returns a 60-element array with all-null for empty input', () => {
    const r = minuteOfHourMeans([], 'temperature');
    expect(r).toHaveLength(60);
    expect(r.every(v => v === null)).toBe(true);
  });

  it('places a single sample in its minute slot, leaves the rest null', () => {
    // 2026-04-19 12:23 local — minute 23.
    const ts = Math.floor(new Date(2026, 3, 19, 12, 23, 0).getTime() / 1000);
    const r  = minuteOfHourMeans([{ ts, temperature: 71.5 }], 'temperature');
    expect(r[23]).toBeCloseTo(71.5);
    expect(r[22]).toBeNull();
    expect(r[24]).toBeNull();
  });

  it('averages across hours: same minute on multiple hours rolls into one bucket', () => {
    const mk = (h, m, t) => ({ ts: Math.floor(new Date(2026, 3, 19, h, m, 0).getTime() / 1000), temperature: t });
    // Three samples all at :15 across different hours → mean of the three.
    const r = minuteOfHourMeans([mk(10, 15, 70), mk(11, 15, 72), mk(12, 15, 74)], 'temperature');
    expect(r[15]).toBeCloseTo(72);
  });

  it('ignores samples whose field is null', () => {
    const ts = Math.floor(new Date(2026, 3, 19, 12, 5, 0).getTime() / 1000);
    const r  = minuteOfHourMeans([{ ts, temperature: null }, { ts, temperature: 70 }], 'temperature');
    expect(r[5]).toBeCloseTo(70);
  });
});

// ── eventMarkerX / visibleEventsForChart ───────────────────────────────────
// Duplicated from ui.html (see file header). Update both when changing.

function eventMarkerX(eventTsSec, xMinMs, xMaxMs, PL, cW) {
  const tsMs = eventTsSec * 1000;
  if (tsMs < xMinMs || tsMs > xMaxMs) return null;
  if (xMaxMs <= xMinMs) return null;
  return PL + (tsMs - xMinMs) / (xMaxMs - xMinMs) * cW;
}

function visibleEventsForChart(events, selectedIds) {
  const sel = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  return events.filter(e => e.sensorId == null || sel.has(e.sensorId));
}

describe('eventMarkerX', () => {
  // Chart at 1000-wide canvas, 60px left padding, 880px content width.
  const PL = 60, cW = 880;
  // 24-hour window starting at NOW-24h, ending at NOW.
  const xMin = NOW - 24 * 3600 * 1000;
  const xMax = NOW;

  it('returns null when event is before the visible window', () => {
    const before = (xMin / 1000) - 60; // 1 min before window start
    expect(eventMarkerX(before, xMin, xMax, PL, cW)).toBeNull();
  });

  it('returns null when event is after the visible window', () => {
    const after = (xMax / 1000) + 60;
    expect(eventMarkerX(after, xMin, xMax, PL, cW)).toBeNull();
  });

  it('returns PL exactly at window start', () => {
    expect(eventMarkerX(xMin / 1000, xMin, xMax, PL, cW)).toBeCloseTo(PL, 5);
  });

  it('returns PL + cW exactly at window end', () => {
    expect(eventMarkerX(xMax / 1000, xMin, xMax, PL, cW)).toBeCloseTo(PL + cW, 5);
  });

  it('interpolates linearly: midpoint event lands at PL + cW/2', () => {
    const mid = (xMin + xMax) / 2 / 1000;
    expect(eventMarkerX(mid, xMin, xMax, PL, cW)).toBeCloseTo(PL + cW / 2, 5);
  });

  it('interpolates correctly at 25% / 75% of the window', () => {
    const q1 = (xMin + 0.25 * (xMax - xMin)) / 1000;
    const q3 = (xMin + 0.75 * (xMax - xMin)) / 1000;
    expect(eventMarkerX(q1, xMin, xMax, PL, cW)).toBeCloseTo(PL + 0.25 * cW, 5);
    expect(eventMarkerX(q3, xMin, xMax, PL, cW)).toBeCloseTo(PL + 0.75 * cW, 5);
  });

  it('returns null when xMax <= xMin (degenerate / zero-width window)', () => {
    expect(eventMarkerX(xMin / 1000, xMin, xMin, PL, cW)).toBeNull();
    expect(eventMarkerX(xMin / 1000, xMax, xMin, PL, cW)).toBeNull();
  });
});

describe('visibleEventsForChart', () => {
  const events = [
    { id: 1, ts: 100, sensorId: null, label: 'global-a' },
    { id: 2, ts: 200, sensorId: 's1',  label: 's1-only' },
    { id: 3, ts: 300, sensorId: 's2',  label: 's2-only' },
    { id: 4, ts: 400, sensorId: null, label: 'global-b' },
  ];

  it('always includes global (sensorId == null) events', () => {
    const out = visibleEventsForChart(events, new Set());
    expect(out.map(e => e.id).sort()).toEqual([1, 4]);
  });

  it('includes sensor-scoped events only when their sensor is selected', () => {
    const out = visibleEventsForChart(events, new Set(['s1']));
    expect(out.map(e => e.id).sort()).toEqual([1, 2, 4]);
  });

  it('accepts a plain array of ids as well as a Set', () => {
    const out = visibleEventsForChart(events, ['s2']);
    expect(out.map(e => e.id).sort()).toEqual([1, 3, 4]);
  });

  it('returns only globals when no sensor matches the scoped events', () => {
    const out = visibleEventsForChart(events, new Set(['unknown']));
    expect(out.map(e => e.id).sort()).toEqual([1, 4]);
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

// ── priorYearWindow ───────────────────────────────────────────────────────
// Duplicated from ui.html (see file header). Update both when changing.
function priorYearWindow(startTs, endTs) {
  const shift = ts => {
    const d = new Date(ts * 1000);
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return Math.floor(d.getTime() / 1000);
  };
  return { startTs: shift(startTs), endTs: shift(endTs) };
}

// Convenience: Unix seconds for a UTC instant.
const utc = (...args) => Math.floor(Date.UTC(...args) / 1000);

describe('priorYearWindow', () => {
  it('shifts a plain mid-year window back by one calendar year', () => {
    // 2026-07-15 12:00 UTC → 2025-07-15 12:00 UTC; 7-day window stays 7 days.
    const end   = utc(2026, 6, 15, 12, 0, 0);
    const start = end - 7 * 86400;
    const r = priorYearWindow(start, end);
    expect(r.endTs).toBe(utc(2025, 6, 15, 12, 0, 0));
    expect(r.startTs).toBe(utc(2025, 6, 8, 12, 0, 0));
    expect(r.endTs - r.startTs).toBe(7 * 86400);
  });

  it('preserves the time-of-day component', () => {
    // 2026-05-14 19:23:47 UTC → 2025-05-14 19:23:47 UTC
    const end = utc(2026, 4, 14, 19, 23, 47);
    const r = priorYearWindow(end - 3600, end);
    expect(r.endTs).toBe(utc(2025, 4, 14, 19, 23, 47));
  });

  it('Feb 28 (non-leap day) → Feb 28 in prior year, unchanged', () => {
    // 2025 and 2024 both have Feb 28 → identical calendar mapping.
    const ts = utc(2025, 1, 28, 10, 0, 0);
    const r = priorYearWindow(ts, ts);
    expect(r.endTs).toBe(utc(2024, 1, 28, 10, 0, 0));
  });

  it('Feb 29 (leap day) rolls forward to Mar 1 in the prior non-leap year', () => {
    // 2024-02-29 doesn't exist in 2023 → JS Date wraps Feb 29 → Mar 1.
    // We accept this: Feb 29 a year ago is genuinely an empty date, and
    // Mar 1 is the closest valid mapping.
    const leapDay = utc(2024, 1, 29, 12, 0, 0);
    const r = priorYearWindow(leapDay, leapDay);
    expect(r.endTs).toBe(utc(2023, 2, 1, 12, 0, 0));
  });

  it('windows crossing the leap-year boundary keep the start unchanged', () => {
    // Window: 2024-02-26 → 2024-03-04 (7 days, crosses Feb 29).
    // Prior year: 2023-02-26 → 2023-03-04 (which in 2023 is still 7 cal days,
    // but contains 365 not 366 day-of-year offset → so the window length
    // can differ by ±1 day across the leap boundary; that's documented
    // behavior).
    const start = utc(2024, 1, 26, 0, 0, 0);
    const end   = utc(2024, 2,  4, 0, 0, 0);
    const r = priorYearWindow(start, end);
    expect(r.startTs).toBe(utc(2023, 1, 26, 0, 0, 0));
    expect(r.endTs).toBe(utc(2023, 2,  4, 0, 0, 0));
  });

  it('US spring-forward day: window shifts cleanly via UTC (no DST artifact)', () => {
    // 2026-03-08 02:00 local US is the spring-forward instant; in UTC that's
    // 2026-03-08 07:00 UTC. We anchor in UTC throughout, so a window crossing
    // this point still shifts to exactly 2025-03-08 — UTC has no DST, so the
    // local-time 23h day doesn't subtract an hour from our window.
    const end   = utc(2026, 2, 8, 12, 0, 0);
    const start = end - 86400;          // 24 UTC-hours
    const r = priorYearWindow(start, end);
    expect(r.endTs - r.startTs).toBe(86400);
    expect(r.endTs).toBe(utc(2025, 2, 8, 12, 0, 0));
    expect(r.startTs).toBe(utc(2025, 2, 7, 12, 0, 0));
  });

  it('US fall-back day: same — UTC math is insensitive to the extra local hour', () => {
    // 2026-11-01 02:00 local US falls back to 01:00 (25h local day).
    // UTC arithmetic is unaffected; window length stays a clean 24 UTC-hours.
    const end   = utc(2026, 10, 1, 12, 0, 0);
    const start = end - 86400;
    const r = priorYearWindow(start, end);
    expect(r.endTs - r.startTs).toBe(86400);
    expect(r.endTs).toBe(utc(2025, 10, 1, 12, 0, 0));
  });

  it('returns the same shape (startTs/endTs as integers)', () => {
    // Integer-only timestamps — downstream callers pass these to a query
    // string and to integer-compare against DB rows; floats would break both.
    const end = utc(2026, 5, 1, 8, 30, 15);
    const r = priorYearWindow(end - 3600, end);
    expect(Number.isInteger(r.startTs)).toBe(true);
    expect(Number.isInteger(r.endTs)).toBe(true);
  });
});

// ── computeOutdoorDelta ───────────────────────────────────────────────────
// Duplicated from ui.html (see file header). Update both when changing.
function computeOutdoorDelta(indoor, outdoor) {
  if (!indoor || !outdoor) return null;
  const out = { temp: null, hum: null, dewpoint: null };
  if (indoor.temp != null && outdoor.temp != null) {
    out.temp = { indoor: indoor.temp, outdoor: outdoor.temp, delta: indoor.temp - outdoor.temp };
  }
  if (indoor.humidity != null && outdoor.humidity != null) {
    out.hum = { indoor: indoor.humidity, outdoor: outdoor.humidity, delta: indoor.humidity - outdoor.humidity };
  }
  if (outdoor.dewpoint != null) {
    out.dewpoint = { outdoor: outdoor.dewpoint };
  }
  if (out.temp == null && out.hum == null && out.dewpoint == null) return null;
  return out;
}

describe('computeOutdoorDelta', () => {
  it('returns null when either side is null', () => {
    expect(computeOutdoorDelta(null, { temp: 60, humidity: 50, dewpoint: 40 })).toBeNull();
    expect(computeOutdoorDelta({ temp: 70, humidity: 50 }, null)).toBeNull();
    expect(computeOutdoorDelta(null, null)).toBeNull();
  });

  it('computes positive delta when indoor is warmer than outdoor', () => {
    const d = computeOutdoorDelta({ temp: 72, humidity: 45 }, { temp: 50, humidity: 75, dewpoint: 43 });
    expect(d.temp.indoor).toBe(72);
    expect(d.temp.outdoor).toBe(50);
    expect(d.temp.delta).toBe(22);
    expect(d.hum.delta).toBe(-30);  // indoor drier than outdoor → negative
    expect(d.dewpoint.outdoor).toBe(43);
  });

  it('computes negative delta when indoor is cooler than outdoor', () => {
    const d = computeOutdoorDelta({ temp: 68, humidity: 50 }, { temp: 90, humidity: 80, dewpoint: 82 });
    expect(d.temp.delta).toBe(-22);
    expect(d.hum.delta).toBe(-30);
  });

  it('returns null temp section when indoor temp is missing, keeps humidity', () => {
    const d = computeOutdoorDelta({ temp: null, humidity: 50 }, { temp: 60, humidity: 70, dewpoint: 50 });
    expect(d.temp).toBeNull();
    expect(d.hum.delta).toBe(-20);
  });

  it('returns null hum section when outdoor humidity is missing, keeps temp', () => {
    const d = computeOutdoorDelta({ temp: 70, humidity: 50 }, { temp: 60, humidity: null, dewpoint: 45 });
    expect(d.temp.delta).toBe(10);
    expect(d.hum).toBeNull();
    expect(d.dewpoint.outdoor).toBe(45);
  });

  it('returns null overall when no axis has matched data', () => {
    const d = computeOutdoorDelta({ temp: null, humidity: null }, { temp: null, humidity: null, dewpoint: null });
    expect(d).toBeNull();
  });

  it('returns just dewpoint when only outdoor.dewpoint is available', () => {
    // No indoor temp/humidity and no outdoor temp/humidity, but a dewpoint reading.
    const d = computeOutdoorDelta({ temp: null, humidity: null }, { temp: null, humidity: null, dewpoint: 38 });
    expect(d).not.toBeNull();
    expect(d.temp).toBeNull();
    expect(d.hum).toBeNull();
    expect(d.dewpoint.outdoor).toBe(38);
  });

  it('handles zero indoor / zero outdoor values (no truthiness bug)', () => {
    // Cold-side edge case: 0°F indoor (unrealistic but tests null-vs-zero handling)
    const d = computeOutdoorDelta({ temp: 0, humidity: 0 }, { temp: 0, humidity: 0, dewpoint: 0 });
    expect(d.temp.delta).toBe(0);
    expect(d.hum.delta).toBe(0);
    expect(d.dewpoint.outdoor).toBe(0);
  });
});

// ── Chart layout / tooltip helpers (copies of ui.html) ─────────────────────

function panelFractions({ temp, hum, baro, vpd }) {
  const extras = (baro ? 1 : 0) + (vpd ? 1 : 0);
  const fracs = [];
  if (temp) fracs.push(extras >= 2 ? 0.42 : extras === 1 ? 0.50 : hum ? 0.58 : 1.0);
  if (hum)  fracs.push(extras >= 2 ? 0.28 : extras === 1 ? 0.32 : 0.42);
  if (baro) fracs.push(vpd ? 0.15 : 0.18);
  if (vpd)  fracs.push(baro ? 0.15 : 0.18);
  const total = fracs.reduce((a, b) => a + b, 0);
  return total > 0 ? fracs.map(f => f / total) : fracs;
}

function tooltipSortValue(sample, panelType, series) {
  if (!sample) return null;
  const has = s => !series || series.has(s);
  switch (panelType) {
    case 'hum':  return has('humidity') ? (sample.humidity     ?? null) : null;
    case 'baro': return has('pressure') ? (sample.baroPressure ?? null) : null;
    case 'vpd':  return has('vpd')      ? (sample.vpd          ?? null) : null;
    default:
      if (has('temp')     && sample.temperature != null) return sample.temperature;
      if (has('dewpoint') && sample.dewpoint    != null) return sample.dewpoint;
      return null;
  }
}

function sortTooltipRows(rows) {
  return rows.slice().sort((a, b) => {
    if (a.sortVal == null && b.sortVal == null) return 0;
    if (a.sortVal == null) return 1;
    if (b.sortVal == null) return -1;
    return b.sortVal - a.sortVal;
  });
}

function sensorGroupFilters(sensors, classify, groups) {
  const present = new Set(Object.values(sensors || {}).map(s => classify(s.name).group));
  if (present.size < 2) return [];
  return groups.filter(g => present.has(g.key)).map(g => ({ key: g.key, label: g.label }));
}

const sumOf = a => a.reduce((x, y) => x + y, 0);

describe('panelFractions', () => {
  it('gives a lone humidity panel the whole canvas', () => {
    expect(panelFractions({ temp: false, hum: true, baro: false, vpd: false })).toEqual([1]);
  });

  it('gives a lone temperature panel the whole canvas', () => {
    expect(panelFractions({ temp: true, hum: false, baro: false, vpd: false })).toEqual([1]);
  });

  it('always sums to 1 for every panel combination', () => {
    for (const temp of [true, false])
      for (const hum of [true, false])
        for (const baro of [true, false])
          for (const vpd of [true, false]) {
            const f = panelFractions({ temp, hum, baro, vpd });
            if (!f.length) continue;
            expect(sumOf(f)).toBeCloseTo(1, 10);
          }
  });

  it('returns one fraction per active panel', () => {
    expect(panelFractions({ temp: true, hum: true, baro: true, vpd: true })).toHaveLength(4);
    expect(panelFractions({ temp: false, hum: true, baro: true, vpd: false })).toHaveLength(2);
  });

  it('returns [] when nothing is shown', () => {
    expect(panelFractions({ temp: false, hum: false, baro: false, vpd: false })).toEqual([]);
  });

  it('keeps temp taller than humidity in the classic two-panel layout', () => {
    const [t, h] = panelFractions({ temp: true, hum: true, baro: false, vpd: false });
    expect(t).toBeGreaterThan(h);
  });

  it('normalizes a humidity + pressure chart to fill the canvas', () => {
    // Pre-normalization these were 0.32 + 0.18 — half the canvas, rest dead space.
    const f = panelFractions({ temp: false, hum: true, baro: true, vpd: false });
    expect(sumOf(f)).toBeCloseTo(1, 10);
    expect(f[0]).toBeGreaterThan(f[1]);
  });
});

describe('tooltipSortValue', () => {
  const all = new Set(['temp', 'humidity', 'pressure', 'dewpoint', 'vpd']);

  it('reads the metric matching the panel', () => {
    const s = { temperature: 70, humidity: 55, baroPressure: 29.9, vpd: 0.8 };
    expect(tooltipSortValue(s, 'temp', all)).toBe(70);
    expect(tooltipSortValue(s, 'hum',  all)).toBe(55);
    expect(tooltipSortValue(s, 'baro', all)).toBe(29.9);
    expect(tooltipSortValue(s, 'vpd',  all)).toBe(0.8);
  });

  it('returns null when the sensor does not plot the ranking metric', () => {
    expect(tooltipSortValue({ temperature: 70, humidity: 55 }, 'hum', new Set(['temp']))).toBeNull();
  });

  it('falls back to dewpoint on the temp panel when temp is not plotted', () => {
    expect(tooltipSortValue({ temperature: 70, dewpoint: 50 }, 'temp', new Set(['dewpoint']))).toBe(50);
  });

  it('treats a missing series set as plotting everything', () => {
    expect(tooltipSortValue({ humidity: 88 }, 'hum', null)).toBe(88);
  });

  it('returns null for a missing value or missing sample', () => {
    expect(tooltipSortValue({ temperature: null }, 'temp', all)).toBeNull();
    expect(tooltipSortValue(null, 'hum', all)).toBeNull();
  });

  it('keeps a zero reading rather than nulling it', () => {
    expect(tooltipSortValue({ humidity: 0 }, 'hum', all)).toBe(0);
  });
});

describe('sortTooltipRows', () => {
  it('orders rows highest value first', () => {
    const rows = [
      { sortVal: 58, html: 'living' },
      { sortVal: 88, html: 'outside' },
      { sortVal: 72, html: 'primary' },
    ];
    expect(sortTooltipRows(rows).map(r => r.html)).toEqual(['outside', 'primary', 'living']);
  });

  it('sinks rows with no comparable value to the bottom', () => {
    const rows = [
      { sortVal: null, html: 'unplotted' },
      { sortVal: 40,   html: 'low' },
      { sortVal: 90,   html: 'high' },
    ];
    expect(sortTooltipRows(rows).map(r => r.html)).toEqual(['high', 'low', 'unplotted']);
  });

  it('is stable for ties and does not mutate the input', () => {
    const rows = [
      { sortVal: 50, html: 'a' },
      { sortVal: 50, html: 'b' },
      { sortVal: 50, html: 'c' },
    ];
    expect(sortTooltipRows(rows).map(r => r.html)).toEqual(['a', 'b', 'c']);
    expect(rows.map(r => r.html)).toEqual(['a', 'b', 'c']);
  });

  it('handles an empty list', () => {
    expect(sortTooltipRows([])).toEqual([]);
  });
});

describe('sensorGroupFilters', () => {
  const GROUPS = [
    { key: 'house',     label: 'House' },
    { key: 'outside',   label: 'Outside' },
    { key: 'appliance', label: 'Appliances' },
    { key: 'other',     label: 'Other' },
  ];
  // Mirrors classifySensor()'s group keys without duplicating its regexes.
  const classify = s => ({
    'Living Room':   { group: 'house' },
    'Attic':         { group: 'house' },
    'Outside':       { group: 'outside' },
    'Garage Fridge': { group: 'appliance' },
  }[s] || { group: 'other' });

  it('offers only the groups that have sensors, in canonical order', () => {
    const sensors = {
      a: { name: 'Outside' },
      b: { name: 'Living Room' },
      c: { name: 'Garage Fridge' },
    };
    expect(sensorGroupFilters(sensors, classify, GROUPS)).toEqual([
      { key: 'house',     label: 'House' },
      { key: 'outside',   label: 'Outside' },
      { key: 'appliance', label: 'Appliances' },
    ]);
  });

  it('offers nothing when every sensor is in one group', () => {
    const sensors = { a: { name: 'Living Room' }, b: { name: 'Attic' } };
    expect(sensorGroupFilters(sensors, classify, GROUPS)).toEqual([]);
  });

  it('offers nothing for an empty or missing sensor map', () => {
    expect(sensorGroupFilters({}, classify, GROUPS)).toEqual([]);
    expect(sensorGroupFilters(null, classify, GROUPS)).toEqual([]);
  });
});
