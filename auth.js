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
//
// Browsers sign in once with the token and get a session cookie instead of
// holding the token in page JS, or arrive from a dashboard that holds the
// token with a one-time hand-off code (see the two sections at the bottom).

import { readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';

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

/**
 * Constant-time check of a presented token against the active one. Both
 * sides are hashed first, so timingSafeEqual always compares equal-length
 * buffers and leaks neither the content nor the length.
 */
export function tokenMatches(candidate, token) {
  if (typeof candidate !== 'string' || typeof token !== 'string' || !token) return false;
  const a = createHash('sha256').update(candidate, 'utf8').digest();
  const b = createHash('sha256').update(token, 'utf8').digest();
  return timingSafeEqual(a, b);
}

// ── Browser sessions ────────────────────────────────────────────────────
// The Explorer UI signs in once with the token (POST /auth/session) and
// gets this cookie back, so page JS never holds the token. HttpOnly keeps
// it out of page JS, SameSite=Strict keeps other sites from sending it,
// and server.js adds Secure when the request came over TLS.
//
// The value is `<expiry>.<nonce>.<mac>`: an expiry in epoch seconds, 16
// random bytes, and an HMAC-SHA256 over both, keyed by the active token.
// Nothing is stored server-side, so sessions survive restarts, and a
// rotated (or changed env) token ends every session at once: the old MACs
// stop verifying. Signing out clears one browser's cookie; rotating the
// token is how to cut off every browser.

export const SESSION_COOKIE = 'sp_session';
export const SESSION_MAX_AGE_SECS = 90 * 24 * 60 * 60;

function sessionMac(token, payload) {
  return createHmac('sha256', token).update(`sp-session-v1.${payload}`).digest('base64url');
}

/** A new session value for `token`, valid for `maxAgeSecs` (at most SESSION_MAX_AGE_SECS). */
export function createSession(token, now = Date.now(), maxAgeSecs = SESSION_MAX_AGE_SECS) {
  const exp = Math.floor(now / 1000) + Math.min(maxAgeSecs, SESSION_MAX_AGE_SECS);
  const payload = `${exp}.${randomBytes(16).toString('base64url')}`;
  return `${payload}.${sessionMac(token, payload)}`;
}

/** True when `value` was made by createSession(token) and hasn't expired. */
export function verifySession(value, token, now = Date.now()) {
  if (typeof value !== 'string' || typeof token !== 'string' || !token) return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  const [expStr, nonce, mac] = parts;
  if (!/^\d{1,12}$/.test(expStr) || !/^[A-Za-z0-9_-]{22}$/.test(nonce)) return false;
  const exp = Number(expStr);
  const nowSecs = Math.floor(now / 1000);
  if (exp <= nowSecs || exp > nowSecs + SESSION_MAX_AGE_SECS) return false;
  const want = Buffer.from(sessionMac(token, `${expStr}.${nonce}`));
  const got = Buffer.from(mac);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The session cookie's value from a Cookie header, or null. */
export function readSessionCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

/** Set-Cookie value carrying `value`; an empty value clears the cookie. */
export function sessionCookieHeader(value, { secure = false } = {}) {
  const maxAge = value ? SESSION_MAX_AGE_SECS : 0;
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

/** The session value from an `Authorization: Session <value>` header, or null. */
export function readSessionHeader(authorization) {
  const m = /^Session\s+(\S+)\s*$/i.exec(typeof authorization === 'string' ? authorization : '');
  return m ? m[1] : null;
}

// ── Sign-in hand-off ────────────────────────────────────────────────────
// A server that holds the token (RoseStorie's user-api) can open the Explorer
// for someone signed in to it without ever showing them the token. It calls
// POST /auth/handoff with the bearer and gets a one-time code, then opens the
// page at `#handoff=<code>`; the page swaps the code for a session
// (POST /auth/handoff/redeem). A fragment never reaches a server, so the code
// stays out of access logs and Referer headers.
//
// A code is 32 random bytes, lives HANDOFF_TTL_SECS, works once, and only
// while the token it was minted under is still the active one. Codes live in
// this process's memory: a restart drops the outstanding ones, which costs a
// re-open at most.
//
// The session comes back in the response body, not as a cookie, and the page
// sends it as `Authorization: Session <value>`. RoseStorie shows the Explorer
// in an iframe on its own site, and browsers refuse a SameSite=Strict cookie
// set inside a cross-site iframe (Safari refuses any third-party cookie). The
// page keeps it in sessionStorage, where its scripts can read it, so it lasts
// HANDOFF_SESSION_MAX_AGE_SECS rather than the cookie's 90 days. A header
// isn't sent by the browser on its own, so other sites can't ride on it.

export const HANDOFF_TTL_SECS = 60;
export const HANDOFF_SESSION_MAX_AGE_SECS = 12 * 60 * 60;
const MAX_LIVE_HANDOFFS = 100;
const _handoffs = new Map(); // sha256(code) hex → { exp: epoch ms, tokenHash: Buffer }

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest();
}

/** A new one-time hand-off code, bound to `token`. */
export function createHandoff(token, now = Date.now()) {
  for (const [key, h] of _handoffs) if (h.exp <= now) _handoffs.delete(key);
  while (_handoffs.size >= MAX_LIVE_HANDOFFS) _handoffs.delete(_handoffs.keys().next().value);
  const code = randomBytes(32).toString('base64url');
  _handoffs.set(sha256(code).toString('hex'), { exp: now + HANDOFF_TTL_SECS * 1000, tokenHash: sha256(token) });
  return code;
}

/**
 * True when `code` came from createHandoff under `token` and hasn't expired.
 * Any code that's found is spent, whether or not it was still good.
 */
export function redeemHandoff(code, token, now = Date.now()) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) return false;
  if (typeof token !== 'string' || !token) return false;
  const key = sha256(code).toString('hex');
  const h = _handoffs.get(key);
  if (!h) return false;
  _handoffs.delete(key);
  return h.exp > now && timingSafeEqual(h.tokenHash, sha256(token));
}

/** Test hook: forget every outstanding code. */
export function _resetHandoffs() {
  _handoffs.clear();
}
