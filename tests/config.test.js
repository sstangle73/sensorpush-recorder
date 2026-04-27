import { describe, it, expect } from 'vitest';
import { parseConfig } from '../config.js';

describe('parseConfig', () => {
  it('extracts DASHBOARD_CONFIG when present', () => {
    const cfg = parseConfig(`window.DASHBOARD_CONFIG = { sensorpush: { email: 'a@b.com', password: 'pw' } };`);
    expect(cfg.sensorpush.email).toBe('a@b.com');
    expect(cfg.sensorpush.password).toBe('pw');
  });

  it('returns empty object when DASHBOARD_CONFIG is not assigned', () => {
    expect(parseConfig(`var x = 1;`)).toEqual({});
  });

  it('returns empty object on malformed source (no throw)', () => {
    expect(parseConfig(`this is { not valid javascript`)).toEqual({});
  });

  it('returns empty object on empty source', () => {
    expect(parseConfig('')).toEqual({});
  });

  it('does not leak globals — sandbox via new Function with `window` param', () => {
    // The sandbox only exposes a `window` object; references to `globalThis`
    // or process inside the source should resolve to the parent scope, but
    // assignments to `window.X` should NOT leak into our process's globals.
    parseConfig(`window.LEAKED = 'oops';`);
    expect(globalThis.LEAKED).toBeUndefined();
  });
});
