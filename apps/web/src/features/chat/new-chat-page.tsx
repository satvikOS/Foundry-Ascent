import { useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate, useRouter } from '@tanstack/react-router';
import {
  AlarmClock,
  EyeOff,
  FlaskConical,
  Inbox,
  Lightbulb,
  LifeBuoy,
  Target,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { VeirBadge } from '@/components/faces/veir-badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
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
import { Composer, MAX_TURN_CHARS, type ComposerMode } from '../coach/composer';
import { setPendingCounterpart } from '../coach/pending-counterpart';
import { setPendingFirstMessage } from '../coach/pending-first-message';
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
 * few starting points from the venture's state. The first message creates the conversation and opens
 * it, where that message is answered — there is no setup dialog. Mode defaults to Auto; "Temporary"
 * starts a chat that keeps no memory and no summary.
 */
export function NewChatPage() {
  const me = useRequiredMe();
  const { tenant, ventureId } = routeApi.useParams();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const venture = useVenture(ventureId);
  const overview = useVentureOverview(ventureId);
  const veir = veirDisplay(venture.data);
  const writable = canWrite(me, ventureId);
  const notebook = useNotebook(ventureId, { enabled: writable && veir !== null });
  const availability = venture.data ? coachingAvailability(me, venture.data) : null;
  const createSession = useCreateSession(ventureId);

  const [text, setText] = useState('');
  const [mode, setMode] = useState<ComposerMode>('auto');
  const [counterpart, setCounterpart] = useState('');
  const [temporary, setTemporary] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Fetch the conversation screen's code while the person writes, so it opens the moment the first
  // message is sent (the message itself waits in memory until it does).
  // The venture memory the conversation binds suggestions to is warmed here too.
  useEffect(() => {
    void router
      .loadRouteChunk(router.routesById['/$tenant/app/v/$ventureId/c/$sessionId'])
      ?.catch(() => undefined);
  }, [router]);
  useEffect(() => {
    if (writable) queryClient.query(memoryQueryOptions(ventureId)).catch(() => undefined);
  }, [queryClient, ventureId, writable]);

  const focusComposer = useCallback(() => {
    textareaRef.current?.focus();
  }, []);
  useHotkeys({ '/': focusComposer });

  // On desktop, put the cursor in the composer once the page has settled (after route focus moved to
  // the heading). Touch devices keep the keyboard closed until the person taps.
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
    const chosenMode = mode === 'auto' ? undefined : mode;
    const rehearsalCounterpart =
      chosenMode === 'rehearse' && counterpart.trim() ? counterpart.trim() : undefined;
    createSession.mutate(
      { ...(chosenMode ? { mode: chosenMode } : {}), privacy: temporary ? 'ephemeral' : 'standard' },
      {
        onSuccess: (session) => {
          setPendingFirstMessage(session.id, { text: value, mode: chosenMode, rehearsalCounterpart });
          if (rehearsalCounterpart) setPendingCounterpart(session.id, rehearsalCounterpart);
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
  const suggestions = writable && availability?.available ? newChatSuggestions(overview.data ?? null) : [];

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
    <div className="flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-(--content-width) flex-1 flex-col justify-center px-4 pt-10 pb-[min(14vh,7rem)] sm:px-6">
        <div className="flex flex-col items-center text-center">
          {veir ? (
            <div className="flex flex-col items-center gap-3">
              <PersonaAvatar name={veir.shortName} portraitUrl={veir.portraitUrl} size="xl" decorative />
              <p className="flex items-center gap-2 text-small font-medium">
                {veir.shortName}
                <VeirBadge kind={veir.kind} />
              </p>
            </div>
          ) : null}
          <h1
            data-page-title
            tabIndex={-1}
            className="mt-6 font-serif text-title font-normal text-balance outline-none"
          >
            {greeting()}, {firstName(me.principal.displayName)}
          </h1>
          <p className="mt-3 max-w-xl font-serif text-subheading text-pretty text-muted-foreground">
            {opener ??
              (writable
                ? `What should we work on for ${venture.data?.name ?? 'your venture'} today?`
                : `You can read ${venture.data?.name ?? 'this venture'}’s conversations from the sidebar.`)}
          </p>
        </div>

        {writable ? (
          <div className="mt-10">
            {availability && !availability.available && availability.title ? (
              <Alert variant="warning" title={availability.title} className="mb-4">
                {availability.reason}
              </Alert>
            ) : null}
            <Composer
              value={text}
              onChange={setText}
              personaName={name}
              disclosure={veir?.disclosure}
              mode={mode}
              onModeChange={setMode}
              allowAuto
              allowedModes={venture.data?.persona?.allowedModes}
              counterpart={counterpart}
              onCounterpartChange={setCounterpart}
              streaming={false}
              busy={createSession.isPending}
              disabledReason={
                availability?.available === false ? (availability.reason ?? 'Unavailable') : null
              }
              onSend={send}
              onStop={() => undefined}
              textareaRef={textareaRef}
              toolbarExtra={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={temporary}
                  disabled={availability?.available === false}
                  onClick={() => {
                    setTemporary((value) => !value);
                  }}
                  className={cn(
                    'h-8 rounded-full px-3 text-small font-normal text-muted-foreground',
                    temporary && 'bg-accent text-foreground',
                  )}
                >
                  <EyeOff aria-hidden />
                  Temporary
                </Button>
              }
            />
            {temporary ? (
              <p className="mt-2 text-center text-caption text-muted-foreground" role="status">
                Temporary chat: nothing from it is remembered or summarised.
              </p>
            ) : null}

            {suggestions.length > 0 ? (
              <ul aria-label="Suggestions" className="mt-6 flex flex-wrap justify-center gap-2">
                {suggestions.map((suggestion) => (
                  <li key={suggestion.id}>
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
        ) : null}
      </div>
    </div>
  );
}

const chipClasses = cn(
  'inline-flex h-9 max-w-full items-center gap-2 rounded-full border border-border bg-transparent px-3.5 text-small text-muted-foreground transition-colors',
  'hover:border-border-strong hover:bg-accent/60 hover:text-foreground',
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
      <Link
        to="/$tenant/app/v/$ventureId/knowledge"
        params={{ tenant, ventureId }}
        search={{ view: 'proposed' }}
        className={chipClasses}
      >
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
