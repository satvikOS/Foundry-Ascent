import { type TurnStreamEvent } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { RequestMetrics } from '../runtime/request-metrics.js';
import { TurnTimeline } from './turn-timing.js';

const TURN = '11111111-1111-4111-8111-111111111111';

function status(
  phase: 'classifying' | 'retrieving' | 'reasoning' | 'validating',
  evidenceCount: number | null,
) {
  return { event: 'turn.status', phase, detail: null, evidenceCount } as const satisfies TurnStreamEvent;
}

describe('TurnTimeline', () => {
  it('reads each stage from the events and the request metrics, in request-relative milliseconds', () => {
    const metrics = new RequestMetrics(1_000);
    metrics.authMs = 3.4;
    // The admission transaction ends just before the turn is accepted.
    metrics.lastTransaction = { endedAt: 118, spanMs: 61.6 };
    metrics.recordDb({
      kind: 'statement',
      roundTrips: 1,
      ms: 20,
      spanMs: null,
      statements: null,
      failed: false,
    });
    metrics.embed = { calls: 1, ms: 91.2 };
    metrics.stream = { startedAt: 400, firstTokenAt: 1_050, calls: 1 };
    metrics.structured = { calls: 1, ms: 1_400 };
    // The streamed reply read most of its prompt from Bedrock's prompt cache; its fields call read some too.
    metrics.recordModelUsage(
      [{ inputTokens: 7_900, outputTokens: 40, cacheReadInputTokens: 6_000, cacheWriteInputTokens: 1_000 }],
      true,
    );
    metrics.recordModelUsage([{ inputTokens: 8_200, outputTokens: 90, cacheReadInputTokens: 7_000 }]);
    const timeline = new TurnTimeline(metrics);
    const at = (ms: number) => 1_000 + ms;

    timeline.observe({ event: 'turn.accepted', turnId: TURN, ordinal: 1 }, at(120));
    timeline.observe(status('classifying', null), at(121));
    timeline.observe(status('retrieving', null), at(122));
    // A late lexical-only second report never moves the stage.
    timeline.observe(status('retrieving', 7), at(390));
    timeline.observe(status('retrieving', 7), at(395));
    timeline.observe(status('reasoning', 7), at(399));
    timeline.observe({ event: 'turn.delta', turnId: TURN, seq: 0, text: 'One.' }, at(1_200));
    timeline.observe({ event: 'turn.delta', turnId: TURN, seq: 1, text: ' Two.' }, at(1_250));
    timeline.observe(
      { event: 'turn.speech', turnId: TURN, seq: 0, text: 'One.', sig: 'x'.repeat(20), final: false },
      at(1_201),
    );
    timeline.observe(status('validating', 7), at(3_000));
    timeline.observe(
      { event: 'turn.error', turnId: TURN, code: 'internal', message: 'x', retryable: true, requestId: 'r' },
      at(3_300),
    );
    // Events after the end change nothing.
    timeline.observe(
      { event: 'turn.error', turnId: TURN, code: 'internal', message: 'x', retryable: true, requestId: 'r' },
      at(3_900),
    );

    expect(timeline.fields()).toEqual({
      voice: true,
      authMs: 3,
      acceptedMs: 120,
      admissionMs: 62,
      retrievalMs: 268,
      embedMs: 91,
      embedCalls: 1,
      promptMs: 10,
      modelStartMs: 400,
      modelFirstTokenMs: 650,
      firstDeltaMs: 1_200,
      firstSpeechMs: 1_201,
      generationMs: 2_601,
      structuredMs: 1_400,
      finishMs: 300,
      totalMs: 3_300,
      inputTokens: 16_100,
      cacheReadInputTokens: 13_000,
      cacheWriteInputTokens: 1_000,
      streamInputTokens: 7_900,
      streamCacheReadInputTokens: 6_000,
      dbRoundTrips: 1,
      dbTransactions: 0,
      dbWaitMs: 20,
      inflightAtStart: 0,
      inflightMax: 0,
      awsConnectionsOpened: 0,
      awsConnectionsReused: 0,
    });
  });

  it('leaves the stages a turn never reached empty (a refused or replayed turn)', () => {
    const timeline = new TurnTimeline(new RequestMetrics(0));
    timeline.observe({ event: 'turn.accepted', turnId: TURN, ordinal: 2 }, 50);
    timeline.observe(
      {
        event: 'turn.blocked',
        turnId: TURN,
        reason: 'crisis_support',
        escalationId: null,
        supportMessage: null,
      },
      80,
    );
    expect(timeline.fields()).toMatchObject({
      voice: false,
      authMs: null,
      acceptedMs: 50,
      admissionMs: null,
      retrievalMs: null,
      embedMs: null,
      modelStartMs: null,
      modelFirstTokenMs: null,
      firstDeltaMs: null,
      firstSpeechMs: null,
      totalMs: 80,
      inputTokens: 0,
      cacheReadInputTokens: 0,
      streamInputTokens: null,
      streamCacheReadInputTokens: null,
      dbRoundTrips: 0,
    });
  });
});
