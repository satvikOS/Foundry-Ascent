import { MockModelGateway } from '@foundry/ai';
import { describe, expect, it } from 'vitest';

import { observeGateway } from './observed-gateway.js';
import {
  currentRequestMetrics,
  recordDbCall,
  RequestMetrics,
  withRequestMetrics,
} from './request-metrics.js';

const statement = {
  kind: 'statement',
  roundTrips: 1,
  ms: 4,
  spanMs: null,
  statements: null,
  failed: false,
} as const;

describe('request metrics', () => {
  it('follow the request through awaits, timers and nested calls, and stay out of other requests', async () => {
    const a = new RequestMetrics();
    const b = new RequestMetrics();
    await Promise.all([
      withRequestMetrics(a, async () => {
        recordDbCall(statement);
        await new Promise((resolve) => setTimeout(resolve, 1));
        recordDbCall({ kind: 'transaction', roundTrips: 2, ms: 6, spanMs: 30, statements: 1, failed: false });
      }),
      withRequestMetrics(b, async () => {
        await Promise.resolve();
        recordDbCall(statement);
      }),
    ]);
    // Outside any request nothing is counted.
    recordDbCall(statement);
    expect(currentRequestMetrics()).toBeUndefined();
    expect(a.dbFields()).toEqual({ dbRoundTrips: 3, dbTransactions: 1, dbWaitMs: 10 });
    expect(a.lastTransaction?.spanMs).toBe(30);
    expect(b.dbFields()).toEqual({ dbRoundTrips: 1, dbTransactions: 0, dbWaitMs: 4 });
  });

  it('record the model calls of the request: embeddings, the first streamed text and structured calls', async () => {
    const gateway = observeGateway(new MockModelGateway({ streamDelayMs: 0 }));
    const metrics = new RequestMetrics();
    await withRequestMetrics(metrics, async () => {
      await gateway.embed(['a question'], { purpose: 'embedding', requestId: 'r1' });
      const chunks: string[] = [];
      await gateway.streamText(
        {
          purpose: 'turn',
          system: 'You are a coach.',
          messages: [{ role: 'user', content: 'Hello there. How are you?' }],
          requestId: 'r1',
        },
        (text) => {
          chunks.push(text);
        },
      );
      expect(chunks.length).toBeGreaterThan(0);
    });
    expect(metrics.embed.calls).toBe(1);
    expect(metrics.stream.calls).toBe(1);
    expect(metrics.stream.startedAt).not.toBeNull();
    expect(metrics.stream.firstTokenAt).toBeGreaterThanOrEqual(metrics.stream.startedAt ?? Infinity);
    expect(metrics.structured.calls).toBe(0);
    // Calls outside a request pass through untouched.
    await gateway.embed(['x'], { purpose: 'embedding' });
    expect(metrics.embed.calls).toBe(1);
  });
});
