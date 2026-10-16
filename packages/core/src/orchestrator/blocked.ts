import { CRISIS_SUPPORT_MESSAGE } from '@foundry/ai';
import { type TurnBlockedDetail, type TurnView, type ValidatorResults } from '@foundry/contracts';
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

// ------------------------------------------------------------------------------------------------
// What founders and teams may see (staff views and the audit log keep the details)
// ------------------------------------------------------------------------------------------------
//
// Which names the cross-venture guard knows is program data: a founder who could see that a message
// naming X was classified `cross_venture`, or that an answer mentioning X was blocked for `cross_venture`,
// would learn that X is another venture (or a member of one). Participants therefore see a generic
// `policy` block reason, no risk categories and no category-specific validator notes.

/** Block reason shown to founders/team: `cross_venture` becomes the generic `policy`. */
export function participantBlockReason(reason: string): string {
  return reason === 'cross_venture' ? 'policy' : reason;
}

/**
 * Pre-classification label for the `classifying` status event: `sensitive` for crisis and high-risk
 * topics (the founder is about to be offered human help anyway), otherwise nothing. Injection and
 * cross-venture labels are never sent.
 */
export function participantRiskLabel(label: string): 'sensitive' | null {
  return label === 'crisis' || label === 'high' ? 'sensitive' : null;
}

/** Validator results without risk categories, the cross-venture flag or category-specific notes. */
export function participantValidator(validator: ValidatorResults | null): ValidatorResults | null {
  if (validator === null) return null;
  return {
    ...validator,
    riskCategories: [],
    crossVentureViolation: false,
    notes: validator.notes
      .filter((note) => !note.startsWith('cross_venture'))
      .map((note) => (note.startsWith('escalation_forced:') ? 'escalation_forced' : note)),
  };
}

/** A turn as founders and team members may see it (see {@link participantValidator}). */
export function participantTurnView(view: TurnView): TurnView {
  return {
    ...view,
    validator: participantValidator(view.validator),
    blocked:
      view.blocked === null ? null : { ...view.blocked, reason: participantBlockReason(view.blocked.reason) },
  };
}
