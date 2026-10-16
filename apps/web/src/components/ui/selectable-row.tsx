import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

interface SelectableRowProps extends Omit<ComponentProps<'button'>, 'type'> {
  /** The item open beside the list. Exposed as `aria-current` and drawn with the selection cue. */
  selected: boolean;
}

/**
 * A row of a master list whose item opens beside it (the escalation inbox, calibration reviews, help
 * requests). The selected row is filled and carries a short bar in `--selected-cue` at its start, so
 * selection never rests on a fill alone (≥ 3:1 against the row and the canvas in both themes, see
 * tokens.test.ts). Hover only tints, more faintly than the selected fill and never with the bar, so a
 * hovered row cannot be mistaken for the open one. The focus ring is drawn inside the row, where no
 * scrolling list can clip it.
 */
export function SelectableRow({ selected, className, ...props }: SelectableRowProps) {
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      data-slot="selectable-row"
      data-selected={selected ? '' : undefined}
      className={cn(
        'relative w-full cursor-pointer text-left transition-colors',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
        'before:pointer-events-none before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full',
        selected ? 'bg-accent before:bg-selected-cue' : 'before:bg-transparent hover:bg-accent/50',
        className,
      )}
      {...props}
    />
  );
}
