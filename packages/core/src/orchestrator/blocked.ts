import { CRISIS_SUPPORT_MESSAGE } from '@foundry/ai';
import { type TurnBlockedDetail } from '@foundry/contracts';
import { turnsRepo } from '@foundry/db';

/**
 * The support message shown with a blocked turn: the crisis path's human-support message (crisis lines,
 * university support), none for the other reasons (the client explains those itself).
 */
export function supportMessageFor(reason: string): string | null {
  return reason === 'crisis_support' ? CRISIS_SUPPORT_MESSAGE : null;
}

/**
 * `TurnView.blocked` / `turn.blocked` fields of a stored turn, so a replayed or reloaded turn shows exactly
 * what the live stream showed. Null for turns that are not blocked. Carries no founder text and no blocked
 * model output.
 */
export function blockedDetailOf(
  turn: Pick<turnsRepo.TurnRecord, 'status' | 'riskLabel' | 'validatorResults'>,
  escalationId: string | null,
): TurnBlockedDetail | null {
  const reason = turnsRepo.blockedReason(turn);
  if (reason === null) return null;
  return { reason, supportMessage: supportMessageFor(reason), escalationId };
}
