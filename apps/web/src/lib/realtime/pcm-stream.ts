/**
 * Plays one unit of raw PCM speech (16-bit mono little-endian, `POST /speech` answering `audio/pcm`) as it arrives,
 * instead of waiting for the whole unit and decoding it: the bytes are read from the response as the server streams
 * them (ElevenLabs or Amazon Polly behind it), turned into float samples, and scheduled back to back as
 * `AudioBufferSourceNode`s on the call's AudioContext, into the player's gain (→ analyser → speakers, so ducking and
 * the level meter work as for any unit).
 *
 * - **Jitter buffer.** The first sound waits until {@link JITTER_MS} of audio is in hand (or the stream ended), so a
 *   late network packet does not cut a word; after that each piece is scheduled as soon as {@link SLICE_MS} of it is
 *   in hand, right after the one before (an underrun leaves a short gap, never an overlap).
 * - **Prefetch.** Reading starts when the stream is made (the player fetches units ahead): what arrives before the
 *   unit's turn is kept and played at once when its turn comes.
 * - **Stop.** `stop()` cancels the read and stops every scheduled piece at once: nothing of the unit plays after it,
 *   and nothing read after it is ever scheduled.
 */

/** Audio held before the first sound (absorbs network jitter; ElevenLabs' docs call ~0.1–0.2 s enough). */
export const JITTER_MS = 100;
/** The smallest piece scheduled once the unit is playing (fewer nodes; still well under a word). */
export const SLICE_MS = 40;
/** How far ahead of `currentTime` a piece is started when nothing is queued before it. */
const LEAD_SECONDS = 0.01;
/** Beyond the audio scheduled, how long the unit may take to report its end (a suspended context never ends it). */
const END_GUARD_MS = 1_500;

export interface PcmSink {
  readonly context: Pick<AudioContext, 'createBuffer' | 'createBufferSource' | 'currentTime'>;
  /** The player's gain (→ analyser → speakers). */
  readonly destination: AudioNode;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PcmPlayHandlers {
  /** The unit's first piece is scheduled (captions and the first-audio time follow this). */
  onStart(): void;
  /** Everything scheduled has played and the stream ended; `heard` is false when no audio came at all. */
  onEnd(heard: boolean): void;
}

export class PcmStream {
  readonly sampleRate: number;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  /** Samples read and not yet scheduled. */
  private pending: Float32Array[] = [];
  private pendingSamples = 0;
  /** The odd byte of a chunk that split a sample. */
  private carry: number | null = null;
  private ended = false;
  private stopped = false;
  private finished = false;
  private started = false;
  private sink: PcmSink | null = null;
  private handlers: PcmPlayHandlers | null = null;
  private readonly sources = new Set<AudioBufferSourceNode>();
  /** When the last scheduled piece ends (context time). */
  private nextAt = 0;
  private guard: unknown = null;
  /** Samples received in all (tests and timing). */
  received = 0;

  constructor(body: ReadableStream<Uint8Array>, sampleRate: number) {
    this.sampleRate = sampleRate;
    this.reader = body.getReader();
    void this.pump();
  }

  /** Starts making the unit heard into `sink`; returns the function that stops it at once. */
  play(sink: PcmSink, handlers: PcmPlayHandlers): () => void {
    this.sink = sink;
    this.handlers = handlers;
    this.schedule();
    this.maybeFinish();
    return () => {
      this.stop();
    };
  }

  /** Stops at once: the read is cancelled, every scheduled piece stops, nothing more is scheduled. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.reader.cancel().catch(() => undefined);
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* not started */
      }
      source.disconnect();
    }
    this.sources.clear();
    this.pending = [];
    this.pendingSamples = 0;
    this.clearGuard();
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const next = await this.reader.read();
        if (this.stopped) return;
        if (next.done) break;
        this.push(next.value);
        this.schedule();
      }
    } catch {
      // A dropped connection or an abort: what arrived still plays (an abort has stopped everything already).
    }
    if (this.stopped) return;
    this.ended = true;
    this.schedule();
    this.maybeFinish();
  }

  /** Bytes → float samples, keeping an odd trailing byte for the next chunk. */
  private push(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    let data = bytes;
    if (this.carry !== null) {
      const joined = new Uint8Array(bytes.byteLength + 1);
      joined[0] = this.carry;
      joined.set(bytes, 1);
      data = joined;
      this.carry = null;
    }
    const whole = data.byteLength - (data.byteLength % 2);
    if (whole < data.byteLength) this.carry = data[data.byteLength - 1] ?? null;
    const count = whole / 2;
    if (count === 0) return;
    const view = new DataView(data.buffer, data.byteOffset, whole);
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i += 1) samples[i] = view.getInt16(i * 2, true) / 32_768;
    this.pending.push(samples);
    this.pendingSamples += count;
    this.received += count;
  }

  /** Schedules what is in hand once enough of it is (all of it once the stream ended). */
  private schedule(): void {
    const sink = this.sink;
    if (sink === null || this.stopped || this.pendingSamples === 0) return;
    const wanted = Math.round(((this.started ? SLICE_MS : JITTER_MS) / 1000) * this.sampleRate);
    if (!this.ended && this.pendingSamples < wanted) return;
    const samples = new Float32Array(this.pendingSamples);
    let offset = 0;
    for (const part of this.pending) {
      samples.set(part, offset);
      offset += part.length;
    }
    this.pending = [];
    this.pendingSamples = 0;
    const buffer = sink.context.createBuffer(1, samples.length, this.sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = sink.context.createBufferSource();
    source.buffer = buffer;
    source.connect(sink.destination);
    const at = Math.max(this.nextAt, sink.context.currentTime + LEAD_SECONDS);
    this.nextAt = at + samples.length / this.sampleRate;
    source.onended = () => {
      source.onended = null;
      source.disconnect();
      this.sources.delete(source);
      this.maybeFinish();
    };
    this.sources.add(source);
    source.start(at);
    if (!this.started) {
      this.started = true;
      this.handlers?.onStart();
    }
  }

  private maybeFinish(): void {
    const sink = this.sink;
    if (sink === null || this.stopped || this.finished || !this.ended || this.pendingSamples > 0) return;
    if (this.sources.size > 0) {
      // A suspended context never ends its sources: the guard keeps the call from waiting forever.
      this.guard ??= sink.setTimeout(
        () => {
          this.guard = null;
          this.finish();
        },
        Math.max(0, this.nextAt - sink.context.currentTime) * 1000 + END_GUARD_MS,
      );
      return;
    }
    this.finish();
  }

  private finish(): void {
    if (this.finished || this.stopped) return;
    this.finished = true;
    this.clearGuard();
    this.handlers?.onEnd(this.started);
  }

  private clearGuard(): void {
    if (this.guard === null) return;
    this.sink?.clearTimeout(this.guard);
    this.guard = null;
  }
}
