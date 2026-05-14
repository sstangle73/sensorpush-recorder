// Route tests for /backups and /backups/:filename/restore.
//
// Restore is a filesystem-level operation (close handle, copy file, re-open),
// so this suite uses real on-disk SQLite files in a tmp dir rather than the
// :memory: pattern used elsewhere. The DB_PATH env var is set BEFORE
// importing server.js so config.js picks it up; backups.js reads the env
// each call so per-test overrides also work.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP = mkdtempSync(join(tmpdir(), 'sp-rec-backups-'));
process.env.DB_PATH = join(TMP, 'sensorpush.db');
const BACKUPS_DIR = join(TMP, 'backups');
mkdirSync(BACKUPS_DIR, { recursive: true });

const { createApp } = await import('../server.js');
const { openDb, upsertSensors } = await import('../db.js');

let server, baseUrl, db;

beforeAll(() => new Promise((resolve) => {
  db = openDb(process.env.DB_PATH);
  upsertSensors(db, [{ id: 'live-marker', name: 'Live', type: 'HT1', active: true, batteryVoltage: 2.9 }]);
  server = http.createServer(createApp(db));
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  // Windows locks the .db file as long as the handle is open — close before rmSync.
  try { db.close(); } catch (_) {}
  rmSync(TMP, { recursive: true, force: true });
});

// Build a real SQLite backup file under BACKUPS_DIR with the daily-snapshot
// name. The file is a valid sqlite database (created via openDb) so the
// restore flow's openDb call in step 5 succeeds.
function makeRealBackup(dateStr, markerId) {
  const tmpPath = join(TMP, `tmp-${markerId}.db`);
  const tdb = openDb(tmpPath);
  upsertSensors(tdb, [{ id: markerId, name: markerId, type: 'HT1', active: true, batteryVoltage: 2.7 }]);
  tdb.close();
  const dest = join(BACKUPS_DIR, `sensorpush-${dateStr}.db`);
  copyFileSync(tmpPath, dest);
  rmSync(tmpPath);
  return dest;
}

async function get(path) {
  const res  = await fetch(baseUrl + path);
  const body = await res.json();
  return { status: res.status, body };
}

async function post(path) {
  const res  = await fetch(baseUrl + path, { method: 'POST' });
  const body = await res.json();
  return { status: res.status, body };
}

describe('GET /backups', () => {
  it('lists daily snapshots with filename, size, mtime, restorable', async () => {
    makeRealBackup('2026-05-10', 'b10');
    makeRealBackup('2026-05-11', 'b11');
    makeRealBackup('2026-05-12', 'b12');

    const { status, body } = await get('/backups');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.backups)).toBe(true);

    const names = body.backups.map(b => b.filename);
    expect(names).toContain('sensorpush-2026-05-10.db');
    expect(names).toContain('sensorpush-2026-05-11.db');
    expect(names).toContain('sensorpush-2026-05-12.db');

    const entry = body.backups.find(b => b.filename === 'sensorpush-2026-05-10.db');
    expect(typeof entry.size).toBe('number');
    expect(entry.size).toBeGreaterThan(0);
    expect(typeof entry.mtime).toBe('number');
    expect(entry.restorable).toBe(true);
  });

  it('skips files that do not match the snapshot pattern', async () => {
    writeFileSync(join(BACKUPS_DIR, 'unrelated.txt'), 'keep me');
    writeFileSync(join(BACKUPS_DIR, 'evil.db'), 'no prefix');
    const { body } = await get('/backups');
    const names = body.backups.map(b => b.filename);
    expect(names).not.toContain('unrelated.txt');
    expect(names).not.toContain('evil.db');
  });

  it('lists pre-restore snapshots as non-restorable', async () => {
    writeFileSync(
      join(BACKUPS_DIR, 'sensorpush-pre-restore-2026-05-14T10-30-45-123Z.db'),
      'placeholder',
    );
    const { body } = await get('/backups');
    const pre = body.backups.find(b => b.filename.includes('pre-restore'));
    expect(pre).toBeDefined();
    expect(pre.restorable).toBe(false);
  });

  it('sorts by mtime descending', async () => {
    const { body } = await get('/backups');
    for (let i = 1; i < body.backups.length; i++) {
      expect(body.backups[i - 1].mtime).toBeGreaterThanOrEqual(body.backups[i].mtime);
    }
  });
});

