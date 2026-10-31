import type { CallEndReason, CallState, SttGrant, TurnBlockedDetail, TurnView } from '@foundry/contracts';

import type { CreateTurnBody, StreamTurnOptions, TurnStreamEventT } from '../api/sse';
import type { AvatarState, SpokenUnit } from './avatar';
import {
  callErrorMessage,
  startFailure,
  type EndCallBody,
  type EndCallResult,
  type HeardUnitBody,
  type HeartbeatBody,
  type HeartbeatResult,
  type InterruptBody,
  type PreparedBeacon,
  type StartCallResult,
} from './call-api';
import {
  MicCapture,
  MicrophoneError,
  requestMicrophone,
  type CaptureAudio,
  type TrackChange,
} from './capture';
import { BARGE_SUSTAIN_MS, BARGE_WORD_SUSTAIN_MS, Endpointer, VoiceRun, floorWords } from './endpointing';
import {
  SpeechPlayer,
  type FaceRenderer,
  type PlayerAudio,
  type SpeechFetchResult,
  type SpeechUnitToPlay,
} from './playback';
import { IDLE_CALL, type CallEnded, type CallSnapshot, type TalkMode, type TypedReason } from './call-state';
import { openingText, speakableSentences } from './spoken-text';
import { TranscribeStream, type TranscribeHandlers, type WebSocketFactory } from './transcribe';
import { VoiceActivityDetector } from './vad';

export type {
  CallActivity,
  CallEnded,
  CallFailure,
  CallNotice,
  CallPhase,
  CallSnapshot,
  TalkMode,
  TypedReason,
} from './call-state';

/**
 * CallEngine: one live call with a vEIR (docs/architecture/calls.md §3).
 *
 *   mic → AudioWorklet (16 kHz PCM) → Transcribe WebSocket (presigned `sttGrant`) → partial captions
 *   → end of turn (stable transcript + silence) → POST /sessions/:id/turns {channel: 'voice', callId}
 *   → `turn.speech` units (signed) → POST /speech, pipelined → one AudioContext → speakers
 *
 * Barge-in: voice while the vEIR speaks ducks it at once; the founder taking the floor stops the audio, aborts the
 * turn stream and POSTs /turns/:id/interrupt with the last unit actually heard. Taking the floor is a settled word
 * that is neither the vEIR's echo nor a backchannel, one Transcribe already marked stable, one with the voice
 * running on, two unsettled ones, or the voice running on (about 0.7 s) when no word heard yet says it is only a
 * backchannel or the echo; speakers whose sound alone stopped the vEIR once, with no word after it, need words. A heartbeat every
 * 15 s carries the server's kill switches and remaining minutes. Without a microphone or speech-to-text
 * (local development, a refusal) the call continues by typing; replies are still spoken.
 *
 * The engine is framework-free (React reads it through `subscribe`/`getSnapshot`) and every browser edge is
 * a dependency, so it is unit tested with fakes. Nothing here logs content.
 */

export interface CallEngineApi {
  startCall(
    sessionId: string,
    inputMode: 'transcribe' | 'typed',
    replace?: boolean,
  ): Promise<StartCallResult>;
  refreshSttGrant(callId: string): Promise<SttGrant>;
  heartbeat(callId: string, body: HeartbeatBody): Promise<HeartbeatResult>;
  endCall(callId: string, body: EndCallBody): Promise<EndCallResult>;
  interruptTurn(turnId: string, body: InterruptBody): Promise<void>;
  streamTurn(
    sessionId: string,
    body: CreateTurnBody,
    options: StreamTurnOptions,
  ): AsyncIterable<TurnStreamEventT>;
  fetchSpeech(sessionId: string, unit: SpeechUnitToPlay, signal: AbortSignal): Promise<SpeechFetchResult>;
  prepareEndBeacon(callId: string, reason: CallEndReason): Promise<PreparedBeacon>;
}

/** The one AudioContext of a call, as capture and playback use it. */
export type CallAudioContext = CaptureAudio['context'] &
  PlayerAudio['context'] & {
    readonly state: AudioContextState;
    resume(): Promise<void>;
    close(): Promise<void>;
    addEventListener(type: 'statechange', listener: () => void): void;
    removeEventListener(type: 'statechange', listener: () => void): void;
  };

export interface CallEngineMedia {
  createAudioContext(): CallAudioContext | null;
  getUserMedia: CaptureAudio['getUserMedia'] | null;
  createWorkletNode(
    context: CallAudioContext,
    name: string,
    options: AudioWorkletNodeOptions,
  ): AudioWorkletNode;
  createSocket: WebSocketFactory;
  synthesis: PlayerAudio['synthesis'];
  createUtterance(text: string): SpeechSynthesisUtterance;
  /** The browser's `devicechange` (a microphone plugged in or out), where it has one. */
  watchDevices?: CaptureAudio['watchDevices'];
}

export interface CallClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly setInterval: (callback: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export interface CallTuning {
  /** Quiet time that ends a hands-free turn. */
  readonly silenceMs: number;
  readonly heartbeatMs: number;
  /** Give up reconnecting speech-to-text after this long (then the call continues by typing). */
  readonly reconnectWindowMs: number;
  /** After a duck, restore the vEIR's volume if no real word confirms the barge-in. */
  readonly bargeConfirmMs: number;
  /** After push-to-talk is released, wait this long for the last words to be transcribed. */
  readonly releaseSettleMs: number;
  /** Warn this many seconds before the call's limit. */
  readonly warnSeconds: number;
  /** End the call after this many heartbeats in a row failed. */
  readonly maxMissedHeartbeats: number;
  /** Suggest push-to-talk after this many ducks that no word confirmed (speakers without headphones). */
  readonly falseBargeInHint: number;
  /** A microphone the system keeps silent this long (another app took it, a hardware mute) is gone. */
  readonly micSilentMs: number;
}

export const DEFAULT_TUNING: CallTuning = {
  silenceMs: 600,
  heartbeatMs: 15_000,
  reconnectWindowMs: 30_000,
  bargeConfirmMs: 1_200,
  releaseSettleMs: 700,
  warnSeconds: 120,
  maxMissedHeartbeats: 3,
  falseBargeInHint: 3,
  micSilentMs: 6_000,
};

export interface CallEngineDeps {
  readonly api: CallEngineApi;
  readonly media: CallEngineMedia;
  readonly clock: CallClock;
  readonly tuning?: Partial<CallTuning>;
  /** A turn finished, was blocked or was cut off (the conversation view refreshes). */
  readonly onTurnSettled?: (sessionId: string, turn: TurnView | null) => void;
}

export interface StartCallOptions {
  readonly ventureId: string;
  readonly sessionId: string;
  readonly talkMode?: TalkMode;
  /**
   * Close the microphone while the vEIR speaks (it is interrupted by tapping or Esc instead). For devices
   * whose echo cancellation does not reach the recogniser, where the vEIR would otherwise hear itself.
   */
  readonly halfDuplex?: boolean;
  /** End the founder's live call in another conversation (they said yes to moving it here). */
  readonly replace?: boolean;
}

interface ActiveTurn {
  readonly controller: AbortController;
  turnId: string | null;
  /** Last unit of this turn heard to its end (-1: none). */
  heardSeq: number;
  /** The units heard to their end, in order, as played. */
  readonly heard: HeardUnitBody[];
  units: number;
  done: boolean;
  interrupted: boolean;
  readonly submittedAt: number;
  firstAudioAt: number | null;
}

/** After voice alone stopped the vEIR, how long a word may take to follow before the sound counts as not the founder. */
const SILENT_BARGE_MS = 3_000;

/** A grant this close to expiry is re-minted before connecting with it. */
const GRANT_MARGIN_MS = 15_000;

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.min(120_000, Math.round(sorted[index] ?? 0));
}

