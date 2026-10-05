import { ProblemDetails, TurnStreamEvent } from '@foundry/contracts';
import { DomainError, type RunTurnOutcome } from '@foundry/core';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { silentLogger } from '../logging.js';
import { InflightTracker } from '../runtime/inflight.js';
import { buildRequest } from '../testing/api-harness.js';
import {
  acceptedEvent,
  type FakeTurn,
  fakeCore,
  MemoryIdempotencyStore,
  pingOnlyDb,
  sleep,
  TURN_ID,
} from '../testing/fakes.js';
import { parseSse } from '../testing/sse.js';

const SESSION = '55555555-5555-4555-8555-555555555555';

function appFor(
  turn: FakeTurn,
  http: Parameters<typeof createApp>[0]['http'] = {},
  store = new MemoryIdempotencyStore(),
) {
  const core = fakeCore(turn);
  const inflight = new InflightTracker();
  const app = createApp({
    core,
    db: pingOnlyDb,
    logger: silentLogger,
    appEnv: 'test',
    appVersion: 't',
    idempotency: store,
    inflight,
    http: { sseKeepAliveMs: 15_000, sseWriteTimeoutMs: 1_000, ...http },
  });
  return { app, core, inflight, store };
}

const post = (body: unknown = { text: 'Hello coach' }, key?: string) =>
  buildRequest(`/sessions/${SESSION}/turns`, {
    body,
    cookie: 'valid',
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });

const ok = (status: RunTurnOutcome['status'] = 'completed'): RunTurnOutcome => ({
  status,
  turnId: TURN_ID,
  replayed: false,
  error: null,
});

describe('turn SSE stream', () => {
  it('writes each event as `event: <name>` + `data: <json>` and keep-alive comments while waiting', async () => {
    const { app } = appFor(
      async (_input, emit) => {
        await emit(acceptedEvent());
        await emit({ event: 'turn.status', phase: 'reasoning', detail: null, evidenceCount: 2 });
        await sleep(120);
        await emit({
          event: 'turn.error',
          turnId: TURN_ID,
          code: 'model_unavailable',
          message: 'Try again',
          retryable: true,
        });
        return ok('failed');
      },
      { sseKeepAliveMs: 25 },
    );
    const res = await app.request(post());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('connection')).toBeNull();
    const text = await res.text();
    expect(text.startsWith('event: turn.accepted\ndata: {')).toBe(true);
    const { frames, comments } = parseSse(text);
    expect(frames.map((f) => f.event)).toEqual(['turn.accepted', 'turn.status', 'turn.error']);
    for (const f of frames) expect(TurnStreamEvent.parse(JSON.parse(f.data)).event).toBe(f.event);
    expect(comments.filter((c) => c === 'keep-alive').length).toBeGreaterThanOrEqual(2);
  });

  it('answers a pre-acceptance refusal with problem+json (status, Retry-After)', async () => {
    const error = new DomainError('rate_limited', 'Slow down', {
      retryAfterSeconds: 600,
      reason: 'turn_rate_limit',
    });
    const { app } = appFor(async (_input, emit) => {
      await emit({
        event: 'turn.error',
        turnId: null,
        code: error.code,
        message: error.message,
        retryable: true,
      });
      return { status: 'rejected', turnId: null, replayed: false, error };
    });
    const res = await app.request(post());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('600');
    expect(ProblemDetails.parse(await res.json())).toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: 600,
    });
  });

  it('cancels the turn when the client disconnects, and still lets it finish', async () => {
    let signal: AbortSignal | undefined;
    let finished = false;
    const { app, inflight } = appFor(async (_input, emit, options) => {
      signal = options.signal;
      await emit(acceptedEvent());
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });
      await emit({
        event: 'turn.error',
        turnId: TURN_ID,
        code: 'model_unavailable',
        message: 'Cancelled',
        retryable: true,
      });
      finished = true;
      return ok('failed');
    });
    const res = await app.request(post());
    const reader = res.body?.getReader();
    const first = await reader?.read();
    const chunk: Uint8Array | undefined = first?.value as Uint8Array | undefined;
    expect(new TextDecoder().decode(chunk)).toContain('turn.accepted');
    await reader?.cancel();
    await inflight.drain(1_000);
    expect(signal?.aborted).toBe(true);
    expect((signal?.reason as DOMException | undefined)?.message).toBe('client_disconnected');
    expect(finished).toBe(true);
  });

  it('cancels at the deadline', async () => {
    let reason: unknown;
    const { app } = appFor(
      async (_input, emit, options) => {
        await emit(acceptedEvent());
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
        });
        reason = options.signal?.reason;
        await emit({
          event: 'turn.error',
          turnId: TURN_ID,
          code: 'model_unavailable',
          message: 'Timed out',
          retryable: true,
        });
        return ok('failed');
      },
      { turnTimeoutMs: 50 },
    );
    const { frames } = parseSse(await (await app.request(post())).text());
    expect(frames.at(-1)?.event).toBe('turn.error');
    expect((reason as DOMException).message).toBe('deadline');
  });

  it('turns an unexpected orchestrator rejection into a final turn.error frame', async () => {
    const { app } = appFor(async (_input, emit) => {
      await emit(acceptedEvent());
      throw new Error('boom');
    });
    const { frames } = parseSse(await (await app.request(post())).text());
    const last = TurnStreamEvent.parse(JSON.parse(frames.at(-1)?.data ?? '{}'));
    expect(last).toMatchObject({ event: 'turn.error', turnId: TURN_ID, code: 'internal' });
  });

  it('binds an Idempotency-Key to the accepted ordinal and replays it via expectedOrdinal', async () => {
    const { app, core } = appFor(async (input, emit) => {
      await emit(acceptedEvent(input.expectedOrdinal ?? 7));
      await emit({
        event: 'turn.blocked',
        turnId: TURN_ID,
        reason: 'identity',
        escalationId: null,
        supportMessage: null,
      });
      return ok('blocked');
    });
    const first = await app.request(post({ text: 'Same text' }, 'turn-idem-0001'));
    expect(first.headers.get('idempotency-replayed')).toBeNull();
    await first.text();
    const second = await app.request(post({ text: 'Same text' }, 'turn-idem-0001'));
    expect(second.headers.get('idempotency-replayed')).toBe('true');
    await second.text();
    expect(core.calls.map((c) => c.expectedOrdinal)).toEqual([undefined, 7]);
    const conflict = await app.request(post({ text: 'Other text' }, 'turn-idem-0001'));
    expect(conflict.status).toBe(409);
  });

  it('releases the key when the turn is refused, so a retry runs again', async () => {
    let calls = 0;
    const { app, store } = appFor(async (_input, emit) => {
      calls += 1;
      const error = new DomainError('session_ended', 'Ended');
      await emit({
        event: 'turn.error',
        turnId: null,
        code: error.code,
        message: error.message,
        retryable: false,
      });
      return { status: 'rejected', turnId: null, replayed: false, error };
    });
    expect((await app.request(post(undefined, 'turn-idem-0002'))).status).toBe(409);
    expect(store.records.size).toBe(0);
    expect((await app.request(post(undefined, 'turn-idem-0002'))).status).toBe(409);
    expect(calls).toBe(2);
  });
});
