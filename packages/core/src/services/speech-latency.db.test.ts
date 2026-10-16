/**
 * How `POST /speech` spends its time before the first audio bytes (docs/runbooks/latency.md): the platform's
 * spend is read while the checks run, the reservation autocommits where a speech service runs (no Begin/Commit
 * round trips), and the bookkeeping of a synthesis (usage ledger, the call's counter, the audit) runs while the
 * audio streams, which ends only once it is done.
 */
import { MockModelGateway } from '@foundry/ai';
import { createDbFromDriver, createPgDriver, p, principalsRepo, type SqlDriver } from '@foundry/db';
import { createTestDatabase, type TestDatabase } from '@foundry/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { coreConfig } from '../config.js';
import { createRequestContext, type RequestContext } from '../context.js';
import { createCore, type Core } from '../core.js';
import {
  FakeSpeechSynthesizer,
  FakeSttGrantIssuer,
  MemoryJobQueue,
  MemoryObjectStore,
} from '../testing/fakes.js';

interface Statement {
  readonly sql: string;
  readonly inTransaction: boolean;
}

/** Every statement, begin and end, in order; statements matching `held` wait until `release()`. */
function recordingDriver(inner: SqlDriver) {
  const log: (Statement | 'begin' | 'end')[] = [];
  const latch = { held: null as RegExp | null, waiting: [] as (() => void)[] };
  const pass = async (sql: string): Promise<void> => {
    if (latch.held?.test(sql) === true) await new Promise<void>((resolve) => latch.waiting.push(resolve));
  };
  const driver: SqlDriver = {
    driver: inner.driver,
    query: async (sql, params) => {
      log.push({ sql, inTransaction: false });
      await pass(sql);
      return inner.query(sql, params);
    },
    queryWithOptions: async (sql, params, options) => {
      log.push({ sql, inTransaction: false });
      await pass(sql);
      return inner.queryWithOptions(sql, params, options);
    },
    transaction: async (fn) => {
      log.push('begin');
      try {
        return await inner.transaction((conn) =>
          fn({
            query: async (sql, params) => {
              log.push({ sql, inTransaction: true });
              await pass(sql);
              return conn.query(sql, params);
            },
          }),
        );
      } finally {
        log.push('end');
      }
    },
    close: () => inner.close(),
  };
  return {
    driver,
    log,
    hold(pattern: RegExp) {
      latch.held = pattern;
    },
    release() {
      latch.held = null;
      for (const resolve of latch.waiting.splice(0)) resolve();
    },
  };
}

let t: TestDatabase;
let recorder: ReturnType<typeof recordingDriver>;
let core: Core;
let bare: Core;
let maya: RequestContext;

const BOOKKEEPING = /INSERT INTO usage_ledger|app\.append_audit/;
const RESERVATION = /^\s*WITH (me|play) AS/;
const SPEND_TODAY = 'sum(cost_usd)';

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  const seed = t.seed;
  if (seed === null) throw new Error('seed missing');
  recorder = recordingDriver(createPgDriver({ connectionString: t.url, max: 4 }));
  const db = createDbFromDriver(recorder.driver);
  const deps = {
    db,
    gateway: new MockModelGateway({ streamDelayMs: 0 }),
    config: coreConfig({ appEnv: 'test' }),
    objectStore: new MemoryObjectStore(),
    jobQueue: new MemoryJobQueue(),
    sttGrants: new FakeSttGrantIssuer(),
  };
  core = createCore({ ...deps, speech: new FakeSpeechSynthesizer() });
  bare = createCore(deps);
  const principalId = seed.principals.maya;
  if (principalId === undefined) throw new Error('maya missing');
  const roles = await t.db.system((sx) =>
    principalsRepo.listActiveRoles(sx, { principalId, tenantId: seed.tenantId }),
  );
  maya = createRequestContext({
    principalId,
    tenantId: seed.tenantId,
    roles,
    requestId: 'speech-latency-test',
  });
}, 120_000);

afterAll(async () => {
  await t.cleanup();
});

