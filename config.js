import { readFileSync } from 'fs';

export const DB_PATH = process.env.DB_PATH || '/data/sensorpush.db';
export const PORT    = parseInt(process.env.PORT || '3003', 10);

// Reads DASHBOARD_CONFIG from /config/config.local.js using the same
// `new Function('window', source)` sandbox pattern the dashboard's
// admin.js uses on the frontend.
//
// Required shape (only sensorpush.email + sensorpush.password are read):
//
//   window.DASHBOARD_CONFIG = {
//     sensorpush: { email: 'you@example.com', password: 'yourpassword' }
//   };
//
export function loadConfig() {
  try {
    const source = readFileSync('/config/config.local.js', 'utf8');
    const w = {};
    new Function('window', source)(w);
    if (w.DASHBOARD_CONFIG) return w.DASHBOARD_CONFIG;
  } catch (_) {
    // fall through
  }
  return {};
}
