import type {
  EscalationView,
  MemoryCandidate,
  MemoryObjectView,
  NextAction,
  SessionView,
  TurnView,
} from '@foundry/contracts';
import { useNavigate } from '@tanstack/react-router';
import { Bot, RotateCcw, UserRound } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { SkeletonText } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { announce } from '@/components/a11y/live-announcer';
import { errorMessage } from '@/lib/api/errors';
import type { TurnBlocked, TurnStreamError, TurnStreamState } from '@/lib/api/hooks/turn-stream';
import { formatDateTime, formatRelative, isoString } from '@/lib/format';
import { formatWait, useSecondsUntil } from '@/lib/hooks/use-countdown';
import { useCreateVentureMemory, useMemoryActions } from '@/features/memory/api';
import { findMemoryForCandidate } from '@/features/memory/optimistic';

import { BlockedPanel } from './blocked-panel';
import { ModeBadge } from './modes';
import type { TurnProgress } from './progress';
import { CoachResponseView, type CandidateBinding } from './response/coach-response';
import { TurnFeedback } from './turn-feedback';
import { TurnProgressList } from './turn-progress';
import { useCoachWorkspace } from './workspace';

function Speaker({
  kind,
  name,
  children,
}: {
  kind: 'founder' | 'coach';
  name: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px]">
      <span
        aria-hidden
        className="flex size-6 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground"
      >
        {kind === 'coach' ? <Bot className="size-3.5" /> : <UserRound className="size-3.5" />}
      </span>
      <span className="font-semibold">{name}</span>
      {kind === 'coach' ? (
        <span className="rounded-sm border border-border-strong px-1 text-[10px] leading-4 font-semibold tracking-wide uppercase">
          AI
        </span>
      ) : null}
      {children}
    </div>
  );
}

export function FounderMessage({
  text,
  at,
  mode,
  showMode,
}: {
  text: string;
  at: string | null;
  mode: TurnView['mode'];
  showMode: boolean;
}) {
  return (
    <div className="rounded-xl bg-muted/60 px-4 py-3">
      <Speaker kind="founder" name="You">
        {showMode ? <ModeBadge mode={mode} /> : null}
        {at ? (
          <time dateTime={isoString(at)} title={formatDateTime(at)} className="text-xs text-muted-foreground">
            {formatRelative(at)}
          </time>
        ) : null}
      </Speaker>
      <p className="text-[15px] leading-7 whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p>
    </div>
  );
}

interface TurnItemProps {
  turn: TurnView;
  previousMode: TurnView['mode'] | null;
  session: SessionView;
  tenant: string;
  ventureId: string;
  canEdit: boolean;
  memoryItems: MemoryObjectView[] | undefined;
  memoryLoading: boolean;
  escalations: EscalationView[] | undefined;
  /** Null when follow-ups can be sent; otherwise the reason they can't. */
  followUpDisabledReason: string | null;
  onFollowUp: (question: string) => void;
  onRetry: (text: string, mode: TurnView['mode']) => void;
  onRequestEscalation: (turn: TurnView) => void;
  onEditMemory: (memory: MemoryObjectView) => void;
  /**
   * The live `turn.blocked` event of a turn blocked in this browser session (the stored `turn.blocked`
   * detail carries the same fields after a reload).
   */
  liveBlocked: TurnBlocked | null;
}

