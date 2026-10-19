// Moisture helpers in ui.html, tested from ui.html's own source rather than
// a copy (ui-helpers.test.js duplicates its functions; these would drift).
// extractFunctions() pulls named top-level `function` declarations out of
// the page's script and evaluates them together.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dewPointF as serverDewPointF, grainsPerLb as serverGrainsPerLb, absHumidityGm3 as serverAbsHumidityGm3 } from '../db.js';

const UI = readFileSync(new URL('../ui.html', import.meta.url), 'utf8');

function extractFunctions(names) {
  const src = names.map(name => {
    const start = UI.indexOf(`\nfunction ${name}(`);
    if (start < 0) throw new Error(`function ${name} not found in ui.html`);
    const open = UI.indexOf('{', UI.indexOf(')', start));
    let depth = 0, i = open;
    for (; i < UI.length; i++) {
      if (UI[i] === '{') depth++;
      else if (UI[i] === '}' && --depth === 0) break;
    }
    return UI.slice(start, i + 1);
  }).join('\n');
  return new Function(`${src}\nreturn { ${names.join(', ')} };`)();
}

const { dewPointF, grainsPerLb, surfaceRh, moldRisk, computeOutdoorDelta } = extractFunctions([
  '_satVaporHpa', 'dewPointF', 'grainsPerLb', 'surfaceRh', '_longestRunSecs', 'moldRisk',
  'computeOutdoorDelta',
]);

describe('psychrometrics', () => {
  it('dew point of saturated air is the air temperature', () => {
    expect(dewPointF(60, 100)).toBeCloseTo(60, 5);
  });

  it('70°F at 50% RH has a dew point near 50.5°F', () => {
    expect(dewPointF(70, 50)).toBeCloseTo(50.5, 0);
  });

  it('the server and the page compute the same dew point', () => {
    for (const [t, rh] of [[70, 50], [56, 80], [38, 95], [85, 30]]) {
      expect(serverDewPointF(t, rh)).toBeCloseTo(dewPointF(t, rh), 9);
    }
  });

  it('returns null for missing or zero RH', () => {
    expect(dewPointF(70, null)).toBeNull();
    expect(dewPointF(70, 0)).toBeNull();
  });

  it('the 50.2°F mold-line dew point is about 53.7 gr/lb', () => {
    expect(grainsPerLb(50.2)).toBeCloseTo(53.7, 0);
  });

  it('surface RH is 100% when the surface is at the dew point', () => {
    expect(surfaceRh(50, 50)).toBeCloseTo(100, 6);
  });

  it('cold surface raises RH: 64°F air at 60% is ~80% on a 56°F surface', () => {
    const rh = surfaceRh(dewPointF(64, 60), 56);
    expect(rh).toBeGreaterThan(78);
    expect(rh).toBeLessThan(83);
  });
});

describe('moldRisk with a cold surface', () => {
  // Two weeks of hourly samples, 64°F at 60% RH: comfortable air.
  const samples = Array.from({ length: 14 * 24 }, (_, i) => ({
    ts: 1_700_000_000 + i * 3600, temperature: 64, humidity: 60, dewpoint: null,
  }));

  it('air alone reads low', () => {
    expect(moldRisk(samples).level).toBe('low');
    expect(moldRisk(samples).condensing).toBeNull();
  });

  it('judged on a 56°F surface the same air is high risk', () => {
    const r = moldRisk(samples, { surfaceF: 56 });
    expect(r.level).toBe('high');
    expect(r.pct70).toBe(1);
    expect(r.surfaceF).toBe(56);
    expect(r.condensing).toBe(0);
  });

  it('counts condensation when the dew point reaches the surface', () => {
    const r = moldRisk(samples, { surfaceF: 49 });
    expect(r.condensing).toBe(1);
  });

  it('uses the stored dew point when a sample has one', () => {
    const wet = samples.map(s => ({ ...s, dewpoint: 58 }));
    expect(moldRisk(wet, { surfaceF: 56 }).condensing).toBe(1);
  });
});

describe('computeOutdoorDelta in gr/lb', () => {
  it('a warm room at lower RH can be wetter than cold outdoor air', () => {
    const d = computeOutdoorDelta(
      { temp: 70, humidity: 55, dewpoint: dewPointF(70, 55) },
      { temp: 50, humidity: 79, dewpoint: dewPointF(50, 79) },
    );
    expect(d.hum.delta).toBeLessThan(0);      // RH says drier...
    expect(d.grains.delta).toBeGreaterThan(5); // ...but it holds more water
    expect(d.dewpoint.delta).toBeGreaterThan(0);
  });

  it('omits grains when the indoor dew point is unknown', () => {
    const d = computeOutdoorDelta({ temp: 70, humidity: 50 }, { temp: 50, humidity: 80, dewpoint: 44 });
    expect(d.grains).toBeUndefined();
    expect(d.dewpoint.outdoor).toBe(44);
  });
});

