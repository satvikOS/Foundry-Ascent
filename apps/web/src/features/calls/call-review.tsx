import type { CallSummary, MemoryObjectView, SessionView } from '@foundry/contracts';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Check, EyeOff, ListChecks, Phone, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { BlockedPanel } from '@/features/coach/blocked-panel';
import { useVentureEscalations } from '@/lib/api/hooks/escalations';
import { memoryItemQueryOptions } from '@/lib/api/hooks/memory';
import { sessionQueryOptions } from '@/lib/api/hooks/sessions';
import { canWrite as canWriteVenture } from '@/lib/auth/roles';
import { budgetEndLine, CALL_END_LINES } from '@/lib/realtime/call-api';
import type { CallEnded } from '@/lib/realtime/call-engine';
import { formatDate } from '@/lib/format';
import { ESCALATION_CATEGORY_LABELS } from '@/lib/labels';

import { MemorySaved, savedByIds } from '../chat/memory-saved';

import { takeReviewFocus, useCall } from './call-context';
import { callTimeline } from './timeline/call-timeline';
import { ConversationTimeline } from './timeline/ConversationTimeline';
import type { TimelineSource } from './timeline/timeline-model';
import { formatClock, spokenDuration } from './use-call-clock';
import { useCallConfig, useCallVeir, type CallVeir } from './use-call-veir';
import { VoiceSphere } from './voice-sphere';

/**
 * The review of the call that just ended in this conversation (rendered by CallReviewSlot): Call again opens the
 * call screen here and starts at once (the click lets the browser play sound); dismissing it, or leaving for a page
 * it links to, forgets the call.
 */
export function CallReviewView() {
  const { me, engine, snapshot } = useCall();
  const navigate = useNavigate();
  const [focusOnMount] = useState(takeReviewFocus);
  const { ventureId, sessionId, ended } = snapshot;
  const veir = useCallVeir(ventureId);
  // The conversation under the review is loaded already: nothing is requested for its privacy.
  const session = useQuery({ ...sessionQueryOptions(sessionId ?? ''), enabled: false });
  if (!engine || !ended || !ventureId || !sessionId || !veir) return null;
  const tenant = me.tenant.slug;
  return (
    <CallReviewCard
      tenant={tenant}
      ventureId={ventureId}
      veir={veir}
      ended={ended}
      canWrite={canWriteVenture(me, ventureId)}
      privacy={session.data?.session.privacy ?? null}
      focusOnMount={focusOnMount}
      timeline={callTimeline(engine).recorder}
      onCallAgain={() => {
        engine.reset();
        void navigate({
          to: '/$tenant/app/v/$ventureId/c/$sessionId',
          params: { tenant, ventureId, sessionId },
          search: { call: 1 },
        });
      }}
      onDismiss={() => {
        engine.reset();
      }}
      onLeave={() => {
        engine.reset();
      }}
    />
  );
}

interface CallReviewProps {
  tenant: string;
  ventureId: string;
  veir: CallVeir;
  ended: CallEnded;
  canWrite: boolean;
  /** The call's conversation: a private one (a one-off) keeps nothing, and the review says so. */
  privacy: SessionView['privacy'] | null;
  onCallAgain: () => void;
  /** Done with the review: the card goes (the call is forgotten). */
  onDismiss: () => void;
  /** Leaving for another page from the review (Human help, Knowledge): the call is over, forget it. */
  onLeave: () => void;
  /** The call's conversation timeline, measured in this page (in memory only); omitted when there is none. */
  timeline?: TimelineSource | null;
  /** The founder ended the call from its screen: focus lands here (the support first, if any). */
  focusOnMount?: boolean;
}

/**
 * "3 exchanges", or who spoke when there was no exchange, so the line never contradicts the timeline beside it.
 * Null when only the founder spoke (the timeline shows it; there is nothing to count).
 */
export function exchangesLine(
  exchanges: number,
  spoke: { veir: boolean; student: boolean },
  name: string,
): string | null {
  if (exchanges > 0) return `${String(exchanges)} exchange${exchanges === 1 ? '' : 's'}`;
  if (spoke.student) return null;
  return spoke.veir ? `Only ${name} spoke` : 'Nothing was said';
}

/**
 * The session review (design-spec §11): after a call (`POST /calls/:id/end`) the founder is back in the
 * conversation, and this card closes its transcript. It holds any support the call was showing, how long the call
 * was and why it ended, the call's timeline, a quiet "Conversation saved" with what the vEIR saved to Knowledge (a
 * private call says it keeps nothing), the next actions it suggested and any request for a person it drafted, and
 * Call again. The transcript itself is already above it.
 */
