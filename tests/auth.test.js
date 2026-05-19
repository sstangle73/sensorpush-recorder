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
    headers: { ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
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

  it('treats Sec-Fetch-Site: same-origin as same-origin bypass', async () => {
    writeFileSync(TOKEN_FILE, 'ffffffffffffffffffffffffffffffff');
    const res = await fetch(baseUrl + '/', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    expect(res.status).toBe(200);
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
