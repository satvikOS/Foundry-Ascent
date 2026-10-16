import type {
  EscalationView,
  MemoryCandidate,
  MemoryObjectView,
  SessionView,
  TurnView,
} from '@foundry/contracts';
import { useNavigate } from '@tanstack/react-router';
import { RotateCcw } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { UserAvatar } from '@/components/faces/user-avatar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/ui/markdown';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api/errors';
import type { TurnBlocked, TurnStreamError, TurnStreamState } from '@/lib/api/hooks/turn-stream';
import { formatDateTime } from '@/lib/format';
import { formatWait, useSecondsUntil } from '@/lib/hooks/use-countdown';
import { useProposalDecision } from '@/features/knowledge/review-api';
import { useCreateVentureMemory } from '@/features/memory/api';
import { findMemoryForCandidate } from '@/features/memory/optimistic';

import { BlockedPanel } from '../coach/blocked-panel';
import type { TurnProgress } from '../coach/progress';
import { CitationKey } from '../coach/response/evidence-chip';
import { TurnProgressList } from '../coach/turn-progress';
import { isActionSaved, useAddAction } from './actions';
import type { CandidateBinding } from './memory-suggestions';
import { usePanelState } from './panel-state';
import { ANSWER_PROSE, VeirAnswer } from './veir-answer';

/** A founder's or teammate's message: a right-aligned bubble in the interface face. */
function FounderMessage({
  text,
  author,
  at,
}: {
  text: string;
  /**
   * The conversation's starter, whose face sits beside the bubble. Turns carry no author yet, so screen
   * readers hear a neutral "Message" rather than a name that may not be the writer's.
   */
  author: string;
  at: string | null;
}) {
  return (
    <div className="relative flex justify-end">
      <p
        className="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-[0.9375rem] leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]"
        title={at ? formatDateTime(at) : undefined}
      >
        <span className="sr-only">Message: </span>
        <span>{text}</span>
      </p>
      <UserAvatar
        name={author}
        size="sm"
        decorative
        className="absolute top-1.5 -right-10 hidden @min-[54rem]/conv:inline-flex"
      />
    </div>
  );
}

/** The vEIR's side of an exchange: its face sits in the left gutter on wide screens. */
function VeirMessage({
  personaName,
  portraitUrl,
  children,
}: {
  personaName: string;
  portraitUrl?: string | null | undefined;
  children: ReactNode;
}) {
  return (
    <div className="relative min-w-0">
      <PersonaAvatar
        name={personaName}
        portraitUrl={portraitUrl}
        size="sm"
        decorative
        className="absolute top-0.5 -left-10 hidden @min-[54rem]/conv:inline-flex"
      />
      <span className="sr-only">{personaName} said: </span>
      {children}
    </div>
  );
}

/** The vEIR's opening line (the notebook opener stored on the conversation): its first message. */
export function OpenerMessage({
  text,
  personaName,
  portraitUrl,
}: {
  text: string;
  personaName: string;
  portraitUrl?: string | null | undefined;
}) {
  return (
    <section aria-label={`${personaName} opened the conversation`}>
      <VeirMessage personaName={personaName} portraitUrl={portraitUrl}>
        <Markdown className={ANSWER_PROSE}>{text}</Markdown>
      </VeirMessage>
    </section>
  );
}

interface StoredExchangeProps {
  turn: TurnView;
  session: SessionView;
  personaName: string;
  portraitUrl?: string | null | undefined;
  tenant: string;
  ventureId: string;
  canEdit: boolean;
  /** The conversation's latest exchange. */
  latest: boolean;
  memoryItems: MemoryObjectView[] | undefined;
  memoryLoading: boolean;
  escalations: EscalationView[] | undefined;
  /** Null when a new message can be sent; otherwise why not. */
  sendDisabledReason: string | null;
  onRetry: (text: string) => void;
  onRequestEscalation: (turn: TurnView) => void;
  /** The live `turn.blocked` event when the turn was blocked in this tab (a reload reads `turn.blocked`). */
  liveBlocked: TurnBlocked | null;
}

