// Moisture helpers in ui.html, tested from ui.html's own source rather than
// a copy (ui-helpers.test.js duplicates its functions; these would drift).
// extractFunctions() pulls named top-level `function` declarations out of
// the page's script and evaluates them together.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dewPointF as serverDewPointF } from '../db.js';

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
