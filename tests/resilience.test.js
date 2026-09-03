// Regression tests for the 2026-09-02 outage class: a slow disk (the nightly
// hypervisor backup fsync-freezes this guest, driving await from ~2ms to
// ~1200ms) turning into a hard outage, and a dead poll loop being invisible.
//
// Two independent failure modes are covered here:
//   1. /metrics rendered on the request path, so every scrape carried a
//      synchronous node:sqlite read. Under a slow disk those reads blew past
//      the 10s scrape timeout (scrape_duration_seconds pinned at exactly
//      10.002s during the incident) while /health, which does no DB work,
//      stayed instant — so the scraper saw the service as down and the
//      container healthcheck saw it as fine.
//   2. The poll loop could stop producing forever while /health kept
//      answering ok:true — 20 hours of it, in the incident.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';

vi.mock('../sensorpush.js', () => ({
  getToken:      vi.fn(),
  fetchSensors:  vi.fn(),
  fetchSamples:  vi.fn(),
  fetchGateways: vi.fn(),
}));

import { getToken, fetchSensors, fetchSamples, fetchGateways } from '../sensorpush.js';
import { createApp } from '../server.js';
import { openDb, upsertSensors } from '../db.js';
import { triggerPoll, getPollStatus, _resetPollerState } from '../poller.js';

const CREDS = { sensorpush: { email: 'a@b.com', password: 'pw' } };

async function withServer(db, fn) {
  const server = http.createServer(createApp(db));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); }
  finally { await new Promise(r => server.close(r)); }
}

describe('/metrics is served off the request path', () => {
  it('does not touch the database after the first render', async () => {
    const db = openDb(':memory:');
    await withServer(db, async base => {
      const first = await fetch(base + '/metrics');
      expect(first.status).toBe(200);
      const firstBody = await first.text();
      expect(firstBody).toContain('sensorpush_last_poll_success');

      // Stand in for a disk so slow that a synchronous node:sqlite read would
      // outlast the scrape timeout: any DB access from here on throws. A
      // second scrape must still succeed, from cache, without querying.
      const realPrepare = db.prepare.bind(db);
      db.prepare = () => { throw new Error('DB must not be queried on the /metrics request path'); };
      try {
        const second = await fetch(base + '/metrics');
        expect(second.status).toBe(200);
        expect(await second.text()).toBe(firstBody);
      } finally {
        db.prepare = realPrepare;
      }
    });
  });

  it('refreshes the cache after its max age, off the response path', async () => {
    const db = openDb(':memory:');
    process.env.METRICS_MAX_AGE_MS = '0';
    try {
      await withServer(db, async base => {
        const cold = await (await fetch(base + '/metrics')).text();
        expect(cold).toContain('sensorpush_sensors_total 0');

        upsertSensors(db, [{ id: 's-new', name: 'Added', type: 'HT1', active: true }]);
        // Two more scrapes: the first serves the pre-insert cache and queues
        // the re-render, the second sees the refreshed body.
        await fetch(base + '/metrics');
        await new Promise(r => setTimeout(r, 50));
        const body = await (await fetch(base + '/metrics')).text();
        expect(body).toContain('sensorpush_sensors_total 1');
      });
    } finally {
      delete process.env.METRICS_MAX_AGE_MS;
    }
  });

  it('stamps each rendered body with its render time so staleness is visible', async () => {
    const db = openDb(':memory:');
    await withServer(db, async base => {
      const body = await (await fetch(base + '/metrics')).text();
      const m = /^sensorpush_metrics_rendered_timestamp_seconds (\d+)$/m.exec(body);
      expect(m).not.toBeNull();
      expect(Math.abs(Number(m[1]) - Math.floor(Date.now() / 1000))).toBeLessThan(60);
    });
  });
});

