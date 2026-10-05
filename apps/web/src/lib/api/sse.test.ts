import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './errors';
import { parseTurnStreamFrame, readTurnStream, SseParser, streamTurn, type TurnStreamEventT } from './sse';

const TURN_ID = '7d1f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const SESSION_ID = '0f9e8d7c-6b5a-4c3d-9e1f-2a3b4c5d6e7f';

function completedTurn() {
  return {
    id: TURN_ID,
    sessionId: SESSION_ID,
    ordinal: 1,
    mode: 'diagnose',
    founderText: 'Should we raise now?',
    status: 'completed',
    response: {
      mode: 'diagnose',
      answer: 'Finish the pilot first.',
      claims: [{ text: 'Two LOIs signed', kind: 'fact', evidence_ids: ['E1'] }],
      uncertainty: [],
      challenge: null,
      next_actions: [],
      escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
      memory_candidates: [],
      follow_up_questions: [],
      rehearsal: null,
    },
    evidence: [],
    validator: null,
    usage: null,
    createdAt: '2026-10-05T10:00:00.000Z',
    completedAt: '2026-10-05T10:00:04.000Z',
  };
}

function frames(parser: SseParser, chunks: string[]) {
  return [...chunks.flatMap((chunk) => parser.feed(chunk)), ...parser.flush()];
}

describe('SseParser', () => {
  it('parses event and data fields and dispatches on a blank line', () => {
    const parser = new SseParser();
    expect(frames(parser, ['event: turn.accepted\ndata: {"a":1}\n\n'])).toEqual([
      { event: 'turn.accepted', data: '{"a":1}', id: undefined, retry: undefined },
    ]);
  });

  it('joins multi-line data with "\\n" and strips exactly one leading space', () => {
    const parser = new SseParser();
    const result = frames(parser, ['data: line one\ndata:line two\ndata:   indented\n\n']);
    expect(result).toHaveLength(1);
    expect(result[0]?.data).toBe('line one\nline two\n  indented');
    expect(result[0]?.event).toBe('message');
  });

  it('handles frames split at every possible chunk boundary', () => {
    const stream = 'event: turn.status\ndata: {"x":"a:b"}\nid: 7\n\nevent: turn.accepted\ndata: {"y":2}\n\n';
    for (let cut = 0; cut <= stream.length; cut++) {
      const parser = new SseParser();
      const result = frames(parser, [stream.slice(0, cut), stream.slice(cut)]);
      expect(result.map((f) => [f.event, f.data])).toEqual([
        ['turn.status', '{"x":"a:b"}'],
        ['turn.accepted', '{"y":2}'],
      ]);
      expect(result[0]?.id).toBe('7');
    }
  });

  it('handles one character per chunk', () => {
    const stream = 'event: e\r\ndata: 1\r\ndata: 2\r\n\r\n';
    const parser = new SseParser();
    const result = frames(
      parser,
      Array.from({ length: stream.length }, (_, i) => stream.charAt(i)),
    );
    expect(result).toEqual([{ event: 'e', data: '1\n2', id: undefined, retry: undefined }]);
  });

  it('treats CRLF split across chunks as one line ending', () => {
    const parser = new SseParser();
    const result = frames(parser, ['data: a\r', '\ndata: b\r', '\n\r', '\n']);
    expect(result.map((f) => f.data)).toEqual(['a\nb']);
  });

  it('accepts bare CR line endings', () => {
    const parser = new SseParser();
    expect(frames(parser, ['data: x\rdata: y\r\r']).map((f) => f.data)).toEqual(['x\ny']);
  });

  it('ignores comments (heartbeats), unknown fields and events without data', () => {
    const parser = new SseParser();
    const result = frames(parser, [': keep-alive\n\nevent: only-name\n\nfoo: bar\ndata: real\n\n']);
    expect(result).toEqual([{ event: 'message', data: 'real', id: undefined, retry: undefined }]);
  });

  it('strips a leading BOM and parses retry', () => {
    const parser = new SseParser();
    const result = frames(parser, ['﻿retry: 3000\ndata: ok\n\n']);
    expect(result[0]).toMatchObject({ data: 'ok', retry: 3000 });
  });

  it('flushes a final event that is not followed by a blank line', () => {
    const parser = new SseParser();
    expect(frames(parser, ['data: tail']).map((f) => f.data)).toEqual(['tail']);
  });
});

