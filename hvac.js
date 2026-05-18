// HVAC duty-cycle inference from a single thermostat-reference sensor's
// temperature trace. Pure, side-effect-free — operates on `[{ ts, temperature }]`
// arrays and returns cycle-segment analysis suitable for both the /hvac route
// and the Stats panel.
//
// Algorithm (detectCycles):
//   1. Sort readings by ts and drop nulls.
//   2. Smooth the temperature series with a centered rolling mean (default
//      900s = 15min window). Smoothing kills per-sample sensor noise and the
//      fast oscillations a real HVAC compressor causes inside its on-state,
//      so the slope reflects the building's response, not the duty cycle.
//   3. At each smoothed sample, compute the instantaneous slope dT/dt from
//      a centered finite difference (uses the neighbors closest in time).
//      Slope is reported in °F per hour for human-readable thresholding.
//   4. Classify each sample's state: HEATING when slope ≥ +slopeThresholdF,
//      COOLING when slope ≤ −slopeThresholdF, IDLE otherwise.
//   5. Group adjacent same-state samples into cycles. The cycle's duration
//      is `endTs - startTs`; cycles strictly shorter than `shortCycleSecs`
//      are flagged as short-cycling.
//   6. Optional outdoor-temp gate: when `opts.outdoorSamples` are supplied,
//      each cycle is checked against the mean outdoor temperature during
//      its window. A heating cycle requires outdoor < indoor − margin
//      (heater is doing real work against the environment); a cooling
//      cycle requires outdoor > indoor + margin. Cycles that fail are
//      passive thermal drift — most commonly the building re-equilibrating
//      after the *opposite* unit shut off — and are dropped. This is the
//      only mechanism in the algorithm that can distinguish "the heater
//      ran" from "the AC just stopped and the room is warming back up,"
//      which have identical signatures in temperature alone.
//   7. Aggregate runtime % per state (heating, cooling, idle) and per-cycle
//      mean length from the (gated) cycle list.
//
// "Distinguish heating vs cooling by sign of the dominant trend": each
// cycle's `kind` is set from the average slope across that cycle. A cycle
// where the average slope is positive is heating, negative is cooling.
// IDLE stretches between active cycles aren't returned as cycles.
//
// All time arithmetic is in epoch seconds. Inputs whose `ts` is in ms will
// produce nonsensical durations — callers must convert first.

export const DEFAULT_OPTS = {
  smoothWindowSecs:  15 * 60, // 15 min rolling mean
  slopeThresholdF:   0.5,     // °F/hr — "the room is being driven"
  shortCycleSecs:    5 * 60,  // cycles shorter than 5 min are flagged
  minSamples:        12,      // <12 valid samples → return empty analysis
  outdoorMarginF:    2.0,     // °F — indoor must beat outdoor by this much in the
                              // cycle's direction for the cycle to count (heating
                              // requires outdoor < indoor − margin, cooling the
                              // reverse). Only consulted when outdoorSamples are
                              // supplied. Defeats off-recovery mislabeling — when
                              // an AC unit shuts off the building warms back up,
                              // which looks identical to a heating cycle in a
                              // pure-temperature trace.
};

// Mean indoor (smoothed) temperature across a [startTs, endTs] window.
// Used by the outdoor-temp gate. Returns null if no smoothed samples fall
// within the window (shouldn't happen for any cycle emitted by _segmentCycles,
// since cycle bounds come from sample timestamps, but defensive).
function _meanIndoorOver(smoothed, startTs, endTs) {
  let sum = 0, n = 0;
  for (const p of smoothed) {
    if (p.ts < startTs) continue;
    if (p.ts > endTs) break; // smoothed is sorted by ts
    sum += p.t; n++;
  }
  return n ? sum / n : null;
}

// Mean outdoor temperature near a [startTs, endTs] cycle window. We accept
// samples up to `maxGapSecs` outside the window because outdoor data lives
// at hourly cadence and most cycles are shorter than an hour. Returns null
// when no outdoor sample is within reach — caller treats that as "no opinion"
// (keep the cycle) rather than evidence either way.
function _meanOutdoorOver(outdoorSamples, startTs, endTs, maxGapSecs = 2 * 3600) {
  if (!outdoorSamples?.length) return null;
  let sum = 0, n = 0;
  const lo = startTs - maxGapSecs, hi = endTs + maxGapSecs;
  for (const s of outdoorSamples) {
    if (s.ts < lo) continue;
    if (s.ts > hi) break; // sorted
    if (s.temp == null || !isFinite(s.temp)) continue;
    sum += s.temp; n++;
  }
  return n ? sum / n : null;
}

