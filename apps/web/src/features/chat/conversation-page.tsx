import type { TurnView } from '@foundry/contracts';
import { getRouteApi, Link } from '@tanstack/react-router';
import { AudioLines, LockKeyhole } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { DisclosureBanner } from '@/components/disclosure-banner';
import { ReportProblemDialog } from '@/components/shell/account-dialogs';
import { Inspector } from '@/components/shell/inspector';
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
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { errorMessage } from '@/lib/api/errors';
import { useVentureEscalations } from '@/lib/api/hooks/escalations';
import { useMemory } from '@/lib/api/hooks/memory';
import { useEndSession, useSession } from '@/lib/api/hooks/sessions';
import { useTurnStream } from '@/lib/api/hooks/turn-stream';
import { useVenture } from '@/lib/api/hooks/ventures';
import { canWrite } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { conversationTitle } from '@/lib/conversations';
import { useDockedBottom } from '@/lib/hooks/use-docked-bottom';
import { useHotkeys } from '@/lib/hooks/use-hotkeys';
import { shortPersonaName, veirDisplay } from '@/lib/veir';
import { EscalationFlowDialog, type EscalationDraft } from '@/features/escalations/escalation-flow-dialog';

import { coachingAvailability } from '../coach/availability';
import { deriveTurnProgress } from '../coach/progress';
import { AttachButton, AttachmentTray, useComposerAttachments } from './attachments';
import { Composer, MAX_TURN_CHARS, modeToSend, type ComposerMode } from './composer';
import { ContextPanel } from './context-panel';
import { DeleteConversationDialog, RenameConversationDialog } from './conversation-dialogs';
import { ConversationHeader, type ConversationMenuAction } from './conversation-header';
import { DigestView } from './digest-view';
import { LiveExchange, OpenerMessage, StoredExchange } from './exchange';
import {
  hasPendingFirstMessage,
  rememberComposerMode,
  rememberedComposerMode,
  useFirstMessageHandoff,
} from './first-message';
import { FollowUps } from './follow-ups';
import { PanelStateProvider } from './panel-state';

const routeApi = getRouteApi('/$tenant/app/v/$ventureId/c/$sessionId');

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * A conversation with the venture's vEIR. Conversations are private to the venture's founders and team;
 * read-only roles (advisors, assigned EIRs) get a plain explanation and nothing is requested for them.
 */
export function ConversationPage() {
  const me = useRequiredMe();
  const { sessionId, ventureId } = routeApi.useParams();
  if (!canWrite(me, ventureId)) return <PrivateConversation />;
  // Keyed by conversation: the router reuses this component across conversations, but the draft, the
  // stream and the panel's selection belong to one conversation only.
  return (
    <PanelStateProvider key={sessionId}>
      <Conversation />
    </PanelStateProvider>
  );
}

function PrivateConversation() {
  const { tenant, ventureId } = routeApi.useParams();
  return (
    <div className="mx-auto w-full max-w-(--content-width) px-4 py-16 sm:px-6">
      <h1 data-page-title tabIndex={-1} className="sr-only">
        Conversation
      </h1>
      <EmptyState
        icon={LockKeyhole}
        title="Conversations are private to the venture team"
        description="Founders and team members can read them. You can still read the venture’s knowledge and documents."
        action={
          <Button asChild variant="secondary" size="sm">
            <Link to="/$tenant/app/v/$ventureId/knowledge" params={{ tenant, ventureId }}>
              Open Knowledge
            </Link>
          </Button>
        }
      />
    </div>
  );
}

function ConversationSkeleton() {
  return (
    <div aria-busy="true" className="mx-auto grid w-full max-w-(--content-width) gap-8 px-4 py-10 sm:px-6">
      <span className="sr-only" role="status">
        Loading conversation…
      </span>
      <Skeleton className="ml-auto h-12 w-2/3 rounded-2xl" />
      <SkeletonText lines={5} />
    </div>
  );
}

