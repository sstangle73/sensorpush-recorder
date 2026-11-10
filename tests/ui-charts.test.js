// Chart and layout helpers in ui.html, run from the page's own source (as in
// ui-psychro.test.js) so the tests can't drift from what the browser runs.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

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

const { axisStep, axisDecimals, timeAxisTicks, customRangeFetch, slotRuns, fmtSpan, tooltipHeading } = extractFunctions([
  'axisStep', 'axisDecimals', 'timeAxisTicks', 'rangeToSeconds', 'customRangeFetch', 'slotRuns', 'fmtSpan',
  'fmtTs', 'tooltipHeading',
]);

const HR = 3600e3, DAY = 86400e3;

describe('axisStep / axisDecimals', () => {
  const T = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
  it('picks the smallest step that fits the tick budget', () => {
    expect(axisStep(40, 10, T)).toBe(5);
    expect(axisStep(40, 4, T)).toBe(10);
    expect(axisStep(3, 10, T)).toBe(0.5);
  });
  it('falls back to the largest step', () => {
    expect(axisStep(1e6, 3, T)).toBe(50);
  });
  it('labels carry the step\'s decimals', () => {
    expect(axisDecimals(0.25)).toBe(2);
    expect(axisDecimals(0.5)).toBe(1);
    expect(axisDecimals(2)).toBe(0);
  });
});

describe('timeAxisTicks', () => {
  const anchor = new Date(2026, 10, 9, 22, 43, 17).getTime(); // local 10:43:17 PM, Nov 9
  const cases = [
    ['5 min', 5 * 60e3], ['1 h', HR], ['24 h', DAY], ['48 h', 2 * DAY],
    ['7 d', 7 * DAY], ['30 d', 30 * DAY], ['90 d', 90 * DAY], ['1 yr', 365 * DAY],
  ];
  for (const [name, span] of cases) {
    for (const maxTicks of [3, 4, 8, 14]) {
      it(`${name} at ${maxTicks} ticks: in range, within budget, no label twice in a row`, () => {
        const ticks = timeAxisTicks(anchor - span, anchor, maxTicks);
        expect(ticks.length).toBeGreaterThan(0);
        expect(ticks.length).toBeLessThanOrEqual(maxTicks + 1);
        for (const t of ticks) {
          expect(t.t).toBeGreaterThanOrEqual(anchor - span);
          expect(t.t).toBeLessThanOrEqual(anchor);
        }
        // "12 PM" on successive days is fine; the same label twice in a row
        // ("9:58 PM 9:58 PM") is not.
        for (let i = 1; i < ticks.length; i++) {
          expect(ticks[i].t).toBeGreaterThan(ticks[i - 1].t);
          expect(ticks[i].label).not.toBe(ticks[i - 1].label);
        }
      });
    }
  }

  it('sub-day ticks sit on round clock times', () => {
    for (const t of timeAxisTicks(anchor - DAY, anchor, 4)) {
      const d = new Date(t.t);
      expect(d.getMinutes()).toBe(0);
      expect(d.getSeconds()).toBe(0);
      expect(d.getHours() % 6).toBe(0);
    }
  });

  it('a tick at local midnight shows the date and is major', () => {
    const ticks = timeAxisTicks(anchor - DAY, anchor, 4);
    const mid = ticks.find(t => new Date(t.t).getHours() === 0);
    expect(mid.major).toBe(true);
    expect(mid.label).toMatch(/Nov/);
    expect(ticks.filter(t => !t.major).every(t => !/Nov/.test(t.label))).toBe(true);
  });

  it('a year ticks month starts', () => {
    const ticks = timeAxisTicks(anchor - 365 * DAY, anchor, 6);
    for (const t of ticks) expect(new Date(t.t).getDate()).toBe(1);
  });

  it('a two-minute window still gets distinct labels', () => {
    const ticks = timeAxisTicks(anchor - 2 * 60e3, anchor, 4);
    const labels = ticks.map(t => t.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('an empty or reversed window has no ticks', () => {
    expect(timeAxisTicks(anchor, anchor, 4)).toEqual([]);
    expect(timeAxisTicks(anchor, anchor - HR, 4)).toEqual([]);
  });
});

describe('customRangeFetch', () => {
  const ranges = ['1h', '24h', '48h', '1d', '7d', '30d', '90d', '1yr'];
  const now = Date.UTC(2026, 10, 9, 12);

  it('reaches back to the start, not just the window\'s length', () => {
    // Two days last January: the year range, not 48h.
    expect(customRangeFetch(ranges, Date.UTC(2026, 0, 10), now)).toBe('1yr');
    // Two hours ending a week ago: 30 d covers it, 7 d (exactly) doesn't.
    expect(customRangeFetch(ranges, now - 7 * DAY - 2 * HR, now)).toBe('30d');
  });

  it('takes the smallest range that reaches back', () => {
    expect(customRangeFetch(ranges, now - 20 * HR, now)).toBe('24h');
    expect(customRangeFetch(ranges, now - 30 * 60e3, now)).toBe('1h');
  });

  it('falls back to the longest range, or 365d with none configured', () => {
    expect(customRangeFetch(ranges, now - 3 * 365 * DAY, now)).toBe('1yr');
    expect(customRangeFetch([], now - DAY, now)).toBe('365d');
  });
});

describe('slotRuns', () => {
  it('merges consecutive equal slots', () => {
    expect(slotRuns(['ok', 'ok', 'gap', 'ok', 'sparse', 'sparse'])).toEqual([
      { state: 'ok', n: 2 }, { state: 'gap', n: 1 }, { state: 'ok', n: 1 }, { state: 'sparse', n: 2 },
    ]);
    expect(slotRuns([])).toEqual([]);
  });
});

describe('fmtSpan', () => {
  it('whole numbers unless they would read as one value', () => {
    expect(fmtSpan(67.2, 70.4)).toBe('67–70');
    expect(fmtSpan(68.6, 69.4)).toBe('68.6–69.4');
  });
});

describe('tooltipHeading', () => {
  const ms = new Date(2026, 8, 7, 13, 27).getTime();
  it('names the day for a daily point, the hour for an hourly one', () => {
    expect(tooltipHeading(ms, 'daily')).toMatch(/Sep.*7.*2026.*day avg/);
    expect(tooltipHeading(ms, 'daily')).not.toMatch(/27/);
    expect(tooltipHeading(ms, 'hourly')).toMatch(/hour avg/);
    expect(tooltipHeading(ms, 'hourly')).not.toMatch(/27/);
    expect(tooltipHeading(ms, 'raw')).toMatch(/27/);
  });
});
