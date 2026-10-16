import { type ModelGateway } from '@foundry/ai';
import { type Core, createCore, type EnvLike } from '@foundry/core';
import { type Db } from '@foundry/db';

import { S3ObjectStore } from '../adapters/s3-object-store.js';
import { DocumentTextExtractor } from '../adapters/text-extractor.js';
import { unavailableJobQueue } from '../adapters/unavailable-ports.js';
import { loadApiConfig, loadCoreConfig, required } from '../config.js';
import { backfillEmbeddings } from '../jobs/embedding-backfill.js';
import { type WorkerDeps } from '../jobs/worker.js';
import { type Logger } from '../logging.js';
import { createDatabase, createGateway, createProcessLogger } from './common.js';

/**
 * What the job dispatch needs from core (ingestion, distillation, daily maintenance) plus the embedding
 * backfill. The Lambda worker and the local dev server's in-process queue both build it here, so they handle
 * every job type the same way.
 */
export function workerDepsFor(
  core: Pick<Core, 'ingestion' | 'distill' | 'maintenance'>,
  args: {
    readonly db: Db;
    readonly gateway: ModelGateway;
    readonly logger: Logger;
    readonly maxReceiveCount: number;
  },
): WorkerDeps {
  const { db, gateway, logger } = args;
  return {
    ingestion: core.ingestion,
    distill: core.distill,
    backfill: (options) => backfillEmbeddings({ db, gateway, logger }, { ...options, purpose: 'embedding' }),
    maintenance: (options) => core.maintenance.runDaily(options),
    logger,
    maxReceiveCount: args.maxReceiveCount,
  };
}

/**
 * The jobs worker's dependencies, built once per container: core over S3 + the text extractor, and the
 * embedding backfill. The worker never enqueues (no SQS send permission): the distillation backstop distils
 * inline.
 */
export function createWorkerRuntime(env: EnvLike): WorkerDeps {
  const config = loadApiConfig(env, 'worker');
  const logger = createProcessLogger(config, 'worker');
  const db = createDatabase(env);
  const gateway = createGateway(env, logger);
  const core = createCore({
    db,
    gateway,
    config: loadCoreConfig(env),
    objectStore: new S3ObjectStore({
      bucket: required(config.documentsBucket, 'DOCUMENTS_BUCKET'),
      region: config.awsRegion,
    }),
    jobQueue: unavailableJobQueue,
    textExtractor: new DocumentTextExtractor(),
    logger: logger.child({ component: 'core' }),
  });
  return workerDepsFor(core, { db, gateway, logger, maxReceiveCount: config.jobsMaxReceiveCount });
}
