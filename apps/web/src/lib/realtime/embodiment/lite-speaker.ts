import { speakingTimeMs, type FaceRenderHandlers, type SpeechUnitToPlay } from '../playback';
import { LiteChunker, liteAudioMs, type LiteControl, type LiteCounts, type LiteEvent } from './lite-socket';

/**
 * What a LITE stock face fed by the page says, and when (docs/architecture/calls.md §4.4): the call's validated
 * speech, as each admitted unit's ElevenLabs PCM arrives from `/speech`, forwarded over the page's one speak channel
 * (`lite-socket.ts`), so the founder hears the avatar's own lip-synced audio track and nothing else.
 *
 * - **Admission.** Only a unit the server admitted is forwarded: one it admitted as it signed it (`faceApproved`,
 *   face pre-approval) at once, any other signed unit (the intro) once `POST /calls/:id/face/say` said 204 (asked
 *   in order). A unit without a signature, or refused, is never forwarded: the call plays it itself.
 * - **One utterance per turn.** The vendor's second utterance cuts the first (it never queues), so all of a turn's
 *   units go into one utterance: the first unit opens it when the call reaches it, and each next unit of the same
 *   turn is appended the moment the one before it was forwarded (no gap between sentences); `agent.speak_end`
 *   goes after the turn's last unit (`endTurn`), or after the forwarded audio played out and nothing followed
 *   ({@link IDLE_CLOSE_MS}). A new turn's utterance never opens while another is open: it waits for that one's
 *   `speak_ended` (or its interrupt). PCM is cut into ~1 s chunks, the utterance's first one 200 ms.
 * - **When a unit is heard.** The utterance's first unit starts at `agent.speak_started` (or the avatar track's
 *   level, whichever first; the level counts only once the track was quiet after the utterance's first chunk and
 *   at least {@link ONSET_HOLD_MS} after a barge-in or a fallback, so the tail of the audio just interrupted, which
 *   still sounds on the track for ~389 ms, is never taken for the new utterance's start); every later one where the audio sent before it ends, from the times each chunk was
 *   sent and the vendor's own lag; the turn's last one ends at `agent.speak_ended`. Captions and the call's "heard"
 *   bookkeeping follow these (`FaceRenderHandlers`).
 * - **Barge-in** (`halt`): the face's element goes silent at once, `agent.interrupt` goes out, everything not yet
 *   forwarded is dropped, and the server is told (bookkeeping). The `speak_ended` that still follows an interrupt
 *   is ignored, and the element sounds again only at the next utterance's `speak_started`.
 * - **Fallback, never both, never twice.** No `speak_started` within {@link LITE_STALL_MS} of the utterance's first
 *   chunk, a vendor error, or the channel closing: the element is silenced and the vendor interrupted first, then
 *   every unit not yet heard is given back to the call, which plays the PCM it holds from the unit's start (units
 *   already heard are never repeated). A unit the avatar was saying is given back `cut` at the point heard (from
 *   where each chunk played), and the call plays only its rest from its own copy. The rest of that turn stays with
 *   the call. A closed channel, or a second stall, ends the face's speaking for the call (`onBroken`): the call
 *   goes on with the presence.
 * - **Time limit.** A new turn's utterance never opens when the session's time left (`remainingMs`, the vendor's
 *   `max_session_duration`; about a minute in the sandbox) is shorter than an estimate of that turn: the face hands
 *   over to the call between turns (`onBroken('time_limit')`), instead of being cut off mid-sentence.
 * - **Keep-alive**: `session.keep_alive` once a minute while no utterance is open.
 */

/** No `speak_started` this long after an utterance's first chunk: the face is given up for that turn. */
export const LITE_STALL_MS = 2_000;
/** `session.keep_alive` at most this often, while idle (the vendor's idle timeout is 5 minutes). */
export const LITE_KEEPALIVE_MS = 60_000;
/** How often the keep-alive is checked. */
const KEEPALIVE_CHECK_MS = 15_000;
/**
 * An open utterance whose audio played out and that got nothing more for this long is ended: a turn still under way
 * may send its next sentence late (the lab measured a 1.3 s pause inside one utterance as harmless), a finished
 * turn whose last unit the call said itself has nothing more to send.
 */
