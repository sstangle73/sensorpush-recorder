// Unit tests for pure helper functions defined in sensor-api/ui.html.
// Functions are duplicated here because ui.html has no module exports.
// If the implementations change in ui.html, update these copies.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function timeAgo(iso) {
  if (!iso) return 'never';
  const mins = (Date.now() - new Date(iso).getTime()) / 60000;
  if (mins < 1)   return 'just now';
  if (mins < 60)  return Math.round(mins) + ' min ago';
  const hrs = mins / 60;
  if (hrs < 24)   return Math.round(hrs) + ' hr ago';
  return Math.round(hrs / 24) + ' d ago';
}

function seenClass(iso) {
  if (!iso) return 'stale';
  const mins = (Date.now() - new Date(iso).getTime()) / 60000;
  if (mins > 30) return 'stale';
  if (mins > 10) return 'warn';
  return '';
}

// API_BASE logic from ui.html: pathname-based detection
function apiBase(pathname) {
  return pathname.startsWith('/sensorpush') ? '/api/sensors' : '';
}

// Pin Date.now() so relative-time assertions are deterministic
const NOW = new Date('2026-04-19T12:00:00Z').getTime();

function ago(minutes) {
  return new Date(NOW - minutes * 60 * 1000).toISOString();
}

beforeEach(() => { vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('timeAgo', () => {
  it('returns "never" for null', () => {
    expect(timeAgo(null)).toBe('never');
  });

  it('returns "never" for undefined', () => {
    expect(timeAgo(undefined)).toBe('never');
  });

  it('returns "just now" for 0 seconds ago', () => {
    expect(timeAgo(new Date(NOW).toISOString())).toBe('just now');
  });

  it('returns "just now" for 30 seconds ago', () => {
    expect(timeAgo(new Date(NOW - 30000).toISOString())).toBe('just now');
  });

  it('returns "1 min ago" for 1 minute ago', () => {
    expect(timeAgo(ago(1))).toBe('1 min ago');
  });

  it('returns "5 min ago" for 5 minutes ago', () => {
    expect(timeAgo(ago(5))).toBe('5 min ago');
  });

  it('returns "59 min ago" for 59 minutes ago', () => {
    expect(timeAgo(ago(59))).toBe('59 min ago');
  });

  it('returns "1 hr ago" for 60 minutes ago', () => {
    expect(timeAgo(ago(60))).toBe('1 hr ago');
  });

  it('returns "3 hr ago" for 3 hours ago', () => {
    expect(timeAgo(ago(180))).toBe('3 hr ago');
  });

  it('returns "23 hr ago" for 23 hours ago', () => {
    expect(timeAgo(ago(23 * 60))).toBe('23 hr ago');
  });

  it('returns "1 d ago" for 24 hours ago', () => {
    expect(timeAgo(ago(24 * 60))).toBe('1 d ago');
  });

  it('returns "7 d ago" for 7 days ago', () => {
    expect(timeAgo(ago(7 * 24 * 60))).toBe('7 d ago');
  });
});

describe('seenClass', () => {
  it('returns "stale" for null', () => {
    expect(seenClass(null)).toBe('stale');
  });

  it('returns "stale" for undefined', () => {
    expect(seenClass(undefined)).toBe('stale');
  });

  it('returns "" (fresh) for just now', () => {
    expect(seenClass(new Date(NOW).toISOString())).toBe('');
  });

  it('returns "" (fresh) for 9 minutes ago', () => {
    expect(seenClass(ago(9))).toBe('');
  });

  it('returns "warn" for exactly 11 minutes ago', () => {
    expect(seenClass(ago(11))).toBe('warn');
  });

  it('returns "warn" for 29 minutes ago', () => {
    expect(seenClass(ago(29))).toBe('warn');
  });

  it('returns "stale" for exactly 31 minutes ago', () => {
    expect(seenClass(ago(31))).toBe('stale');
  });

  it('returns "stale" for several hours ago', () => {
    expect(seenClass(ago(120))).toBe('stale');
  });

  it('returns "stale" for a day ago', () => {
    expect(seenClass(ago(24 * 60))).toBe('stale');
  });
});

describe('API_BASE detection', () => {
  it('returns /api/sensors when served via nginx at /sensorpush/', () => {
    expect(apiBase('/sensorpush/')).toBe('/api/sensors');
  });

  it('returns /api/sensors for any /sensorpush sub-path', () => {
    expect(apiBase('/sensorpush/anything')).toBe('/api/sensors');
  });

  it('returns "" when served directly at /ui (port 3003)', () => {
    expect(apiBase('/ui')).toBe('');
  });

  it('returns "" for root path', () => {
    expect(apiBase('/')).toBe('');
  });

  it('returns "" for unrelated paths', () => {
    expect(apiBase('/dashboard')).toBe('');
  });
});