// Direction-of-energy check: a heating cycle requires the building to be
// losing heat to outdoors (so the heater is doing real work); a cooling
// cycle requires the building to be gaining heat from outdoors. Cycles that
// fail this test are passive thermal drift (sun, occupancy, building
// re-equilibrating after the *opposite* unit just shut off) and get
// silently dropped — they're not HVAC, even if the slope qualified.
function _applyOutdoorGate(cycles, smoothed, outdoorSamples, marginF) {
  if (!outdoorSamples?.length) return { filtered: cycles, gated: false };
  const kept = [];
  for (const c of cycles) {
    const meanIndoor  = _meanIndoorOver(smoothed, c.startTs, c.endTs);
    const meanOutdoor = _meanOutdoorOver(outdoorSamples, c.startTs, c.endTs);
    if (meanIndoor == null || meanOutdoor == null) { kept.push(c); continue; }
    if (c.kind === 'heating' && meanOutdoor >= meanIndoor - marginF) continue;
    if (c.kind === 'cooling' && meanOutdoor <= meanIndoor + marginF) continue;
    kept.push(c);
  }
  return { filtered: kept, gated: true };
}

// Build the centered rolling mean of `points` (already sorted by ts).
// For each point, average all samples whose ts is within ±halfWindow.
// halfWindow=0 short-circuits to the raw series (no smoothing).
function _rollingMean(points, halfWindowSecs) {
  if (!halfWindowSecs) return points.map(p => ({ ts: p.ts, t: p.temperature }));
  const out = new Array(points.length);
  // Two-pointer sliding window — points are sorted, so the window monotonically
  // advances. Avoids the O(n²) of a naive per-sample re-scan on long ranges.
  let lo = 0, hi = 0, sum = 0, n = 0;
  for (let i = 0; i < points.length; i++) {
    const center = points[i].ts;
    while (hi < points.length && points[hi].ts <= center + halfWindowSecs) {
      sum += points[hi].temperature; n++; hi++;
    }
    while (lo < points.length && points[lo].ts <  center - halfWindowSecs) {
      sum -= points[lo].temperature; n--; lo++;
    }
    out[i] = { ts: center, t: n ? sum / n : points[i].temperature };
  }
  return out;
}

// Per-sample slope using centered finite differences. Endpoints fall back to
// forward/backward differences. Slopes are returned in °F per hour, so the
// threshold compares directly to a human-meaningful "the room is warming by
// X°F/hr" magnitude.
function _slopes(smoothed) {
  const n = smoothed.length;
  const s = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = i === 0       ? smoothed[i]     : smoothed[i - 1];
    const b = i === n - 1   ? smoothed[i]     : smoothed[i + 1];
    const dt = b.ts - a.ts;
    s[i] = dt > 0 ? (b.t - a.t) / dt * 3600 : 0;
  }
  return s;
}

function _classify(slope, thresh) {
  if (slope >=  thresh) return 'heating';
  if (slope <= -thresh) return 'cooling';
  return 'idle';
}

// Walk the classified series and emit one cycle per contiguous run of the
// same non-idle state. Each cycle's start ts is the first sample's ts; the
// end ts is the next sample after the run (or the last sample if the run
// reaches the end of the series). meanSlope is the average slope over the
// run, used by callers to confirm the sign matches `kind`.
function _segmentCycles(smoothed, slopes, thresh) {
  const cycles = [];
  let runStart = -1, runKind = null;
  let slopeSum = 0, slopeN = 0;

  const flush = (endIdx) => {
    if (runStart < 0 || runKind === 'idle') return;
    const startTs = smoothed[runStart].ts;
    const endTs   = smoothed[Math.min(endIdx, smoothed.length - 1)].ts;
    cycles.push({
      kind:         runKind,
      startTs,
      endTs,
      durationSecs: endTs - startTs,
      meanSlopeFPerHour: slopeN ? slopeSum / slopeN : 0,
    });
  };

  for (let i = 0; i < smoothed.length; i++) {
    const k = _classify(slopes[i], thresh);
    if (k === runKind) {
      slopeSum += slopes[i]; slopeN++;
      continue;
    }
    flush(i);
    runStart  = i;
    runKind   = k;
    slopeSum  = slopes[i];
    slopeN    = 1;
  }
  flush(smoothed.length - 1);
  return cycles.filter(c => c.durationSecs > 0);
}

