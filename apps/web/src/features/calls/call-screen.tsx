import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, Settings2, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { errorMessage } from '@/lib/api/errors';
import { useCreateSession } from '@/lib/api/hooks/sessions';
import { queryKeys } from '@/lib/api/query-keys';
import { canWrite } from '@/lib/auth/roles';
import { prefersHalfDuplex } from '@/lib/realtime/browser';
import { discardConversation } from '@/lib/realtime/call-api';
import type { CallEngine } from '@/lib/realtime/call-engine';
import { cn } from '@/lib/utils';

import { useLoadedCall } from './call-context';
import { CallLive } from './call-live';
import { callBlocker, CallLobby } from './call-lobby';
import { CallSummaryPanel } from './call-summary';
import {
  CAPTION_SIZES,
  storedTalkMode,
  useAnnounceCaptions,
  useCaptionSize,
  useVoiceNoticeSeen,
} from './preferences';
import { formatClock, spokenDuration, useCallClock } from './use-call-clock';
import { useCallConfig, useCallVeir, type CallVeir } from './use-call-veir';

const FALLBACK_VEIR: CallVeir = {
  name: 'your vEIR',
  kind: 'eir_persona',
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

/**
 * The call screen: a focused, full-height surface over the conversation, open while the URL carries
 * `?call=1`. It starts the call (creating the conversation first on New chat), shows it live, and ends
 * with the summary. Closing it keeps a live call going in the mini call bar.
 */
export function CallScreen() {
  const { me, engine, snapshot, route, hideCall, switchToChat } = useLoadedCall();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenant = me.tenant.slug;
  const open = route?.open === true;
  const routeVenture = route?.ventureId ?? null;
  const active = snapshot.phase !== 'idle';
  const ventureId = (active ? snapshot.ventureId : null) ?? routeVenture;
  const writable = ventureId !== null && canWrite(me, ventureId);
  const config = useCallConfig(routeVenture, open && writable && !active);
  const veir = useCallVeir(ventureId, config.data?.veir) ?? FALLBACK_VEIR;
  const createSession = useCreateSession(routeVenture ?? '');
  const [noticeSeen, acknowledgeNotice] = useVoiceNoticeSeen();
  const [createError, setCreateError] = useState<string | null>(null);
  /** The conversation (or New chat) this screen already tried to start a call in. */
  const attempted = useRef<string | null>(null);
  /** The screen's place now (read after the call starts, which takes a while). */
  const routeNow = useRef(route);
  useEffect(() => {
    routeNow.current = route;
  }, [route]);

  useLiveCallPage(engine, snapshot.phase === 'live');

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
      };
      setCreateError(null);
      acknowledgeNotice();
      engine.reset();
      if (sessionId) {
        attempted.current = sessionId;
        void engine.start({ ...options, sessionId }).catch(() => undefined);
        return;
      }
      // New chat: the call gets a conversation of its own, which becomes the page once the call is live.
      const key = `new:${target}`;
      attempted.current = key;
      createSession.mutate(
        {},
        {
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
                  search: { call: 1 },
                  replace: true,
                });
              });
          },
          onError: (error) => {
            setCreateError(errorMessage(error));
          },
        },
      );
    },
    [acknowledgeNotice, createSession, discard, engine, navigate, route, tenant],
  );

  // Leaving the screen forgets what it tried, so the next Call starts afresh.
  useEffect(() => {
    if (!open) attempted.current = null;
  }, [open]);

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
      search: { call: 1 },
      replace: true,
    });
  }, [engine, navigate, route, snapshot.phase, snapshot.sessionId, snapshot.ventureId, tenant]);

  // Arrived by clicking Call: start without another click (the first call ever shows how voice is handled
  // first, and starts from its Start call).
  useEffect(() => {
    if (route?.open !== true || !ready || snapshot.phase !== 'idle' || createSession.isPending) return;
    const key = route.sessionId ?? `new:${route.ventureId}`;
    if (attempted.current === key || !noticeSeen || !hasUserActivation()) return;
    begin();
  }, [begin, createSession.isPending, noticeSeen, ready, route, snapshot.phase]);

  const live = snapshot.phase === 'starting' || snapshot.phase === 'live' || snapshot.phase === 'ending';
  const ended = snapshot.phase === 'ended' ? snapshot.ended : null;

  const backToConversation = () => {
    hideCall();
    engine.reset();
  };

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
            // Each state focuses its own primary control (Mute, Start call, the summary heading).
            event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            if (snapshot.phase === 'live' && snapshot.activity === 'speaking') engine.interrupt();
            else if (ended) backToConversation();
            else hideCall();
          }}
          className={cn(
            'fixed inset-0 z-50 flex flex-col overflow-y-auto bg-background text-foreground outline-none',
            'bg-[radial-gradient(ellipse_80%_55%_at_50%_30%,color-mix(in_oklab,var(--foreground)_5%,transparent),transparent_70%)]',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-300',
          )}
        >
          <DialogPrimitive.Title className="sr-only">Call with {veir.name}</DialogPrimitive.Title>
          <CallHeader
            live={live}
            snapshot={snapshot}
            onClose={
              ended
                ? backToConversation
                : () => {
                    hideCall();
                  }
            }
          />
          {ended && ventureId ? (
            <div className="flex flex-1 flex-col">
              <CallSummaryPanel
                tenant={tenant}
                ventureId={ventureId}
                veir={veir}
                ended={ended}
                canWrite={writable}
                onBackToConversation={backToConversation}
                onCallAgain={() => {
                  begin();
                }}
                onLeave={() => {
                  engine.reset();
                }}
              />
            </div>
          ) : live ? (
            <CallLive
              tenant={tenant}
              engine={engine}
              snapshot={snapshot}
              veir={veir}
              onSwitchToChat={switchToChat}
            />
          ) : (
            <CallLobby
              engine={engine}
              veir={veir}
              config={config.data}
              blocker={blocker}
              failure={snapshot.phase === 'failed' ? snapshot.error : null}
              busy={createSession.isPending}
              voiceNotice={!noticeSeen}
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
                hideCall();
              }}
            />
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function CallHeader({
  live,
  snapshot,
  onClose,
}: {
  live: boolean;
  snapshot: Parameters<typeof useCallClock>[0];
  onClose: () => void;
}) {
  const clock = useCallClock(snapshot);
  return (
    <header className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-3 sm:px-5">
      <SimpleTooltip content={live ? 'Minimize — the call keeps going' : 'Close'} side="bottom">
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label={live ? 'Minimize call' : 'Close'}
          className="justify-self-start text-muted-foreground hover:text-foreground"
        >
          {live ? <ChevronDown aria-hidden className="size-5" /> : <X aria-hidden className="size-5" />}
        </Button>
      </SimpleTooltip>
      {live && snapshot.liveAt !== null ? (
        <p className="flex items-center gap-2 text-small">
          <span aria-hidden className="size-1.5 rounded-full bg-foreground motion-safe:animate-pulse" />
          <span className="font-mono tabular" aria-hidden>
            {formatClock(clock.elapsed)}
          </span>
          <span className="sr-only">Call time {spokenDuration(clock.elapsed)}</span>
          {clock.leftLabel ? (
            <span className={cn('text-muted-foreground', clock.warning && 'font-medium text-warning')}>
              · {clock.leftLabel}
            </span>
          ) : null}
        </p>
      ) : (
        <span />
      )}
      {live ? <CallSettings /> : <span />}
    </header>
  );
}

/** Caption size and screen-reader captions, remembered in this browser. */
function CallSettings() {
  const [size, setSize] = useCaptionSize();
  const [announce, setAnnounce] = useAnnounceCaptions();
  return (
    <DropdownMenu>
      <SimpleTooltip content="Call settings" side="bottom">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Call settings"
            className="justify-self-end text-muted-foreground hover:text-foreground"
          >
            <Settings2 aria-hidden className="size-5" />
          </Button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Caption size</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={size}
          onValueChange={(value) => {
            const next = CAPTION_SIZES.find((option) => option.value === value);
            if (next) setSize(next.value);
          }}
        >
          {CAPTION_SIZES.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={announce}
          onCheckedChange={(checked) => {
            setAnnounce(checked);
          }}
        >
          Read captions with my screen reader
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
