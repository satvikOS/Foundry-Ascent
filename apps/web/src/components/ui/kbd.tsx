import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'pointer-events-none inline-flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-[5px] border border-border bg-muted px-1',
        'font-sans text-[11px] leading-none font-medium text-muted-foreground select-none',
        className,
      )}
      {...props}
    />
  );
}

export function KbdGroup({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span data-slot="kbd-group" className={cn('inline-flex items-center gap-1', className)} {...props} />
  );
}
