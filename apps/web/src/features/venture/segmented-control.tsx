import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Optional count shown after the label. */
  count?: number;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentOption<T>[];
  /** Accessible name for the group, e.g. "Filter sessions". */
  label: string;
  className?: string;
}

/**
 * Filter switch styled like the pill tabs. Unlike tabs it controls a filter (not separate panels), so
 * it is a group of toggle buttons with aria-pressed — no orphaned tab/panel relationships.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'inline-flex h-9 w-fit items-center gap-0.5 rounded-lg border border-border bg-muted p-0.5 text-muted-foreground',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => {
              onChange(option.value);
            }}
            className={cn(
              'inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors',
              'hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              active && 'bg-card text-foreground shadow-xs',
            )}
          >
            {option.label}
            {option.count !== undefined ? (
              <span className="tabular text-subtle-foreground">{option.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
