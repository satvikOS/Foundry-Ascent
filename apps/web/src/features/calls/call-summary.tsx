import type { CallSummary, MemoryObjectView } from '@foundry/contracts';
import { useQueries } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, ListChecks, Phone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { DisclosureBanner } from '@/components/disclosure-banner';
import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { toast } from '@/components/ui/toast';
import { useVentureEscalations } from '@/lib/api/hooks/escalations';
import { displayContent, memoryItemQueryOptions } from '@/lib/api/hooks/memory';
import { budgetEndLine } from '@/lib/realtime/call-api';
import type { CallEnded } from '@/lib/realtime/call-engine';
import { formatDate } from '@/lib/format';
import { ESCALATION_CATEGORY_LABELS } from '@/lib/labels';

import { reviewFailure, useMemoryReview } from '../knowledge/review-api';

import { formatClock, spokenDuration } from './use-call-clock';
import { useCallConfig, type CallVeir } from './use-call-veir';

interface CallSummaryProps {
  tenant: string;
  ventureId: string;
  veir: CallVeir;
  ended: CallEnded;
  canWrite: boolean;
  onBackToConversation: () => void;
  onCallAgain: () => void;
  /** Leaving for another page from the summary (Human help): the call is over, forget it. */
  onLeave: () => void;
}

const END_LINES: Partial<Record<CallEnded['reason'], string>> = {
  timeout: 'The call reached its time limit.',
  disabled: 'Calls were paused by the program.',
  error: 'The connection was lost.',
};

/**
 * After a call (`POST /calls/:id/end`): how long it was, what the vEIR proposes to remember (Keep / Not
 * now, nothing is kept without the founder's say), the next actions it suggested and any request for a
 * person it drafted. The transcript itself is already in the conversation.
 */
export function CallSummaryPanel({
  tenant,
  ventureId,
  veir,
  ended,
  canWrite,
  onBackToConversation,
  onCallAgain,
  onLeave,
}: CallSummaryProps) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  const summary = ended.summary;
  const exchanges = summary?.turnCount ?? ended.turnCount;
  // Ended for its budget: the refreshed call settings tell call minutes from the day's AI allowance.
  const config = useCallConfig(ventureId, ended.reason === 'budget');
  const endLine =
    ended.reason === 'budget' ? budgetEndLine(config.data?.remainingMinutesToday) : END_LINES[ended.reason];

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center px-4 pt-6 pb-8 text-center sm:pt-10">
      <PersonaAvatar name={veir.name} portraitUrl={veir.portraitUrl} size="xl" decorative />
      <h2 ref={headingRef} tabIndex={-1} className="mt-5 font-serif text-heading font-normal outline-none">
        Call ended
      </h2>
      <p className="mt-2 text-small text-muted-foreground">
        <span className="tabular" aria-hidden>
          {formatClock(ended.durationSeconds)}
        </span>
        <span className="sr-only">{spokenDuration(ended.durationSeconds)}</span>
        {exchanges > 0 ? ` · ${String(exchanges)} exchange${exchanges === 1 ? '' : 's'}` : null}
        {' · '}
        {exchanges > 0 ? 'The transcript is in this conversation.' : 'Nothing was said.'}
      </p>
      {endLine ? (
        <p role="status" className="mt-1 max-w-md text-small text-pretty text-muted-foreground">
          {endLine}
        </p>
      ) : null}

      {summary ? (
        <SummaryDetails
          tenant={tenant}
          ventureId={ventureId}
          veirName={veir.name}
          summary={summary}
          canWrite={canWrite}
          onLeave={onLeave}
        />
      ) : (
        <p role="status" className="mt-6 text-small text-muted-foreground">
          {ended.summaryError ? `The summary couldn’t load. ${ended.summaryError}` : 'Loading the summary…'}
        </p>
      )}

      <div className="mt-8 flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row sm:justify-center">
        <Button variant="secondary" size="lg" onClick={onCallAgain} disabled={!canWrite}>
          <Phone aria-hidden />
          Call again
        </Button>
        <Button size="lg" onClick={onBackToConversation}>
          Back to conversation
        </Button>
      </div>
      <DisclosureBanner
        variant="line"
        text={veir.disclosure}
        veirName={veir.name}
        className="mt-8 max-w-2xl text-center"
      />
    </div>
  );
}

