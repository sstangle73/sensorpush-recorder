// Sensor groups: what kind of place a sensor sits in, worked out from its
// display name. The Live and Stats tabs group by it, and it decides which
// sensors the house panels (mold, indoor vs outdoor, HVAC) and the anomaly
// notifier look at.
//
// Rules are checked in order and the first match wins: the user's own rules
// (settings.groups.rules) first, then DEFAULT_GROUP_RULES. A rule is
//   { match: '<regex, case-insensitive>', group: 'house'|'outside'|'appliance'|'mobile'|'other',
//     subgroup?: '<room label>' }   // subgroup only means something for 'house'
// A subgroup naming a built-in one ('Bedrooms', 'basement') maps onto it;
// any other label becomes a group of its own ("Second floor").
//
// The default rules carry only generic words. ui.html keeps a copy of
// defaultGroupRules() and classifyByRules(); tests/groups.test.js fails
// when the two drift apart.

export const GROUP_KEYS = ['house', 'outside', 'appliance', 'mobile', 'other'];

export const DEFAULT_GROUP_RULES = defaultGroupRules();

export function defaultGroupRules() {
  return [
    // Appliance before Outside, so a "Garage Fridge" is an appliance.
    { match: '\\b(fridge|refrig\\w*|freezer|cabinet|server|wine|incubator|pantry)\\b', group: 'appliance' },
    { match: '\\b(outside|outdoor|yard|patio|deck|shed|garage|exterior|porch)\\b', group: 'outside' },
    // Sensors that travel: their swings are trips, not weather or heating.
    { match: '\\b(backpack|bag|car|vehicle|truck|rv|camper|boat|travel|portable|mobile)\\b', group: 'mobile' },
    { match: '\\battic\\b', group: 'house', subgroup: 'attic' },
    { match: '\\b(bedroom|bedrm|bath|nursery|loft|master|kids?)\\b', group: 'house', subgroup: 'bedrooms' },
    { match: '\\b(living|kitchen|dining|family|foyer|den|study|office|main|hallway|entry|mudroom)\\b', group: 'house', subgroup: 'living' },
    { match: '\\b(basement|cellar|crawl)\\b', group: 'house', subgroup: 'basement' },
  ];
}

// First matching rule wins; a rule whose regex doesn't compile is skipped.
// Returns { group, subgroup }; subgroup is null outside 'house'.
export function classifyByRules(name, userRules, defaults) {
  const n = name || '';
  const builtIn = { attic: 'attic', bedrooms: 'bedrooms', 'living rooms': 'living', living: 'living', basement: 'basement' };
  for (const r of [...(Array.isArray(userRules) ? userRules : []), ...(defaults || [])]) {
    if (!r || typeof r.match !== 'string') continue;
    let re;
    try { re = new RegExp(r.match, 'i'); } catch { continue; }
    if (!re.test(n)) continue;
    if (r.group !== 'house') return { group: r.group, subgroup: null };
    const label = (r.subgroup || '').toString().trim();
    return { group: 'house', subgroup: label ? (builtIn[label.toLowerCase()] || label) : null };
  }
  return { group: 'other', subgroup: null };
}

// The server's view of one sensor's group, with the user's rules from settings.
export function classifySensor(name, settings) {
  return classifyByRules(name, settings?.groups?.rules, DEFAULT_GROUP_RULES);
}

// settings.groups shape: { rules?: [{ match, group, subgroup? }] }, at most
// 100 rules, each regex at most 200 characters and compilable.
export function validGroupsConfig(c) {
  if (c == null) return true;
  if (typeof c !== 'object' || Array.isArray(c)) return false;
  for (const k of Object.keys(c)) {
    if (k !== 'rules') return false;
  }
  const rules = c.rules;
  if (rules == null) return true;
  if (!Array.isArray(rules) || rules.length > 100) return false;
  for (const r of rules) {
    if (r == null || typeof r !== 'object' || Array.isArray(r)) return false;
    for (const k of Object.keys(r)) {
      if (!['match', 'group', 'subgroup'].includes(k)) return false;
    }
    if (typeof r.match !== 'string' || !r.match || r.match.length > 200) return false;
    try { new RegExp(r.match, 'i'); } catch { return false; }
    if (!GROUP_KEYS.includes(r.group)) return false;
    if (r.subgroup != null && (typeof r.subgroup !== 'string' || r.subgroup.length > 40)) return false;
  }
  return true;
}

// settings.hvac.meteredGroups: groups, rooms or HVAC zone names whose
// equipment is measured somewhere else (a circuit monitor, a smart
// thermostat). The inferred-from-temperature HVAC panels leave them out
// rather than contradict a real meter. Matching ignores case.
export function isMetered(meteredGroups, ...names) {
  if (!Array.isArray(meteredGroups) || !meteredGroups.length) return false;
  const set = new Set(meteredGroups.map(g => String(g).trim().toLowerCase()));
  return names.some(n => n != null && set.has(String(n).trim().toLowerCase()));
}
