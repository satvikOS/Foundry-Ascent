import type { TurnFeedbackRequest } from '@foundry/contracts';
import { Check } from 'lucide-react';
import { useId, useState } from 'react';
import type { z } from 'zod';

import { announce } from '@/components/a11y/live-announcer';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api/errors';
import { useTurnFeedback } from '@/lib/api/hooks/sessions';
import { cn } from '@/lib/utils';

type Flag = z.infer<typeof TurnFeedbackRequest>['flags'][number];

const FLAGS: { id: Flag; label: string }[] = [
  { id: 'great_challenge', label: 'Great challenge' },
  { id: 'inaccurate', label: 'Inaccurate' },
  { id: 'unsupported', label: 'Not supported by evidence' },
  { id: 'too_generic', label: 'Too generic' },
  { id: 'unhelpful', label: 'Unhelpful' },
  { id: 'unsafe', label: 'Unsafe' },
];

const RATING_LABELS = ['Not useful', 'Slightly useful', 'Somewhat useful', 'Useful', 'Very useful'] as const;

/**
 * 1–5 rating plus optional flags and comment for one coach response. Ratings feed EIR calibration
 * reviews; they never change the response.
 */
export function TurnFeedback({ turnId }: { turnId: string }) {
  const feedback = useTurnFeedback();
  const ids = { group: useId(), comment: useId() };
  const [rating, setRating] = useState<number | null>(null);
  const [flags, setFlags] = useState<Set<Flag>>(new Set());
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground" role="status">
        <Check aria-hidden className="size-4 text-success" />
        Thanks — your feedback helps reviewers calibrate Foundry Guide.
      </p>
    );
  }

  const submit = () => {
    if (rating === null) return;
    feedback.mutate(
      { turnId, feedback: { rating, flags: [...flags], comment: comment.trim() || null } },
      {
        onSuccess: () => {
          setSent(true);
          announce('Feedback sent');
        },
        onError: (error) => {
          toast.error('Couldn’t send feedback', { description: errorMessage(error) });
        },
      },
    );
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span id={ids.group} className="text-[13px] text-muted-foreground">
          Was this useful?
        </span>
        <div role="radiogroup" aria-labelledby={ids.group} className="flex items-center gap-1">
          {RATING_LABELS.map((label, index) => {
            const value = index + 1;
            const checked = rating === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={`${value} — ${label}`}
                title={label}
                tabIndex={checked || (rating === null && value === 1) ? 0 : -1}
                onClick={() => {
                  setRating(value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    const next = Math.min(5, (rating ?? 0) + 1);
                    setRating(next);
                    (
                      event.currentTarget.parentElement?.children[next - 1] as HTMLElement | undefined
                    )?.focus();
                  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    const next = Math.max(1, (rating ?? 2) - 1);
                    setRating(next);
                    (
                      event.currentTarget.parentElement?.children[next - 1] as HTMLElement | undefined
                    )?.focus();
                  }
                }}
                className={cn(
                  'tabular flex size-7 items-center justify-center rounded-md border text-[13px] font-medium transition-colors',
                  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
                  checked
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground',
                )}
              >
                {value}
              </button>
            );
          })}
        </div>
        {rating !== null ? (
          <span className="text-xs text-muted-foreground">{RATING_LABELS[rating - 1]}</span>
        ) : null}
      </div>
      {rating !== null ? (
        <div className="grid gap-3">
          <fieldset>
            <legend className="mb-1.5 text-[13px] text-muted-foreground">
              Anything specific? (optional)
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {FLAGS.map((flag) => {
                const on = flags.has(flag.id);
                return (
                  <button
                    key={flag.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      setFlags((prev) => {
                        const next = new Set(prev);
                        if (on) next.delete(flag.id);
                        else next.add(flag.id);
                        return next;
                      });
                    }}
                    className={cn(
                      'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors',
                      'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
                      on
                        ? 'border-foreground bg-accent text-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {on ? <Check aria-hidden className="size-3" /> : null}
                    {flag.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <div className="grid gap-1.5">
            <label htmlFor={ids.comment} className="text-[13px] text-muted-foreground">
              Comment (optional)
            </label>
            <Textarea
              id={ids.comment}
              value={comment}
              maxLength={2000}
              minRows={2}
              maxRows={5}
              onChange={(event) => {
                setComment(event.target.value);
              }}
            />
          </div>
          <div>
            <Button
              size="sm"
              variant="secondary"
              onClick={submit}
              loading={feedback.isPending}
              loadingText="Sending…"
            >
              Send feedback
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
