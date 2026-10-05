import { createCore, type EnvLike } from '@foundry/core';

import { S3ObjectStore } from '../adapters/s3-object-store.js';
import { SqsJobQueue } from '../adapters/sqs-job-queue.js';
import { type ApiApp, createApp } from '../app.js';
import { type ApiConfig, loadApiConfig, loadCoreConfig, required } from '../config.js';
import { API_DB_RESUME_BUDGET_MS } from '../lambda-contract.js';
import { type Logger } from '../logging.js';
import { createDatabase, createGateway, createProcessLogger } from './common.js';
import { observeDatabase } from './db-observer.js';
import { InflightTracker } from './inflight.js';

export interface ApiRuntime {
  readonly app: ApiApp;
  readonly inflight: InflightTracker;
  readonly logger: Logger;
  readonly config: ApiConfig;
}

/**
 * Everything the API Lambda needs, built once per container (cold start): config, logger, Data API
 * database, model gateway, S3/SQS adapters, core and the Hono app. No network I/O happens here.
 */
export function createApiRuntime(env: EnvLike): ApiRuntime {
  const config = loadApiConfig(env, 'api');
  const logger = createProcessLogger(config, 'api');
  // A request waits at most API_DB_RESUME_BUDGET_MS (40 s) per call for Aurora to resume, then answers
  // 503 database_resuming + Retry-After: well inside the 60 s Lambda and CloudFront read timeouts.
  // Every call is observed, so the public /health can report the database state without a query.
  const { db, state: dbState } = observeDatabase(
    createDatabase(env, { defaultResumeBudgetMs: API_DB_RESUME_BUDGET_MS }),
  );
  const gateway = createGateway(env, logger);
  const inflight = new InflightTracker();
  const core = createCore({
    db,
    gateway,
    config: loadCoreConfig(env),
    objectStore: new S3ObjectStore({
      bucket: required(config.documentsBucket, 'DOCUMENTS_BUCKET'),
      region: config.awsRegion,
    }),
    jobQueue: new SqsJobQueue({
      queueUrl: required(config.jobsQueueUrl, 'JOBS_QUEUE_URL'),
      region: config.awsRegion,
    }),
    logger: logger.child({ component: 'core' }),
  });
  const app = createApp({
    core,
    db,
    dbState,
    logger,
    appEnv: config.appEnv,
    appVersion: config.appVersion,
    inflight,
  });
  return { app, inflight, logger, config };
}
