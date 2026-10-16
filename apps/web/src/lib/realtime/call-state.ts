import type { CallEndReason, CallSummary, CallView, TurnBlockedDetail } from '@foundry/contracts';

import type { VoiceRoute } from './playback';

/**
 * The state of a call as the UI reads it (CallEngine's snapshot). Kept apart from the engine so the app
 * shell can show "no call" without loading the engine, which loads with the call screen.
 */

export type CallPhase = 'idle' | 'starting' | 'live' | 'ending' | 'ended' | 'failed';
export type CallActivity = 'connecting' | 'listening' | 'thinking' | 'speaking';
export type TalkMode = 'hands_free' | 'push_to_talk';
/** Why the founder types instead of speaking. */
export type TypedReason = 'stt_unavailable' | 'mic_denied' | 'mic_unavailable' | 'stt_failed';

/** A one-line notice under the stage (never spoken: only validated text is voiced). */
export interface CallNotice {
  readonly kind: 'turn_error' | 'time_warning' | 'barge_hint';
  readonly message: string;
}

/** Why a call could not start, and whether trying again may help. */
export interface CallFailure {
  readonly message: string;
  readonly retry: boolean;
  /**
   * The founder is already in a call in another conversation (409 on start). They are asked whether to move
   * it here; yes starts again with `replace: true`, which ends the other call.
   */
  readonly elsewhere?: boolean;
}

export interface CallEnded {
  readonly reason: CallEndReason;
  readonly durationSeconds: number;
  readonly turnCount: number;
  readonly summary: CallSummary | null;
  /** Why the summary could not be loaded (the call is over either way). */
  readonly summaryError: string | null;
}

export interface CallSnapshot {
  readonly phase: CallPhase;
  readonly ventureId: string | null;
  readonly sessionId: string | null;
  readonly call: CallView | null;
  readonly activity: CallActivity;
  readonly input: 'voice' | 'typed';
  readonly typedReason: TypedReason | null;
  readonly muted: boolean;
  /** The call is on hold (the page was hidden): the microphone is off until the founder resumes. */
  readonly held: boolean;
  readonly talkMode: TalkMode;
  /** Push-to-talk is held. */
  readonly talking: boolean;
  /** The microphone is closed while the vEIR speaks (devices without usable echo cancellation). */
  readonly halfDuplex: boolean;
  readonly reconnecting: boolean;
  /** The browser has not let the call's audio start yet: one tap (Turn on sound) unlocks it. */
  readonly audioBlocked: boolean;
  /** When the call went live (epoch ms; the timer counts from here). */
  readonly liveAt: number | null;
  /** Server-reported seconds left, and when they were reported. */
  readonly remaining: { readonly seconds: number; readonly at: number } | null;
  readonly captions: {
    readonly veir: string | null;
    readonly founder: string | null;
    /** The founder line is a live partial (still changing). */
    readonly founderLive: boolean;
  };
  /**
   * How the vEIR's latest sentence was heard: the server's voice, the browser's voice (local development
   * only), or on screen only (the voice failed for it, or speech is refused for the rest of the call).
   */
  readonly voice: VoiceRoute;
  readonly notice: CallNotice | null;
  /** The latest turn was held back (crisis support or a safety check): what the founder is offered. */
  readonly blocked: TurnBlockedDetail | null;
  /** Typed or spoken lines waiting for the vEIR to finish. */
  readonly queued: number;
  readonly ended: CallEnded | null;
  /** Why the call could not start. */
  readonly error: CallFailure | null;
}

/** No call: the engine's state before a call and after it is dismissed. */
export const IDLE_CALL: CallSnapshot = {
  phase: 'idle',
  ventureId: null,
  sessionId: null,
  call: null,
  activity: 'connecting',
  input: 'voice',
  typedReason: null,
  muted: false,
  held: false,
  talkMode: 'hands_free',
  talking: false,
  halfDuplex: false,
  reconnecting: false,
  audioBlocked: false,
  liveAt: null,
  remaining: null,
  captions: { veir: null, founder: null, founderLive: false },
  voice: 'server',
  notice: null,
  blocked: null,
  queued: 0,
  ended: null,
  error: null,
};
