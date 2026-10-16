import type { CallEndReason, CallSummary, CallView } from '@foundry/contracts';

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

export interface CallNotice {
  readonly kind: 'turn_error' | 'blocked' | 'voice_captions' | 'stt_lost' | 'time_warning';
  readonly message: string;
  /** Crisis or support resources (Markdown) for a blocked turn. */
  readonly supportMessage?: string | null;
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
  readonly talkMode: TalkMode;
  /** Push-to-talk is held. */
  readonly talking: boolean;
  readonly reconnecting: boolean;
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
  /** How the vEIR is heard: server voice, the browser's voice (local development), or captions only. */
  readonly voice: VoiceRoute;
  readonly notice: CallNotice | null;
  /** Typed or spoken lines waiting for the vEIR to finish. */
  readonly queued: number;
  readonly ended: CallEnded | null;
  /** Why the call could not start. */
  readonly error: string | null;
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
  talkMode: 'hands_free',
  talking: false,
  reconnecting: false,
  liveAt: null,
  remaining: null,
  captions: { veir: null, founder: null, founderLive: false },
  voice: 'server',
  notice: null,
  queued: 0,
  ended: null,
  error: null,
};
