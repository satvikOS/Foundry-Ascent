import type { PersonaView, TestTurnResponse } from '@foundry/contracts';
import { ChevronRight, FlaskConical, HandHeart, LoaderCircle, RotateCcw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { VeirBadge } from '@/components/faces/veir-badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Markdown } from '@/components/ui/markdown';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { isAbortError } from '@/lib/api/errors';
import { sendTestTurn, usePersonaRelease } from '@/lib/api/hooks/eir';
import { cn } from '@/lib/utils';

import { EvidenceChip } from '../../coach/response/evidence-chip';
import { Composer, modeToSend, type ComposerMode } from '../../chat/composer';
import { ANSWER_PROSE } from '../../chat/veir-answer';
import {
  benchErrorMessage,
  benchHistory,
  benchReleases,
  checkNotes,
  heldBackReason,
  type BenchExchange,
} from './test-bench';

interface TestBenchTabProps {
  persona: PersonaView;
  /** The vEIR's name ("Corin’s vEIR", lib/veir). */
  displayName: string;
}

/**
 * EIR studio → a persona → Test bench: a curator talks to a release (the active one or a draft) the way a
 * founder would, before approving it. Each answer comes through the same checks as a founder's and says what
 * they did. Nothing is saved: the conversation lives in this tab only and is gone when the tab closes or the
 * curator starts over.
 */
export function TestBenchTab({ persona, displayName }: TestBenchTabProps) {
  const releases = useMemo(() => benchReleases(persona), [persona]);
  const [chosen, setChosen] = useState<string | null>(null);
  const current = releases.find((r) => r.id === chosen) ?? releases[0] ?? null;
  const release = usePersonaRelease(current?.id ?? null);
  const [exchanges, setExchanges] = useState<BenchExchange[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ text: string; message: string } | null>(null);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<ComposerMode>('auto');
  const [counterpart, setCounterpart] = useState('');
  const inFlight = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerId = useId();

  // Leaving the tab cancels a message still being answered (its answer would have nowhere to go).
  useEffect(
    () => () => {
      inFlight.current?.abort();
    },
    [],
  );

  // Stop: the message goes back into the box, unanswered.
  const stop = () => {
    inFlight.current?.abort();
    inFlight.current = null;
    if (pending !== null) setText((draft) => (draft.trim() ? draft : pending));
    setPending(null);
  };

  const startOver = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setExchanges([]);
    setPending(null);
    setFailure(null);
    setText('');
    textareaRef.current?.focus();
  }, []);

  const send = (message: string) => {
    const trimmed = message.trim();
    if (current === null || trimmed === '' || pending !== null) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setPending(trimmed);
    setFailure(null);
    setText('');
    const rehearsing = mode === 'rehearse' && counterpart.trim() !== '';
    sendTestTurn(
      persona.id,
      {
        releaseId: current.id,
        text: trimmed,
        mode: modeToSend(mode),
        ...(rehearsing ? { rehearsalCounterpart: counterpart.trim() } : {}),
        history: benchHistory(exchanges),
      },
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setExchanges((list) => [...list, { id: crypto.randomUUID(), text: trimmed, result }]);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setFailure({ text: trimmed, message: benchErrorMessage(error) });
        setText((draft) => (draft.trim() ? draft : trimmed));
      })
      .finally(() => {
        if (inFlight.current === controller) {
          inFlight.current = null;
          setPending(null);
        }
      });
  };

  if (current === null) {
    return (
      <EmptyState
        icon={FlaskConical}
        headingLevel={2}
        title="There’s no release to try yet"
        description="Draft a release in Releases. You can try it here before you approve it."
      />
    );
  }

  const unavailable =
    persona.status === 'suspended'
      ? 'Resume this vEIR to try a release'
      : persona.status === 'retired'
        ? 'This vEIR is retired'
        : null;
  const busy = pending !== null;
  const empty = exchanges.length === 0 && !busy && failure === null;

  return (
    <section aria-label="Test bench" data-testid="test-bench" className="grid gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid min-w-0 gap-1.5">
          <h2 className="font-serif text-subheading font-normal text-balance">Test bench</h2>
          <p className="max-w-[64ch] text-small text-pretty text-muted-foreground">
            Try a release before you approve it. Write as a founder would. Nothing here is saved, no founder
            sees it, and no venture is attached.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={pickerId} className="text-small text-muted-foreground">
            Release
          </label>
          <Select
            value={current.id}
            onValueChange={(next) => {
              if (next === current.id) return;
              // A conversation belongs to one release: switching starts over.
              startOver();
              setChosen(next);
            }}
          >
            <SelectTrigger id={pickerId} size="sm" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {releases.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" onClick={startOver} disabled={empty}>
            <RotateCcw aria-hidden />
            Start over
          </Button>
        </div>
      </div>

      <div className="@container/conv grid gap-6 border-t border-border pt-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <PersonaAvatar name={displayName} size="md" decorative />
          <span className="min-w-0 truncate text-[0.9375rem] font-medium">{displayName}</span>
          <VeirBadge kind={persona.kind} />
          <span className="truncate text-small text-muted-foreground">· {current.label}</span>
        </div>

        {empty ? (
          <p className="max-w-[64ch] text-small text-pretty text-muted-foreground">
            It answers from this release’s doctrine and style, its knowledge library and lessons, through the
            same checks as a founder’s conversation. Under each answer, “What the checks did” says what they
            changed.
          </p>
        ) : null}

        <ol aria-label="Test conversation" className="grid gap-8">
          {exchanges.map((exchange) => (
            <li key={exchange.id} className="grid gap-4">
              <FounderSide text={exchange.text} />
              <AnswerSide result={exchange.result} />
            </li>
          ))}
          {pending !== null ? (
            <li className="grid gap-4">
              <FounderSide text={pending} />
              <p role="status" className="flex items-center gap-2 text-small text-muted-foreground">
                <LoaderCircle aria-hidden className="size-3.5 shrink-0 motion-safe:animate-spin" />
                Writing an answer…
              </p>
            </li>
          ) : null}
        </ol>

        {failure ? (
          <Alert
            variant="destructive"
            title="No answer this time"
            action={
              <Button
                size="sm"
                variant="secondary"
                disabled={unavailable !== null}
                onClick={() => {
                  send(failure.text);
                }}
              >
                Try again
              </Button>
            }
          >
            {failure.message}
          </Alert>
        ) : null}

        <Composer
          value={text}
          onChange={setText}
          personaName={displayName}
          disclosure={release.data?.disclosureText ?? null}
          veirName={displayName}
          mode={mode}
          onModeChange={setMode}
          allowedModes={release.data?.allowedModes}
          counterpart={counterpart}
          onCounterpartChange={setCounterpart}
          streaming={busy}
          disabledReason={unavailable}
          onSend={() => {
            send(text);
          }}
          onStop={stop}
          textareaRef={textareaRef}
        />
      </div>
    </section>
  );
}

