import { LinearResampler } from '../pcm-stream';

/**
 * The speak channel of a HeyGen LiveAvatar LITE stock face, held by the page (docs/architecture/calls.md §4.4,
 * docs/runbooks/avatars.md). Written from the vendor's LITE events (docs.liveavatar.com/docs/lite-mode/events) and
 * what the conversation lab measured in the vendor's sandbox (run 42087743218):
 *
 * - **One socket per call.** The API hands the page `ws_url` (only for a stock face, never a likeness) in the
 *   authenticated avatar-session response; the page opens it once the room joined and sends nothing before
 *   `session.state_updated` `connected` (it comes once per socket, as text JSON). A second socket replaces the first
 *   (the vendor keeps one per session), so the page never opens two, and the server never opens one for this face.
 * - **Audio**: `agent.speak` `{audio}` is 16-bit mono little-endian PCM at 24 kHz in base64, about one second per
 *   message (48,000 bytes, 64,000 base64 characters; at most 1 MB a frame). The first `agent.speak` after
 *   `agent.speak_end` or `agent.interrupt` opens an utterance named by its `event_id`; every chunk of it carries the
 *   same id, and each is acknowledged by `agent.audio_buffer_appended` (source = the utterance id).
 *   `agent.speak_end` seals it (`agent.audio_buffer_committed`). The vendor says `agent.speak_started` about 0.44 s
 *   (p50) after the first chunk, the sound reaches the avatar's audio track about 0.11 s later, and
 *   `agent.speak_ended` follows the audio's end.
 * - **One utterance at a time.** A second utterance does not queue: it cuts the first. So a turn is one utterance
 *   (a pause of 1.3 s inside one was measured harmless), and a new one opens only once the last ended or was
 *   interrupted.
 * - **Interrupt**: `agent.interrupt` clears the buffered audio: `agent.speak_interrupted` (the utterance) and
 *   `agent.audio_buffer_cleared` (the interrupt's id) in ~74 ms, silence on the track ~389 ms later, and a
 *   `agent.speak_ended` for that utterance still follows (ignored).
 * - **Keep-alive**: the socket times out after 5 idle minutes; `session.keep_alive` (no answer) keeps it.
 *
 * This module is the socket and the audio framing only (pure where it can be); `lite-speaker.ts` decides what is
 * sent when.
 */

/** LITE's audio rate (16-bit mono). */
export const LITE_SAMPLE_RATE = 24_000;
/** Bytes per millisecond of LITE audio (24 kHz × 2 bytes). */
const BYTES_PER_MS = (LITE_SAMPLE_RATE * 2) / 1000;
/** One `agent.speak` message: about a second of audio, the size the vendor recommends. */
export const LITE_CHUNK_MS = 1_000;
export const LITE_CHUNK_BYTES = LITE_CHUNK_MS * BYTES_PER_MS;
/**
 * The first chunk of an utterance is smaller, so the face starts sooner: the lab measured first chunk → sound on the
 * avatar's track p50 432 ms at 200 ms of audio (556 ms at 400 ms, 672 ms at 1 s), with no starvation.
 */
export const LITE_FIRST_CHUNK_MS = 200;
export const LITE_FIRST_CHUNK_BYTES = LITE_FIRST_CHUNK_MS * BYTES_PER_MS;
/** WebSocket `OPEN`. */
const OPEN = 1;

/** Milliseconds of LITE audio in `bytes`. */
export function liteAudioMs(bytes: number): number {
  return bytes / BYTES_PER_MS;
}

/** Base64 of `bytes` (what `agent.speak` carries): 4 characters per 3 bytes, padded. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // In slices: `String.fromCharCode(...)` of a whole second (48,000 arguments) is near some engines' limit.
  for (let i = 0; i < bytes.length; i += 0x2000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x2000)));
  }
  return btoa(binary);
}

/**
 * Cuts one utterance's PCM into `agent.speak` chunks (pure): 16-bit mono little-endian at `fromRate` in (ElevenLabs
 * `pcm_24000` passes through byte for byte; Amazon Polly's 16 kHz is resampled once, continuously, to 24 kHz), and
 * chunks of {@link LITE_CHUNK_BYTES} out, the utterance's first one {@link LITE_FIRST_CHUNK_BYTES} (`first`). A byte
 * that splits a sample waits for the next piece; `flush` hands over whatever is left (a unit's end).
 */
export class LiteChunker {
  private readonly resampler: LinearResampler | null;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private carry: number | null = null;
  private firstDue: boolean;

