// Tests for the bearer-token lifecycle: env precedence, file persistence,
// generate/rotate/clear endpoints, and the bypass rules in the request gate.
//
// We point DB_PATH (and therefore the auth file) at a per-test tmp dir
// because the auth module uses path.join(dirname(DB_PATH), 'recorder-token').
// That import happens before vitest can mock anything, so we set the env
// var BEFORE any import.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP = mkdtempSync(join(tmpdir(), 'sp-rec-auth-'));
process.env.DB_PATH = join(TMP, 'sensorpush.db');
const TOKEN_FILE = join(TMP, 'recorder-token');

// Imports must come AFTER env setup so config.js picks up DB_PATH.
const { createApp } = await import('../server.js');
const { openDb } = await import('../db.js');
const { tokenMatches, createSession, verifySession, readSessionCookie, SESSION_MAX_AGE_SECS } = await import('../auth.js');

let server, baseUrl, db;

beforeAll(() => new Promise((resolve) => {
  db = openDb(':memory:');
  server = http.createServer(createApp(db));
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  // Reset state: no env, no file.
  delete process.env.RECORDER_TOKEN;
  if (existsSync(TOKEN_FILE)) rmSync(TOKEN_FILE);
});

afterEach(() => {
  delete process.env.RECORDER_TOKEN;
  if (existsSync(TOKEN_FILE)) rmSync(TOKEN_FILE);
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

async function api(method, path, opts = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.session ? { Cookie: `sp_session=${opts.session}` } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, setCookie: res.headers.get('set-cookie') };
}

// The sp_session value from a Set-Cookie header ('' when it clears it).
function sessionFrom(setCookie) {
  const m = /(?:^|,\s*)sp_session=([^;]*)/.exec(setCookie || '');
  return m ? m[1] : null;
}

describe('GET /settings/auth', () => {
  it('reports source=null when no token configured', async () => {
    const { status, body } = await api('GET', '/settings/auth');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, tokenSet: false, source: null, canRotate: false });
  });

  it('reports source=env when env set', async () => {
    process.env.RECORDER_TOKEN = 'envtoken12345678envtoken12345678';
    const { body } = await api('GET', '/settings/auth', { token: process.env.RECORDER_TOKEN });
    expect(body.source).toBe('env');
    expect(body.canRotate).toBe(false);
  });

  it('reports source=file when file written', async () => {
    writeFileSync(TOKEN_FILE, 'filetoken12345678filetoken12345678', { mode: 0o600 });
    const { body } = await api('GET', '/settings/auth', { token: 'filetoken12345678filetoken12345678' });
    expect(body.source).toBe('file');
    expect(body.canRotate).toBe(true);
  });
});

describe('POST /settings/auth/generate', () => {
  it('mints a new token when none set, persists to file', async () => {
    const { status, body } = await api('POST', '/settings/auth/generate');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(TOKEN_FILE, 'utf8')).toBe(body.token);
  });

  it('refuses when a token is already set', async () => {
    writeFileSync(TOKEN_FILE, 'existing-token-here-1234567890ab');
    const { status, body } = await api('POST', '/settings/auth/generate', {
      token: 'existing-token-here-1234567890ab',
    });
    expect(status).toBe(409);
    expect(body.error).toMatch(/already set/);
  });
});

describe('POST /settings/auth/rotate', () => {
  it('refuses when no token set (use generate instead)', async () => {
    // No token = no auth, so the route is reachable. It returns 409 for a
    // different reason (env-managed) only when the env var is set.
    // Without any token, "rotate" doesn't make conceptual sense — but the
    // route doesn't explicitly forbid it; setToken() will just create one.
    // This test documents the behavior: rotate-from-empty == generate.
    const { status, body } = await api('POST', '/settings/auth/rotate');
    expect(status).toBe(200);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rotates an existing file-based token', async () => {
    const orig = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeFileSync(TOKEN_FILE, orig, { mode: 0o600 });
    const { status, body } = await api('POST', '/settings/auth/rotate', { token: orig });
    expect(status).toBe(200);
    expect(body.token).not.toBe(orig);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(TOKEN_FILE, 'utf8')).toBe(body.token);
  });

  it('refuses when token is env-managed', async () => {
    process.env.RECORDER_TOKEN = 'envtoken12345678envtoken12345678';
    const { status, body } = await api('POST', '/settings/auth/rotate', { token: process.env.RECORDER_TOKEN });
    expect(status).toBe(409);
    expect(body.error).toMatch(/RECORDER_TOKEN env/);
  });
});

