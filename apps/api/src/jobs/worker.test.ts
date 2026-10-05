import { type IngestionResult, RetryableIngestionError } from '@foundry/core';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import { createJsonLogger } from '../logging.js';
import { type BackfillReport } from './embedding-backfill.js';
import { processSqsBatch, type WorkerDeps } from './worker.js';

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
  const value: WorkerDeps = {
    ingestion: { process },
    backfill,
    logger: createJsonLogger({ level: 'debug', write: (l) => lines.push(l) }),
    maxReceiveCount: 3,
  };
  return { value, process, backfill };
}

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
