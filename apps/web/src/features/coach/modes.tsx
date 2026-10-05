import type { CoachMode } from '@foundry/contracts';

import { MODE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

/** Display order of the six coaching modes. */
export const COACH_MODES: readonly CoachMode[] = [
  'diagnose',
  'challenge',
  'coach',
  'teach',
  'rehearse',
  'route',
];

/** Longer guidance for the mode pickers (labels, icons and short descriptions live in lib/labels). */
export const MODE_DETAILS: Record<CoachMode, { whenToUse: string; example: string }> = {
  diagnose: {
    whenToUse: 'You’re not sure what to work on next.',
    example: 'What’s the riskiest assumption in our pilot plan?',
  },
  challenge: {
    whenToUse: 'You have a plan or claim and want it stress-tested.',
    example: 'Poke holes in our pricing for libraries.',
  },
  coach: {
    whenToUse: 'You’re facing a decision and want to think it through.',
    example: 'Should we run a paid pilot before fundraising?',
  },
  teach: {
    whenToUse: 'You want to learn a method, applied to your venture.',
    example: 'Teach me how to size a beachhead market.',
  },
  rehearse: {
    whenToUse: 'A pitch, interview or hard conversation is coming up.',
    example: 'Let me practise my two-minute pitch.',
  },
  route: {
    whenToUse: 'You need a program resource or a human expert.',
    example: 'Who can help with university IP licensing?',
  },
};

/** Mode as icon + label (neutral chip — a mode is not a status). */
export function ModeBadge({ mode, className }: { mode: CoachMode; className?: string }) {
  const def = MODE_LABELS[mode];
  const Icon = def.icon;
  return (
    <span
      data-slot="mode-badge"
      className={cn(
        'inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-md border border-border px-1.5 text-xs font-medium whitespace-nowrap text-foreground',
        className,
      )}
    >
      <Icon aria-hidden className="size-3 text-muted-foreground" />
      {def.label}
    </span>
  );
}
