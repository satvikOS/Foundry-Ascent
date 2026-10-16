import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { errorMessage } from '@/lib/api/errors';
import { useCreateSession } from '@/lib/api/hooks/sessions';
import { canWrite } from '@/lib/auth/roles';
import { cn } from '@/lib/utils';

import { useCall } from './call-context';
import { CallLive } from './call-live';
import { callBlocker, CallLobby } from './call-lobby';
import { CallSummaryPanel } from './call-summary';
import { storedTalkMode } from './preferences';
import { formatClock, spokenDuration, useCallClock } from './use-call-clock';
import { useCallConfig, useCallVeir, type CallVeir } from './use-call-veir';

const FALLBACK_VEIR: CallVeir = {
  name: 'Your vEIR',
  shortName: 'your vEIR',
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
 * The call screen: a focused, full-height surface over the conversation, open while the URL carries
 * `?call=1`. It starts the call (creating the conversation first on New chat), shows it live, and ends
 * with the summary. Closing it keeps a live call going in the mini call bar.
 */
export function CallScreen() {
  const { me, engine, snapshot, route, hideCall, switchToChat } = useCall();
  const navigate = useNavigate();
  const tenant = me.tenant.slug;
  const open = route?.open === true;
  const routeVenture = route?.ventureId ?? null;
  const active = snapshot.phase !== 'idle';
  const ventureId = (active ? snapshot.ventureId : null) ?? routeVenture;
  const writable = ventureId !== null && canWrite(me, ventureId);
  const config = useCallConfig(routeVenture, open && writable && !active);
  const veir = useCallVeir(ventureId, config.data?.veir) ?? FALLBACK_VEIR;
  const createSession = useCreateSession(routeVenture ?? '');
  const [createError, setCreateError] = useState<string | null>(null);
  /** The conversation (or New chat) this screen already tried to start a call in. */
  const attempted = useRef<string | null>(null);

  const blocker = callBlocker({
    writable,
    name: veir.shortName,
    config: config.data,
    configError: config.error ? errorMessage(config.error) : createError,
  });
  const ready = config.data !== undefined && blocker === null;

  const begin = useCallback(() => {
    if (!route) return;
    const { ventureId: target, sessionId } = route;
    setCreateError(null);
    if (sessionId) {
      attempted.current = sessionId;
      engine.reset();
      void engine.start({ ventureId: target, sessionId, talkMode: storedTalkMode() });
      return;
    }
    attempted.current = `new:${target}`;
    createSession.mutate(
      {},
      {
        onSuccess: (session) => {
          attempted.current = session.id;
          void engine.start({ ventureId: target, sessionId: session.id, talkMode: storedTalkMode() });
          void navigate({
            to: '/$tenant/app/v/$ventureId/c/$sessionId',
            params: { tenant, ventureId: target, sessionId: session.id },
            search: { call: 1 },
            replace: true,
          });
        },
        onError: (error) => {
          setCreateError(errorMessage(error));
        },
      },
    );
  }, [createSession, engine, navigate, route, tenant]);

  // Leaving the screen forgets what it tried, so the next Call starts afresh.
  useEffect(() => {
    if (!open) attempted.current = null;
  }, [open]);

  // Opened on a different conversation than the live call: show the live one (one call at a time).
  // A finished call of another conversation is forgotten.
  useEffect(() => {
    if (route?.open !== true || snapshot.sessionId === null) return;
    if (route.sessionId === snapshot.sessionId || route.sessionId === null) return;
    if (snapshot.phase === 'ended' || snapshot.phase === 'failed') {
      engine.reset();
      return;
    }
    if (snapshot.phase === 'idle' || !snapshot.ventureId) return;
    void navigate({
      to: '/$tenant/app/v/$ventureId/c/$sessionId',
      params: { tenant, ventureId: snapshot.ventureId, sessionId: snapshot.sessionId },
      search: { call: 1 },
      replace: true,
    });
  }, [engine, navigate, route, snapshot.phase, snapshot.sessionId, snapshot.ventureId, tenant]);

  // Arrived by clicking Call: start without another click.
  useEffect(() => {
    if (route?.open !== true || !ready || snapshot.phase !== 'idle' || createSession.isPending) return;
    const key = route.sessionId ?? `new:${route.ventureId}`;
    if (attempted.current === key || !hasUserActivation()) return;
    begin();
  }, [begin, createSession.isPending, ready, route, snapshot.phase]);

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
          <DialogPrimitive.Title className="sr-only">Call with {veir.shortName}</DialogPrimitive.Title>
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
            <div className="flex min-h-0 flex-1 flex-col">
              <CallSummaryPanel
                tenant={tenant}
                ventureId={ventureId}
                veir={veir}
                ended={ended}
                canWrite={writable}
                onBackToConversation={backToConversation}
                onCallAgain={begin}
                onLeave={() => {
                  engine.reset();
                }}
              />
            </div>
          ) : live ? (
            <CallLive engine={engine} snapshot={snapshot} veir={veir} onSwitchToChat={switchToChat} />
          ) : (
            <CallLobby
              engine={engine}
              veir={veir}
              config={config.data}
              blocker={blocker}
              failure={snapshot.phase === 'failed' ? snapshot.error : null}
              busy={createSession.isPending}
              onStart={begin}
              onRetry={() => {
                setCreateError(null);
                if (config.error) void config.refetch();
                else begin();
              }}
              onClose={() => {
                hideCall();
                engine.reset();
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
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 px-3 sm:px-5">
      <SimpleTooltip content={live ? 'Minimize — the call keeps going' : 'Close'} side="bottom">
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label={live ? 'Minimize call' : 'Close'}
          className="text-muted-foreground hover:text-foreground"
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
      ) : null}
    </header>
  );
}
