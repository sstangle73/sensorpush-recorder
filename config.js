import { readFileSync } from 'fs';

export const DB_PATH = process.env.DB_PATH || '/data/sensorpush.db';
export const PORT    = parseInt(process.env.PORT || '3003', 10);

// Two ways to provide the upstream SensorPush.com credentials:
//
//  1. Mounted file at /config/config.local.js (legacy / self-host LAN path):
//
//       window.DASHBOARD_CONFIG = {
//         sensorpush: { email: 'you@example.com', password: 'yourpassword' }
//       };
//
//  2. Env vars (managed Fly deploy / any container env):
//
//       SENSORPUSH_EMAIL=you@example.com
//       SENSORPUSH_PASSWORD=yourpassword
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

export function loadConfig() {
  // Env vars win when present — managed deploys never want a mounted file
  // to override their secrets store.
  const fromEnv = envCredentials();
  if (fromEnv) return fromEnv;
  try {
    return parseConfig(readFileSync('/config/config.local.js', 'utf8'));
  } catch (_) {
    return {};
  }
}
