import type { CallEndReason, CallState, SttGrant, TurnView } from '@foundry/contracts';

import { errorMessage, isApiError } from '../api/errors';
import type { CreateTurnBody, StreamTurnOptions, TurnStreamEventT } from '../api/sse';
import type { AvatarState, SpokenUnit } from './avatar';
import type {
  EndCallBody,
  EndCallResult,
  HeartbeatBody,
  HeartbeatResult,
  PreparedBeacon,
  StartCallResult,
} from './call-api';
import { MicCapture, MicrophoneError, requestMicrophone, type CaptureAudio } from './capture';
import { Endpointer, isLikelyEcho } from './endpointing';
import { SpeechPlayer, type PlayerAudio, type SpeechFetchResult, type SpeechUnitToPlay } from './playback';
import { IDLE_CALL, type CallEnded, type CallSnapshot, type TalkMode, type TypedReason } from './call-state';
import { TranscribeStream, type WebSocketFactory } from './transcribe';
import { VoiceActivityDetector } from './vad';

export type {
  CallActivity,
  CallEnded,
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
 * Barge-in: voice while the vEIR speaks ducks it at once; a word that is not its own echo stops the audio,
 * aborts the turn stream and POSTs /turns/:id/interrupt with the last unit actually heard. A heartbeat every
 * 15 s carries the server's kill switches and remaining minutes. Without a microphone or speech-to-text
 * (local development, a refusal) the call continues by typing; replies are still spoken.
 *
 * The engine is framework-free (React reads it through `subscribe`/`getSnapshot`) and every browser edge is
 * a dependency, so it is unit tested with fakes. Nothing here logs content.
 */

export interface CallEngineApi {
  startCall(sessionId: string, inputMode: 'transcribe' | 'typed'): Promise<StartCallResult>;
  refreshSttGrant(callId: string): Promise<SttGrant>;
  heartbeat(callId: string, body: HeartbeatBody): Promise<HeartbeatResult>;
  endCall(callId: string, body: EndCallBody): Promise<EndCallResult>;
  interruptTurn(turnId: string, body: { callId: string; heardSeq: number }): Promise<void>;
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
}

export const DEFAULT_TUNING: CallTuning = {
  silenceMs: 600,
  heartbeatMs: 15_000,
  reconnectWindowMs: 30_000,
  bargeConfirmMs: 1_200,
  releaseSettleMs: 700,
  warnSeconds: 120,
  maxMissedHeartbeats: 3,
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
}

interface ActiveTurn {
  readonly controller: AbortController;
  turnId: string | null;
  /** Last unit of this turn heard to its end (-1: none). */
  heardSeq: number;
  units: number;
  done: boolean;
  interrupted: boolean;
  readonly submittedAt: number;
  firstAudioAt: number | null;
}

/** A grant this close to expiry is re-minted before connecting with it. */
const GRANT_MARGIN_MS = 15_000;

/** Sentences of a stored reply, each a passage `POST /speech` accepts on its own. */
export function speakableUnits(text: string, maxChars = 600): string[] {
  const plain = text
    .replace(/\[(E\d+(?:\s*[,;]\s*E\d+)*)\]/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
  if (plain === '') return [];
  const sentences = plain.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) ?? [plain];
  const units: string[] = [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence === '') continue;
    if (sentence.length <= maxChars) {
      units.push(sentence);
      continue;
    }
    // A run-on sentence is cut at word boundaries.
    let rest = sentence;
    while (rest.length > maxChars) {
      const cut = rest.lastIndexOf(' ', maxChars);
      const at = cut > maxChars / 2 ? cut : maxChars;
      units.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) units.push(rest);
  }
  return units;
}

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
  private capture: MicCapture | null = null;
  private stt: TranscribeStream | null = null;
  private grant: SttGrant | null = null;
  private readonly vad = new VoiceActivityDetector();
  private endpointer: Endpointer;
  private turn: ActiveTurn | null = null;
  private readonly pendingLines: string[] = [];
  private beacon: PreparedBeacon | null = null;
  private founderLevel = 0;
  /** Bumped whenever a call starts or stops, so late async work for an old call is ignored. */
  private epoch = 0;
  private turnCount = 0;

  private heartbeatTimer: unknown = null;
  private tickTimer: unknown = null;
  private bargeTimer: unknown = null;
  private releaseTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private missedHeartbeats = 0;
  private warned = false;
  private sttOpenedAt: number | null = null;
  private micOpenMs = 0;
  private reconnectSince: number | null = null;
  private reconnectAttempt = 0;
  private readonly stats = { bargeIns: 0, reconnects: 0, firstAudioMs: [] as number[] };

  constructor(private readonly deps: CallEngineDeps) {
    this.tuning = { ...DEFAULT_TUNING, ...deps.tuning };
    this.endpointer = new Endpointer(deps.clock.now, { silenceMs: this.tuning.silenceMs });
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
      } else {
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
   * creates may only play sound after one.
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
    });

    const context = this.deps.media.createAudioContext();
    if (context === null) {
      this.set({ phase: 'failed', error: 'This browser can’t play call audio. Continue in chat instead.' });
      return;
    }
    this.context = context;
    void context.resume().catch(() => undefined);
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
      started = await this.deps.api.startCall(options.sessionId, stream ? 'transcribe' : 'typed');
    } catch (error) {
      stopStream(stream);
      if (epoch !== this.epoch) return;
      this.releaseAudio();
      this.set({ phase: 'failed', error: errorMessage(error) });
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
    this.epoch += 1;
    this.teardown();
    this.set({
      phase: 'ending',
      activity: 'connecting',
      captions: IDLE_CALL.captions,
      notice: null,
      queued: 0,
    });
    const sessionId = this.snapshot.sessionId;
    let ended: CallEnded = {
      reason,
      durationSeconds,
      turnCount: this.turnCount,
      summary: null,
      summaryError: null,
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
        };
        this.set({ call: result.call });
      } catch (error) {
        ended = { ...ended, summaryError: errorMessage(error) };
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
    this.set({ ...IDLE_CALL });
  }

  /** After an ended or failed call: back to idle, ready for the next one. */
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
    this.set({ muted });
    this.capture?.setEnabled(!muted);
    if (muted) {
      // Close speech-to-text while muted: nothing is sent and nothing is billed.
      this.closeStt();
      this.endpointer.discard();
      this.vad.reset();
      this.founderLevel = 0;
      this.setCaptions({ founder: null, founderLive: false });
    } else {
      void this.connectStt(this.epoch);
    }
  }

  setTalkMode(talkMode: TalkMode): void {
    if (talkMode === this.snapshot.talkMode) return;
    this.endpointer.discard();
    this.set({ talkMode, talking: false });
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
    if (this.snapshot.activity === 'speaking') this.bargeIn();
  }

  // Speech-to-text ------------------------------------------------------------------------------------

  private async startCapture(stream: MediaStream, context: CallAudioContext, epoch: number): Promise<void> {
    try {
      const capture = await MicCapture.start(
        {
          context,
          getUserMedia: this.deps.media.getUserMedia ?? (() => Promise.reject(new Error('no microphone'))),
          createWorkletNode: (name, options) => this.deps.media.createWorkletNode(context, name, options),
        },
        stream,
      );
      if (epoch !== this.epoch) {
        capture.stop();
        return;
      }
      this.capture = capture;
      capture.onFrame((pcm, rms) => {
        this.onFrame(pcm, rms);
      });
    } catch {
      stopStream(stream);
      if (epoch !== this.epoch) return;
      this.toTyped('mic_unavailable');
      return;
    }
    await this.connectStt(epoch);
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
    const stream = new TranscribeStream(
      grant.url,
      {
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
      },
      this.deps.media.createSocket,
    );
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
    if (this.snapshot.phase !== 'live') return;
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

  private toTyped(reason: TypedReason): void {
    this.closeStt();
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
      activity: this.snapshot.activity === 'connecting' ? 'listening' : this.snapshot.activity,
      captions: { ...this.snapshot.captions, founder: null, founderLive: false },
      notice:
        reason === 'stt_failed'
          ? { kind: 'stt_lost', message: 'Voice input stopped. Type instead, or end and call again.' }
          : this.snapshot.notice,
    });
  }

  private onFrame(pcm: Int16Array, rms: number): void {
    const s = this.snapshot;
    if (s.phase !== 'live' || s.muted) return;
    this.founderLevel = rms;
    if (s.talkMode === 'push_to_talk' && !s.talking) {
      // Keep the stream alive with silence; nothing the founder says counts until they hold to talk.
      this.stt?.sendPcm(new Int16Array(pcm.length));
      return;
    }
    this.stt?.sendPcm(pcm);
    const vad = this.vad.update(rms);
    if (vad.voiced) this.endpointer.onVoice();
    if (vad.onset && s.activity === 'speaking') this.duckForBargeIn();
    if (s.talkMode === 'hands_free' && this.endpointer.isComplete()) {
      const line = this.endpointer.take();
      this.setCaptions({ founder: line, founderLive: false });
      this.utterance(line);
    }
  }

  private onTranscript(result: Parameters<Endpointer['onResult']>[0]): void {
    const s = this.snapshot;
    if (s.phase !== 'live' || s.muted) return;
    if (s.talkMode === 'push_to_talk' && !s.talking && this.releaseTimer === null) return;
    this.endpointer.onResult(result);
    const heard = this.endpointer.text();
    if (heard === '') return;
    if (s.activity === 'speaking') {
      if (isLikelyEcho(heard, this.player?.current?.text ?? null)) {
        // The vEIR's own voice through the speakers: not the founder.
        this.endpointer.discard();
        return;
      }
      this.bargeIn();
    }
    this.setCaptions({ founder: heard, founderLive: true });
  }

  private duckForBargeIn(): void {
    this.player?.duck();
    if (this.bargeTimer !== null) this.deps.clock.clearTimeout(this.bargeTimer);
    this.bargeTimer = this.deps.clock.setTimeout(() => {
      this.bargeTimer = null;
      this.player?.unduck();
    }, this.tuning.bargeConfirmMs);
  }

  // Turns ---------------------------------------------------------------------------------------------

  /** A finished line from the founder: sent now, or after the vEIR finishes its current reply. */
  private utterance(text: string): void {
    if (text === '') return;
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
      units: 0,
      done: false,
      interrupted: false,
      submittedAt: this.deps.clock.now(),
      firstAudioAt: null,
    };
    this.turn = turn;
    this.turnCount += 1;
    this.set({
      activity: 'thinking',
      notice: null,
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
        this.set({ notice: { kind: 'turn_error', message: turnErrorLine(turnFailure(error)) } });
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
        this.player?.enqueue({ turnId: event.turnId, seq: event.seq, text: event.text, sig: event.sig });
        return null;
      case 'turn.completed': {
        const completed = event.turn;
        turn.turnId = completed.id;
        if (turn.units === 0 && completed.status === 'completed' && completed.response) {
          // No streamed units (streaming is off, or an older server): speak the stored validated reply, its
          // short spoken form, or the opening of the answer when a reply has none.
          const { spoken, answer } = completed.response;
          const units = spoken ? speakableUnits(spoken) : openingUnits(speakableUnits(answer));
          units.forEach((text, seq) => {
            turn.units += 1;
            this.player?.enqueue({ turnId: completed.id, seq, text });
          });
        }
        return completed;
      }
      case 'turn.blocked':
        this.player?.stop();
        // The founder reads the support resources; nothing more is listened to until they unmute.
        this.setMuted(true);
        this.set({
          notice: {
            kind: 'blocked',
            message: event.supportMessage
              ? 'I can’t help with this on a call. Please look at the support below.'
              : 'I can’t answer that. The conversation shows what to do next.',
            supportMessage: event.supportMessage,
          },
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
    const waiting = this.pendingLines.splice(0);
    this.set({ activity: 'listening', queued: 0 });
    if (waiting.length > 0) void this.submit(waiting.join(' '));
  }

  /** The founder spoke over the vEIR: stop the audio, abort the stream, record what was heard. */
  private bargeIn(): void {
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
          .interruptTurn(turn.turnId, { callId: call.id, heardSeq: turn.heardSeq })
          .catch(() => undefined);
      }
    }
    this.turn = null;
    this.set({ activity: 'listening', captions: { ...this.snapshot.captions, veir: null } });
  }

  private createPlayer(context: CallAudioContext, sessionId: string): SpeechPlayer {
    const { clock, media, api } = this.deps;
    return new SpeechPlayer(
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
        onUnitStart: (unit) => {
          const turn = this.turn;
          if (turn && unit.turnId !== null && unit.turnId === turn.turnId && turn.firstAudioAt === null) {
            turn.firstAudioAt = clock.now();
            this.stats.firstAudioMs.push(turn.firstAudioAt - turn.submittedAt);
          }
          this.set({ activity: 'speaking', captions: { ...this.snapshot.captions, veir: unit.text } });
          for (const listener of this.speakListeners) listener({ text: unit.text });
        },
        onUnitEnd: (unit, completed) => {
          const turn = this.turn;
          if (completed && turn?.turnId === unit.turnId) turn.heardSeq = Math.max(turn.heardSeq, unit.seq);
        },
        onIdle: () => {
          if (this.snapshot.phase !== 'live') return;
          if (this.turn && !this.turn.done) this.set({ activity: 'thinking' });
          else this.afterReply();
        },
        onRouteChange: (voice) => {
          this.set({
            voice,
            notice:
              voice === 'captions'
                ? { kind: 'voice_captions', message: 'Voice unavailable. Replies appear on screen.' }
                : this.snapshot.notice,
          });
        },
      },
    );
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
      });
      if (epoch !== this.epoch) return;
      this.missedHeartbeats = 0;
      this.set({ remaining: { seconds: result.remainingSeconds, at: this.deps.clock.now() } });
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
    this.warned = false;
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

  private teardown(): void {
    const { clock } = this.deps;
    for (const timer of [this.heartbeatTimer, this.tickTimer]) if (timer !== null) clock.clearInterval(timer);
    for (const timer of [this.bargeTimer, this.releaseTimer, this.reconnectTimer]) {
      if (timer !== null) clock.clearTimeout(timer);
    }
    this.heartbeatTimer = this.tickTimer = this.bargeTimer = this.releaseTimer = this.reconnectTimer = null;
    this.turn?.controller.abort();
    this.turn = null;
    this.pendingLines.length = 0;
    this.closeStt();
    this.capture?.stop();
    this.capture = null;
    this.grant = null;
    this.beacon = null;
    this.founderLevel = 0;
    this.releaseAudio();
  }

  private releaseAudio(): void {
    this.player?.dispose();
    this.player = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

/** The line shown (never spoken: only validated text is voiced) when a turn fails. */
function turnErrorLine(message: string): string {
  return `Sorry, I couldn’t answer that. ${message}`;
}

/** Why a spoken turn was refused, in call terms (the generic "this changed" reads oddly on a call). */
function turnFailure(error: unknown): string {
  if (isApiError(error) && error.code === 'conflict' && error.retryAfter === undefined) {
    return 'This call isn’t active any more. End it and call again.';
  }
  return errorMessage(error);
}

/** The words a call speaks of a reply without a spoken form: its opening, about as long as one. */
const SPOKEN_WORD_LIMIT = 70;

function openingUnits(units: readonly string[]): string[] {
  const opening: string[] = [];
  let words = 0;
  for (const unit of units) {
    const count = unit.split(/\s+/).length;
    if (opening.length > 0 && words + count > SPOKEN_WORD_LIMIT) break;
    opening.push(unit);
    words += count;
  }
  return opening;
}

function minutesLeftLine(secondsLeft: number): string {
  const minutes = Math.max(1, Math.round(secondsLeft / 60));
  return minutes === 1
    ? 'About a minute left on this call.'
    : `${String(minutes)} minutes left on this call.`;
}
