import { TurnStreamEvent, type CreateTurnRequest } from '@foundry/contracts';
import type { z } from 'zod';

import { path, sendRequest } from './client';
import { ApiError } from './errors';

/** One dispatched Server-Sent Events message. */
export interface SseFrame {
  /** `event:` field; "message" when absent. */
  event: string;
  /** All `data:` lines joined with "\n". */
  data: string;
  id: string | undefined;
  retry: number | undefined;
}

/**
 * Incremental SSE parser following the WHATWG event-stream rules: lines end in CRLF, LF or CR (a CR
 * at the end of one chunk followed by LF at the start of the next counts once), `:` lines are
 * comments (heartbeats), multiple `data:` lines are joined with "\n", one leading space after the
 * colon is stripped, and an empty line dispatches the event. Feed it decoded text in arbitrary chunks.
 */
export class SseParser {
  private buffer = '';
  private pendingCR = false;
  private started = false;
  private eventType = '';
  private dataLines: string[] = [];
  private hasData = false;
  private lastEventId: string | undefined;
  private retry: number | undefined;

  feed(chunk: string): SseFrame[] {
    let text = chunk;
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (this.pendingCR && text.startsWith('\n')) text = text.slice(1);
    this.pendingCR = false;

    this.buffer += text;
    const frames: SseFrame[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer.charCodeAt(i);
      if (ch !== 0x0a && ch !== 0x0d) continue;
      const line = this.buffer.slice(start, i);
      if (ch === 0x0d) {
        if (i + 1 < this.buffer.length) {
          if (this.buffer.charCodeAt(i + 1) === 0x0a) i++;
        } else {
          this.pendingCR = true;
        }
      }
      start = i + 1;
      const frame = this.processLine(line);
      if (frame) frames.push(frame);
    }
    this.buffer = this.buffer.slice(start);
    return frames;
  }

  /** Call at end of stream: dispatches a final event that was not followed by a blank line. */
  flush(): SseFrame[] {
    const frames: SseFrame[] = [];
    if (this.buffer.length > 0) {
      const frame = this.processLine(this.buffer);
      if (frame) frames.push(frame);
      this.buffer = '';
    }
    const last = this.dispatch();
    if (last) frames.push(last);
    return frames;
  }

  private processLine(line: string): SseFrame | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.eventType = value;
        break;
      case 'data':
        this.dataLines.push(value);
        this.hasData = true;
        break;
      case 'id':
        if (!value.includes('\u0000')) this.lastEventId = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.retry = Number.parseInt(value, 10);
        break;
      default:
        break;
    }
    return null;
  }

  private dispatch(): SseFrame | null {
    if (!this.hasData) {
      this.eventType = '';
      return null;
    }
    const frame: SseFrame = {
      event: this.eventType || 'message',
      data: this.dataLines.join('\n'),
      id: this.lastEventId,
      retry: this.retry,
    };
    this.eventType = '';
    this.dataLines = [];
    this.hasData = false;
    return frame;
  }
}

export type TurnStreamEventT = z.infer<typeof TurnStreamEvent>;
const KNOWN_EVENTS = new Set<string>(TurnStreamEvent.options.map((o) => o.shape.event.value));

/**
 * Validate one frame against the TurnStreamEvent contract. The event name may come from the `event:`
 * field, the JSON `event` property, or both (they must agree). Unknown event names (e.g. keep-alive
 * pings) return null and are ignored; a known event with an invalid payload throws `invalid_response`.
 */
export function parseTurnStreamFrame(frame: SseFrame): TurnStreamEventT | null {
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch (cause) {
    if (!KNOWN_EVENTS.has(frame.event)) return null;
    throw new ApiError({ status: 200, code: 'invalid_response', title: 'Malformed stream event', cause });
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    if (!KNOWN_EVENTS.has(frame.event)) return null;
    throw new ApiError({ status: 200, code: 'invalid_response', title: 'Malformed stream event' });
  }
  const record = payload as Record<string, unknown>;
  const name = typeof record.event === 'string' ? record.event : frame.event;
  if (!KNOWN_EVENTS.has(name)) return null;
  if (frame.event !== 'message' && frame.event !== name) {
    throw new ApiError({ status: 200, code: 'invalid_response', title: 'Stream event name mismatch' });
  }
  const parsed = TurnStreamEvent.safeParse({ ...record, event: name });
  if (!parsed.success) {
    throw new ApiError({
      status: 200,
      code: 'invalid_response',
      title: 'Stream event did not match the contract',
      detail: parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.map(String).join('.')} (${issue.code})`)
        .join(', '),
    });
  }
  return parsed.data;
}

const TERMINAL = new Set<TurnStreamEventT['event']>(['turn.completed', 'turn.blocked', 'turn.error']);

export function isTerminalTurnEvent(event: TurnStreamEventT): boolean {
  return TERMINAL.has(event.event);
}

/**
 * Read an SSE response body and yield validated turn events until a terminal event
 * (`turn.completed` / `turn.blocked` / `turn.error`). Throws `stream_interrupted` if the stream ends
 * first. Cancels the underlying reader when the consumer stops early or the signal aborts.
 */
export async function* readTurnStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<TurnStreamEventT, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = new SseParser();
  let finished = false;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      const frames = done
        ? [...parser.feed(decoder.decode()), ...parser.flush()]
        : parser.feed(decoder.decode(value, { stream: true }));
      for (const frame of frames) {
        const event = parseTurnStreamFrame(frame);
        if (!event) continue;
        yield event;
        if (isTerminalTurnEvent(event)) {
          finished = true;
          return;
        }
      }
      if (done) break;
    }
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    throw new ApiError({
      status: 200,
      code: 'stream_interrupted',
      title: 'The response stream ended before the turn finished',
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export type CreateTurnBody = z.input<typeof CreateTurnRequest>;

export interface StreamTurnOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}

/**
 * POST /sessions/:id/turns and stream its events (SSE over POST, so EventSource cannot be used).
 * Non-2xx responses throw ApiError before any event is yielded; `503 database_resuming` is waited out
 * by the shared client like any other request.
 */
export async function* streamTurn(
  sessionId: string,
  body: CreateTurnBody,
  options: StreamTurnOptions = {},
): AsyncGenerator<TurnStreamEventT, void, undefined> {
  const response = await sendRequest(path`/sessions/${sessionId}/turns`, {
    method: 'POST',
    body,
    signal: options.signal,
    idempotencyKey: options.idempotencyKey,
    accept: 'text/event-stream, application/problem+json',
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream') || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiError({
      status: response.status,
      code: 'invalid_response',
      title: 'Expected an event stream',
      requestId: response.headers.get('x-request-id') ?? undefined,
    });
  }
  yield* readTurnStream(response.body, options.signal);
}
