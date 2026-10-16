import { describe, expect, it } from 'vitest';

import { distillState, groupName, renderLogs, renderReport, sanitizeLogEvent } from './insights-render.js';
import { InsightsReport, InsightsResponse, reportCode } from './insights.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const VENTURE = '22222222-2222-4222-8222-222222222222';
const PERSONA = '33333333-3333-4333-8333-333333333333';
const TENANT = '44444444-4444-4444-8444-444444444444';
const CALL = '55555555-5555-4555-8555-555555555555';
const TURN = '66666666-6666-4666-8666-666666666666';

type Conversation = InsightsReport['conversations'][number];

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: SESSION,
    tenantId: TENANT,
    ventureId: VENTURE,
    personaId: PERSONA,
    privacy: 'standard',
    status: 'active',
    channel: 'voice',
    startedAt: '2026-10-15T10:00:00.000Z',
    endedAt: null,
    lastActivityAt: '2026-10-15T10:12:00.000Z',
    deleted: false,
    turns: { completed: 6, blocked: 0, failed: 1, pending: 0, voice: 6 },
    firstTurnAt: '2026-10-15T10:00:30.000Z',
    lastTurnAt: '2026-10-15T10:12:00.000Z',
    calls: 1,
    distilledAt: null,
    distillVersion: 0,
    hasDigest: false,
    digestDeleted: false,
    unusableAnswers: 0,
    distillRunning: false,
    hasOpener: false,
    openerSourceSessionId: null,
    openerByPerson: false,
    ...overrides,
  };
}

function report(overrides: Partial<InsightsReport> = {}): InsightsReport {
  return InsightsReport.parse({
    kind: 'metadata',
    version: 1,
    generatedAt: '2026-10-16T12:00:00.000Z',
    days: 30,
    conversations: [conversation()],
    calls: [
      {
        id: CALL,
        sessionId: SESSION,
        ventureId: VENTURE,
        status: 'ended',
        provider: 'builtin',
        inputMode: 'transcribe',
        startedAt: '2026-10-15T10:00:00.000Z',
        endedAt: '2026-10-15T10:13:00.000Z',
        seconds: 780,
        endReason: 'user',
        endDetail: 'client_user',
        lastState: 'listening',
        micOpenSeconds: 600,
        sttGrants: 2,
        speechCharacters: 4200,
        firstAudioMsP50: 1800,
        firstAudioMsP95: 3100,
        bargeIns: 2,
        reconnects: 0,
        turns: 6,
        interruptedTurns: 2,
        speechUnits: 18,
        speechPlays: 18,
        turnLatencyMsP50: 2400,
        turnLatencyMsP95: 5200,
      },
    ],
    turns: [],
    turnTrace: [
      {
        turnId: TURN,
        sessionId: SESSION,
        callId: CALL,
        at: '2026-10-15T10:01:00.000Z',
        ordinal: 1,
        outcome: 'completed',
        reason: null,
        channel: 'voice',
        notebook: false,
        digests: 0,
        openerReplayed: false,
        evidence: 2,
        memoryCandidates: 1,
        attempts: 1,
        fallbackUsed: false,
        inputTokensEstimate: 3500,
        stream: 'streamed',
        totalMs: 2900,
        modelMs: 2500,
        firstTokenMs: 900,
        modelFirstTokenMs: 700,
        speechUnits: 3,
        gateIdentityRewrites: 0,
      },
    ],
    validatorNotes: [{ code: 'spoken_trimmed', turns: 2 }],
    ventures: [],
    usage: [
      {
        purpose: 'turn',
        modelId: 'us.amazon.nova-2-lite-v1:0',
        calls: 12,
        inputTokens: 40000,
        outputTokens: 3000,
        usd: 0.0123,
      },
    ],
    audit: [{ action: 'session.distill_failed', outcome: 'failed', reason: 'invalid_schema', events: 1 }],
    ...overrides,
  });
}