export const IDLE_CLOSE_MS = 3_000;
const IDLE_CLOSE_ENDED_TURN_MS = 300;
/** Beyond its estimated end, how long a sealed utterance's `speak_ended` is waited for before the next opens. */
const CLOSE_WAIT_MS = 2_500;
/** First chunk sent → `speak_started`, until measured (lab p50 444 ms). */
const DEFAULT_LAG_MS = 450;
const TICK_MS = 40;
/** The avatar track's level above which it counts as sounding. */
const ONSET_LEVEL = 0.01;
/**
 * After a barge-in or a fallback, how long the avatar track's level is not taken as a new utterance's start: the
 * interrupted audio still sounds on the track for ~389 ms (lab), and the tap measures the track before the mute.
 */
export const ONSET_HOLD_MS = 700;
/** The shortest turn assumed when deciding whether a new utterance still fits the session's time left. */
export const LITE_HANDOVER_MIN_MS = 6_000;
/** Added to a turn whose units have not all reached the call yet (more sentences may follow). */
const TURN_TAIL_MS = 2_000;
/** Turns whose utterance count is kept for the lab's report. */
const TURNS_KEPT = 64;

export interface LiteSpeakerDeps {
  readonly control: LiteControl;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
  /** An utterance's id (its first chunk's `event_id`). */
  ids(): string;
  /** The server's admission of a signed unit it did not pre-approve (`POST /calls/:id/face/say`); rejects when refused. */
  admit(unit: SpeechUnitToPlay, signal: AbortSignal): Promise<void>;
  /** The face's element goes silent at once (barge-in, a fallback). */
  silence(): void;
  /** The face's element sounds again (the next utterance started). */
  unsilence(): void;
  /** The avatar's audio track level now (RMS, 0–1). */
  level(): number;
  /**
   * The face can no longer be fed: the channel closed, it stalled twice, or the session's time left is too short
   * for the next turn (`time_limit`, handed over between turns).
   */
  onBroken(reason: LiteBrokenReason): void;
  /** The session's time left (ms); unknown: Infinity. */
  remainingMs?(): number;
  /** Barge-in reached the vendor (the server is told, for its bookkeeping). */
  onInterrupt?(): void;
}

export type LiteBrokenReason = 'control_lost' | 'speech_stalled' | 'time_limit';

/** What the speaker did in this call (counts only; the lab reads it). */
export interface LiteReport {
  /** Utterances opened, in all and per turn (`intro` for the call's greeting). */
  readonly utterances: number;
  readonly utterancesByTurn: Readonly<Record<string, number>>;
  readonly unitsForwarded: number;
  /** Units given back to the call (stall, error, a closed channel, refused admission). */
  readonly fallbacks: number;
  /** Units given back partway through (the call played only the rest). */
  readonly cuts: number;
  readonly stalls: number;
  readonly interrupts: number;
  /** First chunk sent → `speak_started`, per utterance that started (ms). */
  readonly startLagMs: readonly number[];
  readonly counts: Readonly<LiteCounts>;
}

interface Utterance {
  readonly id: string;
  readonly turn: string;
  /** Each chunk sent: when, and how long its audio is. */
  readonly chunks: { readonly sentAt: number; readonly ms: number }[];
  startedAt: number | null;
  /** The avatar track was seen quiet since the first chunk (outside the hold after a cut): its level may start it. */
  quietSeen: boolean;
  /** `agent.speak_end` was sent. */
  sealed: boolean;
  endedAt: number | null;
  /** When it was sealed (the wait for its `speak_ended` is bounded from here). */
  sealedAt: number | null;
  stallTimer: unknown;
}