/** The curator's message, as a founder's bubble. */
function FounderSide({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-[0.9375rem] leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
        <span className="sr-only">You wrote: </span>
        {text}
      </p>
    </div>
  );
}

/** The validated answer (or why a founder would not see one), then what the checks did. */
function AnswerSide({ result }: { result: TestTurnResponse }) {
  const evidence = useMemo(() => new Map(result.evidence.map((item) => [item.key, item])), [result.evidence]);
  const renderCitation = useCallback(
    (key: string) => <EvidenceChip evidenceKey={key} item={evidence.get(key)} />,
    [evidence],
  );
  return (
    <div className="grid min-w-0 gap-3" data-testid="bench-answer" data-status={result.status}>
      {result.response ? (
        <Markdown renderCitation={renderCitation} className={ANSWER_PROSE}>
          {result.response.answer}
        </Markdown>
      ) : (
        <HeldBack result={result} />
      )}
      <ChecksDisclosure result={result} />
    </div>
  );
}

/** What a founder would see instead of the answer: crisis support in full, or why it was held back. */
function HeldBack({ result }: { result: TestTurnResponse }) {
  const crisis = result.blocked?.reason === 'crisis_support';
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      data-testid="bench-held-back"
      className="rounded-xl border border-border-strong bg-card p-4"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted">
          <HandHeart aria-hidden className="size-4" />
        </span>
        <div className="min-w-0 space-y-2">
          <h3 id={titleId} className="text-[0.9375rem] font-semibold tracking-tight">
            {crisis ? 'A founder would get support from people' : 'A founder would not see this answer'}
          </h3>
          {crisis && result.blocked?.supportMessage ? (
            <Markdown size="sm" className="text-foreground">
              {result.blocked.supportMessage}
            </Markdown>
          ) : (
            <p className="text-small leading-6 text-muted-foreground">{heldBackReason(result)}</p>
          )}
        </div>
      </div>
    </section>
  );
}

/** "What the checks did": collapsed under each answer, in plain words. */
function ChecksDisclosure({ result }: { result: TestTurnResponse }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const lines = useMemo(() => checkNotes(result), [result]);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="inline-flex items-center gap-1.5 rounded-sm text-small text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ShieldCheck aria-hidden className="size-3.5" />
        What the checks did
        <ChevronRight
          aria-hidden
          className={cn('size-3.5 transition-transform motion-reduce:transition-none', open && 'rotate-90')}
        />
      </button>
      <ul
        id={panelId}
        hidden={!open}
        className="mt-2 grid max-w-[68ch] gap-1.5 border-l border-border pl-3 text-small leading-6 text-muted-foreground"
      >
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
