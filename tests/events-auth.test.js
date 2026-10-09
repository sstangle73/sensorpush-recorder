// Auth enforcement on /events routes. Lives in its own file so we can set
// RECORDER_TOKEN before any module is imported — auth.js captures the env at
// import time. We follow the same pattern as auth.test.js.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP = mkdtempSync(join(tmpdir(), 'sp-rec-evauth-'));
process.env.DB_PATH = join(TMP, 'sensorpush.db');

// Imports must follow env setup so config.js picks up DB_PATH.
const { createApp } = await import('../server.js');
const { openDb, upsertSensors } = await import('../db.js');

let server, baseUrl, db;
const TOKEN = 'eventauthtoken1234567890abcdef00';

beforeAll(() => new Promise((resolve) => {
  process.env.RECORDER_TOKEN = TOKEN;
  db = openDb(':memory:');
  upsertSensors(db, [{ id: 'ev-s1', name: 'Auth Test', type: 'HT1', active: true, batteryVoltage: null }]);
  server = http.createServer(createApp(db));
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

afterAll(() => new Promise((resolve) => {
  delete process.env.RECORDER_TOKEN;
  server.close(resolve);
}));

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

async function call(method, path, { token, body } = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  let parsed;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

describe('Events routes require bearer auth', () => {
  it('POST /events without bearer → 401', async () => {
    const { status } = await call('POST', '/events', { body: { ts: 1000, label: 'x' } });
    expect(status).toBe(401);
  });

  it('GET /events without bearer → 401', async () => {
    const { status } = await call('GET', '/events');
    expect(status).toBe(401);
  });

  it('PATCH /events/:id without bearer → 401', async () => {
    const { status } = await call('PATCH', '/events/1', { body: { label: 'x' } });
    expect(status).toBe(401);
  });

  it('DELETE /events/:id without bearer → 401', async () => {
    const { status } = await call('DELETE', '/events/1');
    expect(status).toBe(401);
  });

  it('POST /events with correct bearer → 200', async () => {
    const { status, body } = await call('POST', '/events', {
      token: TOKEN,
      body: { ts: 1000, label: 'authed' },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.event.label).toBe('authed');
  });

  it('GET /events with correct bearer → 200', async () => {
    const { status, body } = await call('GET', '/events', { token: TOKEN });
    expect(status).toBe(200);
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('wrong bearer → 401', async () => {
    const { status } = await call('GET', '/events', { token: 'wrong-token' });
    expect(status).toBe(401);
  });

  // GHSA-j7mj-3739-5mg9: a script can send Sec-Fetch-Site, so it isn't auth.
  it('Sec-Fetch-Site: same-origin without bearer → 401', async () => {
    const spoof = { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
    const post = await fetch(baseUrl + '/events', {
      method: 'POST', headers: spoof, body: JSON.stringify({ ts: 2000, label: 'spoofed' }),
    });
    expect(post.status).toBe(401);
    const get = await fetch(baseUrl + '/events', { headers: spoof });
    expect(get.status).toBe(401);
  });

  it('a bearer of a different length → 401, not a throw', async () => {
    const { status } = await call('GET', '/events', { token: TOKEN + 'x' });
    expect(status).toBe(401);
  });
});