interface Fed {
  readonly key: string;
  readonly unit: SpeechUnitToPlay;
  readonly turn: string;
  readonly rate: number;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  /** Read and not yet forwarded. */
  buffered: Uint8Array[];
  streamDone: boolean;
  admission: 'pending' | 'yes' | 'no';
  state: 'waiting' | 'forwarding' | 'forwarded' | 'failed';
  utterance: Utterance | null;
  chunker: LiteChunker | null;
  firstChunk: number;
  lastChunk: number;
  bytes: number;
  rendered: boolean;
  handlers: FaceRenderHandlers | null;
  began: boolean;
  finished: boolean;
}

export function liteUnitKey(unit: Pick<SpeechUnitToPlay, 'turnId' | 'seq'>): string {
  return `${unit.turnId ?? 'intro'}.${String(unit.seq)}`;
}

export class LiteSpeaker {
  private queue: Fed[] = [];
  private utterance: Utterance | null = null;
  /** Utterances interrupted: their `speak_ended` is ignored. */
  private readonly interrupted = new Set<string>();
  /** The last seq of each turn whose units all reached the call. */
  private readonly turnEnds = new Map<string, number>();
  /** A turn the face gave back to the call: its later units stay with the call. */
  private degradedTurn: string | null = null;
  private broken = false;
  private stalls = 0;
  private fallbacks = 0;
  private cuts = 0;
  private interrupts = 0;
  /** Until when the avatar track's level is not taken as an utterance's start (after a barge-in or a fallback). */
  private onsetHoldUntil = -Infinity;
  private forwarded = 0;
  private opened = 0;
  private readonly byTurn = new Map<string, number>();
  private readonly startLags: number[] = [];
  private lagMs = DEFAULT_LAG_MS;
  private ticker: unknown = null;
  private keepAliveTimer: unknown = null;
  private admissionChain: Promise<unknown> = Promise.resolve();
  private lifetime = new AbortController();
  private readonly offControl: () => void;

  constructor(private readonly deps: LiteSpeakerDeps) {
    this.offControl = deps.control.on((event) => {
      this.onEvent(event);
    });
    this.scheduleKeepAlive();
  }

  /** Whether the face can take units now. */
  get ready(): boolean {
    return !this.broken && this.deps.control.open;
  }

  report(): LiteReport {
    return {
      utterances: this.opened,
      utterancesByTurn: Object.fromEntries(this.byTurn),
      unitsForwarded: this.forwarded,
      fallbacks: this.fallbacks,
      cuts: this.cuts,
      stalls: this.stalls,
      interrupts: this.interrupts,
      startLagMs: [...this.startLags],
      counts: { ...this.deps.control.counts },
    };
  }

  /**
   * Takes one unit's PCM (16-bit mono at `sampleRate`, still arriving) ahead of its turn. True when the face owns the
   * unit from now on (then `render` makes it heard, or gives it back before it was heard); false when the call plays
   * it itself (no signature, a turn the face gave back, the face not ready).
   */
  feed(unit: SpeechUnitToPlay, body: ReadableStream<Uint8Array>, sampleRate: number): boolean {
    const turn = unit.turnId ?? 'intro';
    const key = liteUnitKey(unit);
    if (
      !this.ready ||
      unit.sig === undefined ||
      this.degradedTurn === turn ||
      this.queue.some((fed) => fed.key === key)
    ) {
      return false;
    }
    const fed: Fed = {
      key,
      unit,
      turn,
      rate: sampleRate,
      reader: body.getReader(),
      buffered: [],
      streamDone: false,
      admission: unit.faceApproved === true ? 'yes' : 'pending',
      state: 'waiting',
      utterance: null,
      chunker: null,
      firstChunk: -1,
      lastChunk: -1,
      bytes: 0,
      rendered: false,
      handlers: null,
      began: false,
      finished: false,
    };
    this.queue.push(fed);
    if (fed.admission === 'pending') this.askAdmission(fed);
    void this.read(fed);
    this.pump();
    return true;
  }

