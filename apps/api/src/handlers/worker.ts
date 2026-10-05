/**
 * Jobs worker Lambda (SQS event source, batch size 5, ReportBatchItemFailures). Dependencies are built
 * once per container; each batch is processed by `processSqsBatch` and transient failures are returned
 * as `batchItemFailures` so SQS retries only those records (DLQ after maxReceiveCount).
 */
import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';

import { processSqsBatch } from '../jobs/worker.js';
import { createWorkerRuntime } from '../runtime/worker.js';

const deps = createWorkerRuntime(process.env);

export const handler = (event: SQSEvent, context: Context): Promise<SQSBatchResponse> =>
  processSqsBatch(deps, event, { remainingMs: () => context.getRemainingTimeInMillis() });
