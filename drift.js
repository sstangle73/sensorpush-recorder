// Pure-function drift detector for sensor pairs. Given an array of
// pre-aligned (ts, deltaTemp, deltaHumidity) samples between two sensors,
// returns mean deltas plus linear-regression slopes of those deltas over
// time (in per-day units). Alignment is performed upstream — typically by
// JOIN-ing hourly_agg on hour_ts so both sensors land in the same buckets.
//
// "Drift" here means the slope of the delta over time: a stable pair has
// slope ≈ 0 (the sensors agree on a constant offset, even if that offset
// isn't zero — sensors live in physically different microclimates).
// A drifting pair has slope ≠ 0 — the offset is growing or shrinking
// systematically, which usually means one sensor's calibration is changing.

// Linear-regression slope of y vs x, returning slope only (intercept is
// uninteresting for drift). Skips null/non-finite pairs. Returns null when
// fewer than 2 valid points, or x has zero variance.
function _slope(xs, ys) {
  const pts = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i];
    if (x != null && y != null && isFinite(x) && isFinite(y)) pts.push([x, y]);
  }
  if (pts.length < 2) return null;
  const xm = pts.reduce((a, [x]) => a + x, 0) / pts.length;
  const ym = pts.reduce((a, [, y]) => a + y, 0) / pts.length;
  let num = 0, den = 0;
  for (const [x, y] of pts) {
    num += (x - xm) * (y - ym);
    den += (x - xm) ** 2;
  }
  if (den === 0) return null;
  return num / den;
}

function _mean(arr) {
  const v = arr.filter(x => x != null && isFinite(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

// computeDriftStats(samples) — samples is [{ ts, deltaTemp, deltaHumidity }]
// where ts is unix seconds and deltas are (sensor_a - sensor_b).
// Returns:
//   {
//     nPairs,                  // total samples received
//     meanTemp, meanHumidity,  // mean deltas (null if no valid points)
//     slopeTempPerDay,         // regression slope: Δ(deltaTemp) per day
//     slopeHumidityPerDay,
//     spanDays,                // time span of input in days (null if < 2 points)
//   }
export function computeDriftStats(samples) {
  const empty = {
    nPairs:              0,
    meanTemp:            null,
    meanHumidity:        null,
    slopeTempPerDay:     null,
    slopeHumidityPerDay: null,
    spanDays:            null,
  };
  if (!Array.isArray(samples) || samples.length === 0) return empty;

  const tsDays   = samples.map(s => s.ts != null ? s.ts / 86400 : null);
  const deltaT   = samples.map(s => s.deltaTemp);
  const deltaH   = samples.map(s => s.deltaHumidity);

  const tss = samples.map(s => s.ts).filter(t => t != null && isFinite(t));
  const spanDays = tss.length >= 2 ? (Math.max(...tss) - Math.min(...tss)) / 86400 : null;

  return {
    nPairs:              samples.length,
    meanTemp:            _mean(deltaT),
    meanHumidity:        _mean(deltaH),
    slopeTempPerDay:     _slope(tsDays, deltaT),
    slopeHumidityPerDay: _slope(tsDays, deltaH),
    spanDays,
  };
}

// Classify a drift slope as "drifting" vs "stable". Compares |slope| to a
// threshold — used by the UI to decorate pairs with shape+color cues.
// Returns 'drifting' | 'stable' | 'unknown' (null slope).
export function classifyDrift(slopePerDay, threshold) {
  if (slopePerDay == null || !isFinite(slopePerDay)) return 'unknown';
  return Math.abs(slopePerDay) > threshold ? 'drifting' : 'stable';
}
