// List + restore SQLite snapshots in /data/backups/.
//
// Snapshots are written daily at 03:30 by poller.js's _snapshotDb via
// VACUUM INTO; this module exposes them so an operator can roll back from
// the Explorer UI without SSH access.
//
// Path safety: restore is strict-gated to the daily pattern
// `sensorpush-YYYY-MM-DD.db` and the resolved path must stay inside the
// backups dir. Listing is slightly more permissive — it surfaces
// pre-restore safety snapshots (named `sensorpush-pre-restore-<ts>.db`)
// so operators can see what was preserved before each restore.

import { readdirSync, statSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { openDb } from './db.js';

// Listable: daily snapshots + pre-restore safety snapshots. Filenames
// follow a fixed prefix so a stray file in /data/backups can't appear.
const LISTABLE_RE   = /^sensorpush-[\w\-]+\.db$/;
// Restorable: strictly the daily-snapshot pattern. Pre-restore snapshots
// are intentionally NOT restorable via this route — the operator can copy
// them over manually if a restore goes wrong.
const RESTORABLE_RE = /^sensorpush-\d{4}-\d{2}-\d{2}\.db$/;

function getBackupsDir() {
  const live = process.env.DB_PATH || '/data/sensorpush.db';
  return join(dirname(live), 'backups');
}

// Two layers of defense against path-traversal:
//   1. The strict daily regex rejects anything with `/`, `\`, `..`, etc.
//   2. resolve(dir, filename) must land inside `dir` (caught even if the
//      regex were ever loosened).
export function isRestorableName(filename) {
  if (typeof filename !== 'string' || !RESTORABLE_RE.test(filename)) return false;
  const dir      = resolve(getBackupsDir());
  const resolved = resolve(dir, filename);
  return dirname(resolved) === dir;
}

export function listBackups() {
  const dir = getBackupsDir();
  try {
    return readdirSync(dir)
      .filter(f => LISTABLE_RE.test(f))
      .map(f => {
        const st = statSync(join(dir, f));
        if (!st.isFile()) return null;
        return {
          filename:   f,
          size:       st.size,
          mtime:      Math.floor(st.mtimeMs / 1000),
          restorable: RESTORABLE_RE.test(f),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) {
    return [];
  }
}

// Restore `filename` from the backups dir over the live DB.
//
// Sequence (each step assumes the previous succeeded):
//   1. Close the live handle. SQLite checkpoints WAL on close, so the
//      .db file on disk captures the final state after this returns.
//   2. Copy live .db to a uniquely-named pre-restore safety snapshot.
//      Concurrent restores get distinct names via ms-precision timestamp.
//   3. Remove `-wal` / `-shm` sidecars. After step 1's checkpoint these
//      are stale; if left around, openDb in step 5 would try to merge
//      them with the new backup file, producing garbled state.
//   4. Copy the chosen backup over /data/sensorpush.db.
//   5. Re-open the freshly-replaced live file. Caller receives the new
//      DatabaseSync; any in-flight requests still using the old handle
//      from before step 1 will error — documented as expected for this
//      admin operation.
export function restoreBackup(currentDb, filename) {
  if (!isRestorableName(filename)) throw new Error('invalid backup filename');
  const dir = getBackupsDir();
  const src = join(dir, filename);
  if (!existsSync(src)) throw new Error(`backup not found: ${filename}`);

  const live = process.env.DB_PATH || '/data/sensorpush.db';

  const ts              = new Date().toISOString().replace(/[:.]/g, '-');
  const preRestoreName  = `sensorpush-pre-restore-${ts}.db`;
  const preRestorePath  = join(dir, preRestoreName);

  currentDb.close();
  copyFileSync(live, preRestorePath);
  for (const sfx of ['-wal', '-shm']) {
    try { if (existsSync(live + sfx)) unlinkSync(live + sfx); } catch (_) {}
  }
  copyFileSync(src, live);
  const newDb = openDb(live);
  return { newDb, preRestoreFilename: preRestoreName };
}
