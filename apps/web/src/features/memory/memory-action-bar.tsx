import type { MemoryObjectView } from '@foundry/contracts';
import { Pencil, Pin, PinOff, Trash } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { useMemoryActions } from './api';
import { ConfirmDeleteMemoryDialog, CorrectMemoryDialog } from './memory-dialogs';
import { availableMemoryActions } from './optimistic';

interface MemoryActionBarProps {
  ventureId: string;
  memory: MemoryObjectView;
  /** Compact: small buttons (the side panel). */
  size?: 'sm' | 'default';
  className?: string;
  /** Called after Forget was confirmed (e.g. to close a detail panel). */
  onRemoved?: (() => void) | undefined;
  /** Replace the generic editor with a type-specific one. */
  onEdit?: (() => void) | undefined;
}

/**
 * What a person can do with something the vEIR knows: Edit (saved as a new version), Pin and Forget (asks
 * first). Nothing is approved or rejected: memory is kept automatically.
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
  const [dialog, setDialog] = useState<'edit' | 'forget' | null>(null);
  const actions = availableMemoryActions(memory);
  const busy = isPending && pendingId === memory.id;
  const buttonSize = size === 'sm' ? 'xs' : 'sm';

  if (actions.length === 0) return null;

  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {actions.includes('correct') ? (
        <Button
          size={buttonSize}
          variant="secondary"
          disabled={busy}
          onClick={() => {
            if (onEdit) onEdit();
            else setDialog('edit');
          }}
        >
          <Pencil aria-hidden />
          Edit
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
      {actions.includes('delete') ? (
        <Button
          size={buttonSize}
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setDialog('forget');
          }}
        >
          <Trash aria-hidden />
          Forget
        </Button>
      ) : null}

      <CorrectMemoryDialog
        ventureId={ventureId}
        memory={memory}
        open={dialog === 'edit'}
        onOpenChange={close}
      />
      <ConfirmDeleteMemoryDialog
        ventureId={ventureId}
        memory={memory}
        open={dialog === 'forget'}
        onOpenChange={close}
        onDone={onRemoved}
      />
    </div>
  );
}
