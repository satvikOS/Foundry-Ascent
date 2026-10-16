import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface FilterChip<K extends string> {
  key: K;
  label: ReactNode;
  /** Shown after the label once known. */
  count?: number | undefined;
}

/**
 * A filter over one list, as a row of toggle buttons (`aria-pressed`). It is not a tab set: there are no
 * panels to point at, so tab roles would leave assistive technology with dangling references.
 */
export function FilterChips<K extends string>({
  label,
  chips,
  selected,
  onSelect,
  className,
}: {
  /** Accessible name of the group, e.g. "Filter lessons". */
  label: string;
  chips: readonly FilterChip<K>[];
  selected: K;
  onSelect: (key: K) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn('flex flex-wrap gap-1.5', className)}>
      {chips.map((chip) => {
        const pressed = chip.key === selected;
        return (
          <button
            key={chip.key}
            type="button"
            aria-pressed={pressed}
            onClick={() => {
              onSelect(chip.key);
            }}
            className={cn(
              'inline-flex h-8 items-center rounded-full border px-3 text-small transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              pressed
                ? 'border-foreground bg-foreground text-background'
                : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground',
            )}
          >
            {/* One inline run, so the space before the count is part of the name ("Open 2"). */}
            <span>
              {chip.label}
              {chip.count !== undefined ? (
                <>
                  {' '}
                  <span className="tabular ml-0.5 text-caption opacity-70">{chip.count}</span>
                </>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
