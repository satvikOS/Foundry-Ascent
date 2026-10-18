/**
 * LOCAL DEVELOPMENT SERVER — never deployed.
 *
 *   pnpm --filter @foundry/db db:reset     # once: local database + seed + a DEV owner access code
 *   pnpm --filter @foundry/api dev         # http://localhost:8787/api/v1
 *
 * Defaults: APP_ENV=development, DB_DRIVER=pg, DATABASE_URL = the db:reset database, MODEL_PROVIDER=mock.
 * Documents go to a local directory through presigned-style URLs served by this process
 * (PUT /api/v1/_local/uploads/:token). Jobs run in-process through the worker's own dispatch, every type the
 * Lambda worker handles (ingestion, distillation, the sweep and daily maintenance), right after they are
 * enqueued or after their delay; daily maintenance also runs once a day while the server is up. For a quicker
 * local demo of distillation, set CORE_DISTILL_DELAY_SECONDS (and CORE_DISTILL_ACTIVE_SECONDS below it).
 * Calls are typed and unspoken unless LOCAL_AWS_SPEECH=true with MODEL_PROVIDER=bedrock and AWS credentials
 * (the conversation lab): then they speak with Amazon Polly and listen through Amazon Transcribe, as deployed.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { serve } from '@hono/node-server';
import { MAX_DOCUMENT_BYTES } from '@foundry/contracts';
import { createCore } from '@foundry/core';
import { migrate } from '@foundry/db';

import { developmentFaceFor } from './adapters/development-face.js';
import { developmentVoiceFor } from './adapters/development-voice.js';
import { InlineJobQueue } from './adapters/inline-job-queue.js';
import { LocalObjectStore } from './adapters/local-object-store.js';
import { DocumentTextExtractor } from './adapters/text-extractor.js';
import { createApp } from './app.js';
import { loadApiConfig, loadCoreConfig } from './config.js';
import { DAILY_MAINTENANCE_MESSAGE, dispatchJob } from './jobs/worker.js';
import { errorFields } from './logging.js';
import { createDatabase, createGateway, createProcessLogger } from './runtime/common.js';
import { observeDatabase } from './runtime/db-observer.js';
import { localSpeechFor } from './runtime/local-speech.js';
import { workerDepsFor } from './runtime/worker.js';

/** The database `pnpm --filter @foundry/db db:reset` creates (owner role fa_master, unix socket cluster). */
export const DEFAULT_LOCAL_DATABASE_URL =
  'postgresql://fa_master:fa_master@localhost/foundry?host=/var/tmp&port=54329';

/** Budget of one local job (no Lambda deadline here) and its attempts (like the queue's redrive count). */
const LOCAL_JOB_BUDGET_MS = 10 * 60_000;
const LOCAL_JOB_ATTEMPTS = 3;
const DAY_MS = 24 * 3_600_000;

async function main(): Promise<void> {
  if (process.env.APP_ENV === 'production')
    throw new Error('dev-server refuses to run with APP_ENV=production');
  const env: Record<string, string | undefined> = {
    ...process.env,
    APP_ENV: 'development',
    DB_DRIVER: process.env.DB_DRIVER ?? 'pg',
    DATABASE_URL: process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL,
    MODEL_PROVIDER: process.env.MODEL_PROVIDER ?? 'mock',
  };
  const port = Number(process.env.PORT ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a TCP port');
  const config = loadApiConfig(env, 'dev');
  const logger = createProcessLogger(config, 'dev');

  const { db, state: dbState } = observeDatabase(createDatabase(env));
  const report = await migrate(db);
  logger.info('dev.migrations', {
    applied: report.applied.length,
    alreadyApplied: report.alreadyApplied.length,
  });

  const uploadDir = resolve(
    process.env.LOCAL_UPLOAD_DIR ?? resolve(import.meta.dirname, '..', '.local', 'uploads'),
  );
  mkdirSync(uploadDir, { recursive: true });
  const objectStore = new LocalObjectStore({
    directory: uploadDir,
    // The web dev server proxies /api to this process, so uploads stay same-origin through it.
    publicOrigin: config.siteOrigin ?? `http://localhost:${String(port)}`,
    // Presigned GETs at another origin (the end-to-end suite: this server's own, as S3 is in production).
    downloadOrigin: process.env.LOCAL_DOWNLOAD_ORIGIN,
    maxUploadBytes: MAX_DOCUMENT_BYTES,
  });
  const jobQueue = new InlineJobQueue({ logger, maxAttempts: LOCAL_JOB_ATTEMPTS });
  const gateway = createGateway(env, logger);
  const core = createCore({
    db,
    gateway,
    config: loadCoreConfig(env),
    objectStore,
    jobQueue,
    textExtractor: new DocumentTextExtractor(),
    logger: logger.child({ component: 'core' }),
    // As in production: settling a turn's kept memory follows the response (this process keeps running).
    afterResponse: (task) => {
      void task;
    },
    ...localSpeechFor(env, config),
    // EMBODIMENT_PROVIDER=fake: calls get the stand-in face (a canvas, no vendor, no key) once faces are on;
    // VOICE_CLONE_PROVIDER=fake: a hum stands in for an EIR's cloned voice once cloned voices are on.
    ...developmentFaceFor(env),
    ...developmentVoiceFor(env),
  });
  const workerDeps = workerDepsFor(core, { db, gateway, logger, maxReceiveCount: LOCAL_JOB_ATTEMPTS });
  jobQueue.attach(async (job, { attempt, requestId }) => {
    const log = logger.child({ requestId, jobType: job.type, attempt });
    const { outcome } = await dispatchJob(workerDeps, job, {
      requestId,
      attempt,
      deadline: Date.now() + LOCAL_JOB_BUDGET_MS,
      log,
    });
    return outcome;
  });
  // The production schedule sends the daily maintenance message; locally it runs once a day while up.
  const daily = setInterval(() => {
    jobQueue.submit(DAILY_MAINTENANCE_MESSAGE).catch((err: unknown) => {
      logger.warn('dev.maintenance_not_queued', errorFields(err));
    });
  }, DAY_MS);
  daily.unref();

  const app = createApp({
    core,
    db,
    dbState,
    logger,
    appEnv: 'development',
    appVersion: config.appVersion,
    localUploads: objectStore,
  });
  const server = serve({ fetch: app.fetch, port }, (info) => {
    process.stdout.write(
      `Foundry Ascent API (development) listening on http://localhost:${String(info.port)}/api/v1\n`,
    );
  });

  const shutdown = (): void => {
    clearInterval(daily);
    jobQueue.stop();
    server.close(() => {
      void jobQueue
        .idle()
        .then(() => db.close())
        .finally(() => process.exit(0));
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(
    'dev-server failed to start. Is the local database set up (pnpm --filter @foundry/db db:reset) and DATABASE_URL correct?',
    errorFields(err),
  );
  process.exit(1);
});
