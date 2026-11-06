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
 * The longest the turn's stream ever waits for the turn's voice checks (`prepareTurnVoice`, started when the turn was
 * accepted, so normally done long before the first unit), once per turn: the first unit that finds them unfinished
 * waits at most this long, and after that no event waits for them again. A unit written while they are unfinished goes
 * to `POST /speech` as before; once they are done, the units after it are voiced here.
 */
export const PREPARE_WAIT_MS = 400;

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
 * page closes the stream; the deadline) stops every synthesis at once and sends nothing more of it. A turn that ends
 * blocked or failed is withdrawn ({@link TurnAudio.withdraw}): nothing more of it is synthesized, billed or sent, as
 * `POST /speech` refuses such a turn's units. A unit it does not take is sent unchanged, and the page asks
 * `POST /speech` for it as before.
 */
export class TurnAudio {
  readonly #voice: () => Promise<TurnVoice | null> | null;
  readonly #signal: AbortSignal;
  readonly #push: (event: TurnStreamEvent) => void;
  readonly #logger: Logger;
  readonly #requestId: string;
  readonly #pending = new Set<Promise<void>>();
  readonly #waiting: (() => void)[] = [];
  readonly #prepareWaitMs: number;
  /** Per turn (lower-cased id): aborted by the stream's signal or by {@link withdraw}. */
  readonly #turns = new Map<string, AbortController>();
  /** The turns withdrawn (lower-cased ids). */
  readonly #withdrawn = new Set<string>();
  /** The turn's voice once its checks finished (null inside: none here). */
  #settled: { readonly voice: TurnVoice | null } | null = null;
  /** The one bounded wait for the checks (shared; never started again once it ended). */
  #wait: Promise<void> | null = null;
  #waited = false;
  #free = VOICE_AHEAD;
  /** The words of the turn's previous unit (prosody context for the next). */
  #previous: { readonly turnId: string; readonly text: string } | null = null;
  readonly stats = { units: 0, frames: 0, bytes: 0, failed: 0, withdrawn: 0 };

  constructor(args: {
    /** The turn's voice once it was prepared (null before the turn was accepted, or when none was asked for). */
    readonly voice: () => Promise<TurnVoice | null> | null;
    readonly signal: AbortSignal;
    /** Hands a frame to the stream (after every event announced before it). */
    readonly push: (event: TurnStreamEvent) => void;
    readonly logger: Logger;
    readonly requestId: string;
    /** {@link PREPARE_WAIT_MS} (tests). */
    readonly prepareWaitMs?: number;
  }) {
    this.#voice = args.voice;
    this.#signal = args.signal;
    this.#push = args.push;
    this.#logger = args.logger;
    this.#requestId = args.requestId;
    this.#prepareWaitMs = args.prepareWaitMs ?? PREPARE_WAIT_MS;
  }

  /**
   * `event` as it is written: a unit this turn voices carries `audio: true`, and `start` (called once it was handed to
   * the stream) begins its audio. Anything else passes unchanged. Never throws.
   */
  async announce(event: TurnStreamEvent): Promise<{ event: TurnStreamEvent; start: (() => void) | null }> {
    // A unit admitted to a face as it was signed (`face: true`) is voiced here too when the turn's voice takes it: only
    // a LITE face the page feeds can be one then (a FULL face's turn has no voice here), and it plays this same PCM.
    if (event.event !== 'turn.speech' || this.#aborted() || this.#turn(event.turnId).signal.aborted)
      return { event, start: null };
    const previous = this.#previous?.turnId === event.turnId ? this.#previous.text : undefined;
    this.#previous = { turnId: event.turnId, text: event.text };
    const voice = await this.#ready();
    if (
      voice === null ||
      this.#aborted() ||
      this.#turn(event.turnId).signal.aborted ||
      !voice.voices(event.text)
    )
      return { event, start: null };
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

  /**
   * The turn `turnId` ended blocked (not crisis support) or failed (`turnId` null: every turn of this stream): what is
   * not yet synthesized never is (its reservation is never made, or given back), a synthesis in flight is aborted (a
   * vendor stream already billed is cancelled; its bookkeeping still runs), no more of its PCM is sent, and each of its
   * open units is closed with `end: 'refused'` (asked for at `POST /speech`, it is refused: `turn_not_speakable`).
   * Called before the terminal event is written, so no PCM of the turn follows that event. Never throws.
   */
  withdraw(turnId: string | null): void {
    if (turnId === null) {
      for (const [key, controller] of this.#turns) {
        this.#withdrawn.add(key);
        controller.abort();
      }
      // A unit of no turn seen yet cannot start either.
      this.#withdrawn.add('*');
      return;
    }
    const key = turnId.toLowerCase();
    this.#withdrawn.add(key);
    this.#turn(turnId).abort();
  }

  /** Read anew each time: the stream may be aborted while a unit waits or sends. */
  #aborted(): boolean {
    return this.#signal.aborted;
  }

  /** The turn's own controller, aborted with the stream (created on first use). */
  #turn(turnId: string): AbortController {
    const key = turnId.toLowerCase();
    let controller = this.#turns.get(key);
    if (controller === undefined) {
      controller = new AbortController();
      this.#turns.set(key, controller);
      if (this.#withdrawn.has('*')) {
        this.#withdrawn.add(key);
        controller.abort();
      } else if (this.#signal.aborted) controller.abort();
      else {
        const linked = controller;
        this.#signal.addEventListener(
          'abort',
          () => {
            linked.abort();
          },
          { once: true },
        );
      }
    }
    return controller;
  }

