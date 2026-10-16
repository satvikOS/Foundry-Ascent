import { type CallEndReason, type PlatformSettingsView } from '@foundry/contracts';
import { callsRepo, type SqlExecutor } from '@foundry/db';

/**
 * Call limits, minute accounting and the rules that end a call (docs/architecture/calls.md §2). Minutes come
 * from the `calls` table: ended calls count until they ended, live calls until now (or until a minute after
 * their last heartbeat when the client went away). The rules are pure and unit tested.
 */
export const CALL_LIMITS = {
  /** Clients send a heartbeat this often. */
  heartbeatSeconds: 15,
  /**
   * A live call without a heartbeat for this long is over: its client went away. The `turns_link_call`
   * trigger of migration 0008 uses the same 60 s window.
   */
  staleSeconds: 60,
  /** A call ended because its client went away counts until this long after its last heartbeat. */
  staleGraceSeconds: 15,
  /** A call needs at least this much time left to start. */
  minStartSeconds: 60,
  /** Lifetime of a speech-to-text grant (Amazon Transcribe allows at most 300 s). */
  sttGrantSeconds: 300,
  /** Speech-to-text grants one call may mint (reconnects and unmutes re-mint). */
  sttGrantsPerCall: 20,
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
  return callsRepo.callSecondsToday(ex, { principalId, staleSeconds: CALL_LIMITS.staleSeconds });
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
  if (!c.personaAvailable) return 'persona_unavailable';
  if (!c.voiceApproved) return 'voice_consent';
  if (c.idleSeconds > CALL_LIMITS.staleSeconds) return 'stale_heartbeat';
  if (c.spendCapReached) return 'spend_cap';
  if (c.timeLeft.seconds <= 0) return c.timeLeft.limit === 'daily' ? 'daily_call_minutes' : 'max_duration';
  return null;
}
