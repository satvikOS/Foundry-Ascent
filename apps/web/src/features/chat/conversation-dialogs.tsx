import { UpdateSessionRequest, type SessionView } from '@foundry/contracts';
import { useEffect, useId, useState } from 'react';

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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api/errors';
import { useDeleteSession, useRenameSession } from '@/lib/api/hooks/sessions';

const TITLE_MAX = UpdateSessionRequest.shape.title.unwrap().maxLength ?? 120;

/** Rename a conversation (used from its header menu and from the sidebar's recents). */
export function RenameConversationDialog({
  session,
  currentTitle,
  open,
  onOpenChange,
}: {
  session: Pick<SessionView, 'id'> | null;
  currentTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const inputId = useId();
  const rename = useRenameSession();
  const [title, setTitle] = useState(currentTitle);
  useEffect(() => {
    if (open) setTitle(currentTitle);
  }, [open, currentTitle]);
  const value = title.trim();

  const save = () => {
    if (!session || !value) return;
    rename.mutate(
      { sessionId: session.id, title: value },
      {
        onSuccess: () => {
          onOpenChange(false);
          announce('Conversation renamed');
        },
        onError: (error) => {
          toast.error('Couldn’t rename the conversation', { description: errorMessage(error) });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
            <DialogDescription className="sr-only">Give this conversation a new title.</DialogDescription>
          </DialogHeader>
          <label htmlFor={inputId} className="sr-only">
            Title
          </label>
          <Input
            id={inputId}
            value={title}
            maxLength={TITLE_MAX}
            autoFocus
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!value} loading={rename.isPending} loadingText="Saving…">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What deleting a conversation erases, as the server does it (`app.erase_drawn_from_session`): its messages and
 * summary, and memory the vEIR drew only from it that nobody touched since. Memory a person edited or kept is
 * theirs now, and stays.
 */
export const DELETE_CONVERSATION_DESCRIPTION =
  'Erases its messages, summary and anything remembered only from it. Memory you edited stays. This can’t be undone.';

/** Delete a conversation after confirming: its content is erased and it leaves every list. */
export function DeleteConversationDialog({
  session,
  open,
  onOpenChange,
  onDeleted,
}: {
  session: Pick<SessionView, 'id' | 'ventureId'> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const remove = useDeleteSession();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
          <AlertDialogDescription>{DELETE_CONVERSATION_DESCRIPTION}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            loading={remove.isPending}
            loadingText="Deleting…"
            onClick={() => {
              if (!session) return;
              remove.mutate(session, {
                onSuccess: () => {
                  onOpenChange(false);
                  toast.success('Conversation deleted');
                  onDeleted?.();
                },
                onError: (error) => {
                  toast.error('Couldn’t delete the conversation', { description: errorMessage(error) });
                },
              });
            }}
          >
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
