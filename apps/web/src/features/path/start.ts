import type { VenturePath } from '@foundry/contracts';

import type { PromptSuggestion } from '@/features/chat/suggestions';

/**
 * Ways to start that come from the path: pick up the current step, say it is finished or stuck, or ask for the plan.
 * Each fills the composer; nothing is sent until the founder sends it.
 */
export function pathSuggestions(path: Pick<VenturePath, 'now'>): PromptSuggestion[] {
  const title = path.now?.title.trim().replace(/[.!]+$/, '');
  const step: PromptSuggestion[] = title
    ? [
        {
          id: 'path-continue',
          icon: 'continue',
          label: `Continue: ${title}`,
          prompt: `Let’s continue with “${title}”.`,
        },
        {
          id: 'path-finished',
          icon: 'finished',
          label: 'I finished it',
          prompt: `I finished “${title}”. What happened: `,
        },
        { id: 'path-stuck', icon: 'stuck', label: 'I’m stuck', prompt: `I’m stuck on “${title}”: ` },
      ]
    : [];
  return [
    ...step,
    {
      id: 'path-next',
      icon: 'next',
      label: 'What should I do next?',
      prompt: 'What should I do next?',
    },
    {
      id: 'path-organise',
      icon: 'organise',
      label: 'Help me get organised',
      prompt: 'Help me get organised.',
    },
  ];
}

/** The few shown under New chat's composer: the step's own, or with no step the two ways to a plan. */
export function startChips(path: Pick<VenturePath, 'now'>): PromptSuggestion[] {
  const all = pathSuggestions(path);
  return path.now ? all.slice(0, 3) : all;
}