describe('parseTurnStreamFrame', () => {
  it('validates events against the TurnStreamEvent contract', () => {
    const event = parseTurnStreamFrame({
      event: 'turn.status',
      data: JSON.stringify({ phase: 'retrieving', detail: null, evidenceCount: 4 }),
      id: undefined,
      retry: undefined,
    });
    expect(event).toEqual({ event: 'turn.status', phase: 'retrieving', detail: null, evidenceCount: 4 });
  });

  it('accepts the event name from the JSON payload when the frame has none', () => {
    const event = parseTurnStreamFrame({
      event: 'message',
      data: JSON.stringify({ event: 'turn.accepted', turnId: TURN_ID, ordinal: 3 }),
      id: undefined,
      retry: undefined,
    });
    expect(event?.event).toBe('turn.accepted');
  });

  it('reads the frames exactly as the API writes them (event name + one JSON data line + keep-alives)', async () => {
    // apps/api: `writeSSE({ event: event.event, data: JSON.stringify(event) })` and `: keep-alive` comments.
    const wire = [
      { event: 'turn.accepted', turnId: TURN_ID, ordinal: 1 },
      { event: 'turn.status', phase: 'classifying', detail: null, evidenceCount: null },
      { event: 'turn.status', phase: 'retrieving', detail: null, evidenceCount: 2 },
      { event: 'turn.completed', turn: completedTurn() },
    ]
      .map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(': keep-alive\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(wire));
        controller.close();
      },
    });
    const events: TurnStreamEventT[] = [];
    for await (const event of readTurnStream(stream)) events.push(event);
    expect(events.map((e) => e.event)).toEqual([
      'turn.accepted',
      'turn.status',
      'turn.status',
      'turn.completed',
    ]);
  });

  it('ignores unknown events such as pings', () => {
    expect(parseTurnStreamFrame({ event: 'ping', data: '{}', id: undefined, retry: undefined })).toBeNull();
    expect(
      parseTurnStreamFrame({ event: 'ping', data: 'not json', id: undefined, retry: undefined }),
    ).toBeNull();
  });

  it('rejects known events with invalid payloads', () => {
    expect(() =>
      parseTurnStreamFrame({
        event: 'turn.status',
        data: JSON.stringify({ phase: 'dreaming', detail: null, evidenceCount: null }),
        id: undefined,
        retry: undefined,
      }),
    ).toThrow(ApiError);
    expect(() =>
      parseTurnStreamFrame({ event: 'turn.completed', data: '{oops', id: undefined, retry: undefined }),
    ).toThrow(ApiError);
  });

  it('rejects a frame whose name disagrees with its payload', () => {
    expect(() =>
      parseTurnStreamFrame({
        event: 'turn.blocked',
        data: JSON.stringify({ event: 'turn.accepted', turnId: TURN_ID, ordinal: 1 }),
        id: undefined,
        retry: undefined,
      }),
    ).toThrow(/mismatch/);
  });
});

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(iterable: AsyncIterable<TurnStreamEventT>): Promise<TurnStreamEventT[]> {
  const out: TurnStreamEventT[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describe('readTurnStream', () => {
  const body = [
    'event: turn.accepted\n',
    `data: {"turnId":"${TURN_ID}","ordinal":1}\n\n`,
    ': heartbeat\n\n',
    'event: turn.status\ndata: {"phase":"retrieving","detail":null,"evidenceCount":5}\n\n',
    `event: turn.completed\ndata: ${JSON.stringify({ turn: completedTurn() })}\n\n`,
  ].join('');

  it('yields validated events across arbitrary byte chunking (including split UTF-8)', async () => {
    const bytes = new TextEncoder().encode(body.replace('Finish the pilot first.', 'Café ✓ first.'));
    for (const size of [1, 2, 3, 7, 64, bytes.length]) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
          controller.close();
        },
      });
      const events = await collect(readTurnStream(stream));
      expect(events.map((e) => e.event)).toEqual(['turn.accepted', 'turn.status', 'turn.completed']);
      const completed = events[2];
      expect(completed?.event === 'turn.completed' && completed.turn.response?.answer).toBe('Café ✓ first.');
    }
  });

  it('throws stream_interrupted when the stream ends before a terminal event', async () => {
    const stream = streamOf([`event: turn.accepted\ndata: {"turnId":"${TURN_ID}","ordinal":1}\n\n`]);
    await expect(collect(readTurnStream(stream))).rejects.toMatchObject({ code: 'stream_interrupted' });
  });

  it('stops at turn.blocked and turn.error', async () => {
    const blocked = streamOf([
      `event: turn.blocked\ndata: {"turnId":"${TURN_ID}","reason":"safety","escalationId":null,"supportMessage":"Talk to a person"}\n\n`,
      'event: turn.status\ndata: {"phase":"reasoning","detail":null,"evidenceCount":null}\n\n',
    ]);
    expect((await collect(readTurnStream(blocked))).map((e) => e.event)).toEqual(['turn.blocked']);

    const failed = streamOf([
      'event: turn.error\ndata: {"turnId":null,"code":"model_unavailable","message":"Try again","retryable":true}\n\n',
    ]);
    expect((await collect(readTurnStream(failed)))[0]).toMatchObject({
      event: 'turn.error',
      retryable: true,
    });
  });

  it('aborts when the signal fires', async () => {
    const controller = new AbortController();
    let enqueue: ((chunk: Uint8Array) => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        enqueue = (chunk) => {
          c.enqueue(chunk);
        };
      },
    });
    const iterator = readTurnStream(stream, controller.signal);
    enqueue?.(
      new TextEncoder().encode(`event: turn.accepted\ndata: {"turnId":"${TURN_ID}","ordinal":1}\n\n`),
    );
    const first = await iterator.next();
    expect(first.value).toMatchObject({ event: 'turn.accepted' });
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });
});

