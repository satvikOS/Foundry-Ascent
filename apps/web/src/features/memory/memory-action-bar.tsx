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
import { cn } from '@/lib/utils';

import { useMemoryActions } from './api';
import { ConfirmMemoryActionDialog, CorrectMemoryDialog, DisputeMemoryDialog } from './memory-dialogs';
import { availableMemoryActions } from './optimistic';

interface MemoryActionBarProps {
  ventureId: string;
  memory: MemoryObjectView;
  /** Compact: primary actions as small buttons, the rest in a menu. */
  size?: 'sm' | 'default';
  className?: string;
  /** Called after a delete/reject was confirmed (e.g. to close a detail panel). */
  onRemoved?: () => void;
  /** Replace the generic correction dialog with a type-specific editor. */
  onEdit?: () => void;
}

/**
 * Lifecycle actions for one memory object: approve / reject for proposals, correct / pin / dispute /
 * delete for confirmed memory. Destructive or lossy actions ask for confirmation; reversible ones
 * (pin, approve) apply optimistically.
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
  const [dialog, setDialog] = useState<'correct' | 'dispute' | 'delete' | 'reject' | null>(null);
  const actions = availableMemoryActions(memory);
  const busy = isPending && pendingId === memory.id;
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
            run(memory.id, { action: 'approve' });
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
            setDialog('reject');
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
      <ConfirmMemoryActionDialog
        ventureId={ventureId}
        memory={memory}
        action={dialog === 'reject' ? 'reject' : 'delete'}
        open={dialog === 'delete' || dialog === 'reject'}
        onOpenChange={close}
        onDone={onRemoved}
      />
    </div>
  );
}
