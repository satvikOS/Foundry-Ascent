import {
  OPEN_ESCALATION_STATUSES,
  type EscalationView,
  type MemoryObjectView,
  type SessionView,
  type TurnView,
} from '@foundry/contracts';
import { Link } from '@tanstack/react-router';
import { Check, HandHelping, Pin, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { InspectorSection } from '@/components/ui/inspector-panel';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useVentureEscalations } from '@/lib/api/hooks/escalations';
import { useMemory } from '@/lib/api/hooks/memory';
import { formatRelative } from '@/lib/format';
import { ESCALATION_CATEGORY_LABELS } from '@/lib/labels';
import { useMemoryActions } from '@/features/memory/api';
import { MemoryTypeLabel } from '@/features/memory/memory-meta';

import { EvidenceItemCard } from './evidence-item';
import { useCoachWorkspace, type SessionInspectorTab } from './workspace';

const OPEN_ESCALATION: ReadonlySet<string> = new Set(OPEN_ESCALATION_STATUSES);

interface SessionInspectorProps {
  session: SessionView;
  turns: TurnView[];
  tenant: string;
  ventureId: string;
  canEdit: boolean;
  onRequestSupport?: () => void;
}

function Loading() {
  return (
    <div aria-busy="true" className="grid gap-2 p-4">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

function EvidenceTab({ turns }: { turns: TurnView[] }) {
  const { selectedTurnId, focused, showEvidence } = useCoachWorkspace();
  const withEvidence = turns.filter((t) => t.status === 'completed');
  const turn =
    withEvidence.find((t) => t.id === selectedTurnId) ?? withEvidence[withEvidence.length - 1] ?? null;
  const refs = useRef(new Map<string, HTMLElement>());
  const handledNonce = useRef(0);

  useEffect(() => {
    // Focus once per chip activation; later re-renders (refetches) must not steal focus again.
    if (!focused?.key || focused.turnId !== turn?.id || focused.nonce === handledNonce.current) return;
    const key = focused.key;
    const nonce = focused.nonce;
    let frame = 0;
    let attempts = 0;
    // The inspector (column or mobile sheet) may still be mounting: retry for a few frames, then
    // bring the item into view and focus it.
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
      <InspectorSection title="Sources">
        <p className="text-[13px] text-muted-foreground">
          Sources appear here once Foundry Guide answers. Each answer cites them as chips like{' '}
          <span className="rounded-[5px] border border-border-strong bg-muted px-1 font-mono text-[11px]">
            E1
          </span>
          .
        </p>
      </InspectorSection>
    );
  }

  return (
    <InspectorSection
      title="Sources"
      meta={turn.evidence.length}
      actions={
        withEvidence.length > 1 ? (
          <Select
            value={turn.id}
            onValueChange={(id) => {
              showEvidence(id);
            }}
          >
            <SelectTrigger size="sm" className="h-7 text-xs" aria-label="Show sources for answer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {withEvidence.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  Answer {t.ordinal}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null
      }
    >
      {turn.evidence.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          No sources were retrieved for this answer, so treat it as general guidance rather than evidence
          about your venture.
        </p>
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
    </InspectorSection>
  );
}

function MemoryLine({
  memory,
  tenant,
  ventureId,
  actions,
}: {
  memory: MemoryObjectView;
  tenant: string;
  ventureId: string;
  actions?: ReactNode;
}) {
  return (
    <li className="grid gap-1 py-2.5">
      <div className="flex items-center gap-1.5">
        <MemoryTypeLabel type={memory.type} iconOnly />
        <Link
          to="/$tenant/app/ventures/$ventureId/memory"
          params={{ tenant, ventureId }}
          search={{ m: memory.id }}
          className="min-w-0 truncate text-[13px] font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {memory.title}
        </Link>
        {memory.pinned ? (
          <Pin aria-label="Pinned" className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
        ) : null}
      </div>
      <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{memory.content}</p>
      {actions}
    </li>
  );
}

function FactsTab({ tenant, ventureId }: { tenant: string; ventureId: string }) {
  const confirmed = useMemory(ventureId, { status: 'confirmed' });
  const [query, setQuery] = useState('');
  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (confirmed.data ?? [])
      .filter(
        (m) => !needle || m.title.toLowerCase().includes(needle) || m.content.toLowerCase().includes(needle),
      )
      .sort(
        (a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      );
  }, [confirmed.data, query]);

  if (confirmed.isPending) return <Loading />;
  if (confirmed.isError) {
    return (
      <div className="p-4">
        <ErrorState
          error={confirmed.error}
          onRetry={() => void confirmed.refetch()}
          size="sm"
          headingLevel={3}
        />
      </div>
    );
  }
  return (
    <InspectorSection title="Known facts" meta={confirmed.data.length}>
      <p className="mb-2 text-xs text-muted-foreground">
        Confirmed memory Foundry Guide can rely on. Pinned items first.
      </p>
      <div className="relative mb-1">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          aria-label="Filter known facts"
          placeholder="Filter"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          className="h-8 pl-8 text-[13px]"
        />
      </div>
      {items.length === 0 ? (
        <p className="py-3 text-[13px] text-muted-foreground">
          {query ? 'Nothing matches.' : 'No confirmed memory yet. Approve suggestions to build it up.'}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((m) => (
            <MemoryLine key={m.id} memory={m} tenant={tenant} ventureId={ventureId} />
          ))}
        </ul>
      )}
    </InspectorSection>
  );
}

function ProposedTab({
  tenant,
  ventureId,
  canEdit,
}: {
  tenant: string;
  ventureId: string;
  canEdit: boolean;
}) {
  const proposed = useMemory(ventureId, { status: 'proposed' });
  const { run, pendingId, isPending } = useMemoryActions(ventureId);
  if (proposed.isPending) return <Loading />;
  if (proposed.isError) {
    return (
      <div className="p-4">
        <ErrorState
          error={proposed.error}
          onRetry={() => void proposed.refetch()}
          size="sm"
          headingLevel={3}
        />
      </div>
    );
  }
  return (
    <InspectorSection
      title="Proposed memory"
      meta={proposed.data.length}
      actions={
        <Button asChild variant="ghost" size="xs">
          <Link
            to="/$tenant/app/ventures/$ventureId/memory"
            params={{ tenant, ventureId }}
            search={{ view: 'proposed' }}
          >
            Review all
          </Link>
        </Button>
      }
    >
      {proposed.data.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Nothing waiting for approval.</p>
      ) : (
        <ul className="divide-y divide-border">
          {proposed.data.map((m) => (
            <MemoryLine
              key={m.id}
              memory={m}
              tenant={tenant}
              ventureId={ventureId}
              actions={
                canEdit ? (
                  <div className="mt-1 flex gap-1.5">
                    <Button
                      size="xs"
                      disabled={isPending && pendingId === m.id}
                      onClick={() => {
                        run(m.id, { action: 'approve' });
                      }}
                      aria-label={`Approve: ${m.title}`}
                    >
                      <Check aria-hidden />
                      Approve
                    </Button>
                    <Button
                      size="xs"
                      variant="secondary"
                      disabled={isPending && pendingId === m.id}
                      onClick={() => {
                        run(m.id, { action: 'reject' });
                      }}
                      aria-label={`Reject: ${m.title}`}
                    >
                      <X aria-hidden />
                      Reject
                    </Button>
                  </div>
                ) : null
              }
            />
          ))}
        </ul>
      )}
    </InspectorSection>
  );
}

function EscalationLine({
  escalation,
  tenant,
  ventureId,
}: {
  escalation: EscalationView;
  tenant: string;
  ventureId: string;
}) {
  return (
    <li className="grid gap-1.5 py-2.5">
      <Link
        to="/$tenant/app/ventures/$ventureId/escalations"
        params={{ tenant, ventureId }}
        search={{ id: escalation.id }}
        className="text-[13px] font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {ESCALATION_CATEGORY_LABELS[escalation.category]}
      </Link>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge kind="escalationPriority" status={escalation.priority} />
        <StatusBadge kind="escalationStatus" status={escalation.status} />
        <span className="text-xs text-muted-foreground">{formatRelative(escalation.createdAt)}</span>
      </div>
    </li>
  );
}

function HandoffTab({
  session,
  tenant,
  ventureId,
  canEdit,
  onRequestSupport,
}: {
  session: SessionView;
  tenant: string;
  ventureId: string;
  canEdit: boolean;
  onRequestSupport?: () => void;
}) {
  const escalations = useVentureEscalations(ventureId);
  if (escalations.isPending) return <Loading />;
  if (escalations.isError) {
    return (
      <div className="p-4">
        <ErrorState
          error={escalations.error}
          onRetry={() => void escalations.refetch()}
          size="sm"
          headingLevel={3}
        />
      </div>
    );
  }
  const fromSession = escalations.data.filter((e) => e.sessionId === session.id);
  const otherOpen = escalations.data.filter(
    (e) => e.sessionId !== session.id && OPEN_ESCALATION.has(e.status),
  );
  return (
    <>
      <InspectorSection
        title="This session"
        meta={fromSession.length}
        actions={
          canEdit && onRequestSupport ? (
            <Button size="xs" variant="secondary" onClick={onRequestSupport}>
              <HandHelping aria-hidden />
              Request support
            </Button>
          ) : null
        }
      >
        {fromSession.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            No human handoffs from this session. Foundry Guide suggests one when a person should weigh in — or
            you can ask for one any time.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {fromSession.map((e) => (
              <EscalationLine key={e.id} escalation={e} tenant={tenant} ventureId={ventureId} />
            ))}
          </ul>
        )}
      </InspectorSection>
      {otherOpen.length > 0 ? (
        <InspectorSection title="Other open requests" meta={otherOpen.length}>
          <ul className="divide-y divide-border">
            {otherOpen.map((e) => (
              <EscalationLine key={e.id} escalation={e} tenant={tenant} ventureId={ventureId} />
            ))}
          </ul>
        </InspectorSection>
      ) : null}
    </>
  );
}

