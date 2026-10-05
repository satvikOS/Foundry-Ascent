import type { CoachMode, CoachResponse } from '@foundry/contracts';

import { RISK_ESCALATION_MAP } from './escalation-map.js';

/**
 * Human-support message shown when the pre-classifier detects a possible crisis. The orchestrator
 * returns it without calling a model (system design §7 step 2) and drafts a P1 escalation.
 * Versioned with the prompts: change it together with POLICY_VERSION.
 */
export const CRISIS_SUPPORT_MESSAGE = [
  'It sounds like you might be going through something really hard right now, and you deserve support from a person, not an AI coach.',
  '',
  '- If you or anyone else is in immediate danger, call your local emergency number now (911 in the US).',
  '- In the US you can call or text **988** (Suicide & Crisis Lifeline) at any time, day or night.',
  '- Your university counseling or student support service can also help, including outside office hours.',
  '',
  'I have prepared a request so someone from the program can check in with you; you choose whether to share it. Your venture work can wait, and I will be here when you are ready.',
].join('\n');

/** A schema-valid `CoachResponse` carrying the crisis message and a P1 safety escalation. */
export function buildCrisisResponse(mode: CoachMode): CoachResponse {
  const route = RISK_ESCALATION_MAP.safety_wellbeing;
  return {
    mode,
    answer: CRISIS_SUPPORT_MESSAGE,
    claims: [],
    uncertainty: [],
    challenge: null,
    next_actions: [
      {
        owner: 'founder',
        action:
          'Reach out to a crisis line, emergency services or university support now if you feel unsafe.',
        target_date: null,
      },
    ],
    escalation: {
      required: true,
      category: route.category,
      priority: route.priority,
      reason: 'Possible personal safety or wellbeing crisis; a person should check in with the founder.',
      requested_role: route.requestedRole,
    },
    memory_candidates: [],
    follow_up_questions: [],
    rehearsal: null,
  };
}
