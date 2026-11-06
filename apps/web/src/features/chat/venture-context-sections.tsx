import {
  OPEN_ESCALATION_STATUSES,
  type DocumentView,
  type EscalationStatus,
  type MemoryObjectView,
  type SessionView,
} from '@foundry/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlarmClockOff, Check, FileText, Pencil, Phone } from 'lucide-react';
import { lazy, Suspense, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { StatusBadge } from '@/components/ui/status-badge';
import { toast } from '@/components/ui/toast';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useDocuments } from '@/lib/api/hooks/documents';
import { useVentureEscalations } from '@/lib/api/hooks/escalations';
import { useMemory } from '@/lib/api/hooks/memory';
import { sessionsQueryOptions } from '@/lib/api/hooks/sessions';
import { conversationTitle, lastActivity, listedInRecents } from '@/lib/conversations';
import { formatRelative, pluralize } from '@/lib/format';
import { ESCALATION_CATEGORY_LABELS, MEMORY_TYPE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { useMemoryActions } from '@/features/memory/api';

import { canActOnDue, doneAction, restoreAction, snoozeAction, SNOOZE_DAYS } from './due-actions';

/** Loaded the first time someone edits a memory from the panel (it carries the form). */
const CorrectMemoryDialog = lazy(() =>
  import('@/features/memory/memory-dialogs').then((m) => ({ default: m.CorrectMemoryDialog })),
);

const OPEN_ESCALATION: ReadonlySet<string> = new Set(OPEN_ESCALATION_STATUSES);

/** Where a request stands, in the founder's own short words (the Human help page has the full status). */
const HELP_STATE: Record<EscalationStatus, string> = {
  draft: 'Draft',
  awaiting_consent: 'Needs your OK',
  awaiting_assignment: 'Finding a person',
  routed: 'With a person',
  acknowledged: 'Seen',
  resolved: 'Answered',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

/** How many items a section lists before its link to the full page. */
export const MAX_ITEMS = 3;

export const QUIET_LINK =
  'rounded-sm text-small text-muted-foreground underline decoration-border-strong underline-offset-4 hover:text-foreground hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring';

export const ROW =
  'group flex min-h-9 w-full min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 text-left text-small transition-colors duration-(--dur-hover) hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11';

/** A row's small icon button (Done, Snooze, Edit): quiet until the row is hovered or focused; always shown on touch. */
const ROW_ACTION = cn(
  'relative flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-[color,background-color,opacity] duration-(--dur-hover)',
  'hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40',
  'opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100',
);

function RowAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <SimpleTooltip content={label}>
      <button
        type="button"
        aria-label={label}
        data-touch-target
        disabled={disabled}
        onClick={onClick}
        className={ROW_ACTION}
      >
        {children}
      </button>
    </SimpleTooltip>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-small text-muted-foreground">{children}</p>;
}

/** One line of an item list: the row (a link or a button) and, at its end, the row's own actions. */
export function ItemLine({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  return (
    <li className="group/row flex min-w-0 items-start gap-0.5">
      <div className="min-w-0 flex-1">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-0.5 pt-1">{actions}</div> : null}
    </li>
  );
}

/**
 * Done and Snooze for a due item: a correction of the item (it keeps its history), confirmed with an Undo that puts
 * it back as it was. Nothing to offer for a suggestion still waiting to be kept.
 */
export function DueActions({ ventureId, item }: { ventureId: string; item: MemoryObjectView }) {
  const { run, pendingId, isPending } = useMemoryActions(ventureId);
  if (!canActOnDue(item)) return null;
  const busy = isPending && pendingId === item.id;
  const undo = (changed: MemoryObjectView | null) => {
    if (!changed) return;
    run(changed.id, restoreAction(item), { successMessage: 'Put back' });
  };
  const act = (kind: 'done' | 'snooze') => {
    const action = kind === 'done' ? doneAction(item) : snoozeAction(item);
    if (!action) return;
    const message = kind === 'done' ? `Done: ${item.title}` : `Snoozed a week: ${item.title}`;
    run(item.id, action, {
      successMessage: null,
      onSuccess: (changed) => {
        toast.success(message, {
          action: {
            label: 'Undo',
            onClick: () => {
              undo(changed);
            },
          },
        });
      },
    });
  };
  return (
    <>
      <RowAction
        label={`Mark done: ${item.title}`}
        disabled={busy}
        onClick={() => {
          act('done');
        }}
      >
        <Check aria-hidden className="size-4" />
      </RowAction>
      <RowAction
        label={`Snooze ${String(SNOOZE_DAYS)} days: ${item.title}`}
        disabled={busy}
        onClick={() => {
          act('snooze');
        }}
      >
        <AlarmClockOff aria-hidden className="size-4" />
      </RowAction>
    </>
  );
}

/**
 * Open requests for human help, newest first, with the open conversation's own first (and its settled ones too, so
 * an answer there is seen); then how many more, and Ask a person.
 */
export function HelpSection({
  tenant,
  ventureId,
  sessionId,
  onAskPerson,
}: {
  tenant: string;
  ventureId: string;
  sessionId: string | undefined;
  onAskPerson: (() => void) | undefined;
}) {
  const escalations = useVentureEscalations(ventureId);
  const items = escalations.data ?? [];
  const relevant = items
    .filter((e) => OPEN_ESCALATION.has(e.status) || (sessionId !== undefined && e.sessionId === sessionId))
    .sort(
      (a, b) =>
        Number(b.sessionId === sessionId) - Number(a.sessionId === sessionId) ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
  const open = items.filter((e) => OPEN_ESCALATION.has(e.status)).length;
  const shown = relevant.slice(0, MAX_ITEMS);
  const more = relevant.length - shown.length;

  return (
    <CollapsibleSection id="help" title="Human help" meta={open > 0 ? open : undefined} metaLabel="open">
      {escalations.isPending ? (
        <Quiet>Loading…</Quiet>
      ) : shown.length > 0 ? (
        <ul aria-label="Requests for help" className="-mx-2 mb-2 grid gap-px">
          {shown.map((e) => (
            <li key={e.id}>
              <Link
                to="/$tenant/app/v/$ventureId/help"
                params={{ tenant, ventureId }}
                search={{ id: e.id }}
                className={cn(ROW, 'items-center justify-between')}
              >
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate">{ESCALATION_CATEGORY_LABELS[e.category]}</span>
                  <span className="text-caption text-muted-foreground">
                    {e.sessionId !== null && e.sessionId === sessionId ? 'From this conversation · ' : ''}
                    {formatRelative(e.updatedAt)}
                  </span>
                </span>
                <StatusBadge kind="escalationStatus" status={e.status} label={HELP_STATE[e.status]} />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {more > 0 ? (
          <Link to="/$tenant/app/v/$ventureId/help" params={{ tenant, ventureId }} className={QUIET_LINK}>
            {pluralize(more, 'more request')}
          </Link>
        ) : shown.length === 0 && !escalations.isPending ? (
          <Quiet>No open requests.</Quiet>
        ) : (
          <span />
        )}
        {onAskPerson ? (
          <Button size="xs" variant="secondary" onClick={onAskPerson}>
            Ask a person
          </Button>
        ) : null}
      </div>
    </CollapsibleSection>
  );
}

/** The venture's memory, most recently changed first (what the mentor learned last is what to check). */
const CURRENT_MEMORY: ReadonlySet<string> = new Set(['proposed', 'confirmed', 'disputed']);

function recentMemory(items: readonly MemoryObjectView[]): MemoryObjectView[] {
  return items
    .filter((m) => CURRENT_MEMORY.has(m.status))
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, MAX_ITEMS);
}

/**
 * The newest things remembered about the venture, each editable in place (the same Edit as Knowledge: saved as a new
 * version, the old one kept in its history), under how this conversation is kept (`header`).
 */
export function RecentMemory({
  tenant,
  ventureId,
  showLink,
}: {
  tenant: string;
  ventureId: string;
  /** "Review or correct memory" (left out of a private conversation, which keeps nothing). */
  showLink: boolean;
}) {
  const memory = useMemory(ventureId);
  const [editing, setEditing] = useState<MemoryObjectView | null>(null);
  const items = recentMemory(memory.data ?? []);
  return (
    <div className="grid gap-2">
      {items.length > 0 ? (
        <ul aria-label="Recently remembered" className="-mx-2 grid gap-px">
          {items.map((item) => {
            const type = MEMORY_TYPE_LABELS[item.type];
            const Icon = type.icon;
            return (
              <ItemLine
                key={item.id}
                actions={
                  <RowAction
                    label={`Edit memory: ${item.title}`}
                    onClick={() => {
                      setEditing(item);
                    }}
                  >
                    <Pencil aria-hidden className="size-3.5" />
                  </RowAction>
                }
              >
                <Link
                  to="/$tenant/app/v/$ventureId/knowledge"
                  params={{ tenant, ventureId }}
                  search={{ m: item.id }}
                  className={ROW}
                >
                  <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="line-clamp-2">{item.title}</span>
                    <span className="text-caption text-muted-foreground">
                      {type.label} · {formatRelative(item.updatedAt)}
                    </span>
                  </span>
                </Link>
              </ItemLine>
            );
          })}
        </ul>
      ) : memory.isPending ? null : (
        <Quiet>Nothing remembered yet.</Quiet>
      )}
      {showLink ? (
        <Link
          to="/$tenant/app/v/$ventureId/knowledge"
          params={{ tenant, ventureId }}
          className={cn(QUIET_LINK, 'justify-self-start')}
        >
          Review or correct memory
        </Link>
      ) : null}
      {editing ? (
        <Suspense fallback={null}>
          <CorrectMemoryDialog
            ventureId={ventureId}
            memory={editing}
            open
            onOpenChange={(open) => {
              if (!open) setEditing(null);
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

function newestDocuments(items: readonly DocumentView[]): DocumentView[] {
  return items
    .filter((doc) => doc.status === 'ready' || doc.status === 'processing' || doc.status === 'failed')
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

const DOCUMENT_STATE: Partial<Record<DocumentView['status'], string>> = {
  processing: 'Processing',
  failed: 'Couldn’t be read',
};

/** The venture's newest documents, each opening in the viewer over the page; then the Documents page. */
export function DocumentsSection({ tenant, ventureId }: { tenant: string; ventureId: string }) {
  const documents = useDocuments(ventureId);
  const items = newestDocuments(documents.data ?? []);
  return (
    <CollapsibleSection id="documents" title="Documents" meta={items.length > 0 ? items.length : undefined}>
      {items.length > 0 ? (
        <ul aria-label="Venture documents" className="-mx-2 mb-1.5 grid gap-px">
          {items.slice(0, MAX_ITEMS).map((doc) => (
            <li key={doc.id}>
              <Link
                to="."
                search={(previous) => ({ ...previous, doc: doc.id, src: undefined, passage: undefined })}
                state={(previous) => ({ ...previous, documentViewer: true })}
                resetScroll={false}
                data-opens-document
                title={doc.filename}
                className={ROW}
              >
                <FileText aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate">{doc.filename}</span>
                  <span className="text-caption text-muted-foreground">
                    {DOCUMENT_STATE[doc.status] ?? `Added ${formatRelative(doc.createdAt)}`}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : documents.isPending ? null : (
        <Quiet>No documents yet.</Quiet>
      )}
      <Link to="/$tenant/app/v/$ventureId/documents" params={{ tenant, ventureId }} className={QUIET_LINK}>
        {items.length > MAX_ITEMS ? `All ${String(items.length)} documents` : 'Open Documents'}
      </Link>
    </CollapsibleSection>
  );
}

function withCalls(items: readonly SessionView[]): SessionView[] {
  return items
    .filter((session) => session.hasCalls && listedInRecents(session))
    .slice()
    .sort((a, b) => lastActivity(b) - lastActivity(a));
}

/** The venture's conversations that held a call, newest first, each opening the conversation (and its summary). */
export function CallsSection({
  tenant,
  ventureId,
  sessionId,
}: {
  tenant: string;
  ventureId: string;
  sessionId: string | undefined;
}) {
  const sessions = useQuery({ ...sessionsQueryOptions(ventureId), select: (data) => withCalls(data.items) });
  const items = sessions.data ?? [];
  return (
    <CollapsibleSection id="calls" title="Calls" meta={items.length > 0 ? items.length : undefined}>
      {items.length > 0 ? (
        <ul aria-label="Recent calls" className="-mx-2 grid gap-px">
          {items.slice(0, MAX_ITEMS).map((session) => (
            <li key={session.id}>
              <Link
                to="/$tenant/app/v/$ventureId/c/$sessionId"
                params={{ tenant, ventureId, sessionId: session.id }}
                aria-current={session.id === sessionId ? 'page' : undefined}
                className={ROW}
              >
                <Phone aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate">{conversationTitle(session)}</span>
                  <span className="text-caption text-muted-foreground">
                    {session.id === sessionId ? 'This conversation · ' : ''}
                    {formatRelative(lastActivity(session))}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : sessions.isPending ? null : (
        <Quiet>No calls yet.</Quiet>
      )}
    </CollapsibleSection>
  );
}
