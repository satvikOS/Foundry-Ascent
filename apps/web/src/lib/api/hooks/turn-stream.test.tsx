import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { IDS, makeTurn } from '@/features/coach/testing';

import {
  MAX_PENDING_REPLAYS,
  retryAtFrom,
  turnPhaseLabel,
  turnStreamReducer,
  useTurnStream,
  type TurnStreamState,
} from './turn-stream';

const IDLE: TurnStreamState = {
  status: 'idle',
  pendingText: null,
  turnId: null,
  ordinal: null,
  phase: null,
  steps: [],
  turn: null,
  blocked: null,
  error: null,
  autoRetryAt: null,
};
const TURN_ID = '7d1f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

describe('turnStreamReducer', () => {
  it('tracks a turn from start through progress steps to blocked', () => {
    let state = turnStreamReducer(IDLE, { type: 'start', text: 'Can I file a patent myself?' });
    expect(state).toMatchObject({ status: 'streaming', pendingText: 'Can I file a patent myself?' });

    state = turnStreamReducer(state, {
      type: 'event',
      event: { event: 'turn.accepted', turnId: TURN_ID, ordinal: 2 },
    });
    expect(state).toMatchObject({ turnId: TURN_ID, ordinal: 2 });

    state = turnStreamReducer(state, {
      type: 'event',
      event: { event: 'turn.status', phase: 'classifying', detail: null, evidenceCount: null },
    });
    state = turnStreamReducer(state, {
      type: 'event',
      event: { event: 'turn.status', phase: 'retrieving', detail: null, evidenceCount: 3 },
    });
    expect(state.phase).toBe('retrieving');
    expect(state.steps.map((s) => s.phase)).toEqual(['classifying', 'retrieving']);

    state = turnStreamReducer(state, {
      type: 'event',
      event: {
        event: 'turn.blocked',
        turnId: TURN_ID,
        reason: 'ip_licensing',
        escalationId: null,
        supportMessage: 'An EIR can help with this.',
      },
    });
    expect(state).toMatchObject({ status: 'blocked', phase: null });
    expect(state.blocked?.supportMessage).toBe('An EIR can help with this.');
  });

  it('records turn.error as a failed, possibly retryable turn', () => {
    const state = turnStreamReducer(turnStreamReducer(IDLE, { type: 'start', text: 'x' }), {
      type: 'event',
      event: {
        event: 'turn.error',
        turnId: null,
        code: 'model_unavailable',
        message: 'Try again',
        retryable: true,
      },
    });
    expect(state.status).toBe('failed');
    expect(state.error).toMatchObject({ code: 'model_unavailable', retryable: true });
  });

  it('keeps the request id and the server wait of a turn.error', () => {
    const before = Date.now();
    const state = turnStreamReducer(turnStreamReducer(IDLE, { type: 'start', text: 'x' }), {
      type: 'event',
      event: {
        event: 'turn.error',
        turnId: TURN_ID,
        code: 'conflict',
        message: 'This message is still being answered. Please wait.',
        retryable: true,
        retryAfterSeconds: 5,
        requestId: 'req-abc-123',
      },
    });
    expect(state.error).toMatchObject({ code: 'conflict', requestId: 'req-abc-123' });
    expect(state.error?.retryAt).toBeGreaterThanOrEqual(before + 5000);
    expect(retryAtFrom(undefined)).toBeUndefined();
    expect(retryAtFrom(0)).toBeUndefined();
    expect(retryAtFrom(3, 1_000)).toBe(4_000);
  });

  it('records and clears a scheduled automatic replay', () => {
    const failed: TurnStreamState = { ...IDLE, status: 'failed', pendingText: 'x' };
    const scheduled = turnStreamReducer(failed, { type: 'autoRetry', at: 123 });
    expect(scheduled.autoRetryAt).toBe(123);
    // Cancelling a failed turn only stops the scheduled replay.
    expect(turnStreamReducer(scheduled, { type: 'cancelled' })).toMatchObject({
      status: 'failed',
      autoRetryAt: null,
    });
    // A new send starts clean.
    expect(turnStreamReducer(scheduled, { type: 'start', text: 'y' }).autoRetryAt).toBeNull();
  });

  it('only marks an in-flight turn as cancelled', () => {
    expect(turnStreamReducer(IDLE, { type: 'cancelled' })).toBe(IDLE);
    const streaming = turnStreamReducer(IDLE, { type: 'start', text: 'x' });
    expect(turnStreamReducer(streaming, { type: 'cancelled' }).status).toBe('cancelled');
  });

  it('labels phases for the live region', () => {
    expect(turnPhaseLabel({ phase: 'retrieving', evidenceCount: 1 })).toBe('Gathering evidence · 1 source');
    expect(turnPhaseLabel({ phase: 'retrieving', evidenceCount: 4 })).toBe('Gathering evidence · 4 sources');
    expect(turnPhaseLabel({ phase: 'validating', evidenceCount: null })).toBe(
      'Checking claims against evidence',
    );
  });
});