  /**
   * The call reached a unit it gave the face: makes it heard (`handlers`), or gives it back at once (`failed`) when
   * the face does not hold it any more. Returns the function that stops it (barge-in: everything stops).
   */
  render(unit: SpeechUnitToPlay, handlers: FaceRenderHandlers): () => void {
    const fed = this.queue.find((entry) => entry.key === liteUnitKey(unit));
    if (fed === undefined || fed.state === 'failed' || fed.finished || this.broken) {
      if (fed !== undefined) fed.finished = true;
      this.later(() => {
        handlers.onEnd('failed');
      }, 0);
      return () => {
        this.halt();
      };
    }
    fed.rendered = true;
    fed.handlers = handlers;
    this.pump();
    this.tick();
    return () => {
      this.halt();
    };
  }

  /** All of `turn`'s units reached the call; its last is `lastSeq`. */
  endTurn(turn: string | null, lastSeq: number): void {
    const key = turn ?? 'intro';
    this.turnEnds.set(key, lastSeq);
    if (this.turnEnds.size > TURNS_KEPT) {
      const oldest = this.turnEnds.keys().next().value;
      if (oldest !== undefined) this.turnEnds.delete(oldest);
    }
    this.maybeSeal();
  }

  /** `turn` failed: its units the face has not forwarded yet lose their pre-approval (the call plays them). */
  withdraw(turn: string): void {
    for (const fed of this.queue) {
      if (fed.turn === turn && fed.state === 'waiting' && fed.unit.faceApproved === true)
        fed.admission = 'no';
    }
    this.pump();
  }

  /** Barge-in (or the call stopped): silent at once, the vendor interrupted, everything dropped. */
  halt(): void {
    this.deps.silence();
    const live = this.utterance;
    if (live !== null && live.endedAt === null) this.interrupt(live);
    this.drop();
  }

  /** The face went away (room, video or channel): what was not heard goes back to the call. */
  lost(): void {
    if (this.broken) return;
    this.broken = true;
    this.giveBack();
  }

  dispose(): void {
    this.broken = true;
    this.drop();
    this.offControl();
    if (this.keepAliveTimer !== null) this.deps.clearTimeout(this.keepAliveTimer);
    this.keepAliveTimer = null;
    this.lifetime.abort();
  }

  // Internals -----------------------------------------------------------------------------------------

  private later(callback: () => void, ms: number): unknown {
    return this.deps.setTimeout(callback, ms);
  }

  private askAdmission(fed: Fed): void {
    const signal = this.lifetime.signal;
    const asked = this.admissionChain.then(() => this.deps.admit(fed.unit, signal));
    this.admissionChain = asked.catch(() => undefined);
    asked.then(
      () => {
        if (fed.admission === 'pending') fed.admission = 'yes';
        this.pump();
      },
      () => {
        fed.admission = 'no';
        this.pump();
      },
    );
  }

  private async read(fed: Fed): Promise<void> {
    try {
      for (;;) {
        const next = await fed.reader.read();
        if (next.done) break;
        if (fed.finished || fed.state === 'failed') return;
        if (fed.state === 'forwarding') this.forwardBytes(fed, next.value);
        else fed.buffered.push(next.value);
      }
    } catch {
      // Aborted (barge-in) or the connection dropped: what arrived is all there is.
    }
    fed.streamDone = true;
    if (fed.state === 'forwarding') this.completeForward(fed);
  }

