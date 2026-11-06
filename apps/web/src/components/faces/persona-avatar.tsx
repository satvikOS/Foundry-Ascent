import { cva, type VariantProps } from 'class-variance-authority';
import { useState, type ComponentProps } from 'react';

import { cn } from '@/lib/utils';

export type FaceSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

const faceVariants = cva(
  'relative inline-flex shrink-0 items-center justify-center rounded-full select-none',
  {
    variants: {
      size: {
        xs: 'size-3',
        sm: 'size-4',
        md: 'size-5',
        lg: 'size-8',
        xl: 'size-12',
        /** The call stage. */
        '2xl': 'size-28',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

interface PersonaAvatarProps
  extends Omit<ComponentProps<'span'>, 'children'>, VariantProps<typeof faceVariants> {
  /** The mentor's display name ("Thomas"): the face's accessible name unless decorative. */
  name: string;
  /**
   * Served portrait. Only pass one when the EIR consented to their likeness being used; without it the face is
   * the small sphere, never a stock image and never a letter.
   */
  portraitUrl?: string | null;
  /** On a call: an expanding ring shows the mentor is speaking (static ring with reduced motion). */
  speaking?: boolean;
  /** Hide from assistive technology when the name is already visible next to the face. */
  decorative?: boolean;
}

/**
 * The mentor's mark where a visual is truly needed (the studio's persona lists, the welcome): the consented
 * portrait when one exists, otherwise a small, still sphere in the voice palette (the call's presence in
 * miniature). There is no letter monogram (owner, 2026-11-05). Exposed as an image named after the mentor
 * unless decorative.
 */
export function PersonaAvatar({
  name,
  portraitUrl,
  size,
  speaking = false,
  decorative = false,
  className,
  ...props
}: PersonaAvatarProps) {
  const [portraitFailed, setPortraitFailed] = useState(false);
  const showPortrait = Boolean(portraitUrl) && !portraitFailed;

  return (
    <span
      data-slot="persona-avatar"
      data-speaking={speaking || undefined}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative || undefined}
      className={cn(faceVariants({ size }), className)}
      {...props}
    >
      {speaking ? (
        <>
          <span aria-hidden className="absolute -inset-1 rounded-full border border-foreground/60" />
          <span
            aria-hidden
            className="absolute -inset-1 rounded-full border border-foreground/50 motion-safe:animate-speak motion-reduce:hidden"
          />
        </>
      ) : null}
      {showPortrait ? (
        <span
          aria-hidden
          className="relative flex size-full items-center justify-center overflow-hidden rounded-full border border-border-strong"
        >
          <img
            src={portraitUrl ?? undefined}
            alt=""
            decoding="async"
            className="size-full object-cover"
            onError={() => {
              setPortraitFailed(true);
            }}
          />
        </span>
      ) : (
        <span aria-hidden data-slot="persona-orb" className="persona-orb relative size-full" />
      )}
    </span>
  );
}
