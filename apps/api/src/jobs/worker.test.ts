import {
  type DistillBackstopReport,
  type DistillJobInput,
  type DistillOutcome,
  type DistillRunOptions,
  type IngestionResult,
  type MaintenanceReport,
  RetryableDistillError,
  RetryableIngestionError,
} from '@foundry/core';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import { createJsonLogger } from '../logging.js';
import { type BackfillReport } from './embedding-backfill.js';
import {
  DAILY_MAINTENANCE_MESSAGE,
  DISTILL_SWEEP_MESSAGE,
  dispatchJob,
  parseJob,
  processSqsBatch,
  type WorkerDeps,
} from './worker.js';

const job = (documentId: string) =>
  JSON.stringify({
    type: 'ingest_document',
    documentId,
    tenantId: '11111111-1111-4111-8111-111111111111',
    ventureId: '22222222-2222-4222-8222-222222222222',
    requestId: 'req-1',
  });

function record(messageId: string, body: string, receiveCount = 1): SQSRecord {
  return {
    messageId,
    receiptHandle: 'r',
    body,
    attributes: {
      ApproximateReceiveCount: String(receiveCount),
      SentTimestamp: '0',
      SenderId: 's',
      ApproximateFirstReceiveTimestamp: '0',
    },
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:FoundryAscent-Jobs',
    awsRegion: 'us-east-1',
  };
}

const DOC_OK = '33333333-3333-4333-8333-000000000001';
const DOC_RETRY = '33333333-3333-4333-8333-000000000002';
const DOC_CRASH = '33333333-3333-4333-8333-000000000003';

function deps(lines: string[] = []) {
  const backfillReport: BackfillReport = { chunks: 3, memory: 1, remaining: false, stoppedBy: 'done' };
  const process = vi.fn(
    (raw: unknown, options: { attempt?: number; maxAttempts?: number }): Promise<IngestionResult> => {
      const documentId = (raw as { documentId: string }).documentId;
      if (documentId === DOC_RETRY) return Promise.reject(new RetryableIngestionError('transient'));
      if (documentId === DOC_CRASH) return Promise.reject(new Error('database still resuming'));
      return Promise.resolve({
        status: 'ready',
        documentId,
        chunks: 4,
        reason: options.attempt === 3 ? 'last' : null,
      });
    },
  );
  const backfill = vi.fn(() => Promise.resolve(backfillReport));
  const sweep: DistillBackstopReport = {
    candidates: 2,
    distilled: 1,
    skipped: 1,
    dropped: 0,
    failed: 0,
    deferred: 0,
  };
  const maintenance = vi.fn(
    (_options: { readonly requestId: string; readonly deadline?: number }): Promise<MaintenanceReport> =>
      Promise.resolve({
        ephemeralSessionsEnded: 1,
        ephemeralTurnsRedacted: 2,
        staleCallsEnded: 1,
        proposalsExpired: 3,
        staleUploadsFailed: 1,
        distillation: sweep,
      }),
  );
  const distillSession = vi.fn(
    (job: DistillJobInput, _options?: DistillRunOptions): Promise<DistillOutcome> =>
      job.sessionId === SESSION_RETRY
        ? Promise.reject(new RetryableDistillError('model_unavailable'))
        : Promise.resolve({
            sessionId: job.sessionId,
            status: 'distilled',
            reason: null,
            turns: 4,
            notebookVersion: 2,
            memoryProposed: 1,
            memoryRepeated: 0,
            lessonsDrafted: 1,
          }),
  );
  const backstop = vi.fn(
    (_options: { readonly requestId: string; readonly deadline?: number }): Promise<DistillBackstopReport> =>
      Promise.resolve(sweep),
  );
  const value: WorkerDeps = {
    ingestion: { process },
    distill: { distillSession, backstop },
    backfill,
    maintenance,
    logger: createJsonLogger({ level: 'debug', write: (l) => lines.push(l) }),
    maxReceiveCount: 3,
    now: () => NOW,
  };
  return { value, process, backfill, maintenance, distillSession, backstop };
}

const NOW = Date.parse('2026-10-16T12:00:00Z');
const SESSION_OK = '55555555-5555-4555-8555-000000000001';
const SESSION_RETRY = '55555555-5555-4555-8555-000000000002';
const distillJob = (sessionId: string, turns?: number) =>
  JSON.stringify({
    type: 'distill_session',
    sessionId,
    tenantId: '11111111-1111-4111-8111-111111111111',
    ventureId: '22222222-2222-4222-8222-222222222222',
    ...(turns === undefined ? {} : { turns }),
    requestId: null,
  });

