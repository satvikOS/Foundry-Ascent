import { DEFAULT_DISCLOSURE } from '@foundry/contracts';
import { useQuery } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import { meQueryOptions } from '@/lib/api/hooks/auth';
import { cn } from '@/lib/utils';

/**
 * The disclosure on public pages, before anyone has signed in (no persona is known yet): what every vEIR
 * is, and that it never speaks for the EIR.
 */
export const PUBLIC_DISCLOSURE =
  'Every vEIR is an AI, built with consent from an EIR’s approved doctrine and style. It is not the EIR and never speaks for them.';

interface DisclosureBannerProps {
  /**
   * Disclosure text. Pass the session's or persona release's `disclosure` when you have it;
   * otherwise the signed-in principal's `Me.disclosure`, then DEFAULT_DISCLOSURE, is used.
   */
  text?: string | null;
  /**
   * "line" (one quiet line under a composer or a conversation header: the view's single disclosure),
   * "inline" (a callout on public pages and reviews), "print" (exports; serif, always visible).
   */
  variant?: 'line' | 'inline' | 'print';
  className?: string;
}

/**
 * Persistent AI disclosure (system-design §9; blueprint 01 F-09). REQUIRED in every conversation view, call
 * and export. It is not dismissible, uses a label + text (never colour alone), and is exposed as a note
 * named "AI disclosure" so assistive technology reads it in context.
 */
export function DisclosureBanner({ text, variant = 'line', className }: DisclosureBannerProps) {
  // Read the cached principal only: public pages must not call GET /me (it would wake the paused DB).
  const { data: me } = useQuery({ ...meQueryOptions(), enabled: false });
  const message =
    [text, me?.disclosure, DEFAULT_DISCLOSURE]
      .map((candidate) => candidate?.trim() ?? '')
      .find((candidate) => candidate.length > 0) ?? DEFAULT_DISCLOSURE;

  if (variant === 'print') {
    return (
      <p
        role="note"
        aria-label="AI disclosure"
        data-slot="disclosure"
        className={cn('border-y border-black/30 py-2 font-serif text-[11pt] leading-snug', className)}
      >
        <strong>AI disclosure. </strong>
        {message}
      </p>
    );
  }

  if (variant === 'line') return <DisclosureLine message={message} className={className} />;

  return (
    <div
      role="note"
      aria-label="AI disclosure"
      data-slot="disclosure"
      className={cn(
        'flex items-start gap-2.5 rounded-lg border border-dashed border-border-strong bg-muted/50 px-3 py-2.5 text-small text-muted-foreground',
        className,
      )}
    >
      <span className="mt-px inline-flex shrink-0 items-center gap-1 rounded-sm border border-border-strong bg-background px-1.5 text-[11px] leading-[18px] font-semibold tracking-wide text-foreground uppercase">
        <Bot aria-hidden className="size-3" />
        AI
      </span>
      <span>{message}</span>
    </div>
  );
}

/**
 * One line: the label and the start of the disclosure. When the full text does not fit, "More" shows the
 * rest; screen readers always get the whole text.
 */
function DisclosureLine({ message, className }: { message: string; className?: string | undefined }) {
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    const measure = () => {
      setClipped(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      observer?.disconnect();
    };
  }, [expanded, message]);

  return (
    <p
      role="note"
      aria-label="AI disclosure"
      data-slot="disclosure"
      className={cn(
        'flex min-w-0 items-baseline justify-center gap-1.5 text-caption text-muted-foreground',
        className,
      )}
    >
      <span className="shrink-0 rounded-[0.25rem] border border-border-strong px-1 font-mono text-[0.625rem] leading-[1.125rem] font-medium tracking-[0.08em] text-foreground uppercase">
        AI
      </span>
      <span ref={textRef} className={cn('min-w-0', expanded ? 'text-pretty' : 'truncate')}>
        {message}
      </span>
      {clipped || expanded ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((value) => !value);
          }}
          className="shrink-0 font-medium text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {expanded ? 'Less' : 'More'}
          <span className="sr-only"> of the AI disclosure</span>
        </button>
      ) : null}
    </p>
  );
}
