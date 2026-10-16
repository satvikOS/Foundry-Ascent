import { cn } from '@/lib/utils';

interface CallCaptionsProps {
  name: string;
  veir: string | null;
  founder: string | null;
  founderLive: boolean;
}

/**
 * Live captions: the vEIR's current sentence (the reading face, large) and what the founder is saying.
 * Not a live region: the vEIR's voice and a screen reader would talk over each other, and announcements
 * on a call carry state, never content.
 */
export function CallCaptions({ name, veir, founder, founderLive }: CallCaptionsProps) {
  return (
    <section aria-label="Captions" className="mx-auto grid w-full max-w-2xl gap-4 px-2 text-center">
      <p className="min-h-[2lh] font-serif text-[1.25rem] leading-[1.5] text-pretty text-foreground sm:text-[1.375rem]">
        {veir ? (
          <>
            <span className="sr-only">{name}: </span>
            {veir}
          </>
        ) : null}
      </p>
      <p
        className={cn(
          'min-h-[1lh] text-[1rem] leading-[1.55] text-pretty text-muted-foreground sm:text-[1.0625rem]',
          founderLive && 'text-subtle-foreground',
        )}
      >
        {founder ? (
          <>
            <span className="label-mono mr-2 align-[0.1em]">You</span>
            {founder}
          </>
        ) : null}
      </p>
    </section>
  );
}