/** One stored exchange: the person's message and the vEIR's answer (or the support panel). */
export function StoredExchange({
  turn,
  session,
  personaName,
  portraitUrl,
  tenant,
  ventureId,
  canEdit,
  latest,
  memoryItems,
  memoryLoading,
  escalations,
  sendDisabledReason,
  onRetry,
  onRequestEscalation,
  liveBlocked,
}: StoredExchangeProps) {
  const navigate = useNavigate();
  const { showSources } = usePanelState();
  const { decide, pendingIds } = useProposalDecision(ventureId);
  const { createMemory } = useCreateVentureMemory(ventureId);
  const { add, savingKey } = useAddAction(ventureId);
  const [savingTitle, setSavingTitle] = useState<string | null>(null);
  const response = turn.response;

  const onOpenSource = useCallback(
    (key: string) => {
      showSources(turn.id, key);
    },
    [showSources, turn.id],
  );

  const bindings = useMemo<CandidateBinding[]>(
    () =>
      (response?.memory_candidates ?? []).map((candidate) => ({
        candidate,
        memory: memoryItems ? findMemoryForCandidate(memoryItems, turn.id, candidate) : null,
      })),
    [response, memoryItems, turn.id],
  );

  const turnSource = { kind: 'turn' as const, id: turn.id };
  const savedActions = new Set(
    (response?.next_actions ?? []).flatMap((action, index) =>
      isActionSaved(memoryItems, action, turnSource) ? [index] : [],
    ),
  );
  const sourceRefs = [
    { ...turnSource, label: `Answer ${turn.ordinal}` },
    { kind: 'session' as const, id: session.id, label: 'Conversation' },
  ];

  const saveCandidate = async (candidate: MemoryCandidate) => {
    setSavingTitle(candidate.title);
    try {
      const memory = await createMemory({
        type: candidate.type,
        title: candidate.title.slice(0, 200),
        content: candidate.content,
        sourceRefs,
      });
      toast.success(memory.status === 'proposed' ? 'Saved — waiting for approval' : 'Kept');
    } catch (error) {
      toast.error('Couldn’t keep this', { description: errorMessage(error) });
    } finally {
      setSavingTitle(null);
    }
  };

  const existingEscalation = escalations?.find((e) => e.turnId === turn.id) ?? null;

  let body: ReactNode;
  if (turn.status === 'completed' && response) {
    body = (
      <VeirAnswer
        turn={turn}
        response={response}
        personaName={personaName}
        latest={latest}
        summarised={session.status === 'ended' && session.recap !== null}
        canEdit={canEdit}
        onOpenSource={onOpenSource}
        onShowSources={() => {
          showSources(turn.id);
        }}
        nextActions={{
          saved: savedActions,
          savingIndex:
            savingKey?.startsWith(`${turn.id}:`) === true
              ? Number(savingKey.slice(turn.id.length + 1))
              : null,
          onAdd: (action, index) => {
            void add(action, sourceRefs, `${turn.id}:${index}`);
          },
        }}
        memory={
          session.privacy === 'ephemeral' || !canEdit
            ? null
            : {
                bindings,
                controls: {
                  loading: memoryLoading,
                  pendingId: pendingIds[0] ?? null,
                  savingTitle,
                  onKeep: (memory) => {
                    decide([memory.id], 'approve');
                  },
                  onDismiss: (memory) => {
                    decide([memory.id], 'reject');
                  },
                  onSave: (candidate) => {
                    void saveCandidate(candidate);
                  },
                },
              }
        }
        escalation={{
          existing: existingEscalation,
          onRequest: canEdit
            ? () => {
                onRequestEscalation(turn);
              }
            : undefined,
          onView: (escalation) =>
            void navigate({
              to: '/$tenant/app/v/$ventureId/help',
              params: { tenant, ventureId },
              search: { id: escalation.id },
            }),
        }}
      />
    );
  } else if (turn.status === 'blocked') {
    // After a reload the stored detail (`turn.blocked`) brings back the support message and resources.
    const blocked = liveBlocked ?? turn.blocked;
    body = (
      <BlockedPanel
        tenant={tenant}
        ventureId={ventureId}
        personaName={personaName}
        supportMessage={blocked?.supportMessage ?? null}
        reason={blocked?.reason ?? null}
        escalationId={blocked?.escalationId ?? existingEscalation?.id ?? null}
        onRequestSupport={
          canEdit
            ? () => {
                onRequestEscalation(turn);
              }
            : undefined
        }
      />
    );
  } else {
    body = (
      <Alert
        variant="warning"
        title={turn.status === 'failed' ? 'This answer couldn’t be completed' : 'This answer didn’t finish'}
        action={
          canEdit && session.status === 'active' && !sendDisabledReason ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onRetry(turn.founderText);
              }}
            >
              <RotateCcw aria-hidden />
              Ask again
            </Button>
          ) : null
        }
      >
        Nothing was saved from it.
      </Alert>
    );
  }

  return (
    <article
      id={`turn-${turn.id}`}
      aria-label={`Exchange ${turn.ordinal}`}
      className="grid scroll-mt-24 gap-6"
    >
      <FounderMessage text={turn.founderText} author={session.startedBy.displayName} at={turn.createdAt} />
      <VeirMessage personaName={personaName} portraitUrl={portraitUrl}>
        {body}
      </VeirMessage>
    </article>
  );
}

