// Sensor groups (groups.js) and ui.html's copy of the same rules. The page
// can't import a module, so it carries its own defaultGroupRules() and
// classifyByRules(); these tests fail when the two drift apart.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_GROUP_RULES, defaultGroupRules, classifyByRules, classifySensor,
  validGroupsConfig, isMetered, GROUP_KEYS,
} from '../groups.js';

const UI = readFileSync(new URL('../ui.html', import.meta.url), 'utf8');

function extractFunctions(names, prelude = '') {
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
  return new Function(`${prelude}\n${src}\nreturn { ${names.join(', ')} };`)();
}

const ui = extractFunctions(['defaultGroupRules', 'classifyByRules', 'isMeteredGroup']);

const NAMES = [
  'Living Room', 'Kitchen', 'Primary Bedroom', 'Kids Room', 'Attic', 'Basement', 'Crawl Space',
  'Outside', 'Back Patio', 'Garage', 'Garage Fridge', 'Refrigerator', 'Freezer', 'Wine Cellar',
  'Server Closet', 'Steven Backpack', 'Car', 'Ecoflow Glacier', 'Beer Cooler', 'Network Rack',
  'Greenhouse', '', null,
];

describe('default group rules', () => {
  it.each([
    ['Refrigerator', 'appliance'],           // \brefrig\b used to miss it
    ['Garage Fridge', 'appliance'],          // appliance before outside
    ['Back Patio', 'outside'],
    ['Steven Backpack', 'mobile'],
    ['Car', 'mobile'],
    ['Ecoflow Glacier', 'other'],            // product words are not defaults
    ['Beer Cooler', 'other'],
    ['Network Rack', 'other'],
    ['Greenhouse', 'other'],
  ])('%s → %s', (name, group) => {
    expect(classifyByRules(name, null, DEFAULT_GROUP_RULES).group).toBe(group);
  });

  it('puts house rooms in their built-in subgroups', () => {
    expect(classifyByRules('Primary Bedroom', [], DEFAULT_GROUP_RULES)).toEqual({ group: 'house', subgroup: 'bedrooms' });
    expect(classifyByRules('Crawl Space', [], DEFAULT_GROUP_RULES)).toEqual({ group: 'house', subgroup: 'basement' });
  });

  it('carry no device or product names', () => {
    const words = DEFAULT_GROUP_RULES.map(r => r.match).join('|');
    for (const w of ['glacier', 'cooler', 'rack', 'ecoflow']) expect(words).not.toMatch(new RegExp(`\\b${w}\\b`));
  });

  it('use only known groups', () => {
    for (const r of DEFAULT_GROUP_RULES) expect(GROUP_KEYS).toContain(r.group);
    expect(validGroupsConfig({ rules: DEFAULT_GROUP_RULES })).toBe(true);
  });
});

describe('user group rules', () => {
  it('are checked before the defaults', () => {
    const rules = [{ match: 'glacier|cooler', group: 'mobile' }, { match: 'fridge', group: 'other' }];
    expect(classifyByRules('Ecoflow Glacier', rules, DEFAULT_GROUP_RULES).group).toBe('mobile');
    expect(classifyByRules('Garage Fridge', rules, DEFAULT_GROUP_RULES).group).toBe('other');
  });

  it('map a built-in room label onto its key and keep any other label', () => {
    const rules = [
      { match: 'wesley|primary', group: 'house', subgroup: 'Second floor' },
      { match: 'den', group: 'house', subgroup: 'Bedrooms' },
      { match: 'studio', group: 'house', subgroup: 'living rooms' },
    ];
    expect(classifyByRules('Wesley Bedroom', rules, DEFAULT_GROUP_RULES)).toEqual({ group: 'house', subgroup: 'Second floor' });
    expect(classifyByRules('Den', rules, DEFAULT_GROUP_RULES)).toEqual({ group: 'house', subgroup: 'bedrooms' });
    expect(classifyByRules('Studio', rules, DEFAULT_GROUP_RULES)).toEqual({ group: 'house', subgroup: 'living' });
  });

  it('give a subgroup only to house sensors', () => {
    expect(classifyByRules('Shed', [{ match: 'shed', group: 'outside', subgroup: 'x' }], [])).toEqual({ group: 'outside', subgroup: null });
  });

  it('skip a rule whose regex does not compile instead of throwing', () => {
    expect(classifyByRules('Attic', [{ match: '(', group: 'other' }], DEFAULT_GROUP_RULES).group).toBe('house');
  });

  it('are read from settings.groups.rules on the server', () => {
    expect(classifySensor('Ecoflow Glacier', { groups: { rules: [{ match: 'glacier', group: 'mobile' }] } }).group).toBe('mobile');
    expect(classifySensor('Ecoflow Glacier', {}).group).toBe('other');
    expect(classifySensor('Attic', null).group).toBe('house');
  });
});

