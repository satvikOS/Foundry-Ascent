import { MockModelGateway, mockCoachResponse, type MockGenerateContext } from '@foundry/ai';
import { coreConfig, createCore, createRequestContext } from '@foundry/core';
import {
  FakeSpeechSynthesizer,
  FakeSttGrantIssuer,
  MemoryJobQueue,
  MemoryObjectStore,
  Utf8TextExtractor,
} from '@foundry/core/testing';
import {
  createDbFromDriver,
  createPgDriver,
  instrumentDriver,
  p,
  principalsRepo,
  type Db,
  type SqlConnection,
  type SqlDriver,
} from '@foundry/db';
import { createTestDatabase, type TestDatabase } from '@foundry/db/testing';

import { AsyncLocalStorage } from 'node:async_hooks';

import { type ApiApp, createApp } from '../app.js';
import { createJsonLogger, type Logger } from '../logging.js';
import { InflightTracker } from '../runtime/inflight.js';
import { observeGateway } from '../runtime/observed-gateway.js';
import { currentRequestMetrics, recordDbCall } from '../runtime/request-metrics.js';
import { warmApiProcess } from '../runtime/warm-up.js';
import { buildRequest, nextViewerIp, type RequestOptions, sessionTokenFrom } from '../testing/api-harness.js';
import { type SimulatedLatency, simulatedGateway } from './simulation.js';

/**
 * The whole API in one process over a fresh seeded database, with production-like latency added where
 * production waits on the network (`SimulatedLatency`): every database round trip, the model, the
 * embedding and the speech service. The app, core, middleware and instrumentation are the real ones; only
 * the far ends are simulated. Every log line the app writes is kept (`logs`) so the stage timings can be
 * read the way they are read in production.
 */
export interface LatencyRig {
  readonly app: ApiApp;
  readonly db: Db;
  readonly t: TestDatabase;
  readonly logs: string[];
  readonly latency: SimulatedLatency;
  /** Every round trip the app made, with the request that made it (`LatencyRigOptions.traceQueries`; else empty). */
  readonly queries: TracedRoundTrip[];
  readonly ventureId: string;
  readonly founderId: string;
  request(path: string, options?: RequestOptions): Promise<Response>;
  /** Signs a principal in through the real endpoint (an access code issued by the owner). */
  signIn(principalId: string): Promise<string>;
  cleanup(): Promise<void>;
}

/** Founder messages that start with this get a one-sentence reply on a call (a quick back-and-forth). */
export const QUICK_PREFIX = 'Quick question:';

/**
 * The mock's own streamed reply (its `spoken` form on a call), cut to its first sentence when the founder
 * asked a quick question on a call: calls mix one-sentence replies with longer ones, and how soon a
 * one-sentence reply is heard differs from a longer one.
 */
export function harnessReply(context: MockGenerateContext): string {
  const response = mockCoachResponse(context);
  const voice = context.control?.channel === 'voice';
  const text =
    voice && typeof response.spoken === 'string' && response.spoken !== ''
      ? response.spoken
      : response.answer;
  if (!voice || !context.founderText.startsWith(QUICK_PREFIX)) return text;
  return /^.*?[.!?](?=\s|$)/su.exec(text)?.[0] ?? text;
}

/**
 * One database round trip as the Data API would count it (`traceQueries`): a statement, or a transaction's begin and
 * end together (`sql` = `BEGIN … COMMIT`, 2 round trips). `sql` is the statement's text with whitespace collapsed: the
 * harness's own seeded data only, never printed with parameters.
 */
export interface TracedRoundTrip {
  /** The rig request that made it (its path), or null outside one. */
  readonly path: string | null;
  readonly sql: string;
  readonly roundTrips: number;
  /** Whether the request's first streamed model call had not started yet when the round trip began. */
  readonly beforeModel: boolean;
  /** Milliseconds since the request reached the API, when the round trip began. */
  readonly at: number;
  /** The request's metrics object: one per request (to tell two requests on the same path apart). */
  readonly request: object | null;
}

export interface LatencyRigOptions {
  /**
   * Extra copies of each of the venture's three most recent confirmed memory items, as production's venture
   * memory held them (the same advisor meeting four times): retrieval then meets the repeats a real turn does.
   */
  readonly duplicateMemory?: number;
  /** Keep every round trip with its request and statement text (`LatencyRig.queries`, `latency --queries`). */
  readonly traceQueries?: boolean;
  /**
   * Skip the process-start warm-up the API Lambda's init and the dev server run (runtime/warm-up.ts), to measure a
   * process without it (`latency --skip-init-warm-up`).
   */
  readonly skipInitWarmUp?: boolean;
}