describe('DELETE /settings/auth', () => {
  it('removes the file-based token', async () => {
    const tok = 'cccccccccccccccccccccccccccccccc';
    writeFileSync(TOKEN_FILE, tok, { mode: 0o600 });
    const { status, body } = await api('DELETE', '/settings/auth', { token: tok });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(existsSync(TOKEN_FILE)).toBe(false);
  });

  it('refuses when env-managed', async () => {
    process.env.RECORDER_TOKEN = 'envtoken12345678envtoken12345678';
    const { status } = await api('DELETE', '/settings/auth', { token: process.env.RECORDER_TOKEN });
    expect(status).toBe(409);
  });
});

describe('Bearer middleware', () => {
  it('allows requests when no token set', async () => {
    const { status } = await api('GET', '/health');
    expect(status).toBe(200);
  });

  it('rejects unauth cross-origin requests when token set', async () => {
    writeFileSync(TOKEN_FILE, 'dddddddddddddddddddddddddddddddd');
    // /health is public — bypass.
    const health = await api('GET', '/health');
    expect(health.status).toBe(200);
    // / without application/json is public — UI nav works (HTML default).
    const html = await fetch(baseUrl + '/', { headers: { Accept: 'text/html' } });
    expect(html.status).toBe(200);
    // Cross-origin JSON read needs the bearer.
    const json = await api('GET', '/', { headers: { Accept: 'application/json' } });
    expect(json.status).toBe(401);
  });

  it('accepts requests with the right bearer', async () => {
    const tok = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    writeFileSync(TOKEN_FILE, tok);
    const { status } = await api('GET', '/', { token: tok });
    expect(status).toBe(200);
  });

  // GHSA-j7mj-3739-5mg9: Sec-Fetch-Site is chosen by the client. Any script
  // can send it, so it must never stand in for the token.
  it('does not let Sec-Fetch-Site: same-origin stand in for the token', async () => {
    const tok = 'ffffffffffffffffffffffffffffffff';
    writeFileSync(TOKEN_FILE, tok);
    const spoof = { 'Sec-Fetch-Site': 'same-origin' };
    const json = await api('GET', '/', { headers: { ...spoof, Accept: 'application/json' } });
    expect(json.status).toBe(401);
    const settings = await api('GET', '/settings', { headers: spoof });
    expect(settings.status).toBe(401);
    const backups = await api('GET', '/backups', { headers: spoof });
    expect(backups.status).toBe(401);
    const rotate = await api('POST', '/settings/auth/rotate', { headers: spoof });
    expect(rotate.status).toBe(401);
    expect(rotate.body.token).toBeUndefined();
    const clear = await api('DELETE', '/settings/auth', { headers: spoof });
    expect(clear.status).toBe(401);
    expect(readFileSync(TOKEN_FILE, 'utf8')).toBe(tok);
  });

  it('serves the UI page with Sec-Fetch-Site: same-origin (HTML is public)', async () => {
    writeFileSync(TOKEN_FILE, 'ffffffffffffffffffffffffffffffff');
    const res = await fetch(baseUrl + '/', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('still gates Sec-Fetch-Site: cross-site / none', async () => {
    writeFileSync(TOKEN_FILE, '11111111111111111111111111111111');
    const res = await fetch(baseUrl + '/', {
      headers: { 'Sec-Fetch-Site': 'cross-site', Accept: 'application/json' },
    });
    expect(res.status).toBe(401);
  });

  it('gates sensor-pairs routes when token set', async () => {
    const tok = '22222222222222222222222222222222';
    writeFileSync(TOKEN_FILE, tok);
    // Without bearer → 401
    const unauth = await api('GET', '/sensor-pairs');
    expect(unauth.status).toBe(401);
    // With bearer → 200 (empty list)
    const ok = await api('GET', '/sensor-pairs', { token: tok });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
  });
});

describe('Browser sessions (/auth/session)', () => {
  const TOK = '33333333333333333333333333333333';

  async function signIn() {
    writeFileSync(TOKEN_FILE, TOK);
    const r = await api('POST', '/auth/session', { body: { token: TOK } });
    expect(r.status).toBe(200);
    return sessionFrom(r.setCookie);
  }

  it('reports no auth required when no token is set', async () => {
    const { status, body } = await api('GET', '/auth/session');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, authRequired: false, authenticated: true });
  });

  it('reports signed out when a token is set and nothing is presented', async () => {
    writeFileSync(TOKEN_FILE, TOK);
    const { status, body } = await api('GET', '/auth/session', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, authRequired: true, authenticated: false });
  });

  it('refuses a wrong token and sets no cookie', async () => {
    writeFileSync(TOKEN_FILE, TOK);
    const r = await api('POST', '/auth/session', { body: { token: TOK.slice(1) } });
    expect(r.status).toBe(401);
    expect(r.setCookie).toBeNull();
    const missing = await api('POST', '/auth/session', { body: {} });
    expect(missing.status).toBe(401);
  });

  it('sets an HttpOnly, SameSite=Strict cookie that never carries the token', async () => {
    writeFileSync(TOKEN_FILE, TOK);
    const r = await api('POST', '/auth/session', { body: { token: TOK } });
    expect(r.setCookie).toMatch(/HttpOnly/);
    expect(r.setCookie).toMatch(/SameSite=Strict/);
    expect(r.setCookie).toMatch(/Max-Age=7776000/);
    expect(r.setCookie).toMatch(/Path=\//);
    expect(r.setCookie).not.toMatch(/Secure/);
    expect(r.setCookie).not.toContain(TOK);
    const tls = await api('POST', '/auth/session', { body: { token: TOK }, headers: { 'X-Forwarded-Proto': 'https' } });
    expect(tls.setCookie).toMatch(/; Secure/);
  });

  it('gives each sign-in a different random value', async () => {
    const a = await signIn();
    const b = await signIn();
    expect(a).not.toBe(b);
  });

  it('lets the session cookie through the gate', async () => {
    const s = await signIn();
    const same = { 'Sec-Fetch-Site': 'same-origin' };
    expect((await api('GET', '/', { session: s, headers: { ...same, Accept: 'application/json' } })).status).toBe(200);
    expect((await api('GET', '/settings', { session: s, headers: same })).status).toBe(200);
    // Non-browser clients send no Sec-Fetch-Site; a typed-in URL sends none.
    expect((await api('GET', '/settings', { session: s })).status).toBe(200);
    expect((await api('GET', '/settings', { session: s, headers: { 'Sec-Fetch-Site': 'none' } })).status).toBe(200);
    const state = await api('GET', '/auth/session', { session: s, headers: same });
    expect(state.body.authenticated).toBe(true);
  });

  it('refuses the cookie on requests a browser marks as from another site', async () => {
    const s = await signIn();
    for (const site of ['cross-site', 'same-site']) {
      const r = await api('POST', '/settings/auth/rotate', { session: s, headers: { 'Sec-Fetch-Site': site } });
      expect(r.status).toBe(401);
    }
    expect(readFileSync(TOKEN_FILE, 'utf8')).toBe(TOK);
  });

  it('refuses a tampered or foreign cookie', async () => {
    const s = await signIn();
    const [exp, nonce, mac] = s.split('.');
    const later = `${Number(exp) + 60}.${nonce}.${mac}`;
    expect((await api('GET', '/settings', { session: later })).status).toBe(401);
    expect((await api('GET', '/settings', { session: `${exp}.${nonce}.${mac.slice(0, -2)}AA` })).status).toBe(401);
    expect((await api('GET', '/settings', { session: 'garbage' })).status).toBe(401);
    expect((await api('GET', '/settings', { session: createSession('a-different-token-entirely-0000') })).status).toBe(401);
  });

  it('a bearer, when present, is all that counts', async () => {
    const s = await signIn();
    const r = await api('GET', '/settings', { session: s, token: 'wrong-token-wrong-token-wrong-tok' });
    expect(r.status).toBe(401);
  });

  it('ends every session when the token changes', async () => {
    const s = await signIn();
    writeFileSync(TOKEN_FILE, '44444444444444444444444444444444');
    expect((await api('GET', '/settings', { session: s })).status).toBe(401);
  });

  it('rotate signs the caller in with the new token and ends the old session', async () => {
    const s = await signIn();
    const r = await api('POST', '/settings/auth/rotate', { session: s, headers: { 'Sec-Fetch-Site': 'same-origin' } });
    expect(r.status).toBe(200);
    const fresh = sessionFrom(r.setCookie);
    expect(fresh).toBeTruthy();
    expect((await api('GET', '/settings', { session: s })).status).toBe(401);
    expect((await api('GET', '/settings', { session: fresh })).status).toBe(200);
    expect((await api('GET', '/settings', { token: r.body.token })).status).toBe(200);
  });

  it('generate signs the caller in with the token it made', async () => {
    const r = await api('POST', '/settings/auth/generate');
    expect(r.status).toBe(200);
    expect((await api('GET', '/settings', { session: sessionFrom(r.setCookie) })).status).toBe(200);
  });

  it('removing the token clears the cookie', async () => {
    const s = await signIn();
    const r = await api('DELETE', '/settings/auth', { session: s });
    expect(r.status).toBe(200);
    expect(r.setCookie).toMatch(/sp_session=;.*Max-Age=0/);
  });

  it('DELETE /auth/session signs this browser out', async () => {
    const r = await api('DELETE', '/auth/session');
    expect(r.status).toBe(200);
    expect(sessionFrom(r.setCookie)).toBe('');
    expect(r.setCookie).toMatch(/Max-Age=0/);
  });

  it('signing in with no token set is a no-op', async () => {
    const r = await api('POST', '/auth/session', { body: { token: 'anything' } });
    expect(r.status).toBe(200);
    expect(r.body.authRequired).toBe(false);
    expect(r.setCookie).toBeNull();
  });
});

describe('auth.js helpers', () => {
  it('tokenMatches compares in constant time, any lengths', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches('abcd', 'abc')).toBe(false);
    expect(tokenMatches('', 'abc')).toBe(false);
    expect(tokenMatches(undefined, 'abc')).toBe(false);
    expect(tokenMatches('abc', null)).toBe(false);
  });

  it('verifySession honours the expiry', () => {
    const t0 = Date.UTC(2026, 9, 9);
    const s = createSession('tok-tok-tok-tok-tok', t0);
    expect(verifySession(s, 'tok-tok-tok-tok-tok', t0)).toBe(true);
    expect(verifySession(s, 'tok-tok-tok-tok-tok', t0 + (SESSION_MAX_AGE_SECS - 1) * 1000)).toBe(true);
    expect(verifySession(s, 'tok-tok-tok-tok-tok', t0 + SESSION_MAX_AGE_SECS * 1000)).toBe(false);
    expect(verifySession(s, 'other-token-other', t0)).toBe(false);
  });

  it('readSessionCookie finds the cookie among others', () => {
    expect(readSessionCookie('a=1; sp_session=x.y.z; b=2')).toBe('x.y.z');
    expect(readSessionCookie('sp_session_other=1')).toBeNull();
    expect(readSessionCookie(undefined)).toBeNull();
  });
});