describe('/health sees a dead poll loop', () => {
  beforeEach(() => { _resetPollerState(); vi.clearAllMocks(); });
  afterEach(() => { _resetPollerState(); delete process.env.HEALTH_MAX_POLL_AGE_SECS; });

  async function health(base) {
    const res = await fetch(base + '/health');
    return { status: res.status, body: await res.json() };
  }

  it('reports healthy before the first poll — a restart cannot fix a fresh or misconfigured recorder', async () => {
    const db = openDb(':memory:');
    await withServer(db, async base => {
      const { status, body } = await health(base);
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.lastPoll).toBeNull();
      expect(body.pollAgeSecs).toBeNull();
    });
  });

  it('reports healthy right after a successful poll', async () => {
    const db = openDb(':memory:');
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([{ id: 's1', name: 'Test', type: 'HT1', active: true }]);
    fetchGateways.mockResolvedValue([]);
    fetchSamples.mockResolvedValue([]);
    await triggerPoll(db, CREDS);
    await withServer(db, async base => {
      const { status, body } = await health(base);
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.pollAgeSecs).toBeLessThan(60);
    });
  });

  it('reports 503 once the poll loop has been silent past the limit', async () => {
    const db = openDb(':memory:');
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([{ id: 's1', name: 'Test', type: 'HT1', active: true }]);
    fetchGateways.mockResolvedValue([]);
    fetchSamples.mockResolvedValue([]);
    await triggerPoll(db, CREDS);

    // Shrink the window instead of faking the clock — mocking Date.now breaks
    // fetch's own timers. A 10ms limit makes the poll we just did already
    // "stale", which is the shape of the outage: process up, event loop free,
    // no data landing.
    process.env.HEALTH_MAX_POLL_AGE_SECS = '0.01';
    await new Promise(r => setTimeout(r, 30));
    await withServer(db, async base => {
      const { status, body } = await health(base);
      expect(status).toBe(503);
      expect(body.ok).toBe(false);
      expect(body.lastPoll).not.toBeNull();
      expect(body.error).toMatch(/no successful poll/);
    });
  });

  it('can be disabled entirely with HEALTH_MAX_POLL_AGE_SECS=0', async () => {
    const db = openDb(':memory:');
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([{ id: 's1', name: 'Test', type: 'HT1', active: true }]);
    fetchGateways.mockResolvedValue([]);
    fetchSamples.mockResolvedValue([]);
    await triggerPoll(db, CREDS);

    process.env.HEALTH_MAX_POLL_AGE_SECS = '0';
    await new Promise(r => setTimeout(r, 30));
    await withServer(db, async base => {
      const { status, body } = await health(base);
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });
  });
});

describe('poll loop cannot pile up or fail silently', () => {
  beforeEach(() => { _resetPollerState(); vi.clearAllMocks(); });
  afterEach(() => { _resetPollerState(); });

  it('skips a tick while a poll is still in flight instead of overlapping it', async () => {
    const db = openDb(':memory:');
    let release;
    const gate = new Promise(r => { release = r; });
    getToken.mockResolvedValue('tok');
    // Hold the first poll open inside fetchSensors, the way a slow window does.
    fetchSensors.mockImplementation(async () => {
      await gate;
      return [{ id: 's1', name: 'Test', type: 'HT1', active: true }];
    });
    fetchGateways.mockResolvedValue([]);
    fetchSamples.mockResolvedValue([]);

    const inFlight = triggerPoll(db, CREDS);
    await Promise.resolve();
    expect(getPollStatus().pollInFlight).toBe(true);

    // A second attempt arriving mid-poll is dropped, not queued: without this
    // the 5-minute interval keeps launching polls that each add synchronous
    // insert+recompute bursts to an event loop already behind on disk.
    await triggerPoll(db, CREDS);
    expect(getPollStatus().pollSkipped).toBe(1);
    expect(fetchSensors).toHaveBeenCalledTimes(1);

    release();
    await inFlight;
    expect(getPollStatus().pollSkipped).toBe(0);
    expect(getPollStatus().pollInFlight).toBe(false);
  });

  it('records a reason when the cloud returns no sensors instead of returning silently', async () => {
    const db = openDb(':memory:');
    getToken.mockResolvedValue('tok');
    fetchSensors.mockResolvedValue([]);
    await triggerPoll(db, CREDS);
    expect(getPollStatus().lastPollError).toMatch(/empty sensor list/);
    expect(getPollStatus().lastPollTime).toBeNull();
  });

  it('records a reason when no credentials are configured instead of returning silently', async () => {
    const db = openDb(':memory:');
    await triggerPoll(db, {});
    expect(getPollStatus().lastPollError).toMatch(/no SensorPush credentials/);
    expect(fetchSensors).not.toHaveBeenCalled();
  });
});
