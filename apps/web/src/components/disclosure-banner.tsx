import { DEFAULT_DISCLOSURE } from '@foundry/contracts';
import { useQuery } from '@tanstack/react-query';
import { Bot } from 'lucide-react';

import { meQueryOptions } from '@/lib/api/hooks/auth';
import { cn } from '@/lib/utils';

interface DisclosureBannerProps {
  /**
   * Disclosure text. Pass the session's or persona release's `disclosure` when you have it;
   * otherwise the signed-in principal's `Me.disclosure`, then DEFAULT_DISCLOSURE, is used.
   */
  text?: string | null;
  /**
   * "line" (one quiet line under a composer or call: the conversation's single disclosure), "inline"
   * (card callout), "banner" (full-width strip), "print" (exports; serif, always visible).
   */
  variant?: 'line' | 'banner' | 'inline' | 'print';
  className?: string;
}

/**
 * Persistent synthetic-identity disclosure (system-design §9; blueprint 01 F-09). REQUIRED in every
 * session view and every export. It is not dismissible, uses an icon + text (never colour alone),
 * and is exposed as a labelled note so assistive technology reads it in context.
 */
export function DisclosureBanner({ text, variant = 'banner', className }: DisclosureBannerProps) {
  // Read the cached principal only: public pages must not call GET /me (it would wake the paused DB).
  const { data: me } = useQuery({ ...meQueryOptions(), enabled: false });
  const message = [text, me?.disclosure, DEFAULT_DISCLOSURE]
    .map((candidate) => candidate?.trim() ?? '')
    .find((candidate) => candidate.length > 0);

  if (variant === 'print') {
    return (
      <p
        role="note"
        aria-label="AI disclosure"
        data-slot="disclosure"
        className={cn('border-y border-black/30 py-2 font-serif text-[11pt] leading-snug', className)}
      >
        <strong>AI disclosure. </strong>
        {message ?? DEFAULT_DISCLOSURE}
      </p>
    );
  }

  if (variant === 'line') {
    return (
      <p
        role="note"
        aria-label="AI disclosure"
        data-slot="disclosure"
        className={cn(
          'flex items-baseline justify-center gap-1.5 text-caption text-muted-foreground',
          className,
        )}
      >
        <span className="shrink-0 rounded-[0.25rem] border border-border-strong px-1 font-mono text-[0.625rem] leading-[1.125rem] font-medium tracking-[0.08em] text-foreground uppercase">
          AI
        </span>
        <span className="min-w-0 text-pretty">{message ?? DEFAULT_DISCLOSURE}</span>
      </p>
    );
  }

  return (
    <div
      role="note"
      aria-label="AI disclosure"
      data-slot="disclosure"
      className={cn(
        'flex items-start gap-2.5 text-small text-muted-foreground',
        variant === 'banner' &&
          'border-b border-dashed border-border-strong bg-muted/50 px-4 py-2 sm:items-center',
        variant === 'inline' &&
          'rounded-lg border border-dashed border-border-strong bg-muted/50 px-3 py-2.5',
        className,
      )}
    >
      <span className="mt-px inline-flex shrink-0 items-center gap-1 rounded-sm border border-border-strong bg-background px-1.5 text-[11px] leading-[18px] font-semibold tracking-wide text-foreground uppercase sm:mt-0">
        <Bot aria-hidden className="size-3" />
        AI
      </span>
      <span>{message ?? DEFAULT_DISCLOSURE}</span>
    </div>
  );
}
