import type { CoachMode, MemoryObjectView, TurnView } from '@foundry/contracts';
import { getRouteApi, Link } from '@tanstack/react-router';
import { ArrowLeft, EyeOff, FileCheck2, HandHelping, MessagesSquare, Play, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { DisclosureBanner } from '@/components/disclosure-banner';
import { Inspector } from '@/components/shell/inspector';
import { Alert } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api/errors';
import { useVentureEscalations } from '@/lib/api/hooks/escalations';
import { useMemory } from '@/lib/api/hooks/memory';
import { useEndSession, useSession } from '@/lib/api/hooks/sessions';
import { useTurnStream } from '@/lib/api/hooks/turn-stream';
import { useVenture } from '@/lib/api/hooks/ventures';
import { canWrite } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { formatDateTime, formatRelative, isoString, pluralize } from '@/lib/format';
import { useHotkeys } from '@/lib/hooks/use-hotkeys';
import { MODE_LABELS } from '@/lib/labels';
import { EscalationFlowDialog, type EscalationDraft } from '@/features/escalations/escalation-flow-dialog';
import { CorrectMemoryDialog } from '@/features/memory/memory-dialogs';

import { coachingAvailability } from './availability';
import { Composer, MAX_TURN_CHARS } from './composer';
import { MODE_DETAILS, ModeBadge } from './modes';
import { clearPendingCounterpart, pendingCounterpart } from './pending-counterpart';
import { deriveTurnProgress } from './progress';
import { SessionInspector } from './session-inspector';
import { SessionRecapView } from './session-recap';
import { sessionTitle } from './sessions-page';
import { PendingTurn, TurnItem } from './turn-item';
import { CoachWorkspaceProvider } from './workspace';

const routeApi = getRouteApi('/$tenant/app/ventures/$ventureId/coach/$sessionId');

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isInViewport(el: Element | null): boolean {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < window.innerHeight;
}

export function SessionPage() {
  const { sessionId } = routeApi.useParams();
  // Keyed by session: the router reuses this component across sessions, but the composer draft,
  // stream state and inspector selection belong to one session only.
  return (
    <CoachWorkspaceProvider key={sessionId}>
      <SessionCanvas />
    </CoachWorkspaceProvider>
  );
}

function SessionSkeleton() {
  return (
    <PageContainer size="narrow">
      <div aria-busy="true" className="grid gap-6">
        <span className="sr-only" role="status">
          Loading session…
        </span>
        <div className="grid gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <Skeleton className="h-16 w-full rounded-xl" />
        <SkeletonText lines={5} />
      </div>
    </PageContainer>
  );
}

function SessionCanvas() {
  const me = useRequiredMe();
  const { tenant, ventureId, sessionId } = routeApi.useParams();
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const detail = useSession(sessionId);
  const venture = useVenture(ventureId);
  const memory = useMemory(ventureId);
  const escalations = useVentureEscalations(ventureId);
  const stream = useTurnStream(sessionId, { ventureId });
  const endSession = useEndSession(ventureId);
  const canEdit = canWrite(me, ventureId);

  const [text, setText] = useState('');
  const [modeOverride, setModeOverride] = useState<CoachMode | null>(null);
  const [counterpart, setCounterpart] = useState(() => pendingCounterpart(sessionId) ?? '');
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [escalation, setEscalation] = useState<{ open: boolean; draft: EscalationDraft | null }>({
    open: false,
    draft: null,
  });
  const [editingMemory, setEditingMemory] = useState<MemoryObjectView | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingRef = useRef<HTMLDivElement | null>(null);
  const initialScrollDone = useRef(false);

  const session = detail.data?.session ?? null;
  const turns = useMemo(() => detail.data?.turns ?? [], [detail.data]);
  const lastTurnMode = turns.length > 0 ? (turns[turns.length - 1]?.mode ?? null) : null;
  const mode: CoachMode = modeOverride ?? lastTurnMode ?? session?.mode ?? 'diagnose';
  const availability = venture.data && session ? coachingAvailability(me, venture.data, session) : null;
  const ventureAvailability = venture.data ? coachingAvailability(me, venture.data) : null;
  const canSend = Boolean(availability?.available);
  const progress = deriveTurnProgress(stream.state);
  const { state } = stream;

  const focusComposer = useCallback(() => {
    textareaRef.current?.focus();
  }, []);
  useHotkeys({ '/': focusComposer });

  // First load of an active conversation: start at the latest exchange.
  useEffect(() => {
    if (initialScrollDone.current || !session || turns.length === 0) return;
    initialScrollDone.current = true;
    if (session.status !== 'active') return;
    const last = turns[turns.length - 1];
    if (last) document.getElementById(`turn-${last.id}`)?.scrollIntoView({ block: 'start' });
  }, [session, turns]);

  // Keep the streaming exchange in view.
  useEffect(() => {
    if (state.status === 'streaming' && state.pendingText !== null) {
      pendingRef.current?.scrollIntoView({
        block: 'nearest',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    }
  }, [state.status, state.pendingText, state.steps.length]);

  // Announce how a turn ended (content-free). Step-by-step progress is announced by TurnProgressList.
  // A replay that found the turn still being answered is retried automatically, so it is not a failure.
  const stillAnswering =
    state.status === 'failed' && state.error?.code === 'conflict' && state.error.retryAt !== undefined;
  useEffect(() => {
    if (stillAnswering) {
      announce('Still answering. Foundry Guide will check again shortly.');
      return;
    }
    switch (state.status) {
      case 'completed':
        announce('Response ready.');
        break;
      case 'blocked':
        announce('Foundry Guide handed this question to a person. Support options are shown.', 'assertive');
        break;
      case 'failed':
        announce('The response could not be completed.', 'assertive');
        break;
      case 'cancelled':
        announce('Stopped.');
        break;
      default:
        break;
    }
  }, [state.status, stillAnswering]);

  // When an answer arrives and the person was watching, bring its start into view.
  const completedTurnId = state.status === 'completed' ? (state.turn?.id ?? null) : null;
  useEffect(() => {
    if (!completedTurnId) return;
    const frame = requestAnimationFrame(() => {
      const el = document.getElementById(`turn-${completedTurnId}`);
      if (el && (isInViewport(pendingRef.current) || isInViewport(el))) {
        el.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      }
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [completedTurnId]);

  const send = useCallback(
    (raw: string, sendMode: CoachMode = mode) => {
      const value = raw.trim();
      if (!value || value.length > MAX_TURN_CHARS || !canSend || stream.isStreaming) return;
      setText('');
      const rehearsalCounterpart = sendMode === 'rehearse' ? counterpart.trim() : '';
      void stream
        .send({ text: value, mode: sendMode, ...(rehearsalCounterpart ? { rehearsalCounterpart } : {}) })
        .then((outcome) => {
          if (outcome === 'cancelled') {
            // Give the words back so nothing typed is lost.
            setText((current) => (current.trim() ? current : value));
          }
        });
    },
    [mode, canSend, stream, counterpart],
  );

  if (detail.isPending) return <SessionSkeleton />;
  if (detail.isError || session?.ventureId !== ventureId) {
    return (
      <PageContainer size="narrow">
        <PageHeader title="Session" />
        <ErrorState
          error={detail.error}
          title={detail.isError ? undefined : 'Session not found'}
          onRetry={detail.isError ? () => void detail.refetch() : undefined}
          action={
            <Button asChild variant="ghost" size="sm">
              <Link to="/$tenant/app/ventures/$ventureId/coach" params={{ tenant, ventureId }}>
                Back to sessions
              </Link>
            </Button>
          }
        />
      </PageContainer>
    );
  }

  const ended = session.status === 'ended';
  const view = ended ? (search.view ?? 'recap') : 'transcript';
  const liveTurnId = state.turnId;
  const liveInHistory = liveTurnId !== null && turns.some((t) => t.id === liveTurnId);
  const showPending =
    state.status !== 'idle' &&
    state.pendingText !== null &&
    !(liveInHistory && (state.status === 'completed' || state.status === 'blocked'));
  const visibleTurns = showPending && liveTurnId ? turns.filter((t) => t.id !== liveTurnId) : turns;
  const followUpDisabledReason = !canSend
    ? (availability?.reason ?? 'Coaching is unavailable right now.')
    : stream.isStreaming
      ? 'Wait for the current answer to finish.'
      : null;

  const requestEscalationForTurn = (turn: TurnView) => {
    const proposal = turn.response?.escalation;
    setEscalation({
      open: true,
      draft: {
        turnId: turn.id,
        category: proposal?.category ?? 'expert_judgment',
        priority: proposal?.priority ?? 'P2',
        requestedRole: proposal?.requested_role ?? 'eir',
        founderQuestion: turn.founderText.slice(0, 2000),
        desiredDecision: null,
      },
    });
  };
  const requestGeneralEscalation = () => {
    setEscalation({ open: true, draft: { turnId: null, founderQuestion: session.goal ?? '' } });
  };

  const confirmEndSession = () => {
    setConfirmEnd(false);
    stream.cancel();
    endSession.mutate(sessionId, {
      onSuccess: (result) => {
        clearPendingCounterpart(sessionId);
        toast.success(result.recap ? 'Session ended — your recap is ready' : 'Session ended');
        announce('Session ended');
        void navigate({ search: { view: 'recap' }, replace: true });
      },
      onError: (error) => {
        toast.error('Couldn’t end the session', { description: errorMessage(error) });
      },
    });
  };

  const persona = venture.data?.persona ?? null;

  const transcript = (
    <section aria-label="Transcript" className="grid gap-10">
      {visibleTurns.length === 0 && !showPending ? (
        ended ? (
          <EmptyState
            icon={MessagesSquare}
            title="No messages"
            description="This session ended before anything was asked."
          />
        ) : (
          <div className="rounded-xl border border-dashed border-border-strong p-6">
            <h2 className="text-base font-semibold tracking-tight">Ask your first question</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {MODE_LABELS[mode].description} Foundry Guide answers with cited evidence, labels what is fact
              versus inference, and ends with a challenge and next actions.
            </p>
            {canSend ? (
              <ul className="mt-4 flex flex-wrap gap-2" aria-label="Suggested openers">
                {[session.goal ? `Help me with this: ${session.goal}` : null, MODE_DETAILS[mode].example]
                  .filter((s): s is string => Boolean(s))
                  .map((suggestion) => (
                    <li key={suggestion}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-auto py-1.5 text-left whitespace-normal"
                        onClick={() => {
                          setText(suggestion.slice(0, MAX_TURN_CHARS));
                          focusComposer();
                        }}
                      >
                        {suggestion}
                      </Button>
                    </li>
                  ))}
              </ul>
            ) : null}
          </div>
        )
      ) : null}
      {visibleTurns.map((turn, index) => (
        <TurnItem
          key={turn.id}
          turn={turn}
          previousMode={index > 0 ? (visibleTurns[index - 1]?.mode ?? null) : null}
          session={session}
          tenant={tenant}
          ventureId={ventureId}
          canEdit={canEdit}
          memoryItems={memory.data}
          memoryLoading={memory.isPending}
          escalations={escalations.data}
          followUpDisabledReason={ended ? 'This session has ended.' : followUpDisabledReason}
          onFollowUp={(question) => {
            send(question);
          }}
          onRetry={(retryText, retryMode) => {
            send(retryText, retryMode);
          }}
          onRequestEscalation={requestEscalationForTurn}
          onEditMemory={setEditingMemory}
          liveBlocked={state.blocked?.turnId === turn.id ? state.blocked : null}
        />
      ))}
      {showPending ? (
        <div ref={pendingRef} className="scroll-mb-56">
          <PendingTurn
            state={state}
            progress={progress}
            mode={mode}
            personaName={session.personaName}
            tenant={tenant}
            ventureId={ventureId}
            canRetry={canSend}
            onRetry={() => {
              // Same text, mode and counterpart as the failed attempt, so an interrupted turn the API
              // already accepted is replayed (same Idempotency-Key) rather than answered twice.
              if (!canSend || stream.isStreaming) return;
              void stream.retry();
            }}
            onEdit={() => {
              const previous = state.pendingText ?? '';
              stream.reset();
              setText((current) => (current.trim() ? current : previous));
              focusComposer();
            }}
            onRequestSupport={canEdit ? requestGeneralEscalation : undefined}
          />
        </div>
      ) : null}
    </section>
  );

  return (
    <>
      <DisclosureBanner text={session.disclosure} />
      <PageContainer size="narrow" className="pb-4">
        <PageHeader
          eyebrow={
            <Link
              to="/$tenant/app/ventures/$ventureId/coach"
              params={{ tenant, ventureId }}
              className="inline-flex items-center gap-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <ArrowLeft aria-hidden className="size-3.5" />
              All sessions
            </Link>
          }
          title={sessionTitle(session)}
          actions={
            !ended && canEdit ? (
              <>
                <Button variant="ghost" size="sm" onClick={requestGeneralEscalation}>
                  <HandHelping aria-hidden />
                  Request support
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={endSession.isPending}
                  loadingText="Ending…"
                  onClick={() => {
                    setConfirmEnd(true);
                  }}
                >
                  <Square aria-hidden className="size-3.5" />
                  End session
                </Button>
              </>
            ) : null
          }
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            <ModeBadge mode={session.mode} />
            <StatusBadge kind="session" status={session.status} />
            {session.privacy === 'ephemeral' ? (
              <span
                className="inline-flex items-center gap-1"
                title="Nothing from this session is kept as memory."
              >
                <EyeOff aria-hidden className="size-3.5" />
                Ephemeral
              </span>
            ) : null}
            <span>
              {session.personaName} v{session.personaVersion} · AI coach
            </span>
            <span>
              Started by {session.startedBy.displayName}{' '}
              <time dateTime={isoString(session.startedAt)} title={formatDateTime(session.startedAt)}>
                {formatRelative(session.startedAt)}
              </time>
            </span>
            <span className="tabular">{pluralize(session.turnCount, 'exchange')}</span>
          </div>
        </PageHeader>

        {!ended && availability && !availability.available ? (
          <Alert variant="warning" title={availability.title} className="mb-6">
            {availability.reason}
          </Alert>
        ) : null}

        {ended ? (
          <Tabs
            value={view}
            onValueChange={(value) => {
              void navigate({
                search: { view: value === 'transcript' ? 'transcript' : 'recap' },
                replace: true,
              });
            }}
            className="gap-5"
          >
            <TabsList variant="underline">
              <TabsTrigger value="recap">
                <FileCheck2 aria-hidden />
                Recap
              </TabsTrigger>
              <TabsTrigger value="transcript">
                <MessagesSquare aria-hidden />
                Transcript
                <span className="tabular text-subtle-foreground">{turns.length}</span>
              </TabsTrigger>
            </TabsList>
            <TabsContent value="recap">
              <SessionRecapView
                session={session}
                recap={session.recap}
                turns={turns}
                tenant={tenant}
                ventureId={ventureId}
                canEdit={canEdit}
                memoryItems={memory.data}
                memoryLoading={memory.isPending}
                escalations={escalations.data}
                onRequestEscalation={requestGeneralEscalation}
                onRefresh={() => void detail.refetch()}
                refreshing={detail.isFetching}
              />
            </TabsContent>
            <TabsContent value="transcript">{transcript}</TabsContent>
          </Tabs>
        ) : (
          transcript
        )}

        {ended && ventureAvailability?.available ? (
          <div className="mt-8 flex justify-center" data-print="hide">
            <Button asChild variant="secondary">
              <Link
                to="/$tenant/app/ventures/$ventureId/coach"
                params={{ tenant, ventureId }}
                search={{ start: session.mode }}
              >
                <Play aria-hidden />
                Start a new session
              </Link>
            </Button>
          </div>
        ) : null}
      </PageContainer>

      {!ended && canEdit ? (
        <div
          className="sticky bottom-0 z-10 bg-gradient-to-t from-background via-background/95 to-background/0 pt-6 pb-3"
          data-print="hide"
        >
          <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 lg:px-8">
            <Composer
              value={text}
              onChange={setText}
              mode={mode}
              onModeChange={setModeOverride}
              allowedModes={persona?.allowedModes}
              counterpart={counterpart}
              onCounterpartChange={setCounterpart}
              streaming={stream.isStreaming}
              disabledReason={canSend ? null : (availability?.reason ?? 'Coaching is unavailable right now.')}
              onSend={() => {
                send(text);
              }}
              onStop={stream.cancel}
              textareaRef={textareaRef}
            />
          </div>
        </div>
      ) : null}

      <Inspector title="Session" description="Evidence, known facts, proposed memory and handoffs">
        <SessionInspector
          session={session}
          turns={turns}
          tenant={tenant}
          ventureId={ventureId}
          canEdit={canEdit}
          onRequestSupport={!ended ? requestGeneralEscalation : undefined}
        />
      </Inspector>

      <AlertDialog open={confirmEnd} onOpenChange={setConfirmEnd}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End this session?</AlertDialogTitle>
            <AlertDialogDescription>
              {session.privacy === 'ephemeral'
                ? 'This is an ephemeral session: nothing will be kept as memory and no recap is saved.'
                : 'Foundry Guide will write a recap — diagnosis, evidence, challenge, next actions and any escalation — and propose memory for you to approve.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep going</AlertDialogCancel>
            <Button onClick={confirmEndSession}>End session</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <EscalationFlowDialog
        ventureId={ventureId}
        open={escalation.open}
        draft={escalation.draft}
        onOpenChange={(open) => {
          setEscalation((prev) => ({ ...prev, open }));
        }}
        onViewEscalation={(e) =>
          void navigate({
            to: '/$tenant/app/ventures/$ventureId/escalations',
            params: { tenant, ventureId },
            search: { id: e.id },
          })
        }
      />
      <CorrectMemoryDialog
        ventureId={ventureId}
        memory={editingMemory}
        open={editingMemory !== null}
        onOpenChange={(open) => {
          if (!open) setEditingMemory(null);
        }}
      />
    </>
  );
}
