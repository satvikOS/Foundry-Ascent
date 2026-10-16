import { type EnvLike } from '@foundry/core';

import { loadApiConfig } from '../config.js';
import { type InsightsDeps } from '../jobs/insights.js';
import { createDatabase, createProcessLogger } from './common.js';

/**
 * The insights function's dependencies, built once per container: the database (owner role, read-only
 * transactions) and the process logger. No model gateway, no object store, no queue.
 */
export function createInsightsRuntime(env: EnvLike): InsightsDeps {
  const config = loadApiConfig(env, 'insights');
  return { db: createDatabase(env), logger: createProcessLogger(config, 'insights') };
}
