import {
  OPEN_ESCALATION_STATUSES,
  type EscalationView,
  type NotebookEntry,
  type SessionView,
  type TurnView,
} from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useVentureEscalations } from '@/lib/api/hooks/escalations';
import { useNotebook } from '@/lib/api/hooks/notebook';
import { formatRelative, pluralize } from '@/lib/format';
import { ESCALATION_CATEGORY_LABELS } from '@/lib/labels';
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

/**
 * The conversation's right panel: Sources · Notebook · Human help. Memory has no queue here: what the vEIR
 * learns is kept automatically, and the founder edits or forgets it in Knowledge.
 */
export function ContextPanel({
  session,
  turns,
  personaName,
  tenant,
  ventureId,
  onAskPerson,
}: ContextPanelProps) {
  const { tab, setTab } = usePanelState();
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
          <TabsTrigger value="help">Human help</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="sources">
        <SourcesTab turns={turns} personaName={personaName} tenant={tenant} ventureId={ventureId} />
      </TabsContent>
      <TabsContent value="notebook">
        <NotebookTab personaName={personaName} tenant={tenant} ventureId={ventureId} />
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

function SourcesTab({
  turns,
  personaName,
  tenant,
  ventureId,
}: {
  turns: TurnView[];
  personaName: string;
  tenant: string;
  ventureId: string;
}) {
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
        <Quiet>No sources yet.</Quiet>
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
        <Quiet>No sources. Treat this answer as general guidance.</Quiet>
      ) : (
        <ul className="grid gap-2" aria-label={`Sources for answer ${turn.ordinal}`}>
          {turn.evidence.map((item) => (
            <li key={item.key}>
              <EvidenceItemCard
                item={item}
                veirName={personaName}
                venture={{ tenant, ventureId }}
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
        <p className="text-caption text-muted-foreground">Notes from past conversations, not facts.</p>
      </div>
      {empty ? (
        <Quiet>No notes yet.</Quiet>
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
          {fromHere.length === 0 ? 'No requests yet.' : pluralize(fromHere.length, 'request')}
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
