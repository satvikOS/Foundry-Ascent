import { cva, type VariantProps } from 'class-variance-authority';
import { useState, type ComponentProps } from 'react';

import { monogram } from '@/lib/veir';
import { cn } from '@/lib/utils';

export type FaceSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const faceVariants = cva(
  'relative inline-flex shrink-0 items-center justify-center rounded-full select-none',
  {
    variants: {
      size: {
        xs: 'size-5',
        sm: 'size-6',
        md: 'size-8',
        lg: 'size-10',
        xl: 'size-16',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

/** Serif monogram sizes, tuned per face size so the letters sit optically centred. */
const MONOGRAM_TEXT: Record<FaceSize, string> = {
  xs: 'text-[0.6875rem]',
  sm: 'text-[0.8125rem]',
  md: 'text-[1rem]',
  lg: 'text-[1.25rem]',
  xl: 'text-[1.875rem]',
};

interface PersonaAvatarProps
  extends Omit<ComponentProps<'span'>, 'children'>, VariantProps<typeof faceVariants> {
  /** The vEIR's short name ("Corin"); its monogram is used when there is no portrait. */
  name: string;
  /**
   * Served portrait. Only pass one when the EIR consented to their likeness being used; without it
   * the face is a monogram, never a stock image.
   */
  portraitUrl?: string | null;
  /** On a call: an expanding ring shows the vEIR is speaking (static ring with reduced motion). */
  speaking?: boolean;
  /** Hide from assistive technology when the name is already visible next to the face. */
  decorative?: boolean;
}

/**
 * The face of a vEIR: the consented portrait when one exists, otherwise a refined monogram (serif
 * initials inside a hairline ring). Exposed as an image named after the vEIR unless decorative.
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
  const key: FaceSize = size ?? 'md';
  const showPortrait = Boolean(portraitUrl) && !portraitFailed;
  const large = key === 'lg' || key === 'xl';

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
      <span
        aria-hidden
        className={cn(
          'relative flex size-full items-center justify-center overflow-hidden rounded-full',
          'border border-border-strong bg-gradient-to-b from-card to-muted text-foreground',
          // A second hairline inside the first: the "ring" of the monogram on larger faces.
          large && 'shadow-[inset_0_0_0_3px_var(--card),inset_0_0_0_4px_var(--border)]',
        )}
      >
        {showPortrait ? (
          <img
            src={portraitUrl ?? undefined}
            alt=""
            decoding="async"
            className="size-full object-cover"
            onError={() => {
              setPortraitFailed(true);
            }}
          />
        ) : (
          <span
            className={cn(
              'font-serif leading-none font-medium tracking-[-0.02em]',
              MONOGRAM_TEXT[key],
              // Optical centring: serif capitals sit slightly high in their box.
              'translate-y-[0.04em]',
            )}
          >
            {monogram(name)}
          </span>
        )}
      </span>
    </span>
  );
}