function Conversation() {
  const me = useRequiredMe();
  const { tenant, ventureId, sessionId } = routeApi.useParams();
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const detail = useSession(sessionId);
  const venture = useVenture(ventureId);
  const memory = useMemory(ventureId);
  const escalations = useVentureEscalations(ventureId);
  const stream = useTurnStream(sessionId, { ventureId });
  const endSession = useEndSession();
  const attachments = useComposerAttachments(ventureId);

  const [text, setText] = useState('');
  const [mode, setModeState] = useState<ComposerMode>(() => rememberedComposerMode(sessionId));
  const [counterpart, setCounterpart] = useState('');
  const [dialog, setDialog] = useState<'rename' | 'end' | 'report' | 'delete' | null>(null);
  const [escalation, setEscalation] = useState<{ open: boolean; draft: EscalationDraft | null }>({
    open: false,
    draft: null,
  });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const liveRef = useRef<HTMLDivElement | null>(null);
  const initialScrollDone = useRef(false);
  const composerDockRef = useDockedBottom();

  const session = detail.data?.session ?? null;
  const turns = useMemo(() => detail.data?.turns ?? [], [detail.data]);
  const availability = venture.data && session ? coachingAvailability(me, venture.data, session) : null;
  const canSend = Boolean(availability?.available);
  const { state } = stream;
  const progress = deriveTurnProgress(state);
  const veir = veirDisplay(venture.data);
  const personaName =
    session && veir?.personaId === session.personaId
      ? veir.shortName
      : session
        ? shortPersonaName(session.personaName, veir?.kind ?? 'neutral_guide')
        : (veir?.shortName ?? 'your vEIR');

  const setMode = useCallback(
    (next: ComposerMode) => {
      setModeState(next);
      rememberComposerMode(sessionId, next);
    },
    [sessionId],
  );
  const focusComposer = useCallback(() => {
    textareaRef.current?.focus();
  }, []);
  useHotkeys({ '/': focusComposer });

  // First load: an ended conversation opened for its summary starts there; an open one at its latest
  // exchange.
  useEffect(() => {
    if (initialScrollDone.current || !session) return;
    if (search.view === 'digest' && session.status === 'ended') {
      initialScrollDone.current = true;
      document.getElementById('digest')?.scrollIntoView({ block: 'start' });
      return;
    }
    if (turns.length === 0) return;
    initialScrollDone.current = true;
    const last = turns[turns.length - 1];
    if (last) document.getElementById(`turn-${last.id}`)?.scrollIntoView({ block: 'start' });
  }, [session, turns, search.view]);

  // A message just sent: bring it to the top of the reading column, so the answer streams in below.
  const sentText = state.status === 'streaming' ? state.pendingText : null;
  useLayoutEffect(() => {
    if (sentText === null) return;
    liveRef.current?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [sentText]);

  // Announce how a turn ended (content-free). Step-by-step progress is announced by TurnProgressList.
  // A replay that found the turn still being answered is retried automatically, so it is not a failure.
  const stillAnswering =
    state.status === 'failed' && state.error?.code === 'conflict' && state.error.retryAt !== undefined;
  useEffect(() => {
    if (stillAnswering) {
      announce(`Still answering. ${personaName} will check again shortly.`);
      return;
    }
    switch (state.status) {
      case 'completed':
        announce('Response ready.');
        break;
      case 'blocked':
        announce(`${personaName} handed this question to a person. Support options are shown.`, 'assertive');
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
  }, [state.status, stillAnswering, personaName]);

  const sendTurn = stream.send;
  const send = useCallback(
    (raw: string) => {
      const value = raw.trim();
      if (!value || value.length > MAX_TURN_CHARS || !canSend || stream.isStreaming) return;
      setText('');
      const chosen = modeToSend(mode);
      const rehearsalCounterpart = chosen === 'rehearse' ? counterpart.trim() : '';
      void sendTurn({
        text: value,
        ...(chosen ? { mode: chosen } : {}),
        ...(rehearsalCounterpart ? { rehearsalCounterpart } : {}),
      }).then((outcome) => {
        // Give the words back so nothing typed is lost.
        if (outcome === 'cancelled') setText((current) => (current.trim() ? current : value));
      });
    },
    [mode, canSend, stream.isStreaming, counterpart, sendTurn],
  );

  // The first message typed on New chat.
  const restoreText = useCallback((value: string) => {
    setText((current) => (current.trim() ? current : value));
  }, []);
  useFirstMessageHandoff({
    sessionId,
    ready: session !== null && availability !== null && turns.length === 0,
    canSend,
    send: sendTurn,
    restore: restoreText,
    setCounterpart,
  });

  if (detail.isPending) return <ConversationSkeleton />;
  if (detail.isError || session?.ventureId !== ventureId) {
    return (
      <div className="mx-auto w-full max-w-(--content-width) px-4 py-16 sm:px-6">
        <h1 data-page-title tabIndex={-1} className="sr-only">
          Conversation
        </h1>
        <ErrorState
          error={detail.error}
          title={detail.isError ? undefined : 'Conversation not found'}
          onRetry={detail.isError ? () => void detail.refetch() : undefined}
          action={
            <Button asChild variant="ghost" size="sm">
              <Link to="/$tenant/app/v/$ventureId" params={{ tenant, ventureId }}>
                New chat
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  const ended = session.status === 'ended';
  const liveTurnId = state.turnId;
  const liveInHistory = liveTurnId !== null && turns.some((t) => t.id === liveTurnId);
  const showLive =
    state.status !== 'idle' &&
    state.pendingText !== null &&
    !(liveInHistory && (state.status === 'completed' || state.status === 'blocked'));
  const visibleTurns = showLive && liveTurnId ? turns.filter((t) => t.id !== liveTurnId) : turns;
  const waitingForFirst = turns.length === 0 && hasPendingFirstMessage(sessionId);
  const sendDisabledReason = !canSend
    ? (availability?.reason ?? 'Unavailable right now.')
    : stream.isStreaming
      ? 'Wait for the current answer to finish.'
      : null;
  const title = conversationTitle(session, turns[0]?.founderText ?? state.pendingText);
  const latest = visibleTurns[visibleTurns.length - 1] ?? null;
  const followUps =
    !showLive && latest?.status === 'completed' && !ended ? (latest.response?.follow_up_questions ?? []) : [];

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
  const askPerson = () => {
    setEscalation({ open: true, draft: { turnId: null, founderQuestion: session.goal ?? '' } });
  };

  const onMenu = (action: ConversationMenuAction) => {
    setDialog(action);
  };

  const confirmEnd = () => {
    setDialog(null);
    stream.cancel();
    endSession.mutate(sessionId, {
      onSuccess: () => {
        toast.success('Conversation ended');
        announce('Conversation ended');
        void navigate({ search: { view: 'digest' }, replace: true }).then(() => {
          requestAnimationFrame(() => {
            document.getElementById('digest')?.scrollIntoView({
              block: 'start',
              behavior: prefersReducedMotion() ? 'auto' : 'smooth',
            });
          });
        });
      },
      onError: (error) => {
        toast.error('Couldn’t end the conversation', { description: errorMessage(error) });
      },
    });
  };

  return (
    <div className="@container/conv flex flex-1 flex-col">
      <ConversationHeader
        tenant={tenant}
        ventureId={ventureId}
        session={session}
        title={title}
        personaName={personaName}
        personaKind={veir?.kind ?? 'neutral_guide'}
        portraitUrl={veir?.portraitUrl}
        canEdit
        canCall={!ended && canSend}
        onAction={onMenu}
      >
        {ended ? (
          <DisclosureBanner variant="line" text={session.disclosure} className="justify-start" />
        ) : null}
      </ConversationHeader>

      <div className="mx-auto w-full max-w-(--content-width) flex-1 px-4 pt-8 pb-10 sm:px-6">
        <section aria-label="Transcript" className="grid gap-12">
          {session.opener ? (
            <OpenerMessage text={session.opener} personaName={personaName} portraitUrl={veir?.portraitUrl} />
          ) : null}
          {visibleTurns.length === 0 && !showLive && !waitingForFirst && !session.opener ? (
            <p className="py-10 text-center text-small text-muted-foreground">
              {ended
                ? 'This conversation ended before anything was asked.'
                : `Ask ${personaName} anything about ${venture.data?.name ?? 'your venture'}.`}
            </p>
          ) : null}
          {visibleTurns.map((turn) => (
            <StoredExchange
              key={turn.id}
              turn={turn}
              session={session}
              personaName={personaName}
              portraitUrl={veir?.portraitUrl}
              tenant={tenant}
              ventureId={ventureId}
              canEdit
              latest={!showLive && turn.id === latest?.id}
              memoryItems={memory.data}
              memoryLoading={memory.isPending}
              escalations={escalations.data}
              sendDisabledReason={ended ? 'This conversation has ended.' : sendDisabledReason}
              onRetry={send}
              onRequestEscalation={requestEscalationForTurn}
              liveBlocked={state.blocked?.turnId === turn.id ? state.blocked : null}
            />
          ))}
          {showLive ? (
            <div ref={liveRef} className="scroll-mt-24">
              <LiveExchange
                state={state}
                progress={progress}
                author={session.startedBy.displayName}
                personaName={personaName}
                portraitUrl={veir?.portraitUrl}
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
                onRequestSupport={askPerson}
              />
            </div>
          ) : null}
          {ended ? (
            <DigestView
              session={session}
              personaName={personaName}
              canEdit
              memoryItems={memory.data}
              escalations={escalations.data}
              onAskPerson={askPerson}
            />
          ) : null}
        </section>
      </div>

      {ended ? null : (
        <div
          ref={composerDockRef}
          className="sticky bottom-0 z-10 bg-background pt-1 pb-3 before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-gradient-to-t before:from-background before:to-background/0"
          data-print="hide"
        >
          <div className="mx-auto grid w-full max-w-(--content-width) gap-2.5 px-4 sm:px-6">
            {followUps.length > 0 && canSend ? (
              <FollowUps
                questions={followUps}
                disabled={stream.isStreaming}
                onPick={(question) => {
                  send(question);
                }}
              />
            ) : null}
            {!canSend && availability?.reason ? (
              <p className="text-center text-small text-muted-foreground" role="status">
                {availability.reason}
              </p>
            ) : null}
            <Composer
              value={text}
              onChange={setText}
              personaName={personaName}
              disclosure={session.disclosure}
              mode={mode}
              onModeChange={setMode}
              allowedModes={venture.data?.persona?.allowedModes}
              counterpart={counterpart}
              onCounterpartChange={setCounterpart}
              streaming={stream.isStreaming}
              disabledReason={canSend ? null : (availability?.title ?? 'Unavailable')}
              onSend={() => {
                send(text);
              }}
              onStop={stream.cancel}
              textareaRef={textareaRef}
              top={
                <AttachmentTray
                  items={attachments.items}
                  onCancel={attachments.cancel}
                  onRetry={attachments.retry}
                  onDismiss={attachments.dismiss}
                />
              }
              tools={<AttachButton onFiles={attachments.attach} disabled={!canSend} />}
              actions={
                canSend ? (
                  <SimpleTooltip content={`Call ${personaName}`}>
                    <Button asChild variant="subtle" size="icon-sm" className="rounded-full">
                      <Link
                        to="/$tenant/app/v/$ventureId/c/$sessionId"
                        params={{ tenant, ventureId, sessionId }}
                        search={{ call: 1 }}
                        aria-label={`Call ${personaName}`}
                      >
                        <AudioLines aria-hidden />
                      </Link>
                    </Button>
                  </SimpleTooltip>
                ) : null
              }
            />
          </div>
        </div>
      )}

      <Inspector title="Context">
        <ContextPanel
          session={session}
          turns={turns}
          personaName={personaName}
          tenant={tenant}
          ventureId={ventureId}
          onAskPerson={askPerson}
        />
      </Inspector>

      <AlertDialog
        open={dialog === 'end'}
        onOpenChange={(open) => {
          setDialog(open ? 'end' : null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              {session.privacy === 'ephemeral'
                ? 'It’s a temporary chat, so nothing from it is kept.'
                : `${personaName} will write a summary and suggest what to remember.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep going</AlertDialogCancel>
            <Button onClick={confirmEnd} loading={endSession.isPending} loadingText="Ending…">
              End conversation
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <RenameConversationDialog
        session={session}
        currentTitle={title}
        open={dialog === 'rename'}
        onOpenChange={(open) => {
          setDialog(open ? 'rename' : null);
        }}
      />
      <DeleteConversationDialog
        session={session}
        open={dialog === 'delete'}
        onOpenChange={(open) => {
          setDialog(open ? 'delete' : null);
        }}
        onDeleted={() => {
          void navigate({ to: '/$tenant/app/v/$ventureId', params: { tenant, ventureId }, replace: true });
        }}
      />
      <ReportProblemDialog
        open={dialog === 'report'}
        onOpenChange={(open) => {
          setDialog(open ? 'report' : null);
        }}
      />
      <EscalationFlowDialog
        ventureId={ventureId}
        open={escalation.open}
        draft={escalation.draft}
        onOpenChange={(open) => {
          setEscalation((prev) => ({ ...prev, open }));
        }}
        onViewEscalation={(e) =>
          void navigate({
            to: '/$tenant/app/v/$ventureId/help',
            params: { tenant, ventureId },
            search: { id: e.id },
          })
        }
      />
    </div>
  );
}
