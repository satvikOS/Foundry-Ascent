import { randomUUID } from 'node:crypto';

import {
  type DistillService,
  type IngestionProcessor,
  JobMessage,
  type MaintenanceReport,
  RetryableDistillError,
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
 * jobs queue: ends ephemeral sessions idle for 24 h and erases their content, expires stale AI memory
 * proposals and runs the distillation backstop (core.maintenance.runDaily). The message carries no data;
 * every run is idempotent.
 */
export const MaintenanceJob = z.object({
  type: z.literal('maintenance'),
  task: z.literal('daily'),
  requestId: z.string().max(128).nullable().optional(),
});

/**
 * The distillation sweep, sent by the distillation schedule when it is enabled: the worker distils a bounded
 * batch of idle, undistilled conversations inline (core.distill.backstop). The worker never enqueues.
 */
export const DistillSweepJob = z.object({
  type: z.literal('distill_sweep'),
  requestId: z.string().max(128).nullable().optional(),
});

/** The exact bodies the schedules send (apps/api/lambda-contract.json, shared with infra/cdk). */
export { DAILY_MAINTENANCE_MESSAGE, DISTILL_SWEEP_MESSAGE } from '../lambda-contract.js';

/** Every message type the worker understands: core's jobs plus the scheduled and operator jobs. */
export const WorkerJob = z.union([JobMessage, BackfillEmbeddingsJob, MaintenanceJob, DistillSweepJob]);
export type WorkerJob = z.infer<typeof WorkerJob>;

export interface WorkerDeps {
  readonly ingestion: Pick<IngestionProcessor, 'process'>;
  readonly distill: Pick<DistillService, 'distillSession' | 'backstop'>;
  readonly backfill: (options: Omit<BackfillOptions, 'purpose'>) => Promise<BackfillReport>;
  readonly maintenance: (options: {
    readonly requestId: string;
    readonly deadline?: number;
  }) => Promise<MaintenanceReport>;
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
/** Time kept back from the Lambda deadline for acknowledging the batch. */
const DEADLINE_MARGIN_MS = 10_000;

/** `done`: acknowledged (also for jobs that can never succeed). `retry`: redelivered later. */
export type JobOutcome = 'done' | 'retry';

export interface DispatchContext {
  readonly requestId: string;
  /** Delivery attempt (SQS `ApproximateReceiveCount`, or the local queue's attempt). */
  readonly attempt: number;
  /** Epoch ms by which the job must be over. */
  readonly deadline: number;
  /** Logger carrying the job's correlation fields. */
  readonly log: Logger;
}

/**
 * Runs one job: the single dispatch for the Lambda worker and the local dev server's in-process queue, so
 * every job type behaves the same locally and in production. Transient failures (the model or the database
 * unavailable) return `retry`; everything else is `done`.
 */
export async function dispatchJob(
  deps: WorkerDeps,
  job: WorkerJob,
  ctx: DispatchContext,
): Promise<{ outcome: JobOutcome; ingested: boolean }> {
  const { requestId, log, deadline } = ctx;
  switch (job.type) {
    case 'maintenance':
      try {
        const report = await deps.maintenance({ requestId, deadline });
        log.info('worker.maintenance_done', {
          ephemeralSessionsEnded: report.ephemeralSessionsEnded,
          ephemeralTurnsRedacted: report.ephemeralTurnsRedacted,
          staleCallsEnded: report.staleCallsEnded,
          proposalsExpired: report.proposalsExpired,
          distillCandidates: report.distillation.candidates,
          distilled: report.distillation.distilled,
          distillFailed: report.distillation.failed,
          distillDeferred: report.distillation.deferred,
        });
        return { outcome: 'done', ingested: false };
      } catch (err) {
        // Retried by SQS (e.g. Aurora still resuming); the redrive policy bounds the attempts.
        log.warn('worker.maintenance_failed', errorFields(err));
        return { outcome: 'retry', ingested: false };
      }

    case 'distill_sweep':
      try {
        const report = await deps.distill.backstop({ requestId, deadline });
        log.info('worker.distill_sweep_done', { ...report });
        return { outcome: 'done', ingested: false };
      } catch (err) {
        log.warn('worker.distill_sweep_failed', errorFields(err));
        return { outcome: 'retry', ingested: false };
      }

    case 'distill_session':
      try {
        // `attempt` is the receive count, which also counts deliveries processSqsBatch deferred unstarted:
        // distillation counts the model's answers itself and uses it only to know the queue's last delivery.
        const result = await deps.distill.distillSession(
          {
            sessionId: job.sessionId,
            requestId,
            ...(job.turns === undefined ? {} : { queuedTurns: job.turns }),
          },
          { deadline, attempt: ctx.attempt, maxAttempts: deps.maxReceiveCount },
        );
        log.info('worker.distill_done', {
          sessionId: result.sessionId,
          status: result.status,
          reason: result.reason,
          turns: result.turns,
          notebookVersion: result.notebookVersion,
          memoryProposed: result.memoryProposed,
          memoryRepeated: result.memoryRepeated,
          lessonsDrafted: result.lessonsDrafted,
        });
        return { outcome: 'done', ingested: false };
      } catch (err) {
        log.warn('worker.distill_retry', {
          sessionId: job.sessionId,
          retryable: err instanceof RetryableDistillError,
          ...errorFields(err),
        });
        return { outcome: 'retry', ingested: false };
      }

    case 'backfill_embeddings':
      try {
        const report = await deps.backfill({ requestId, maxItems: job.maxItems ?? 1_000, deadline });
        log.info('worker.backfill_done', { ...report });
      } catch (err) {
        log.warn('worker.backfill_failed', errorFields(err));
      }
      return { outcome: 'done', ingested: false };

    case 'ingest_document':
    case 'ingest_knowledge_source':
      try {
        const result = await deps.ingestion.process(job, {
          requestId,
          attempt: ctx.attempt,
          maxAttempts: deps.maxReceiveCount,
        });
        log.info('worker.ingestion_done', {
          documentId: result.documentId,
          sourceId: result.sourceId ?? null,
          status: result.status,
          chunks: result.chunks,
          reason: result.reason,
        });
        return { outcome: 'done', ingested: result.status === 'ready' };
      } catch (err) {
        // RetryableIngestionError (transient) and anything unexpected (e.g. the database still resuming while
        // recording a failure) are retried; the redrive policy bounds the attempts.
        log.warn('worker.ingestion_retry', {
          retryable: err instanceof RetryableIngestionError,
          ...errorFields(err),
        });
        return { outcome: 'retry', ingested: false };
      }
  }
}

/** Parses a queue message body; null for malformed or unknown messages. */
export function parseJob(body: string): WorkerJob | null {
  let json: unknown;
  try {
    json = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  const parsed = WorkerJob.safeParse(json);
  return parsed.success ? parsed.data : null;
}

async function processRecord(
  deps: WorkerDeps,
  record: SQSRecord,
  job: WorkerJob | null,
  invocation: WorkerInvocation,
  now: () => number,
): Promise<{ outcome: JobOutcome | 'dropped'; ingested: boolean }> {
  const attempt = Math.max(1, Number.parseInt(record.attributes.ApproximateReceiveCount, 10) || 1);
  if (job === null) {
    // Malformed or unknown messages can never succeed: drop them (logged with ids only).
    deps.logger.warn('worker.invalid_message', { messageId: record.messageId, attempt });
    return { outcome: 'dropped', ingested: false };
  }
  const requestId = job.requestId ?? `sqs-${record.messageId}`;
  const log = deps.logger.child({ requestId, messageId: record.messageId, jobType: job.type, attempt });
  return dispatchJob(deps, job, {
    requestId,
    attempt,
    deadline: now() + Math.max(0, invocation.remainingMs() - DEADLINE_MARGIN_MS),
    log,
  });
}

/**
 * SQS batch handler logic: records run sequentially (the batch is small and Aurora is capped at 2 ACU), daily
 * maintenance first (it erases ended temporary chats, and must not be deferred behind distillations until its
 * receive count runs out); transient failures and records that cannot start within the remaining time are
 * returned as `batchItemFailures` (partial batch response), everything else is acknowledged.
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
  const parsed = event.Records.map((record) => ({ record, job: parseJob(record.body) }));
  const ordered = [
    ...parsed.filter((r) => r.job?.type === 'maintenance'),
    ...parsed.filter((r) => r.job?.type !== 'maintenance'),
  ];
  for (const { record, job } of ordered) {
    if (invocation.remainingMs() < MIN_RECORD_BUDGET_MS) {
      deps.logger.warn('worker.deferred', { batchId, messageId: record.messageId });
      failures.push({ itemIdentifier: record.messageId });
      continue;
    }
    const { outcome, ingested: ready } = await processRecord(deps, record, job, invocation, now);
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