interface LiveExchangeProps {
  state: TurnStreamState;
  progress: TurnProgress;
  author: string;
  personaName: string;
  portraitUrl?: string | null | undefined;
  tenant: string;
  ventureId: string;
  canRetry: boolean;
  onRetry: () => void;
  onEdit: () => void;
  onRequestSupport?: (() => void) | undefined;
}

const renderStreamedCitation = (key: string) => <CitationKey evidenceKey={key} />;

/**
 * The exchange being answered (or one that stopped or failed before it was saved). Validated answer
 * units render as they arrive; the stored answer replaces them on completion, in the same place and
 * the same type, so the text does not jump.
 */
export function LiveExchange({
  state,
  progress,
  author,
  personaName,
  portraitUrl,
  tenant,
  ventureId,
  canRetry,
  onRetry,
  onEdit,
  onRequestSupport,
}: LiveExchangeProps) {
  if (!state.pendingText) return null;
  const streaming = state.status === 'streaming';
  return (
    <article aria-label="Current exchange" aria-busy={streaming} className="grid scroll-mt-24 gap-6">
      <FounderMessage text={state.pendingText} author={author} at={null} />
      <VeirMessage personaName={personaName} portraitUrl={portraitUrl}>
        {state.streamedText ? (
          <Markdown renderCitation={renderStreamedCitation} className={ANSWER_PROSE}>
            {state.streamedText}
          </Markdown>
        ) : null}
        {streaming || state.status === 'completed' ? (
          <TurnProgressList progress={progress} className={state.streamedText ? 'mt-3' : undefined} />
        ) : null}
        {state.status === 'blocked' && state.blocked ? (
          <BlockedPanel
            tenant={tenant}
            ventureId={ventureId}
            personaName={personaName}
            supportMessage={state.blocked.supportMessage}
            reason={state.blocked.reason}
            escalationId={state.blocked.escalationId}
            onRequestSupport={onRequestSupport}
          />
        ) : state.status === 'failed' && state.error ? (
          <TurnFailure
            error={state.error}
            personaName={personaName}
            autoRetryAt={state.autoRetryAt}
            canRetry={canRetry}
            onRetry={onRetry}
            onEdit={onEdit}
          />
        ) : state.status === 'cancelled' ? (
          <Alert
            title="Stopped"
            action={
              <Button size="sm" variant="secondary" onClick={onEdit}>
                Edit and resend
              </Button>
            }
          >
            Nothing from this answer was saved.
          </Alert>
        ) : null}
      </VeirMessage>
    </article>
  );
}

/**
 * A turn that ended in `turn.error` (or a failed request). Honours the server's wait: while a message the
 * server is still answering is replayed automatically it says so and counts down; otherwise "Try again"
 * stays disabled until `retryAfterSeconds` / Retry-After has passed. The request id is shown for support.
 */
export function TurnFailure({
  error,
  personaName,
  autoRetryAt,
  canRetry,
  onRetry,
  onEdit,
}: {
  error: TurnStreamError;
  personaName: string;
  autoRetryAt: number | null;
  canRetry: boolean;
  onRetry: () => void;
  onEdit: () => void;
}) {
  const replayIn = useSecondsUntil(autoRetryAt);
  const waitFor = useSecondsUntil(error.retryAt);
  const replaying = autoRetryAt !== null;
  return (
    <Alert
      variant={replaying ? 'info' : 'destructive'}
      live={replaying ? 'status' : 'alert'}
      title={replaying ? 'Still answering' : `${personaName} couldn’t answer`}
      action={
        <>
          {error.retryable && canRetry && !replaying ? (
            <Button size="sm" variant="secondary" onClick={onRetry} disabled={waitFor > 0}>
              <RotateCcw aria-hidden />
              {waitFor > 0 ? `Try again in ${formatWait(waitFor)}` : 'Try again'}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onEdit}>
            Edit message
          </Button>
        </>
      }
    >
      {error.message}
      {replaying ? (
        <span className="mt-1 block" data-testid="turn-auto-retry">
          {/* The ticking countdown is visual only; screen readers hear the steady sentence once. */}
          <span aria-hidden>
            {replayIn > 0 ? `Checking again in ${formatWait(replayIn)}…` : 'Checking again…'}
          </span>
          <span className="sr-only">{personaName} will check again automatically.</span>
        </span>
      ) : null}
      {error.requestId ? (
        <span className="mt-1 block text-xs">
          Request ID <code className="font-mono">{error.requestId}</code>
        </span>
      ) : null}
    </Alert>
  );
}
