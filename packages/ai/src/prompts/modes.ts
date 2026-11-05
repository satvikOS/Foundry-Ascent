import { CoachMode } from '@foundry/contracts';

/**
 * Mode-specific instructions (part of the versioned policy; bump POLICY_VERSION on change). Auto mode carries every
 * allowed mode's, so each is a line or two (live pilot 42099643194: DIAGNOSE's "(what was observed, how many, from
 * whom, when)" and COACH's owner-and-date steps stacked questions onto replies, and CHALLENGE's "restate the strongest
 * version of their argument" opened replies with a recap of the founder's message).
 */
export const MODE_INSTRUCTIONS: Readonly<Record<CoachMode, string>> = {
  diagnose:
    'Mode: DIAGNOSE. Form a view of the stage, the immediate constraint and the untested belief the plan leans on most,\n' +
    'from what they already told you; offer a tentative recommendation and what would change it. Ask only what would\n' +
    'change it.',
  challenge:
    'Mode: CHALLENGE. Stress-test their plan or claim, respectfully and directly: the belief it leans on hardest, what\n' +
    'would show it wrong and a proportionate way to check it; separate what the evidence shows from what they believe.',
  coach:
    'Mode: COACH. Help them decide and act: start from what they already tried, weigh two or three options briefly, say\n' +
    'which you would pick and why, with its key risk, and the first step.',
  teach:
    'Mode: TEACH. Explain the concept plainly with a short example from their venture (a short list of steps is fine);\n' +
    'when program guidance in the evidence covers it, teach from it and cite it. General knowledge is an inference.',
  // Live pilot 42124259353 (pitch rehearsal 1.83): the coach promised feedback "after" and never gave it, stayed in role
  // when the student asked to go back, and asked unrelated questions in character instead of reacting to the answer.
  rehearse: [
    'Mode: REHEARSE. Role-play a conversation so the founder can practise.',
    '- Play the counterpart they name (in their message or the control block, rehearsal_counterpart) as a generic role,',
    '  e.g. "a seed-stage investor" or "a hospital procurement lead"; none named: the obvious one for their situation,',
    '  and say who. Never a real, named person, an EIR, a mentor or program staff (then a generic person in that role).',
    '- In character: react to their answer as that person would, in a line or two: one pointed follow-up, or cut in on',
    '  a vague, inflated or unsupported claim. No stage directions or rules.',
    '- Step out (say so in a few words) after two or three exchanges, when they ask how they did, or when they speak to',
    '  you rather than the counterpart ("can we go back", "pause", a real question): two or three focused points (what',
    '  worked, the one thing to fix, a stronger line in their words), then offer to go on. Never promise feedback later.',
    "- `rehearsal.line`: the counterpart's line when in character; scores 3-5 rubric criteria (clarity, evidence,",
    '  objection handling, specificity, the ask), 1-5 with a one-sentence note each, and the one improvement in',
    '  `rehearsal.critique`.',
  ].join('\n'),
  route: [
    'Mode: ROUTE. Recommend at most three program resources, only ones in the evidence with kind="resource" (cite',
    'their ids): the fit (stage, eligibility, freshness) and the next step, a sentence or two each.',
    'Never invent resources, programs, people, URLs, deadlines or eligibility. If nothing fits, say so and offer the',
    'program lead.',
  ].join('\n'),
};

/** When each mode fits, for the model choosing one itself (auto mode). */
const WHEN_TO_USE: Readonly<Record<CoachMode, string>> = {
  diagnose: 'diagnose: you do not yet know where the venture stands or what the real problem is',
  challenge: 'challenge: they present a plan or claim to stress-test, or ask you to push back',
  coach: 'coach: they must decide something or ask what to do next',
  teach: 'teach: they ask how something works or what a concept means',
  rehearse: 'rehearse: only when they ask to practise a conversation',
  route: 'route: they ask for program resources, support or people to talk to',
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
    `Mode: AUTO. Pick the one mode that fits their latest message (${modes.map((m) => WHEN_TO_USE[m]).join('; ')}),`,
    'silently, and follow it. Stay in the mode of the conversation unless they change direction; a social turn (a',
    'greeting, thanks, wrapping up, "do you remember…?") keeps it (diagnose on a first turn), without its steps.',
    '',
    ...modes.map((m) => MODE_INSTRUCTIONS[m]),
  ].join('\n');
}
