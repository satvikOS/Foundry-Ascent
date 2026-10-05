/**
 * Migrations custom resource (`onEvent` of the CDK Provider framework): Create/Update run migrations,
 * the idempotent synthetic seed (deploy owner from OWNER_ACCESS_CODE_PREFIX/HASH) and a bounded seed
 * embedding backfill; Delete is a no-op. The physical id is always `foundry-ascent-schema`.
 */
import type { CdkCustomResourceEvent, Context } from 'aws-lambda';

import { handleSchemaEvent, type SchemaResponse } from '../jobs/schema-resource.js';
import { createSchemaRuntime } from '../runtime/schema.js';

const deps = createSchemaRuntime(process.env);

export const handler = (event: CdkCustomResourceEvent, context: Context): Promise<SchemaResponse> =>
  handleSchemaEvent(deps, event, {
    requestId: context.awsRequestId,
    remainingMs: () => context.getRemainingTimeInMillis(),
  });
