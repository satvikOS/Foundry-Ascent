import type { NotebookEntry, SessionView, TurnView } from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useNotebook } from '@/lib/api/hooks/notebook';
import type { VeirName } from '@/lib/veir';
import { formatIsoDate } from '@/features/memory/typed/attributes';

import { EvidenceItemCard } from '../coach/evidence-item';
import { usePanelState, type PanelTab } from './panel-state';
import { VentureContext, type PromptSuggestion } from './venture-context';

interface ContextPanelProps {
  session: SessionView;
  turns: TurnView[];
  personaName: string;
  veir: VeirName | null;
  tenant: string;
  ventureId: string;
  onAskPerson?: (() => void) | undefined;
  /** Fill the composer with a quick action (none once the conversation has ended or cannot take a message). */
  onPrompt?: ((suggestion: PromptSuggestion) => void) | undefined;
}

/**
 * The conversation's right panel: Overview (the venture's stage, what is due, tests, human help, the memory state
 * and quick actions, as on New chat) · Sources · Notebook. Memory has no queue here: what the mentor learns is kept
 * automatically, and the founder edits or forgets it in Knowledge.
 */
export function ContextPanel({
  session,
  turns,
  personaName,
  veir,
  tenant,
  ventureId,
  onAskPerson,
  onPrompt,
}: ContextPanelProps) {
  const { tab, setTab } = usePanelState();
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        setTab(value as PanelTab);
      }}
      // The tabs stay put and each tab scrolls on its own beneath them (no opaque sticky strip over the glass).
      className="absolute inset-0 flex min-h-0 flex-col gap-0"
    >
      <div className="shrink-0 border-b border-border px-4">
        <TabsList
          variant="underline"
          className="h-11 gap-4 overflow-x-auto border-b-0 [scrollbar-width:none]"
        >
          <TabsTrigger value="context">Overview</TabsTrigger>
          <TabsTrigger value="sources">Sources</TabsTrigger>
          <TabsTrigger value="notebook">Notebook</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="context" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <VentureContext
          tenant={tenant}
          ventureId={ventureId}
          veir={veir}
          sessionId={session.id}
          memory={{ kind: 'fixed', privacy: session.privacy }}
          onPrompt={onPrompt}
          onAskPerson={onAskPerson}
        />
      </TabsContent>
      <TabsContent value="sources" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <SourcesTab turns={turns} personaName={personaName} tenant={tenant} ventureId={ventureId} />
      </TabsContent>
      <TabsContent value="notebook" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <NotebookTab personaName={personaName} tenant={tenant} ventureId={ventureId} />
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
      <h3 className="section-label">{title}</h3>
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
        <h2 className="text-subheading font-semibold">What {personaName} knows</h2>
        <p className="text-caption text-muted-foreground">Notes from past conversations, not facts.</p>
      </div>
      {empty ? (
        <Quiet>No notes yet.</Quiet>
      ) : (
        <>
          {data.summary.trim() ? <p className="text-body">{data.summary}</p> : null}
          {commitments.length > 0 ? (
            <section className="grid gap-1.5">
              <h3 className="section-label">Commitments</h3>
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