function sse(...events: object[]): Response {
  const text = events
    .map((event) => `event: ${(event as { event: string }).event}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function idempotencyKeyOf(call: Parameters<typeof fetch> | undefined): string | null {
  return new Headers(call?.[1]?.headers).get('idempotency-key');
}

describe('useTurnStream idempotency', () => {
  function setup() {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useTurnStream(IDS.session, { ventureId: IDS.venture }), { wrapper });
    return { fetchMock, result };
  }

  const turn = makeTurn({ id: IDS.turn, sessionId: IDS.session, ordinal: 1 });
  const completed = [
    { event: 'turn.accepted', turnId: IDS.turn, ordinal: 1 },
    { event: 'turn.status', phase: 'reasoning', detail: null, evidenceCount: null },
    { event: 'turn.completed', turn },
  ];

  it('reuses the key when retrying a send whose outcome is unknown, then starts fresh', async () => {
    const { fetchMock, result } = setup();
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(sse(...completed))
      .mockResolvedValueOnce(sse(...completed));

    let outcome: string | null = null;
    await act(async () => {
      outcome = await result.current.send({ text: 'Where should I start?', mode: 'diagnose' });
    });
    expect(outcome).toBe('failed');
    expect(result.current.state.error).toMatchObject({ code: 'network_error', retryable: true });

    await act(async () => {
      outcome = await result.current.retry();
    });
    expect(outcome).toBe('completed');
    expect(result.current.state.turn?.id).toBe(IDS.turn);
    const first = idempotencyKeyOf(fetchMock.mock.calls[0]);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(idempotencyKeyOf(fetchMock.mock.calls[1])).toBe(first);
    // Same body bytes on the retry (the API binds the key to a hash of the body).
    expect(fetchMock.mock.calls[1]?.[1]?.body).toEqual(fetchMock.mock.calls[0]?.[1]?.body);

    // A completed turn is settled: asking the same thing again is a new turn with a new key.
    await act(async () => {
      await result.current.send({ text: 'Where should I start?', mode: 'diagnose' });
    });
    expect(idempotencyKeyOf(fetchMock.mock.calls[2])).not.toBe(first);
  });

  it('uses a new key after the server reported the turn as failed', async () => {
    const { fetchMock, result } = setup();
    fetchMock
      .mockResolvedValueOnce(
        sse(
          { event: 'turn.accepted', turnId: IDS.turn, ordinal: 1 },
          {
            event: 'turn.error',
            turnId: IDS.turn,
            code: 'model_unavailable',
            message: 'Please send it again.',
            retryable: true,
          },
        ),
      )
      .mockResolvedValueOnce(sse(...completed));

    await act(async () => {
      await result.current.send({ text: 'Where should I start?' });
    });
    expect(result.current.state.status).toBe('failed');
    await act(async () => {
      await result.current.retry();
    });
    expect(result.current.state.status).toBe('completed');
    expect(idempotencyKeyOf(fetchMock.mock.calls[1])).not.toBe(idempotencyKeyOf(fetchMock.mock.calls[0]));
  });

  it('keeps the key while a replay reports the original turn as still being answered', async () => {
    const { fetchMock, result } = setup();
    fetchMock
      .mockResolvedValueOnce(
        sse(
          { event: 'turn.accepted', turnId: IDS.turn, ordinal: 1 },
          {
            event: 'turn.error',
            turnId: IDS.turn,
            code: 'conflict',
            message: 'This message is still being answered. Please wait.',
            retryable: true,
          },
        ),
      )
      .mockResolvedValueOnce(sse(...completed));
    await act(async () => {
      await result.current.send({ text: 'Where should I start?' });
    });
    await act(async () => {
      await result.current.retry();
    });
    expect(result.current.state.status).toBe('completed');
    expect(idempotencyKeyOf(fetchMock.mock.calls[1])).toBe(idempotencyKeyOf(fetchMock.mock.calls[0]));
  });

  /**
   * Fake only setTimeout (the hook's replay timer): request hashing (WebCrypto) and stream reading stay
   * real, so the test waits for them with `until` instead of assuming they finish within a timer tick.
   */
  async function until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !predicate(); i++) {
      await act(async () => {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      });
    }
    expect(predicate(), 'condition reached').toBe(true);
  }

  it('replays a still-pending turn automatically after retryAfterSeconds, with the same key', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { fetchMock, result } = setup();
      const pending = {
        event: 'turn.error',
        turnId: IDS.turn,
        code: 'conflict',
        message: 'This message is still being answered. Please wait.',
        retryable: true,
        retryAfterSeconds: 5,
        requestId: 'req-pending-1',
      };
      fetchMock
        .mockResolvedValueOnce(sse({ event: 'turn.accepted', turnId: IDS.turn, ordinal: 1 }, pending))
        .mockResolvedValueOnce(sse(...completed));
      await act(async () => {
        await result.current.send({ text: 'Where should I start?' });
      });
      expect(result.current.state.status).toBe('failed');
      expect(result.current.state.error?.requestId).toBe('req-pending-1');
      expect(result.current.state.autoRetryAt).not.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Nothing happens before the server's wait has passed.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_900);
      });
      await act(async () => {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      await until(() => result.current.state.status === 'completed');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(idempotencyKeyOf(fetchMock.mock.calls[1])).toBe(idempotencyKeyOf(fetchMock.mock.calls[0]));
      expect(result.current.state.autoRetryAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops replaying automatically after MAX_PENDING_REPLAYS, and cancel stops a scheduled replay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { fetchMock, result } = setup();
      const pending = () =>
        sse(
          { event: 'turn.accepted', turnId: IDS.turn, ordinal: 1 },
          {
            event: 'turn.error',
            turnId: IDS.turn,
            code: 'conflict',
            message: 'Still being answered.',
            retryable: true,
            retryAfterSeconds: 1,
          },
        );
      fetchMock.mockImplementation(() => Promise.resolve(pending()));
      await act(async () => {
        await result.current.send({ text: 'Where should I start?' });
      });
      for (let calls = 2; calls <= 1 + MAX_PENDING_REPLAYS; calls++) {
        await until(() => result.current.state.autoRetryAt !== null);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_100);
        });
        await until(() => fetchMock.mock.calls.length === calls && result.current.state.status === 'failed');
      }
      // The cap is reached: no further replay is scheduled.
      await until(() => result.current.state.status === 'failed');
      expect(result.current.state.autoRetryAt).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1 + MAX_PENDING_REPLAYS);

      // A manual retry of the same message keeps the key and the cap.
      await act(async () => {
        await result.current.retry();
      });
      expect(result.current.state.autoRetryAt).toBeNull();
      // A new message gets its own replays; cancel stops the scheduled one.
      fetchMock.mockClear();
      await act(async () => {
        await result.current.send({ text: 'Another question' });
      });
      expect(result.current.state.autoRetryAt).not.toBeNull();
      act(() => {
        result.current.cancel();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.current.state.autoRetryAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reuse the key for a different message', async () => {
    const { fetchMock, result } = setup();
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(sse(...completed));
    await act(async () => {
      await result.current.send({ text: 'First question' });
    });
    await act(async () => {
      await result.current.send({ text: 'A different question' });
    });
    expect(idempotencyKeyOf(fetchMock.mock.calls[1])).not.toBe(idempotencyKeyOf(fetchMock.mock.calls[0]));
  });
});
