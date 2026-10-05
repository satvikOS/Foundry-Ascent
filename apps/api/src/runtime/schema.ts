import { type EnvLike } from '@foundry/core';
import { seedConfigFromEnv } from '@foundry/db';

import { loadApiConfig } from '../config.js';
import { backfillEmbeddings } from '../jobs/embedding-backfill.js';
import { type SchemaResourceDeps } from '../jobs/schema-resource.js';
import { createDatabase, createGateway, createProcessLogger } from './common.js';

/**
 * The migrations custom resource's dependencies, built once per container. The seed configuration (deploy
 * owner's access-code prefix and hash, home tenant) is validated here, so a misconfigured deploy fails at
 * init instead of half-way through.
 */
export function createSchemaRuntime(env: EnvLike): SchemaResourceDeps {
  const config = loadApiConfig(env, 'migrate');
  const logger = createProcessLogger(config, 'migrate');
  const db = createDatabase(env);
  const gateway = createGateway(env, logger);
  return {
    db,
    seedConfig: seedConfigFromEnv(env),
    backfill: (options) => backfillEmbeddings({ db, gateway, logger }, { ...options, purpose: 'seed' }),
    logger,
  };
}