type SpeakListener = (unit: SpokenUnit) => void;

export class CallEngine {
  private snapshot: CallSnapshot = IDLE_CALL;
  private readonly listeners = new Set<() => void>();
  private readonly speakListeners = new Set<SpeakListener>();
  private readonly tuning: CallTuning;

  private context: CallAudioContext | null = null;
  private player: SpeechPlayer | null = null;
  /** The face that renders the call's audio (voicing `audio`), or null: the speakers. */
  private face: FaceRenderer | null = null;
  /** Whether the call's vendor face is shown (reported in heartbeats, so a dropped face stops billing). */
  private faceShown: boolean | null = null;
  private readonly faceStopListeners = new Set<() => void>();
  private capture: MicCapture | null = null;
  private stt: TranscribeStream | null = null;
  private grant: SttGrant | null = null;
  private readonly vad = new VoiceActivityDetector();
  /** The founder's voice while the vEIR speaks (a barge-in long before the transcript confirms it). */
  private readonly voiceRun: VoiceRun;
  /** Voice alone no longer stops the vEIR on this call: it did once and no word followed (speakers, a room). */
  private sustainBargeOff = false;
  private silentBargeTimer: unknown = null;
  private endpointer: Endpointer;
  private turn: ActiveTurn | null = null;
  /** The crisis turn whose fixed support line is being said (never cut off). */
  private crisisTurnId: string | null = null;
  /**
   * The crisis support line of a call that ended while it was being said: its player and audio outlive the
   * call until the line has been heard to its end (released then, or when the page goes away).
   */
  private lingering: { readonly player: SpeechPlayer; readonly context: CallAudioContext } | null = null;
  private readonly pendingLines: string[] = [];
  private beacon: PreparedBeacon | null = null;
  private founderLevel = 0;
  /** What the vEIR has said of the current reply (and the intro): its echo is not the founder speaking. */
  private spokenSoFar = '';
  private readonly onAudioState = (): void => {
    this.syncAudioState();
  };
  /** Bumped whenever a call starts or stops, so late async work for an old call is ignored. */
  private epoch = 0;
  private turnCount = 0;

  private heartbeatTimer: unknown = null;
  private tickTimer: unknown = null;
  private bargeTimer: unknown = null;
  private releaseTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private micSilentTimer: unknown = null;
  private missedHeartbeats = 0;
  private falseBargeIns = 0;
  private warned = false;
  private sttOpenedAt: number | null = null;
  private micOpenMs = 0;
  private reconnectSince: number | null = null;
  private reconnectAttempt = 0;
  private readonly stats = { bargeIns: 0, reconnects: 0, firstAudioMs: [] as number[] };

  constructor(private readonly deps: CallEngineDeps) {
    this.tuning = { ...DEFAULT_TUNING, ...deps.tuning };
    this.endpointer = new Endpointer(deps.clock.now, { silenceMs: this.tuning.silenceMs });
    this.voiceRun = new VoiceRun(deps.clock.now);
  }

  // Store ---------------------------------------------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): CallSnapshot => this.snapshot;

  /** Every validated unit as it starts being heard (the avatar reacts). */
  onSpeak(listener: SpeakListener): () => void {
    this.speakListeners.add(listener);
    return () => {
      this.speakListeners.delete(listener);
    };
  }

  /**
   * A vendor face that renders the call's validated audio itself, lip-synced (voicing `audio`), or null to play
   * through the speakers again (the face dropped, the stage closed). The call's own checks, signatures,
   * barge-in and heard-units accounting are unchanged: the face only receives audio this call fetched.
   */
  attachFace(face: FaceRenderer | null): void {
    this.face = face;
    this.player?.setFace(face);
  }

  /**
   * Whether the call's vendor face is on screen (`null`: the call has none). Heartbeats report it, so the server
   * ends a face the founder no longer sees.
   */
  setFaceShown(shown: boolean | null): void {
    this.faceShown = shown;
  }

  /** The server said the face has to go (faces switched off, likeness withdrawn, minutes used up). */
  onFaceStop(listener: () => void): () => void {
    this.faceStopListeners.add(listener);
    return () => {
      this.faceStopListeners.delete(listener);
    };
  }

