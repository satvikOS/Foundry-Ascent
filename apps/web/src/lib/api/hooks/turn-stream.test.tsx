import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { IDS, makeTurn } from '@/features/coach/testing';

import { queryKeys } from '../query-keys';
import {
  joinStreamUnits,
  MAX_PENDING_REPLAYS,
  retryAtFrom,
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
  units: [],
  streamedText: '',
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

  it('appends validated answer units in seq order, once each, for the current turn only', () => {
    let state = turnStreamReducer(IDLE, { type: 'start', text: 'What next?' });
    state = turnStreamReducer(state, {
      type: 'event',
      event: { event: 'turn.accepted', turnId: TURN_ID, ordinal: 1 },
    });
    const delta = (seq: number, text: string, turnId = TURN_ID) =>
      ({ type: 'event', event: { event: 'turn.delta', turnId, seq, text } }) as const;
    state = turnStreamReducer(state, delta(1, 'Then talk to five library staff.'));
    state = turnStreamReducer(state, delta(0, 'Start with the people who feel the pain.'));
    // A unit delivered twice is kept once; a unit of another turn is ignored.
    state = turnStreamReducer(state, delta(1, 'Then talk to five library staff.'));
    state = turnStreamReducer(state, delta(2, 'Not this.', '8e2f3d5f-2b3c-4d4e-9f0a-1b2c3d4e5f60'));
    expect(state.units.map((unit) => unit.seq)).toEqual([0, 1]);
    expect(state.streamedText).toBe(
      'Start with the people who feel the pain. Then talk to five library staff.',
    );
    expect(state.status).toBe('streaming');
  });

  it('keeps streamed text until the stored answer arrives, and discards it when the turn does not finish', () => {
    const streaming = turnStreamReducer(turnStreamReducer(IDLE, { type: 'start', text: 'x' }), {
      type: 'event',
      event: { event: 'turn.delta', turnId: TURN_ID, seq: 0, text: 'A first sentence.' },
    });
    expect(streaming.streamedText).toBe('A first sentence.');
    const turn = makeTurn({ id: TURN_ID });
    const completed = turnStreamReducer(streaming, {
      type: 'event',
      event: { event: 'turn.completed', turn },
    });
    // The stored answer is authoritative (the view renders `turn`); the streamed text is only a bridge.
    expect(completed).toMatchObject({ status: 'completed', turn: { id: TURN_ID } });

    const blocked = turnStreamReducer(streaming, {
      type: 'event',
      event: {
        event: 'turn.blocked',
        turnId: TURN_ID,
        reason: 'policy',
        escalationId: null,
        supportMessage: null,
      },
    });
    expect(blocked).toMatchObject({ status: 'blocked', units: [], streamedText: '' });
    const failed = turnStreamReducer(streaming, {
      type: 'event',
      event: { event: 'turn.error', turnId: TURN_ID, code: 'internal', message: 'x', retryable: true },
    });
    expect(failed).toMatchObject({ status: 'failed', streamedText: '' });
    expect(turnStreamReducer(streaming, { type: 'cancelled' })).toMatchObject({
      status: 'cancelled',
      streamedText: '',
    });
    // Units arriving after the turn ended are ignored.
    expect(
      turnStreamReducer(completed, {
        type: 'event',
        event: { event: 'turn.delta', turnId: TURN_ID, seq: 1, text: 'Late.' },
      }),
    ).toBe(completed);
  });

  it('joins units without running sentences together or doubling spaces', () => {
    expect(joinStreamUnits([])).toBe('');
    expect(
      joinStreamUnits([
        { seq: 0, text: 'One.' },
        { seq: 1, text: ' Two.' },
        { seq: 2, text: '\n\nThree.' },
        { seq: 3, text: 'Four.' },
      ]),
    ).toBe('One. Two.\n\nThree. Four.');
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

describe('useTurnStream streaming', () => {
  it('shows validated units while the turn runs, then keeps the stored answer as authoritative', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.session.detail(IDS.session), {
      session: { turnCount: 0 },
      turns: [],
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const final = makeTurn({ id: IDS.turn, sessionId: IDS.session, ordinal: 1 });
    const seen: string[] = [];
    const { result } = renderHook(
      () =>
        useTurnStream(IDS.session, {
          ventureId: IDS.venture,
          onEvent: (event) => {
            if (event.event === 'turn.delta') seen.push(event.text);
          },
        }),
      { wrapper },
    );
    fetchMock.mockResolvedValueOnce(
      sse(
        { event: 'turn.accepted', turnId: IDS.turn, ordinal: 1 },
        { event: 'turn.delta', turnId: IDS.turn, seq: 0, text: 'A streamed first sentence.' },
        { event: 'turn.delta', turnId: IDS.turn, seq: 1, text: 'A second one.' },
        { event: 'turn.completed', turn: final },
      ),
    );
    await act(async () => {
      await result.current.send({ text: 'What is my riskiest assumption?' });
    });
    expect(seen).toEqual(['A streamed first sentence.', 'A second one.']);
    expect(result.current.state.status).toBe('completed');
    // The stored answer (not the streamed units) is what the conversation now shows.
    const cached = client.getQueryData<{ turns: { id: string; response: { answer: string } | null }[] }>(
      queryKeys.session.detail(IDS.session),
    );
    expect(cached?.turns.map((t) => t.id)).toEqual([IDS.turn]);
    expect(cached?.turns[0]?.response?.answer).toBe(final.response?.answer);
  });
});

describe('useTurnStream venture refresh', () => {
  it('cancels a venture read that was in flight when the turn finished, then reads again', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    // The memory list the conversation binds suggestions to: its first read starts before the turn is
    // saved and is still pending when the turn completes (it would return the list without the new item).
    let resolveFirst: (items: string[]) => void = () => undefined;
    const memoryFn = vi
      .fn<() => Promise<string[]>>()
      .mockImplementationOnce(
        () =>
          new Promise<string[]>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(['proposed from this turn']);
    const turn = makeTurn({ id: IDS.turn, sessionId: IDS.session, ordinal: 1 });
    fetchMock.mockResolvedValue(
      sse({ event: 'turn.accepted', turnId: IDS.turn, ordinal: 1 }, { event: 'turn.completed', turn }),
    );
    const { result } = renderHook(
      () => ({
        stream: useTurnStream(IDS.session, { ventureId: IDS.venture }),
        memory: useQuery({ queryKey: queryKeys.venture.memory(IDS.venture), queryFn: memoryFn }),
      }),
      { wrapper },
    );
    expect(memoryFn).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.stream.send({ text: 'What should we test?' });
    });
    // The stale first read finishing late must not win over the fresh one.
    await act(async () => {
      resolveFirst(['stale list']);
      await Promise.resolve();
    });
    for (let i = 0; i < 50 && result.current.memory.data?.[0] !== 'proposed from this turn'; i++) {
      await act(async () => {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      });
    }
    expect(memoryFn).toHaveBeenCalledTimes(2);
    expect(result.current.memory.data).toEqual(['proposed from this turn']);
  });

  it('reads again only what a turn changes: the memory, not the notebook, documents or call settings', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const reads = { memory: 0, notebook: 0, documents: 0, callConfig: 0 };
    const counted = (name: keyof typeof reads) => () => {
      reads[name] += 1;
      return Promise.resolve([]);
    };
    const turn = makeTurn({ id: IDS.turn, sessionId: IDS.session, ordinal: 1 });
    fetchMock.mockResolvedValue(
      sse({ event: 'turn.accepted', turnId: IDS.turn, ordinal: 1 }, { event: 'turn.completed', turn }),
    );
    const { result } = renderHook(
      () => ({
        stream: useTurnStream(IDS.session, { ventureId: IDS.venture }),
        memory: useQuery({ queryKey: queryKeys.venture.memory(IDS.venture), queryFn: counted('memory') }),
        notebook: useQuery({
          queryKey: queryKeys.venture.notebook(IDS.venture),
          queryFn: counted('notebook'),
        }),
        documents: useQuery({
          queryKey: queryKeys.venture.documents(IDS.venture),
          queryFn: counted('documents'),
        }),
        callConfig: useQuery({
          queryKey: [...queryKeys.venture.scope(IDS.venture), 'call-config'],
          queryFn: counted('callConfig'),
        }),
      }),
      { wrapper },
    );
    await waitFor(() => {
      expect(reads).toEqual({ memory: 1, notebook: 1, documents: 1, callConfig: 1 });
    });
    await act(async () => {
      await result.current.stream.send({ text: 'What should we test?' });
    });
    await waitFor(() => {
      expect(reads.memory).toBe(2);
    });
    expect(reads).toEqual({ memory: 2, notebook: 1, documents: 1, callConfig: 1 });
  });
});

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

  it('shows a 429’s own detail: which limit was reached and until when', async () => {
    const { fetchMock, result } = setup();
    const detail = 'You have reached your daily AI coaching budget. It resets at midnight UTC.';
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: 'urn:foundry-ascent:problem:spend_cap_reached',
          title: 'Daily AI budget reached',
          status: 429,
          code: 'spend_cap_reached',
          detail,
          requestId: 'req-1',
          retryAfterSeconds: 3600,
        }),
        { status: 429, headers: { 'content-type': 'application/problem+json', 'retry-after': '3600' } },
      ),
    );
    await act(async () => {
      await result.current.send({ text: 'Where should I start?' });
    });
    expect(result.current.state).toMatchObject({
      status: 'failed',
      error: { code: 'spend_cap_reached', message: detail },
    });
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