/** Records each statement and transaction of `driver` into `into`, labelled with the rig request (`label`). */
function traceDriver(
  driver: SqlDriver,
  into: TracedRoundTrip[],
  label: AsyncLocalStorage<string>,
): SqlDriver {
  const record = (sql: string, roundTrips: number): void => {
    const metrics = currentRequestMetrics();
    into.push({
      path: label.getStore() ?? null,
      sql: sql.replace(/\s+/gu, ' ').trim(),
      roundTrips,
      beforeModel: metrics === undefined || metrics.stream.startedAt === null,
      at: metrics === undefined ? 0 : metrics.elapsed(),
      request: metrics ?? null,
    });
  };
  const wrap = (conn: SqlConnection): SqlConnection => ({
    query: (sql, params) => {
      record(sql, 1);
      return conn.query(sql, params);
    },
  });
  return {
    driver: driver.driver,
    query: (sql, params) => {
      record(sql, 1);
      return driver.query(sql, params);
    },
    queryWithOptions: (sql, params, options) => {
      record(sql, 1);
      return driver.queryWithOptions(sql, params, options);
    },
    transaction: (fn) => {
      record('BEGIN … COMMIT', 2);
      return driver.transaction((conn) => fn(wrap(conn)));
    },
    close: () => driver.close(),
  };
}

export async function createLatencyRig(
  latency: SimulatedLatency,
  options: LatencyRigOptions = {},
): Promise<LatencyRig> {
  const t = await createTestDatabase({ seed: true });
  const seed = t.seed;
  if (seed === null) throw new Error('the latency rig needs a seeded database');
  const quietquad = seed.ventures.find((v) => v.key === 'quietquad');
  const copies = options.duplicateMemory ?? 0;
  if (quietquad !== undefined && copies > 0) {
    await t.db.system((sx) =>
      sx.query(
        `INSERT INTO memory_objects (tenant_id, venture_id, type, title, content, attributes, status, visibility,
                                     confidence, source_refs, origin, created_by, approved_by, approved_at, embedding)
         SELECT m.tenant_id, m.venture_id, m.type, m.title, m.content, m.attributes, m.status, m.visibility,
                m.confidence, m.source_refs, m.origin, m.created_by, m.approved_by, m.approved_at, m.embedding
         FROM (SELECT * FROM memory_objects WHERE venture_id = :ventureId AND status = 'confirmed'
               ORDER BY updated_at DESC, id LIMIT 3) m
         CROSS JOIN generate_series(1, :copies)`,
        { ventureId: p.uuid(quietquad.id), copies: p.int(copies) },
      ),
    );
  }
  const queries: TracedRoundTrip[] = [];
  const label = new AsyncLocalStorage<string>();
  const pg = createPgDriver({ connectionString: t.url, max: 6 });
  const db = createDbFromDriver(
    instrumentDriver(options.traceQueries === true ? traceDriver(pg, queries, label) : pg, {
      onCall: recordDbCall,
      simulatedRoundTripMs: latency.dbRoundTripMs,
    }),
  );
  const logs: string[] = [];
  const logger: Logger = createJsonLogger({ level: 'info', write: (line) => logs.push(line) });
  const gateway = observeGateway(
    simulatedGateway(new MockModelGateway({ streamDelayMs: 0, streamFixture: harnessReply }), latency),
  );
  const speech = new FakeSpeechSynthesizer();
  speech.delayMs = latency.speechFirstByteMs;
  // As in production: work after a response (settling a turn's kept memory) is drained, never waited for.
  const inflight = new InflightTracker();
  const core = createCore({
    db,
    gateway,
    // Every scenario talks as one founder: lift the per-person message limit, keep everything else.
    config: coreConfig({ appEnv: 'test', turns: { rateLimit: 1_000 } }),
    objectStore: new MemoryObjectStore(),
    jobQueue: new MemoryJobQueue(),
    textExtractor: new Utf8TextExtractor(),
    logger: logger.child({ component: 'core' }),
    speech,
    sttGrants: new FakeSttGrantIssuer(),
    afterResponse: (task) => {
      void inflight.track(task);
    },
  });
  const app = createApp({ core, db, logger, appEnv: 'test', appVersion: 'latency-harness', inflight });
  // As a Lambda container's init and the dev server do before their first request.
  if (options.skipInitWarmUp !== true) await warmApiProcess(logger);
  const request = async (path: string, requestOptions?: RequestOptions): Promise<Response> =>
    label.run(path, () => app.request(buildRequest(path, requestOptions)));

  const venture = seed.ventures.find((v) => v.key === 'quietquad');
  const founderId = seed.principals.maya;
  const ownerId = seed.ownerId;
  if (venture === undefined || founderId === undefined || ownerId === null) {
    throw new Error('the seed is missing the quietquad venture, its founder or the owner');
  }

  return {
    app,
    db,
    t,
    logs,
    latency,
    queries,
    ventureId: venture.id,
    founderId,
    request,
    async signIn(principalId) {
      const roles = await t.db.system((sx) =>
        principalsRepo.listActiveRoles(sx, { principalId: ownerId, tenantId: seed.tenantId }),
      );
      const ownerCtx = createRequestContext({
        principalId: ownerId,
        tenantId: seed.tenantId,
        roles,
        requestId: 'latency-rig',
      });
      const issued = await core.admin.issueAccessCode(ownerCtx, principalId, { label: 'latency harness' });
      const res = await request('/auth/sign-in', {
        body: { accessCode: issued.accessCode },
        headers: { 'x-fa-viewer-ip': nextViewerIp() },
      });
      const token = sessionTokenFrom(res);
      if (res.status !== 200 || token === null) throw new Error(`sign-in failed with ${String(res.status)}`);
      return token;
    },
    async cleanup() {
      await inflight.drain(10_000);
      await db.close();
      await t.cleanup();
    },
  };
}
