import { DatabaseResumingError, type Db } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiApp } from './app.js';
import { WAKE_INSTANCE_INTERVAL_MS, WAKE_PER_IP_INTERVAL_MS } from './routes/wake.js';
import { observeDatabase } from './runtime/db-observer.js';
import { InflightTracker } from './runtime/inflight.js';
import { type ApiHarness, buildRequest, createApiHarness, failingDb } from './testing/api-harness.js';

let api: ApiHarness;

beforeAll(async () => {
  api = await createApiHarness();
});
afterAll(async () => {
  await api.cleanup();
});

/** Counts the pings that reach the real database (the only call the wake route may make). */
function countingDb(db: Db): { readonly db: Db; readonly pings: unknown[] } {
  const pings: unknown[] = [];
  return {
    pings,
    db: {
      driver: db.driver,
      withContext: (ctx, fn) => db.withContext(ctx, fn),
      system: (fn, opts) => db.system(fn, opts),
      ping: (opts) => {
        pings.push(opts);
        return db.ping(opts);
      },
      close: () => db.close(),
    },
  };
}

/** An app with its own wake gate, clock and in-flight tracker over `db`. */
function wakeApp(db: Db, extra: Partial<Parameters<ApiHarness['appWith']>[0]> = {}) {
  let t = Date.parse('2026-10-17T12:00:00Z');
  const inflight = new InflightTracker();
  const app: ApiApp = api.appWith({ db, inflight, now: () => new Date(t), ...extra });
  return {
    app,
    inflight,
    advance: (ms: number) => {
      t += ms;
    },
    wake: (ip: string, headers: Record<string, string> = {}) =>
      app.request(buildRequest('/wake', { method: 'POST', headers: { 'x-fa-viewer-ip': ip, ...headers } })),
  };
}

const wakeLogs = (): Record<string, unknown>[] =>
  api.logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === 'db.wake');

describe('POST /wake', () => {
  it('is public, answers 204 with no content, and runs one SELECT 1 on the database', async () => {
    expect(api.app.routeTable).toContainEqual({
      method: 'POST',
      path: '/wake',
      auth: 'public',
      idempotency: 'none',
    });
    const counting = countingDb(api.h.t.db);
    const w = wakeApp(counting.db);
    const before = wakeLogs().length;

    const res = await w.wake('203.0.113.50');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(res.headers.get('content-type')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await w.inflight.drain(5_000)).toBe(0);
    // A single attempt: on a paused cluster it fails at once and starts the resume, it never waits for it.
    expect(counting.pings).toEqual([{ maxWaitMs: 0 }]);
    expect(wakeLogs().slice(before)).toMatchObject([{ outcome: 'awake' }]);
  });

  it('limits each viewer IP to one database call per window, and the instance to one per 30 s', async () => {
    const counting = countingDb(api.h.t.db);
    const w = wakeApp(counting.db);
    const sent = async (ip: string): Promise<boolean> => {
      const before = counting.pings.length;
      const res = await w.wake(ip);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      await w.inflight.drain(5_000);
      return counting.pings.length > before;
    };

    expect(await sent('203.0.113.60')).toBe(true);
    // Same IP again, at once and later in the window: still 204, nothing sent.
    expect(await sent('203.0.113.60')).toBe(false);
    w.advance(WAKE_INSTANCE_INTERVAL_MS + 1_000);
    expect(await sent('203.0.113.60')).toBe(false);
    // Another IP after the instance interval: sent. A third one within 30 s of it: not.
    expect(await sent('203.0.113.61')).toBe(true);
    w.advance(5_000);
    expect(await sent('203.0.113.62')).toBe(false);
    // The first IP once its window has passed: sent again.
    w.advance(WAKE_PER_IP_INTERVAL_MS);
    expect(await sent('203.0.113.60')).toBe(true);
    expect(counting.pings).toHaveLength(3);
  });

  it('sends nothing while this instance saw the database awake recently', async () => {
    const counting = countingDb(api.h.t.db);
    const { db, state } = observeDatabase(counting.db);
    const w = wakeApp(db, { dbState: state });
    await db.ping(); // a real request's database call
    const before = counting.pings.length;
    expect((await w.wake('203.0.113.70')).status).toBe(204);
    await w.inflight.drain(5_000);
    expect(counting.pings).toHaveLength(before);
  });

  it('on a paused cluster answers 204 and logs that the resume started, after one attempt', async () => {
    const counting = countingDb(
      failingDb(
        api.h.t.db,
        () => true,
        () => new DatabaseResumingError({ waitedMs: 0 }),
      ),
    );
    const w = wakeApp(counting.db);
    const before = wakeLogs().length;
    expect((await w.wake('203.0.113.80')).status).toBe(204);
    await w.inflight.drain(5_000);
    expect(counting.pings).toEqual([{ maxWaitMs: 0 }]);
    expect(wakeLogs().slice(before)).toMatchObject([{ outcome: 'resuming' }]);
  });

  it('answers before a slow database call ends, tracks the call, and starts no second one meanwhile', async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pings: unknown[] = [];
    const real = api.h.t.db;
    const slow: Db = {
      driver: real.driver,
      withContext: (ctx, fn) => real.withContext(ctx, fn),
      system: (fn, opts) => real.system(fn, opts),
      close: () => real.close(),
      ping: async (opts) => {
        pings.push(opts);
        await pending;
      },
    };
    const w = wakeApp(slow);
    expect((await w.wake('203.0.113.90')).status).toBe(204);
    expect(w.inflight.size).toBe(1);
    w.advance(WAKE_INSTANCE_INTERVAL_MS + 1_000);
    expect((await w.wake('203.0.113.91')).status).toBe(204);
    expect(pings).toHaveLength(1);
    release();
    expect(await w.inflight.drain(5_000)).toBe(0);
  });

  it('requires the CSRF header like every other write', async () => {
    const counting = countingDb(api.h.t.db);
    const w = wakeApp(counting.db);
    const res = await w.app.request(
      buildRequest('/wake', { method: 'POST', csrf: false, headers: { 'x-fa-viewer-ip': '203.0.113.99' } }),
    );
    expect(res.status).toBe(403);
    expect(counting.pings).toHaveLength(0);
  });
});
