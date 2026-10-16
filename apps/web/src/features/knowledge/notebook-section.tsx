import type {
  CommitmentStatus,
  NotebookCommitment,
  NotebookEdit,
  NotebookEntry,
  NotebookSection,
} from '@foundry/contracts';
import { NotebookPen } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { Alert } from '@/components/ui/alert';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { HairlineSkeleton } from '@/components/ui/page-section';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useNotebook } from '@/lib/api/hooks/notebook';
import { formatDateTime, formatRelative, isoString } from '@/lib/format';
import { cn } from '@/lib/utils';
import { daysUntil, formatIsoDate } from '@/features/memory/typed/attributes';
import { sentenceStart, useVeirAuthor } from '@/features/venture/veir-name';

import { InlineEditForm, LineActions, useReturnFocus } from './inline-edit';
import { isNotebookConflict, useNotebookEdit } from './notebook-api';
import { isNotebookEmpty } from './notebook-edit';

/** Limits of the notebook contract (`NotebookEdit` in @foundry/contracts). */
const LIMITS = { summary: 1200, entry: 400, commitment: 300, opener: 300 } as const;

/** Note groups after the commitments ("About you" leads, before them). */
const LATER_GROUPS: { section: Exclude<NotebookSection, 'founderProfile'>; title: string }[] = [
  { section: 'openQuestions', title: 'Open questions' },
  { section: 'lastAdvice', title: 'Last advice' },
];

const COMMITMENT_STATUS_LABEL: Record<CommitmentStatus, string> = {
  open: 'Open',
  done: 'Done',
  dropped: 'Dropped',
};

interface NotebookEditorProps {
  ventureId: string;
  /** The vEIR's short name ("Corin", or "your vEIR"). */
  veirName: string;
  /** Founders and the team edit; the assigned EIR reads. */
  canEdit: boolean;
}

/**
 * "What <vEIR> knows": the notebook the vEIR keeps about the founder and venture, written after each
 * conversation. Every line is an AI note: shown to the team, correctable or removable in place, never a
 * fact. Edits carry the version they were made against; when the notebook changed meanwhile it is
 * reloaded and the person is told.
 */
