import type { CoachMode, VentureOverview } from '@foundry/contracts';

import { titleFromMessage } from '@/lib/conversations';

import { MODE_DETAILS } from '../coach/modes';

/**
 * A chip under the New chat composer: a message to start with, or open help requests. Memory is never one:
 * what the vEIR learns is kept automatically, with nothing to review.
 */
export type Suggestion =
  | { id: string; kind: 'prompt'; label: string; prompt: string; icon: SuggestionIcon; mode?: CoachMode }
  | { id: string; kind: 'help'; label: string; count: number; icon: SuggestionIcon };

export type SuggestionIcon = 'overdue' | 'goal' | 'assumption' | 'help' | 'idea';

const MAX_SUGGESTIONS = 4;
const LABEL_MAX = 44;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Up to four starting points from the venture's state: an overdue action, the current goal, an untested
 * assumption and open help requests — topped up with general openers.
 */
export function newChatSuggestions(
  overview: Pick<
    VentureOverview,
    'overdueActions' | 'currentGoal' | 'openAssumptions' | 'openEscalations'
  > | null,
): Suggestion[] {
  const items: Suggestion[] = [];
  if (overview) {
    const overdue = overview.overdueActions[0];
    if (overdue) {
      items.push({
        id: `overdue-${overdue.id}`,
        kind: 'prompt',
        icon: 'overdue',
        label: `Overdue: ${titleFromMessage(overdue.title, LABEL_MAX - 9)}`,
        prompt: `“${overdue.title}” is overdue. Help me get it back on track.`,
      });
    }
    const goal = overview.currentGoal?.trim();
    if (goal) {
      items.push({
        id: 'goal',
        kind: 'prompt',
        icon: 'goal',
        label: 'Plan our next step',
        prompt: `Our current goal is: ${goal}. What should we do next to get there?`,
      });
    }
    const assumption = overview.openAssumptions[0];
    if (assumption) {
      items.push({
        id: `assumption-${assumption.id}`,
        kind: 'prompt',
        icon: 'assumption',
        label: `Test: ${titleFromMessage(assumption.title, LABEL_MAX - 6)}`,
        prompt: `How could we test this assumption cheaply: “${assumption.title}”?`,
        mode: 'challenge',
      });
    }
    if (overview.openEscalations > 0) {
      items.push({
        id: 'help',
        kind: 'help',
        icon: 'help',
        count: overview.openEscalations,
        label: plural(overview.openEscalations, 'open help request', 'open help requests'),
      });
    }
  }
  const openers: CoachMode[] = ['diagnose', 'challenge', 'rehearse'];
  for (const mode of openers) {
    if (items.length >= 3) break;
    items.push({
      id: `opener-${mode}`,
      kind: 'prompt',
      icon: 'idea',
      label: MODE_DETAILS[mode].example,
      prompt: MODE_DETAILS[mode].example,
      mode,
    });
  }
  return items.slice(0, MAX_SUGGESTIONS);
}