/** One exchange: the founder's message and Foundry Guide's structured answer (or a support panel). */
export function TurnItem({
  turn,
  previousMode,
  session,
  tenant,
  ventureId,
  canEdit,
  memoryItems,
  memoryLoading,
  escalations,
  followUpDisabledReason,
  onFollowUp,
  onRetry,
  onRequestEscalation,
  onEditMemory,
  liveBlocked,
}: TurnItemProps) {
  const navigate = useNavigate();
  const { showEvidence } = useCoachWorkspace();
  const { run, pendingId } = useMemoryActions(ventureId);
  const { createMemory } = useCreateVentureMemory(ventureId);
  const [savingIndex, setSavingIndex] = useState<number | null>(null);
  const [savingTitle, setSavingTitle] = useState<string | null>(null);
  const response = turn.response;

  const onOpenEvidence = useCallback(
    (key: string) => {
      showEvidence(turn.id, key);
    },
    [showEvidence, turn.id],
  );

  const candidates = useMemo<CandidateBinding[]>(
    () =>
      (response?.memory_candidates ?? []).map((candidate) => ({
        candidate,
        memory: memoryItems ? findMemoryForCandidate(memoryItems, turn.id, candidate) : null,
      })),
    [response, memoryItems, turn.id],
  );

  const savedActions = useMemo(() => {
    const saved = new Set<number>();
    if (!memoryItems || !response) return saved;
    response.next_actions.forEach((action, index) => {
      if (
        findMemoryForCandidate(memoryItems, turn.id, { type: 'action', title: action.action.slice(0, 200) })
      ) {
        saved.add(index);
      }
    });
    return saved;
  }, [memoryItems, response, turn.id]);

  const sourceRefs = [
    { kind: 'turn' as const, id: turn.id, label: `Coach answer ${turn.ordinal}` },
    { kind: 'session' as const, id: session.id, label: 'Coaching session' },
  ];

  const saveAction = async (action: NextAction, index: number) => {
    setSavingIndex(index);
    try {
      await createMemory({
        type: 'action',
        title: action.action.slice(0, 200),
        content: [
          action.action,
          action.owner ? `Owner: ${action.owner}` : null,
          action.target_date ? `Target: ${action.target_date}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
        attributes: {
          owner: action.owner || undefined,
          due: action.target_date ?? undefined,
          status: 'open',
        },
        sourceRefs,
      });
      toast.success('Saved as an action');
      announce('Saved as an action');
    } catch (error) {
      toast.error('Couldn’t save the action', { description: errorMessage(error) });
    } finally {
      setSavingIndex(null);
    }
  };

  const saveCandidate = async (candidate: MemoryCandidate) => {
    setSavingTitle(candidate.title);
    try {
      const memory = await createMemory({
        type: candidate.type,
        title: candidate.title.slice(0, 200),
        content: candidate.content,
        sourceRefs,
      });
      toast.success(memory.status === 'proposed' ? 'Saved — waiting for approval' : 'Saved to memory');
    } catch (error) {
      toast.error('Couldn’t save to memory', { description: errorMessage(error) });
    } finally {
      setSavingTitle(null);
    }
  };

  const existingEscalation = escalations?.find((e) => e.turnId === turn.id) ?? null;
  const showMode = previousMode !== null ? previousMode !== turn.mode : turn.mode !== session.mode;

  let body: ReactNode;
  if (turn.status === 'completed' && response) {
    body = (
      <CoachResponseView
        turn={turn}
        response={response}
        onOpenEvidence={onOpenEvidence}
        onFollowUp={onFollowUp}
        followUpDisabledReason={followUpDisabledReason}
        nextActions={{
          saved: savedActions,
          savingIndex,
          onSave: canEdit
            ? (action, index) => {
                void saveAction(action, index);
              }
            : undefined,
        }}
        candidates={candidates}
        memory={{
          state: session.privacy === 'ephemeral' ? 'ephemeral' : memoryLoading ? 'loading' : 'ready',
          canEdit,
          pendingId,
          onApprove: (memory) => {
            run(memory.id, { action: 'approve' });
          },
          onReject: (memory) => {
            run(memory.id, { action: 'reject' });
          },
          onEdit: onEditMemory,
          onSave: (candidate) => {
            void saveCandidate(candidate);
          },
          savingTitle,
        }}
        escalation={{
          existing: existingEscalation,
          onRequest: canEdit
            ? () => {
                onRequestEscalation(turn);
              }
            : undefined,
          onView: (escalation) =>
            void navigate({
              to: '/$tenant/app/ventures/$ventureId/escalations',
              params: { tenant, ventureId },
              search: { id: escalation.id },
            }),
        }}
        footer={canEdit ? <TurnFeedback turnId={turn.id} /> : undefined}
      />
    );
  } else if (turn.status === 'blocked') {
    // After a reload the stored detail (`turn.blocked`) brings back the support message and resources.
    const blocked = liveBlocked ?? turn.blocked;
    body = (
      <BlockedPanel
        tenant={tenant}
        ventureId={ventureId}
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
          canEdit && session.status === 'active' && !followUpDisabledReason ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onRetry(turn.founderText, turn.mode);
              }}
            >
              <RotateCcw aria-hidden />
              Ask again
            </Button>
          ) : null
        }
      >
        Nothing was saved from it. You can ask again.
      </Alert>
    );
  }

  return (
    <article
      id={`turn-${turn.id}`}
      aria-label={`Exchange ${turn.ordinal}`}
      className="grid scroll-mt-40 gap-4"
    >
      <FounderMessage text={turn.founderText} at={turn.createdAt} mode={turn.mode} showMode={showMode} />
      <div className="px-1">
        <Speaker kind="coach" name={session.personaName}>
          {turn.completedAt ? (
            <time
              dateTime={isoString(turn.completedAt)}
              title={formatDateTime(turn.completedAt)}
              className="text-xs text-muted-foreground"
            >
              {formatRelative(turn.completedAt)}
            </time>
          ) : null}
          {response && turn.status === 'completed' ? (
            <CopyButton value={response.answer} label="Copy answer" size="icon-xs" className="ml-auto" />
          ) : null}
        </Speaker>
        {body}
      </div>
    </article>
  );
}

interface PendingTurnProps {
  state: TurnStreamState;
  progress: TurnProgress;
  mode: TurnView['mode'];
  personaName: string;
  tenant: string;
  ventureId: string;
  canRetry: boolean;
  onRetry: () => void;
  onEdit: () => void;
  onRequestSupport?: () => void;
}

/** The exchange currently streaming (or that just stopped/failed before it was saved). */
export function PendingTurn({
  state,
  progress,
  mode,
  personaName,
  tenant,
  ventureId,
  canRetry,
  onRetry,
  onEdit,
  onRequestSupport,
}: PendingTurnProps) {
  if (!state.pendingText) return null;
  return (
    <article aria-label="Current exchange" aria-busy={state.status === 'streaming'} className="grid gap-4">
      <FounderMessage text={state.pendingText} at={null} mode={mode} showMode={false} />
      <div className="px-1">
        <Speaker kind="coach" name={personaName} />
        <TurnProgressList progress={progress} className="mb-3" />
        {state.status === 'streaming' ? (
          <SkeletonText lines={3} className="max-w-2xl" />
        ) : state.status === 'blocked' && state.blocked ? (
          <BlockedPanel
            tenant={tenant}
            ventureId={ventureId}
            supportMessage={state.blocked.supportMessage}
            reason={state.blocked.reason}
            escalationId={state.blocked.escalationId}
            onRequestSupport={onRequestSupport}
          />
        ) : state.status === 'failed' && state.error ? (
          <TurnFailure
            error={state.error}
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
            You stopped this answer. Nothing from it was saved.
          </Alert>
        ) : null}
      </div>
    </article>
  );
}

/**
 * A turn that ended in `turn.error` (or a failed request). Honours the server's wait: while a message
 * the server is still answering is replayed automatically it says so and counts down; otherwise "Try
 * again" stays disabled until `retryAfterSeconds` / Retry-After has passed. The request id is shown for
 * support.
 */
export function TurnFailure({
  error,
  autoRetryAt,
  canRetry,
  onRetry,
  onEdit,
}: {
  error: TurnStreamError;
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
      title={replaying ? 'Still answering' : 'Foundry Guide couldn’t answer'}
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
          <span className="sr-only">Foundry Guide will check again automatically.</span>
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
