import { describe, it, expect } from 'vitest';
import { computeDriftStats, classifyDrift } from '../drift.js';

// Build N hourly samples of constant delta T/H starting at startTs (seconds).
function stable({ n, startTs, deltaT, deltaH }) {
  return Array.from({ length: n }, (_, i) => ({
    ts:            startTs + i * 3600,
    deltaTemp:     deltaT,
    deltaHumidity: deltaH,
  }));
}

// Build N hourly samples whose delta grows linearly at the given per-day rate.
function drifting({ n, startTs, baseT, baseH, slopeTPerDay, slopeHPerDay }) {
  return Array.from({ length: n }, (_, i) => {
    const days = (i * 3600) / 86400;
    return {
      ts:            startTs + i * 3600,
      deltaTemp:     baseT + slopeTPerDay * days,
      deltaHumidity: baseH + slopeHPerDay * days,
    };
  });
}

// Step-change: first half at one delta, second half at another.
function stepChange({ n, startTs, beforeT, afterT, beforeH, afterH }) {
  const half = Math.floor(n / 2);
  return Array.from({ length: n }, (_, i) => ({
    ts:            startTs + i * 3600,
    deltaTemp:     i < half ? beforeT : afterT,
    deltaHumidity: i < half ? beforeH : afterH,
  }));
}

describe('computeDriftStats — degenerate inputs', () => {
  it('returns zeroed stats on empty array', () => {
    const r = computeDriftStats([]);
    expect(r.nPairs).toBe(0);
    expect(r.meanTemp).toBeNull();
    expect(r.meanHumidity).toBeNull();
    expect(r.slopeTempPerDay).toBeNull();
    expect(r.slopeHumidityPerDay).toBeNull();
    expect(r.spanDays).toBeNull();
  });

  it('returns zeroed stats on null/undefined', () => {
    expect(computeDriftStats(null).nPairs).toBe(0);
    expect(computeDriftStats(undefined).nPairs).toBe(0);
  });

  it('returns null slopes when only one sample (no regression possible)', () => {
    const r = computeDriftStats([{ ts: 1000, deltaTemp: 0.5, deltaHumidity: 1.2 }]);
    expect(r.nPairs).toBe(1);
    expect(r.meanTemp).toBeCloseTo(0.5);
    expect(r.meanHumidity).toBeCloseTo(1.2);
    expect(r.slopeTempPerDay).toBeNull();
    expect(r.slopeHumidityPerDay).toBeNull();
    expect(r.spanDays).toBeNull();
  });
});

describe('computeDriftStats — stable pair', () => {
  it('zero slope when both sensors agree exactly (delta = 0 throughout)', () => {
    const samples = stable({ n: 24 * 30, startTs: 1_700_000_000, deltaT: 0, deltaH: 0 });
    const r = computeDriftStats(samples);
    expect(r.nPairs).toBe(24 * 30);
    expect(r.meanTemp).toBeCloseTo(0);
    expect(r.meanHumidity).toBeCloseTo(0);
    expect(r.slopeTempPerDay).toBeCloseTo(0);
    expect(r.slopeHumidityPerDay).toBeCloseTo(0);
    expect(r.spanDays).toBeCloseTo(29.96, 1); // (n-1) hours / 24
  });

  it('zero slope with a non-zero constant offset (e.g. sensors in different microclimates)', () => {
    // Sensor A consistently reads 0.7°F warmer than B, 2.5%RH lower. Drift =
    // 0 because the offset is constant — only the offset's *trend* matters.
    const samples = stable({ n: 24 * 14, startTs: 1_700_000_000, deltaT: 0.7, deltaH: -2.5 });
    const r = computeDriftStats(samples);
    expect(r.meanTemp).toBeCloseTo(0.7);
    expect(r.meanHumidity).toBeCloseTo(-2.5);
    expect(r.slopeTempPerDay).toBeCloseTo(0);
    expect(r.slopeHumidityPerDay).toBeCloseTo(0);
  });
});

