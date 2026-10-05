import { describe, expect, it } from 'vitest';

import { LockoutCache } from './lockout-cache.js';

describe('LockoutCache (finding 7)', () => {
  it('remembers a lockout until it ends, keyed by an HMAC of the viewer network', () => {
    const cache = new LockoutCache(10);
    const key = cache.keyFor('203.0.113.7');
    expect(key).not.toContain('203');
    expect(cache.keyFor('203.0.113.7')).toBe(key);
    expect(cache.keyFor('203.0.113.8')).not.toBe(key);
    expect(cache.remainingMs(key, 1_000)).toBe(0);
    cache.lock(key, 61_000);
    expect(cache.remainingMs(key, 1_000)).toBe(60_000);
    expect(cache.remainingMs(key, 61_000)).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('uses a per-container key, so two caches never share hashes', () => {
    expect(new LockoutCache(1).keyFor('2001:db8::/64')).not.toBe(new LockoutCache(1).keyFor('2001:db8::/64'));
    expect(new LockoutCache(1).keyFor(null)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is bounded: the oldest entries are evicted first', () => {
    const cache = new LockoutCache(2);
    const [a, b, c] = ['a', 'b', 'c'].map((n) => cache.keyFor(n)) as [string, string, string];
    cache.lock(a, 10_000);
    cache.lock(b, 10_000);
    cache.lock(c, 10_000);
    expect(cache.size).toBe(2);
    expect(cache.remainingMs(a, 0)).toBe(0);
    expect(cache.remainingMs(c, 0)).toBe(10_000);
    const disabled = new LockoutCache(0);
    disabled.lock(a, 10_000);
    expect(disabled.size).toBe(0);
  });
});
