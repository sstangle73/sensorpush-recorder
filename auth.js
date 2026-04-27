// Recorder token persistence + lookup.
//
// Resolution order (first match wins):
//   1. RECORDER_TOKEN env var — set by the operator in docker-compose.
//      Useful for ops who prefer config-as-code over runtime mutation.
//   2. /data/recorder-token file — written by the Settings → Security
//      flow in the Explorer UI. Survives container restarts because /data
//      is bind-mounted from the host.
//   3. null — no auth configured. Bearer middleware in server.js becomes
//      a no-op; anyone with the URL can read sensors and toggle
//      exclusions. Reasonable for LAN-only deploys, dangerous on a
//      public-internet recorder.
//
// Why both env and file? The file path lets new BYO tenants generate +
// rotate the token from the UI without touching docker-compose.yml. The
// env path stays for ops who want secrets entirely outside the container's
// writable filesystem (Vault-injected, Compose secret, etc.).
//
// On every request the bearer middleware calls getToken(), so generation
// + rotation + clear take effect without a restart.

import { readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { DB_PATH } from './config.js';

const TOKEN_FILE = join(dirname(DB_PATH), 'recorder-token');

/**
 * Returns the active token (env > file > null). Reads the file on every
 * call — cheap, and keeps generate/rotate/clear effective without a
 * restart. The env var is captured once at module load (it can't change
 * without a process restart anyway).
 */
export function getToken() {
  const envTok = (process.env.RECORDER_TOKEN || '').trim();
  if (envTok) return envTok;
  try {
    if (existsSync(TOKEN_FILE)) {
      const v = readFileSync(TOKEN_FILE, 'utf8').trim();
      return v || null;
    }
  } catch (_) {}
  return null;
}

/**
 * Returns 'env', 'file', or null. Used by the Settings UI to decide
 * which controls to show (rotate vs. read-only when env-managed).
 */
export function getTokenSource() {
  if ((process.env.RECORDER_TOKEN || '').trim()) return 'env';
  try {
    if (existsSync(TOKEN_FILE)) return 'file';
  } catch (_) {}
  return null;
}

/**
 * Generate 32 random bytes hex. Throws on the (very unlikely) crypto
 * RNG failure rather than silently returning a weak value.
 */
export function generateToken() {
  return randomBytes(32).toString('hex');
}

/**
 * Write `token` to the file path. Mode 0600 so other processes on the
 * host can't read it. Throws if the env var is set — env wins, file
 * mutation would be surprising no-op.
 */
export function setToken(token) {
  if ((process.env.RECORDER_TOKEN || '').trim()) {
    throw new Error('RECORDER_TOKEN env var is set; remove it from compose first');
  }
  if (typeof token !== 'string' || token.length < 16) {
    throw new Error('token must be a string of at least 16 chars');
  }
  writeFileSync(TOKEN_FILE, token, { encoding: 'utf8', mode: 0o600 });
  // Defensive — writeFileSync ignores the mode bit on existing files.
  try { chmodSync(TOKEN_FILE, 0o600); } catch (_) {}
}

/**
 * Remove the file token. Throws if the env var is set (no UI control
 * should call this in that state, but be defensive). No-op if the file
 * doesn't exist.
 */
export function clearStoredToken() {
  if ((process.env.RECORDER_TOKEN || '').trim()) {
    throw new Error('RECORDER_TOKEN env var is set; cannot clear file');
  }
  try {
    if (existsSync(TOKEN_FILE)) unlinkSync(TOKEN_FILE);
  } catch (_) {}
}

export const TOKEN_FILE_PATH = TOKEN_FILE;