describe('POST /backups/:filename/restore — validation', () => {
  it('rejects filename not matching daily pattern (400)', async () => {
    const { status, body } = await post('/backups/sensorpush-bad.db/restore');
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/invalid backup filename/);
  });

  it('rejects filename with path-traversal sequences (400)', async () => {
    // %2F decodes to "/" inside the :filename segment per Express's behavior,
    // so the regex check sees "sensorpush-../../etc/passwd" — rejected.
    const malicious = encodeURIComponent('sensorpush-../../etc/passwd');
    const { status } = await post(`/backups/${malicious}/restore`);
    expect(status).toBe(400);
  });

  it('rejects pre-restore filename — only daily pattern is restorable', async () => {
    const { status } = await post(
      '/backups/sensorpush-pre-restore-2026-05-14T10-30-45-123Z.db/restore',
    );
    expect(status).toBe(400);
  });

  it('returns 500 when filename matches but backup file is missing', async () => {
    const { status, body } = await post('/backups/sensorpush-1999-01-01.db/restore');
    expect(status).toBe(500);
    expect(body.error).toMatch(/not found/);
  });
});

// Full-restore tests run in isolated tmp dirs with their own server, so they
// don't perturb the file-level server's `db` handle (which is required by
// later GET /backups assertions if any are added below).
describe('POST /backups/:filename/restore — full restore flow', () => {
  it('creates a pre-restore snapshot and re-opens the db handle', async () => {
    const prevDbPath = process.env.DB_PATH;
    const dir = mkdtempSync(join(tmpdir(), 'sp-rec-restore-'));
    process.env.DB_PATH = join(dir, 'sensorpush.db');
    const localBackups = join(dir, 'backups');
    mkdirSync(localBackups);

    const liveDb = openDb(process.env.DB_PATH);
    upsertSensors(liveDb, [{ id: 'before', name: 'B', type: 'HT1', active: true, batteryVoltage: 2.9 }]);

    const otherPath = join(dir, 'tmp-other.db');
    const otherDb = openDb(otherPath);
    upsertSensors(otherDb, [{ id: 'after', name: 'A', type: 'HT1', active: true, batteryVoltage: 2.7 }]);
    otherDb.close();
    copyFileSync(otherPath, join(localBackups, 'sensorpush-2026-04-01.db'));

    let swapped = null;
    const srv = http.createServer(createApp(liveDb, null, (newDb) => { swapped = newDb; }));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}`;

    try {
      const res  = await fetch(`${url}/backups/sensorpush-2026-04-01.db/restore`, { method: 'POST' });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.preRestoreFilename).toMatch(/^sensorpush-pre-restore-.+\.db$/);

      // Pre-restore safety snapshot was written to disk.
      const preRestorePath = join(localBackups, data.preRestoreFilename);
      expect(existsSync(preRestorePath)).toBe(true);

      // Pre-restore snapshot still holds the BEFORE marker — confirms it
      // captured the live DB content prior to the swap.
      const preDb = openDb(preRestorePath);
      const beforeRow = preDb.prepare('SELECT id FROM sensors WHERE id = ?').get('before');
      const afterRow  = preDb.prepare('SELECT id FROM sensors WHERE id = ?').get('after');
      preDb.close();
      expect(beforeRow).toBeDefined();
      expect(afterRow).toBeUndefined();

      // App's db handle was reassigned and now serves the restored data —
      // hit / via the running server to prove the route closures see the new
      // handle without restart.
      const sensorsRes  = await fetch(`${url}/`);
      const sensorsBody = await sensorsRes.json();
      expect(sensorsBody.ok).toBe(true);
      expect(sensorsBody.sensors.after).toBeDefined();
      expect(sensorsBody.sensors.before).toBeUndefined();
    } finally {
      // Close the swapped-in handle so Windows releases the file lock before rmSync.
      try { swapped?.close(); } catch (_) {}
      await new Promise((r) => srv.close(r));
      rmSync(dir, { recursive: true, force: true });
      process.env.DB_PATH = prevDbPath;
    }
  });

  it('fires onSwap callback with the new db handle', async () => {
    const prevDbPath = process.env.DB_PATH;
    const dir = mkdtempSync(join(tmpdir(), 'sp-rec-swap-'));
    process.env.DB_PATH = join(dir, 'sensorpush.db');
    const localBackups = join(dir, 'backups');
    mkdirSync(localBackups);

    const liveDb = openDb(process.env.DB_PATH);
    const otherPath = join(dir, 'tmp-other.db');
    openDb(otherPath).close();
    copyFileSync(otherPath, join(localBackups, 'sensorpush-2026-04-02.db'));

    let swapped = null;
    const srv = http.createServer(createApp(liveDb, null, (newDb) => { swapped = newDb; }));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}`;

    try {
      const res = await fetch(`${url}/backups/sensorpush-2026-04-02.db/restore`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(swapped).not.toBeNull();
      // The callback received a working handle — quick query proves it.
      const count = swapped.prepare('SELECT COUNT(*) AS n FROM sensors').get();
      expect(count.n).toBe(0);
    } finally {
      try { swapped?.close(); } catch (_) {}
      await new Promise((r) => srv.close(r));
      rmSync(dir, { recursive: true, force: true });
      process.env.DB_PATH = prevDbPath;
    }
  });
});
