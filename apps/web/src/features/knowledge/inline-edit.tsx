import { Pencil, X } from 'lucide-react';
import { useId, useRef, useState, type ReactNode, type Ref } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface InlineEditFormProps {
  value: string;
  /** Accessible name of the text box ("Edit note"). */
  label: string;
  maxLength: number;
  onSave: (next: string) => void;
  onCancel: () => void;
  /** Extra fields under the text (e.g. a due date). */
  children?: ReactNode;
  /** Whether the extra fields changed (so Save applies even when the text did not). */
  extraChanged?: boolean;
  rows?: number;
}

/**
 * Edits one line in place: Enter or Save keeps it, Shift+Enter adds a line break, Escape or Cancel
 * leaves it as it was. Saving unchanged text is the same as cancelling.
 */
export function InlineEditForm({
  value,
  label,
  maxLength,
  onSave,
  onCancel,
  children,
  extraChanged = false,
  rows = 2,
}: InlineEditFormProps) {
  const [draft, setDraft] = useState(value);
  const trimmed = draft.trim();
  const counterId = useId();

  const submit = () => {
    if (trimmed === '') return;
    if (trimmed === value.trim() && !extraChanged) {
      onCancel();
      return;
    }
    onSave(trimmed);
  };

  return (
    <form
      className="grid gap-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Textarea
        aria-label={label}
        aria-describedby={counterId}
        // Focus moves into the editor the person just opened.
        autoFocus
        value={draft}
        maxLength={maxLength}
        minRows={rows}
        maxRows={10}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {children}
      <div className="flex items-center justify-end gap-2">
        <span
          id={counterId}
          className={cn(
            'tabular mr-auto text-caption text-subtle-foreground',
            draft.length < maxLength * 0.9 && 'sr-only',
          )}
        >
          {draft.length}/{maxLength} characters
        </span>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={trimmed === ''}>
          Save
        </Button>
      </div>
    </form>
  );
}

/**
 * Edit and remove buttons for one line. On a mouse they appear with hover or keyboard focus, so a long
 * list stays calm; on touch screens they are always shown.
 */
export function LineActions({
  describedBy,
  onEdit,
  onRemove,
  editRef,
}: {
  /** Id of the line's text, so "Edit" and "Remove" are announced with it. */
  describedBy: string;
  onEdit: () => void;
  onRemove: () => void;
  editRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-0.5 transition-opacity duration-150',
        'pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100',
      )}
    >
      <Button
        ref={editRef}
        variant="ghost"
        size="icon-xs"
        aria-label="Edit"
        aria-describedby={describedBy}
        onClick={onEdit}
      >
        <Pencil aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Remove"
        aria-describedby={describedBy}
        onClick={onRemove}
      >
        <X aria-hidden />
      </Button>
    </div>
  );
}

/** Keeps a button to return focus to when an inline editor closes. */
export function useReturnFocus() {
  const ref = useRef<HTMLButtonElement | null>(null);
  const restore = () => {
    requestAnimationFrame(() => ref.current?.focus());
  };
  return { ref, restore };
}
