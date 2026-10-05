import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

import { Spinner } from './spinner';

export const buttonVariants = cva(
  [
    'relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap select-none',
    'transition-[color,background-color,border-color,box-shadow,opacity] duration-150 ease-out',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 active:bg-primary/85',
        secondary:
          'border border-border bg-secondary text-secondary-foreground shadow-xs hover:border-border-strong hover:bg-accent',
        outline: 'border border-border-strong bg-transparent text-foreground hover:bg-accent',
        ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground',
        subtle: 'text-muted-foreground hover:bg-accent hover:text-foreground',
        destructive:
          'bg-destructive-strong text-destructive-foreground shadow-xs hover:bg-destructive-strong/90 active:bg-destructive-strong/85',
        'destructive-outline':
          'border border-destructive/50 bg-transparent text-destructive hover:border-destructive hover:bg-destructive/10',
        link: 'h-auto px-0 text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground',
      },
      size: {
        xs: 'h-7 gap-1.5 rounded-sm px-2 text-xs',
        sm: 'h-8 gap-1.5 px-3 text-[13px]',
        default: 'h-9 px-4',
        lg: 'h-11 rounded-lg px-6 text-[15px]',
        icon: 'size-9',
        'icon-sm': 'size-8',
        'icon-xs': 'size-7 rounded-sm',
      },
    },
    compoundVariants: [{ variant: 'link', className: 'px-0' }],
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  /** Render the single child element (e.g. a router Link) with button styling. */
  asChild?: boolean;
  /** Shows a spinner, sets aria-busy and disables the button. */
  loading?: boolean;
  /** Text announced while loading (defaults to the visible label). */
  loadingText?: string;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  loadingText,
  disabled,
  children,
  type,
  ...props
}: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);

  if (asChild) {
    return (
      <Slot.Root data-slot="button" className={classes} aria-busy={loading || undefined} {...props}>
        {children}
      </Slot.Root>
    );
  }

  return (
    <button
      data-slot="button"
      type={type ?? 'button'}
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <Spinner />
          {loadingText ?? children}
        </>
      ) : (
        children
      )}
    </button>
  );
}
