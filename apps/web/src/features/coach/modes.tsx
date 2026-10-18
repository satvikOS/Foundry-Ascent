import type { CoachMode } from '@foundry/contracts';

/** Display order of the six coaching modes. */
export const COACH_MODES: readonly CoachMode[] = [
  'diagnose',
  'challenge',
  'coach',
  'teach',
  'rehearse',
  'route',
];

/** A first message for each mode, offered on New chat (labels, icons and descriptions live in lib/labels). */
export const MODE_DETAILS: Record<CoachMode, { example: string }> = {
  diagnose: {
    example: 'What’s the riskiest assumption in our pilot plan?',
  },
  challenge: {
    example: 'Poke holes in our pricing for libraries.',
  },
  coach: {
    example: 'Should we run a paid pilot before fundraising?',
  },
  teach: {
    example: 'Teach me how to size a beachhead market.',
  },
  rehearse: {
    example: 'Let me practise my two-minute pitch.',
  },
  route: {
    example: 'Who can help with university IP licensing?',
  },
};
