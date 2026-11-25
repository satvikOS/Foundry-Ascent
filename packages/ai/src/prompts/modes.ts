import { CoachMode } from '@foundry/contracts';

/**
 * Mode-specific instructions (part of the versioned policy; bump POLICY_VERSION on change). Auto mode carries every
 * allowed mode's, so each is a line or two: what the reply contract does not already say ("# How you talk").
 */
export const MODE_INSTRUCTIONS: Readonly<Record<CoachMode, string>> = {
  diagnose:
    'DIAGNOSE (unclear where they stand): your tentative read and recommendation, then what would change it.',
  challenge:
    'CHALLENGE (a plan or claim to test): the belief it leans on hardest, what would show it wrong, a proportionate test.',
  coach: 'COACH (a decision, or what to do next): your pick and why, its key risk, the first step.',
  teach:
    'TEACH (how something works, a goal or step ahead): plainly, from the program guidance in the evidence when it covers\n' +
    'it, with a short example from their venture.',
  // Live pilot 42124259353 (pitch rehearsal 1.83): the coach promised feedback "after" and never gave it, stayed in role
  // when the student asked to go back, and asked unrelated questions in character instead of reacting to the answer.
  // What each rehearsal turn needs (react, when to step out) is also said on it, in <conversation_state>.
  rehearse:
    'REHEARSE (asked to practise): play the counterpart they name (or rehearsal_counterpart) as a generic role, never a\n' +
    'real, named person, an EIR or staff; react in a line or two. After two or three exchanges, or when they speak to you,\n' +
    'step out, saying so: what worked, one thing to fix, a stronger line. Never promise feedback later.',
  route:
    'ROUTE (resources or people): at most three, only ones in the evidence with kind="resource", cited, with fit and next\n' +
    'step. Never invent resources, people, URLs, deadlines or eligibility; none fits: offer the program lead.',
};

/** Allowed modes in a stable order; all but rehearse when none are given. */
export function autoModes(allowed: readonly CoachMode[] | undefined): CoachMode[] {
  const set = new Set(allowed ?? CoachMode.options.filter((m) => m !== 'rehearse'));
  const modes = CoachMode.options.filter((m) => set.has(m));
  return modes.length > 0 ? modes : ['diagnose'];
}

/**
 * Auto mode: the model picks the one mode that fits the founder's message among `allowed`, sets `mode`
 * to it and follows that mode's instructions (all of which are listed).
 */
export function autoModeInstructions(allowed: readonly CoachMode[]): string {
  const modes = autoModes(allowed);
  return [
    'Mode: AUTO. Silently pick the mode that fits their latest message; a social turn keeps the last one, without its steps.',
    ...modes.map((m) => `- ${MODE_INSTRUCTIONS[m]}`),
  ].join('\n');
}