describe('the metadata report', () => {
  it('renders tables of numbers and codes', () => {
    const markdown = renderReport(report());
    expect(markdown).toContain('## Platform insights (last 30 days');
    expect(markdown).toContain('| voice/standard | 1 | 6 | 6.0 |');
    expect(markdown).toContain('| never | 1 |');
    expect(markdown).toContain('| session.distill_failed | failed | invalid_schema | 1 |');
    expect(markdown).toContain('| 11111111 | 1 | 10-15 10:01:00 | voice | completed | no | 0 | no |');
  });

  it('is strict: a field that could carry text, or text in a code field, is refused', () => {
    const base = report();
    expect(InsightsReport.safeParse({ ...base, note: 'anything' }).success).toBe(false);
    expect(
      InsightsReport.safeParse({ ...base, conversations: [{ ...conversation(), title: 'Pricing talk' }] })
        .success,
    ).toBe(false);
    expect(
      InsightsReport.safeParse({
        ...base,
        conversations: [conversation({ status: 'We talked about pricing' })],
      }).success,
    ).toBe(false);
    expect(
      InsightsReport.safeParse({
        ...base,
        audit: [{ action: 'session.distilled', outcome: 'succeeded', reason: 'Maya said no', events: 1 }],
      }).success,
    ).toBe(false);
    // The union the workflow parses refuses it too (it is not an export part or an error either).
    expect(InsightsResponse.safeParse({ ...base, note: 'anything' }).success).toBe(false);
  });

  it('reports a stored value that is not a plain code as other', () => {
    expect(reportCode('model_unavailable:timeout')).toBe('model_unavailable:timeout');
    expect(reportCode('Not a code')).toBe('other');
    expect(reportCode(null)).toBeNull();
  });

  it('names each conversation’s distillation state', () => {
    expect(distillState(conversation())).toBe('never');
    expect(
      distillState(
        conversation({ distilledAt: '2026-10-15T10:30:00.000Z', distillVersion: 6, hasDigest: true }),
      ),
    ).toBe('up_to_date');
    expect(distillState(conversation({ distilledAt: '2026-10-15T10:30:00.000Z', distillVersion: 6 }))).toBe(
      'recorded_without_digest',
    );
    expect(distillState(conversation({ distilledAt: '2026-10-15T10:30:00.000Z', distillVersion: 3 }))).toBe(
      'behind',
    );
    expect(distillState(conversation({ privacy: 'ephemeral' }))).toBe('private');
    expect(distillState(conversation({ distillRunning: true }))).toBe('running');
  });
});

describe('Lambda log events', () => {
  const at = Date.parse('2026-10-15T10:21:00.000Z');

  it('keeps only allow-listed fields whose values are ids, codes, numbers or timings', () => {
    const line = JSON.stringify({
      level: 'info',
      time: '2026-10-15T10:21:00.000Z',
      event: 'worker.distill_done',
      sessionId: SESSION,
      status: 'skipped',
      reason: 'active',
      turns: 6,
      // Not allow-listed, or not a code: dropped.
      message: 'the founder said something',
      title: 'Pricing',
      errorName: 'Error: with a message',
      requestId: 'has spaces in it',
    });
    expect(sanitizeLogEvent('worker', line, at)).toEqual({
      group: 'worker',
      level: 'info',
      time: '2026-10-15T10:21:00.000Z',
      event: 'worker.distill_done',
      sessionId: SESSION,
      status: 'skipped',
      reason: 'active',
      turns: 6,
    });
    expect(
      sanitizeLogEvent('worker', JSON.stringify({ event: 'distill.skipped', reason: 'Some text here' }), at),
    ).toEqual({
      group: 'worker',
      event: 'distill.skipped',
      time: '2026-10-15T10:21:00.000Z',
    });
  });

  it('drops lines that are not JSON events and reads REPORT lines as numbers', () => {
    expect(sanitizeLogEvent('api', 'START RequestId: x Version: $LATEST', at)).toBeNull();
    expect(sanitizeLogEvent('api', 'some stack trace text', at)).toBeNull();
    expect(sanitizeLogEvent('api', JSON.stringify({ no: 'event' }), at)).toBeNull();
    const report = sanitizeLogEvent(
      'api',
      'REPORT RequestId: 0b1c2d3e-0000-4000-8000-000000000000\tDuration: 812.25 ms\tBilled Duration: 813 ms\tMemory Size: 1024 MB\tMax Memory Used: 210 MB\tInit Duration: 640.50 ms',
      at,
    );
    expect(report).toMatchObject({
      event: 'lambda.report',
      durationMs: 812.25,
      initMs: 640.5,
      maxMemoryMb: 210,
    });
  });

  it('renders counts, the distillation timeline, routes and invocations', () => {
    const events = [
      sanitizeLogEvent(
        'api',
        JSON.stringify({
          event: 'distill.enqueued',
          sessionId: SESSION,
          trigger: 'turn',
          turns: 6,
          delaySeconds: 540,
          time: '2026-10-15T10:12:00.000Z',
        }),
        at,
      ),
      sanitizeLogEvent(
        'worker',
        JSON.stringify({
          event: 'worker.distill_done',
          sessionId: SESSION,
          status: 'skipped',
          reason: 'active',
          time: '2026-10-15T10:21:00.000Z',
        }),
        at,
      ),
      sanitizeLogEvent(
        'api',
        JSON.stringify({
          event: 'http.request',
          level: 'info',
          method: 'POST',
          route: '/api/v1/sessions/:id/turns',
          latencyMs: 2300,
        }),
        at,
      ),
    ].flatMap((e) => (e === null ? [] : [e]));
    const markdown = renderLogs(events);
    expect(markdown).toContain(
      '| 10-15 10:12:00 | api | distill.enqueued | 11111111 | turn | – | – | 6 | 540 | – |',
    );
    expect(markdown).toContain(
      '| 10-15 10:21:00 | worker | worker.distill_done | 11111111 | – | skipped | active | – | – | – |',
    );
    expect(markdown).toContain('| POST /api/v1/sessions/:id/turns | 1 | 2300 | 2300 | 2300 | 0 |');
  });

  it('names log groups by function', () => {
    expect(groupName('/aws/lambda/FoundryAscent-Worker')).toBe('worker');
    expect(groupName('FoundryAscent-Api')).toBe('api');
    expect(groupName('/aws/lambda/Other')).toBe('other');
  });
});
