import {
  OPEN_ESCALATION_STATUSES,
  type EscalationView,
  type MemoryObjectView,
  type NotebookEntry,
  type SessionView,
  type TurnView,
} from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api/errors';
import { useVentureEscalations } from '@/lib/api/hooks/escalations';
import { useMemory } from '@/lib/api/hooks/memory';
import { useBatchMemoryAction } from '@/lib/api/hooks/memory-batch';
import { useNotebook } from '@/lib/api/hooks/notebook';
import { formatRelative, pluralize } from '@/lib/format';
import { ESCALATION_CATEGORY_LABELS } from '@/lib/labels';
import { useMemoryActions } from '@/features/memory/api';
import { MemoryTypeLabel } from '@/features/memory/memory-meta';
import { formatIsoDate } from '@/features/memory/typed/attributes';

import { EvidenceItemCard } from '../coach/evidence-item';
import { usePanelState, type PanelTab } from './panel-state';

const OPEN_ESCALATION: ReadonlySet<string> = new Set(OPEN_ESCALATION_STATUSES);

interface ContextPanelProps {
  session: SessionView;
  turns: TurnView[];
  personaName: string;
  tenant: string;
  ventureId: string;
  onAskPerson?: (() => void) | undefined;
}

/** The conversation's right panel: Sources · Notebook · To review · Human help. */
export function ContextPanel({
  session,
  turns,
  personaName,
  tenant,
  ventureId,
  onAskPerson,
}: ContextPanelProps) {
  const { tab, setTab } = usePanelState();
  const proposed = useMemory(ventureId, { status: 'proposed' });
  const pending = proposed.data?.length ?? 0;
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        setTab(value as PanelTab);
      }}
      className="gap-0"
    >
      <div className="sticky top-0 z-10 border-b border-border bg-card px-4">
        <TabsList
          variant="underline"
          className="h-11 gap-4 overflow-x-auto border-b-0 [scrollbar-width:none]"
        >
          <TabsTrigger value="sources">Sources</TabsTrigger>
          <TabsTrigger value="notebook">Notebook</TabsTrigger>
          <TabsTrigger value="review">
            To review
            {pending > 0 ? (
              <span className="tabular text-subtle-foreground">
                {pending}
                <span className="sr-only"> waiting</span>
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="help">Human help</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="sources">
        <SourcesTab turns={turns} personaName={personaName} />
      </TabsContent>
      <TabsContent value="notebook">
        <NotebookTab personaName={personaName} tenant={tenant} ventureId={ventureId} />
      </TabsContent>
      <TabsContent value="review">
        <ReviewTab tenant={tenant} ventureId={ventureId} items={proposed.data} query={proposed} />
      </TabsContent>
      <TabsContent value="help">
        <HelpTab session={session} tenant={tenant} ventureId={ventureId} onAskPerson={onAskPerson} />
      </TabsContent>
    </Tabs>
  );
}

function PanelBody({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 px-4 py-4">{children}</div>;
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-small text-muted-foreground">{children}</p>;
}

function Loading() {
  return (
    <div aria-busy="true" className="grid gap-2 px-4 py-4">
      <span className="sr-only" role="status">
        Loading…
      </span>
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  );
}

function Failed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="px-4 py-4">
      <ErrorState error={error} onRetry={onRetry} size="sm" headingLevel={3} />
    </div>
  );
}

