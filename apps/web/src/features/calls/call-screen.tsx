import type { SessionView } from '@foundry/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, EyeOff, Phone, Video } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { useCoverGround } from '@/components/shell/ground-cover';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { errorMessage } from '@/lib/api/errors';
import { sessionQueryOptions, useCreateSession } from '@/lib/api/hooks/sessions';
import { queryKeys } from '@/lib/api/query-keys';
import { canWrite } from '@/lib/auth/roles';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { prefersHalfDuplex } from '@/lib/realtime/browser';
import { discardConversation } from '@/lib/realtime/call-api';
import type { CallEngine } from '@/lib/realtime/call-engine';
import type { CallSnapshot } from '@/lib/realtime/call-state';
import { cn } from '@/lib/utils';
import { RecordingMark } from '@/features/recordings/record-control';
import type { RecordingSession } from '@/features/recordings/recording-session';
import {
  useCallRecordingLifecycle,
  useCanRecord,
  useRecordingSession,
  type RecordBlocker,
} from '@/features/recordings/use-call-recording';

import { newConversationRequest } from '../chat/first-message';
import { startPrivacy, takeChoiceInView, useStartPrivacy } from '../chat/privacy-choice';
import { focusReviewNext, useLoadedCall } from './call-context';
import { CallDisclosureDialog } from './call-disclosure';
import {
  acknowledgeDisclosure as acknowledgeKind,
  disclosureSeen,
  useCallDisclosure,
} from './call-disclosure-store';
import { CALL_KIND_LABEL, videoAvailability, type CallKind } from './call-kind';
import { CallLive } from './call-live';
import { callBlocker, CallLobby } from './call-lobby';
import { useCallNotice } from './call-notice';
import { inlineWelcome, useVeirWelcome } from '../veir/welcome';
import { storedTalkMode } from './preferences';
import { formatClock, spokenDuration, useCallClock } from './use-call-clock';
import { useCallConfig, useCallVeir, type CallVeir } from './use-call-veir';

const FALLBACK_VEIR: CallVeir = {
  name: 'your mentor',
  shortName: 'your mentor',
  kind: 'eir_persona',
  presentation: 'mentor',
  eirFirstName: null,
  firstPerson: false,
  eirSeesWork: false,
  disclosure: '',
  portraitUrl: null,
  provider: 'builtin',
};

/**
 * Whether the browser will let this page play sound without a fresh click (it has seen one already, e.g.
 * the Call button that opened this screen). A reloaded `?call=1` has not, so it shows Start call.
 */
function hasUserActivation(): boolean {
  return 'userActivation' in navigator ? navigator.userActivation.hasBeenActive : true;
}

/**
 * Whether the call's conversation is private, from the conversation already loaded under the call screen (or
 * created for the call): nothing is requested for it. Null while unknown.
 */
function useSessionPrivacy(sessionId: string | null): SessionView['privacy'] | null {
  const session = useQuery({ ...sessionQueryOptions(sessionId ?? ''), enabled: false });
  return sessionId ? (session.data?.session.privacy ?? null) : null;
}

/**
 * While a call is live: keep the screen awake, and put the call on hold when the page is hidden (the
 * microphone closes; a tap resumes, which mobile browsers need before they play audio again).
 */
function useLiveCallPage(engine: CallEngine, live: boolean): void {
  useEffect(() => {
    if (!live) return undefined;
    let lock: WakeLockSentinel | null = null;
    let done = false;
    const keepAwake = () => {
      if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      navigator.wakeLock.request('screen').then(
        (sentinel) => {
          if (done) void sentinel.release().catch(() => undefined);
          else lock = sentinel;
        },
        () => undefined,
      );
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') engine.hold();
      else keepAwake();
    };
    keepAwake();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      done = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void lock?.release().catch(() => undefined);
    };
  }, [engine, live]);
}

/** Said under the status when a video call was asked for but only voice is offered to this person. */
const VOICE_INSTEAD = 'Video isn’t available, so this is a voice call.';
/** Why a voice call cannot turn video on again (its vendor sessions used up, or its face ended for good). */
const VIDEO_USED = 'Video can’t restart in this call.';

