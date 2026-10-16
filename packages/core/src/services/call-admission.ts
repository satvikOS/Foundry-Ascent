import { fail } from '../errors.js';
import { type RequestScope } from '../internal/kit.js';

/**
 * Admission for a spoken turn (`channel: 'voice'`), called by the turn path inside the request transaction
 * before the model is called (docs/architecture/calls.md §2).
 *
 * The calls service owns the rules: the turn must name a live call of this conversation started by the
 * caller, calls must be enabled, the per-call and daily minute caps and the voice-turn rate limit must
 * hold. It throws a DomainError (`not_found`, `conflict`, `rate_limited` or `ai_disabled`) to refuse.
 */
export interface VoiceTurnAdmission {
  readonly sessionId: string;
  readonly callId: string | undefined;
  readonly now: Date;
}

export type AdmitVoiceTurn = (scope: RequestScope, admission: VoiceTurnAdmission) => Promise<void>;

/**
 * Placeholder until the calls service lands: refuses every spoken turn, so no voice turn can bypass the
 * call caps.
 */
export const admitVoiceTurn: AdmitVoiceTurn = () =>
  Promise.reject(fail.conflict('Voice calls are not available yet', 'calls_unavailable'));