function SummaryDetails({
  tenant,
  ventureId,
  veirName,
  summary,
  canWrite,
  onLeave,
}: {
  tenant: string;
  ventureId: string;
  veirName: string;
  summary: CallSummary;
  canWrite: boolean;
  onLeave: () => void;
}) {
  const memories = useQueries({
    queries: summary.memoryProposalIds.map((id) => memoryItemQueryOptions(id)),
  });
  const escalations = useVentureEscalations(ventureId);
  const drafted = (escalations.data ?? []).filter((e) => summary.escalationIds.includes(e.id));
  const proposals = memories
    .map((query) => query.data)
    .filter((memory): memory is MemoryObjectView => memory !== undefined);
  const loadingMemory = memories.some((query) => query.isPending);
  const empty =
    summary.memoryProposalIds.length === 0 &&
    summary.nextActions.length === 0 &&
    summary.escalationIds.length === 0;

  if (empty) {
    return <p className="mt-6 text-small text-muted-foreground">Nothing new to review from this call.</p>;
  }

  return (
    <div className="mt-8 grid w-full gap-6 text-left">
      {summary.memoryProposalIds.length > 0 ? (
        <section aria-labelledby="call-summary-memory">
          <h3 id="call-summary-memory" className="label-mono mb-2">
            {veirName} would like to remember
          </h3>
          {loadingMemory && proposals.length === 0 ? (
            <p role="status" className="text-small text-muted-foreground">
              Loading…
            </p>
          ) : (
            <ul className="grid gap-2">
              {proposals.map((memory) => (
                <MemoryProposal key={memory.id} ventureId={ventureId} memory={memory} canWrite={canWrite} />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {summary.nextActions.length > 0 ? (
        <section aria-labelledby="call-summary-actions">
          <h3 id="call-summary-actions" className="label-mono mb-2">
            Next actions
          </h3>
          <ul className="grid gap-1.5">
            {summary.nextActions.map((action, index) => (
              <li key={`${action.action}-${String(index)}`} className="flex gap-2.5 text-body">
                <ListChecks aria-hidden className="mt-1 size-4 shrink-0 text-muted-foreground" />
                <span>
                  {action.action}
                  <span className="text-small text-muted-foreground">
                    {' · '}
                    {action.owner}
                    {action.target_date ? ` · by ${formatDate(action.target_date)}` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {summary.escalationIds.length > 0 ? (
        <section aria-labelledby="call-summary-help">
          <h3 id="call-summary-help" className="label-mono mb-2">
            Human help
          </h3>
          <ul className="grid gap-2">
            {drafted.map((escalation) => (
              <li
                key={escalation.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border bg-card px-3.5 py-3"
              >
                <span className="min-w-0 flex-1 text-small font-medium">
                  {ESCALATION_CATEGORY_LABELS[escalation.category]}
                </span>
                <StatusBadge kind="escalationStatus" status={escalation.status} />
                <Link
                  to="/$tenant/app/v/$ventureId/help"
                  params={{ tenant, ventureId }}
                  onClick={onLeave}
                  className="text-small font-medium underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
                >
                  Review
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function MemoryProposal({
  ventureId,
  memory,
  canWrite,
}: {
  ventureId: string;
  memory: MemoryObjectView;
  canWrite: boolean;
}) {
  const review = useMemoryReview(ventureId);
  const [decided, setDecided] = useState<'confirmed' | 'rejected' | null>(null);
  // A proposal decided elsewhere meanwhile (the conversation's own Keep row) shows that decision.
  const status = decided ?? (memory.status === 'proposed' ? null : memory.status);
  const pending = review.isPending ? review.variables.action : null;

  // The one approve/reject path in the app (S8's review hook): optimistic lists, batch route, rollback.
  const decide = (choice: 'approve' | 'reject') => {
    review.mutate(
      { ids: [memory.id], action: choice },
      {
        onSuccess: (result) => {
          // Skipped: someone decided it meanwhile; the refetched item shows what happened to it.
          if (result.items.some((item) => item.id === memory.id)) {
            setDecided(choice === 'approve' ? 'confirmed' : 'rejected');
          }
        },
        onError: (error) => {
          const { title, description } = reviewFailure(choice, [memory.id], error);
          toast.error(title, { description });
        },
      },
    );
  };

  return (
    <li className="rounded-lg border border-border bg-card px-3.5 py-3">
      <p className="text-small font-medium">{memory.title}</p>
      <p className="mt-0.5 line-clamp-3 text-small text-muted-foreground">{displayContent(memory)}</p>
      <div className="mt-2.5 flex items-center gap-2">
        {status === 'confirmed' ? (
          <p className="flex items-center gap-1.5 text-small text-muted-foreground">
            <Check aria-hidden className="size-4" />
            Kept
          </p>
        ) : status === 'rejected' ? (
          <p className="text-small text-muted-foreground">Not kept</p>
        ) : status ? (
          <StatusBadge kind="memory" status={status} />
        ) : canWrite ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              loading={pending === 'approve'}
              disabled={review.isPending}
              onClick={() => {
                decide('approve');
              }}
              aria-label={`Keep: ${memory.title}`}
            >
              Keep
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={pending === 'reject'}
              disabled={review.isPending}
              onClick={() => {
                decide('reject');
              }}
              aria-label={`Not now: ${memory.title}`}
            >
              Not now
            </Button>
          </>
        ) : null}
      </div>
    </li>
  );
}
