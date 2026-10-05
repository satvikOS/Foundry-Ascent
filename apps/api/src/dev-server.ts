/**
 * LOCAL DEVELOPMENT SERVER — never deployed.
 *
 *   pnpm --filter @foundry/db db:reset     # once: local database + seed + a DEV owner access code
 *   pnpm --filter @foundry/api dev         # http://localhost:8787/api/v1
 *
 * Defaults: APP_ENV=development, DB_DRIVER=pg, DATABASE_URL = the db:reset database, MODEL_PROVIDER=mock.
 * Documents go to a local directory through presigned-style URLs served by this process
 * (PUT /api/v1/_local/uploads/:token), and jobs run in-process right after they are enqueued.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { serve } from '@hono/node-server';
import { MAX_DOCUMENT_BYTES } from '@foundry/contracts';
import { createCore } from '@foundry/core';
import { migrate } from '@foundry/db';

import { InlineJobQueue } from './adapters/inline-job-queue.js';
import { LocalObjectStore } from './adapters/local-object-store.js';
import { DocumentTextExtractor } from './adapters/text-extractor.js';
import { createApp } from './app.js';
import { loadApiConfig, loadCoreConfig } from './config.js';
import { errorFields } from './logging.js';
import { createDatabase, createGateway, createProcessLogger } from './runtime/common.js';
import { observeDatabase } from './runtime/db-observer.js';

/** The database `pnpm --filter @foundry/db db:reset` creates (owner role fa_master, unix socket cluster). */
export const DEFAULT_LOCAL_DATABASE_URL =
  'postgresql://fa_master:fa_master@localhost/foundry?host=/var/tmp&port=54329';

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
    maxUploadBytes: MAX_DOCUMENT_BYTES,
  });
  const jobQueue = new InlineJobQueue({ logger });
  const core = createCore({
    db,
    gateway: createGateway(env, logger),
    config: loadCoreConfig(env),
    objectStore,
    jobQueue,
    textExtractor: new DocumentTextExtractor(),
    logger: logger.child({ component: 'core' }),
  });
  jobQueue.attach(async (job, { attempt, maxAttempts, requestId }) => {
    const result = await core.ingestion.process(job, { requestId, attempt, maxAttempts });
    logger.info('dev.job_done', { requestId, type: job.type, status: result.status, chunks: result.chunks });
  });

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