  constructor(
    readonly fromRate: number,
    options: { readonly first: boolean },
  ) {
    this.resampler = fromRate === LITE_SAMPLE_RATE ? null : new LinearResampler(fromRate, LITE_SAMPLE_RATE);
    this.firstDue = options.first;
  }

  /** Bytes held back (not yet a whole chunk). */
  get held(): number {
    return this.pendingBytes;
  }

  /** The chunks `bytes` completes, in order. */
  push(bytes: Uint8Array): Uint8Array[] {
    const pcm = this.toLite(bytes);
    if (pcm.byteLength > 0) {
      this.pending.push(pcm);
      this.pendingBytes += pcm.byteLength;
    }
    const out: Uint8Array[] = [];
    for (;;) {
      const size = this.firstDue ? LITE_FIRST_CHUNK_BYTES : LITE_CHUNK_BYTES;
      if (this.pendingBytes < size) break;
      out.push(this.take(size));
      this.firstDue = false;
    }
    return out;
  }

  /** What is held, as one last (smaller) chunk; null when nothing is. */
  flush(): Uint8Array | null {
    if (this.pendingBytes === 0) return null;
    this.firstDue = false;
    return this.take(this.pendingBytes);
  }

  private take(size: number): Uint8Array {
    const chunk = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      const head = this.pending[0];
      if (head === undefined) break;
      const n = Math.min(size - filled, head.byteLength);
      chunk.set(head.subarray(0, n), filled);
      filled += n;
      if (n === head.byteLength) this.pending.shift();
      else this.pending[0] = head.subarray(n);
    }
    this.pendingBytes -= filled;
    return chunk;
  }

  /** Whole 16-bit samples of `bytes` at 24 kHz (a split sample's byte waits for the next piece). */
  private toLite(bytes: Uint8Array): Uint8Array {
    let data = bytes;
    if (this.carry !== null && bytes.byteLength > 0) {
      data = new Uint8Array(bytes.byteLength + 1);
      data[0] = this.carry;
      data.set(bytes, 1);
      this.carry = null;
    }
    const whole = data.byteLength - (data.byteLength % 2);
    if (whole < data.byteLength) this.carry = data[data.byteLength - 1] ?? null;
    if (whole === 0) return new Uint8Array(0);
    if (this.resampler === null) return data.slice(0, whole);
    const view = new DataView(data.buffer, data.byteOffset, whole);
    const samples = new Float32Array(whole / 2);
    for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true) / 32_768;
    const resampled = this.resampler.push(samples);
    const out = new Uint8Array(resampled.length * 2);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < resampled.length; i += 1) {
      const v = Math.round((resampled[i] ?? 0) * 32_768);
      outView.setInt16(i * 2, Math.max(-32_768, Math.min(32_767, v)), true);
    }
    return out;
  }
}

/** The part of a WebSocket the channel uses (the browser's; an in-page stand-in in tests and development). */
export interface LiteSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
}

/** The vendor's events that name a source (the utterance, or for `cleared` the interrupt). */
export type LiteSourceKind =
  'speak_started' | 'speak_ended' | 'speak_interrupted' | 'appended' | 'committed' | 'cleared';

/** What the vendor said on the channel, as the speaker reads it (`source`: the utterance or interrupt id). */
export type LiteEvent =
  | { readonly kind: LiteSourceKind; readonly source: string }
  /** A vendor error (its plain type only, never its message); `video_starvation` is a diagnostic, not a failure. */
  | { readonly kind: 'error'; readonly errorType: string }
  /** The socket closed or failed (not by the page). */
  | { readonly kind: 'closed' };

const EVENT_KINDS: Readonly<Record<string, LiteSourceKind>> = {
  'agent.speak_started': 'speak_started',
  'agent.speak_ended': 'speak_ended',
  'agent.speak_interrupted': 'speak_interrupted',
  'agent.audio_buffer_appended': 'appended',
  'agent.audio_buffer_committed': 'committed',
  'agent.audio_buffer_cleared': 'cleared',
};

interface WireEvent {
  readonly type?: unknown;
  readonly state?: unknown;
  readonly source_event_id?: unknown;
  readonly error?: { readonly type?: unknown } | null;
}

/** What the channel sent and heard, for the lab and the reconciliation (counts only). */
export interface LiteCounts {
  chunks: number;
  bytes: number;
  speakEnds: number;
  interrupts: number;
  keepAlives: number;
  appended: number;
  committed: number;
  started: number;
  ended: number;
  interrupted: number;
  errors: number;
}

/**
 * One open LITE speak channel: connects (open, then the vendor's `connected`), sends commands only once connected,
 * and reports the vendor's events by their source id. It never reconnects by itself and never logs the URL.
 */