  /** Forwards the next units that may go now, in order. */
  private pump(): void {
    if (this.broken) return;
    for (let i = 0; i < this.queue.length; i += 1) {
      const fed = this.queue[i];
      if (fed === undefined) break;
      if (fed.state === 'forwarding') return;
      if (fed.state !== 'waiting') continue;
      if (fed.admission === 'pending') return;
      if (fed.admission === 'no') {
        this.fail(fed);
        continue;
      }
      const prev = i > 0 ? this.queue[i - 1] : undefined;
      const live = this.utterance;
      // The next sentence of the turn the avatar is saying: appended at once, so it follows without a gap.
      const chained =
        live !== null &&
        !live.sealed &&
        live.turn === fed.turn &&
        prev?.turn === fed.turn &&
        prev.unit.seq === fed.unit.seq - 1 &&
        prev.state === 'forwarded' &&
        prev.utterance === live;
      if (!chained && !fed.rendered) return;
      if (live !== null && (live.turn !== fed.turn || live.sealed)) {
        // Another turn's utterance is still open: it is sealed now and waited for (a new one would cut it).
        if (!live.sealed) this.seal(live);
        this.tick();
        return;
      }
      if (live === null && this.tooLate(fed.turn)) {
        // The session ends before this turn would: the call says it, and the face hands over now, between turns.
        this.giveBack();
        this.breakDown('time_limit');
        return;
      }
      this.startForward(fed, live ?? this.open(fed.turn));
      return;
    }
  }

  /** Whether `turn` would outlast the session's time left (an estimate from its units' words). */
  private tooLate(turn: string): boolean {
    const remaining = this.deps.remainingMs?.() ?? Infinity;
    if (!Number.isFinite(remaining)) return false;
    let known = 0;
    for (const fed of this.queue) if (fed.turn === turn) known += speakingTimeMs(fed.unit.text);
    const estimate = Math.max(LITE_HANDOVER_MIN_MS, known + (this.turnEnds.has(turn) ? 0 : TURN_TAIL_MS));
    return remaining < estimate;
  }

  private open(turn: string): Utterance {
    const utterance: Utterance = {
      id: this.deps.ids(),
      turn,
      chunks: [],
      startedAt: null,
      quietSeen: false,
      sealed: false,
      endedAt: null,
      sealedAt: null,
      stallTimer: null,
    };
    this.utterance = utterance;
    return utterance;
  }

  private startForward(fed: Fed, utterance: Utterance): void {
    fed.state = 'forwarding';
    fed.utterance = utterance;
    fed.chunker = new LiteChunker(fed.rate, { first: utterance.chunks.length === 0 });
    fed.firstChunk = utterance.chunks.length;
    const held = fed.buffered;
    fed.buffered = [];
    for (const bytes of held) {
      this.forwardBytes(fed, bytes);
      // A chunk the channel refused gave everything back.
      if (!this.forwarding(fed)) return;
    }
    if (fed.streamDone) this.completeForward(fed);
  }

  private forwarding(fed: Fed): boolean {
    return fed.state === 'forwarding';
  }

  private forwardBytes(fed: Fed, bytes: Uint8Array): void {
    const chunker = fed.chunker;
    if (chunker === null) return;
    for (const chunk of chunker.push(bytes)) {
      if (!this.send(fed, chunk)) return;
    }
  }

  private completeForward(fed: Fed): void {
    if (fed.state !== 'forwarding') return;
    const rest = fed.chunker?.flush() ?? null;
    if (rest !== null && !this.send(fed, rest)) return;
    const utterance = fed.utterance;
    if (fed.bytes === 0 || utterance === null) {
      // No audio came: the call shows the unit as words. An utterance it would have opened is dropped unopened.
      if (utterance !== null && utterance.chunks.length === 0 && this.utterance === utterance) {
        this.utterance = null;
      }
      fed.utterance = null;
      this.fail(fed);
      this.pump();
      return;
    }
    fed.state = 'forwarded';
    fed.lastChunk = utterance.chunks.length - 1;
    this.forwarded += 1;
    this.maybeSeal();
    this.pump();
    this.tick();
  }

  /** Sends one chunk of `fed` into its utterance; false when the channel could not take it. */
  private send(fed: Fed, chunk: Uint8Array): boolean {
    const utterance = fed.utterance;
    if (utterance === null) return false;
    try {
      this.deps.control.speak(utterance.id, chunk);
    } catch {
      this.closed();
      return false;
    }
    const now = this.deps.now();
    if (utterance.chunks.length === 0) {
      this.opened += 1;
      this.byTurn.set(utterance.turn, (this.byTurn.get(utterance.turn) ?? 0) + 1);
      if (this.byTurn.size > TURNS_KEPT) {
        const oldest = this.byTurn.keys().next().value;
        if (oldest !== undefined) this.byTurn.delete(oldest);
      }
      utterance.stallTimer = this.later(() => {
        if (utterance.startedAt === null && this.utterance === utterance) this.stall(utterance);
      }, LITE_STALL_MS);
    }
    utterance.chunks.push({ sentAt: now, ms: liteAudioMs(chunk.byteLength) });
    fed.bytes += chunk.byteLength;
    return true;
  }

