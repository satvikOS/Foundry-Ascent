import { callsRepo, isUuid, settingsRepo } from '@foundry/db';

import { DomainError, fail } from '../errors.js';
import { requireId, type RequestScope } from '../internal/kit.js';
import { secondsUntilUtcMidnight } from '../orchestrator/sampling.js';
import {
  CALL_LIMITS,
  callSecondsToday,
  callTimeLeft,
  type CallCaps,
  type CallTimeLeft,
} from './call-usage.js';

/**
 * Admission for a spoken turn (`channel: 'voice'`), called by the turn path inside the request transaction
 * that inserts the turn, under its per-person admission lock, before the model is called
 * (docs/architecture/calls.md §2).
 *
 * The turn must name a live call of this conversation started by the caller whose client is still there;
 * calls must be enabled; the per-call and daily minute caps, the voice-turn rate limit and the turn cap per
 * call must hold. It throws a DomainError (`not_found`, `conflict`, `rate_limited` or `ai_disabled`) to refuse.
 */
export interface VoiceTurnAdmission {
  readonly sessionId: string;
  readonly callId: string | undefined;
  readonly now: Date;
}

export type AdmitVoiceTurn = (scope: RequestScope, admission: VoiceTurnAdmission) => Promise<void>;

export interface VoiceTurnFacts {
  readonly call: Pick<callsRepo.CallRecord, 'status' | 'idleSeconds'>;
  readonly callsEnabled: boolean;
  readonly timeLeft: CallTimeLeft;
  /** Spoken turns the person sent in the rate window. */
  readonly recentVoiceTurns: number;
  /** Turns the call holds so far. */
  readonly callTurns: number;
}

export interface VoiceTurnRefusal {
  readonly code: 'conflict' | 'rate_limited' | 'ai_disabled';
  readonly reason: string;
  readonly message: string;
  /** `midnight`: retry when the daily minutes reset; a number: seconds. */
  readonly retryAfter?: number | 'midnight';
}

const CALL_OVER = 'This call has ended. Start a new call to keep talking.';

/** The refusal when a live call has no time left (its own limit, or today's minutes); null otherwise. */
export function timeLimitRefusal(timeLeft: CallTimeLeft): VoiceTurnRefusal | null {
  if (timeLeft.seconds > 0) return null;
  return timeLeft.limit === 'daily'
    ? {
        code: 'rate_limited',
        reason: 'daily_call_minutes',
        message: 'You have used today’s call minutes. Calls reset at midnight UTC.',
        retryAfter: 'midnight',
      }
    : { code: 'conflict', reason: 'call_minutes', message: 'This call reached its time limit.' };
}

/** The rules of voice-turn admission over facts read from the database (pure; unit tested). */
export function voiceTurnRefusal(facts: VoiceTurnFacts): VoiceTurnRefusal | null {
  if (facts.call.status !== 'live' || facts.call.idleSeconds > CALL_LIMITS.staleSeconds) {
    return { code: 'conflict', reason: 'call_not_active', message: CALL_OVER };
  }
  if (!facts.callsEnabled) {
    return {
      code: 'ai_disabled',
      reason: 'calls_disabled',
      message: 'Calls are paused by the program. You can keep chatting.',
    };
  }
  const timeUp = timeLimitRefusal(facts.timeLeft);
  if (timeUp !== null) return timeUp;
  if (facts.recentVoiceTurns >= CALL_LIMITS.voiceTurnRateLimit) {
    return {
      code: 'rate_limited',
      reason: 'voice_turn_rate_limit',
      message: 'You are talking very quickly. Please pause for a minute.',
      retryAfter: 60,
    };
  }
  if (facts.callTurns >= CALL_LIMITS.maxTurnsPerCall) {
    return {
      code: 'conflict',
      reason: 'call_turn_limit',
      message: 'This call reached its turn limit. Start a new call to keep talking.',
    };
  }
  return null;
}

/** The DomainError for a refusal (`now` dates a wait until the daily reset). */
export function refusalError(refusal: VoiceTurnRefusal, now: Date): DomainError {
  const retryAfterSeconds =
    refusal.retryAfter === 'midnight' ? secondsUntilUtcMidnight(now) : refusal.retryAfter;
  return new DomainError(
    refusal.code,
    refusal.message,
    retryAfterSeconds === undefined
      ? { reason: refusal.reason }
      : { reason: refusal.reason, retryAfterSeconds },
  );
}

export const admitVoiceTurn: AdmitVoiceTurn = async (scope, admission) => {
  const { tx, ctx } = scope;
  const deny = (error: DomainError, objectId: string | null): DomainError => {
    scope.deferAudit({
      action: 'turn.rejected',
      outcome: error.code === 'not_found' ? 'denied' : 'blocked',
      objectType: 'call',
      objectId,
      policyReason: error.reason ?? error.code,
      metadata: { sessionId: admission.sessionId },
    });
    return error;
  };
  if (admission.callId === undefined) {
    throw deny(fail.conflict('Start a call before speaking.', 'call_required'), null);
  }
  const callId = requireId(admission.callId, 'Call');
  const call = await callsRepo.getCall(tx, callId);
  if (call?.sessionId !== admission.sessionId || call.startedBy !== ctx.principalId) {
    throw deny(fail.notFound('Call'), callId);
  }
  const settings = await settingsRepo.getPlatformSettings(tx);
  const caps: CallCaps = settings;
  const refusal = voiceTurnRefusal({
    call,
    callsEnabled: settings.callsEnabled,
    timeLeft: callTimeLeft({
      elapsedSeconds: call.elapsedSeconds,
      maxSeconds: call.maxSeconds,
      usedSecondsToday: await callSecondsToday(tx, ctx.principalId),
      caps,
    }),
    recentVoiceTurns: await callsRepo.countRecentVoiceTurns(tx, {
      authorId: ctx.principalId,
      windowSeconds: CALL_LIMITS.voiceTurnRateWindowSeconds,
    }),
    callTurns: await callsRepo.countCallTurns(tx, call.id),
  });
  if (refusal !== null) throw deny(refusalError(refusal, admission.now), callId);
};

/**
 * Whether `callId` names the caller's live call in this conversation, its client still there. It never refuses:
 * the turn path asks it for a spoken crisis message, which is answered whatever the call's state (support is
 * never refused for call reasons) and recorded as spoken only when it was said on such a call.
 */
export async function isLiveCallOf(
  scope: RequestScope,
  args: { readonly sessionId: string; readonly callId: string | undefined },
): Promise<boolean> {
  if (args.callId === undefined || !isUuid(args.callId)) return false;
  const call = await callsRepo.getCall(scope.tx, args.callId.toLowerCase());
  return (
    call !== null &&
    call.sessionId === args.sessionId &&
    call.startedBy === scope.ctx.principalId &&
    call.status === 'live' &&
    call.idleSeconds <= CALL_LIMITS.staleSeconds
  );
}
