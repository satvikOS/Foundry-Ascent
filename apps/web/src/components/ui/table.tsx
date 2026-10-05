import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

export function Table({
  className,
  containerClassName,
  ...props
}: ComponentProps<'table'> & { containerClassName?: string }) {
  return (
    <div
      data-slot="table-container"
      className={cn(
        'relative w-full overflow-x-auto rounded-xl border border-border bg-card',
        containerClassName,
      )}
    >
      <table
        data-slot="table"
        className={cn('w-full caption-bottom border-collapse text-sm', className)}
        {...props}
      />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return (
    <thead data-slot="table-header" className={cn('bg-muted/50 [&_tr]:border-b', className)} {...props} />
  );
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

export function TableFooter({ className, ...props }: ComponentProps<'tfoot'>) {
  return (
    <tfoot className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)} {...props} />
  );
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b border-border transition-colors hover:bg-accent/40 data-[state=selected]:bg-accent',
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-10 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground first:pl-4 last:pr-4',
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn('px-3 py-2.5 align-middle first:pl-4 last:pr-4', className)}
      {...props}
    />
  );
}

export function TableCaption({ className, ...props }: ComponentProps<'caption'>) {
  return <caption className={cn('mt-3 text-[13px] text-muted-foreground', className)} {...props} />;
}

export type SortDirection = 'asc' | 'desc';
export interface SortState<K extends string> {
  key: K;
  direction: SortDirection;
}

interface SortableTableHeadProps<K extends string> extends Omit<ComponentProps<'th'>, 'onChange'> {
  sortKey: K;
  sort: SortState<K> | null;
  onSortChange: (next: SortState<K>) => void;
  children: ReactNode;
  align?: 'left' | 'right';
}

/**
 * Column header with an accessible sort toggle: a real <button> inside the <th>, aria-sort on the
 * header, and an arrow icon whose direction (not colour) shows the state.
 */
export function SortableTableHead<K extends string>({
  sortKey,
  sort,
  onSortChange,
  children,
  align = 'left',
  className,
  ...props
}: SortableTableHeadProps<K>) {
  const active = sort?.key === sortKey;
  const direction = active ? sort.direction : null;
  const Icon = direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ChevronsUpDown;
  return (
    <TableHead
      aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
      className={cn(align === 'right' && 'text-right', className)}
      {...props}
    >
      <button
        type="button"
        onClick={() => {
          onSortChange({ key: sortKey, direction: active && direction === 'asc' ? 'desc' : 'asc' });
        }}
        className={cn(
          '-mx-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-accent hover:text-foreground',
          'focus-visible:outline-2 focus-visible:outline-ring',
          active && 'text-foreground',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        {children}
        <Icon aria-hidden className={cn('size-3.5', !active && 'opacity-50')} />
      </button>
    </TableHead>
  );
}

/** Stable sort helper for SortableTableHead. */
export function sortRows<T, K extends string>(
  rows: readonly T[],
  sort: SortState<K> | null,
  accessor: (row: T, key: K) => string | number | null | undefined,
): T[] {
  if (!sort) return [...rows];
  const factor = sort.direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const av = accessor(a.row, sort.key);
      const bv = accessor(b.row, sort.key);
      if (av === bv) return a.index - b.index;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return cmp === 0 ? a.index - b.index : cmp * factor;
    })
    .map(({ row }) => row);
}