export function NotebookEditor({ ventureId, veirName, canEdit }: NotebookEditorProps) {
  const notebook = useNotebook(ventureId);
  const edit = useNotebookEdit(ventureId);
  const author = useVeirAuthor(ventureId);
  const [confirmClear, setConfirmClear] = useState(false);

  if (notebook.isPending) return <HairlineSkeleton rows={4} label="Loading the notebook…" />;
  if (notebook.isError) {
    return <ErrorState error={notebook.error} onRetry={() => void notebook.refetch()} headingLevel={2} />;
  }
  if (notebook.data === null) {
    return (
      <EmptyState
        icon={NotebookPen}
        headingLevel={2}
        title="The notebook isn’t shared with you"
        description="Only the venture team and its EIR can read it."
      />
    );
  }

  const data = notebook.data;
  const save = (change: NotebookEdit) => {
    edit.mutate(change);
  };
  const empty = isNotebookEmpty(data);

  return (
    <div className="grid gap-8">
      <div className="flex items-start gap-4">
        <PersonaAvatar name={veirName} size="lg" decorative className="mt-1 hidden sm:inline-flex" />
        <div className="grid min-w-0 flex-1 gap-1.5">
          <p className="label-mono">AI notes</p>
          <h2 className="font-serif text-subheading font-normal">What {veirName} knows</h2>
          <p className="max-w-[60ch] text-small text-muted-foreground">
            Notes {author} keeps from your conversations. Your team can see and correct them. They’re never
            treated as facts.
          </p>
          {data.updatedAt ? (
            <p className="text-caption text-subtle-foreground">
              {data.lastEditedBy === 'person' ? 'Edited by your team' : `Updated by ${author}`}{' '}
              <time dateTime={isoString(data.updatedAt)} title={formatDateTime(data.updatedAt)}>
                {formatRelative(data.updatedAt)}
              </time>
            </p>
          ) : null}
        </div>
      </div>

      {isNotebookConflict(edit.error) ? (
        <Alert
          variant="warning"
          live="alert"
          title="The notebook changed"
          action={
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                edit.reset();
              }}
            >
              Dismiss
            </Button>
          }
        >
          It was updated while you were editing, so your change wasn’t saved. It’s been reloaded: check it and
          try again.
        </Alert>
      ) : null}

      {empty ? (
        <EmptyState
          icon={NotebookPen}
          headingLevel={3}
          title="Nothing noted yet"
          description={`After a conversation, ${author} notes what you’re working on, your commitments and open questions. You can correct any of it here.`}
        />
      ) : (
        <div className="grid gap-7">
          {data.summary.trim() !== '' ? (
            <SummaryBlock
              summary={data.summary}
              canEdit={canEdit}
              onSave={(summary) => {
                save({ action: 'edit_summary', summary });
              }}
              onRemove={() => {
                save({ action: 'edit_summary', summary: '' });
              }}
            />
          ) : null}

          <EntryGroup
            title="About you"
            entries={data.founderProfile}
            canEdit={canEdit}
            onSave={(id, text) => {
              save({ action: 'edit_entry', section: 'founderProfile', id, text });
            }}
            onRemove={(id) => {
              save({ action: 'remove_entry', section: 'founderProfile', id });
            }}
          />

          <CommitmentGroup
            commitments={data.commitments}
            canEdit={canEdit}
            onChange={(id, change) => {
              save({ action: 'edit_commitment', id, ...change });
            }}
            onRemove={(id) => {
              save({ action: 'remove_commitment', id });
            }}
          />

          {LATER_GROUPS.map((group) => (
            <EntryGroup
              key={group.section}
              title={group.title}
              entries={data[group.section]}
              canEdit={canEdit}
              onSave={(id, text) => {
                save({ action: 'edit_entry', section: group.section, id, text });
              }}
              onRemove={(id) => {
                save({ action: 'remove_entry', section: group.section, id });
              }}
            />
          ))}

          {data.nextOpener ? (
            <OpenerBlock
              opener={data.nextOpener}
              author={author}
              canEdit={canEdit}
              onSave={(text) => {
                save({ action: 'edit_opener', text });
              }}
              onRemove={() => {
                save({ action: 'remove_opener' });
              }}
            />
          ) : null}

          {canEdit ? (
            <div className="border-t border-border pt-4">
              <Button
                variant="ghost"
                size="sm"
                className="-ml-3 text-muted-foreground"
                onClick={() => {
                  setConfirmClear(true);
                }}
              >
                Clear notebook
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear the notebook?</AlertDialogTitle>
            <AlertDialogDescription>
              Every note goes, and {author} won’t write the same notes back. Conversations, memory and
              documents stay as they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmClear(false);
                save({ action: 'clear' });
              }}
            >
              Clear notebook
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** A titled group of notebook lines (a landmark region named by its title). */
function Group({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="grid gap-1">
      <h3 id={headingId} className="label-mono">
        {title}
      </h3>
      {children}
    </section>
  );
}

function SummaryBlock({
  summary,
  canEdit,
  onSave,
  onRemove,
}: {
  summary: string;
  canEdit: boolean;
  onSave: (summary: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const focus = useReturnFocus();
  const textId = useId();
  const close = () => {
    setEditing(false);
    focus.restore();
  };
  return (
    <Group title="Summary">
      {editing ? (
        <InlineEditForm
          value={summary}
          label="Edit summary"
          maxLength={LIMITS.summary}
          rows={4}
          onCancel={close}
          onSave={(next) => {
            onSave(next);
            close();
          }}
        />
      ) : (
        <div className="group flex items-start gap-3">
          <p id={textId} className="prose-reading min-w-0 flex-1 text-pretty">
            {summary}
          </p>
          {canEdit ? (
            <LineActions
              describedBy={textId}
              editRef={focus.ref}
              onEdit={() => {
                setEditing(true);
              }}
              onRemove={onRemove}
            />
          ) : null}
        </div>
      )}
    </Group>
  );
}

function EntryGroup({
  title,
  entries,
  canEdit,
  onSave,
  onRemove,
}: {
  title: string;
  entries: readonly NotebookEntry[];
  canEdit: boolean;
  onSave: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <Group title={title}>
      <ul className="divide-y divide-border">
        {entries.map((entry) => (
          <EntryLine key={entry.id} entry={entry} canEdit={canEdit} onSave={onSave} onRemove={onRemove} />
        ))}
      </ul>
    </Group>
  );
}

function EntryLine({
  entry,
  canEdit,
  onSave,
  onRemove,
}: {
  entry: NotebookEntry;
  canEdit: boolean;
  onSave: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const focus = useReturnFocus();
  const textId = useId();
  const close = () => {
    setEditing(false);
    focus.restore();
  };
  return (
    <li className="group py-2.5">
      {editing ? (
        <InlineEditForm
          value={entry.text}
          label="Edit note"
          maxLength={LIMITS.entry}
          onCancel={close}
          onSave={(next) => {
            onSave(entry.id, next);
            close();
          }}
        />
      ) : (
        <div className="flex items-start gap-3">
          <p id={textId} className="min-w-0 flex-1 text-body text-pretty">
            {entry.text}
          </p>
          {canEdit ? (
            <LineActions
              describedBy={textId}
              editRef={focus.ref}
              onEdit={() => {
                setEditing(true);
              }}
              onRemove={() => {
                onRemove(entry.id);
              }}
            />
          ) : null}
        </div>
      )}
    </li>
  );
}

interface CommitmentChange {
  text?: string;
  due?: string | null;
  status?: CommitmentStatus;
}

function CommitmentGroup({
  commitments,
  canEdit,
  onChange,
  onRemove,
}: {
  commitments: readonly NotebookCommitment[];
  canEdit: boolean;
  onChange: (id: string, change: CommitmentChange) => void;
  onRemove: (id: string) => void;
}) {
  if (commitments.length === 0) return null;
  return (
    <Group title="Commitments">
      <ul className="divide-y divide-border">
        {commitments.map((commitment) => (
          <CommitmentLine
            key={commitment.id}
            commitment={commitment}
            canEdit={canEdit}
            onChange={onChange}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </Group>
  );
}

function dueText(commitment: NotebookCommitment): { text: string; overdue: boolean } | null {
  if (!commitment.due) return null;
  const days = daysUntil(commitment.due);
  const overdue = commitment.status === 'open' && days < 0;
  return { text: `${overdue ? 'Was due' : 'Due'} ${formatIsoDate(commitment.due)}`, overdue };
}

function CommitmentLine({
  commitment,
  canEdit,
  onChange,
  onRemove,
}: {
  commitment: NotebookCommitment;
  canEdit: boolean;
  onChange: (id: string, change: CommitmentChange) => void;
  onRemove: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [due, setDue] = useState(commitment.due ?? '');
  const [status, setStatus] = useState<CommitmentStatus>(commitment.status);
  const focus = useReturnFocus();
  const textId = useId();
  const dueId = useId();
  const statusId = useId();
  const doneId = useId();
  const close = () => {
    setEditing(false);
    focus.restore();
  };
  const open = () => {
    setDue(commitment.due ?? '');
    setStatus(commitment.status);
    setEditing(true);
  };
  const dueValue = due === '' ? null : due;
  const extraChanged = dueValue !== commitment.due || status !== commitment.status;
  const deadline = dueText(commitment);
  const closed = commitment.status !== 'open';

  if (editing) {
    return (
      <li className="py-2.5">
        <InlineEditForm
          value={commitment.text}
          label="Edit commitment"
          maxLength={LIMITS.commitment}
          extraChanged={extraChanged}
          onCancel={close}
          onSave={(text) => {
            const change: CommitmentChange = {};
            if (text !== commitment.text) change.text = text;
            if (dueValue !== commitment.due) change.due = dueValue;
            if (status !== commitment.status) change.status = status;
            onChange(commitment.id, change);
            close();
          }}
        >
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={dueId} className="text-caption text-muted-foreground">
                Due
              </Label>
              <Input
                id={dueId}
                type="date"
                value={due}
                className="w-44"
                onChange={(event) => {
                  setDue(event.target.value);
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={statusId} className="text-caption text-muted-foreground">
                Status
              </Label>
              <Select
                value={status}
                onValueChange={(value) => {
                  setStatus(value as CommitmentStatus);
                }}
              >
                <SelectTrigger id={statusId} className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(COMMITMENT_STATUS_LABEL) as CommitmentStatus[]).map((value) => (
                    <SelectItem key={value} value={value}>
                      {COMMITMENT_STATUS_LABEL[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </InlineEditForm>
      </li>
    );
  }

  return (
    <li className="group flex items-start gap-3 py-2.5">
      {canEdit && commitment.status !== 'dropped' ? (
        <Checkbox
          id={doneId}
          className="mt-1"
          checked={commitment.status === 'done'}
          aria-label="Done"
          aria-describedby={textId}
          onCheckedChange={(checked) => {
            onChange(commitment.id, { status: checked === true ? 'done' : 'open' });
          }}
        />
      ) : null}
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p
          id={textId}
          className={cn(
            'text-body text-pretty',
            closed && 'text-muted-foreground',
            commitment.status === 'done' && 'line-through decoration-border-strong',
          )}
        >
          {commitment.text}
        </p>
        {deadline || closed ? (
          <p className="text-caption text-subtle-foreground">
            {closed ? COMMITMENT_STATUS_LABEL[commitment.status] : null}
            {closed && deadline ? ' · ' : null}
            {deadline ? (
              <span className={cn(deadline.overdue && 'font-medium text-warning')}>{deadline.text}</span>
            ) : null}
          </p>
        ) : null}
      </div>
      {canEdit ? (
        <LineActions
          describedBy={textId}
          editRef={focus.ref}
          onEdit={open}
          onRemove={() => {
            onRemove(commitment.id);
          }}
        />
      ) : null}
    </li>
  );
}

function OpenerBlock({
  opener,
  author,
  canEdit,
  onSave,
  onRemove,
}: {
  opener: string;
  /** Who writes the opening line ("Corin’s vEIR"). */
  author: string;
  canEdit: boolean;
  onSave: (text: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const focus = useReturnFocus();
  const textId = useId();
  const close = () => {
    setEditing(false);
    focus.restore();
  };
  return (
    <Group title="Next conversation">
      <p className="text-small text-muted-foreground">{sentenceStart(author)} may open with:</p>
      {editing ? (
        <InlineEditForm
          value={opener}
          label="Edit opening line"
          maxLength={LIMITS.opener}
          onCancel={close}
          onSave={(next) => {
            onSave(next);
            close();
          }}
        />
      ) : (
        <div className="group flex items-start gap-3">
          <blockquote
            id={textId}
            className="prose-reading min-w-0 flex-1 border-l-2 border-border-strong pl-4 italic"
          >
            {opener}
          </blockquote>
          {canEdit ? (
            <LineActions
              describedBy={textId}
              editRef={focus.ref}
              onEdit={() => {
                setEditing(true);
              }}
              onRemove={onRemove}
            />
          ) : null}
        </div>
      )}
    </Group>
  );
}