/**
 * The call screen: one surface over the conversation, open while the URL carries `?call=voice` or `?call=video`
 * (design-spec §11). Its header names the vEIR, the kind of call and its time; minimizing keeps a live call going
 * in the mini call bar, and Back returns to it. Before the call it is the sphere idle with Start call in the
 * microphone's place (creating the conversation first on New chat); before the first call of each kind, the call's
 * disclosure comes first, over it. Then the call itself, which can switch between voice and video where the face
 * allows. When the call ends the screen closes onto the conversation, where its review closes the transcript.
 */
export function CallScreen() {
  const {
    me,
    engine,
    face,
    snapshot,
    route,
    kind,
    setKind,
    switchKind,
    hideCall,
    switchToChat,
    arrivedByHistory,
  } = useLoadedCall();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenant = me.tenant.slug;
  const open = route?.open === true;
  // The open screen hides the app's ground entirely: the breathing ground behind it stops drawing.
  useCoverGround(open);
  const routeVenture = route?.ventureId ?? null;
  const active = snapshot.phase !== 'idle';
  const ventureId = (active ? snapshot.ventureId : null) ?? routeVenture;
  const writable = ventureId !== null && canWrite(me, ventureId);
  // The call's own venture once there is a call (read from the cache, never fetched again meanwhile): minimized onto
  // another page, the screen still knows the call's vEIR and its face (it asks for the face, below).
  const config = useCallConfig(ventureId, open && writable && !active);
  const knownVeir = useCallVeir(ventureId, config.data?.veir, config.data?.provider);
  const veir = knownVeir ?? FALLBACK_VEIR;
  const createSession = useCreateSession(routeVenture ?? '');
  // A call from New chat takes New chat's choice: remembered (the default) or private, a one-off.
  const [newPrivacy, setNewPrivacy] = useStartPrivacy(routeVenture ?? '');
  const privacy = useSessionPrivacy(snapshot.sessionId ?? route?.sessionId ?? null);
  // The server keeps that this person was told how a call handles their voice (now part of the disclosure).
  const [, acknowledgeNotice] = useCallNotice(me.principal.id, config.data);
  // Voice or video: the URL asks, and the call settings say whether this person is offered a face.
  const video = videoAvailability(config.data);
  const askedKind: CallKind = route?.kind ?? 'voice';
  const voiceInstead = askedKind === 'video' && video?.available === false;
  const startKind: CallKind = voiceInstead ? 'voice' : askedKind;
  // Before the first call of each kind, the call's disclosure (remembered per person).
  const [disclosed, acknowledgeDisclosure] = useCallDisclosure(me.principal.id, startKind);
  /** Turning video on during a voice call, waiting on the video disclosure. */
  const [videoAsk, setVideoAsk] = useState(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // Stored with the person: someone who opens a call before meeting their coach (a vEIR or the program's guide)
  // reads the welcome here.
  const [welcomeSeen, acknowledgeWelcome] = useVeirWelcome(me, knownVeir);
  const welcome = inlineWelcome(welcomeSeen, writable, knownVeir);
  const welcomeHere = welcome !== null;
  const [createError, setCreateError] = useState<string | null>(null);
  /** The conversation (or New chat) this screen already tried to start a call in. */
  const attempted = useRef<string | null>(null);
  /** The screen's place now (read after the call starts, which takes a while). */
  const routeNow = useRef(route);
  useEffect(() => {
    routeNow.current = route;
  }, [route]);

  useLiveCallPage(engine, snapshot.phase === 'live');

  // The call's recording lives with the engine (it carries on while minimized and is saved when the call ends).
  const recordingSession = useRecordingSession(engine);
  const canRecord = useCanRecord();
  useCallRecordingLifecycle(recordingSession, {
    veirName: veir.name,
    founderName: me.principal.displayName,
    face,
    tenant,
  });
  const recordBlocker: RecordBlocker =
    privacy === 'ephemeral'
      ? 'private'
      : !canRecord
        ? 'unsupported'
        : snapshot.phase !== 'live' || snapshot.awaitingFace
          ? 'not_live'
          : null;

  // A live video call asks for its face here as well as on its tile: this screen stays mounted for the whole call,
  // minimized or not, so a call minimized while it was still starting still gets its face, and with it its
  // conversation (which waits for the face). Asking again is a no-op while the face is joining, live or unavailable.
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const liveCallId = snapshot.phase === 'live' ? (snapshot.call?.id ?? null) : null;
  const liveVenture = snapshot.phase === 'live' ? snapshot.ventureId : null;
  useEffect(() => {
    if (kind !== 'video' || face === null || liveCallId === null || liveVenture === null) return;
    face.request({ provider: veir.provider, ventureId: liveVenture, callId: liveCallId, reducedMotion });
  }, [kind, face, liveCallId, liveVenture, veir.provider, reducedMotion]);

  const blocker = callBlocker({
    writable,
    name: veir.name,
    config: config.data,
    configError: config.error ? errorMessage(config.error) : createError,
  });
  const ready = config.data !== undefined && blocker === null;

  /** Removes a conversation created for a call that never started, so no empty conversation is left. */
  const discard = useCallback(
    (sessionId: string, target: string) => {
      // Minimized while connecting, the page may show that conversation: go back to New chat first.
      if (routeNow.current?.sessionId === sessionId) {
        void navigate({
          to: '/$tenant/app/v/$ventureId',
          params: { tenant, ventureId: target },
          search: {},
          replace: true,
        });
      }
      void discardConversation(sessionId)
        .catch(() => undefined)
        .finally(() => {
          queryClient.removeQueries({ queryKey: queryKeys.session.detail(sessionId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.venture.sessions(target) });
        });
    },
    [navigate, queryClient, tenant],
  );

  /** Starts the call; `replace` moves the founder's live call in another conversation here (asked first). */
  const begin = useCallback(
    (replace = false) => {
      if (!route) return;
      const { ventureId: target, sessionId } = route;
      const options = {
        ventureId: target,
        talkMode: storedTalkMode(),
        halfDuplex: prefersHalfDuplex(),
        replace,
        // A video call: the face first, then the conversation (owner round 3); a voice call starts talking at once.
        awaitFace: startKind === 'video',
      };
      setCreateError(null);
      acknowledgeNotice();
      acknowledgeDisclosure();
      if (welcomeHere) acknowledgeWelcome();
      setKind(startKind);
      engine.reset();
      if (sessionId) {
        attempted.current = sessionId;
        void engine.start({ ...options, sessionId }).catch(() => undefined);
        return;
      }
      // New chat: the call gets a conversation of its own, which becomes the page once the call is live.
      const key = `new:${target}`;
      attempted.current = key;
      createSession.mutate(newConversationRequest({ mode: undefined, privacy: startPrivacy(target) }), {
        onSuccess: (session) => {
          if (attempted.current !== key) {
            // The screen was closed while the conversation was being created.
            discard(session.id, target);
            return;
          }
          void engine
            .start({ ...options, sessionId: session.id })
            .catch(() => undefined)
            .then(() => {
              const { phase, sessionId: calling } = engine.getSnapshot();
              if (calling !== session.id || phase === 'failed' || phase === 'idle') {
                discard(session.id, target);
                return;
              }
              const now = routeNow.current;
              if (now?.open !== true || now.sessionId !== null || now.ventureId !== target) return;
              attempted.current = session.id;
              void navigate({
                to: '/$tenant/app/v/$ventureId/c/$sessionId',
                params: { tenant, ventureId: target, sessionId: session.id },
                search: { call: startKind },
                replace: true,
              });
            });
        },
        onError: (error) => {
          setCreateError(errorMessage(error));
        },
      });
    },
    [
      acknowledgeDisclosure,
      acknowledgeNotice,
      acknowledgeWelcome,
      createSession,
      discard,
      engine,
      navigate,
      route,
      setKind,
      startKind,
      tenant,
      welcomeHere,
    ],
  );

  /** Before the call: the screen asks for the other kind instead (its URL follows, so Back keeps it). */
  const switchBeforeStart = useCallback(
    (next: CallKind) => {
      if (!route) return;
      const { ventureId: target, sessionId } = route;
      if (sessionId) {
        void navigate({
          to: '/$tenant/app/v/$ventureId/c/$sessionId',
          params: { tenant, ventureId: target, sessionId },
          search: { call: next },
          replace: true,
        });
      } else {
        void navigate({
          to: '/$tenant/app/v/$ventureId',
          params: { tenant, ventureId: target },
          search: { call: next },
          replace: true,
        });
      }
    },
    [navigate, route, tenant],
  );

  /** During the call: to voice at once; to video after its disclosure, the first time. */
  const switchLive = useCallback(
    (next: CallKind) => {
      if (next === 'video' && !disclosureSeen(me.principal.id, 'video')) {
        setVideoAsk(true);
        return;
      }
      switchKind(next);
    },
    [me.principal.id, switchKind],
  );

  // Leaving the screen forgets what it tried, so the next Call starts afresh.
  useEffect(() => {
    if (!open) attempted.current = null;
  }, [open]);

  /**
   * Whether this opening of the screen came from New chat's Call button, beside Remember or Private. A call
   * into a new conversation from anywhere else (the sidebar, ⌘K) waits on the start screen, which offers the
   * choice first. Taken when the screen opens (before it can start a call), forgotten when it closes.
   */
  const choiceSeen = useRef(false);
  /** The same, for what the screen shows (the disclosure leads to the choice when it was not in view). */
  const [choiceShown, setChoiceShown] = useState(false);
  useEffect(() => {
    if (!open) {
      choiceSeen.current = false;
      setChoiceShown(false);
      return;
    }
    if (routeVenture !== null && takeChoiceInView(routeVenture)) {
      choiceSeen.current = true;
      setChoiceShown(true);
    }
  }, [open, routeVenture]);

  // A call that could not start is forgotten once the screen closes. If it failed while minimized, the
  // screen that explains why was closed, so a toast says it instead.
  const failureShown = useRef(false);
  useEffect(() => {
    if (snapshot.phase !== 'failed') {
      failureShown.current = false;
      return;
    }
    if (open) {
      failureShown.current = true;
      return;
    }
    if (!failureShown.current && snapshot.error) {
      toast.error('The call didn’t start', { description: snapshot.error.message });
    }
    engine.reset();
  }, [engine, open, snapshot.error, snapshot.phase]);

  // Opened on a different conversation than the live call: show the live one (one call at a time).
  // A finished call of another conversation is forgotten, also when Call opens New chat (its summary is not
  // what the founder asked for). New chat's own call is told apart while its conversation is created.
  useEffect(() => {
    if (route?.open !== true || snapshot.sessionId === null) return;
    if (route.sessionId === snapshot.sessionId) return;
    const newChat = route.sessionId === null;
    if (snapshot.phase === 'ended' || (snapshot.phase === 'failed' && !newChat)) {
      engine.reset();
      return;
    }
    if (newChat || snapshot.phase === 'idle' || !snapshot.ventureId) return;
    void navigate({
      to: '/$tenant/app/v/$ventureId/c/$sessionId',
      params: { tenant, ventureId: snapshot.ventureId, sessionId: snapshot.sessionId },
      search: { call: kind },
      replace: true,
    });
  }, [engine, kind, navigate, route, snapshot.phase, snapshot.sessionId, snapshot.ventureId, tenant]);

  // Arrived by clicking Call: start without another click (the first call of each kind shows its disclosure
  // first, and starts from its Start call). Back or Forward to a call's URL is not a click: it waits for
  // Start call too. A call into a new conversation starts at once only from New chat's Call button, where
  // Remember or Private was in view; from anywhere else it waits for Start call, beside that choice.
  useEffect(() => {
    if (route?.open !== true || !ready || snapshot.phase !== 'idle' || createSession.isPending) return;
    const key = route.sessionId ?? `new:${route.ventureId}`;
    if (attempted.current === key || !disclosed || welcomeHere || !hasUserActivation() || arrivedByHistory())
      return;
    if (route.sessionId === null && !choiceSeen.current) return;
    begin();
  }, [
    arrivedByHistory,
    begin,
    createSession.isPending,
    disclosed,
    ready,
    route,
    snapshot.phase,
    welcomeHere,
  ]);

  // A call that ends on this screen returns to its conversation, where the review is (focus moves to it). Opened
  // over a call that ended earlier (Call again, the composer's Call), that call is forgotten and a new one starts.
  const lastPhase = useRef(snapshot.phase);
  /** The screen closed because the call ended on it: focus goes to the review, not back to the Call button. */
  const endedHere = useRef(false);
  useEffect(() => {
    const was = lastPhase.current;
    lastPhase.current = snapshot.phase;
    if (!open || snapshot.phase !== 'ended') return;
    if (was === 'ending' || was === 'live' || was === 'starting') {
      endedHere.current = true;
      focusReviewNext();
      hideCall({ replace: true });
    } else {
      engine.reset();
    }
  }, [engine, hideCall, open, snapshot.phase]);

  const live = snapshot.phase === 'starting' || snapshot.phase === 'live' || snapshot.phase === 'ending';
  const ended = snapshot.phase === 'ended';
  const shownKind: CallKind = live ? kind : startKind;
  const callId = snapshot.call?.id ?? null;
  const videoBlocked =
    video?.available === false
      ? video.reason
      : live && callId !== null && face !== null && !face.canAsk(callId)
        ? VIDEO_USED
        : null;
  // The first call of this kind: its disclosure, over the start screen, before anything starts.
  const disclosing = open && ready && !disclosed && snapshot.phase === 'idle' && !createSession.isPending;
  // A new conversation whose Remember or Private was not in view: the disclosure leads to the start screen's choice.
  const choicePending = route?.sessionId === null && !choiceShown;

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) hideCall();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-slot="call-screen"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            // Each state focuses its own primary control (the vEIR's name, Start call).
            event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (!endedHere.current) return;
            // The review in the conversation has taken focus.
            endedHere.current = false;
            event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            if (snapshot.phase === 'live' && snapshot.activity === 'speaking') engine.interrupt();
            else hideCall({ replace: !live });
          }}
          className={cn(
            'app-ground fixed inset-0 z-50 flex flex-col overflow-y-auto text-foreground outline-none',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-300',
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            {CALL_KIND_LABEL[shownKind]} with {veir.name}
          </DialogPrimitive.Title>
          <CallHeader
            name={veir.name}
            kind={shownKind}
            headingRef={headingRef}
            live={live}
            snapshot={snapshot}
            isPrivate={privacy === 'ephemeral'}
            recording={recordingSession}
            onClose={() => {
              // Live: minimized, the call goes on in the mini bar and Back returns to it. Before the call: closed,
              // and its `?call=1` entry is replaced so Back never returns to it.
              if (live) hideCall();
              else {
                if (snapshot.phase === 'failed') engine.reset();
                hideCall({ replace: true });
              }
            }}
          />
          {ended ? null : live ? (
            <CallLive
              tenant={tenant}
              engine={engine}
              snapshot={snapshot}
              veir={veir}
              face={face}
              onSwitchToChat={switchToChat}
              kind={kind}
              onSwitchKind={switchLive}
              videoBlocked={videoBlocked}
              headingRef={headingRef}
              recording={{ session: recordingSession, blocker: recordBlocker, principalId: me.principal.id }}
            />
          ) : (
            <CallLobby
              engine={engine}
              veir={veir}
              config={config.data}
              blocker={blocker}
              failure={snapshot.phase === 'failed' ? snapshot.error : null}
              busy={createSession.isPending}
              kind={startKind}
              onSwitchKind={snapshot.phase === 'idle' ? switchBeforeStart : null}
              videoBlocked={video?.available === false ? video.reason : null}
              note={voiceInstead ? VOICE_INSTEAD : null}
              welcome={welcome}
              privacy={
                route?.sessionId === null && writable ? { value: newPrivacy, onChange: setNewPrivacy } : null
              }
              onStart={() => {
                begin();
              }}
              onRetry={() => {
                setCreateError(null);
                if (config.error) void config.refetch();
                else begin();
              }}
              onMoveHere={() => {
                begin(true);
              }}
              onClose={() => {
                // Forget the failed call first, so closing returns to the page (not to a call that never was).
                engine.reset();
                hideCall({ replace: true });
              }}
            />
          )}
          <CallDisclosureDialog
            open={disclosing}
            name={veir.name}
            kind={startKind}
            confirmLabel={choicePending ? 'Continue' : 'Start call'}
            onConfirm={() => {
              acknowledgeDisclosure();
              // From the sidebar or ⌘K, Remember or Private is chosen on the start screen first.
              if (!choicePending) begin();
            }}
            onCancel={() => {
              if (snapshot.phase === 'failed') engine.reset();
              hideCall({ replace: true });
            }}
          />
          <CallDisclosureDialog
            open={videoAsk && live}
            name={veir.name}
            kind="video"
            confirmLabel="Turn on video"
            onConfirm={() => {
              acknowledgeKind(me.principal.id, 'video');
              setVideoAsk(false);
              switchKind('video');
            }}
            onCancel={() => {
              setVideoAsk(false);
            }}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * The call's header: back to the conversation (minimize) on the left; in the middle the vEIR's name (the screen's
 * heading) over the kind of call, its time and what is left near the end, and Private for a one-off; the right is
 * the switch and the call settings' corner (CallLive, CallLobby).
 */
function CallHeader({
  name,
  kind,
  headingRef,
  live,
  snapshot,
  isPrivate,
  recording,
  onClose,
}: {
  name: string;
  kind: CallKind;
  headingRef: RefObject<HTMLHeadingElement | null>;
  live: boolean;
  snapshot: Parameters<typeof useCallClock>[0] & Pick<CallSnapshot, 'awaitingFace'>;
  /** A private call (a one-off) says so quietly while it lasts. */
  isPrivate: boolean;
  /** The call's recording: "● REC" and its time while it records. */
  recording: RecordingSession;
  onClose: () => void;
}) {
  const clock = useCallClock(snapshot);
  const KindIcon = kind === 'video' ? Video : Phone;
  // A video call waiting for its face has not started its conversation: no clock yet, only "Connecting to …".
  const timing = live && snapshot.liveAt !== null && !snapshot.awaitingFace;
  return (
    <header
      data-slot="call-header"
      className="grid h-16 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-2 sm:px-4"
    >
      {/* Always a chevron back to the conversation: X on this screen only ever means End (bottom right). */}
      <SimpleTooltip
        content={live ? 'Back to the conversation. The call keeps going.' : 'Close'}
        side="bottom"
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label={live ? 'Minimize call' : 'Close'}
          className="fa-call-focus justify-self-start text-muted-foreground hover:text-foreground"
        >
          <ChevronDown aria-hidden className="size-5" />
        </Button>
      </SimpleTooltip>
      <div className="grid min-w-0 justify-items-center gap-0.5 text-center">
        <h2
          ref={headingRef}
          tabIndex={-1}
          data-slot="call-heading"
          className="max-w-[min(18rem,52vw)] truncate rounded-sm text-body font-medium text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {name}
        </h2>
        <p
          data-slot="call-kind"
          className="flex max-w-[min(22rem,60vw)] items-center gap-1.5 text-caption whitespace-nowrap text-muted-foreground"
        >
          <KindIcon aria-hidden className="size-3.5 shrink-0" />
          <span>{CALL_KIND_LABEL[kind]}</span>
          {timing ? (
            <>
              <span aria-hidden>·</span>
              <span className="tabular" aria-hidden>
                {formatClock(clock.elapsed)}
              </span>
              <span className="sr-only">, call time {spokenDuration(clock.elapsed)}</span>
            </>
          ) : null}
          {live ? <RecordingMark session={recording} separator /> : null}
          {timing && clock.leftLabel ? (
            <span className={cn('truncate', clock.warning && 'font-medium text-warning')}>
              <span aria-hidden>· </span>
              {clock.leftLabel}
            </span>
          ) : null}
          {isPrivate ? (
            <>
              <span aria-hidden>·</span>
              <PrivateMark />
            </>
          ) : null}
        </p>
      </div>
      {/* The switch and the call settings sit in this corner (CallLive, CallLobby). */}
      <span />
    </header>
  );
}

function PrivateMark() {
  return (
    <span
      data-testid="private-indicator"
      className="inline-flex items-center gap-1 text-muted-foreground"
      title="Private: nothing from this call is remembered"
    >
      <EyeOff aria-hidden className="size-3.5" />
      Private
    </span>
  );
}