  private set(patch: Partial<CallSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private setCaptions(patch: Partial<CallSnapshot['captions']>): void {
    this.set({ captions: { ...this.snapshot.captions, ...patch } });
  }

  /** Both sides' loudness for the avatar (0–1). A voice without a signal to measure gets a gentle pulse. */
  levels(): { veir: number; founder: number } {
    const speaking = this.snapshot.activity === 'speaking' && this.snapshot.phase === 'live';
    let veir = 0;
    if (speaking && this.player) {
      if (this.snapshot.voice === 'server') {
        veir = this.player.level();
      } else if (this.snapshot.voice === 'browser') {
        // The browser's voice cannot be measured: a gentle pulse while it reads.
        const t = this.deps.clock.now() / 1000;
        veir = 0.03 + 0.025 * Math.abs(Math.sin(t * 5.3) * Math.sin(t * 2.1));
      }
    }
    return { veir, founder: this.snapshot.muted ? 0 : this.founderLevel };
  }

  /** The state the avatar shows. */
  avatarState(): AvatarState {
    const s = this.snapshot;
    if (s.phase === 'starting' || s.reconnecting) return 'connecting';
    if (s.phase !== 'live') return 'idle';
    if (s.activity === 'speaking') return 'speaking';
    if (s.activity === 'thinking') return 'thinking';
    if (s.muted) return 'muted';
    return s.activity === 'connecting' ? 'connecting' : 'listening';
  }

  // Lifecycle -----------------------------------------------------------------------------------------

  /**
   * Starts a call in a conversation. Call it from a user gesture where possible: the AudioContext it
   * creates may only play sound after one (otherwise the call shows Turn on sound). It never rejects: a
   * call that cannot start ends in the `failed` phase with the reason.
   */
  async start(options: StartCallOptions): Promise<void> {
    if (this.snapshot.phase !== 'idle') return;
    const epoch = ++this.epoch;
    this.resetCounters();
    this.set({
      ...IDLE_CALL,
      phase: 'starting',
      ventureId: options.ventureId,
      sessionId: options.sessionId,
      talkMode: options.talkMode ?? 'hands_free',
      halfDuplex: options.halfDuplex ?? false,
    });
    try {
      await this.open(options, epoch);
    } catch {
      // A browser API that threw: never leave a half-open call or a live microphone behind.
      if (epoch !== this.epoch) return;
      const call = this.snapshot.call;
      this.epoch += 1;
      this.teardown();
      if (call) void this.deps.api.endCall(call.id, { reason: 'error' }).catch(() => undefined);
      this.set({
        ...IDLE_CALL,
        phase: 'failed',
        ventureId: options.ventureId,
        sessionId: options.sessionId,
        error: { message: 'The call couldn’t start. Try again.', retry: true },
      });
    }
  }

  private async open(options: StartCallOptions, epoch: number): Promise<void> {
    const context = this.deps.media.createAudioContext();
    if (context === null) {
      this.set({
        phase: 'failed',
        error: { message: 'This browser can’t play call audio. Continue in chat instead.', retry: false },
      });
      return;
    }
    this.context = context;
    context.addEventListener('statechange', this.onAudioState);
    this.resumeAudio();
    this.player = this.createPlayer(context, options.sessionId);

    let stream: MediaStream | null = null;
    let typedReason: TypedReason | null = null;
    const getUserMedia = this.deps.media.getUserMedia;
    if (getUserMedia === null) {
      typedReason = 'mic_unavailable';
    } else {
      try {
        stream = await requestMicrophone(getUserMedia);
      } catch (error) {
        typedReason =
          error instanceof MicrophoneError && error.reason === 'denied' ? 'mic_denied' : 'mic_unavailable';
      }
    }
    if (epoch !== this.epoch) {
      stopStream(stream);
      return;
    }

    let started: StartCallResult;
    try {
      started = await this.deps.api.startCall(
        options.sessionId,
        stream ? 'transcribe' : 'typed',
        options.replace === true,
      );
    } catch (error) {
      stopStream(stream);
      if (epoch !== this.epoch) return;
      this.releaseAudio();
      this.set({ phase: 'failed', error: startFailure(error) });
      return;
    }
    if (epoch !== this.epoch) {
      // Ended before the server answered: close the call that was just opened.
      stopStream(stream);
      void this.deps.api.endCall(started.call.id, { reason: 'user' }).catch(() => undefined);
      return;
    }

    const { call, sttGrant, intro } = started;
    if (sttGrant === null) {
      stopStream(stream);
      stream = null;
      typedReason ??= 'stt_unavailable';
    }
    const now = this.deps.clock.now();
    this.grant = sttGrant;
    this.set({
      phase: 'live',
      call,
      liveAt: now,
      remaining: { seconds: call.maxSeconds, at: now },
      input: stream ? 'voice' : 'typed',
      typedReason: stream ? null : typedReason,
      activity: intro || stream ? 'connecting' : 'listening',
    });
    this.syncAudioState();
    this.heartbeatTimer = this.deps.clock.setInterval(() => {
      void this.heartbeat();
    }, this.tuning.heartbeatMs);
    this.tickTimer = this.deps.clock.setInterval(() => {
      this.tick();
    }, 1000);
    void this.deps.api
      .prepareEndBeacon(call.id, 'navigated')
      .then((beacon) => {
        if (epoch === this.epoch) this.beacon = beacon;
      })
      .catch(() => undefined);

    if (intro) this.player.enqueue({ turnId: null, seq: 0, text: intro.text, sig: intro.sig });
    if (stream) await this.startCapture(stream, context, epoch);
  }

  /** Ends the call (the founder pressed End, the limit was reached, or the server ended it). */
  async end(reason: CallEndReason = 'user'): Promise<void> {
    const { phase, call } = this.snapshot;
    if (phase === 'starting') {
      this.epoch += 1;
      this.teardown();
      this.set({ ...IDLE_CALL });
      return;
    }
    if (phase !== 'live') return;
    const durationSeconds = this.elapsedSeconds();
    // Whatever ends the call (its time limit, the server, lost heartbeats, the founder), the crisis support
    // line is heard to its end and the support stays on screen: everything else closes now.
    const support = supportShown(this.snapshot.blocked);
    const keepLine = this.sayingCrisisLine();
    this.epoch += 1;
    this.teardown(keepLine);
    this.set({
      phase: 'ending',
      activity: 'connecting',
      captions: IDLE_CALL.captions,
      notice: null,
      blocked: support,
      held: false,
      audioBlocked: false,
      queued: 0,
    });
    const sessionId = this.snapshot.sessionId;
    let ended: CallEnded = {
      reason,
      durationSeconds,
      turnCount: this.turnCount,
      summary: null,
      summaryError: null,
      blocked: support,
    };
    if (call) {
      try {
        const result = await this.deps.api.endCall(call.id, { reason, clientStats: this.clientStats() });
        ended = {
          reason: result.call.endReason ?? reason,
          durationSeconds: result.summary.durationSeconds,
          turnCount: result.summary.turnCount,
          summary: result.summary,
          summaryError: null,
          blocked: support,
        };
        this.set({ call: result.call });
      } catch (error) {
        ended = { ...ended, summaryError: callErrorMessage(error) };
      }
    }
    if (sessionId) this.deps.onTurnSettled?.(sessionId, null);
    this.set({ phase: 'ended', ended });
  }

  /**
   * The page or the app shell is going away mid-call: end it with a keepalive request (no summary) and
   * release the microphone at once.
   */
  dispose(): void {
    const { phase, call } = this.snapshot;
    if (phase === 'live' && call) {
      if (this.beacon) this.beacon.send();
      else void this.deps.api.endCall(call.id, { reason: 'navigated' }).catch(() => undefined);
    }
    this.epoch += 1;
    this.teardown();
    this.releaseLingering();
    this.set({ ...IDLE_CALL });
  }

  /** After an ended or failed call: back to idle, ready for the next one (a crisis line still plays out). */
  reset(): void {
    if (this.snapshot.phase === 'live' || this.snapshot.phase === 'starting') return;
    this.epoch += 1;
    this.teardown();
    this.set({ ...IDLE_CALL });
  }

  // Controls ------------------------------------------------------------------------------------------

  /** A typed line: spoken back like any other turn of the call. */
  sendText(text: string): void {
    const line = text.trim();
    if (line === '' || this.snapshot.phase !== 'live') return;
    if (this.snapshot.activity === 'speaking') this.bargeIn();
    this.endpointer.discard();
    this.setCaptions({ founder: line, founderLive: false });
    this.utterance(line);
  }

  setMuted(muted: boolean): void {
    if (this.snapshot.phase !== 'live' || this.snapshot.input !== 'voice' || muted === this.snapshot.muted)
      return;
    // Muting also lets go of push-to-talk, and nothing reconnects while muted (on hold, reading support):
    // unmuting starts speech-to-text afresh, with a fresh window to reconnect in.
    this.set(muted ? { muted, held: false, talking: false, reconnecting: false } : { muted, held: false });
    this.capture?.setEnabled(!muted);
    if (muted) {
      // Close speech-to-text while muted: nothing is sent and nothing is billed.
      this.closeStt();
      this.stopReconnecting();
      this.stopWatchingSilentMic();
      if (this.releaseTimer !== null) this.deps.clock.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
      this.endpointer.discard();
      this.vad.reset();
      this.founderLevel = 0;
      this.setCaptions({ founder: null, founderLive: false });
    } else {
      if (this.capture?.sourceMuted) this.watchSilentMic();
      void this.connectStt(this.epoch);
    }
  }

  /**
   * After the microphone disconnected (or was refused when asked again): asks for it again and goes back to
   * voice. Call it from a tap (Reconnect microphone). A call that started typed stays typed.
   */
  async reconnectMicrophone(): Promise<void> {
    const s = this.snapshot;
    const context = this.context;
    const getUserMedia = this.deps.media.getUserMedia;
    if (
      s.phase !== 'live' ||
      s.input !== 'typed' ||
      s.call?.inputMode !== 'transcribe' ||
      !(
        s.typedReason === 'mic_lost' ||
        s.typedReason === 'mic_denied' ||
        s.typedReason === 'mic_unavailable'
      ) ||
      context === null ||
      getUserMedia === null
    ) {
      return;
    }
    const epoch = this.epoch;
    let stream: MediaStream;
    try {
      stream = await requestMicrophone(getUserMedia);
    } catch (error) {
      if (epoch !== this.epoch || this.snapshot.input !== 'typed') return;
      const denied = error instanceof MicrophoneError && error.reason === 'denied';
      this.set({ typedReason: denied ? 'mic_denied' : 'mic_unavailable' });
      return;
    }
    const now = this.snapshot;
    if (epoch !== this.epoch || now.phase !== 'live' || now.input !== 'typed') {
      stopStream(stream);
      return;
    }
    this.stopReconnecting();
    this.set({
      input: 'voice',
      typedReason: null,
      muted: false,
      activity: now.activity === 'listening' ? 'connecting' : now.activity,
    });
    await this.startCapture(stream, context, epoch);
  }

  setTalkMode(talkMode: TalkMode): void {
    if (talkMode === this.snapshot.talkMode) return;
    this.endpointer.discard();
    const notice = this.snapshot.notice?.kind === 'barge_hint' ? null : this.snapshot.notice;
    this.set({ talkMode, talking: false, notice });
  }

  /** Push-to-talk held (true) or released (false). Releasing ends the turn. */
  pushToTalk(pressed: boolean): void {
    const s = this.snapshot;
    if (s.phase !== 'live' || s.talkMode !== 'push_to_talk' || s.input !== 'voice' || s.talking === pressed)
      return;
    this.set({ talking: pressed });
    if (pressed) {
      if (this.releaseTimer !== null) this.deps.clock.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
      if (s.muted) this.setMuted(false);
      if (s.activity === 'speaking') this.bargeIn();
      return;
    }
    this.releaseTimer = this.deps.clock.setTimeout(() => {
      this.releaseTimer = null;
      const line = this.endpointer.take();
      if (line) this.utterance(line);
    }, this.tuning.releaseSettleMs);
  }

  /** Stops the vEIR mid-sentence (Esc, or tapping the presence). */
  interrupt(): void {
    if (this.snapshot.activity === 'speaking' && !this.sayingCrisisSupport()) this.bargeIn();
  }

  /**
   * The vEIR is saying the fixed crisis support line (the one unit of a crisis turn, said before the support
   * panel): nothing cuts it off, neither Esc, Interrupt nor a voice that sounds like a barge-in.
   */
  private sayingCrisisSupport(): boolean {
    const blocked = this.snapshot.blocked;
    const playing = this.player?.current ?? null;
    return blocked?.reason === 'crisis_support' && playing !== null && playing.turnId === this.crisisTurnId;
  }

  /** The crisis support line is being said, or is still to be said (being fetched after the block). */
  private sayingCrisisLine(): boolean {
    const player = this.player;
    if (this.snapshot.blocked?.reason !== 'crisis_support' || this.crisisTurnId === null || !player?.busy) {
      return false;
    }
    return player.current === null || player.current.turnId === this.crisisTurnId;
  }

  /**
   * Puts the call on hold while the page is hidden: the microphone is muted and speech-to-text closed, so
   * nothing is heard or billed. The founder resumes with a tap (which also lets the browser play again).
   */
  hold(): void {
    const s = this.snapshot;
    if (s.phase !== 'live' || s.input !== 'voice' || s.muted) return;
    this.setMuted(true);
    this.set({ held: true });
  }

  /** Back from hold. Call it from a tap. */
  resume(): void {
    if (!this.snapshot.held) return;
    this.resumeAudio();
    this.setMuted(false);
  }

  /**
   * Lets the call's audio play. Browsers keep an AudioContext silent until a user gesture: when the call
   * started without one, the screen offers Turn on sound, whose tap calls this.
   */
  resumeAudio(): void {
    const context = this.context;
    if (!context || context.state === 'closed') return;
    context.resume().then(this.onAudioState, this.onAudioState);
  }

  private syncAudioState(): void {
    const context = this.context;
    const blocked =
      this.snapshot.phase === 'live' &&
      context !== null &&
      context.state !== 'running' &&
      context.state !== 'closed';
    if (blocked !== this.snapshot.audioBlocked) this.set({ audioBlocked: blocked });
  }

  // Speech-to-text ------------------------------------------------------------------------------------

  private async startCapture(stream: MediaStream, context: CallAudioContext, epoch: number): Promise<void> {
    // The grant only opens a stream for a few seconds after it was minted: connect while the capture
    // worklet loads instead of after it (frames are sent once both are ready).
    const connecting = this.connectStt(epoch);
    try {
      const capture = await MicCapture.start(
        {
          context,
          getUserMedia: this.deps.media.getUserMedia ?? (() => Promise.reject(new Error('no microphone'))),
          createWorkletNode: (name, options) => this.deps.media.createWorkletNode(context, name, options),
          watchDevices: this.deps.media.watchDevices,
        },
        stream,
      );
      // Ended, or switched to typing while the worklet loaded (speech-to-text refused): release the mic.
      if (epoch !== this.epoch || this.snapshot.input !== 'voice') {
        capture.stop();
        await connecting;
        return;
      }
      this.capture = capture;
      capture.onFrame((pcm, rms) => {
        this.onFrame(pcm, rms);
      });
      capture.onTrackChange((change) => {
        this.onTrackChange(change);
      });
      if (capture.sourceMuted) this.watchSilentMic();
    } catch {
      stopStream(stream);
      if (epoch !== this.epoch) return;
      this.toTyped('mic_unavailable');
      await connecting;
      return;
    }
    await connecting;
  }

  /** The microphone went away or went silent at its source (unplugged, revoked, taken by another app). */
  private onTrackChange(change: TrackChange): void {
    if (change === 'ended') this.micLost();
    else if (change === 'muted') this.watchSilentMic();
    else this.stopWatchingSilentMic();
  }

  /** A source the system mutes for a moment comes back; one that stays muted is treated as gone. */
  private watchSilentMic(): void {
    const s = this.snapshot;
    if (s.phase !== 'live' || s.input !== 'voice' || s.muted || this.micSilentTimer !== null) return;
    this.micSilentTimer = this.deps.clock.setTimeout(() => {
      this.micSilentTimer = null;
      if (this.capture?.sourceMuted) this.micLost();
    }, this.tuning.micSilentMs);
  }

  private stopWatchingSilentMic(): void {
    if (this.micSilentTimer !== null) this.deps.clock.clearTimeout(this.micSilentTimer);
    this.micSilentTimer = null;
  }

  /** Nothing the founder says can be heard any more: say so, and continue by typing (Reconnect offered). */
  private micLost(): void {
    const s = this.snapshot;
    if (s.phase !== 'live' || s.input !== 'voice') return;
    this.toTyped('mic_lost');
  }

  /** Speech-to-text should be connected and is not. */
  private sttWanted(): boolean {
    const s = this.snapshot;
    return s.phase === 'live' && s.input === 'voice' && !s.muted && this.stt === null;
  }

  private async connectStt(epoch: number): Promise<void> {
    const call = this.snapshot.call;
    if (!call || !this.sttWanted()) return;
    let grant = this.grant;
    if (grant === null || Date.parse(grant.expiresAt) - this.deps.clock.now() < GRANT_MARGIN_MS) {
      try {
        grant = await this.deps.api.refreshSttGrant(call.id);
      } catch {
        if (epoch === this.epoch) this.sttLost();
        return;
      }
      if (epoch !== this.epoch) return;
      this.grant = grant;
    }
    // The founder may have muted (or the stream reconnected) while the grant was minted.
    if (!this.sttWanted()) return;
    let stream: TranscribeStream | null = null;
    const handlers: TranscribeHandlers = {
      onOpen: () => {
        if (this.stt !== stream) return;
        this.sttOpenedAt = this.deps.clock.now();
        this.reconnectSince = null;
        this.reconnectAttempt = 0;
        if (this.snapshot.reconnecting) this.set({ reconnecting: false });
        if (this.snapshot.activity === 'connecting') this.set({ activity: 'listening' });
      },
      onResult: (result) => {
        if (this.stt !== stream) return;
        this.onTranscript(result);
      },
      onClose: ({ expected }) => {
        if (this.stt !== stream) return;
        this.stopMicClock();
        this.stt = null;
        if (!expected && epoch === this.epoch && !this.snapshot.muted) this.sttLost();
      },
    };
    try {
      stream = new TranscribeStream(grant.url, handlers, this.deps.media.createSocket);
    } catch (error) {
      // The socket could not even be created. A SecurityError (the page's CSP or the browser refuses the
      // host) will refuse every retry too: continue by typing at once. Anything else is retried.
      if (errorName(error) === 'SecurityError') this.toTyped('stt_unavailable');
      else this.sttLost();
      return;
    }
    this.stt = stream;
  }

  private closeStt(): void {
    const stream = this.stt;
    this.stt = null;
    this.stopMicClock();
    stream?.end();
  }

  /** The Transcribe socket dropped: reconnect with a fresh grant, or continue by typing after a while. */
  private sttLost(): void {
    const s = this.snapshot;
    // Muted meanwhile (a grant request that failed after the founder muted): unmuting reconnects.
    if (s.phase !== 'live' || s.input !== 'voice' || s.muted) return;
    const now = this.deps.clock.now();
    this.reconnectSince ??= now;
    if (now - this.reconnectSince >= this.tuning.reconnectWindowMs) {
      this.toTyped('stt_failed');
      return;
    }
    this.stats.reconnects += 1;
    this.grant = null;
    if (!this.snapshot.reconnecting) this.set({ reconnecting: true });
    const delay = Math.min(4_000, 500 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    const epoch = this.epoch;
    this.reconnectTimer = this.deps.clock.setTimeout(() => {
      this.reconnectTimer = null;
      if (epoch === this.epoch) void this.connectStt(epoch);
    }, delay);
  }

  private stopReconnecting(): void {
    if (this.reconnectTimer !== null) this.deps.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectSince = null;
    this.reconnectAttempt = 0;
  }

  private toTyped(reason: TypedReason): void {
    this.closeStt();
    this.stopReconnecting();
    this.stopWatchingSilentMic();
    this.capture?.stop();
    this.capture = null;
    this.endpointer.discard();
    this.founderLevel = 0;
    this.set({
      input: 'typed',
      typedReason: reason,
      reconnecting: false,
      muted: false,
      talking: false,
      held: false,
      activity: this.snapshot.activity === 'connecting' ? 'listening' : this.snapshot.activity,
      captions: { ...this.snapshot.captions, founder: null, founderLive: false },
    });
  }

  private onFrame(pcm: Int16Array, rms: number): void {
    const s = this.snapshot;
    if (s.phase !== 'live' || s.muted) return;
    this.founderLevel = rms;
    const gated =
      (s.talkMode === 'push_to_talk' && !s.talking) || (s.halfDuplex && s.activity === 'speaking');
    if (gated) {
      // Keep the stream alive with silence: nothing counts until the founder holds to talk, or (half duplex)
      // until the vEIR has finished.
      this.founderLevel = 0;
      this.stt?.sendPcm(new Int16Array(pcm.length));
      return;
    }
    this.stt?.sendPcm(pcm);
    const vad = this.vad.update(rms);
    if (vad.voiced) this.endpointer.onVoice();
    if (vad.onset && s.activity === 'speaking') this.duckForBargeIn();
    if (s.activity === 'speaking' && s.talkMode === 'hands_free') {
      // The voice runs on over the vEIR: the founder is taking the floor, before the transcript says so.
      if (this.voiceRun.frame(vad.voiced) >= BARGE_SUSTAIN_MS && this.voiceTakesFloor()) {
        this.bargeIn();
        this.watchSilentBarge();
      }
    } else {
      this.voiceRun.reset();
    }
    // While the vEIR speaks, only a barge-in hands the floor over: what is heard meanwhile is its echo or a
    // backchannel, and never completes a turn.
    if (s.talkMode === 'hands_free' && s.activity !== 'speaking' && this.endpointer.isComplete()) {
      if (this.turn !== null) {
        // Between the sentences of a reply, the last one may still be coming back through the speakers.
        this.forgetNonWords();
        if (!this.endpointer.hasSpeech()) {
          this.setCaptions({ founder: null, founderLive: false });
          return;
        }
      }
      const line = this.endpointer.take();
      this.setCaptions({ founder: line, founderLive: false });
      this.utterance(line);
    }
  }

  private onTranscript(result: Parameters<Endpointer['onResult']>[0]): void {
    const s = this.snapshot;
    if (s.phase !== 'live' || s.muted) return;
    if (s.talkMode === 'push_to_talk' && !s.talking && this.releaseTimer === null) return;
    if (s.halfDuplex && s.activity === 'speaking') return;
    this.endpointer.onResult(result);
    const heard = this.endpointer.text();
    if (heard === '') return;
    if (s.activity === 'speaking' && s.talkMode === 'hands_free') {
      // Barge-in needs the founder taking the floor: a settled word that is neither the vEIR's echo nor a
      // backchannel ("yeah", "mm-hmm"), one such word Transcribe already marked stable, one while the voice runs
      // on, or two such words while the transcript is still changing.
      const taking = floorWords(heard, this.spokenSoFar).length;
      const settled = result.stable || !result.partial;
      const stableWord = floorWords(result.stableText ?? '', this.spokenSoFar).length > 0;
      const voiced = !this.sustainBargeOff && this.voiceRun.duration() >= BARGE_WORD_SUSTAIN_MS;
      if (taking < (settled ? 1 : 2) && !stableWord && !(taking >= 1 && voiced)) {
        // A settled echo or backchannel is not a turn either (a revision that adds words is heard afresh).
        if (settled) this.forgetNonWords();
        return;
      }
      this.bargeIn();
      this.forgetNonWords();
    }
    const line = this.endpointer.text();
    if (line !== '') this.setCaptions({ founder: line, founderLive: true });
  }

  /** Drops what was only the vEIR's echo or a backchannel from what the founder is saying. */
  private forgetNonWords(): void {
    this.endpointer.retain((text) => floorWords(text, this.spokenSoFar).length > 0);
  }

  /**
   * Whether the voice running on over the vEIR is the founder taking the floor: not on a call where voice alone
   * already stopped it for nothing, and not when the words heard so far are only its echo or backchannels.
   */
  private voiceTakesFloor(): boolean {
    if (this.sustainBargeOff || this.sayingCrisisSupport()) return false;
    const heard = this.endpointer.text();
    return heard === '' || floorWords(heard, this.spokenSoFar).length > 0;
  }

  /**
   * After voice alone stopped the vEIR: when no word follows, the sound was not the founder (speakers, a room), so
   * from now on on this call only words stop it (and push to talk is suggested as for other sound without words).
   */
  private watchSilentBarge(): void {
    if (this.silentBargeTimer !== null) this.deps.clock.clearTimeout(this.silentBargeTimer);
    const turns = this.turnCount;
    this.silentBargeTimer = this.deps.clock.setTimeout(() => {
      this.silentBargeTimer = null;
      if (this.snapshot.phase !== 'live' || this.turnCount !== turns || this.endpointer.hasSpeech()) return;
      this.sustainBargeOff = true;
      this.falseBargeIn();
    }, SILENT_BARGE_MS);
  }

  private duckForBargeIn(): void {
    this.player?.duck();
    if (this.bargeTimer !== null) this.deps.clock.clearTimeout(this.bargeTimer);
    this.bargeTimer = this.deps.clock.setTimeout(() => {
      // No word followed the sound (a cough, the speakers): restore the vEIR's volume.
      this.bargeTimer = null;
      this.player?.unduck();
      this.falseBargeIn();
    }, this.tuning.bargeConfirmMs);
  }

  /** Repeated sound without words while the vEIR speaks: suggest push-to-talk once. */
  private falseBargeIn(): void {
    this.falseBargeIns += 1;
    const s = this.snapshot;
    if (this.falseBargeIns !== this.tuning.falseBargeInHint || s.talkMode !== 'hands_free') return;
    this.set({
      notice: {
        kind: 'barge_hint',
        message: 'Sound around you keeps pausing the reply. Headphones or push to talk will help.',
      },
    });
  }

  // Turns ---------------------------------------------------------------------------------------------

  /**
   * A finished line from the founder: sent now, or after the vEIR finishes its current reply. The call's greeting
   * is not a reply: a line typed or said while it is still on its way or being said stops it and is sent at once
   * (the lab: every call's first line waited 11–14 s for the greeting to play out).
   */
  private utterance(text: string): void {
    if (text === '') return;
    if (this.greeting()) this.bargeIn();
    this.pendingLines.push(text);
    if ((this.turn !== null && !this.turn.done) || this.player?.busy) {
      this.set({ queued: this.pendingLines.length });
      return;
    }
    void this.submit(this.pendingLines.splice(0).join(' '));
  }

  private async submit(text: string): Promise<void> {
    const sessionId = this.snapshot.sessionId;
    const call = this.snapshot.call;
    if (!sessionId || !call) return;
    const epoch = this.epoch;
    const turn: ActiveTurn = {
      controller: new AbortController(),
      turnId: null,
      heardSeq: -1,
      heard: [],
      units: 0,
      done: false,
      interrupted: false,
      submittedAt: this.deps.clock.now(),
      firstAudioAt: null,
    };
    this.turn = turn;
    this.turnCount += 1;
    this.spokenSoFar = '';
    this.set({
      activity: 'thinking',
      notice: this.snapshot.notice?.kind === 'turn_error' ? null : this.snapshot.notice,
      blocked: null,
      queued: 0,
      captions: { ...this.snapshot.captions, veir: null },
    });
    let settled: TurnView | null = null;
    try {
      const events = this.deps.api.streamTurn(
        sessionId,
        { text, channel: 'voice', callId: call.id },
        { signal: turn.controller.signal, idempotencyKey: globalThis.crypto.randomUUID() },
      );
      for await (const event of events) {
        if (epoch !== this.epoch || turn.interrupted) break;
        settled = this.onTurnEvent(turn, event) ?? settled;
      }
    } catch (error) {
      if (epoch === this.epoch && !turn.interrupted && !turn.controller.signal.aborted) {
        this.set({ notice: { kind: 'turn_error', message: turnErrorLine(callErrorMessage(error)) } });
      }
    } finally {
      turn.done = true;
      if (epoch === this.epoch) {
        this.deps.onTurnSettled?.(sessionId, settled);
        if (this.turn === turn && !this.player?.busy) this.afterReply();
      }
    }
  }

  /** Handles one stream event; returns the completed turn when there is one. */
  private onTurnEvent(turn: ActiveTurn, event: TurnStreamEventT): TurnView | null {
    switch (event.event) {
      case 'turn.accepted':
        turn.turnId = event.turnId;
        return null;
      case 'turn.speech':
        turn.turnId ??= event.turnId;
        turn.units += 1;
        this.player?.enqueue({
          turnId: event.turnId,
          seq: event.seq,
          text: event.text,
          sig: event.sig,
          ...(event.face === true ? { faceApproved: true } : {}),
        });
        return null;
      case 'turn.completed': {
        const completed = event.turn;
        turn.turnId = completed.id;
        if (turn.units === 0 && completed.status === 'completed' && completed.response) {
          // No streamed units (streaming is off): speak the stored, validated spoken reply sentence by
          // sentence. A reply without one is shown, never voiced.
          const { spoken, answer } = completed.response;
          if (spoken) {
            speakableSentences(spoken).forEach((text, seq) => {
              turn.units += 1;
              this.player?.enqueue({ turnId: completed.id, seq, text });
            });
          } else {
            this.setCaptions({ veir: openingText(answer) || null });
          }
        }
        return completed;
      }
      case 'turn.blocked':
        // Crisis support is said first (the fixed support line arrives as signed units of this turn), so
        // it keeps playing to its end; any other held-back reply stops at once.
        if (event.reason === 'crisis_support') this.crisisTurnId = event.turnId;
        else this.player?.stop();
        // The founder reads the support; nothing more is listened to until they unmute.
        this.setMuted(true);
        this.set({
          blocked: {
            reason: event.reason,
            escalationId: event.escalationId,
            supportMessage: event.supportMessage,
          },
          notice: null,
        });
        return null;
      case 'turn.error':
        this.set({ notice: { kind: 'turn_error', message: turnErrorLine(event.message) } });
        return null;
      case 'turn.status':
      case 'turn.delta':
        return null;
    }
  }

  /** The reply is over (heard, cut off or failed): listen again, then send what waited. */
  private afterReply(): void {
    this.turn = null;
    if (this.snapshot.phase !== 'live') return;
    // A "yeah" or the vEIR's own echo heard while it spoke is not the founder's next turn.
    if (this.endpointer.hasSpeech()) {
      this.forgetNonWords();
      if (!this.endpointer.hasSpeech()) this.setCaptions({ founder: null, founderLive: false });
    }
    const waiting = this.pendingLines.splice(0);
    this.set({ activity: 'listening', queued: 0 });
    if (waiting.length > 0) void this.submit(waiting.join(' '));
  }

  /** Only the call's greeting is being fetched or said (no reply of a turn, never the crisis support line). */
  private greeting(): boolean {
    return this.turn === null && this.player?.busy === true && !this.sayingCrisisLine();
  }

  /** The founder spoke over the vEIR: stop the audio, abort the stream, record what was heard. */
  private bargeIn(): void {
    if (this.sayingCrisisSupport()) return;
    const turn = this.turn;
    if (this.bargeTimer !== null) this.deps.clock.clearTimeout(this.bargeTimer);
    this.bargeTimer = null;
    this.player?.stop();
    this.stats.bargeIns += 1;
    const call = this.snapshot.call;
    if (turn && !turn.interrupted) {
      turn.interrupted = true;
      turn.controller.abort();
      if (turn.turnId && call) {
        void this.deps.api
          .interruptTurn(turn.turnId, { callId: call.id, heardSeq: turn.heardSeq, heard: turn.heard })
          .catch(() => undefined);
      }
    }
    this.turn = null;
    this.set({ activity: 'listening', captions: { ...this.snapshot.captions, veir: null } });
  }

  private createPlayer(context: CallAudioContext, sessionId: string): SpeechPlayer {
    const { clock, media, api } = this.deps;
    // Events of a player that outlived its call (the crisis line) never touch the snapshot of a later call.
    const current = () => player === this.player;
    const player: SpeechPlayer = new SpeechPlayer(
      {
        context,
        fetchSpeech: (unit, signal) => api.fetchSpeech(sessionId, unit, signal),
        synthesis: media.synthesis,
        createUtterance: (text) => media.createUtterance(text),
        setTimeout: (callback, ms) => clock.setTimeout(callback, ms),
        clearTimeout: (handle) => {
          clock.clearTimeout(handle);
        },
        now: clock.now,
      },
      {
        onUnitStart: (unit, route) => {
          if (!current()) return;
          const turn = this.turn;
          if (turn && unit.turnId !== null && unit.turnId === turn.turnId && turn.firstAudioAt === null) {
            turn.firstAudioAt = clock.now();
            this.stats.firstAudioMs.push(turn.firstAudioAt - turn.submittedAt);
          }
          this.spokenSoFar = `${this.spokenSoFar} ${unit.text}`;
          this.set({
            activity: 'speaking',
            voice: route,
            captions: { ...this.snapshot.captions, veir: unit.text },
          });
          for (const listener of this.speakListeners) listener({ text: unit.text });
        },
        onUnitEnd: (unit, completed) => {
          if (!current()) return;
          const turn = this.turn;
          if (!completed || turn?.turnId !== unit.turnId || unit.seq <= turn.heardSeq) return;
          turn.heardSeq = unit.seq;
          turn.heard.push({ seq: unit.seq, text: unit.text, ...(unit.sig ? { sig: unit.sig } : {}) });
        },
        onVoicePaused: () => {
          if (current()) this.set({ voicePaused: true });
        },
        onIdle: () => {
          if (player === this.lingering?.player) {
            // The crisis line of a call that has ended was heard to its end: release its audio now.
            this.releaseLingering();
            return;
          }
          if (!current() || this.snapshot.phase !== 'live') return;
          if (this.turn && !this.turn.done) this.set({ activity: 'thinking' });
          else this.afterReply();
        },
      },
    );
    player.setFace(this.face);
    return player;
  }

  // Heartbeat and limits ------------------------------------------------------------------------------

  private callState(): CallState {
    const s = this.snapshot;
    if (s.reconnecting) return 'reconnecting';
    if (s.muted) return 'muted';
    if (s.activity === 'connecting') return 'idle';
    return s.activity;
  }

  private async heartbeat(): Promise<void> {
    const call = this.snapshot.call;
    if (this.snapshot.phase !== 'live' || !call) return;
    const epoch = this.epoch;
    try {
      const result = await this.deps.api.heartbeat(call.id, {
        state: this.callState(),
        micOpenSeconds: this.micOpenSeconds(),
        ...(this.faceShown === null ? {} : { face: this.faceShown ? 'live' : 'off' }),
      });
      if (epoch !== this.epoch) return;
      this.missedHeartbeats = 0;
      this.set({ remaining: { seconds: result.remainingSeconds, at: this.deps.clock.now() } });
      if (result.face === 'stop') for (const listener of [...this.faceStopListeners]) listener();
      if (result.action === 'terminate') void this.end(result.reason ?? 'disabled');
    } catch {
      if (epoch !== this.epoch) return;
      this.missedHeartbeats += 1;
      if (this.missedHeartbeats >= this.tuning.maxMissedHeartbeats) void this.end('error');
    }
  }

  private remainingNow(): number | null {
    const remaining = this.snapshot.remaining;
    if (!remaining) return null;
    return remaining.seconds - (this.deps.clock.now() - remaining.at) / 1000;
  }

  private tick(): void {
    if (this.snapshot.phase !== 'live') return;
    const left = this.remainingNow();
    if (left === null) return;
    if (left <= 0) {
      void this.end('timeout');
      return;
    }
    if (left <= this.tuning.warnSeconds && !this.warned) {
      this.warned = true;
      this.set({
        notice: {
          kind: 'time_warning',
          message: minutesLeftLine(left),
        },
      });
    }
  }

  // Accounting and teardown ---------------------------------------------------------------------------

  private elapsedSeconds(): number {
    const liveAt = this.snapshot.liveAt;
    return liveAt === null ? 0 : Math.max(0, Math.round((this.deps.clock.now() - liveAt) / 1000));
  }

  private stopMicClock(): void {
    if (this.sttOpenedAt !== null) this.micOpenMs += this.deps.clock.now() - this.sttOpenedAt;
    this.sttOpenedAt = null;
  }

  private micOpenSeconds(): number {
    const open = this.sttOpenedAt === null ? 0 : this.deps.clock.now() - this.sttOpenedAt;
    return Math.min(24 * 3600, Math.round((this.micOpenMs + open) / 1000));
  }

  private clientStats(): NonNullable<EndCallBody['clientStats']> {
    return {
      firstAudioMsP50: percentile(this.stats.firstAudioMs, 50),
      firstAudioMsP95: percentile(this.stats.firstAudioMs, 95),
      bargeIns: Math.min(10_000, this.stats.bargeIns),
      reconnects: Math.min(10_000, this.stats.reconnects),
    };
  }

  private resetCounters(): void {
    this.turnCount = 0;
    this.missedHeartbeats = 0;
    this.falseBargeIns = 0;
    this.sustainBargeOff = false;
    this.voiceRun.reset();
    this.warned = false;
    this.spokenSoFar = '';
    this.micOpenMs = 0;
    this.sttOpenedAt = null;
    this.reconnectSince = null;
    this.reconnectAttempt = 0;
    this.stats.bargeIns = 0;
    this.stats.reconnects = 0;
    this.stats.firstAudioMs = [];
    this.pendingLines.length = 0;
    this.endpointer = new Endpointer(this.deps.clock.now, { silenceMs: this.tuning.silenceMs });
    this.vad.reset();
  }

  /** Stops everything of the call; `keepCrisisLine` lets the crisis support line being said play out. */
  private teardown(keepCrisisLine = false): void {
    const { clock } = this.deps;
    for (const timer of [this.heartbeatTimer, this.tickTimer]) if (timer !== null) clock.clearInterval(timer);
    for (const timer of [
      this.bargeTimer,
      this.releaseTimer,
      this.reconnectTimer,
      this.micSilentTimer,
      this.silentBargeTimer,
    ]) {
      if (timer !== null) clock.clearTimeout(timer);
    }
    this.silentBargeTimer = null;
    this.heartbeatTimer = this.tickTimer = this.bargeTimer = this.releaseTimer = this.reconnectTimer = null;
    this.micSilentTimer = null;
    this.turn?.controller.abort();
    this.turn = null;
    this.pendingLines.length = 0;
    this.closeStt();
    this.capture?.stop();
    this.capture = null;
    this.grant = null;
    this.beacon = null;
    this.founderLevel = 0;
    if (keepCrisisLine) this.lingerCrisisLine();
    else this.releaseAudio();
  }

  /** Keeps the player (and its audio) of the crisis line past the call, until it is heard to its end. */
  private lingerCrisisLine(): void {
    const { player, context } = this;
    if (player === null || context === null) {
      this.releaseAudio();
      return;
    }
    this.releaseLingering();
    this.player = null;
    this.context = null;
    context.removeEventListener('statechange', this.onAudioState);
    this.lingering = { player, context };
  }

  private releaseLingering(): void {
    const lingering = this.lingering;
    this.lingering = null;
    if (!lingering) return;
    lingering.player.dispose();
    if (lingering.context.state !== 'closed') void lingering.context.close().catch(() => undefined);
  }

  private releaseAudio(): void {
    this.player?.dispose();
    this.player = null;
    const context = this.context;
    this.context = null;
    if (!context) return;
    context.removeEventListener('statechange', this.onAudioState);
    if (context.state !== 'closed') void context.close().catch(() => undefined);
  }
}

/** Reasons whose panel is support for the founder (crisis lines, a safety hand-over), as BlockedPanel tells. */
const SUPPORT_REASON = /crisis|safety|wellbeing|harm/i;

/** The support a call was showing, kept with its summary when it ends; a held-back answer is not kept. */
function supportShown(blocked: TurnBlockedDetail | null): TurnBlockedDetail | null {
  if (blocked === null) return null;
  return blocked.supportMessage !== null || SUPPORT_REASON.test(blocked.reason) ? blocked : null;
}

function errorName(error: unknown): string | null {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : null;
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

/** The line shown (never spoken: only validated text is voiced) when a turn fails. */
function turnErrorLine(message: string): string {
  return `Sorry, I couldn’t answer that. ${message}`;
}

function minutesLeftLine(secondsLeft: number): string {
  const minutes = Math.max(1, Math.round(secondsLeft / 60));
  return minutes === 1
    ? 'About a minute left on this call.'
    : `${String(minutes)} minutes left on this call.`;
}