/** The session's right-hand inspector: Evidence · Known facts · Proposed memory · Handoff. */
export function SessionInspector({
  session,
  turns,
  tenant,
  ventureId,
  canEdit,
  onRequestSupport,
}: SessionInspectorProps) {
  const { tab, setTab } = useCoachWorkspace();
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        setTab(value as SessionInspectorTab);
      }}
      className="gap-0"
    >
      <div className="sticky top-0 z-10 border-b border-border bg-card px-3 py-2">
        <TabsList className="w-full">
          <TabsTrigger value="evidence" className="flex-1 px-1.5">
            Evidence
          </TabsTrigger>
          <TabsTrigger value="facts" className="flex-1 px-1.5">
            Facts
          </TabsTrigger>
          <TabsTrigger value="proposed" className="flex-1 px-1.5">
            Proposed
          </TabsTrigger>
          <TabsTrigger value="handoff" className="flex-1 px-1.5">
            Handoff
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="evidence">
        <EvidenceTab turns={turns} />
      </TabsContent>
      <TabsContent value="facts">
        <FactsTab tenant={tenant} ventureId={ventureId} />
      </TabsContent>
      <TabsContent value="proposed">
        <ProposedTab tenant={tenant} ventureId={ventureId} canEdit={canEdit} />
      </TabsContent>
      <TabsContent value="handoff">
        <HandoffTab
          session={session}
          tenant={tenant}
          ventureId={ventureId}
          canEdit={canEdit}
          onRequestSupport={onRequestSupport}
        />
      </TabsContent>
    </Tabs>
  );
}
