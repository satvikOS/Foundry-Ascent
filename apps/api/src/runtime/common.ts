import { createModelGateway, type ModelGateway, modelGatewayConfigFromEnv } from '@foundry/ai';
import { type EnvLike } from '@foundry/core';
import { createDbFromEnv, type Db } from '@foundry/db';

import { type ApiConfig } from '../config.js';
import { createJsonLogger, type Logger } from '../logging.js';

export type ProcessName = 'api' | 'worker' | 'migrate' | 'dev';

/** Root logger of a process: JSON lines tagged with service, process and version. */
export function createProcessLogger(config: ApiConfig, process: ProcessName): Logger {
  return createJsonLogger({
    level: config.logLevel,
    base: { service: 'foundry-ascent', process, version: config.appVersion, env: config.appEnv },
  });
}

/**
 * Database facade from the runtime contract (DB_DRIVER=dataapi|pg). No I/O until first use.
 * `defaultResumeBudgetMs` applies when DB_RESUME_BUDGET_MS is unset (the API passes its contract budget).
 */
export function createDatabase(env: EnvLike, options: { readonly defaultResumeBudgetMs?: number } = {}): Db {
  const budget = env.DB_RESUME_BUDGET_MS?.trim();
  if ((budget === undefined || budget === '') && options.defaultResumeBudgetMs !== undefined) {
    return createDbFromEnv({ ...env, DB_RESUME_BUDGET_MS: String(options.defaultResumeBudgetMs) });
  }
  return createDbFromEnv(env);
}

/**
 * Model gateway selection (MODEL_PROVIDER=bedrock|mock; mock by default outside production, required in
 * production). No network I/O at construction.
 */
export function createGateway(env: EnvLike, logger: Logger): ModelGateway {
  return createModelGateway(modelGatewayConfigFromEnv(env, { logger: logger.child({ component: 'ai' }) }));
}
