import { describe, it, expect } from 'vitest';
import { detectCycles, pickDefaultThermostatSensor, DEFAULT_OPTS } from '../hvac.js';

// Synthesize a `{ ts, temperature }[]` trace at `cadenceSecs` resolution
// using a per-sample temperature function. Times start at 0 (epoch) — they
// are relative within the trace, and detectCycles never depends on absolute
// wall-clock time.
function trace(durationSecs, cadenceSecs, tempFn) {
  const out = [];
  for (let t = 0; t <= durationSecs; t += cadenceSecs) {
    out.push({ ts: t, temperature: tempFn(t) });
  }
  return out;
}

describe('detectCycles — guards', () => {
  it('returns insufficient-data on empty input', () => {
    const r = detectCycles([]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('insufficient-data');
    expect(r.validSamples).toBe(0);
  });

  it('returns insufficient-data when valid count < minSamples', () => {
    // 6 samples, default minSamples is 12.
    const r = detectCycles(trace(30 * 60, 300, () => 70));
    expect(r.ok).toBe(false);
    expect(r.validSamples).toBe(7);
  });

  it('drops null/NaN temperatures from the valid count', () => {
    const samples = [
      ...trace(60 * 60, 300, () => 70),
      { ts: 999999, temperature: null },
      { ts: 999998, temperature: NaN },
    ];
    const r = detectCycles(samples);
    expect(r.ok).toBe(true);
    // 1h @ 5min cadence = 13 samples, plus the two null entries (dropped).
    expect(r.totalSecs).toBe(60 * 60);
  });
});

describe('detectCycles — steady-state trace', () => {
  it('reports 0% heating, 0% cooling, all idle for a flat trace', () => {
    // 6h of dead-flat 70°F.
    const r = detectCycles(trace(6 * 3600, 300, () => 70));
    expect(r.ok).toBe(true);
    expect(r.cycleCount).toBe(0);
    expect(r.heatingRuntimePct).toBe(0);
    expect(r.coolingRuntimePct).toBe(0);
    expect(r.idleSecs).toBe(r.totalSecs);
    expect(r.dominantKind).toBe('idle');
  });

  it('does not count tiny noise (below slope threshold) as cycles', () => {
    // ±0.05°F jitter at 5min cadence ⇒ slope ≪ 0.5°F/hr threshold.
    const r = detectCycles(trace(6 * 3600, 300, t => 70 + 0.05 * Math.sin(t / 600)));
    expect(r.cycleCount).toBe(0);
    expect(r.heatingRuntimePct).toBe(0);
  });
});

describe('detectCycles — single heating cycle', () => {
  it('identifies one heating cycle when temperature ramps up then plateaus', () => {
    // 0–30min: ramp +6°F (≈12°F/hr). 30min–3h: hold at 76°F.
    // The ramp should be classified as heating; the plateau as idle.
    const r = detectCycles(trace(3 * 3600, 60, t => {
      if (t <= 30 * 60) return 70 + (t / (30 * 60)) * 6;
      return 76;
    }));
    expect(r.ok).toBe(true);
    expect(r.heatingCycleCount).toBeGreaterThanOrEqual(1);
    expect(r.coolingCycleCount).toBe(0);
    expect(r.dominantKind).toBe('heating');
    expect(r.heatingRuntimePct).toBeGreaterThan(0.1);
    expect(r.heatingRuntimePct).toBeLessThan(0.5);
    // The first heating cycle's mean slope should be clearly positive.
    const firstHeat = r.cycles.find(c => c.kind === 'heating');
    expect(firstHeat.meanSlopeFPerHour).toBeGreaterThan(0);
  });

  it('returns no cooling cycles when only heating is present', () => {
    const r = detectCycles(trace(2 * 3600, 60, t => 68 + (t / 3600) * 4)); // +4°F/hr steady ramp
    expect(r.heatingCycleCount).toBeGreaterThanOrEqual(1);
    expect(r.coolingCycleCount).toBe(0);
    expect(r.heatingRuntimePct).toBeGreaterThan(0.5);
  });
});

describe('detectCycles — short-cycling pattern', () => {
  it('flags cycles shorter than shortCycleSecs in shortCycles', () => {
    // 6 distinct 2-min heating ramps separated by 4-min idle stretches.
    // Each ramp: +1°F over 2min ⇒ slope ≈ 30°F/hr, well above threshold.
    // shortCycleSecs default = 5min ⇒ all 6 should be flagged.
    let base = 70;
    const r = detectCycles(trace(60 * 60, 30, t => {
      const cycleIdx   = Math.floor(t / 360);     // 6 min per cycle (2 ramp + 4 idle)
      const inCycle    = t - cycleIdx * 360;
      base = 70 + cycleIdx * 0.01;                // tiny drift so cycles are independent
      if (inCycle < 120) return base + (inCycle / 120) * 1;
      return base + 1;
    }), { shortCycleSecs: 5 * 60, slopeThresholdF: 0.5 });

    expect(r.ok).toBe(true);
    expect(r.shortCycles.length).toBeGreaterThanOrEqual(3);
    // Every flagged short cycle must be strictly shorter than the threshold.
    for (const sc of r.shortCycles) {
      expect(sc.durationSecs).toBeLessThan(5 * 60);
    }
  });

  it('respects a tighter shortCycleSecs override', () => {
    // Same ramp pattern; with shortCycleSecs=60s, fewer should qualify.
    const r = detectCycles(trace(60 * 60, 30, t => {
      const cycleIdx = Math.floor(t / 360);
      const inCycle  = t - cycleIdx * 360;
      if (inCycle < 120) return 70 + (inCycle / 120);
      return 71;
    }), { shortCycleSecs: 30 });
    expect(r.shortCycles.length).toBe(0);
  });
});

describe('detectCycles — mixed heating + cooling day', () => {
  it('identifies both heating and cooling cycles and picks a dominant kind', () => {
    // Morning (0–4h): heating ramp +6°F. Midday (4–8h): cooling ramp −8°F.
    // Evening (8–12h): heating again, ramp +4°F.
    const r = detectCycles(trace(12 * 3600, 60, t => {
      if (t < 4 * 3600)  return 70 + (t / (4 * 3600)) * 6;
      if (t < 8 * 3600)  return 76 - ((t - 4 * 3600) / (4 * 3600)) * 8;
      return 68 + ((t - 8 * 3600) / (4 * 3600)) * 4;
    }));
    expect(r.ok).toBe(true);
    expect(r.heatingCycleCount).toBeGreaterThanOrEqual(1);
    expect(r.coolingCycleCount).toBeGreaterThanOrEqual(1);
    // heating: 10°F across 8h; cooling: 8°F across 4h. Heating runtime > cooling.
    expect(r.heatingRuntimePct).toBeGreaterThan(r.coolingRuntimePct);
    expect(r.dominantKind).toBe('heating');
  });

  it('switches dominant to cooling when cooling outpaces heating', () => {
    // 8h of steady cooling (−1°F/hr), 1h of mild heating.
    const r = detectCycles(trace(9 * 3600, 120, t => {
      if (t < 8 * 3600) return 78 - (t / 3600);   // 78 → 70 over 8h
      return 70 + ((t - 8 * 3600) / 3600) * 0.6;  // mild rise, just under threshold
    }));
    expect(r.coolingRuntimePct).toBeGreaterThan(r.heatingRuntimePct);
    expect(r.dominantKind).toBe('cooling');
  });
});

describe('detectCycles — runtime % bounds', () => {
  it('reports runtime percentages that sum to ≤1 with idle making up the remainder', () => {
    const r = detectCycles(trace(8 * 3600, 60, t => 70 + Math.sin(t / 1800) * 3));
    expect(r.heatingRuntimePct + r.coolingRuntimePct).toBeLessThanOrEqual(1.0001);
    expect(r.heatingRuntimeSecs + r.coolingRuntimeSecs + r.idleSecs).toBeCloseTo(r.totalSecs, 0);
  });

  it('exposes the effective options on the result for callers', () => {
    const r = detectCycles(trace(2 * 3600, 300, () => 70), { slopeThresholdF: 0.25 });
    expect(r.opts.slopeThresholdF).toBe(0.25);
    expect(r.opts.shortCycleSecs).toBe(DEFAULT_OPTS.shortCycleSecs);
  });
});

describe('pickDefaultThermostatSensor', () => {
  // Build a 24h trace at 5min cadence around `base` with given noise amplitude.
  function tr(base, noise) {
    return trace(24 * 3600, 300, t => base + noise * Math.sin(t / 1800));
  }

  it('returns null when no eligible sensor has enough samples', () => {
    const got = pickDefaultThermostatSensor([
      { id: 'a', group: 'house', samples: tr(70, 1).slice(0, 5) },
    ]);
    expect(got).toBeNull();
  });

  it('picks the lowest-variance indoor sensor', () => {
    const got = pickDefaultThermostatSensor([
      { id: 'stable',   group: 'house',     samples: tr(70, 0.3) },
      { id: 'jittery',  group: 'house',     samples: tr(70, 3.0) },
      { id: 'outside',  group: 'outside',   samples: tr(50, 0.1) }, // even lower var, but outdoor
      { id: 'fridge',   group: 'appliance', samples: tr(38, 0.1) }, // even lower, but appliance
    ]);
    expect(got).toBe('stable');
  });

  it('falls back to deterministic id order on a perfect variance tie', () => {
    const got = pickDefaultThermostatSensor([
      { id: 'b', group: 'house', samples: tr(70, 0) },
      { id: 'a', group: 'house', samples: tr(70, 0) },
    ]);
    expect(got).toBe('a');
  });

  it('honors eligibleGroups override', () => {
    const got = pickDefaultThermostatSensor([
      { id: 'inside',  group: 'house',   samples: tr(70, 1.0) },
      { id: 'outside', group: 'outside', samples: tr(50, 0.1) },
    ], { eligibleGroups: ['outside'] });
    expect(got).toBe('outside');
  });
});