describe('processSqsBatch', () => {
  it('reports only transient failures as batch item failures and passes SQS attempt counts', async () => {
    const lines: string[] = [];
    const { value, process, backfill } = deps(lines);
    const event: SQSEvent = {
      Records: [
        record('ok', job(DOC_OK), 3),
        record('retry', job(DOC_RETRY)),
        record('crash', job(DOC_CRASH)),
        record('garbage', '{"type":"ingest_document"}'),
        record('not-json', '<xml/>'),
      ],
    };
    const result = await processSqsBatch(value, event, { remainingMs: () => 100_000 });
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'retry' }, { itemIdentifier: 'crash' }]);
    expect(process).toHaveBeenCalledTimes(3);
    expect(process.mock.calls[0]?.[1]).toMatchObject({ attempt: 3, maxAttempts: 3, requestId: 'req-1' });
    // One successful ingestion → one bounded opportunistic backfill.
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(backfill.mock.calls[0]).toEqual([expect.objectContaining({ maxItems: 64 })]);
    expect(lines.join('\n')).toContain('worker.invalid_message');
  });

  it('defers records that cannot start in the remaining time', async () => {
    const { value, process } = deps();
    const result = await processSqsBatch(
      value,
      { Records: [record('a', job(DOC_OK)), record('b', job(DOC_OK))] },
      {
        remainingMs: () => 10_000,
      },
    );
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'a' }, { itemIdentifier: 'b' }]);
    expect(process).not.toHaveBeenCalled();
  });

  it('runs daily maintenance first, so distillations never push it past its receive count', async () => {
    const { value, maintenance, distillSession } = deps();
    let remaining = 60_000;
    distillSession.mockImplementation((j: DistillJobInput) => {
      remaining = 20_000; // the first record used up the invocation
      return Promise.resolve({
        sessionId: j.sessionId,
        status: 'distilled',
        reason: null,
        turns: 1,
        notebookVersion: 1,
        memoryProposed: 0,
        memoryRepeated: 0,
        lessonsDrafted: 0,
      });
    });
    const result = await processSqsBatch(
      value,
      {
        Records: [
          record('d1', distillJob(SESSION_OK)),
          record('d2', distillJob(SESSION_OK)),
          record('m1', JSON.stringify(DAILY_MAINTENANCE_MESSAGE)),
        ],
      },
      { remainingMs: () => remaining },
    );
    expect(maintenance).toHaveBeenCalledTimes(1);
    expect(distillSession).toHaveBeenCalledTimes(1);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'd2' }]);
  });

  it('runs backfill jobs within the invocation budget and never retries them', async () => {
    const { value, backfill } = deps();
    backfill.mockRejectedValueOnce(new Error('bedrock throttled'));
    const result = await processSqsBatch(
      value,
      { Records: [record('b1', JSON.stringify({ type: 'backfill_embeddings', maxItems: 50 }))] },
      { remainingMs: () => 60_000 },
    );
    expect(result.batchItemFailures).toEqual([]);
    expect(backfill.mock.calls[0]).toEqual([expect.objectContaining({ maxItems: 50, requestId: 'sqs-b1' })]);
  });
});

describe('daily maintenance message (EventBridge schedule → jobs queue)', () => {
  it('runs core maintenance for the scheduled message and retries it when it fails', async () => {
    const lines: string[] = [];
    const { value, maintenance, process } = deps(lines);
    const body = JSON.stringify(DAILY_MAINTENANCE_MESSAGE);
    const ok = await processSqsBatch(value, { Records: [record('m1', body)] }, { remainingMs: () => 60_000 });
    expect(ok.batchItemFailures).toEqual([]);
    // The deadline leaves a margin before the Lambda timeout for the distillation backstop.
    expect(maintenance).toHaveBeenCalledWith({ requestId: 'sqs-m1', deadline: NOW + 50_000 });
    expect(process).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('worker.maintenance_done');
    expect(lines.find((line) => line.includes('worker.maintenance_done'))).toContain('staleUploadsFailed');

    maintenance.mockRejectedValueOnce(new Error('database still resuming'));
    const failed = await processSqsBatch(
      value,
      { Records: [record('m2', body)] },
      { remainingMs: () => 60_000 },
    );
    expect(failed.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }]);
  });

  it('comes back while the backstop leaves conversations for lack of time, until the queue’s last receive', async () => {
    const lines: string[] = [];
    const { value, maintenance } = deps(lines);
    const left = (): Promise<MaintenanceReport> =>
      Promise.resolve({
        ephemeralSessionsEnded: 0,
        ephemeralTurnsRedacted: 0,
        staleCallsEnded: 0,
        proposalsExpired: 0,
        staleUploadsFailed: 0,
        distillation: { candidates: 50, distilled: 12, skipped: 0, dropped: 0, failed: 0, deferred: 38 },
      });
    maintenance.mockImplementation(left);
    const body = JSON.stringify(DAILY_MAINTENANCE_MESSAGE);
    for (const receive of [1, 2]) {
      const again = await processSqsBatch(
        value,
        { Records: [record(`m${receive}`, body, receive)] },
        { remainingMs: () => 60_000 },
      );
      expect(again.batchItemFailures).toEqual([{ itemIdentifier: `m${receive}` }]);
    }
    expect(lines.join('\n')).toContain('worker.maintenance_continues');
    // The last receive is acknowledged: a backlog never sends the message to the dead-letter queue.
    const last = await processSqsBatch(
      value,
      { Records: [record('m3', body, 3)] },
      { remainingMs: () => 60_000 },
    );
    expect(last.batchItemFailures).toEqual([]);
    expect(maintenance).toHaveBeenCalledTimes(3);
  });

  it('drops maintenance messages it does not understand', async () => {
    const { value, maintenance } = deps();
    const result = await processSqsBatch(
      value,
      { Records: [record('m3', JSON.stringify({ type: 'maintenance', task: 'drop_tables' }))] },
      { remainingMs: () => 60_000 },
    );
    expect(result.batchItemFailures).toEqual([]);
    expect(maintenance).not.toHaveBeenCalled();
  });
});

