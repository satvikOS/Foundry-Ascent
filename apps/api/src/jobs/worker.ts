import { randomUUID } from 'node:crypto';

import {
  type IngestionProcessor,
  JobMessage,
  type MaintenanceReport,
  RetryableIngestionError,
} from '@foundry/core';
import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { z } from 'zod';

import { errorFields, type Logger } from '../logging.js';
import { type BackfillOptions, type BackfillReport } from './embedding-backfill.js';

/**
 * Worker-only job: embed chunks/memory still missing vectors. Enqueued by operators (or future
 * schedulers); the worker also runs a small pass after ingestion batches.
 */
export const BackfillEmbeddingsJob = z.object({
  type: z.literal('backfill_embeddings'),
  requestId: z.string().max(128).nullable().optional(),
  maxItems: z.number().int().min(1).max(5_000).optional(),
});

/**
 * Daily maintenance, sent by the FoundryAscent-App EventBridge schedule (one rule, `rate(1 day)`) to the
 * jobs queue: ends ephemeral sessions idle for 24 h and erases their content (core.maintenance.runDaily).
 * The message carries no data; every run is idempotent.
 */
export const MaintenanceJob = z.object({
  type: z.literal('maintenance'),
  task: z.literal('daily'),
  requestId: z.string().max(128).nullable().optional(),
});
/** The exact body the daily schedule sends (apps/api/lambda-contract.json, shared with infra/cdk). */
export { DAILY_MAINTENANCE_MESSAGE } from '../lambda-contract.js';

/** Every message type the worker understands: core's jobs plus worker maintenance jobs. */
export const WorkerJob = z.union([JobMessage, BackfillEmbeddingsJob, MaintenanceJob]);
export type WorkerJob = z.infer<typeof WorkerJob>;

export interface WorkerDeps {
  readonly ingestion: Pick<IngestionProcessor, 'process'>;
  readonly backfill: (options: Omit<BackfillOptions, 'purpose'>) => Promise<BackfillReport>;
  readonly maintenance: (options: { readonly requestId: string }) => Promise<MaintenanceReport>;
  readonly logger: Logger;
  /** The jobs queue's redrive maxReceiveCount: the last receive marks a document failed. */
  readonly maxReceiveCount: number;
  readonly now?: () => number;
}

export interface WorkerInvocation {
  /** Lambda `context.getRemainingTimeInMillis`. */
  readonly remainingMs: () => number;
}

/** A record is only started with at least this much time left; otherwise it is retried later. */
export const MIN_RECORD_BUDGET_MS = 30_000;
/** Opportunistic backfill after an ingestion batch: bounded so it never delays the next batch much. */
const AFTER_BATCH_BACKFILL_ITEMS = 64;
const AFTER_BATCH_BACKFILL_MIN_MS = 20_000;

type RecordOutcome = 'done' | 'retry' | 'dropped';

function parseBody(record: SQSRecord): WorkerJob | null {
  let json: unknown;
  try {
    json = JSON.parse(record.body) as unknown;
  } catch {
    return null;
  }
  const parsed = WorkerJob.safeParse(json);
  return parsed.success ? parsed.data : null;
}

async function processRecord(
  deps: WorkerDeps,
  record: SQSRecord,
  invocation: WorkerInvocation,
  now: () => number,
): Promise<{ outcome: RecordOutcome; ingested: boolean }> {
  const job = parseBody(record);
  const attempt = Math.max(1, Number.parseInt(record.attributes.ApproximateReceiveCount, 10) || 1);
  if (job === null) {
    // Malformed or unknown messages can never succeed: drop them (logged with ids only).
    deps.logger.warn('worker.invalid_message', { messageId: record.messageId, attempt });
    return { outcome: 'dropped', ingested: false };
  }
  const requestId = job.requestId ?? `sqs-${record.messageId}`;
  const log = deps.logger.child({ requestId, messageId: record.messageId, jobType: job.type, attempt });

  if (job.type === 'maintenance') {
    try {
      const report = await deps.maintenance({ requestId });
      log.info('worker.maintenance_done', { ...report });
      return { outcome: 'done', ingested: false };
    } catch (err) {
      // Retried by SQS (e.g. Aurora still resuming); the redrive policy bounds the attempts.
      log.warn('worker.maintenance_failed', errorFields(err));
      return { outcome: 'retry', ingested: false };
    }
  }

  if (job.type === 'backfill_embeddings') {
    try {
      const report = await deps.backfill({
        requestId,
        maxItems: job.maxItems ?? 1_000,
        deadline: now() + Math.max(0, invocation.remainingMs() - 10_000),
      });
      log.info('worker.backfill_done', { ...report });
    } catch (err) {
      log.warn('worker.backfill_failed', errorFields(err));
    }
    return { outcome: 'done', ingested: false };
  }

  try {
    const result = await deps.ingestion.process(job, {
      requestId,
      attempt,
      maxAttempts: deps.maxReceiveCount,
    });
    log.info('worker.ingestion_done', {
      documentId: result.documentId,
      status: result.status,
      chunks: result.chunks,
      reason: result.reason,
    });
    return { outcome: 'done', ingested: result.status === 'ready' };
  } catch (err) {
    // RetryableIngestionError (transient) and anything unexpected (e.g. the database still resuming while
    // recording a failure) are retried by SQS; the redrive policy bounds the attempts.
    log.warn('worker.ingestion_retry', {
      retryable: err instanceof RetryableIngestionError,
      ...errorFields(err),
    });
    return { outcome: 'retry', ingested: false };
  }
}

/**
 * SQS batch handler logic: records run sequentially (the batch is small and Aurora is capped at 2 ACU);
 * transient failures and records that cannot start within the remaining time are returned as
 * `batchItemFailures` (partial batch response), everything else is acknowledged.
 */
export async function processSqsBatch(
  deps: WorkerDeps,
  event: SQSEvent,
  invocation: WorkerInvocation,
): Promise<SQSBatchResponse> {
  const now = deps.now ?? Date.now;
  const batchId = randomUUID();
  const failures: SQSBatchItemFailure[] = [];
  let ingested = 0;
  for (const record of event.Records) {
    if (invocation.remainingMs() < MIN_RECORD_BUDGET_MS) {
      deps.logger.warn('worker.deferred', { batchId, messageId: record.messageId });
      failures.push({ itemIdentifier: record.messageId });
      continue;
    }
    const { outcome, ingested: ready } = await processRecord(deps, record, invocation, now);
    if (outcome === 'retry') failures.push({ itemIdentifier: record.messageId });
    if (ready) ingested += 1;
  }
  if (ingested > 0 && invocation.remainingMs() > AFTER_BATCH_BACKFILL_MIN_MS + 5_000) {
    try {
      const report = await deps.backfill({
        requestId: `backfill-${batchId}`,
        maxItems: AFTER_BATCH_BACKFILL_ITEMS,
        deadline: now() + AFTER_BATCH_BACKFILL_MIN_MS,
      });
      if (report.chunks + report.memory > 0) deps.logger.info('worker.backfill_done', { batchId, ...report });
    } catch (err) {
      deps.logger.warn('worker.backfill_failed', { batchId, ...errorFields(err) });
    }
  }
  deps.logger.info('worker.batch_done', {
    batchId,
    records: event.Records.length,
    failures: failures.length,
    ingested,
  });
  return { batchItemFailures: failures };
}
