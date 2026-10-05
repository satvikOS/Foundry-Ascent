import type { MemoryObjectView } from '@foundry/contracts';
import { Check, CheckCheck, Pencil, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Markdown } from '@/components/ui/markdown';
import { Skeleton } from '@/components/ui/skeleton';
import { displayContent, useMemory } from '@/lib/api/hooks/memory';
import { formatRelative, pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';

import { useMemoryActions } from './api';
import { CorrectMemoryDialog } from './memory-dialogs';
import { MemoryAttributesList } from './memory-detail';
import { ConfidenceMeter, MemoryTypeLabel, OriginLabel, SourceRefList, VisibilityLabel } from './memory-meta';

const SEQUENCE_PREFIX_MS = 1000;

function isTypingTarget(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

interface ProposedQueueProps {
  ventureId: string;
  tenant: string;
  canEdit: boolean;
  /** Show the item in the detail inspector. */
  onOpenDetail: (memoryId: string) => void;
}

/**
 * Fast review of memory the coach proposed. Keyboard: J/K (or ↓/↑) move, A approves, R rejects,
 * E edits, Enter opens the full detail. Keys are handled only while focus is inside the queue, so they
 * never fight global shortcuts or typing.
 */
export function ProposedQueue({ ventureId, tenant, canEdit, onOpenDetail }: ProposedQueueProps) {
  const proposed = useMemory(ventureId, { status: 'proposed' });
  const { run } = useMemoryActions(ventureId);
  const items = proposed.data ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editing, setEditing] = useState<MemoryObjectView | null>(null);
  const lastIndex = useRef(0);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const keyboardFocus = useRef(false);
  const lastKey = useRef<{ key: string; at: number } | null>(null);

  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === activeId),
  );
  const active = items[activeIndex] ?? null;

  const focusCard = useCallback((id: string) => {
    requestAnimationFrame(() => {
      cardRefs.current.get(id)?.focus();
    });
  }, []);

  // When the active item leaves the queue (approved/rejected), move to the item now at its position.
  useEffect(() => {
    if (items.length === 0) return;
    if (activeId && items.some((item) => item.id === activeId)) return;
    const next = items[Math.min(lastIndex.current, items.length - 1)];
    if (!next) return;
    setActiveId(next.id);
    if (keyboardFocus.current) focusCard(next.id);
  }, [items, activeId, focusCard]);

  const move = (delta: number) => {
    if (items.length === 0) return;
    const nextIndex = Math.min(items.length - 1, Math.max(0, activeIndex + delta));
    const next = items[nextIndex];
    if (!next) return;
    lastIndex.current = nextIndex;
    setActiveId(next.id);
    focusCard(next.id);
  };

  const decide = (item: MemoryObjectView, action: 'approve' | 'reject') => {
    lastIndex.current = items.findIndex((i) => i.id === item.id);
    const remaining = items.length - 1;
    run(
      item.id,
      { action },
      {
        successMessage: null,
        onSuccess: () => {
          const verb = action === 'approve' ? 'Approved' : 'Rejected';
          announce(
            `${verb}. ${remaining === 0 ? 'All caught up.' : `${pluralize(remaining, 'item')} left.`}`,
          );
        },
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    // Leave "g then x" navigation sequences to the global shortcut handler.
    const previous = lastKey.current;
    lastKey.current = { key, at: Date.now() };
    if (previous?.key === 'g' && Date.now() - previous.at < SEQUENCE_PREFIX_MS) return;
    keyboardFocus.current = true;
    switch (key) {
      case 'j':
      case 'arrowdown':
        event.preventDefault();
        move(1);
        return;
      case 'k':
      case 'arrowup':
        event.preventDefault();
        move(-1);
        return;
      case 'a':
        if (!canEdit || !active) return;
        event.preventDefault();
        decide(active, 'approve');
        return;
      case 'r':
        if (!canEdit || !active) return;
        event.preventDefault();
        decide(active, 'reject');
        return;
      case 'e':
        if (!canEdit || !active) return;
        event.preventDefault();
        setEditing(active);
        return;
      case 'enter':
        if (!active || event.target !== cardRefs.current.get(active.id)) return;
        event.preventDefault();
        onOpenDetail(active.id);
        return;
      default:
        return;
    }
  };

  if (proposed.isPending) {
    return (
      <div aria-busy="true" className="grid gap-3">
        <span className="sr-only" role="status">
          Loading proposed memory…
        </span>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-40 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (proposed.isError) {
    return <ErrorState error={proposed.error} onRetry={() => void proposed.refetch()} />;
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon={CheckCheck}
        title="All caught up"
        description="Nothing is waiting for review. When Foundry Guide suggests something to remember, it appears here first — nothing is used until someone approves it."
      />
    );
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          {pluralize(items.length, 'suggestion')} to review
        </p>
        {canEdit ? (
          <p className="hidden items-center gap-3 text-xs text-muted-foreground md:flex" aria-hidden>
            <KbdGroup>
              <Kbd>J</Kbd>
              <Kbd>K</Kbd> move
            </KbdGroup>
            <KbdGroup>
              <Kbd>A</Kbd> approve
            </KbdGroup>
            <KbdGroup>
              <Kbd>R</Kbd> reject
            </KbdGroup>
            <KbdGroup>
              <Kbd>E</Kbd> edit
            </KbdGroup>
          </p>
        ) : null}
      </div>
      <div
        role="list"
        aria-label="Proposed memory"
        aria-describedby={canEdit ? 'proposed-queue-help' : undefined}
        onKeyDown={onKeyDown}
        className="grid gap-3"
      >
        <p id="proposed-queue-help" className="sr-only">
          Use J and K or the arrow keys to move between suggestions, A to approve, R to reject, E to edit, and
          Enter to open details.
        </p>
        {items.map((item, index) => {
          const isActive = index === activeIndex;
          return (
            <article
              key={item.id}
              role="listitem"
              ref={(node) => {
                if (node) cardRefs.current.set(item.id, node);
                else cardRefs.current.delete(item.id);
              }}
              tabIndex={isActive ? 0 : -1}
              aria-labelledby={`proposed-${item.id}-title`}
              aria-current={isActive ? 'true' : undefined}
              onFocus={(event) => {
                if (event.target === event.currentTarget) {
                  setActiveId(item.id);
                  lastIndex.current = index;
                }
              }}
              onClick={() => {
                setActiveId(item.id);
                lastIndex.current = index;
              }}
              className={cn(
                'rounded-xl border bg-card p-4 shadow-sm transition-[border-color,box-shadow] outline-none sm:p-5',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                isActive ? 'border-border-strong ring-1 ring-border-strong' : 'border-border',
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <MemoryTypeLabel type={item.type} />
                <ConfidenceMeter value={item.confidence} />
                <VisibilityLabel visibility={item.visibility} />
                <span className="ml-auto text-xs text-muted-foreground">
                  {formatRelative(item.createdAt)}
                </span>
              </div>
              <h3
                id={`proposed-${item.id}-title`}
                className="mt-2.5 text-[15px] leading-snug font-semibold tracking-tight [overflow-wrap:anywhere]"
              >
                {item.title}
              </h3>
              <Markdown size="sm" className="mt-1 text-muted-foreground">
                {displayContent(item)}
              </Markdown>
              {Object.keys(item.attributes).length > 0 ? (
                <div className="mt-3">
                  <MemoryAttributesList attributes={item.attributes} />
                </div>
              ) : null}
              <div className="mt-3 flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3">
                <div className="grid gap-1.5">
                  <OriginLabel origin={item.origin} />
                  <SourceRefList refs={item.sourceRefs} tenant={tenant} ventureId={ventureId} />
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {canEdit ? (
                    <>
                      <Button
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          decide(item, 'approve');
                        }}
                      >
                        <Check aria-hidden />
                        Approve
                        {isActive ? (
                          <Kbd
                            aria-hidden
                            className="ml-0.5 border-primary-foreground/30 bg-transparent text-primary-foreground/80"
                          >
                            A
                          </Kbd>
                        ) : null}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={(event) => {
                          event.stopPropagation();
                          decide(item, 'reject');
                        }}
                      >
                        <X aria-hidden />
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          setEditing(item);
                        }}
                      >
                        <Pencil aria-hidden />
                        Edit
                      </Button>
                    </>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenDetail(item.id);
                    }}
                  >
                    Details
                  </Button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      <CorrectMemoryDialog
        ventureId={ventureId}
        memory={editing}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            const id = editing?.id;
            setEditing(null);
            if (id && keyboardFocus.current) focusCard(id);
          }
        }}
      />
    </div>
  );
}
