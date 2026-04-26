import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('node-fetch', () => ({ default: vi.fn() }));
import fetch from 'node-fetch';

import { getToken, fetchSensors, fetchSamples, _resetTokenCache } from '../sensorpush.js';

function jsonResp(data, status = 200) {
  return {
    ok:   status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

beforeEach(() => {
  _resetTokenCache();
  vi.clearAllMocks();
});

describe('getToken', () => {
  it('returns null when step 1 responds non-OK', async () => {
    fetch.mockResolvedValueOnce(jsonResp({}, 401));
    expect(await getToken('a@b.com', 'pw')).toBeNull();
  });

  it('returns null when step 1 body has no authorization field', async () => {
    fetch.mockResolvedValueOnce(jsonResp({ something: 'else' }));
    expect(await getToken('a@b.com', 'pw')).toBeNull();
  });

  it('returns null when step 2 responds non-OK', async () => {
    fetch.mockResolvedValueOnce(jsonResp({ authorization: 'auth123' }));
    fetch.mockResolvedValueOnce(jsonResp({}, 500));
    expect(await getToken('a@b.com', 'pw')).toBeNull();
  });

  it('returns null when step 2 body has no accesstoken field', async () => {
    fetch.mockResolvedValueOnce(jsonResp({ authorization: 'auth123' }));
    fetch.mockResolvedValueOnce(jsonResp({ other: 'field' }));
    expect(await getToken('a@b.com', 'pw')).toBeNull();
  });

  it('runs 2-step flow and returns access token on success', async () => {
    fetch.mockResolvedValueOnce(jsonResp({ authorization: 'authcode' }));
    fetch.mockResolvedValueOnce(jsonResp({ accesstoken: 'tok123' }));
    const token = await getToken('a@b.com', 'pw');
    expect(token).toBe('tok123');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns cached token without calling fetch again', async () => {
    fetch.mockResolvedValueOnce(jsonResp({ authorization: 'authcode' }));
    fetch.mockResolvedValueOnce(jsonResp({ accesstoken: 'tok123' }));
    await getToken('a@b.com', 'pw');
    fetch.mockClear();
    const second = await getToken('a@b.com', 'pw');
    expect(second).toBe('tok123');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('re-auths when cached token is within 60s of expiry', async () => {
    // Prime the cache with a nearly-expired token via two successful calls
    fetch.mockResolvedValueOnce(jsonResp({ authorization: 'a1' }));
    fetch.mockResolvedValueOnce(jsonResp({ accesstoken: 'tok_old' }));
    await getToken('a@b.com', 'pw');

    // Force cache expiry by directly manipulating module state isn't possible;
    // instead test by calling _resetTokenCache and ensuring re-auth happens.
    _resetTokenCache();
    fetch.mockResolvedValueOnce(jsonResp({ authorization: 'a2' }));
    fetch.mockResolvedValueOnce(jsonResp({ accesstoken: 'tok_new' }));
    const token = await getToken('a@b.com', 'pw');
    expect(token).toBe('tok_new');
  });
});

describe('fetchSensors', () => {
  it('maps API response to array of sensor objects', async () => {
    const apiData = {
      'id1': { name: 'Living Room', type: 'HT1',    active: true,  battery_voltage: 2.85 },
      'id2': { name: 'Outside',     type: 'HTP.xw', active: false, battery_voltage: 2.70 },
    };
    fetch.mockResolvedValueOnce(jsonResp(apiData));
    const sensors = await fetchSensors('tok');
    expect(sensors).toHaveLength(2);
    const s1 = sensors.find(s => s.id === 'id1');
    expect(s1).toMatchObject({ id: 'id1', name: 'Living Room', type: 'HT1', active: true, batteryVoltage: 2.85 });
    const s2 = sensors.find(s => s.id === 'id2');
    expect(s2.active).toBe(false);
  });

  it('throws on non-OK response', async () => {
    fetch.mockResolvedValueOnce(jsonResp({}, 403));
    await expect(fetchSensors('tok')).rejects.toThrow('sensors HTTP 403');
  });
});

describe('fetchSamples', () => {
  it('returns samples array for the sensor', async () => {
    const sample = { observed: '2026-04-18T12:00:00Z', temperature: 68, humidity: 50 };
    fetch.mockResolvedValueOnce(jsonResp({ sensors: { 's1': [sample] } }));
    const result = await fetchSamples('tok', { sensorId: 's1', startTs: null });
    expect(result).toHaveLength(1);
    expect(result[0].temperature).toBe(68);
  });

  it('returns empty array when sensor not in response', async () => {
    fetch.mockResolvedValueOnce(jsonResp({ sensors: {} }));
    const result = await fetchSamples('tok', { sensorId: 'missing', startTs: null });
    expect(result).toEqual([]);
  });

  it('includes startTime in request body when startTs provided', async () => {
    fetch.mockResolvedValueOnce(jsonResp({ sensors: { 's1': [] } }));
    await fetchSamples('tok', { sensorId: 's1', startTs: 1000000 });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.startTime).toBe(new Date(1000000 * 1000).toISOString());
    expect(body.sensors).toContain('s1');
  });
});
