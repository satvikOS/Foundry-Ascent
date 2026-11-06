import { type TurnStreamEvent } from '@foundry/contracts';
import { type TurnVoice } from '@foundry/core';

import { type Logger } from '../logging.js';

/**
 * Units synthesized at once: the one being sent and the next (the call screen used to fetch as far ahead from
 * `POST /speech`), so the next unit's audio is in hand when the one before ends, without a vendor stream per unit.
 */
export const VOICE_AHEAD = 2;
/** The most PCM one `turn.audio` frame carries (bytes; base64 makes it a third longer). */
export const MAX_FRAME_BYTES = 32_768;
/**
 * How long a unit waits for the turn's voice checks (`prepareTurnVoice`, started when the turn was accepted, so
 * normally done long before the first unit) before it is left to `POST /speech` as before.
 */
export const PREPARE_WAIT_MS = 3_000;

type AudioEnd = NonNullable<Extract<TurnStreamEvent, { event: 'turn.audio' }>['end']>;
type SpeechEvent = Extract<TurnStreamEvent, { event: 'turn.speech' }>;

/**
 * Speech inside a spoken turn's own stream (docs/runbooks/latency.md): each signed `turn.speech` unit the turn's voice
 * takes (`TurnVoice`, checked once per turn) is announced with `audio: true`, and the moment it was written its
 * synthesis starts on the server (reserved, then ElevenLabs or Amazon Polly streaming raw PCM, the unit before it as
 * context). Its audio follows in the same stream as `turn.audio` frames (base64 PCM, the rate on the first, a closing
 * frame), so the page plays it as it arrives with no `POST /speech` and none of that request's checks on the way to
 * the first sound; a LITE face the page feeds takes a copy of the same PCM (no second synthesis). At most
 * {@link VOICE_AHEAD} units synthesize at once, in order. Aborting `signal` (barge-in: the
 * page closes the stream; the deadline) stops every synthesis at once and sends nothing more of it. A unit it does not
 * take is sent unchanged, and the page asks `POST /speech` for it as before.
 */
export class TurnAudio {
  readonly #voice: () => Promise<TurnVoice | null> | null;
  readonly #signal: AbortSignal;
  readonly #push: (event: TurnStreamEvent) => void;
  readonly #logger: Logger;
  readonly #requestId: string;
  readonly #pending = new Set<Promise<void>>();
  readonly #waiting: (() => void)[] = [];
  #free = VOICE_AHEAD;
  /** The words of the turn's previous unit (prosody context for the next). */
  #previous: { readonly turnId: string; readonly text: string } | null = null;
  readonly stats = { units: 0, frames: 0, bytes: 0, failed: 0 };

  constructor(args: {
    /** The turn's voice once it was prepared (null before the turn was accepted, or when none was asked for). */
    readonly voice: () => Promise<TurnVoice | null> | null;
    readonly signal: AbortSignal;
    /** Hands a frame to the stream (after every event announced before it). */
    readonly push: (event: TurnStreamEvent) => void;
    readonly logger: Logger;
    readonly requestId: string;
  }) {
    this.#voice = args.voice;
    this.#signal = args.signal;
    this.#push = args.push;
    this.#logger = args.logger;
    this.#requestId = args.requestId;
  }

  /**
   * `event` as it is written: a unit this turn voices carries `audio: true`, and `start` (called once it was handed to
   * the stream) begins its audio. Anything else passes unchanged. Never throws.
   */
  async announce(event: TurnStreamEvent): Promise<{ event: TurnStreamEvent; start: (() => void) | null }> {
    // A unit admitted to a face as it was signed (`face: true`) is voiced here too when the turn's voice takes it: only
    // a LITE face the page feeds can be one then (a FULL face's turn has no voice here), and it plays this same PCM.
    if (event.event !== 'turn.speech' || this.#aborted()) return { event, start: null };
    const previous = this.#previous?.turnId === event.turnId ? this.#previous.text : undefined;
    this.#previous = { turnId: event.turnId, text: event.text };
    const voice = await this.#ready();
    if (voice === null || this.#aborted() || !voice.voices(event.text)) return { event, start: null };
    this.stats.units += 1;
    return {
      event: { ...event, audio: true },
      start: () => {
        const running = this.#say(voice, event, previous).finally(() => {
          this.#pending.delete(running);
        });
        this.#pending.add(running);
      },
    };
  }

  /** Resolves once every announced unit's audio was sent, or given up (its closing frame sent). */
  async drained(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }

  /** Read anew each time: the stream may be aborted while a unit waits or sends. */
  #aborted(): boolean {
    return this.#signal.aborted;
  }

  async #ready(): Promise<TurnVoice | null> {
    const voice = this.#voice();
    if (voice === null) return null;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        voice.catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            resolve(null);
          }, PREPARE_WAIT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #acquire(): Promise<void> {
    if (this.#free > 0) {
      this.#free -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#waiting.push(resolve);
    });
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next === undefined) this.#free += 1;
    else next();
  }

  async #say(voice: TurnVoice, unit: SpeechEvent, previousText: string | undefined): Promise<void> {
    const { turnId, seq } = unit;
    let end: AudioEnd = 'failed';
    let sent = false;
    await this.#acquire();
    try {
      if (this.#aborted()) return;
      const result = await voice.speak(
        { turnId, seq, text: unit.text, sig: unit.sig },
        { signal: this.#signal, ...(previousText === undefined ? {} : { previousText }) },
      );
      if (result.kind !== 'audio') {
        end = result.kind;
        return;
      }
      const reader = result.audio.getReader();
      for (;;) {
        if (this.#aborted()) {
          // Barge-in or the deadline: the vendor stream is cancelled (its bookkeeping still runs) and nothing more is sent.
          await reader.cancel().catch(() => undefined);
          break;
        }
        let next: Awaited<ReturnType<typeof reader.read>>;
        try {
          next = await reader.read();
        } catch {
          // A voice that broke after its first audio: the unit ends where its audio stopped (as `POST /speech` does).
          break;
        }
        if (next.done) break;
        for (let offset = 0; offset < next.value.byteLength; offset += MAX_FRAME_BYTES) {
          const piece = next.value.subarray(
            offset,
            Math.min(next.value.byteLength, offset + MAX_FRAME_BYTES),
          );
          if (this.#aborted()) break;
          this.#push({
            event: 'turn.audio',
            turnId,
            seq,
            pcm: Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength).toString('base64'),
            ...(sent ? {} : { sampleRate: result.sampleRateHertz }),
          });
          sent = true;
          this.stats.frames += 1;
          this.stats.bytes += piece.byteLength;
        }
      }
      end = sent ? 'done' : 'failed';
    } catch (err) {
      this.#logger.warn('turn.audio_failed', {
        requestId: this.#requestId,
        turnId,
        seq,
        error: err instanceof Error ? err.name : 'unknown',
      });
    } finally {
      this.#release();
      if (end !== 'done') this.stats.failed += 1;
      // Always closed, so the page never waits for a unit (a failed one is asked from `POST /speech`).
      this.#push({ event: 'turn.audio', turnId, seq, end: sent ? 'done' : end });
    }
  }
}
