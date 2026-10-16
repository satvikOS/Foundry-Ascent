import { MockModelGateway, mockCoachResponse, type MockGenerateContext } from '@foundry/ai';
import { coreConfig, createCore, createRequestContext } from '@foundry/core';
import {
  FakeSpeechSynthesizer,
  FakeSttGrantIssuer,
  MemoryJobQueue,
  MemoryObjectStore,
  Utf8TextExtractor,
} from '@foundry/core/testing';
import { createDbFromDriver, createPgDriver, instrumentDriver, principalsRepo, type Db } from '@foundry/db';
import { createTestDatabase, type TestDatabase } from '@foundry/db/testing';

import { type ApiApp, createApp } from '../app.js';
import { createJsonLogger, type Logger } from '../logging.js';
import { observeGateway } from '../runtime/observed-gateway.js';
import { recordDbCall } from '../runtime/request-metrics.js';
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

export async function createLatencyRig(latency: SimulatedLatency): Promise<LatencyRig> {
  const t = await createTestDatabase({ seed: true });
  const seed = t.seed;
  if (seed === null) throw new Error('the latency rig needs a seeded database');
  const db = createDbFromDriver(
    instrumentDriver(createPgDriver({ connectionString: t.url, max: 6 }), {
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
  });
  const app = createApp({ core, db, logger, appEnv: 'test', appVersion: 'latency-harness' });
  const request = async (path: string, options?: RequestOptions): Promise<Response> =>
    app.request(buildRequest(path, options));

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
      await db.close();
      await t.cleanup();
    },
  };
}