function SourcesTab({ turns, personaName }: { turns: TurnView[]; personaName: string }) {
  const { selectedTurnId, focused, showSources } = usePanelState();
  const answered = turns.filter((t) => t.status === 'completed');
  const turn = answered.find((t) => t.id === selectedTurnId) ?? answered[answered.length - 1] ?? null;
  const refs = useRef(new Map<string, HTMLElement>());
  const handledNonce = useRef(0);

  useEffect(() => {
    // Focus once per chip activation; later re-renders (refetches) must not steal focus again.
    if (!focused?.key || focused.turnId !== turn?.id || focused.nonce === handledNonce.current) return;
    const key = focused.key;
    const nonce = focused.nonce;
    let frame = 0;
    let attempts = 0;
    // The panel (column or mobile sheet) may still be mounting: retry for a few frames, then bring the
    // source into view and focus it.
    const tryFocus = () => {
      const el = refs.current.get(key);
      if (!el?.isConnected) {
        if (attempts++ < 20) frame = requestAnimationFrame(tryFocus);
        return;
      }
      handledNonce.current = nonce;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
      el.focus({ preventScroll: true });
    };
    frame = requestAnimationFrame(tryFocus);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [focused, turn]);

  if (!turn) {
    return (
      <PanelBody>
        <Quiet>Sources appear here once {personaName} answers.</Quiet>
      </PanelBody>
    );
  }

  return (
    <PanelBody>
      {answered.length > 1 ? (
        <Select
          value={turn.id}
          onValueChange={(id) => {
            showSources(id);
          }}
        >
          <SelectTrigger size="sm" className="w-full" aria-label="Show sources for answer">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {answered.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                Answer {t.ordinal}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {turn.evidence.length === 0 ? (
        <Quiet>
          No sources for this answer. Treat it as general guidance, not evidence about your venture.
        </Quiet>
      ) : (
        <ul className="grid gap-2" aria-label={`Sources for answer ${turn.ordinal}`}>
          {turn.evidence.map((item) => (
            <li key={item.key}>
              <EvidenceItemCard
                item={item}
                highlighted={focused?.turnId === turn.id && focused.key === item.key}
                ref={(node) => {
                  if (node) refs.current.set(item.key, node);
                  else refs.current.delete(item.key);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </PanelBody>
  );
}

function NotebookList({ title, entries }: { title: string; entries: readonly NotebookEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <section className="grid gap-1.5">
      <h3 className="label-mono">{title}</h3>
      <ul className="grid gap-1.5 text-small leading-6">
        {entries.map((entry) => (
          <li key={entry.id}>{entry.text}</li>
        ))}
      </ul>
    </section>
  );
}

/** "What {vEIR} knows": the notebook, read-only here; it is edited on the Knowledge page. */
function NotebookTab({
  personaName,
  tenant,
  ventureId,
}: {
  personaName: string;
  tenant: string;
  ventureId: string;
}) {
  const notebook = useNotebook(ventureId);
  if (notebook.isPending) return <Loading />;
  if (notebook.isError) return <Failed error={notebook.error} onRetry={() => void notebook.refetch()} />;
  const data = notebook.data;
  const commitments = (data?.commitments ?? []).filter((c) => c.status === 'open');
  const empty =
    !data ||
    (!data.summary.trim() &&
      commitments.length === 0 &&
      data.founderProfile.length === 0 &&
      data.openQuestions.length === 0 &&
      data.lastAdvice.length === 0);

  return (
    <PanelBody>
      <div className="grid gap-1">
        <h2 className="font-serif text-subheading">What {personaName} knows</h2>
        <p className="text-caption text-muted-foreground">
          Notes from past conversations. Not facts: your team can correct or delete them.
        </p>
      </div>
      {empty ? (
        <Quiet>Nothing yet. {personaName} writes notes after a conversation ends.</Quiet>
      ) : (
        <>
          {data.summary.trim() ? (
            <p className="font-serif text-[0.9375rem] leading-7">{data.summary}</p>
          ) : null}
          {commitments.length > 0 ? (
            <section className="grid gap-1.5">
              <h3 className="label-mono">Commitments</h3>
              <ul className="grid gap-1.5 text-small leading-6">
                {commitments.map((commitment) => (
                  <li key={commitment.id}>
                    {commitment.text}
                    {commitment.due ? (
                      <span className="tabular text-muted-foreground">
                        {' '}
                        · by {formatIsoDate(commitment.due)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <NotebookList title="About you" entries={data.founderProfile} />
          <NotebookList title="Open questions" entries={data.openQuestions} />
          <NotebookList title="Recent advice" entries={data.lastAdvice} />
        </>
      )}
      <Button asChild variant="link" size="sm" className="justify-self-start text-small">
        <Link to="/$tenant/app/v/$ventureId/knowledge" params={{ tenant, ventureId }}>
          Edit in Knowledge
          <ArrowUpRight aria-hidden />
        </Link>
      </Button>
    </PanelBody>
  );
}

function ReviewTab({
  tenant,
  ventureId,
  items,
  query,
}: {
  tenant: string;
  ventureId: string;
  items: MemoryObjectView[] | undefined;
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
}) {
  const { run, pendingId } = useMemoryActions(ventureId);
  const batch = useBatchMemoryAction(ventureId);
  if (query.isPending) return <Loading />;
  if (query.isError || !items) return <Failed error={query.error} onRetry={() => void query.refetch()} />;

  const keepAll = () => {
    batch.mutate(
      { ids: items.slice(0, 50).map((m) => m.id), action: 'approve' },
      {
        onSuccess: (result) => {
          const message = `Kept ${pluralize(result.items.length, 'item')}`;
          toast.success(message);
          announce(message);
        },
        onError: (error) => {
          toast.error('Couldn’t keep these', { description: errorMessage(error) });
        },
      },
    );
  };

  return (
    <PanelBody>
      <div className="flex items-center justify-between gap-2">
        <p className="text-small text-muted-foreground">
          {items.length === 0
            ? 'Nothing waiting. Suggestions to remember appear here.'
            : 'Suggestions to remember for this venture. Nothing is kept until someone keeps it.'}
        </p>
        {items.length > 1 ? (
          <Button size="xs" variant="secondary" loading={batch.isPending} onClick={keepAll}>
            Keep all
          </Button>
        ) : null}
      </div>
      {items.length > 0 ? (
        <ul className="divide-y divide-border border-y border-border">
          {items.map((memory) => {
            const busy = pendingId === memory.id || batch.isPending;
            return (
              <li key={memory.id} className="grid gap-1.5 py-3">
                <div className="flex items-center gap-1.5">
                  <MemoryTypeLabel type={memory.type} iconOnly />
                  <p className="min-w-0 text-small font-medium [overflow-wrap:anywhere]">{memory.title}</p>
                </div>
                <p className="line-clamp-3 text-caption leading-5 text-muted-foreground">{memory.content}</p>
                <div className="flex gap-1.5">
                  <Button
                    size="xs"
                    disabled={busy}
                    aria-label={`Keep: ${memory.title}`}
                    onClick={() => {
                      run(memory.id, { action: 'approve' }, { successMessage: 'Kept' });
                    }}
                  >
                    Keep
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Not now: ${memory.title}`}
                    onClick={() => {
                      run(memory.id, { action: 'reject' }, { successMessage: 'Not kept' });
                    }}
                  >
                    Not now
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      <Button asChild variant="link" size="sm" className="justify-self-start text-small">
        <Link to="/$tenant/app/v/$ventureId/knowledge" params={{ tenant, ventureId }}>
          Open Knowledge
          <ArrowUpRight aria-hidden />
        </Link>
      </Button>
    </PanelBody>
  );
}

function EscalationRow({
  escalation,
  tenant,
  ventureId,
}: {
  escalation: EscalationView;
  tenant: string;
  ventureId: string;
}) {
  return (
    <li className="grid gap-1.5 py-3">
      <Link
        to="/$tenant/app/v/$ventureId/help"
        params={{ tenant, ventureId }}
        search={{ id: escalation.id }}
        className="text-small font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {ESCALATION_CATEGORY_LABELS[escalation.category]}
      </Link>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge kind="escalationStatus" status={escalation.status} />
        <span className="text-caption text-muted-foreground">{formatRelative(escalation.createdAt)}</span>
      </div>
    </li>
  );
}

function HelpTab({
  session,
  tenant,
  ventureId,
  onAskPerson,
}: {
  session: SessionView;
  tenant: string;
  ventureId: string;
  onAskPerson?: (() => void) | undefined;
}) {
  const escalations = useVentureEscalations(ventureId);
  if (escalations.isPending) return <Loading />;
  if (escalations.isError)
    return <Failed error={escalations.error} onRetry={() => void escalations.refetch()} />;
  const fromHere = escalations.data.filter((e) => e.sessionId === session.id);
  const otherOpen = escalations.data.filter(
    (e) => e.sessionId !== session.id && OPEN_ESCALATION.has(e.status),
  );
  return (
    <PanelBody>
      <div className="flex items-center justify-between gap-2">
        <p className="text-small text-muted-foreground">
          {fromHere.length === 0
            ? 'No requests from this conversation.'
            : `${pluralize(fromHere.length, 'request')} from this conversation.`}
        </p>
        {onAskPerson ? (
          <Button size="xs" variant="secondary" onClick={onAskPerson}>
            Ask a person
          </Button>
        ) : null}
      </div>
      {fromHere.length > 0 ? (
        <ul className="divide-y divide-border border-y border-border">
          {fromHere.map((e) => (
            <EscalationRow key={e.id} escalation={e} tenant={tenant} ventureId={ventureId} />
          ))}
        </ul>
      ) : null}
      {otherOpen.length > 0 ? (
        <section className="grid gap-1.5">
          <h3 className="label-mono">Other open requests</h3>
          <ul className="divide-y divide-border border-y border-border">
            {otherOpen.map((e) => (
              <EscalationRow key={e.id} escalation={e} tenant={tenant} ventureId={ventureId} />
            ))}
          </ul>
        </section>
      ) : null}
    </PanelBody>
  );
}
