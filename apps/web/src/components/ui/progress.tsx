import { Progress as ProgressPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

interface ProgressProps extends ComponentProps<typeof ProgressPrimitive.Root> {
  /** null renders an indeterminate bar. */
  value: number | null;
  /** Accessible name, e.g. "Upload progress". */
  label: string;
  indicatorClassName?: string;
}

export function Progress({ className, value, label, indicatorClassName, ...props }: ProgressProps) {
  const clamped = value === null ? null : Math.min(100, Math.max(0, value));
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      aria-label={label}
      value={clamped}
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          'h-full rounded-full bg-primary transition-[width] duration-300 ease-out',
          clamped === null && 'w-1/3 motion-safe:animate-[fa-indeterminate_1.4s_ease-in-out_infinite]',
          indicatorClassName,
        )}
        // React applies `style` through the CSSOM, which a strict CSP (style-src 'self') permits.
        style={clamped === null ? undefined : { width: `${clamped}%` }}
      />
    </ProgressPrimitive.Root>
  );
}
