import type {
  EscalationView,
  MemoryObjectView,
  NextAction,
  SessionRecap,
  SessionView,
  TurnView,
} from '@foundry/contracts';
import {
  Bookmark,
  Check,
  Compass,
  HandHelping,
  Library,
  ListChecks,
  Printer,
  RefreshCw,
  Swords,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { DisclosureBanner } from '@/components/disclosure-banner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { toast } from '@/components/ui/toast';
import { announce } from '@/components/a11y/live-announcer';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/format';
import { ESCALATION_CATEGORY_LABELS, REQUESTED_ROLE_LABELS } from '@/lib/labels';
import { useCreateVentureMemory } from '@/features/memory/api';
import { MemoryActionBar } from '@/features/memory/memory-action-bar';
import { ConfidenceMeter, MemoryTypeLabel } from '@/features/memory/memory-meta';
import { formatIsoDate } from '@/features/memory/typed/attributes';
import { displayContent } from '@/lib/api/hooks/memory';

import { EvidenceChip } from './response/evidence-chip';
import { useCoachWorkspace } from './workspace';

function RecapCard({
  title,
  icon: Icon,
  index,
  children,
  className,
}: {
  title: string;
  icon: LucideIcon;
  index: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={`recap-${index}`}
      className={`rounded-xl border border-border bg-card p-4 shadow-sm break-inside-avoid sm:p-5 ${className ?? ''}`}
    >
      <h3 id={`recap-${index}`} className="mb-3 flex items-center gap-2 text-sm font-semibold tracking-tight">
        <span className="tabular flex size-5 items-center justify-center rounded-full border border-border-strong text-[11px]">
          {index}
        </span>
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        {title}
      </h3>
      {children}
    </section>
  );
}

interface SessionRecapViewProps {
  session: SessionView;
  recap: SessionRecap | null;
  turns: TurnView[];
  tenant: string;
  ventureId: string;
  canEdit: boolean;
  memoryItems: MemoryObjectView[] | undefined;
  memoryLoading: boolean;
  escalations: EscalationView[] | undefined;
  onRequestEscalation: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}

/**
 * Session recap — the five session-contract objects (diagnosis, evidence, challenge, next actions,
 * escalation) followed by the memory the session proposed for approval. Printable with disclosure.
 */
export function SessionRecapView({
  session,
  recap,
  turns,
  ventureId,
  canEdit,
  memoryItems,
  memoryLoading,
  escalations,
  onRequestEscalation,
  onRefresh,
  refreshing,
}: SessionRecapViewProps) {
  const { showEvidence } = useCoachWorkspace();
  const { createMemory } = useCreateVentureMemory(ventureId);
  const [savingIndex, setSavingIndex] = useState<number | null>(null);

  if (!recap) {
    return session.privacy === 'ephemeral' ? (
      <Alert title="No recap for ephemeral sessions">
        This was an ephemeral session, so no recap or memory was kept. Only minimal security records remain.
      </Alert>
    ) : (
      <Alert
        variant="info"
        title="The recap is being prepared"
        action={
          <Button size="sm" variant="secondary" onClick={onRefresh} loading={refreshing}>
            <RefreshCw aria-hidden />
            Check again
          </Button>
        }
      >
        It usually takes a few seconds after a session ends.
      </Alert>
    );
  }

  const findEvidenceTurn = (key: string): TurnView | undefined =>
    [...turns].reverse().find((t) => t.evidence.some((e) => e.key === key));

  const savedAction = (action: NextAction) =>
    memoryItems?.some(
      (m) =>
        m.type === 'action' &&
        m.title.trim().toLowerCase() === action.action.slice(0, 200).trim().toLowerCase() &&
        m.sourceRefs.some((r) => r.kind === 'session' && r.id === session.id),
    ) ?? false;

  const saveAction = async (action: NextAction, index: number) => {
    setSavingIndex(index);
    try {
      await createMemory({
        type: 'action',
        title: action.action.slice(0, 200),
        content: action.action,
        attributes: {
          owner: action.owner || undefined,
          due: action.target_date ?? undefined,
          status: 'open',
        },
        sourceRefs: [{ kind: 'session', id: session.id, label: 'Session recap' }],
      });
      toast.success('Saved as an action');
      announce('Saved as an action');
    } catch (error) {
      toast.error('Couldn’t save the action', { description: errorMessage(error) });
    } finally {
      setSavingIndex(null);
    }
  };

  const existing = escalations?.filter((e) => e.sessionId === session.id) ?? [];
  const candidateMemory = recap.memory_candidate_ids.map(
    (id) => [id, memoryItems?.find((m) => m.id === id) ?? null] as const,
  );

  return (
    <div className="grid gap-4" data-testid="session-recap">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted-foreground">
          Recap generated by Foundry Guide (AI) ·{' '}
          <time dateTime={recap.generated_at}>{formatDateTime(recap.generated_at)}</time>
        </p>
        <Button
          variant="ghost"
          size="sm"
          data-print="hide"
          onClick={() => {
            window.print();
          }}
        >
          <Printer aria-hidden />
          Print recap
        </Button>
      </div>
      <DisclosureBanner variant="print" text={session.disclosure} className="hidden print:block" />

      <div className="grid gap-4 lg:grid-cols-2">
        <RecapCard title="Diagnosis" icon={Compass} index={1}>
          <dl className="grid gap-3 text-sm">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Stage</dt>
              <dd className="mt-0.5">{recap.diagnosis.stage}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Immediate constraint</dt>
              <dd className="mt-0.5 leading-6">{recap.diagnosis.immediate_constraint}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Riskiest assumption</dt>
              <dd className="mt-0.5 leading-6">{recap.diagnosis.riskiest_assumption}</dd>
            </div>
          </dl>
        </RecapCard>

        <RecapCard title="Evidence" icon={Library} index={2}>
          {recap.evidence.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No evidence was cited in this session.</p>
          ) : (
            <ul className="grid gap-2.5">
              {recap.evidence.map((item) => {
                const turn = findEvidenceTurn(item.evidence_key);
                const evidence = turn?.evidence.find((e) => e.key === item.evidence_key) ?? null;
                return (
                  <li key={`${item.evidence_key}-${item.title}`} className="text-sm leading-6">
                    {evidence && turn ? (
                      <EvidenceChip
                        evidenceKey={item.evidence_key}
                        item={evidence}
                        onOpen={(key) => {
                          showEvidence(turn.id, key);
                        }}
                        className="ml-0"
                      />
                    ) : (
                      <span className="mr-1 rounded-[5px] border border-border px-1 font-mono text-[11px]">
                        {item.evidence_key}
                      </span>
                    )}{' '}
                    <span className="font-medium">{item.title}</span>
                    {item.note ? (
                      <span className="block text-[13px] text-muted-foreground">{item.note}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </RecapCard>

        <RecapCard title="Challenge" icon={Swords} index={3}>
          <p className="border-l-2 border-foreground/70 pl-3 text-[15px] leading-7 font-medium">
            {recap.challenge}
          </p>
        </RecapCard>

        <RecapCard title="Next actions" icon={ListChecks} index={4}>
          {recap.next_actions.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No next actions were agreed.</p>
          ) : (
            <ul className="grid gap-2">
              {recap.next_actions.map((action, index) => (
                <li
                  key={`${index}-${action.action}`}
                  className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="text-sm font-medium">{action.action}</p>
                    <p className="text-xs text-muted-foreground">
                      {action.owner || 'No owner'}
                      {action.target_date ? ` · ${formatIsoDate(action.target_date)}` : ''}
                    </p>
                  </div>
                  {savedAction(action) ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium">
                      <Check aria-hidden className="size-3.5 text-success" />
                      Saved
                    </span>
                  ) : canEdit ? (
                    <Button
                      size="xs"
                      variant="secondary"
                      data-print="hide"
                      loading={savingIndex === index}
                      onClick={() => void saveAction(action, index)}
                    >
                      <Bookmark aria-hidden />
                      Save as action
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </RecapCard>

        <RecapCard title="Escalation" icon={HandHelping} index={5} className="lg:col-span-2">
          {recap.escalation.required ? (
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {recap.escalation.priority ? (
                  <StatusBadge kind="escalationPriority" status={recap.escalation.priority} />
                ) : null}
                {recap.escalation.category ? (
                  <span className="text-sm font-medium">
                    {ESCALATION_CATEGORY_LABELS[recap.escalation.category]}
                  </span>
                ) : null}
                {recap.escalation.requested_role ? (
                  <span className="text-xs text-muted-foreground">
                    →{' '}
                    {REQUESTED_ROLE_LABELS[recap.escalation.requested_role] ??
                      recap.escalation.requested_role}
                  </span>
                ) : null}
              </div>
              {recap.escalation.reason ? (
                <p className="text-sm leading-6">{recap.escalation.reason}</p>
              ) : null}
              {existing.length > 0 ? (
                <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                  Requested from this session:{' '}
                  <StatusBadge kind="escalationStatus" status={existing[0]?.status ?? 'draft'} />
                </p>
              ) : canEdit ? (
                <div data-print="hide">
                  <Button size="sm" onClick={onRequestEscalation}>
                    <HandHelping aria-hidden />
                    Request human support
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              No human handoff needed from this session. You can still request support at any time.
            </p>
          )}
        </RecapCard>
      </div>

      {session.privacy === 'standard' && candidateMemory.length > 0 ? (
        <section
          aria-labelledby="recap-memory"
          className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5"
        >
          <h3 id="recap-memory" className="mb-1 flex items-center gap-2 text-sm font-semibold tracking-tight">
            <Bookmark aria-hidden className="size-4 text-muted-foreground" />
            Memory to approve
          </h3>
          <p className="mb-3 text-[13px] text-muted-foreground">
            Foundry Guide proposed these from the session. Nothing is remembered until you approve it.
          </p>
          <ul className="divide-y divide-border">
            {candidateMemory.map(([id, memory]) => (
              <li key={id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                {memory ? (
                  <>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <MemoryTypeLabel type={memory.type} />
                        <StatusBadge kind="memory" status={memory.status} />
                        <ConfidenceMeter value={memory.confidence} />
                      </div>
                      <p className="mt-1 text-sm font-medium">{memory.title}</p>
                      <p className="text-[13px] text-muted-foreground">{displayContent(memory)}</p>
                    </div>
                    {canEdit ? (
                      <MemoryActionBar ventureId={ventureId} memory={memory} size="sm" className="shrink-0" />
                    ) : null}
                  </>
                ) : memoryLoading ? (
                  <Skeleton className="h-12 w-full" />
                ) : (
                  <p className="text-[13px] text-muted-foreground">
                    This suggestion is no longer available (it may have been rejected or deleted).
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
