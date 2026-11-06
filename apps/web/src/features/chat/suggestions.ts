import type { CoachMode } from '@foundry/contracts';

/**
 * A starting point the context panel offers (it fills the composer; nothing is sent until the founder sends it).
 * Memory is never one: what the mentor learns is kept automatically, with nothing to review.
 */
export interface PromptSuggestion {
  id: string;
  label: string;
  prompt: string;
  icon: SuggestionIcon;
  mode?: CoachMode;
}

export type SuggestionIcon = 'goal' | 'idea' | 'challenge' | 'rehearse';

/** What talking about an overdue action starts with. */
export function overduePrompt(title: string): string {
  return `“${title}” is overdue. Help me get it back on track.`;
}

/** What talking about an upcoming milestone starts with. */
export function milestonePrompt(title: string): string {
  return `“${title}” is coming up. What should we do to be ready?`;
}

/** What talking about an untested assumption starts with (in the challenge mode). */
export function assumptionPrompt(title: string): string {
  return `How could we test this assumption cheaply: “${title}”?`;
}

const OPENERS: readonly PromptSuggestion[] = [
  {
    id: 'opener-diagnose',
    icon: 'idea',
    label: 'Find our riskiest assumption',
    prompt: 'What’s the riskiest assumption in our plan right now?',
    mode: 'diagnose',
  },
  {
    id: 'opener-challenge',
    icon: 'challenge',
    label: 'Poke holes in our plan',
    prompt: 'Poke holes in our current plan.',
    mode: 'challenge',
  },
  {
    id: 'opener-rehearse',
    icon: 'rehearse',
    label: 'Practise a pitch',
    prompt: 'Let me practise my two-minute pitch.',
    mode: 'rehearse',
  },
];

/**
 * The panel's quick actions, three at most: planning toward the venture's current goal when it has one, then
 * general openers. What is due or being tested is offered on its own row above them, never twice.
 */
export function quickActions(currentGoal: string | null | undefined): PromptSuggestion[] {
  const goal = currentGoal?.trim();
  const items: PromptSuggestion[] = goal
    ? [
        {
          id: 'goal',
          icon: 'goal',
          label: 'Plan our next step',
          prompt: `Our current goal is: ${goal}. What should we do next to get there?`,
        },
      ]
    : [];
  return [...items, ...OPENERS].slice(0, 3);
}