  /** Seals the open utterance once its turn's last unit was forwarded. */
  private maybeSeal(): void {
    const live = this.utterance;
    if (live === null || live.sealed) return;
    const last = this.turnEnds.get(live.turn);
    if (last === undefined) return;
    const pending = this.queue.some(
      (fed) => fed.turn === live.turn && fed.state === 'forwarding' && fed.utterance === live,
    );
    const done = this.queue.some(
      (fed) =>
        fed.turn === live.turn && fed.utterance === live && fed.state === 'forwarded' && fed.unit.seq >= last,
    );
    if (!pending && done) this.seal(live);
  }

  private seal(utterance: Utterance): void {
    if (utterance.sealed) return;
    utterance.sealed = true;
    utterance.sealedAt = this.deps.now();
    if (utterance.chunks.length === 0) {
      // Nothing was sent: there is nothing to end at the vendor.
      if (this.utterance === utterance) this.utterance = null;
      return;
    }
    try {
      this.deps.control.speakEnd(utterance.id);
    } catch {
      this.closed();
    }
  }

  private interrupt(utterance: Utterance): void {
    this.interrupted.add(utterance.id);
    if (this.interrupted.size > TURNS_KEPT) {
      const oldest = this.interrupted.values().next().value;
      if (oldest !== undefined) this.interrupted.delete(oldest);
    }
    this.deps.clearTimeout(utterance.stallTimer);
    utterance.endedAt = this.deps.now();
    if (this.utterance === utterance) this.utterance = null;
    if (utterance.chunks.length === 0) return;
    this.holdOnset();
    this.interrupts += 1;
    try {
      this.deps.control.interrupt();
    } catch {
      /* the channel is gone: nothing is playing there any more */
    }
    this.deps.onInterrupt?.();
  }

  /** Drops every unit (no handler is called: the call stopped them itself). */
  private drop(): void {
    for (const fed of this.queue) this.cancel(fed);
    this.queue = [];
    this.turnEnds.clear();
    if (this.utterance !== null) this.deps.clearTimeout(this.utterance.stallTimer);
    this.utterance = null;
    this.stopTicking();
  }

  private cancel(fed: Fed): void {
    fed.finished = true;
    fed.buffered = [];
    fed.reader.cancel().catch(() => undefined);
  }

  private fail(fed: Fed): void {
    if (fed.state === 'failed') return;
    fed.state = 'failed';
    this.fallbacks += 1;
    fed.buffered = [];
    fed.reader.cancel().catch(() => undefined);
    if (fed.rendered && !fed.finished) {
      fed.finished = true;
      fed.handlers?.onEnd('failed');
    }
  }

  /**
   * The face could not make the turn heard: silent and interrupted first, then every unit not yet heard goes back to
   * the call (heard ones count as heard, never repeated), and the turn's later units stay with the call.
   */
  private giveBack(): void {
    this.deps.silence();
    this.holdOnset();
    const now = this.deps.now();
    const live = this.utterance;
    if (live !== null) {
      this.degradedTurn = live.turn;
      if (this.deps.control.open) this.interrupt(live);
      else {
        this.deps.clearTimeout(live.stallTimer);
        this.interrupted.add(live.id);
        this.utterance = null;
      }
    }
    const units = this.queue;
    this.queue = [];
    for (const fed of units) {
      if (fed.finished) continue;
      if (fed.began) {
        // Partway through: the call plays the rest from its own copy, from where the avatar had got to.
        fed.finished = true;
        fed.reader.cancel().catch(() => undefined);
        this.cuts += 1;
        fed.handlers?.onEnd('cut', this.heardMs(fed, now));
        continue;
      }
      this.fail(fed);
      fed.finished = true;
    }
    this.stopTicking();
  }

