import type { MemoryObjectView } from '@foundry/contracts';
import { Check, MoreHorizontal, Pencil, Pin, PinOff, Trash, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { announce } from '@/components/a11y/live-announcer';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/utils';
import { reviewMessage, useMemoryReview, type ReviewAction } from '@/features/knowledge/review-api';

import { useMemoryActions } from './api';
import { ConfirmDeleteMemoryDialog, CorrectMemoryDialog, DisputeMemoryDialog } from './memory-dialogs';
import { availableMemoryActions } from './optimistic';

interface MemoryActionBarProps {
  ventureId: string;
  memory: MemoryObjectView;
  /** Compact: primary actions as small buttons, the rest in a menu. */
  size?: 'sm' | 'default';
  className?: string;
  /** Called after a delete was confirmed (e.g. to close a detail panel). */
  onRemoved?: (() => void) | undefined;
  /** Replace the generic correction dialog with a type-specific editor. */
  onEdit?: (() => void) | undefined;
}

/**
 * Lifecycle actions for one memory object: approve / reject for proposals (the same review path as the
 * "To review" queue), correct / pin / dispute / delete for kept memory. Deleting asks for confirmation;
 * everything else applies at once.
 */
export function MemoryActionBar({
  ventureId,
  memory,
  size = 'default',
  className,
  onRemoved,
  onEdit,
}: MemoryActionBarProps) {
  const { run, isPending, pendingId } = useMemoryActions(ventureId);
  const review = useMemoryReview(ventureId);
  const [dialog, setDialog] = useState<'correct' | 'dispute' | 'delete' | null>(null);
  const actions = availableMemoryActions(memory);
  const busy =
    (isPending && pendingId === memory.id) ||
    (review.isPending && review.variables.ids.includes(memory.id));

  const decide = (action: ReviewAction) => {
    review.mutate(
      { ids: [memory.id], action },
      {
        onSuccess: (result) => {
          const message = reviewMessage(action, result);
          toast.success(message);
          announce(message);
        },
        onError: (error) => {
          toast.error('Couldn’t update memory', { description: errorMessage(error) });
        },
      },
    );
  };
  const buttonSize = size === 'sm' ? 'xs' : 'sm';

  if (actions.length === 0) return null;

  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {actions.includes('approve') ? (
        <Button
          size={buttonSize}
          disabled={busy}
          onClick={() => {
            decide('approve');
          }}
        >
          <Check aria-hidden />
          Approve
        </Button>
      ) : null}
      {actions.includes('reject') ? (
        <Button
          size={buttonSize}
          variant="secondary"
          disabled={busy}
          onClick={() => {
            decide('reject');
          }}
        >
          <X aria-hidden />
          Reject
        </Button>
      ) : null}
      {actions.includes('correct') ? (
        <Button
          size={buttonSize}
          variant="secondary"
          disabled={busy}
          onClick={() => {
            if (onEdit) onEdit();
            else setDialog('correct');
          }}
        >
          <Pencil aria-hidden />
          {memory.status === 'proposed' || onEdit ? 'Edit' : 'Correct'}
        </Button>
      ) : null}
      {actions.includes('pin') || actions.includes('unpin') ? (
        <Button
          size={buttonSize}
          variant="ghost"
          disabled={busy}
          aria-pressed={memory.pinned}
          onClick={() => {
            run(memory.id, { action: memory.pinned ? 'unpin' : 'pin' });
          }}
        >
          {memory.pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
          {memory.pinned ? 'Unpin' : 'Pin'}
        </Button>
      ) : null}
      {actions.includes('dispute') || actions.includes('delete') ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size={size === 'sm' ? 'icon-xs' : 'icon-sm'}
              variant="ghost"
              aria-label="More memory actions"
              disabled={busy}
            >
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {actions.includes('dispute') ? (
              <DropdownMenuItem
                onSelect={() => {
                  setDialog('dispute');
                }}
              >
                <TriangleAlert aria-hidden />
                Dispute…
              </DropdownMenuItem>
            ) : null}
            {actions.includes('dispute') && actions.includes('delete') ? <DropdownMenuSeparator /> : null}
            {actions.includes('delete') ? (
              <DropdownMenuItem
                destructive
                onSelect={() => {
                  setDialog('delete');
                }}
              >
                <Trash aria-hidden />
                Delete…
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <CorrectMemoryDialog
        ventureId={ventureId}
        memory={memory}
        open={dialog === 'correct'}
        onOpenChange={close}
      />
      <DisputeMemoryDialog
        ventureId={ventureId}
        memory={memory}
        open={dialog === 'dispute'}
        onOpenChange={close}
      />
      <ConfirmDeleteMemoryDialog
        ventureId={ventureId}
        memory={memory}
        open={dialog === 'delete'}
        onOpenChange={close}
        onDone={onRemoved}
      />
    </div>
  );
}
