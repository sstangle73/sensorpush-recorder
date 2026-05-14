// Open-Meteo outdoor weather fetcher.
//
// Two endpoints, both off the same forecast API (no API key needed):
//   - fetchCurrentWeather: latest current_weather → one reading
//   - fetchHourlyWeather:  hourly[] for the last `pastDays` days (up to 92) →
//                           used for first-run backfill so the new outdoor
//                           series shows up alongside whatever historical
//                           indoor data is already in the DB
//
// Both return arrays of { ts (epoch s), temp (°F), humidity (%), dewpoint (°F) }
// shaped to match insertOutdoorReadings in db.js.

import fetch from 'node-fetch';

const OM_BASE = 'https://api.open-meteo.com/v1/forecast';

// Returns [{ ts, temp, humidity, dewpoint }] with one entry, or [] on failure.
// Soft-failing (returns []) so a transient outage during the hourly poll
// doesn't crash the loop — same pattern as the SensorPush polling.
export async function fetchCurrentWeather(lat, lon) {
  const url = new URL(OM_BASE);
  url.searchParams.set('latitude',  String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('current',   'temperature_2m,relative_humidity_2m,dew_point_2m');
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('timeformat', 'unixtime');

  try {
    const r = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error(`weather HTTP ${r.status}`);
    const data = await r.json();
    const c = data?.current;
    if (!c || c.time == null) return [];
    return [{
      ts:       Number(c.time),
      temp:     c.temperature_2m       ?? null,
      humidity: c.relative_humidity_2m ?? null,
      dewpoint: c.dew_point_2m         ?? null,
    }];
  } catch (_) {
    return [];
  }
}

// Returns [{ ts, temp, humidity, dewpoint }] hourly samples for the last
// `pastDays` days (1-92 per Open-Meteo limit). Empty on failure.
//
// We use the forecast endpoint with past_days rather than the archive API
// because the archive has a 5-day data lag, which would leave a hole in the
// most recent week. forecast covers up to 92 past days with no lag.
export async function fetchHourlyWeather(lat, lon, pastDays = 7) {
  const clamped = Math.max(1, Math.min(92, Math.floor(pastDays)));
  const url = new URL(OM_BASE);
  url.searchParams.set('latitude',  String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('hourly',    'temperature_2m,relative_humidity_2m,dew_point_2m');
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('past_days', String(clamped));
  // forecast_days=0 → only return past + current, no future hours
  url.searchParams.set('forecast_days', '1');
  url.searchParams.set('timeformat', 'unixtime');

  try {
    const r = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`weather HTTP ${r.status}`);
    const data = await r.json();
    const h = data?.hourly;
    if (!h?.time?.length) return [];
    const out = [];
    for (let i = 0; i < h.time.length; i++) {
      const ts = Number(h.time[i]);
      if (!Number.isFinite(ts)) continue;
      out.push({
        ts,
        temp:     h.temperature_2m?.[i]       ?? null,
        humidity: h.relative_humidity_2m?.[i] ?? null,
        dewpoint: h.dew_point_2m?.[i]         ?? null,
      });
    }
    return out;
  } catch (_) {
    return [];
  }
}
