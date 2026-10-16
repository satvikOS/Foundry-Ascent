import type { TurnFeedbackRequest } from '@foundry/contracts';
import { Check, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useId, useState } from 'react';
import type { z } from 'zod';

import { announce } from '@/components/a11y/live-announcer';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { errorMessage } from '@/lib/api/errors';
import { useTurnFeedback } from '@/lib/api/hooks/sessions';
import { cn } from '@/lib/utils';

type Flag = z.infer<typeof TurnFeedbackRequest>['flags'][number];

const PROBLEMS: { id: Flag; label: string }[] = [
  { id: 'inaccurate', label: 'Inaccurate' },
  { id: 'unsupported', label: 'Not supported by sources' },
  { id: 'too_generic', label: 'Too generic' },
  { id: 'unhelpful', label: 'Unhelpful' },
  { id: 'unsafe', label: 'Unsafe' },
];

/** Thumbs map onto the 1–5 rating reviewers calibrate with. */
const GOOD = 5;
const BAD = 1;

/**
 * Copy and rate one answer. Shown under the latest answer, and on hover or focus for earlier ones.
 * Ratings feed the EIR's calibration reviews; they never change the answer. An answer the person rated
 * before (`myRating`, kept by the server) shows the thumb they chose instead of the buttons.
 */
export function MessageActions({
  turnId,
  copyText,
  canRate,
  pinned,
  myRating = null,
}: {
  turnId: string;
  copyText: string;
  canRate: boolean;
  /** Always visible (the latest answer, touch screens); otherwise on hover or focus. */
  pinned: boolean;
  /** The person's own earlier rating of this answer (1–5), or null. */
  myRating?: number | null;
}) {
  const feedback = useTurnFeedback();
  /** Rated just now, on this page: a short thanks. */
  const [rated, setRated] = useState<'good' | 'bad' | null>(null);
  const earlier = myRating === null ? null : myRating >= GOOD ? 'good' : 'bad';
  const [reporting, setReporting] = useState(false);

  const send = (rating: number, flags: Flag[] = [], comment: string | null = null) => {
    feedback.mutate(
      { turnId, feedback: { rating, flags, comment } },
      {
        onSuccess: () => {
          setRated(rating >= GOOD ? 'good' : 'bad');
          setReporting(false);
          announce('Thanks for the feedback');
        },
        onError: (error) => {
          toast.error('Couldn’t send feedback', { description: errorMessage(error) });
        },
      },
    );
  };

  return (
    <div
      data-print="hide"
      className={cn(
        'mt-2 -ml-2 flex items-center gap-0.5 text-muted-foreground transition-opacity duration-150',
        !pinned &&
          'opacity-0 group-focus-within/answer:opacity-100 group-hover/answer:opacity-100 pointer-coarse:opacity-100',
      )}
    >
      <CopyButton value={copyText} label="Copy answer" size="icon-xs" variant="subtle" />
      {canRate ? (
        rated ? (
          <span className="inline-flex h-7 items-center gap-1 px-1.5 text-caption" role="status">
            <Check aria-hidden className="size-3.5" />
            Thanks
          </span>
        ) : earlier ? (
          <span
            role="img"
            aria-label={earlier === 'good' ? 'You rated this a good answer' : 'You rated this a bad answer'}
            title={earlier === 'good' ? 'You rated this a good answer' : 'You rated this a bad answer'}
            className="inline-flex size-7 items-center justify-center text-foreground"
          >
            {earlier === 'good' ? (
              <ThumbsUp aria-hidden className="size-4 fill-current" />
            ) : (
              <ThumbsDown aria-hidden className="size-4 fill-current" />
            )}
          </span>
        ) : (
          <>
            <SimpleTooltip content="Good answer">
              <Button
                variant="subtle"
                size="icon-xs"
                aria-label="Good answer"
                disabled={feedback.isPending}
                onClick={() => {
                  send(GOOD);
                }}
              >
                <ThumbsUp aria-hidden />
              </Button>
            </SimpleTooltip>
            <SimpleTooltip content="Bad answer">
              <Button
                variant="subtle"
                size="icon-xs"
                aria-label="Bad answer"
                disabled={feedback.isPending}
                onClick={() => {
                  setReporting(true);
                }}
              >
                <ThumbsDown aria-hidden />
              </Button>
            </SimpleTooltip>
            <BadAnswerDialog
              open={reporting}
              onOpenChange={setReporting}
              pending={feedback.isPending}
              onSubmit={(flags, comment) => {
                send(BAD, flags, comment);
              }}
            />
          </>
        )
      ) : null}
    </div>
  );
}

/**
 * "What was wrong?": optional problems and details for a thumbs-down. The form lives inside the dialog
 * content, which unmounts when the dialog closes, so every way of closing it (Cancel, Escape, the close
 * button, a sent report) starts the next report empty.
 */
function BadAnswerDialog({
  open,
  onOpenChange,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onSubmit: (flags: Flag[], comment: string | null) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>What was wrong?</DialogTitle>
          <DialogDescription>
            Reviewers use this to improve answers. Both parts are optional.
          </DialogDescription>
        </DialogHeader>
        <BadAnswerForm
          pending={pending}
          onCancel={() => {
            onOpenChange(false);
          }}
          onSubmit={onSubmit}
        />
      </DialogContent>
    </Dialog>
  );
}

function BadAnswerForm({
  pending,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  onCancel: () => void;
  onSubmit: (flags: Flag[], comment: string | null) => void;
}) {
  const commentId = useId();
  const [flags, setFlags] = useState<ReadonlySet<Flag>>(new Set());
  const [comment, setComment] = useState('');
  return (
    <>
      <div className="grid gap-4">
        <fieldset>
          <legend className="sr-only">Problems</legend>
          <div className="flex flex-wrap gap-1.5">
            {PROBLEMS.map((problem) => {
              const on = flags.has(problem.id);
              return (
                <button
                  key={problem.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    setFlags((prev) => {
                      const next = new Set(prev);
                      if (on) next.delete(problem.id);
                      else next.add(problem.id);
                      return next;
                    });
                  }}
                  className={cn(
                    'inline-flex h-8 items-center gap-1 rounded-full border px-3 text-small transition-colors',
                    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
                    on
                      ? 'border-foreground bg-accent text-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {on ? <Check aria-hidden className="size-3.5" /> : null}
                  {problem.label}
                </button>
              );
            })}
          </div>
        </fieldset>
        <div className="grid gap-1.5">
          <label htmlFor={commentId} className="text-small font-medium">
            Details
          </label>
          <Textarea
            id={commentId}
            value={comment}
            maxLength={2000}
            minRows={3}
            maxRows={6}
            onChange={(event) => {
              setComment(event.target.value);
            }}
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          loading={pending}
          loadingText="Sending…"
          onClick={() => {
            onSubmit([...flags], comment.trim() || null);
          }}
        >
          Send feedback
        </Button>
      </DialogFooter>
    </>
  );
}