async function introOfNewCall(): Promise<{ sessionId: string; text: string; sig: string; callId: string }> {
  const venture = t.seed?.ventures.find((v) => v.key === 'quietquad');
  if (venture === undefined) throw new Error('quietquad missing');
  const session = await core.sessions.create(maya, venture.id, {});
  const started = await core.calls.start(maya, session.id, { inputMode: 'typed', replace: true });
  if (started.intro === null) throw new Error('expected an intro');
  return { sessionId: session.id, callId: started.call.id, ...started.intro };
}

const statements = (from: number) =>
  recorder.log.slice(from).flatMap((e) => (typeof e === 'string' ? [] : [e]));

describe('speech before the first audio', () => {
  it('hands the audio over before the bookkeeping is written, and ends it only once it is', async () => {
    const intro = await introOfNewCall();
    recorder.hold(BOOKKEEPING);
    try {
      // Resolves although the usage-ledger row and the audit cannot be written yet.
      const speech = await core.speech.synthesize(maya, {
        sessionId: intro.sessionId,
        turnId: null,
        seq: 0,
        text: intro.text,
        sig: intro.sig,
      });
      const reader = speech.audio.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe(`MP3:${intro.text}`);
      let ended = false;
      const rest = (async () => {
        while (!(await reader.read()).done) {
          /* drain */
        }
        ended = true;
      })();
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Held writes keep the response open.
      expect(ended).toBe(false);
      recorder.release();
      await rest;
      expect(ended).toBe(true);
    } finally {
      recorder.release();
    }
    const rows = await t.db.system((sx) =>
      sx.query(
        `SELECT (SELECT count(*)::int FROM usage_ledger WHERE purpose = 'speech' AND request_id = :r) AS usage,
                (SELECT count(*)::int FROM audit_events WHERE action = 'speech.synthesized' AND request_id = :r) AS audit`,
        { r: p.text('speech-latency-test') },
      ),
    );
    expect(rows.rows[0]).toEqual({ usage: 1, audit: 1 });
    await core.calls.end(maya, intro.callId, { reason: 'user' });
  });

  it('reserves in one autocommit statement, and reads the spend and the call while the checks run', async () => {
    const intro = await introOfNewCall();
    const from = recorder.log.length;
    const speech = await core.speech.synthesize(maya, {
      sessionId: intro.sessionId,
      turnId: null,
      seq: 0,
      text: intro.text,
      sig: intro.sig,
    });
    await new Response(speech.audio).arrayBuffer();
    const reservation = statements(from).filter((s) => RESERVATION.test(s.sql));
    expect(reservation).toEqual([{ sql: expect.any(String) as string, inTransaction: false }]);
    // The spend is read before the checks' transaction ends.
    const events = recorder.log.slice(from);
    const spendAt = events.findIndex((e) => typeof e !== 'string' && e.sql.includes(SPEND_TODAY));
    const checksEnd = events.indexOf('end');
    expect(spendAt).toBeGreaterThanOrEqual(0);
    expect(spendAt).toBeLessThan(checksEnd);
    // The caller's call is read in a second transaction, begun before the first one ends.
    expect(events.slice(0, checksEnd).filter((e) => e === 'begin')).toHaveLength(2);
    await core.calls.end(maya, intro.callId, { reason: 'user' });
  });

  it('without a speech service, reserves inside a transaction that the 501 rolls back', async () => {
    const intro = await introOfNewCall();
    const from = recorder.log.length;
    await expect(
      bare.speech.synthesize(maya, {
        sessionId: intro.sessionId,
        turnId: null,
        seq: 0,
        text: intro.text,
        sig: intro.sig,
      }),
    ).rejects.toMatchObject({ code: 'speech_unavailable' });
    const reservation = statements(from).filter((s) => RESERVATION.test(s.sql));
    expect(reservation.map((s) => s.inTransaction)).toEqual([true]);
    const plays = await t.db.system((sx) =>
      sx.query(`SELECT count(*)::int AS n FROM call_speech WHERE call_id = :c`, { c: p.uuid(intro.callId) }),
    );
    expect(plays.rows[0]).toEqual({ n: 0 });
    await core.calls.end(maya, intro.callId, { reason: 'user' });
  });
});
