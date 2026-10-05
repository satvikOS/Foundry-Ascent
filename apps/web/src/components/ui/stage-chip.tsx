import type { VentureStage } from '@foundry/contracts';

import { STAGE_LABELS, STAGE_ORDER } from '@/lib/labels';
import { cn } from '@/lib/utils';

const BAR_HEIGHTS = ['h-1', 'h-[5px]', 'h-1.5', 'h-[7px]', 'h-2', 'h-[9px]', 'h-2.5'];

/**
 * Venture stage chip with a 7-step progress meter. The stage name is always visible; the meter is
 * decorative reinforcement (its position is also stated for screen readers).
 */
export function StageChip({
  stage,
  className,
  showMeter = true,
}: {
  stage: VentureStage;
  className?: string;
  showMeter?: boolean;
}) {
  const index = STAGE_ORDER.indexOf(stage);
  return (
    <span
      data-slot="stage-chip"
      className={cn(
        'inline-flex h-5 w-fit shrink-0 items-center gap-1.5 rounded-md border border-border-strong px-1.5 text-xs font-medium whitespace-nowrap text-foreground',
        className,
      )}
    >
      {showMeter ? (
        <span aria-hidden className="flex items-end gap-px">
          {STAGE_ORDER.map((s, i) => (
            <span
              key={s}
              className={cn(
                'w-[3px] rounded-[1px]',
                BAR_HEIGHTS[i],
                i <= index ? 'bg-foreground' : 'bg-border-strong',
              )}
            />
          ))}
        </span>
      ) : null}
      <span>{STAGE_LABELS[stage]}</span>
      <span className="sr-only">
        (stage {index + 1} of {STAGE_ORDER.length})
      </span>
    </span>
  );
}
