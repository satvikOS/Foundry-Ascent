/**
 * Plays one unit of raw PCM speech (16-bit mono little-endian, `POST /speech` answering `audio/pcm`) as it arrives,
 * instead of waiting for the whole unit and decoding it: the bytes are read from the response as the server streams
 * them (ElevenLabs or Amazon Polly behind it), turned into float samples, resampled once to the AudioContext's own
 * rate, and scheduled back to back as `AudioBufferSourceNode`s on the call's AudioContext, through a gain of the unit's
 * own into the player's gain (→ analyser → speakers, so ducking and the level meter work as for any unit).
 *
 * - **No clicks at the joins.** The stream is 24 kHz (ElevenLabs) or 16 kHz (Polly); the context runs at 44.1 kHz
 *   (macOS Safari's default) or 48 kHz. Left to the browser, each piece would be resampled on its own and start at
 *   `n / 24000` s, which is no frame of a 44.1 kHz context: every join would cut the interpolator off and land
 *   between frames. Instead {@link LinearResampler} converts the whole unit in one continuous pass (its phase and
 *   last sample carry from one piece to the next), every buffer is made at the context's rate, and every piece
 *   starts on a whole frame right where the one before ends, so the pieces join sample for sample. The resampler is
 *   linear (enough for speech below 8-12 kHz; a polyphase filter or an AudioWorklet ring buffer can replace it here
 *   without touching the scheduling).
 * - **Fades, not cuts.** The newest piece always carries a {@link FADE_MS} fade-out at its end, cancelled the moment
 *   the next piece is joined on in time; so an underrun (the network fell behind) fades to silence instead of
 *   stopping dead, and the piece after it fades in. `stop()` fades the unit out over {@link STOP_FADE_MS} before its
 *   pieces stop.
 * - **Jitter buffer.** The first sound waits until {@link JITTER_MS} of audio is in hand (or the stream ended), so a
 *   late network packet does not cut a word; after that each piece is scheduled as soon as {@link SLICE_MS} of it is
 *   in hand, right after the one before.
 * - **Prefetch.** Reading starts when the stream is made (the player fetches units ahead): what arrives before the
 *   unit's turn is kept and played at once when its turn comes.
 * - **Stop.** `stop()` cancels the read, fades out and stops every scheduled piece at once (a piece not yet started
 *   never starts): nothing of the unit is heard after the fade, and nothing read after it is ever scheduled.
 */

/** Audio held before the first sound (absorbs network jitter; ElevenLabs' docs call ~0.1–0.2 s enough). */
export const JITTER_MS = 100;
/** The smallest piece scheduled once the unit is playing (fewer nodes; still well under a word). */
export const SLICE_MS = 40;
/** The fade at an underrun's edges: long enough to hide the step, too short to hear as a fade. */
export const FADE_MS = 4;
/** The fade when the unit is stopped (barge-in, hang-up): "at once", without the click of a hard cut. */
export const STOP_FADE_MS = 5;
/** How far ahead of `currentTime` a piece is started when nothing is queued before it. */
const LEAD_SECONDS = 0.01;
/**
 * A join is only made while the fade-out it cancels is still this far in the future: the render thread works a
 * quantum or two ahead of `currentTime` (128 frames ≈ 3 ms at 44.1 kHz), and a ramp it has begun is left to finish.
 */
const JOIN_MARGIN_SECONDS = 0.006;
/** Beyond the audio scheduled, how long the unit may take to report its end (a suspended context never ends it). */
const END_GUARD_MS = 1_500;

export interface PcmSink {
  readonly context: Pick<
    AudioContext,
    'createBuffer' | 'createBufferSource' | 'createGain' | 'currentTime' | 'sampleRate'
  >;
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

/**
 * A streaming linear resampler (pure): samples at `fromRate` in, samples at `toRate` out, one continuous signal
 * however the input is cut into pieces. Output sample `n` is read at input position `n × fromRate / toRate`, worked
 * out in whole numbers (no drift), and the last input sample of a piece is kept as the left neighbour of the next,
 * so piece boundaries leave no seam. At equal rates it is the identity.
 */
export class LinearResampler {
  /** Output samples made so far. */
  private produced = 0;
  /** Input samples received before the current piece (the index of its first sample). */
  private consumed = 0;
  /** The input sample just before the current piece. */
  private last = 0;

  constructor(
    readonly fromRate: number,
    readonly toRate: number,
  ) {}

