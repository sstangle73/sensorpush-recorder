import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('node-fetch', () => ({ default: vi.fn() }));
import fetch from 'node-fetch';

import { fetchCurrentWeather, fetchHourlyWeather } from '../weather.js';

function jsonResp(data, status = 200) {
  return {
    ok:   status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchCurrentWeather', () => {
  it('returns a single sample shaped { ts, temp, humidity, dewpoint }', async () => {
    fetch.mockResolvedValueOnce(jsonResp({
      current: {
        time: 1715000000,
        temperature_2m: 68.5,
        relative_humidity_2m: 55,
        dew_point_2m: 52.3,
      },
    }));
    const result = await fetchCurrentWeather(43.65, -79.38);
    expect(result).toEqual([{ ts: 1715000000, temp: 68.5, humidity: 55, dewpoint: 52.3 }]);
  });

  it('passes lat/lon and fahrenheit unit in query string', async () => {
    fetch.mockResolvedValueOnce(jsonResp({ current: { time: 1, temperature_2m: 50, relative_humidity_2m: 40, dew_point_2m: 30 } }));
    await fetchCurrentWeather(43.65, -79.38);
    const url = fetch.mock.calls[0][0];
    expect(url).toContain('latitude=43.65');
    expect(url).toContain('longitude=-79.38');
    expect(url).toContain('temperature_unit=fahrenheit');
    expect(url).toContain('current=temperature_2m');
  });

  it('returns [] when current is missing', async () => {
    fetch.mockResolvedValueOnce(jsonResp({}));
    expect(await fetchCurrentWeather(0, 0)).toEqual([]);
  });

  it('returns [] on non-OK response (no throw)', async () => {
    fetch.mockResolvedValueOnce(jsonResp({}, 500));
    expect(await fetchCurrentWeather(0, 0)).toEqual([]);
  });

  it('returns [] on network error (no throw)', async () => {
    fetch.mockRejectedValueOnce(new Error('connection refused'));
    expect(await fetchCurrentWeather(0, 0)).toEqual([]);
  });

  it('maps missing per-field values to null rather than dropping the row', async () => {
    fetch.mockResolvedValueOnce(jsonResp({
      current: { time: 100, temperature_2m: 70, relative_humidity_2m: null, dew_point_2m: undefined },
    }));
    const [s] = await fetchCurrentWeather(0, 0);
    expect(s.temp).toBe(70);
    expect(s.humidity).toBeNull();
    expect(s.dewpoint).toBeNull();
  });
});

describe('fetchHourlyWeather', () => {
  it('zips parallel hourly arrays into [{ts, temp, humidity, dewpoint}]', async () => {
    fetch.mockResolvedValueOnce(jsonResp({
      hourly: {
        time:                  [1000, 1100, 1200],
        temperature_2m:        [60, 61, 62],
        relative_humidity_2m:  [50, 51, 52],
        dew_point_2m:          [40, 41, 42],
      },
    }));
    const result = await fetchHourlyWeather(43.65, -79.38, 7);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ ts: 1000, temp: 60, humidity: 50, dewpoint: 40 });
    expect(result[2]).toEqual({ ts: 1200, temp: 62, humidity: 52, dewpoint: 42 });
  });

  it('clamps past_days into [1, 92]', async () => {
    fetch.mockResolvedValueOnce(jsonResp({ hourly: { time: [], temperature_2m: [], relative_humidity_2m: [], dew_point_2m: [] } }));
    await fetchHourlyWeather(0, 0, 500);
    const url1 = fetch.mock.calls[0][0];
    expect(url1).toContain('past_days=92');

    fetch.mockResolvedValueOnce(jsonResp({ hourly: { time: [], temperature_2m: [], relative_humidity_2m: [], dew_point_2m: [] } }));
    await fetchHourlyWeather(0, 0, 0);
    const url2 = fetch.mock.calls[1][0];
    expect(url2).toContain('past_days=1');
  });

  it('returns [] when hourly is missing or empty', async () => {
    fetch.mockResolvedValueOnce(jsonResp({}));
    expect(await fetchHourlyWeather(0, 0)).toEqual([]);

    fetch.mockResolvedValueOnce(jsonResp({ hourly: { time: [] } }));
    expect(await fetchHourlyWeather(0, 0)).toEqual([]);
  });

  it('returns [] on non-OK response', async () => {
    fetch.mockResolvedValueOnce(jsonResp({}, 503));
    expect(await fetchHourlyWeather(0, 0)).toEqual([]);
  });

  it('returns [] on network error', async () => {
    fetch.mockRejectedValueOnce(new Error('timeout'));
    expect(await fetchHourlyWeather(0, 0)).toEqual([]);
  });

  it('preserves null per-field values rather than coercing them to 0', async () => {
    fetch.mockResolvedValueOnce(jsonResp({
      hourly: {
        time:                  [1000, 1100],
        temperature_2m:        [60, null],
        relative_humidity_2m:  [null, 51],
        dew_point_2m:          [40, null],
      },
    }));
    const r = await fetchHourlyWeather(0, 0);
    expect(r[0]).toEqual({ ts: 1000, temp: 60, humidity: null, dewpoint: 40 });
    expect(r[1]).toEqual({ ts: 1100, temp: null, humidity: 51, dewpoint: null });
  });

  it('skips rows whose ts is non-finite (defensive against malformed payloads)', async () => {
    fetch.mockResolvedValueOnce(jsonResp({
      hourly: {
        time:                  [1000, 'bogus', 1200],
        temperature_2m:        [60, 61, 62],
        relative_humidity_2m:  [50, 51, 52],
        dew_point_2m:          [40, 41, 42],
      },
    }));
    const r = await fetchHourlyWeather(0, 0);
    expect(r.map(x => x.ts)).toEqual([1000, 1200]);
  });
});
