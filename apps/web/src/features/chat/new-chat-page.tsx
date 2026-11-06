import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { AudioLines } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { Inspector, InspectorToggle, useInspector } from '@/components/shell/inspector';
import { PhoneBarAction } from '@/components/shell/shell-chrome';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { errorMessage } from '@/lib/api/errors';
import { memoryQueryOptions } from '@/lib/api/hooks/memory';
import { conversationOpenerQueryOptions, useCreateSession } from '@/lib/api/hooks/sessions';
import { useVenture } from '@/lib/api/hooks/ventures';
import { canWrite } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { greeting } from '@/lib/format';
import { useHotkeys } from '@/lib/hooks/use-hotkeys';
import { BREAKPOINTS, useMediaQuery } from '@/lib/hooks/use-media-query';
import { NEUTRAL_MENTOR_NAME, veirDisplay } from '@/lib/veir';

import { conversationOrigin, NEW_CHAT_ORIGIN } from '@/features/documents/upload-queue';

import { useCallsAvailable } from '../calls/calls-available';
import { coachingAvailability } from '../coach/availability';
import { AttachButton, AttachmentTray, useComposerAttachments } from './attachments';
import { Composer, MAX_TURN_CHARS, modeToSend, type ComposerMode } from './composer';
import { newConversationRequest, setPendingFirstMessage } from './first-message';
import { newChatGreeting } from './greeting';
import { markChoiceInView, useStartPrivacy } from './privacy-choice';
import { VentureContext, type PromptSuggestion } from './venture-context';

const routeApi = getRouteApi('/$tenant/app/v/$ventureId/');

function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}

/** Longest New chat waits for the vEIR's opener before greeting without one (a slow network, a cold server). */
export const OPENER_WAIT_MS = 1_500;

/** What New chat greets a remembered conversation with, decided once per visit (see `NewChat`). */
interface ShownOpener {
  /** The vEIR's opener shown, or null (nothing to pick up, or it did not arrive in time). */
  readonly opener: string | null;
  /** When it was phrased (`GET /ventures/:id/opener`'s `at`), sent as `openerShownAt`; null with no opener. */
  readonly at: string | null;
  /** They have talked before. */
  readonly returning: boolean;
}

/**
 * New chat: a calm centre with only the greeting, one short line and the composer (owner, 2026-11-05: "too
 * crowded"). The venture's context sits in the right panel beside it: its stage and focus, what is due, open help
 * requests, whether the conversation is remembered (the default) or private, and quick actions that fill the
 * composer. With something to pick up, the greeting is the
 * vEIR's opener ("Welcome back, Maya / Last time we were on per-library pricing. How did the facilities call
 * go?"), the line the conversation then opens with; else, and for a private chat, the time of day. The first
 * message creates the conversation and opens it, where that message is answered; there is no setup step.
 * Read-only roles see where they can go instead.
 */
export function NewChatPage() {
  const me = useRequiredMe();
  const { ventureId } = routeApi.useParams();
  // One New chat per venture: switching ventures (the same route, new params) must not carry a draft across.
  // The venture's uploads live above its pages, and opening another venture stops and forgets them.
  return canWrite(me, ventureId) ? <NewChat key={ventureId} /> : <ReadOnlyVenture />;
}

function Greeting({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center">
      <h1 data-page-title tabIndex={-1} className="text-title font-semibold text-balance outline-none">
        {title}
      </h1>
      {children}
    </div>
  );
}

function ReadOnlyVenture() {
  const me = useRequiredMe();
  const { tenant, ventureId } = routeApi.useParams();
  const venture = useVenture(ventureId);
  const name = venture.data?.name ?? 'this venture';
  return (
    <div className="mx-auto flex w-full max-w-(--content-width) flex-1 flex-col justify-center px-4 py-16 sm:px-6">
      <Greeting title={`${greeting()}, ${firstName(me.principal.displayName)}`}>
        <p className="mt-3 max-w-xl text-pretty text-muted-foreground">
          Conversations are private to the team. You can read {name}’s knowledge and documents.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-2">
          <Button asChild variant="secondary">
            <Link to="/$tenant/app/v/$ventureId/knowledge" params={{ tenant, ventureId }}>
              Knowledge
            </Link>
          </Button>
          <Button asChild variant="ghost">
            <Link to="/$tenant/app/v/$ventureId/documents" params={{ tenant, ventureId }}>
              Documents
            </Link>
          </Button>
        </div>
      </Greeting>
    </div>
  );
}

