import { EventStreamDecoder, encodeAudioEvent, payloadJson, type EventStreamMessage } from './event-stream';
import type { TranscriptResult } from './endpointing';

/**
 * One Amazon Transcribe streaming session over the presigned WebSocket URL our API mints (`SttGrant`).
 * Audio never passes through our API: the browser sends 16 kHz PCM as event-stream `AudioEvent`s straight to
 * AWS and receives `TranscriptEvent`s back. A presigned URL is valid for connecting only (at most five
 * minutes); an open stream keeps going, so a new URL is needed only to reconnect.
 */

export type WebSocketLike = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'binaryType'> & {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface TranscribeHandlers {
  onOpen(): void;
  onResult(result: TranscriptResult): void;
  /**
   * The stream stopped. `expected` is true after `end()`/`close()`; otherwise the socket dropped or
   * Transcribe sent an exception (the code is its exception type, e.g. `BadRequestException`).
   */
  onClose(info: { expected: boolean; code: string | null }): void;
}

const OPEN = 1;
/** Audio queued while the socket opens: about two seconds of 50 ms frames, so the first words survive. */
const MAX_PENDING_FRAMES = 40;
/** After the end-of-audio event, how long to wait for the last transcripts before closing. */
const END_GRACE_MS = 1500;

interface RawItem {
  Stable?: boolean;
  Type?: string;
}
interface RawResult {
  ResultId?: string;
  IsPartial?: boolean;
  Alternatives?: { Transcript?: string; Items?: RawItem[] }[];
}

/** Transcript results from one `TranscriptEvent` payload (unknown shapes yield nothing). */
export function transcriptResults(payload: unknown): TranscriptResult[] {
  const results = (payload as { Transcript?: { Results?: RawResult[] } } | null)?.Transcript?.Results;
  if (!Array.isArray(results)) return [];
  const out: TranscriptResult[] = [];
  for (const result of results) {
    const alternative = result.Alternatives?.[0];
    const text = alternative?.Transcript?.trim() ?? '';
    if (typeof result.ResultId !== 'string') continue;
    const items = alternative?.Items ?? [];
    const words = items.filter((item) => item.Type !== 'punctuation');
    out.push({
      resultId: result.ResultId,
      text,
      partial: result.IsPartial !== false,
      stable: result.IsPartial === false || (words.length > 0 && words.every((item) => item.Stable === true)),
    });
  }
  return out;
}

export class TranscribeStream {
  private readonly socket: WebSocketLike;
  private readonly decoder = new EventStreamDecoder();
  private readonly pending: Uint8Array[] = [];
  private closed = false;
  private ending = false;
  private exception: string | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    url: string,
    private readonly handlers: TranscribeHandlers,
    createSocket: WebSocketFactory = (target) => new WebSocket(target),
  ) {
    this.socket = createSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.socket.onopen = () => {
      if (this.closed) return;
      for (const frame of this.pending.splice(0)) this.socket.send(frame);
      this.handlers.onOpen();
    };
    this.socket.onmessage = (event) => {
      this.receive(event.data);
    };
    this.socket.onerror = () => {
      // The close event that follows carries the outcome.
    };
    this.socket.onclose = () => {
      this.finish(this.ending && this.exception === null);
    };
  }

  /** Sends one frame of 16-bit PCM (little-endian, mono, at the grant's sample rate). */
  sendPcm(pcm: Int16Array): void {
    if (this.closed || this.ending || pcm.length === 0) return;
    const frame = encodeAudioEvent(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    if (this.socket.readyState === OPEN) {
      this.socket.send(frame);
    } else {
      this.pending.push(frame);
      if (this.pending.length > MAX_PENDING_FRAMES) this.pending.shift();
    }
  }

  /** Ends the audio: Transcribe sends its last results, then the socket closes (or is closed for it). */
  end(): void {
    if (this.closed || this.ending) return;
    this.ending = true;
    if (this.socket.readyState === OPEN) {
      this.socket.send(encodeAudioEvent(new Uint8Array(0)));
      this.endTimer = setTimeout(() => {
        this.close();
      }, END_GRACE_MS);
    } else {
      this.close();
    }
  }

  /** Closes at once, without waiting for remaining results. */
  close(): void {
    if (this.closed) return;
    this.ending = true;
    try {
      this.socket.close(1000);
    } catch {
      /* already closing */
    }
    this.finish(true);
  }

  private finish(expected: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (this.endTimer !== null) clearTimeout(this.endTimer);
    this.pending.length = 0;
    this.handlers.onClose({ expected: expected && this.exception === null, code: this.exception });
  }

  private receive(data: unknown): void {
    if (this.closed || !(data instanceof ArrayBuffer)) return;
    let messages: EventStreamMessage[];
    try {
      messages = this.decoder.feed(new Uint8Array(data));
    } catch {
      this.exception = 'InvalidStream';
      this.socket.close(1000);
      this.finish(false);
      return;
    }
    for (const message of messages) {
      const type = message.headers[':message-type'];
      if (type === 'exception' || type === 'error') {
        const code = message.headers[':exception-type'] ?? message.headers[':error-code'];
        this.exception = typeof code === 'string' ? code : 'TranscribeError';
        continue;
      }
      if (message.headers[':event-type'] !== 'TranscriptEvent') continue;
      let payload: unknown;
      try {
        payload = payloadJson(message);
      } catch {
        continue;
      }
      for (const result of transcriptResults(payload)) this.handlers.onResult(result);
    }
  }
}
