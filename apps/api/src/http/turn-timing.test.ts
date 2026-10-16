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
      promptMs: 10,
      modelStartMs: 400,
      modelFirstTokenMs: 650,
      firstDeltaMs: 1_200,
      firstSpeechMs: 1_201,
      generationMs: 2_601,
      structuredMs: 1_400,
      finishMs: 300,
      totalMs: 3_300,
      dbRoundTrips: 1,
      dbTransactions: 0,
      dbWaitMs: 20,
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
      dbRoundTrips: 0,
    });
  });
});