describe('computeDriftStats — drifting pair', () => {
  it('recovers the synthetic temperature slope (°F/day)', () => {
    // Sensor A drifts 0.05°F/day vs B over 30 days → 1.5°F total drift.
    const samples = drifting({
      n: 24 * 30, startTs: 1_700_000_000,
      baseT: 0, baseH: 0, slopeTPerDay: 0.05, slopeHPerDay: 0,
    });
    const r = computeDriftStats(samples);
    expect(r.slopeTempPerDay).toBeCloseTo(0.05, 3);
    expect(r.slopeHumidityPerDay).toBeCloseTo(0, 3);
    // Mean ≈ slope * mid-point days = 0.05 * (29.96 / 2) ≈ 0.749
    expect(r.meanTemp).toBeCloseTo(0.749, 2);
  });

  it('recovers the synthetic humidity slope (%RH/day)', () => {
    const samples = drifting({
      n: 24 * 14, startTs: 1_700_000_000,
      baseT: 0, baseH: 0, slopeTPerDay: 0, slopeHPerDay: -0.2,
    });
    const r = computeDriftStats(samples);
    expect(r.slopeHumidityPerDay).toBeCloseTo(-0.2, 3);
    expect(r.slopeTempPerDay).toBeCloseTo(0, 3);
  });

  it('handles non-zero starting offset combined with a drift trend', () => {
    // Starts 1.0°F apart, drifts 0.1°F/day on top of that.
    const samples = drifting({
      n: 24 * 20, startTs: 1_700_000_000,
      baseT: 1.0, baseH: 0, slopeTPerDay: 0.1, slopeHPerDay: 0,
    });
    const r = computeDriftStats(samples);
    expect(r.slopeTempPerDay).toBeCloseTo(0.1, 3);
    // Mean = baseT + slope * mid-point days
    expect(r.meanTemp).toBeGreaterThan(1.0);
  });
});

describe('computeDriftStats — step change', () => {
  it('produces a non-zero slope through the step (regression picks up the level shift)', () => {
    // 14 days at +0.5°F delta, then 14 days at +2.0°F delta. The slope
    // through the data isn't 0 — it's roughly (2.0 - 0.5) / 28d ≈ 0.054/day.
    const samples = stepChange({
      n: 24 * 28, startTs: 1_700_000_000,
      beforeT: 0.5, afterT: 2.0, beforeH: 0, afterH: 0,
    });
    const r = computeDriftStats(samples);
    expect(r.slopeTempPerDay).toBeGreaterThan(0);
    // Mean is the simple average of the two levels.
    expect(r.meanTemp).toBeCloseTo(1.25, 1);
  });

  it('zero slope when the step cancels (symmetric about midpoint)', () => {
    // +1°F first half, -1°F second half — mean is 0, slope is *negative*
    // (delta decreases over time).
    const samples = stepChange({
      n: 24 * 14, startTs: 1_700_000_000,
      beforeT: 1, afterT: -1, beforeH: 0, afterH: 0,
    });
    const r = computeDriftStats(samples);
    expect(r.meanTemp).toBeCloseTo(0, 1);
    expect(r.slopeTempPerDay).toBeLessThan(0);
  });
});

describe('computeDriftStats — robustness', () => {
  it('ignores null deltaTemp values when computing meanTemp and slopeTempPerDay', () => {
    // 100 valid points + 5 nulls — should still get a clean slope.
    const valid = drifting({
      n: 100, startTs: 1_700_000_000,
      baseT: 0, baseH: 0, slopeTPerDay: 0.02, slopeHPerDay: 0,
    });
    const withNulls = [
      ...valid,
      { ts: 1_700_999_999, deltaTemp: null, deltaHumidity: null },
      { ts: 1_701_000_000, deltaTemp: null, deltaHumidity: 0 },
    ];
    const r = computeDriftStats(withNulls);
    expect(r.nPairs).toBe(102);
    expect(r.slopeTempPerDay).toBeCloseTo(0.02, 3);
    expect(r.meanTemp).toBeGreaterThan(0);
  });
});

describe('classifyDrift', () => {
  it("returns 'unknown' for null/NaN slope", () => {
    expect(classifyDrift(null, 0.05)).toBe('unknown');
    expect(classifyDrift(NaN, 0.05)).toBe('unknown');
    expect(classifyDrift(undefined, 0.05)).toBe('unknown');
  });

  it("returns 'stable' when |slope| ≤ threshold", () => {
    expect(classifyDrift(0, 0.05)).toBe('stable');
    expect(classifyDrift(0.04, 0.05)).toBe('stable');
    expect(classifyDrift(-0.05, 0.05)).toBe('stable');
  });

  it("returns 'drifting' when |slope| > threshold", () => {
    expect(classifyDrift(0.06, 0.05)).toBe('drifting');
    expect(classifyDrift(-0.5, 0.05)).toBe('drifting');
  });
});