  /**
   * The output for `input`: every output position up to its last sample (a position between that sample and the
   * next piece's first is made when the next piece comes).
   */
  push(input: Float32Array): Float32Array {
    if (this.fromRate === this.toRate) return input;
    const first = this.consumed;
    const total = first + input.length;
    const at = (i: number): number => (i < first ? this.last : (input[i - first] ?? 0));
    const out: number[] = [];
    for (;;) {
      const scaled = this.produced * this.fromRate;
      const i = Math.floor(scaled / this.toRate);
      const rest = scaled - i * this.toRate;
      // Interpolating needs the sample after `i`, unless the position is exactly on `i`.
      if (i > total - 1 || (rest !== 0 && i + 1 > total - 1)) break;
      const a = at(i);
      out.push(rest === 0 ? a : a + ((at(i + 1) - a) * rest) / this.toRate);
      this.produced += 1;
    }
    if (input.length > 0) this.last = input[input.length - 1] ?? 0;
    this.consumed = total;
    return Float32Array.from(out);
  }
}

export class PcmStream {
  readonly sampleRate: number;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  /** Samples read and not yet scheduled (at the stream's rate). */
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
  private resampler: LinearResampler | null = null;
  /** The unit's own gain (→ the player's gain): fades at underruns and on stop. */
  private gain: GainNode | null = null;
  private readonly sources = new Set<AudioBufferSourceNode>();
  /** The context frame the last scheduled piece ends on (pieces start on whole frames). */
  private nextFrame = 0;
  /** Where the newest piece's provisional fade-out starts (context time), or null when there is none. */
  private fadeOutAt: number | null = null;
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
    const rate = sink.context.sampleRate > 0 ? sink.context.sampleRate : this.sampleRate;
    this.resampler = new LinearResampler(this.sampleRate, rate);
    const gain = sink.context.createGain();
    gain.gain.value = 1;
    gain.connect(sink.destination);
    this.gain = gain;
    this.schedule();
    this.maybeFinish();
    return () => {
      this.stop();
    };
  }

  /**
   * Stops at once: the read is cancelled, the unit fades out over {@link STOP_FADE_MS} and every scheduled piece
   * stops at its end (one not yet started never starts), and nothing more is scheduled.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.reader.cancel().catch(() => undefined);
    this.pending = [];
    this.pendingSamples = 0;
    this.clearGuard();
    const sink = this.sink;
    const gain = this.gain;
    const sources = [...this.sources];
    this.sources.clear();
    if (sink === null || gain === null) return;
    const now = sink.context.currentTime;
    const end = now + STOP_FADE_MS / 1000;
    const param = gain.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(0, end);
    for (const source of sources) {
      source.onended = null;
      try {
        source.stop(end);
      } catch {
        /* not started */
      }
    }
    // Once the fade has played, the unit's nodes leave the graph.
    sink.setTimeout(() => {
      for (const source of sources) source.disconnect();
      gain.disconnect();
    }, STOP_FADE_MS + 20);
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
    const gain = this.gain;
    const resampler = this.resampler;
    if (sink === null || gain === null || resampler === null || this.stopped || this.pendingSamples === 0)
      return;
    const wanted = Math.round(((this.started ? SLICE_MS : JITTER_MS) / 1000) * this.sampleRate);
    if (!this.ended && this.pendingSamples < wanted) return;
    const input = new Float32Array(this.pendingSamples);
    let offset = 0;
    for (const part of this.pending) {
      input.set(part, offset);
      offset += part.length;
    }
    this.pending = [];
    this.pendingSamples = 0;
    const samples = resampler.push(input);
    if (samples.length === 0) return;

    const context = sink.context;
    const rate = resampler.toRate;
    const now = context.currentTime;
    const param = gain.gain;
    // Joined on to the piece before while its fade-out is still ahead (cancelled: the two play as one signal);
    // otherwise (the first piece, or an underrun) started fresh on a whole frame, fading in.
    const joined = this.fadeOutAt !== null && this.fadeOutAt > now + JOIN_MARGIN_SECONDS;
    let startFrame: number;
    if (joined && this.fadeOutAt !== null) {
      param.cancelScheduledValues(this.fadeOutAt);
      startFrame = this.nextFrame;
    } else {
      startFrame = Math.max(this.nextFrame, Math.ceil((now + LEAD_SECONDS) * rate));
    }
    const at = startFrame / rate;
    const duration = samples.length / rate;
    const end = (startFrame + samples.length) / rate;
    const fade = Math.min(FADE_MS / 1000, duration / 2);
    if (!joined) {
      param.setValueAtTime(0, at);
      param.linearRampToValueAtTime(1, at + fade);
    }
    // The newest piece fades out at its end unless the next one is joined on in time.
    param.setValueAtTime(1, end - fade);
    param.linearRampToValueAtTime(0, end);
    this.fadeOutAt = end - fade;
    this.nextFrame = startFrame + samples.length;

    const buffer = context.createBuffer(1, samples.length, rate);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
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
      const rate = this.resampler?.toRate ?? this.sampleRate;
      this.guard ??= sink.setTimeout(
        () => {
          this.guard = null;
          this.finish();
        },
        Math.max(0, this.nextFrame / rate - sink.context.currentTime) * 1000 + END_GUARD_MS,
      );
      return;
    }
    this.finish();
  }

  private finish(): void {
    if (this.finished || this.stopped) return;
    this.finished = true;
    this.clearGuard();
    this.gain?.disconnect();
    this.handlers?.onEnd(this.started);
  }

  private clearGuard(): void {
    if (this.guard === null) return;
    this.sink?.clearTimeout(this.guard);
    this.guard = null;
  }
}
