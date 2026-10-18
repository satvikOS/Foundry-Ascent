import type { CallSummary, MemoryObjectView, SessionView } from '@foundry/contracts';
import { useQueries } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, EyeOff, ListChecks, Phone } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { DisclosureBanner } from '@/components/disclosure-banner';
import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { BlockedPanel } from '@/features/coach/blocked-panel';
import { useVentureEscalations } from '@/lib/api/hooks/escalations';
import { memoryItemQueryOptions } from '@/lib/api/hooks/memory';
import { budgetEndLine, CALL_END_LINES } from '@/lib/realtime/call-api';
import type { CallEnded } from '@/lib/realtime/call-engine';
import { formatDate } from '@/lib/format';
import { ESCALATION_CATEGORY_LABELS } from '@/lib/labels';

import { MemorySaved, savedByIds } from '../chat/memory-saved';

import { formatClock, spokenDuration } from './use-call-clock';
import { useCallConfig, type CallVeir } from './use-call-veir';

interface CallSummaryProps {
  tenant: string;
  ventureId: string;
  veir: CallVeir;
  ended: CallEnded;
  canWrite: boolean;
  /** The call's conversation: a private one (a one-off) keeps nothing, and the summary says so. */
  privacy: SessionView['privacy'] | null;
  onBackToConversation: () => void;
  onCallAgain: () => void;
  /** Leaving for another page from the summary (Human help): the call is over, forget it. */
  onLeave: () => void;
}

/**
 * After a call (`POST /calls/:id/end`): how long it was, a quiet "Remembered" with what the vEIR saved to
 * Knowledge (kept automatically; a private call says it keeps nothing), the next actions it suggested and any
 * request for a person it drafted. The transcript itself is already in the conversation.
 */
export function CallSummaryPanel({
  tenant,
  ventureId,
  veir,
  ended,
  canWrite,
  privacy,
  onBackToConversation,
  onCallAgain,
  onLeave,
}: CallSummaryProps) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const supportRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Support the call was showing comes first, and focus with it.
    (supportRef.current ?? headingRef.current)?.focus();
  }, []);
  const summary = ended.summary;
  const exchanges = summary?.turnCount ?? ended.turnCount;
  // Ended for its budget: the refreshed call settings tell call minutes from the day's AI allowance.
  const config = useCallConfig(ventureId, ended.reason === 'budget');
  const endLine =
    ended.reason === 'budget'
      ? budgetEndLine(config.data?.remainingMinutesToday)
      : CALL_END_LINES[ended.reason];

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center px-4 pt-6 pb-8 text-center sm:pt-10">
      {ended.blocked ? (
        // The call ended while it showed support (crisis lines, a request for a person): it stays, above the
        // summary, until the founder leaves it. Following its link leaves the call behind too.
        <div
          ref={supportRef}
          role="region"
          aria-label="Support"
          tabIndex={-1}
          className="mb-8 w-full text-left outline-none"
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest('a')) onLeave();
          }}
        >
          <BlockedPanel
            tenant={tenant}
            ventureId={ventureId}
            supportMessage={ended.blocked.supportMessage}
            reason={ended.blocked.reason}
            escalationId={ended.blocked.escalationId}
            personaName={veir.name}
          />
        </div>
      ) : null}
      <PersonaAvatar name={veir.name} portraitUrl={veir.portraitUrl} size="xl" decorative />
      <h2 ref={headingRef} tabIndex={-1} className="mt-5 font-serif text-heading font-normal outline-none">
        Call ended
      </h2>
      <p className="mt-2 text-small text-muted-foreground">
        <span className="tabular" aria-hidden>
          {formatClock(ended.durationSeconds)}
        </span>
        <span className="sr-only">{spokenDuration(ended.durationSeconds)}</span>
        {exchanges > 0
          ? ` · ${String(exchanges)} exchange${exchanges === 1 ? '' : 's'}`
          : ' · Nothing was said.'}
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
          summary={summary}
          canWrite={canWrite}
          isPrivate={privacy === 'ephemeral'}
          supportShown={ended.blocked !== null}
          onLeave={onLeave}
        />
      ) : (
        <p role="status" className="mt-6 text-small text-muted-foreground">
          {ended.summaryError ? `The summary couldn’t load. ${ended.summaryError}` : 'Loading…'}
        </p>
      )}

      <div className="mt-8 flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row sm:justify-center">
        <Button variant="secondary" size="lg" onClick={onCallAgain} disabled={!canWrite}>
          <Phone aria-hidden />
          Call again
        </Button>
        <Button size="lg" onClick={onBackToConversation} aria-label="Back to conversation">
          Back
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
  summary,
  canWrite,
  isPrivate,
  supportShown,
  onLeave,
}: {
  tenant: string;
  ventureId: string;
  summary: CallSummary;
  canWrite: boolean;
  isPrivate: boolean;
  /**
   * The call ended while it showed support (crisis lines, a safety hand-over). What was said then is never
   * remembered, and under that support a line about memory is the wrong thing to say: none is shown.
   */
  supportShown: boolean;
  onLeave: () => void;
}) {
  const remembered = !isPrivate && !supportShown && canWrite && summary.turnCount > 0;
  // What the call saved to Knowledge, as it stands now (anything forgotten since is left out): kept by the vEIR
  // by itself, or saved before memory was kept automatically.
  const savedIds = remembered ? [...(summary.memoryKeptIds ?? []), ...summary.memoryProposalIds] : [];
  const memories = useQueries({ queries: savedIds.map((id) => memoryItemQueryOptions(id)) });
  const saved = savedByIds(
    savedIds,
    memories.map((query) => query.data).filter((memory): memory is MemoryObjectView => memory !== undefined),
  );
  const escalations = useVentureEscalations(ventureId);
  const drafted = (escalations.data ?? []).filter((e) => summary.escalationIds.includes(e.id));

  return (
    <div className="mt-6 grid w-full gap-6 text-left">
      {isPrivate ? (
        <p
          data-testid="call-private"
          className="flex items-center justify-center gap-1.5 text-small text-muted-foreground"
        >
          <EyeOff aria-hidden className="size-4" />
          Private: nothing is remembered.
        </p>
      ) : remembered ? (
        // A quiet "remembered" state: the call is kept with the conversation and the vEIR picks up from it
        // next time, so the founder can trust the next call knows.
        <div className="grid justify-items-center gap-1">
          <p
            data-testid="call-remembered"
            className="flex items-center justify-center gap-1.5 text-small text-muted-foreground"
          >
            <Check aria-hidden className="size-4" />
            Remembered for next time.
          </p>
          <MemorySaved
            tenant={tenant}
            ventureId={ventureId}
            memories={saved}
            // Leaving for Knowledge: the call is over, forget it (no "Call ended" bar follows the founder there).
            onNavigate={onLeave}
            className="justify-center"
          />
        </div>
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
          <ul className="divide-y divide-border border-y border-border">
            {drafted.map((escalation) => (
              <li key={escalation.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-3">
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
