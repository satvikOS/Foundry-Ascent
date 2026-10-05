import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn, initials } from '@/lib/utils';

const avatarVariants = cva(
  'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted font-medium text-foreground uppercase select-none',
  {
    variants: {
      size: {
        xs: 'size-5 text-[9px]',
        sm: 'size-6 text-[10px]',
        default: 'size-8 text-xs',
        lg: 'size-10 text-sm',
      },
      shape: {
        circle: 'rounded-full',
        square: 'rounded-md',
      },
    },
    defaultVariants: { size: 'default', shape: 'circle' },
  },
);

interface AvatarProps extends Omit<ComponentProps<'span'>, 'children'>, VariantProps<typeof avatarVariants> {
  name: string;
  /** Hide from assistive technology when the name is already visible next to the avatar. */
  decorative?: boolean;
}

/**
 * Initials avatar. No photos are used anywhere in the product (synthetic identities only); a person's
 * likeness must never be implied.
 */
export function Avatar({ name, size, shape, decorative = false, className, ...props }: AvatarProps) {
  return (
    <span
      data-slot="avatar"
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative || undefined}
      className={cn(avatarVariants({ size, shape }), className)}
      {...props}
    >
      {initials(name)}
    </span>
  );
}