describe('streamTurn', () => {
  let fetchMock: ReturnType<
    typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>
  >;
  beforeEach(() => {
    fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs with SSE accept, CSRF and body hash headers and yields events', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        streamOf([`event: turn.completed\ndata: ${JSON.stringify({ turn: completedTurn() })}\n\n`]),
        { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
      ),
    );
    const events = await collect(
      streamTurn(SESSION_ID, { text: 'Hello', mode: 'coach' }, { idempotencyKey: 'k1' }),
    );
    expect(events.map((e) => e.event)).toEqual(['turn.completed']);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/sessions/${SESSION_ID}/turns`);
    const headers = new Headers(init?.headers);
    expect(init?.method).toBe('POST');
    expect(headers.get('accept')).toContain('text/event-stream');
    expect(headers.get('x-requested-with')).toBe('foundry-ascent');
    expect(headers.get('x-amz-content-sha256')).toMatch(/^[0-9a-f]{64}$/);
    expect(headers.get('idempotency-key')).toBe('k1');
  });

  it('throws the problem+json error before streaming', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'x',
          title: 'Suspended',
          status: 423,
          code: 'persona_suspended',
          requestId: 'r-1',
        }),
        { status: 423, headers: { 'content-type': 'application/problem+json' } },
      ),
    );
    await expect(collect(streamTurn(SESSION_ID, { text: 'Hi' }))).rejects.toMatchObject({
      code: 'persona_suspended',
      status: 423,
      requestId: 'r-1',
    });
  });

  it('rejects a non-SSE success response', async () => {
    fetchMock.mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await expect(collect(streamTurn(SESSION_ID, { text: 'Hi' }))).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});
