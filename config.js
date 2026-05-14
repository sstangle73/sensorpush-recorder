import { readFileSync } from 'fs';

export const DB_PATH = process.env.DB_PATH || '/data/sensorpush.db';
export const PORT    = parseInt(process.env.PORT || '3003', 10);

// Two ways to provide the upstream SensorPush.com credentials:
//
//  1. Mounted file at /config/config.local.js (legacy / self-host LAN path):
//
//       window.DASHBOARD_CONFIG = {
//         sensorpush: { email: 'you@example.com', password: 'yourpassword' },
//         weather:    { lat: 43.65, lon: -79.38 },   // optional
//       };
//
//  2. Env vars (managed Fly deploy / any container env):
//
//       SENSORPUSH_EMAIL=you@example.com
//       SENSORPUSH_PASSWORD=yourpassword
//       WEATHER_LAT=43.65   (optional)
//       WEATHER_LON=-79.38  (optional)
//
// Env vars take precedence over the file when both are set, so a managed
// deploy can override a stale file without removing it.
//
// parseConfig is exported separately for unit testing — it operates on the
// already-read source string and never touches the filesystem.
export function parseConfig(source) {
  try {
    const w = {};
    new Function('window', source)(w);
    if (w.DASHBOARD_CONFIG) return w.DASHBOARD_CONFIG;
  } catch (_) {
    // malformed source → empty config
  }
  return {};
}

function envCredentials() {
  const email = (process.env.SENSORPUSH_EMAIL || '').trim();
  const password = process.env.SENSORPUSH_PASSWORD || '';
  if (!email || !password) return null;
  return { sensorpush: { email, password } };
}

// Parse WEATHER_LAT / WEATHER_LON from env. Both must be present, finite, and
// within valid earth bounds; otherwise returns null and the caller falls
// back to whatever the file config provides.
function envWeather() {
  const lat = parseFloat(process.env.WEATHER_LAT);
  const lon = parseFloat(process.env.WEATHER_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

export function loadConfig() {
  // Env vars win when present — managed deploys never want a mounted file
  // to override their secrets store.
  const fromEnv = envCredentials();
  let cfg = fromEnv;
  if (!cfg) {
    try {
      cfg = parseConfig(readFileSync('/config/config.local.js', 'utf8'));
    } catch (_) {
      cfg = {};
    }
  }
  // Weather location is layered on independently — env can override file even
  // when sensorpush creds come from the file.
  const envW = envWeather();
  if (envW) cfg = { ...cfg, weather: envW };
  return cfg;
}
