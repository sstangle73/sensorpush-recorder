import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseConfig, loadConfig } from '../config.js';

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

describe('loadConfig — env-var fallback', () => {
  let savedEmail, savedPassword, savedLat, savedLon;
  beforeEach(() => {
    savedEmail = process.env.SENSORPUSH_EMAIL;
    savedPassword = process.env.SENSORPUSH_PASSWORD;
    savedLat = process.env.WEATHER_LAT;
    savedLon = process.env.WEATHER_LON;
    delete process.env.SENSORPUSH_EMAIL;
    delete process.env.SENSORPUSH_PASSWORD;
    delete process.env.WEATHER_LAT;
    delete process.env.WEATHER_LON;
  });
  afterEach(() => {
    if (savedEmail    !== undefined) process.env.SENSORPUSH_EMAIL    = savedEmail;    else delete process.env.SENSORPUSH_EMAIL;
    if (savedPassword !== undefined) process.env.SENSORPUSH_PASSWORD = savedPassword; else delete process.env.SENSORPUSH_PASSWORD;
    if (savedLat      !== undefined) process.env.WEATHER_LAT         = savedLat;      else delete process.env.WEATHER_LAT;
    if (savedLon      !== undefined) process.env.WEATHER_LON         = savedLon;      else delete process.env.WEATHER_LON;
  });

  it('uses env vars when both SENSORPUSH_EMAIL and SENSORPUSH_PASSWORD are set', () => {
    process.env.SENSORPUSH_EMAIL = 'env@example.com';
    process.env.SENSORPUSH_PASSWORD = 'envpw';
    const cfg = loadConfig();
    expect(cfg.sensorpush).toEqual({ email: 'env@example.com', password: 'envpw' });
  });

  it('falls back to file (which is missing in tests) when only one env var is set', () => {
    process.env.SENSORPUSH_EMAIL = 'only-email@example.com';
    // No password set — env path should not match.
    const cfg = loadConfig();
    expect(cfg.sensorpush).toBeUndefined();
  });

  it('layers WEATHER_LAT / WEATHER_LON onto the config', () => {
    process.env.SENSORPUSH_EMAIL = 'a@b.com';
    process.env.SENSORPUSH_PASSWORD = 'pw';
    process.env.WEATHER_LAT = '43.65';
    process.env.WEATHER_LON = '-79.38';
    const cfg = loadConfig();
    expect(cfg.weather).toEqual({ lat: 43.65, lon: -79.38 });
  });

  it('ignores WEATHER_LAT / LON when missing or non-finite', () => {
    process.env.SENSORPUSH_EMAIL = 'a@b.com';
    process.env.SENSORPUSH_PASSWORD = 'pw';
    process.env.WEATHER_LAT = 'not-a-number';
    process.env.WEATHER_LON = '-79.38';
    const cfg = loadConfig();
    expect(cfg.weather).toBeUndefined();
  });

  it('ignores WEATHER_LAT / LON when out of valid earth bounds', () => {
    process.env.SENSORPUSH_EMAIL = 'a@b.com';
    process.env.SENSORPUSH_PASSWORD = 'pw';
    process.env.WEATHER_LAT = '200';   // > 90, invalid
    process.env.WEATHER_LON = '-79.38';
    expect(loadConfig().weather).toBeUndefined();
  });
});

describe('parseConfig — weather block', () => {
  it('extracts weather.{lat,lon} when present in DASHBOARD_CONFIG', () => {
    const cfg = parseConfig(`window.DASHBOARD_CONFIG = {
      sensorpush: { email: 'a@b.com', password: 'pw' },
      weather:    { lat: 43.65, lon: -79.38 },
    };`);
    expect(cfg.weather).toEqual({ lat: 43.65, lon: -79.38 });
  });

  it('leaves weather undefined when the block is absent', () => {
    const cfg = parseConfig(`window.DASHBOARD_CONFIG = {
      sensorpush: { email: 'a@b.com', password: 'pw' },
    };`);
    expect(cfg.weather).toBeUndefined();
  });
});