describe('absolute humidity (1.4.0)', () => {
  const {
    grainsPerLb: gr, absHumidityGm3, ahValue, defaultAhUnit, panelFractions,
    tooltipSortValue, outdoorAsSample, dewPointF: dp,
  } = extractFunctions([
    '_satVaporHpa', 'dewPointF', 'grainsPerLb', 'absHumidityGm3', 'defaultAhUnit',
    'ahValue', 'panelFractions', 'tooltipSortValue', 'outdoorAsSample',
  ]);
  const within = (got, ref, pct) => expect(Math.abs(got - ref) / ref).toBeLessThan(pct / 100);

  // Reference values: ASHRAE Fundamentals psychrometric tables (humidity
  // ratio at 14.696 psia) and saturation vapour density tables. Magnus is an
  // approximation, so these hold to 1%.
  it('70°F at 50% RH is about 54.5 gr/lb and 9.2 g/m³', () => {
    within(gr(dp(70, 50)), 54.5, 1);
    within(absHumidityGm3(dp(70, 50), 70), 9.2, 1);
  });

  it('saturated air at 20°C holds 17.3 g/m³ and 103.3 gr/lb', () => {
    within(absHumidityGm3(68, 68), 17.3, 1);
    within(gr(68), 103.3, 1);
  });

  it('saturated air at 0°C holds 4.85 g/m³ and at 30°C 30.4 g/m³', () => {
    within(absHumidityGm3(32, 32), 4.85, 1);
    within(absHumidityGm3(86, 86), 30.4, 1);
  });

  it('the server and the page compute the same values', () => {
    for (const [t, rh] of [[70, 50], [56, 80], [38, 95], [85, 30], [20, 60]]) {
      const d = dp(t, rh);
      expect(serverGrainsPerLb(d)).toBeCloseTo(gr(d), 9);
      expect(serverAbsHumidityGm3(d, t)).toBeCloseTo(absHumidityGm3(d, t), 9);
    }
  });

  it('defaults to gr/lb for °F and g/m³ for °C', () => {
    expect(defaultAhUnit('F')).toBe('grlb');
    expect(defaultAhUnit('C')).toBe('gm3');
  });

  it('prefers the value the server sent, in the chosen unit', () => {
    const s = { temperature: 70, humidity: 50, humidityRatio: 60, absHumidity: 10 };
    expect(ahValue(s, 'grlb')).toBe(60);
    expect(ahValue(s, 'gm3')).toBe(10);
  });

  it('computes from T and RH when the sample has no stored value (live, outdoor)', () => {
    within(ahValue({ temperature: 70, humidity: 50 }, 'grlb'), 54.5, 1);
    within(ahValue({ temperature: 70, humidity: 50 }, 'gm3'), 9.2, 1);
    expect(ahValue({ temperature: 70, humidity: null }, 'grlb')).toBeNull();
  });

  it('falls back to the dew point when RH is missing', () => {
    expect(ahValue({ temperature: 70, humidity: null, dewpoint: 50 }, 'grlb')).toBeCloseTo(gr(50), 9);
  });

  it('reads an Open-Meteo sample through the outdoor shim', () => {
    const o = outdoorAsSample({ ts: 1, temp: 50, humidity: 79, dewpoint: 44 });
    within(ahValue(o, 'grlb'), gr(dp(50, 79)), 0.01);
  });

  it('gives the absolute-humidity panel a share of the chart, in panel order', () => {
    const f = panelFractions({ temp: true, hum: true, ah: true, baro: false, vpd: false });
    expect(f).toHaveLength(3);
    expect(f.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(f[2]).toBeLessThan(f[1]);   // smaller than the RH panel above it
    expect(panelFractions({ temp: false, hum: false, ah: true, baro: false, vpd: false })).toEqual([1]);
  });

  it('ranks tooltip rows by absolute humidity when that panel is on top', () => {
    const ser = new Set(['absHumidity']);
    expect(tooltipSortValue({ humidityRatio: 50, absHumidity: 8 }, 'ah', ser)).toBe(50);
    expect(tooltipSortValue({ humidityRatio: 50, absHumidity: 8 }, 'ah', ser, 'gm3')).toBe(8);
    expect(tooltipSortValue({ humidityRatio: 50 }, 'ah', new Set(['temp']))).toBeNull();
  });
});
