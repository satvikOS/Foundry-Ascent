import { useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate, useRouter } from '@tanstack/react-router';
import {
  AlarmClock,
  AudioLines,
  EyeOff,
  FlaskConical,
  Inbox,
  Lightbulb,
  LifeBuoy,
  Target,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { VeirBadge } from '@/components/faces/veir-badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { errorMessage } from '@/lib/api/errors';
import { memoryQueryOptions } from '@/lib/api/hooks/memory';
import { useNotebook } from '@/lib/api/hooks/notebook';
import { useCreateSession } from '@/lib/api/hooks/sessions';
import { useVenture, useVentureOverview } from '@/lib/api/hooks/ventures';
import { canWrite } from '@/lib/auth/roles';
import { useRequiredMe } from '@/lib/auth/use-me';
import { greeting } from '@/lib/format';
import { useHotkeys } from '@/lib/hooks/use-hotkeys';
import { cn } from '@/lib/utils';
import { veirDisplay } from '@/lib/veir';

import { coachingAvailability } from '../coach/availability';
import { AttachButton, AttachmentTray, useComposerAttachments } from './attachments';
import { Composer, MAX_TURN_CHARS, modeToSend, type ComposerMode } from './composer';
import { newConversationRequest, setPendingFirstMessage } from './first-message';
import { newChatSuggestions, type Suggestion, type SuggestionIcon } from './suggestions';

const routeApi = getRouteApi('/$tenant/app/v/$ventureId/');

const SUGGESTION_ICONS: Record<SuggestionIcon, LucideIcon> = {
  review: Inbox,
  overdue: AlarmClock,
  goal: Target,
  assumption: FlaskConical,
  help: LifeBuoy,
  idea: Lightbulb,
};

function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}

/**
 * New chat: the vEIR's face and a greeting (its notebook opener when it has one), the composer, and a
 * few starting points from the venture's state. The first message creates the conversation and opens it,
 * where that message is answered; there is no setup step. Read-only roles see where they can go instead.
 */
export function NewChatPage() {
  const me = useRequiredMe();
  const { ventureId } = routeApi.useParams();
  return canWrite(me, ventureId) ? <NewChat /> : <ReadOnlyVenture />;
}