export function CallReviewCard({
  tenant,
  ventureId,
  veir,
  ended,
  canWrite,
  privacy,
  onCallAgain,
  onDismiss,
  onLeave,
  timeline = null,
  focusOnMount = false,
}: CallReviewProps) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const supportRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Support the call was showing comes first, and focus with it.
    if (focusOnMount) (supportRef.current ?? headingRef.current)?.focus();
  }, [focusOnMount]);
  const summary = ended.summary;
  const exchanges = summary?.turnCount ?? ended.turnCount;
  const turns = timeline?.turns() ?? [];
  const spoke = {
    veir: turns.some((turn) => turn.speaker === 'veir'),
    student: turns.some((turn) => turn.speaker === 'student'),
  };
  const said = exchangesLine(exchanges, spoke, veir.shortName);
  // Ended for its budget: the refreshed call settings tell call minutes from the day's AI allowance.
  const config = useCallConfig(ventureId, ended.reason === 'budget');
  const endLine =
    ended.reason === 'budget'
      ? budgetEndLine(config.data?.remainingMinutesToday)
      : CALL_END_LINES[ended.reason];
  // Ended out of view (no focus moves here): say so once, politely.
  const announced = useRef(false);
  useEffect(() => {
    if (focusOnMount || announced.current) return;
    announced.current = true;
    announce(endLine ? `Call ended. ${endLine}` : 'Call ended.');
  }, [focusOnMount, endLine]);

  return (
    <section
      aria-labelledby="call-review-heading"
      data-slot="call-review"
      className="grid gap-6 rounded-2xl border border-border-card bg-card p-5 shadow-sm sm:p-6"
    >
      {ended.blocked ? (
        // The call ended while it showed support (crisis lines, a request for a person): it stays, above the
        // review, until the founder leaves it. Following its link leaves the call behind too.
        <div
          ref={supportRef}
          role="region"
          aria-label="Support"
          tabIndex={-1}
          className="outline-none"
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
      <header className="flex items-start gap-3">
        <VoiceSphere state="idle" size="2.25rem" reducedMotion className="mt-0.5 shrink-0" />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h2
            id="call-review-heading"
            ref={headingRef}
            tabIndex={-1}
            className="font-serif text-subheading font-normal outline-none"
          >
            Call ended
          </h2>
          <p className="text-small text-muted-foreground">
            <span className="tabular" aria-hidden>
              {formatClock(ended.durationSeconds)}
            </span>
            <span className="sr-only">{spokenDuration(ended.durationSeconds)}</span>
            {said ? ` · ${said}` : null}
          </p>
          {endLine ? (
            <p role="status" className="text-small text-pretty text-muted-foreground">
              {endLine}
            </p>
          ) : null}
        </div>
        <SimpleTooltip content="Dismiss">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Dismiss call review"
            onClick={onDismiss}
            className="-mt-1 -mr-1 shrink-0 text-muted-foreground"
          >
            <X aria-hidden />
          </Button>
        </SimpleTooltip>
      </header>
      {turns.length > 0 && timeline ? (
        // The whole call fills the bar (at least ten seconds' worth): it is over, nothing grows at the right.
        <ConversationTimeline
          source={timeline}
          names={{ veir: veir.name, student: 'You' }}
          legend
          minSpanMs={10_000}
        />
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
        <p role="status" className="text-small text-muted-foreground">
          {ended.summaryError ? `The summary couldn’t load. ${ended.summaryError}` : 'Loading…'}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={onCallAgain} disabled={!canWrite}>
          <Phone aria-hidden />
          Call again
        </Button>
      </div>
    </section>
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
  // Show pending suggestions and previously approved items as they stand now.
  const savedIds = remembered ? [...(summary.memoryKeptIds ?? []), ...summary.memoryProposalIds] : [];
  const memories = useQueries({ queries: savedIds.map((id) => memoryItemQueryOptions(id)) });
  const saved = savedByIds(
    savedIds,
    memories.map((query) => query.data).filter((memory): memory is MemoryObjectView => memory !== undefined),
  );
  const escalations = useVentureEscalations(ventureId);
  const drafted = (escalations.data ?? []).filter((e) => summary.escalationIds.includes(e.id));
  // Nothing to say (a call where nothing was said): no empty block under the timeline.
  if (!isPrivate && !remembered && summary.nextActions.length === 0 && summary.escalationIds.length === 0) {
    return null;
  }

  return (
    <div className="grid w-full gap-6">
      {isPrivate ? (
        <p data-testid="call-private" className="flex items-center gap-1.5 text-small text-muted-foreground">
          <EyeOff aria-hidden className="size-4" />
          Private: nothing is remembered.
        </p>
      ) : remembered ? (
        // Distinguish the saved session record from memory that still needs approval.
        <div className="grid justify-items-start gap-1">
          <p
            data-testid="call-remembered"
            className="flex items-center gap-1.5 text-small text-muted-foreground"
          >
            <Check aria-hidden className="size-4" />
            Conversation saved.
          </p>
          <MemorySaved
            tenant={tenant}
            ventureId={ventureId}
            memories={saved}
            // Leaving for Knowledge: the call is over, forget it (no "Call ended" bar follows the founder there).
            onNavigate={onLeave}
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