  /**
   * The turn's voice when its checks are done. The first unit that finds them unfinished waits for them at most
   * {@link PREPARE_WAIT_MS}; after that nothing waits (a unit written meanwhile goes to `POST /speech`), so a slow
   * prepare (an Aurora resume, a slow Data API) holds the stream back once per turn at most, never once per unit.
   */
  async #ready(): Promise<TurnVoice | null> {
    if (this.#settled !== null) return this.#settledVoice();
    const voice = this.#voice();
    if (voice === null) return null;
    if (this.#wait === null) {
      // Registered first, so the outcome is known by the time the wait below ends with it.
      voice.then(
        (v) => {
          this.#settled = { voice: v };
        },
        () => {
          this.#settled = { voice: null };
        },
      );
      let timer: NodeJS.Timeout | undefined;
      this.#wait = Promise.race([
        voice.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.#prepareWaitMs);
        }),
      ]).finally(() => {
        clearTimeout(timer);
      });
    }
    if (!this.#waited) {
      this.#waited = true;
      await this.#wait;
    }
    return this.#settledVoice();
  }

  /** The voice the checks settled on so far (read anew: set by the prepare's own callbacks). */
  #settledVoice(): TurnVoice | null {
    return this.#settled?.voice ?? null;
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
    // Aborted by the stream's signal (barge-in, the deadline) or by `withdraw` (the turn blocked or failed).
    const turn = this.#turn(turnId).signal;
    // Read anew each time: the turn may be withdrawn or the stream aborted while a unit waits or sends.
    const stopped = (): boolean => turn.aborted;
    let end: AudioEnd = 'failed';
    let sent = false;
    let acquired = false;
    try {
      if (!stopped()) {
        await this.#acquire();
        acquired = true;
      }
      if (stopped()) return;
      const result = await voice.speak(
        { turnId, seq, text: unit.text, sig: unit.sig },
        { signal: turn, ...(previousText === undefined ? {} : { previousText }) },
      );
      if (result.kind !== 'audio') {
        end = result.kind;
        return;
      }
      const reader = result.audio.getReader();
      // Aborted while a read waits on the vendor: cancelled at once (the waiting read ends), not at its next bytes.
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      if (stopped()) cancel();
      else turn.addEventListener('abort', cancel, { once: true });
      for (;;) {
        if (stopped()) {
          // Barge-in, the deadline or a withdrawn turn: the vendor stream is cancelled (its bookkeeping still runs)
          // and nothing more is sent.
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
          if (stopped()) break;
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
      turn.removeEventListener('abort', cancel);
      end = sent ? 'done' : 'failed';
    } catch (err) {
      this.#logger.warn('turn.audio_failed', {
        requestId: this.#requestId,
        turnId,
        seq,
        error: err instanceof Error ? err.name : 'unknown',
      });
    } finally {
      if (acquired) this.#release();
      // A withdrawn turn's unit is refused (never asked again: `POST /speech` refuses it too).
      const withdrawn = this.#withdrawn.has(turnId.toLowerCase());
      const closed: AudioEnd = withdrawn ? 'refused' : sent ? 'done' : end;
      if (withdrawn) this.stats.withdrawn += 1;
      else if (closed !== 'done') this.stats.failed += 1;
      // Always closed, so the page never waits for a unit (a failed one is asked from `POST /speech`).
      this.#push({ event: 'turn.audio', turnId, seq, end: closed });
    }
  }
}
