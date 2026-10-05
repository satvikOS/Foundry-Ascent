import { createCore, type EnvLike } from '@foundry/core';

import { S3ObjectStore } from '../adapters/s3-object-store.js';
import { DocumentTextExtractor } from '../adapters/text-extractor.js';
import { unavailableJobQueue } from '../adapters/unavailable-ports.js';
import { loadApiConfig, loadCoreConfig, required } from '../config.js';
import { backfillEmbeddings } from '../jobs/embedding-backfill.js';
import { type WorkerDeps } from '../jobs/worker.js';
import { createDatabase, createGateway, createProcessLogger } from './common.js';

/**
 * The jobs worker's dependencies, built once per container: core's ingestion processor over S3 + the
 * text extractor, and the embedding backfill. The worker never enqueues (no SQS send permission).
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
  return {
    ingestion: core.ingestion,
    backfill: (options) => backfillEmbeddings({ db, gateway, logger }, { ...options, purpose: 'embedding' }),
    maintenance: (options) => core.maintenance.runDaily(options),
    logger,
    maxReceiveCount: config.jobsMaxReceiveCount,
  };
}
