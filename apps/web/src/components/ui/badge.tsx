import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

export const badgeVariants = cva(
  [
    'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border px-1.5 py-0.5',
    "text-xs leading-4 font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg:not([class*='size-'])]:size-3",
    'transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
  ],
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-border bg-secondary text-secondary-foreground',
        outline: 'border-border-strong text-foreground',
        muted: 'border-transparent bg-muted text-muted-foreground',
        success: 'border-success/35 bg-success/10 text-success',
        warning: 'border-warning/35 bg-warning/10 text-warning',
        destructive: 'border-destructive/35 bg-destructive/10 text-destructive',
        info: 'border-info/35 bg-info/10 text-info',
      },
    },
    defaultVariants: { variant: 'secondary' },
  },
);

export interface BadgeProps extends ComponentProps<'span'>, VariantProps<typeof badgeVariants> {
  asChild?: boolean;
}

export function Badge({ className, variant, asChild = false, ...props }: BadgeProps) {
  const Comp = asChild ? Slot.Root : 'span';
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}
