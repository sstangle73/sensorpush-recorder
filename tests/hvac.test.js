import { describe, it, expect } from 'vitest';
import { detectCycles, pickDefaultThermostatSensor, combineZoneSeries, DEFAULT_OPTS } from '../hvac.js';

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
  it('suppresses sub-minute phantom cycles via decimation', () => {
    // Six 2-min "ramps" at high sample rate (30 s cadence) — the kind of
    // pattern that, before decimation, would emit 6 phantom 2-min cycles
    // due to per-sample slope flicker. With 5-min decimation each ramp is
    // absorbed into a bucket; nothing rises to a cycle.
    const r = detectCycles(trace(60 * 60, 30, t => {
      const cycleIdx   = Math.floor(t / 360);
      const inCycle    = t - cycleIdx * 360;
      const base       = 70 + cycleIdx * 0.01;
      if (inCycle < 120) return base + (inCycle / 120) * 1;
      return base + 1;
    }), { shortCycleSecs: 5 * 60, slopeThresholdF: 0.5 });
    expect(r.ok).toBe(true);
    // The whole hour is brief warmings totaling +6°F — decimation will
    // still see the overall drift as a single (or zero) cycle, but the
    // six sub-cycles should NOT each be emitted.
    expect(r.cycleCount).toBeLessThanOrEqual(2);
  });

  it('flags real short cycles when they exceed the decimation floor', () => {
    // Three ~8-min heating ramps separated by 20-min idle stretches over
    // 1.5h. Each ramp resolves to ~2 decimated samples (≥ 5 min cycle).
    // With shortCycleSecs=15min, each cycle (≈ 8-10 min) should be flagged.
    const r = detectCycles(trace(90 * 60, 60, t => {
      const period   = 28 * 60;          // 8 min ramp + 20 min idle
      const cycleIdx = Math.floor(t / period);
      const inCycle  = t - cycleIdx * period;
      const base     = 70 + cycleIdx * 0.05;
      if (inCycle < 8 * 60) return base + (inCycle / (8 * 60)) * 2;
      return base + 2;
    }), { shortCycleSecs: 15 * 60, slopeThresholdF: 0.5 });
    expect(r.ok).toBe(true);
    expect(r.heatingCycleCount).toBeGreaterThanOrEqual(2);
    // Most cycles (≥ 2/3) should be flagged short under a 15 min threshold;
    // bucket alignment can occasionally yield a single 15-min cycle when a
    // ramp straddles a decimation boundary.
    expect(r.shortCycles.length).toBeGreaterThanOrEqual(Math.ceil(r.cycleCount * 2 / 3));
    for (const sc of r.shortCycles) {
      expect(sc.durationSecs).toBeLessThan(15 * 60);
    }
  });

  it('respects a tighter shortCycleSecs override', () => {
    // Long heating ramp (60 min) — cycle is ~60 min. shortCycleSecs=60s
    // ⇒ nothing flagged.
    const r = detectCycles(trace(90 * 60, 60, t => {
      if (t < 60 * 60) return 70 + (t / (60 * 60)) * 4;
      return 74;
    }), { shortCycleSecs: 60 });
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

describe('detectCycles — outdoor-temp gate', () => {
  // Build a flat outdoor trace at a constant temperature across the same
  // window as the indoor trace, hourly cadence (matches real Open-Meteo
  // sampling). Start at t=0 to align with `trace()`.
  function flatOutdoor(durationSecs, temp) {
    const out = [];
    for (let t = 0; t <= durationSecs; t += 3600) out.push({ ts: t, temp });
    return out;
  }

  it('keeps a heating cycle when outdoor is colder than indoor by ≥ margin', () => {
    // Indoor ramps 68 → 74 (heater running on a cold day). Outdoor steady 40°F,
    // well below indoor − 2°F margin ⇒ direction matches, cycle kept.
    const indoor   = trace(2 * 3600, 60, t => 68 + (t / (2 * 3600)) * 6);
    const outdoor  = flatOutdoor(2 * 3600, 40);
    const r = detectCycles(indoor, { outdoorSamples: outdoor });
    expect(r.gated).toBe(true);
    expect(r.heatingCycleCount).toBeGreaterThanOrEqual(1);
    expect(r.heatingRuntimePct).toBeGreaterThan(0.5);
  });

  it('drops a "heating" cycle when outdoor is warmer than indoor (AC off-recovery scenario)', () => {
    // Indoor warms 72 → 78 — same slope as a heating cycle, but outdoor is
    // 88°F (summer afternoon). This is the building re-warming after the AC
    // cycled off, not the heater. Gate should drop it entirely.
    const indoor  = trace(2 * 3600, 60, t => 72 + (t / (2 * 3600)) * 6);
    const outdoor = flatOutdoor(2 * 3600, 88);
    const r = detectCycles(indoor, { outdoorSamples: outdoor });
    expect(r.gated).toBe(true);
    expect(r.heatingCycleCount).toBe(0);
    expect(r.heatingRuntimePct).toBe(0);
    expect(r.dominantKind).toBe('idle');
  });

  it('drops a "cooling" cycle when outdoor is colder than indoor (heater off-recovery)', () => {
    // Indoor cools 74 → 68, but it's 30°F outside — this is heat loss after
    // the furnace shut off, not the AC.
    const indoor  = trace(2 * 3600, 60, t => 74 - (t / (2 * 3600)) * 6);
    const outdoor = flatOutdoor(2 * 3600, 30);
    const r = detectCycles(indoor, { outdoorSamples: outdoor });
    expect(r.gated).toBe(true);
    expect(r.coolingCycleCount).toBe(0);
    expect(r.coolingRuntimePct).toBe(0);
  });

  it('drops cycles within the margin (indoor and outdoor too close to disambiguate)', () => {
    // Indoor 70 → 73 (heating slope), outdoor 72°F. delta = -2°F at most,
    // not beyond the 2°F default margin ⇒ drop.
    const indoor  = trace(2 * 3600, 60, t => 70 + (t / (2 * 3600)) * 3);
    const outdoor = flatOutdoor(2 * 3600, 72);
    const r = detectCycles(indoor, { outdoorSamples: outdoor });
    expect(r.heatingCycleCount).toBe(0);
  });

  it('respects a custom outdoorMarginF', () => {
    // Same indoor heating ramp 70 → 73 with outdoor 65°F (delta = ~6°F).
    // Margin = 8°F → outdoor (65) is NOT ≥ indoor (~71.5) − 8 = 63.5, so cycle kept.
    // Wait: heating gate is "drop if outdoor >= indoor - margin". outdoor=65,
    // indoor≈71.5, margin=8 → indoor-margin=63.5, outdoor(65) >= 63.5 → drop.
    const indoor   = trace(2 * 3600, 60, t => 70 + (t / (2 * 3600)) * 3);
    const outdoor  = flatOutdoor(2 * 3600, 65);
    const lenient = detectCycles(indoor, { outdoorSamples: outdoor, outdoorMarginF: 0.5 });
    const strict  = detectCycles(indoor, { outdoorSamples: outdoor, outdoorMarginF: 8.0 });
    expect(lenient.heatingCycleCount).toBeGreaterThanOrEqual(1);
    expect(strict.heatingCycleCount).toBe(0);
  });

  it('behaves identically to ungated when outdoorSamples are absent', () => {
    const indoor    = trace(2 * 3600, 60, t => 70 + (t / (2 * 3600)) * 6);
    const ungated   = detectCycles(indoor);
    const noSamples = detectCycles(indoor, { outdoorSamples: undefined });
    expect(ungated.gated).toBe(false);
    expect(noSamples.gated).toBe(false);
    expect(noSamples.heatingCycleCount).toBe(ungated.heatingCycleCount);
    expect(noSamples.heatingRuntimePct).toBeCloseTo(ungated.heatingRuntimePct, 6);
  });

  it('keeps a cycle whose time window has no outdoor coverage (no-opinion fallback)', () => {
    // Indoor heating cycle in the early window; outdoor data only available
    // far in the future. Cycle should be kept because gate has no opinion.
    const indoor   = trace(2 * 3600, 60, t => 70 + (t / (2 * 3600)) * 6);
    const outdoor  = [{ ts: 30 * 3600, temp: 80 }, { ts: 31 * 3600, temp: 80 }];
    const r = detectCycles(indoor, { outdoorSamples: outdoor });
    expect(r.gated).toBe(true);
    expect(r.heatingCycleCount).toBeGreaterThanOrEqual(1);
  });

  it('partitions a mixed day correctly: keeps real cycles, drops off-recovery', () => {
    // Continuous 24h trace split into a cold morning and a warm afternoon.
    // Each half has one real cycle + one off-recovery cycle, separated by an
    // idle hold. The outdoor temp transition happens during the long idle
    // stretch at hour 12, so the smoother can't bridge the seasons.
    //
    //   0– 2h: heating ramp 68→74    (outdoor 35 ⇒ kept, real heater run)
    //   2– 4h: cooling drift 74→71   (outdoor 35 ⇒ dropped, heater off-recovery)
    //   4–12h: hold at 71            (idle)
    //  12–14h: cooling ramp 71→65    (outdoor 85 ⇒ kept, real AC run)
    //  14–16h: heating drift 65→68   (outdoor 85 ⇒ dropped, AC off-recovery)
    //  16–24h: hold at 68            (idle)
    const indoor = trace(24 * 3600, 60, t => {
      if (t <  2 * 3600) return 68 + (t / (2 * 3600)) * 6;                       // 68→74
      if (t <  4 * 3600) return 74 - ((t -  2 * 3600) / (2 * 3600)) * 3;          // 74→71
      if (t < 12 * 3600) return 71;
      if (t < 14 * 3600) return 71 - ((t - 12 * 3600) / (2 * 3600)) * 6;          // 71→65
      if (t < 16 * 3600) return 65 + ((t - 14 * 3600) / (2 * 3600)) * 3;          // 65→68
      return 68;
    });
    const outdoor = [];
    for (let t = 0; t <= 24 * 3600; t += 3600) {
      outdoor.push({ ts: t, temp: t < 12 * 3600 ? 35 : 85 });
    }
    const r = detectCycles(indoor, { outdoorSamples: outdoor });
    expect(r.gated).toBe(true);
    // One real heating + one real cooling survive; the two drifts drop.
    expect(r.heatingCycleCount).toBe(1);
    expect(r.coolingCycleCount).toBe(1);
    // Sanity: ungated baseline would have caught the drifts too.
    const baseline = detectCycles(indoor);
    expect(baseline.heatingCycleCount + baseline.coolingCycleCount)
      .toBeGreaterThan(r.heatingCycleCount + r.coolingCycleCount);
  });

  it('reports gated=false explicitly when outdoor list is empty array', () => {
    const indoor = trace(2 * 3600, 60, t => 70 + (t / (2 * 3600)) * 6);
    const r = detectCycles(indoor, { outdoorSamples: [] });
    expect(r.gated).toBe(false);
    expect(r.heatingCycleCount).toBeGreaterThanOrEqual(1);
  });
});

describe('combineZoneSeries', () => {
  it('returns an empty array when no members provided', () => {
    expect(combineZoneSeries([])).toEqual([]);
    expect(combineZoneSeries(null)).toEqual([]);
  });

  it('passes a single sensor through one bucket per non-empty 5-min window', () => {
    // 1h trace at 60 s cadence = 60 samples. 5-min bucketing → 12 buckets,
    // each averaging 5 samples.
    const samples = trace(60 * 60 - 60, 60, t => 70 + t / 3600); // 70 → 71 linear
    const combined = combineZoneSeries([samples], 5 * 60);
    expect(combined.length).toBe(12);
    // Sorted by ts ascending.
    for (let i = 1; i < combined.length; i++) {
      expect(combined[i].ts).toBeGreaterThan(combined[i - 1].ts);
    }
    // Temperature is roughly monotonic with the trend.
    expect(combined[combined.length - 1].temperature).toBeGreaterThan(combined[0].temperature);
  });

  it('averages across members per bucket — each member contributes one value', () => {
    // Two sensors over the same window with constant temps 70 and 76.
    // Each bucket gets one value per sensor, mean = 73.
    const sensorA = trace(60 * 60 - 60, 60, () => 70);
    const sensorB = trace(60 * 60 - 60, 60, () => 76);
    const combined = combineZoneSeries([sensorA, sensorB], 5 * 60);
    expect(combined.length).toBeGreaterThan(0);
    for (const p of combined) {
      expect(p.temperature).toBeCloseTo(73, 6);
    }
  });

  it('does not let a fast-cadence sensor drown out a slow one', () => {
    // Sensor A samples every 30s (120 samples over 1h, mean 70°F).
    // Sensor B samples every 5 min (12 samples over 1h, mean 80°F).
    // Without per-sensor bucketing, raw union would weight A 10× → mean ≈ 71.
    // With bucketing, each contributes one value per 5-min bucket → mean = 75.
    const fastA = trace(60 * 60 - 30, 30, () => 70);
    const slowB = trace(60 * 60 - 300, 300, () => 80);
    const combined = combineZoneSeries([fastA, slowB], 5 * 60);
    expect(combined.length).toBeGreaterThan(0);
    for (const p of combined) {
      expect(p.temperature).toBeCloseTo(75, 1);
    }
  });

  it('drops buckets where no member reported', () => {
    // Two sensors that don't overlap in time — sensor A covers 0–30min,
    // sensor B covers 60–90min. The 30–60min gap should have no buckets.
    const sensorA = [];
    for (let t = 0; t < 30 * 60; t += 60) sensorA.push({ ts: t, temperature: 70 });
    const sensorB = [];
    for (let t = 60 * 60; t < 90 * 60; t += 60) sensorB.push({ ts: t, temperature: 80 });
    const combined = combineZoneSeries([sensorA, sensorB], 5 * 60);
    // No bucket should land in the gap.
    for (const p of combined) {
      const inGap = p.ts >= 30 * 60 && p.ts < 60 * 60;
      expect(inGap).toBe(false);
    }
  });

  it('produces a series detectCycles can consume directly', () => {
    // Two-sensor zone with a synchronized heating event.
    const sensorA = trace(2 * 3600, 60, t => 68 + (t / (2 * 3600)) * 6);
    const sensorB = trace(2 * 3600, 60, t => 70 + (t / (2 * 3600)) * 6);
    const combined = combineZoneSeries([sensorA, sensorB], 5 * 60);
    const r = detectCycles(combined);
    expect(r.ok).toBe(true);
    expect(r.heatingCycleCount).toBeGreaterThanOrEqual(1);
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