  /** The avatar track's sound is not taken as a start for a while (the cut audio's tail is still on it). */
  private holdOnset(): void {
    this.onsetHoldUntil = this.deps.now() + ONSET_HOLD_MS;
  }

  /** How much of `fed` the avatar had played by `now` (ms), from where each of its chunks played. */
  private heardMs(fed: Fed, now: number): number {
    const utterance = fed.utterance;
    if (utterance === null || fed.firstChunk < 0) return 0;
    const positions = this.positions(utterance);
    if (positions === null) return 0;
    const last = fed.lastChunk >= 0 ? fed.lastChunk : utterance.chunks.length - 1;
    let heard = 0;
    for (let i = fed.firstChunk; i <= last; i += 1) {
      const at = positions[i];
      const chunk = utterance.chunks[i];
      if (at === undefined || chunk === undefined) break;
      heard += Math.max(0, Math.min(chunk.ms, now - at.start));
    }
    return Math.round(heard);
  }

  private stall(utterance: Utterance): void {
    if (this.utterance !== utterance) return;
    this.stalls += 1;
    this.giveBack();
    if (this.stalls >= 2) this.breakDown('speech_stalled');
  }

  private closed(): void {
    if (this.broken) return;
    this.giveBack();
    this.breakDown('control_lost');
  }

  private breakDown(reason: LiteBrokenReason): void {
    if (this.broken) return;
    this.broken = true;
    this.deps.onBroken(reason);
  }

  private onEvent(event: LiteEvent): void {
    if (event.kind === 'closed') {
      this.closed();
      return;
    }
    if (event.kind === 'error') {
      // A frame gap is a diagnostic; any other error ends what the face was saying (the call says the rest).
      if (event.errorType === 'video_starvation') return;
      const live = this.utterance;
      if (live !== null) this.stall(live);
      return;
    }
    if (this.interrupted.has(event.source)) return;
    const live = this.utterance;
    if (live?.id !== event.source) return;
    if (event.kind === 'speak_started') {
      this.started(live);
      return;
    }
    if (event.kind === 'speak_ended') {
      this.ended(live);
    }
  }

  private started(utterance: Utterance): void {
    if (utterance.startedAt !== null) return;
    const now = this.deps.now();
    utterance.startedAt = now;
    this.deps.clearTimeout(utterance.stallTimer);
    const first = utterance.chunks[0];
    if (first !== undefined) {
      const lag = now - first.sentAt;
      this.startLags.push(Math.round(lag));
      if (this.startLags.length > TURNS_KEPT) this.startLags.shift();
      this.lagMs = Math.max(50, Math.min(1_500, 0.7 * this.lagMs + 0.3 * lag));
    }
    // The element sounds again with the new utterance (it was silenced at barge-in or a fallback).
    this.deps.unsilence();
    this.tick();
  }

  private ended(utterance: Utterance): void {
    if (utterance.endedAt !== null) return;
    utterance.endedAt = this.deps.now();
    if (this.utterance === utterance) this.utterance = null;
    this.tick();
    this.pump();
  }

  /** Where each chunk of `utterance` plays (wall-clock ms), once it started; null before. */
  private positions(utterance: Utterance): { start: number; end: number }[] | null {
    if (utterance.startedAt === null) return null;
    const out: { start: number; end: number }[] = [];
    let end = -Infinity;
    utterance.chunks.forEach((chunk, i) => {
      const start = i === 0 ? (utterance.startedAt ?? 0) : Math.max(end, chunk.sentAt + this.lagMs);
      end = start + chunk.ms;
      out.push({ start, end });
    });
    return out;
  }

