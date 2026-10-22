import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { monogram } from '@/lib/veir';
import { cn } from '@/lib/utils';

/**
 * Initials are drawn from `data-initials` (CSS generated content), not written as text: a control's visible label
 * is the text on screen, aria-hidden or not (WCAG 2.5.3 Label in Name), and a face beside a name is no part of it.
 */
const INITIALS = 'before:content-[attr(data-initials)]';

const userAvatarVariants = cva(
  'inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-muted font-sans font-medium text-foreground select-none',
  {
    variants: {
      size: {
        xs: 'size-5 text-[0.5625rem]',
        sm: 'size-6 text-[0.625rem]',
        md: 'size-8 text-[0.75rem]',
        lg: 'size-10 text-[0.875rem]',
        xl: 'size-16 text-[1.25rem]',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

interface UserAvatarProps
  extends Omit<ComponentProps<'span'>, 'children'>, VariantProps<typeof userAvatarVariants> {
  name: string;
  /** Hide from assistive technology when the name is already visible next to the avatar. */
  decorative?: boolean;
}

/**
 * A person: initials only. People never get photos here, so no one's likeness is implied (vEIR faces
 * are PersonaAvatar).
 */
export function UserAvatar({ name, size, decorative = false, className, ...props }: UserAvatarProps) {
  return (
    <span
      data-slot="user-avatar"
      data-initials={monogram(name)}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative || undefined}
      className={cn(userAvatarVariants({ size }), INITIALS, className)}
      {...props}
    />
  );
}

const ventureMarkVariants = cva(
  'inline-flex shrink-0 items-center justify-center rounded-md border border-border-strong bg-card font-sans font-semibold tracking-tight text-foreground select-none',
  {
    variants: {
      size: {
        xs: 'size-5 rounded-[0.3rem] text-[0.5625rem]',
        sm: 'size-6 rounded-[0.35rem] text-[0.625rem]',
        md: 'size-8 text-[0.75rem]',
        lg: 'size-10 rounded-lg text-[0.875rem]',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

interface VentureMarkProps
  extends Omit<ComponentProps<'span'>, 'children'>, VariantProps<typeof ventureMarkVariants> {
  name: string;
  decorative?: boolean;
}

/** A venture's square monogram (switcher, lists). */
export function VentureMark({ name, size, decorative = true, className, ...props }: VentureMarkProps) {
  return (
    <span
      data-slot="venture-mark"
      data-initials={monogram(name)}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative || undefined}
      className={cn(ventureMarkVariants({ size }), INITIALS, className)}
      {...props}
    />
  );
}