// Main entry point. See module-level comment for the algorithm.
//
// Returns:
//   {
//     ok: true,
//     cycles:               [{ kind, startTs, endTs, durationSecs, meanSlopeFPerHour }, …],
//     shortCycles:          subset of cycles with durationSecs < shortCycleSecs,
//     heatingRuntimeSecs,
//     coolingRuntimeSecs,
//     idleSecs,
//     totalSecs,
//     heatingRuntimePct:    heatingRuntimeSecs / totalSecs (0..1; 0 if totalSecs===0),
//     coolingRuntimePct:    coolingRuntimeSecs / totalSecs,
//     cycleCount,
//     heatingCycleCount,
//     coolingCycleCount,
//     meanCycleSecs:        mean over all (heating+cooling) cycles, null if none,
//     meanHeatingCycleSecs: null if no heating cycles,
//     meanCoolingCycleSecs: null if no cooling cycles,
//     dominantKind:         'heating' | 'cooling' | 'idle' — whichever has the
//                           larger runtime (idle if both runtimes are zero),
//     gated:                true iff opts.outdoorSamples was supplied and the
//                           outdoor-temp direction check was applied,
//     opts:                 the effective options used (for callers/tests),
//   }
//
// Opts (additional, beyond DEFAULT_OPTS):
//   outdoorSamples: [{ ts, temp }] — optional; when present enables the
//                   outdoor-temp gate (see step 6 above). Hourly cadence is
//                   fine; cycles within 2h of an outdoor sample are gated,
//                   ones without nearby outdoor data are left alone.
//
// For traces with fewer than `minSamples` valid temperature points, returns
// `{ ok: false, reason: 'insufficient-data', validSamples }` so callers can
// distinguish "no data yet" from "0% runtime".
export function detectCycles(readings, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const valid = (readings || [])
    .filter(r => r && typeof r.ts === 'number' && r.temperature != null && isFinite(r.temperature))
    .map(r => ({ ts: r.ts, temperature: r.temperature }))
    .sort((a, b) => a.ts - b.ts);

  if (valid.length < o.minSamples) {
    return { ok: false, reason: 'insufficient-data', validSamples: valid.length, opts: o };
  }

  const smoothed = _rollingMean(valid, Math.floor(o.smoothWindowSecs / 2));
  const slopes   = _slopes(smoothed);
  const rawCycles = _segmentCycles(smoothed, slopes, o.slopeThresholdF);
  const { filtered: cycles, gated } = _applyOutdoorGate(
    rawCycles, smoothed, opts.outdoorSamples, o.outdoorMarginF,
  );

  const totalSecs = smoothed[smoothed.length - 1].ts - smoothed[0].ts;
  let heatingRuntimeSecs = 0, coolingRuntimeSecs = 0;
  for (const c of cycles) {
    if (c.kind === 'heating') heatingRuntimeSecs += c.durationSecs;
    else if (c.kind === 'cooling') coolingRuntimeSecs += c.durationSecs;
  }
  const idleSecs = Math.max(0, totalSecs - heatingRuntimeSecs - coolingRuntimeSecs);

  const heatingCycles  = cycles.filter(c => c.kind === 'heating');
  const coolingCycles  = cycles.filter(c => c.kind === 'cooling');
  const meanOf = arr => arr.length ? arr.reduce((s, c) => s + c.durationSecs, 0) / arr.length : null;

  let dominantKind = 'idle';
  if (heatingRuntimeSecs > coolingRuntimeSecs && heatingRuntimeSecs > 0) dominantKind = 'heating';
  else if (coolingRuntimeSecs > heatingRuntimeSecs && coolingRuntimeSecs > 0) dominantKind = 'cooling';

  return {
    ok: true,
    cycles,
    shortCycles:          cycles.filter(c => c.durationSecs < o.shortCycleSecs),
    heatingRuntimeSecs,
    coolingRuntimeSecs,
    idleSecs,
    totalSecs,
    heatingRuntimePct:    totalSecs ? heatingRuntimeSecs / totalSecs : 0,
    coolingRuntimePct:    totalSecs ? coolingRuntimeSecs / totalSecs : 0,
    cycleCount:           cycles.length,
    heatingCycleCount:    heatingCycles.length,
    coolingCycleCount:    coolingCycles.length,
    meanCycleSecs:        meanOf(cycles),
    meanHeatingCycleSecs: meanOf(heatingCycles),
    meanCoolingCycleSecs: meanOf(coolingCycles),
    dominantKind,
    gated,
    opts: o,
  };
}

// Pick a default thermostat-reference sensor when the user hasn't flagged
// one. The most-stable indoor sensor (lowest temperature variance over the
// supplied window) is the best proxy for a thermostat — appliances cycle
// hard, outdoor sensors swing diurnally, and bedrooms drift with occupancy.
//
//   `sensorsWithSamples` is an array of:
//     { id, group, samples: [{ ts, temperature }] }
//   where `group` is the classification result (e.g. 'house', 'outside').
//
// Returns the chosen sensor id, or null when no eligible candidate has
// enough valid readings. Ties broken by sample count (more data wins), then
// by id (deterministic).
export function pickDefaultThermostatSensor(sensorsWithSamples, opts = {}) {
  const { minSamples = 24, eligibleGroups = ['house', 'other'] } = opts;
  const scored = [];
  for (const s of sensorsWithSamples) {
    if (!eligibleGroups.includes(s.group)) continue;
    const temps = (s.samples || [])
      .map(r => r.temperature)
      .filter(t => t != null && isFinite(t));
    if (temps.length < minSamples) continue;
    const mean = temps.reduce((a, b) => a + b, 0) / temps.length;
    const variance = temps.reduce((a, b) => a + (b - mean) ** 2, 0) / temps.length;
    scored.push({ id: s.id, variance, n: temps.length });
  }
  if (!scored.length) return null;
  scored.sort((a, b) =>
    a.variance - b.variance
    || b.n - a.n
    || (a.id < b.id ? -1 : 1)
  );
  return scored[0].id;
}