function NewChat() {
  const me = useRequiredMe();
  const { tenant, ventureId } = routeApi.useParams();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const venture = useVenture(ventureId);
  const veir = veirDisplay(venture.data);
  const availability = venture.data ? coachingAvailability(me, venture.data) : null;
  // How the vEIR would open a conversation now. Never a greeting fetched before the last conversation (refetched
  // when stale), and never changed once shown: what New chat greets with is what the conversation opens with.
  const openerQuery = useQuery({
    ...conversationOpenerQueryOptions(ventureId),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [openerLate, setOpenerLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setOpenerLate(true);
    }, OPENER_WAIT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  const [shown, setShown] = useState<ShownOpener | null>(null);
  if (shown === null) {
    const preview = openerQuery.data;
    if (preview !== undefined && !openerQuery.isRefetching) {
      setShown({
        opener: preview.opener,
        at: preview.opener === null ? null : preview.at,
        returning: preview.lastConversation !== null,
      });
    } else if (openerQuery.isError || openerLate) {
      // Not in time (or not at all): greet without it, and the conversation opens without one too.
      setShown({ opener: null, at: null, returning: false });
    }
  }
  // New chat is for the venture team; its Call entry shows only while calls are on.
  const callsAvailable = useCallsAvailable(ventureId, true);
  const createSession = useCreateSession(ventureId);
  const attachments = useComposerAttachments(ventureId, NEW_CHAT_ORIGIN);

  const [text, setText] = useState('');
  const [mode, setMode] = useState<ComposerMode>('auto');
  const [counterpart, setCounterpart] = useState('');
  // Remember or Private, shared with a call started from here. Every fresh New chat starts at Remember.
  const [privacy, setPrivacy] = useStartPrivacy(ventureId);
  const temporary = privacy === 'ephemeral';
  useEffect(() => {
    setPrivacy('standard');
  }, [setPrivacy]);
  // The choice is in view while the context panel is open beside the composer.
  const inspector = useInspector();
  const contextInView = inspector.open && inspector.isDesktop;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Fetch the conversation screen's code while the person writes, so it opens the moment the first
  // message is sent (the message itself waits in memory until it does). The venture memory the
  // conversation binds suggestions to is warmed too.
  useEffect(() => {
    void router
      .loadRouteChunk(router.routesById['/$tenant/app/v/$ventureId/c/$sessionId'])
      ?.catch(() => undefined);
  }, [router]);
  useEffect(() => {
    queryClient.query(memoryQueryOptions(ventureId)).catch(() => undefined);
  }, [queryClient, ventureId]);

  const focusComposer = useCallback(() => {
    textareaRef.current?.focus();
  }, []);
  useHotkeys({ '/': focusComposer });

  // On desktop, put the cursor in the composer once the page has settled (after route focus moved to the
  // heading, and once the greeting is known: the composer is not there before). Touch devices keep the keyboard
  // closed until the person taps.
  const ready = shown !== null && !venture.isPending;
  useEffect(() => {
    if (!ready || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const timer = setTimeout(() => {
      const active = document.activeElement;
      const idle =
        active === null ||
        active === document.body ||
        active.id === 'main-content' ||
        active.hasAttribute('data-page-title');
      if (idle) textareaRef.current?.focus({ preventScroll: true });
    }, 60);
    return () => {
      clearTimeout(timer);
    };
  }, [ventureId, ready]);

  const send = () => {
    const value = text.trim();
    if (!value || value.length > MAX_TURN_CHARS || !availability?.available || createSession.isPending)
      return;
    const chosenMode = modeToSend(mode);
    const rehearsalCounterpart =
      chosenMode === 'rehearse' && counterpart.trim() ? counterpart.trim() : undefined;
    createSession.mutate(
      newConversationRequest({ mode: chosenMode, privacy, openerShownAt: shown?.at ?? null }),
      {
        onSuccess: (session) => {
          setPendingFirstMessage(session.id, { text: value, mode: chosenMode, rehearsalCounterpart });
          // Files still uploading go on, and show in the conversation's composer instead of this one.
          attachments.handOver(conversationOrigin(session.id));
          void navigate({
            to: '/$tenant/app/v/$ventureId/c/$sessionId',
            params: { tenant, ventureId, sessionId: session.id },
          });
        },
        onError: (error) => {
          toast.error('Couldn’t start the conversation', { description: errorMessage(error) });
        },
      },
    );
  };

  const choose = (suggestion: PromptSuggestion) => {
    setText(suggestion.prompt.slice(0, MAX_TURN_CHARS));
    if (
      suggestion.mode &&
      (!venture.data?.persona || venture.data.persona.allowedModes.includes(suggestion.mode))
    ) {
      setMode(suggestion.mode);
    }
    focusComposer();
  };

  const name = veir?.name ?? NEUTRAL_MENTOR_NAME;
  const available = availability?.available === true;
  const welcome = newChatGreeting({
    opener: shown?.opener ?? null,
    firstName: firstName(me.principal.displayName),
    ventureName: venture.data?.name ?? 'your venture',
    returning: shown?.returning ?? false,
    privateChat: temporary,
  });

  // The page appears once its greeting is known (briefly, at most OPENER_WAIT_MS): it never changes in front of
  // the founder, and nothing moves under them.
  if (!ready) {
    return (
      <div
        // Keyed apart from the page: the page arrives as a new element, so nothing on screen "moves" (a reused
        // node moving from the centred skeleton counted as a layout shift on a slow phone).
        key="pending"
        aria-busy="true"
        className="mx-auto flex w-full max-w-(--content-width) flex-1 flex-col items-center justify-center gap-4 px-4"
      >
        <span className="sr-only" role="status">
          Loading…
        </span>
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-5 w-80 max-w-full" />
        <Skeleton className="h-28 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div key="ready" className="relative flex flex-1 flex-col">
      <PanelToggle />
      <div className="mx-auto flex w-full max-w-(--content-width) flex-1 flex-col justify-center px-4 pt-16 pb-[min(14vh,7rem)] sm:px-6">
        <Greeting title={welcome.title}>
          <p
            data-testid="greeting-line"
            className="mt-2 max-w-xl text-body text-pretty text-muted-foreground"
          >
            {welcome.line}
          </p>
        </Greeting>

        <div className="mt-8">
          <Composer
            value={text}
            onChange={setText}
            personaName={name}
            mode={mode}
            onModeChange={setMode}
            allowedModes={venture.data?.persona?.allowedModes}
            counterpart={counterpart}
            onCounterpartChange={setCounterpart}
            streaming={false}
            busy={createSession.isPending}
            disabledReason={available ? null : (availability?.title ?? 'Unavailable')}
            onSend={send}
            onStop={() => undefined}
            textareaRef={textareaRef}
            top={
              <AttachmentTray
                items={attachments.items}
                onCancel={attachments.cancel}
                onRetry={attachments.retry}
                onDismiss={attachments.dismiss}
              />
            }
            // Attached files go into the venture's Documents, which last: a private chat offers none.
            tools={temporary ? null : <AttachButton onFiles={attachments.attach} disabled={!available} />}
            actions={
              available && callsAvailable && veir ? (
                <SimpleTooltip content={`Call ${name}`}>
                  <Button asChild variant="subtle" size="icon-sm" className="rounded-full">
                    <Link
                      to="/$tenant/app/v/$ventureId"
                      params={{ tenant, ventureId }}
                      search={{ call: 1 }}
                      aria-label={`Call ${name}`}
                      // Remember or Private was in view in the context panel beside it: the call starts at once
                      // with that choice. With the panel closed, the call asks first.
                      onClick={() => {
                        if (contextInView) markChoiceInView(ventureId);
                      }}
                    >
                      <AudioLines aria-hidden />
                    </Link>
                  </Button>
                </SimpleTooltip>
              ) : null
            }
          />
          {!available && availability?.reason ? (
            <p className="mt-3 text-center text-small text-muted-foreground" role="status">
              {availability.reason}
            </p>
          ) : temporary ? (
            <p className="mt-3 text-center text-caption text-muted-foreground" data-testid="private-note">
              Private: not kept.
            </p>
          ) : null}
        </div>
      </div>

      <Inspector title="Context" remember="context" defaultOpen>
        <VentureContext
          tenant={tenant}
          ventureId={ventureId}
          veir={veir}
          memory={
            available ? { kind: 'choice', value: privacy, onChange: setPrivacy } : { kind: 'fixed', privacy }
          }
          onPrompt={available ? choose : undefined}
        />
      </Inspector>
    </div>
  );
}

/**
 * The context panel's toggle on New chat (which has no header): in the phone bar on phones, else at the page's top
 * right while the panel is not beside the content (closed on desktop, or a sheet on a tablet). The open panel has
 * its own close.
 */
function PanelToggle() {
  const { open, isDesktop } = useInspector();
  const phone = !useMediaQuery(BREAKPOINTS.md, true);
  if (phone) {
    return (
      <PhoneBarAction>
        <InspectorToggle className="size-9" />
      </PhoneBarAction>
    );
  }
  if (open && isDesktop) return null;
  return (
    <div className="absolute top-4 right-4 z-10" data-print="hide">
      <InspectorToggle />
    </div>
  );
}