describe('distillation jobs', () => {
  it('distils a queued conversation with the invocation deadline and retries transient failures', async () => {
    const lines: string[] = [];
    const { value, distillSession, process } = deps(lines);
    const result = await processSqsBatch(
      value,
      { Records: [record('d1', distillJob(SESSION_OK, 4)), record('d2', distillJob(SESSION_RETRY), 2)] },
      { remainingMs: () => 100_000 },
    );
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'd2' }]);
    // The turn count it was queued at (a later turn's job supersedes it) and the delivery attempt.
    expect(distillSession).toHaveBeenNthCalledWith(
      1,
      { sessionId: SESSION_OK, requestId: 'sqs-d1', queuedTurns: 4 },
      { deadline: NOW + 90_000, attempt: 1, maxAttempts: 3 },
    );
    expect(distillSession).toHaveBeenNthCalledWith(
      2,
      { sessionId: SESSION_RETRY, requestId: 'sqs-d2' },
      { deadline: NOW + 90_000, attempt: 2, maxAttempts: 3 },
    );
    expect(process).not.toHaveBeenCalled();
    const done = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.event === 'worker.distill_done');
    expect(done).toMatchObject({
      sessionId: SESSION_OK,
      status: 'distilled',
      memoryProposed: 1,
      lessonsDrafted: 1,
    });
    expect(lines.join('\n')).toContain('worker.distill_retry');
  });

  it('runs the sweep message inline (bounded backstop) and retries it when it fails', async () => {
    const lines: string[] = [];
    const { value, backstop } = deps(lines);
    expect(DISTILL_SWEEP_MESSAGE).toEqual({ type: 'distill_sweep' });
    const body = JSON.stringify(DISTILL_SWEEP_MESSAGE);
    const ok = await processSqsBatch(value, { Records: [record('s1', body)] }, { remainingMs: () => 60_000 });
    expect(ok.batchItemFailures).toEqual([]);
    expect(backstop).toHaveBeenCalledWith({ requestId: 'sqs-s1', deadline: NOW + 50_000 });
    expect(lines.join('\n')).toContain('worker.distill_sweep_done');

    backstop.mockRejectedValueOnce(new Error('database still resuming'));
    const failed = await processSqsBatch(
      value,
      { Records: [record('s2', body)] },
      { remainingMs: () => 60_000 },
    );
    expect(failed.batchItemFailures).toEqual([{ itemIdentifier: 's2' }]);
  });

  it('drops distillation messages without a valid session id', async () => {
    const { value, distillSession } = deps();
    const result = await processSqsBatch(
      value,
      { Records: [record('d3', JSON.stringify({ type: 'distill_session', sessionId: 'abc' }))] },
      { remainingMs: () => 60_000 },
    );
    expect(result.batchItemFailures).toEqual([]);
    expect(distillSession).not.toHaveBeenCalled();
  });
});

describe('dispatchJob (shared by the worker and the local dev server)', () => {
  it('handles every job type the worker parses', async () => {
    const { value, process, distillSession, backstop, maintenance, backfill } = deps();
    const ctx = { requestId: 'r', attempt: 1, deadline: NOW + 60_000, log: value.logger };
    const bodies = [job(DOC_OK), distillJob(SESSION_OK), JSON.stringify(DISTILL_SWEEP_MESSAGE)];
    bodies.push(JSON.stringify(DAILY_MAINTENANCE_MESSAGE), JSON.stringify({ type: 'backfill_embeddings' }));
    bodies.push(
      JSON.stringify({
        type: 'ingest_knowledge_source',
        sourceId: DOC_OK,
        tenantId: '11111111-1111-4111-8111-111111111111',
        personaId: '22222222-2222-4222-8222-222222222222',
        requestId: null,
      }),
    );
    for (const body of bodies) {
      const parsed = parseJob(body);
      expect(parsed, body).not.toBeNull();
      if (parsed) expect((await dispatchJob(value, parsed, ctx)).outcome).toBe('done');
    }
    expect(process).toHaveBeenCalledTimes(2);
    expect(distillSession).toHaveBeenCalledTimes(1);
    expect(backstop).toHaveBeenCalledTimes(1);
    expect(maintenance).toHaveBeenCalledTimes(1);
    expect(backfill).toHaveBeenCalledTimes(1);
  });
});