  /** Reports each rendered unit's start and end as the avatar reaches them; seals or closes idle utterances. */
  private tick(): void {
    if (this.ticker !== null) {
      this.deps.clearTimeout(this.ticker);
      this.ticker = null;
    }
    const now = this.deps.now();
    const live = this.utterance;
    // The track sounding counts as started (its event may come late), once it was quiet after the first chunk
    // and outside the hold after a cut: before that, what sounds is the audio just interrupted, not this utterance.
    if (live !== null && live.startedAt === null && live.chunks.length > 0 && now >= this.onsetHoldUntil) {
      const sounding = this.deps.level() > ONSET_LEVEL;
      if (!sounding) live.quietSeen = true;
      else if (live.quietSeen) {
        this.started(live);
        return;
      }
    }
    for (const fed of this.queue) {
      if (!fed.rendered || fed.finished || fed.utterance === null) continue;
      const utterance = fed.utterance;
      const positions = this.positions(utterance);
      const over = utterance.endedAt !== null;
      if (!fed.began) {
        const start = positions?.[fed.firstChunk]?.start;
        if (over || (start !== undefined && now >= start)) {
          fed.began = true;
          fed.handlers?.onStart();
        }
      }
      if (fed.began && fed.state === 'forwarded') {
        const end = positions?.[fed.lastChunk]?.end;
        const lastOfUtterance =
          utterance.sealed &&
          !this.queue.some(
            (other) => other !== fed && other.utterance === utterance && other.firstChunk > fed.lastChunk,
          );
        // The utterance's last unit ends at `speak_ended`; the others where the audio after them begins.
        if (over || (!lastOfUtterance && end !== undefined && now >= end)) {
          fed.finished = true;
          fed.handlers?.onEnd('ended');
        }
      }
    }
    this.prune();
    if (live !== null && live === this.utterance && live.startedAt !== null) {
      const positions = this.positions(live);
      const playedOut = positions?.at(-1)?.end ?? 0;
      const forwarding = this.queue.some(
        (fed) =>
          fed.turn === live.turn &&
          (fed.state === 'forwarding' || (fed.state === 'waiting' && fed.admission !== 'no')),
      );
      // Nothing more came for the open utterance: it is ended, so the avatar goes idle and the vendor's end follows.
      const idle = this.turnEnds.has(live.turn) ? IDLE_CLOSE_ENDED_TURN_MS : IDLE_CLOSE_MS;
      if (!live.sealed && !forwarding && now >= playedOut + idle) this.seal(live);
      // A sealed utterance whose end never came: closed all the same, so the next turn is not held up.
      if (
        live.sealed &&
        live.endedAt === null &&
        now >= Math.max(playedOut, live.sealedAt ?? 0) + CLOSE_WAIT_MS
      ) {
        this.ended(live);
        return;
      }
    }
    if (this.queue.length > 0 || this.utterance !== null) {
      this.ticker = this.later(() => {
        this.ticker = null;
        this.tick();
      }, TICK_MS);
    }
  }

  /** Forgets units that are over (heard, or given back), keeping the queue short. */
  private prune(): void {
    while (this.queue.length > 1) {
      const head = this.queue[0];
      const next = this.queue[1];
      // The unit before a waiting one stays (the next sentence chains on it).
      if (head === undefined || !head.finished || next?.state === 'waiting') break;
      this.queue.shift();
    }
    if (this.queue.length === 1 && this.queue[0]?.finished === true && this.utterance === null)
      this.queue = [];
  }

  private stopTicking(): void {
    if (this.ticker !== null) this.deps.clearTimeout(this.ticker);
    this.ticker = null;
  }

  private scheduleKeepAlive(): void {
    this.keepAliveTimer = this.later(() => {
      this.keepAliveTimer = null;
      if (this.broken) return;
      const control = this.deps.control;
      const idle = this.utterance === null;
      if (idle && control.open && this.deps.now() - control.lastSentAt >= LITE_KEEPALIVE_MS) {
        try {
          control.keepAlive();
        } catch {
          /* closed: the close event says so */
        }
      }
      this.scheduleKeepAlive();
    }, KEEPALIVE_CHECK_MS);
  }
}
