import type { MemoryObjectView } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { Check, CheckCheck, Pencil, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { HairlineSkeleton } from '@/components/ui/page-section';
import { toast } from '@/components/ui/toast';
import { displayContent, useMemory } from '@/lib/api/hooks/memory';
import { formatDateTime, formatRelative, isoString, pluralize } from '@/lib/format';
import { MEMORY_TYPE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { CorrectMemoryDialog } from '@/features/memory/memory-dialogs';
import { useVeirName } from '@/features/venture/veir-name';

import {
  PartialReviewError,
  reviewFailure,
  reviewMessage,
  useMemoryReview,
  type ReviewAction,
} from './review-api';

const SEQUENCE_PREFIX_MS = 1000;

function isTypingTarget(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

interface ReviewQueueProps {
  ventureId: string;
  tenant: string;
  /** Founders and the team decide; others only see the queue. */
  canEdit: boolean;
  /** Open an item's full detail (provenance, history). */
  onOpenDetail: (memoryId: string) => void;
}

/**
 * The one "To review" queue: memory the vEIR (or a teammate) proposed, waiting for a person. Approve
 * or reject one item, or select several and decide them together. Keyboard: J/K or the arrows move,
 * X selects, A approves, R rejects, E edits, Enter opens the detail.
 */
export function ReviewQueue({ ventureId, tenant, canEdit, onOpenDetail }: ReviewQueueProps) {
  const proposed = useMemory(ventureId, { status: 'proposed' });
  const review = useMemoryReview(ventureId);
  const author = useVeirName(ventureId);
  const items = useMemo(() => proposed.data ?? [], [proposed.data]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editing, setEditing] = useState<MemoryObjectView | null>(null);
  const [confirmReject, setConfirmReject] = useState<readonly string[] | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const lastIndex = useRef(0);
  const keyboard = useRef(false);
  const lastKey = useRef<{ key: string; at: number } | null>(null);

  // Selection only ever holds items still waiting.
  const live = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  const chosen = useMemo(() => [...selected].filter((id) => live.has(id)), [selected, live]);

  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === activeId),
  );

  const focusRow = useCallback((id: string) => {
    requestAnimationFrame(() => {
      rowRefs.current.get(id)?.focus();
    });
  }, []);

  // When the active item leaves the queue, the item now at its place becomes active.
  useEffect(() => {
    if (items.length === 0) return;
    if (activeId && items.some((item) => item.id === activeId)) return;
    const next = items[Math.min(lastIndex.current, items.length - 1)];
    if (!next) return;
    setActiveId(next.id);
    if (keyboard.current) focusRow(next.id);
  }, [items, activeId, focusRow]);

  const deselect = (ids: readonly string[]) => {
    setSelected((previous) => new Set([...previous].filter((id) => !ids.includes(id))));
  };

  const decide = (ids: readonly string[], action: ReviewAction) => {
    if (ids.length === 0) return;
    const first = items.findIndex((item) => ids.includes(item.id));
    lastIndex.current = Math.max(0, first);
    review.mutate(
      { ids, action },
      {
        onSuccess: (result) => {
          const message = reviewMessage(action, result);
          const left = items.length - result.items.length - result.skippedIds.length;
          toast.success(message);
          announce(`${message} ${left <= 0 ? 'All caught up.' : `${pluralize(left, 'item')} left.`}`);
          deselect(ids);
        },
        onError: (error) => {
          const failure = reviewFailure(action, ids, error);
          toast.error(failure.title, { description: failure.description });
          announce(failure.title, 'assertive');
          if (error instanceof PartialReviewError) {
            deselect([...error.done.items.map((item) => item.id), ...error.done.skippedIds]);
          }
        },
      },
    );
  };

  const toggle = (id: string, on: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const move = (delta: number) => {
    if (items.length === 0) return;
    const index = Math.min(items.length - 1, Math.max(0, activeIndex + delta));
    const next = items[index];
    if (!next) return;
    lastIndex.current = index;
    setActiveId(next.id);
    focusRow(next.id);
  };

  const rowOf = (target: EventTarget): MemoryObjectView | null => {
    if (!(target instanceof Element)) return null;
    const id = target.closest<HTMLElement>('li[data-id]')?.dataset.id;
    return items.find((item) => item.id === id) ?? null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    // Leave "g then x" navigation sequences to the global shortcut handler.
    const previous = lastKey.current;
    lastKey.current = { key, at: Date.now() };
    if (previous?.key === 'g' && Date.now() - previous.at < SEQUENCE_PREFIX_MS) return;
    keyboard.current = true;
    if (key === 'j' || key === 'arrowdown') {
      event.preventDefault();
      move(1);
      return;
    }
    if (key === 'k' || key === 'arrowup') {
      event.preventDefault();
      move(-1);
      return;
    }
    // Shortcuts act on the row that holds the focus (the row itself, or its checkbox or a button).
    const row = rowOf(event.target);
    if (!row) return;
    if (key === 'enter') {
      // Enter on a button inside the row presses that button.
      if (event.target !== rowRefs.current.get(row.id)) return;
      event.preventDefault();
      onOpenDetail(row.id);
      return;
    }
    if (!canEdit) return;
    if (key === 'a') {
      event.preventDefault();
      decide([row.id], 'approve');
    } else if (key === 'r') {
      event.preventDefault();
      decide([row.id], 'reject');
    } else if (key === 'e') {
      event.preventDefault();
      setEditing(row);
    } else if (key === 'x') {
      event.preventDefault();
      toggle(row.id, !selected.has(row.id));
    }
  };

  if (proposed.isPending) return <HairlineSkeleton rows={3} label="Loading suggestions…" />;
  if (proposed.isError) {
    return <ErrorState error={proposed.error} onRetry={() => void proposed.refetch()} headingLevel={2} />;
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon={CheckCheck}
        headingLevel={2}
        title="Nothing to review"
        description={`When ${author} suggests something to remember, it waits here until someone on your team decides.`}
      />
    );
  }

  const allSelected = chosen.length === items.length;
  return (
    <div className="grid gap-3">
      <div
        role="toolbar"
        aria-label="Review suggestions"
        className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2"
      >
        <div className="flex items-center gap-3">
          {canEdit ? (
            <Checkbox
              aria-label="Select all"
              checked={allSelected ? true : chosen.length > 0 ? 'indeterminate' : false}
              onCheckedChange={(checked) => {
                setSelected(checked === true ? new Set(items.map((item) => item.id)) : new Set());
              }}
            />
          ) : null}
          <p className="text-small text-muted-foreground" role="status" aria-live="polite">
            {chosen.length > 0
              ? `${chosen.length} of ${pluralize(items.length, 'suggestion')} selected`
              : `${pluralize(items.length, 'suggestion')} to review`}
          </p>
        </div>
        {canEdit && chosen.length > 0 ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              loading={review.isPending && review.variables.action === 'approve'}
              onClick={() => {
                decide(chosen, 'approve');
              }}
            >
              <Check aria-hidden />
              Approve {chosen.length}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={review.isPending}
              onClick={() => {
                setConfirmReject(chosen);
              }}
            >
              <X aria-hidden />
              Reject {chosen.length}
            </Button>
          </div>
        ) : null}
      </div>

      <ul
        aria-label="Suggestions to review"
        aria-describedby={canEdit ? 'review-queue-keys' : undefined}
        onKeyDown={onKeyDown}
        className="divide-y divide-border border-y border-border"
      >
        {items.map((item, index) => {
          const isActive = index === activeIndex;
          const checkboxId = `review-${item.id}`;
          const session = item.sourceRefs.find((ref) => ref.kind === 'session');
          return (
            <li
              key={item.id}
              ref={(node) => {
                if (node) rowRefs.current.set(item.id, node);
                else rowRefs.current.delete(item.id);
              }}
              data-id={item.id}
              tabIndex={isActive ? 0 : -1}
              aria-labelledby={`${checkboxId}-title`}
              aria-current={isActive ? 'true' : undefined}
              onFocus={() => {
                // Focus anywhere in the row (its checkbox or a button too) makes it the active row.
                setActiveId(item.id);
                lastIndex.current = index;
              }}
              className={cn(
                'grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 py-4 outline-none sm:grid-cols-[auto_minmax(0,1fr)_auto]',
                'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                !canEdit && 'grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_auto]',
              )}
            >
              {canEdit ? (
                <Checkbox
                  id={checkboxId}
                  className="mt-1"
                  checked={selected.has(item.id)}
                  aria-labelledby={`${checkboxId}-title`}
                  onCheckedChange={(checked) => {
                    toggle(item.id, checked === true);
                  }}
                />
              ) : null}
              <div className="grid min-w-0 gap-1">
                <h3
                  id={`${checkboxId}-title`}
                  className="text-[15px] leading-snug font-medium [overflow-wrap:anywhere]"
                >
                  {item.title}
                </h3>
                <p className="line-clamp-3 text-small text-muted-foreground [overflow-wrap:anywhere]">
                  {displayContent(item)}
                </p>
                <p className="flex flex-wrap items-center gap-x-1.5 text-caption text-subtle-foreground">
                  <span>{MEMORY_TYPE_LABELS[item.type].label}</span>
                  <span aria-hidden>·</span>
                  <span>
                    {item.origin === 'ai'
                      ? `Suggested by ${author}`
                      : `Added by ${item.createdBy.displayName}`}
                  </span>
                  {session ? (
                    <>
                      <span aria-hidden>·</span>
                      <Link
                        to="/$tenant/app/v/$ventureId/c/$sessionId"
                        params={{ tenant, ventureId, sessionId: session.id }}
                        className="underline decoration-border-strong underline-offset-[3px] hover:text-foreground hover:decoration-foreground"
                      >
                        From a conversation
                      </Link>
                    </>
                  ) : null}
                  <span aria-hidden>·</span>
                  <time dateTime={isoString(item.createdAt)} title={formatDateTime(item.createdAt)}>
                    {formatRelative(item.createdAt)}
                  </time>
                </p>
              </div>
              <div
                className={cn(
                  'flex flex-wrap items-center gap-1.5 sm:col-start-auto sm:justify-end',
                  canEdit ? 'col-start-2' : 'col-start-1',
                )}
              >
                {canEdit ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={review.isPending}
                      aria-describedby={`${checkboxId}-title`}
                      onClick={() => {
                        decide([item.id], 'approve');
                      }}
                    >
                      <Check aria-hidden />
                      Approve
                      {isActive ? (
                        <Kbd aria-hidden className="ml-0.5 hidden md:inline-flex">
                          A
                        </Kbd>
                      ) : null}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={review.isPending}
                      aria-describedby={`${checkboxId}-title`}
                      onClick={() => {
                        decide([item.id], 'reject');
                      }}
                    >
                      Reject
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Edit"
                      aria-describedby={`${checkboxId}-title`}
                      onClick={() => {
                        setEditing(item);
                      }}
                    >
                      <Pencil aria-hidden />
                    </Button>
                  </>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-describedby={`${checkboxId}-title`}
                  onClick={() => {
                    onOpenDetail(item.id);
                  }}
                >
                  Details
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {canEdit ? (
        <p
          id="review-queue-keys"
          className="hidden items-center gap-3 text-caption text-subtle-foreground md:flex"
        >
          <span className="sr-only">
            Keyboard: J and K or the arrow keys move, X selects, A approves, R rejects, E edits, Enter opens
            details.
          </span>
          <KbdGroup aria-hidden>
            <Kbd>J</Kbd>
            <Kbd>K</Kbd> move
          </KbdGroup>
          <KbdGroup aria-hidden>
            <Kbd>X</Kbd> select
          </KbdGroup>
          <KbdGroup aria-hidden>
            <Kbd>A</Kbd> approve
          </KbdGroup>
          <KbdGroup aria-hidden>
            <Kbd>R</Kbd> reject
          </KbdGroup>
          <KbdGroup aria-hidden>
            <Kbd>E</Kbd> edit
          </KbdGroup>
        </p>
      ) : null}

      <CorrectMemoryDialog
        ventureId={ventureId}
        memory={editing}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            const id = editing?.id;
            setEditing(null);
            if (id && keyboard.current) focusRow(id);
          }
        }}
      />

      <AlertDialog
        open={confirmReject !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmReject(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject {pluralize(confirmReject?.length ?? 0, 'suggestion')}?</AlertDialogTitle>
            <AlertDialogDescription>
              They won’t be used as memory. You can add anything that turns out to be right yourself.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              onClick={() => {
                const ids = confirmReject ?? [];
                setConfirmReject(null);
                decide(ids, 'reject');
              }}
            >
              Reject
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
