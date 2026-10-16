import { type CallEndReason, type PlatformSettingsView } from '@foundry/contracts';
import { callsRepo, type SqlExecutor } from '@foundry/db';

/**
 * Call limits, minute accounting and the rules that end a call (docs/architecture/calls.md §2). Minutes come
 * from the `calls` table: ended calls count until they ended, live calls until now, but never more than
 * {@link CALL_LIMITS.staleGraceSeconds} after their last heartbeat (where a call whose client went away is
 * closed). The rules are pure and unit tested.
 */
export const CALL_LIMITS = {
  /** Clients send a heartbeat this often. */
  heartbeatSeconds: 15,
  /**
   * A live call without a heartbeat for this long is over: its client went away. The `turns_link_call`
   * trigger of migration 0008 uses the same 60 s window.
   */
  staleSeconds: 60,
  /**
   * A live call counts until at most this long after its last heartbeat (two heartbeats), and a call whose
   * client went away is closed there: its minutes are the same before and after it is closed.
   */
  staleGraceSeconds: 30,
  /** A call needs at least this much time left to start. */
  minStartSeconds: 60,
  /**
   * Lifetime of a speech-to-text grant. The presigned URL only has to open the stream, and it can open any
   * number of streams until it expires, so it lives just long enough for the browser to connect.
   */
  sttGrantSeconds: 30,
  /** Speech-to-text grants one call may mint (reconnects and unmutes re-mint). */
  sttGrantsPerCall: 20,
  /** Speech-to-text grants one person may mint per UTC day, across calls. */
  sttGrantsPerDay: 100,
  /** The fixed crisis support message of a crisis turn may be spoken this many times … */
  crisisSpeechReplays: 5,
  /** … within this long after the turn was sent. */
  crisisSpeechWindowSeconds: 600,
  /** Spoken turns one person may send per window (typed chat has its own limit). */
  voiceTurnRateLimit: 40,
  voiceTurnRateWindowSeconds: 600,
  /** Turns one call may hold. */
  maxTurnsPerCall: 90,
} as const;

export type CallCaps = Required<
  Pick<PlatformSettingsView, 'maxCallMinutes' | 'dailyCallMinutesPerPrincipal'>
>;

/** Seconds the person spent in calls today (UTC), by the database clock. */
export function callSecondsToday(ex: SqlExecutor, principalId: string): Promise<number> {
  return callsRepo.callSecondsToday(ex, { principalId, graceSeconds: CALL_LIMITS.staleGraceSeconds });
}

/** Amazon Transcribe streaming, US English, in USD per second of audio (us-east-1, first pricing tier). */
export const TRANSCRIBE_USD_PER_SECOND = 0.024 / 60;

/** Estimated cost of `seconds` of speech-to-text (the microphone seconds the client reports). */
export function transcriptionCostUsd(seconds: number): number {
  return Math.max(0, seconds) * TRANSCRIBE_USD_PER_SECOND;
}

/** Seconds left today under the daily cap (never negative). */
export function remainingDailySeconds(usedSecondsToday: number, dailyCapMinutes: number): number {
  return Math.max(0, Math.floor(dailyCapMinutes * 60 - usedSecondsToday));
}

/** Minutes left today, rounded down to a tenth (what the call screen shows). */
export function remainingDailyMinutes(usedSecondsToday: number, dailyCapMinutes: number): number {
  return Math.floor(remainingDailySeconds(usedSecondsToday, dailyCapMinutes) / 6) / 10;
}

/** The hard limit of a new call: the per-call cap or today's remaining minutes, whichever is smaller. */
export function newCallMaxSeconds(usedSecondsToday: number, caps: CallCaps): number {
  return Math.min(
    caps.maxCallMinutes * 60,
    remainingDailySeconds(usedSecondsToday, caps.dailyCallMinutesPerPrincipal),
  );
}

export interface CallTimeLeft {
  readonly seconds: number;
  /** Which limit binds: the call's own length, or the person's minutes today. */
  readonly limit: 'call' | 'daily';
}

/**
 * Time left in a live call: its own limit (its `maxSeconds`, or a per-call cap lowered since it started) and
 * the daily cap, which `usedSecondsToday` already charges with this call's time so far.
 */
export function callTimeLeft(args: {
  readonly elapsedSeconds: number;
  readonly maxSeconds: number;
  readonly usedSecondsToday: number;
  readonly caps: CallCaps;
}): CallTimeLeft {
  const call = Math.max(0, Math.min(args.maxSeconds, args.caps.maxCallMinutes * 60) - args.elapsedSeconds);
  const daily = remainingDailySeconds(args.usedSecondsToday, args.caps.dailyCallMinutesPerPrincipal);
  return call <= daily ? { seconds: call, limit: 'call' } : { seconds: daily, limit: 'daily' };
}

/** Why a live call has to stop, most fundamental first. */
export type CallStopCause =
  | 'kill_switch'
  | 'calls_disabled'
  | 'session_closed'
  | 'access_revoked'
  | 'persona_unavailable'
  | 'voice_consent'
  | 'stale_heartbeat'
  | 'spend_cap'
  | 'daily_call_minutes'
  | 'max_duration';

/** The end reason clients see for each cause. */
export const STOP_REASON: Readonly<Record<CallStopCause, CallEndReason>> = {
  kill_switch: 'disabled',
  calls_disabled: 'disabled',
  session_closed: 'user',
  access_revoked: 'disabled',
  persona_unavailable: 'disabled',
  voice_consent: 'disabled',
  stale_heartbeat: 'timeout',
  spend_cap: 'budget',
  daily_call_minutes: 'budget',
  max_duration: 'timeout',
};

export interface CallConditions {
  readonly aiEnabled: boolean;
  readonly callsEnabled: boolean;
  /** The conversation is still active (not ended or deleted). */
  readonly sessionActive: boolean;
  /** The caller may still write to the venture (a founder or team member of a venture not archived). */
  readonly canWrite: boolean;
  /** The venture's vEIR is still this call's persona, active, with an approved release. */
  readonly personaAvailable: boolean;
  /** The call's voice is still approved (stock voice, or the EIR's voice under consent in force). */
  readonly voiceApproved: boolean;
  /** Seconds since the previous heartbeat (or the start). */
  readonly idleSeconds: number;
  readonly spendCapReached: boolean;
  readonly timeLeft: CallTimeLeft;
}

/** Whether a live call must stop now, and why (pure; the heartbeat and every check share it). */
export function callStopCause(c: CallConditions): CallStopCause | null {
  if (!c.aiEnabled) return 'kill_switch';
  if (!c.callsEnabled) return 'calls_disabled';
  if (!c.sessionActive) return 'session_closed';
  if (!c.canWrite) return 'access_revoked';
  if (!c.personaAvailable) return 'persona_unavailable';
  if (!c.voiceApproved) return 'voice_consent';
  if (c.idleSeconds > CALL_LIMITS.staleSeconds) return 'stale_heartbeat';
  if (c.spendCapReached) return 'spend_cap';
  if (c.timeLeft.seconds <= 0) return c.timeLeft.limit === 'daily' ? 'daily_call_minutes' : 'max_duration';
  return null;
}
