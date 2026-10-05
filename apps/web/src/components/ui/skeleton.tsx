import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** Loading placeholder. Decorative: wrap loading regions in an element with aria-busy="true". */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn('skeleton-shimmer rounded-md bg-muted', className)}
      {...props}
    />
  );
}

/** Generic block of text lines. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('grid gap-2', className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3.5', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}

/** Region wrapper that announces loading to assistive technology. */
export function LoadingRegion({
  label = 'Loading',
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={className}>
      <span className="sr-only">{label}…</span>
      {children}
    </div>
  );
}