function Greeting({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center">
      <h1
        data-page-title
        tabIndex={-1}
        className="mt-6 font-serif text-title font-normal text-balance outline-none"
      >
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
  const veir = veirDisplay(venture.data);
  const name = venture.data?.name ?? 'this venture';
  return (
    <div className="mx-auto flex w-full max-w-(--content-width) flex-1 flex-col justify-center px-4 py-16 sm:px-6">
      {veir ? (
        <div className="flex flex-col items-center gap-3">
          <PersonaAvatar name={veir.shortName} portraitUrl={veir.portraitUrl} size="xl" decorative />
          <p className="flex items-center gap-2 text-small font-medium">
            {veir.shortName}
            <VeirBadge kind={veir.kind} />
          </p>
        </div>
      ) : null}
      <Greeting title={`${greeting()}, ${firstName(me.principal.displayName)}`}>
        <p className="mt-3 max-w-xl text-pretty text-muted-foreground">
          You can read {name}’s knowledge and documents. Conversations with{' '}
          {veir ? veir.shortName : 'its vEIR'} are private to the founders and team.
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
  const overview = useVentureOverview(ventureId);
  const veir = veirDisplay(venture.data);
  const notebook = useNotebook(ventureId, { enabled: veir !== null });
  const availability = venture.data ? coachingAvailability(me, venture.data) : null;
  const createSession = useCreateSession(ventureId);
  const attachments = useComposerAttachments(ventureId);

  const [text, setText] = useState('');
  const [mode, setMode] = useState<ComposerMode>('auto');
  const [counterpart, setCounterpart] = useState('');
  const [temporary, setTemporary] = useState(false);
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
  // heading). Touch devices keep the keyboard closed until the person taps.
  useEffect(() => {
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
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
  }, [ventureId]);

  const send = () => {
    const value = text.trim();
    if (!value || value.length > MAX_TURN_CHARS || !availability?.available || createSession.isPending)
      return;
    const chosenMode = modeToSend(mode);
    const rehearsalCounterpart =
      chosenMode === 'rehearse' && counterpart.trim() ? counterpart.trim() : undefined;
    createSession.mutate(newConversationRequest({ mode: chosenMode, temporary }), {
      onSuccess: (session) => {
        setPendingFirstMessage(session.id, { text: value, mode: chosenMode, rehearsalCounterpart });
        void navigate({
          to: '/$tenant/app/v/$ventureId/c/$sessionId',
          params: { tenant, ventureId, sessionId: session.id },
        });
      },
      onError: (error) => {
        toast.error('Couldn’t start the conversation', { description: errorMessage(error) });
      },
    });
  };

  const choose = (suggestion: Extract<Suggestion, { kind: 'prompt' }>) => {
    setText(suggestion.prompt.slice(0, MAX_TURN_CHARS));
    if (
      suggestion.mode &&
      (!venture.data?.persona || venture.data.persona.allowedModes.includes(suggestion.mode))
    ) {
      setMode(suggestion.mode);
    }
    focusComposer();
  };

  const name = veir?.shortName ?? 'your vEIR';
  const opener = notebook.data?.nextOpener?.trim() ?? null;
  const available = availability?.available === true;
  const suggestions = available && !temporary ? newChatSuggestions(overview.data ?? null) : [];

  if (venture.isPending) {
    return (
      <div
        aria-busy="true"
        className="mx-auto flex w-full max-w-(--content-width) flex-1 flex-col items-center justify-center gap-4 px-4"
      >
        <span className="sr-only" role="status">
          Loading…
        </span>
        <Skeleton className="size-16 rounded-full" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-28 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 flex-col">
      <div className="absolute top-3 right-3 z-10 sm:top-4 sm:right-4">
        <SimpleTooltip content={temporary ? 'Turn off temporary chat' : 'Temporary chat: not remembered'}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={temporary}
            disabled={!available}
            onClick={() => {
              setTemporary((value) => !value);
            }}
            className={cn(
              'rounded-full text-muted-foreground',
              temporary && 'bg-accent text-foreground hover:bg-accent',
            )}
          >
            <EyeOff aria-hidden />
            Temporary
          </Button>
        </SimpleTooltip>
      </div>

      <div className="mx-auto flex w-full max-w-(--content-width) flex-1 flex-col justify-center px-4 pt-16 pb-[min(14vh,7rem)] sm:px-6">
        {veir ? (
          <div className="flex flex-col items-center gap-3">
            <PersonaAvatar name={veir.shortName} portraitUrl={veir.portraitUrl} size="xl" decorative />
            <p className="flex items-center gap-2 text-small font-medium">
              {veir.shortName}
              <VeirBadge kind={veir.kind} />
            </p>
          </div>
        ) : null}
        <Greeting
          title={temporary ? 'Temporary chat' : `${greeting()}, ${firstName(me.principal.displayName)}`}
        >
          <p className="mt-3 max-w-xl font-serif text-subheading text-pretty text-muted-foreground">
            {temporary
              ? `${name} won’t remember it. It’s erased when it ends or after 24 hours idle.`
              : (opener ?? `What should we work on for ${venture.data?.name ?? 'your venture'} today?`)}
          </p>
        </Greeting>

        <div className="mt-10">
          <Composer
            value={text}
            onChange={setText}
            personaName={name}
            disclosure={veir?.disclosure}
            veirName={veir?.name}
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
            // Attached files go into the venture's Documents, which last: a temporary chat offers none.
            tools={temporary ? null : <AttachButton onFiles={attachments.attach} disabled={!available} />}
            actions={
              available && veir ? (
                <SimpleTooltip content={`Call ${name}`}>
                  <Button asChild variant="subtle" size="icon-sm" className="rounded-full">
                    <Link
                      to="/$tenant/app/v/$ventureId"
                      params={{ tenant, ventureId }}
                      search={{ call: 1 }}
                      aria-label={`Call ${name}`}
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
          ) : null}

          {suggestions.length > 0 ? (
            <ul aria-label="Suggestions" className="mt-6 flex flex-wrap justify-center gap-2">
              {suggestions.map((suggestion) => (
                <li key={suggestion.id} className="max-w-full">
                  <SuggestionChip
                    suggestion={suggestion}
                    tenant={tenant}
                    ventureId={ventureId}
                    onChoose={choose}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const chipClasses = cn(
  'inline-flex h-9 max-w-full items-center gap-2 rounded-full border border-border bg-transparent px-3.5 text-small text-muted-foreground transition-colors',
  'hover:border-border-strong hover:text-foreground',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
);

function SuggestionChip({
  suggestion,
  tenant,
  ventureId,
  onChoose,
}: {
  suggestion: Suggestion;
  tenant: string;
  ventureId: string;
  onChoose: (suggestion: Extract<Suggestion, { kind: 'prompt' }>) => void;
}) {
  const Icon = SUGGESTION_ICONS[suggestion.icon];
  const content = (
    <>
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="truncate">{suggestion.label}</span>
    </>
  );
  if (suggestion.kind === 'review') {
    return (
      <Link to="/$tenant/app/v/$ventureId/knowledge" params={{ tenant, ventureId }} className={chipClasses}>
        {content}
      </Link>
    );
  }
  if (suggestion.kind === 'help') {
    return (
      <Link to="/$tenant/app/v/$ventureId/help" params={{ tenant, ventureId }} className={chipClasses}>
        {content}
      </Link>
    );
  }
  return (
    <button
      type="button"
      className={chipClasses}
      onClick={() => {
        onChoose(suggestion);
      }}
    >
      {content}
    </button>
  );
}