describe('ui.html and groups.js agree', () => {
  it('have the same default rules', () => {
    expect(ui.defaultGroupRules()).toEqual(defaultGroupRules());
  });

  it('classify every name the same way, with and without user rules', () => {
    const rules = [{ match: 'glacier', group: 'mobile' }, { match: 'attic', group: 'house', subgroup: 'Top floor' }, { match: '[', group: 'other' }];
    for (const n of NAMES) {
      for (const r of [null, [], rules]) {
        expect(ui.classifyByRules(n, r, ui.defaultGroupRules())).toEqual(classifyByRules(n, r, DEFAULT_GROUP_RULES));
      }
    }
  });

  it('match metered groups the same way', () => {
    for (const [list, names] of [[['Attic'], ['attic']], [['steam '], ['Steam']], [[], ['x']], [null, ['x']], [['a'], [null, 'b']]]) {
      expect(ui.isMeteredGroup(list, ...names)).toBe(isMetered(list, ...names));
    }
  });
});

describe('validGroupsConfig', () => {
  it('accepts null, an empty object and a list of rules', () => {
    expect(validGroupsConfig(null)).toBe(true);
    expect(validGroupsConfig({})).toBe(true);
    expect(validGroupsConfig({ rules: [{ match: 'x', group: 'house', subgroup: 'Upstairs' }] })).toBe(true);
  });

  it('rejects over-long regexes, long room labels and too many rules', () => {
    expect(validGroupsConfig({ rules: [{ match: 'x'.repeat(201), group: 'house' }] })).toBe(false);
    expect(validGroupsConfig({ rules: [{ match: 'x', group: 'house', subgroup: 'y'.repeat(41) }] })).toBe(false);
    expect(validGroupsConfig({ rules: Array.from({ length: 101 }, () => ({ match: 'x', group: 'other' })) })).toBe(false);
  });
});

describe('Live and Stats grouping in ui.html', () => {
  const settings = { groups: { rules: [
    { match: 'wesley|primary', group: 'house', subgroup: 'Second floor' },
    { match: 'glacier', group: 'mobile' },
  ] } };
  const page = extractFunctions(
    ['defaultGroupRules', 'classifyByRules', 'classifySensor', 'rtGroups', '_mean', 'grainsPerLb', '_satVaporHpa', 'indoorOutdoorRows'],
    `const _settings = ${JSON.stringify(settings)};
     const RT_GROUPS = ${UI.match(/const RT_GROUPS = (\[[\s\S]*?\n\]);/)[1]};
     const _DEFAULT_GROUP_RULES = defaultGroupRules();`,
  );

  it('adds the user\'s own rooms after the built-in ones, and a Mobile group', () => {
    const groups = page.rtGroups();
    expect(groups[0].subgroups.map(s => s.key)).toEqual(['attic', 'bedrooms', 'living', 'basement', 'Second floor']);
    expect(groups.map(g => g.key)).toEqual(['house', 'outside', 'appliance', 'mobile', 'other']);
  });

  it('compares moisture by the user\'s rooms, and keeps house sensors with no room', () => {
    const mk = (name, dewAvg, tempAvg = 68) => ({ group: page.classifySensor(name), stats: { dewAvg, tempAvg } });
    const all = [
      mk('Primary Bedroom', 52), mk('Wesley Bedroom', 54),
      mk('Attic', 50),
      mk('Sunroom', 40), // no default room word: falls to "other", not compared
      mk('Outside', 40, 50),
      mk('Ecoflow Glacier', 30, 40),
    ];
    all.push({ group: { group: 'house', subgroup: null }, stats: { dewAvg: 45, tempAvg: 66 } });
    const io = page.indoorOutdoorRows(all, page.rtGroups());
    expect(io.rows.map(r => [r.label, r.n])).toEqual([['Attic', 1], ['Second floor', 2], ['House (no room)', 1]]);
    expect(io.rows.find(r => r.label === 'Second floor').dew).toBeCloseTo(53, 6);
    expect(io.outDew).toBe(40);
    expect(io.rows[0].dGrains).toBeGreaterThan(0);
  });
});

describe('mold risk tiers', () => {
  it('differ in colour and in glyph, not colour alone', () => {
    const block = UI.match(/const tier = \{\s*high:[\s\S]*?\n  \};/)[0];
    const tiers = [...block.matchAll(/glyph: '([^']+)',\s*color: '([^']+)',\s*label: '([^']+)'/g)].map(m => m.slice(1));
    expect(tiers).toHaveLength(3);
    expect(new Set(tiers.map(t => t[0])).size).toBe(3);
    expect(new Set(tiers.map(t => t[1])).size).toBe(3);
  });
});