export class LiteControl {
  private connected = false;
  private closedByUs = false;
  private gone = false;
  private readonly listeners = new Set<(event: LiteEvent) => void>();
  readonly counts: LiteCounts = {
    chunks: 0,
    bytes: 0,
    speakEnds: 0,
    interrupts: 0,
    keepAlives: 0,
    appended: 0,
    committed: 0,
    started: 0,
    ended: 0,
    interrupted: 0,
    errors: 0,
  };
  /** When a command was last sent (the keep-alive is due only on an idle channel). */
  lastSentAt = 0;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;

  constructor(
    private readonly socket: LiteSocket,
    private readonly deps: {
      readonly ids: () => string;
      readonly now: () => number;
    },
  ) {
    socket.addEventListener('message', (message) => {
      this.receive(message.data);
    });
    socket.addEventListener('error', () => {
      this.drop();
    });
    socket.addEventListener('close', () => {
      this.drop();
    });
  }

  /** Whether commands can be sent (connected, not closed). */
  get open(): boolean {
    return this.connected && !this.gone && this.socket.readyState === OPEN;
  }

  /** Resolves once the vendor said `connected`; rejects when the socket fails or closes first. */
  ready(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.gone) return Promise.reject(new Error('lite_closed'));
    return new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  on(listener: (event: LiteEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** One chunk of an utterance (`utteranceId` names it: the first chunk after an end or interrupt opens it). */
  speak(utteranceId: string, pcm: Uint8Array): void {
    this.send({ type: 'agent.speak', event_id: utteranceId, audio: bytesToBase64(pcm) });
    this.counts.chunks += 1;
    this.counts.bytes += pcm.byteLength;
  }

  /** Seals the utterance: the vendor plays out what it has, then says `speak_ended`. */
  speakEnd(utteranceId: string): void {
    this.send({ type: 'agent.speak_end', event_id: utteranceId });
    this.counts.speakEnds += 1;
  }

  /** Barge-in: the vendor drops what it still has to say. Returns the interrupt's id. */
  interrupt(): string {
    const id = this.deps.ids();
    this.send({ type: 'agent.interrupt', event_id: id });
    this.counts.interrupts += 1;
    return id;
  }

  /** Keeps an idle channel from timing out (no answer). */
  keepAlive(): void {
    this.send({ type: 'session.keep_alive', event_id: this.deps.ids() });
    this.counts.keepAlives += 1;
  }

  /** The page is done with the channel (the face ended). */
  close(): void {
    this.closedByUs = true;
    this.gone = true;
    this.readyReject?.(new Error('lite_closed'));
    this.readyResolve = null;
    this.readyReject = null;
    try {
      this.socket.close(1000);
    } catch {
      /* already closed */
    }
  }

  private send(command: Record<string, string>): void {
    if (!this.open) throw new Error('lite_not_open');
    this.socket.send(JSON.stringify(command));
    this.lastSentAt = this.deps.now();
  }

  private drop(): void {
    if (this.gone && this.closedByUs) return;
    const wasGone = this.gone;
    this.gone = true;
    this.readyReject?.(new Error('lite_closed'));
    this.readyResolve = null;
    this.readyReject = null;
    if (!wasGone) this.emit({ kind: 'closed' });
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    let event: WireEvent;
    try {
      event = JSON.parse(data) as WireEvent;
    } catch {
      return;
    }
    if (event.type === 'session.state_updated') {
      if (event.state === 'connected' && !this.connected) {
        this.connected = true;
        this.lastSentAt = this.deps.now();
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject = null;
      }
      if (event.state === 'disconnected') this.drop();
      return;
    }
    if (event.type === 'error') {
      const type = event.error?.type;
      const errorType = typeof type === 'string' && /^[a-z][a-z_]{0,39}$/.test(type) ? type : 'error';
      this.counts.errors += 1;
      this.emit({ kind: 'error', errorType });
      return;
    }
    const kind = typeof event.type === 'string' ? EVENT_KINDS[event.type] : undefined;
    if (kind === undefined || typeof event.source_event_id !== 'string') return;
    if (kind === 'appended') this.counts.appended += 1;
    if (kind === 'committed') this.counts.committed += 1;
    if (kind === 'speak_started') this.counts.started += 1;
    if (kind === 'speak_ended') this.counts.ended += 1;
    if (kind === 'speak_interrupted') this.counts.interrupted += 1;
    this.emit({ kind, source: event.source_event_id });
  }

  private emit(event: LiteEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
