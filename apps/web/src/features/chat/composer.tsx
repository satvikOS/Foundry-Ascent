import { CreateTurnRequest, type CoachMode } from '@foundry/contracts';
import { ArrowUp, Sparkles, Square } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';

import { DisclosureBanner } from '@/components/disclosure-banner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatNumber } from '@/lib/format';
import { MODE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

import { COACH_MODES } from '../coach/modes';

export const MAX_TURN_CHARS = CreateTurnRequest.shape.text.maxLength ?? 8000;
const COUNTERPART_MAX = 120;

/** "Auto": the vEIR picks how to help (no mode is sent with the message). */
export type ComposerMode = CoachMode | 'auto';

/** The `mode` to send with a message: none for Auto. */
export function modeToSend(mode: ComposerMode): CoachMode | undefined {
  return mode === 'auto' ? undefined : mode;
}

/**
 * Stop ignores clicks this soon after an answer starts: Send turns into Stop under the pointer, so the second
 * click of a double click on Send would otherwise stop the message it just sent.
 */
export const STOP_GRACE_MS = 600;

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** The vEIR's short name ("Corin"): names the message box and its placeholder. */
  personaName: string;
  /** The persona release's disclosure, shown as the view's one AI disclosure line. */
  disclosure?: string | null | undefined;
  /** The vEIR's full name ("Corin's vEIR"), named in the disclosure line. */
  veirName?: string | null | undefined;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  /** Modes the persona release allows (all six when undefined). Auto is always offered. */
  allowedModes?: readonly CoachMode[] | undefined;
  counterpart: string;
  onCounterpartChange: (value: string) => void;
  streaming: boolean;
  /** Sending in progress outside the turn stream (e.g. creating the conversation). */
  busy?: boolean;
  /** When set, the composer is disabled and shows this reason. */
  disabledReason: string | null;
  onSend: () => void;
  onStop: () => void;
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Above the message box (attachments being uploaded). */
  top?: ReactNode;
  /** Toolbar controls after the mode chip (attach, temporary chat). */
  tools?: ReactNode;
  /** Toolbar controls just before Send (the call button). */
  actions?: ReactNode;
  className?: string;
}

/**
 * Message composer: Enter sends, Shift+Enter adds a line, Escape stops an answer being written. A
 * compact mode chip (Auto by default), the rehearsal counterpart in Rehearse, a character count only
 * near the limit, and under it the view's single AI disclosure line.
 */
export function Composer({
  value,
  onChange,
  personaName,
  disclosure,
  veirName,
  mode,
  onModeChange,
  allowedModes,
  counterpart,
  onCounterpartChange,
  streaming,
  busy = false,
  disabledReason,
  onSend,
  onStop,
  textareaRef,
  top,
  tools,
  actions,
  className,
}: ComposerProps) {
  const ids = { input: useId(), hint: useId(), count: useId(), mode: useId(), counterpart: useId() };
  const length = value.length;
  const tooLong = length > MAX_TURN_CHARS;
  const empty = value.trim().length === 0;
  const disabled = disabledReason !== null;
  const modes = COACH_MODES.filter((m) => !allowedModes || allowedModes.includes(m));
  const nearLimit = length > MAX_TURN_CHARS * 0.9;
  const label = `Message ${personaName}`;
  // When an answer started from this composer (Stop's grace period runs from there). An answer already under
  // way when the composer appears has no grace period.
  const streamingSince = useRef<number | null>(null);
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (streaming && !wasStreaming.current) streamingSince.current = Date.now();
    if (!streaming) streamingSince.current = null;
    wasStreaming.current = streaming;
  }, [streaming]);
  const stop = (event: MouseEvent<HTMLButtonElement>) => {
    const since = streamingSince.current;
    // A click that belongs to the double click on Send (or lands right after it) is not a request to stop.
    if (event.detail > 1 || (since !== null && Date.now() - since < STOP_GRACE_MS)) return;
    onStop();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && streaming) {
      event.preventDefault();
      onStop();
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!streaming && !busy && !empty && !tooLong && !disabled) onSend();
  };

  return (
    <div data-slot="composer-region" className={cn('grid gap-2.5', className)}>
      <div
        data-slot="composer"
        className={cn(
          'rounded-[1.25rem] border bg-card transition-colors duration-150',
          'focus-within:border-input',
          tooLong ? 'border-destructive' : 'border-border-strong',
          disabled && 'bg-muted/40',
        )}
      >
        {top}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            // Submitting only ever sends: Stop is its own button (and Escape), never the form.
            if (!streaming && !busy && !empty && !tooLong && !disabled) onSend();
          }}
          aria-label={label}
        >
          <label htmlFor={ids.input} className="sr-only">
            {label}
          </label>
          <Textarea
            id={ids.input}
            ref={textareaRef}
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
            }}
            onKeyDown={onKeyDown}
            minRows={1}
            maxRows={10}
            disabled={disabled}
            aria-describedby={`${ids.hint} ${ids.count}`}
            aria-invalid={tooLong || undefined}
            placeholder={disabledReason ?? `Message ${personaName}`}
            className="min-h-13 resize-none border-0 bg-transparent px-4 pt-3.5 pb-1 text-[0.9375rem] leading-6 shadow-none hover:border-0 focus-visible:ring-0 focus-visible:outline-none disabled:bg-transparent"
          />
          <p id={ids.hint} className="sr-only">
            {streaming ? 'Press Escape to stop the answer.' : 'Enter sends. Shift and Enter adds a new line.'}
          </p>
          <div className="flex flex-wrap items-center gap-1 px-2 pt-1 pb-2">
            {tools}
            <label htmlFor={ids.mode} className="sr-only">
              Mode for the next message
            </label>
            <Select
              value={mode}
              disabled={disabled}
              onValueChange={(next) => {
                onModeChange(next as ComposerMode);
              }}
            >
              <SelectTrigger
                id={ids.mode}
                size="sm"
                className="h-8 w-auto gap-1.5 rounded-full border-transparent bg-transparent px-2.5 text-small text-muted-foreground shadow-none hover:border-transparent hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value="auto">
                  <Sparkles aria-hidden className="size-4 text-muted-foreground" />
                  Auto
                </SelectItem>
                {modes.map((m) => {
                  const Icon = MODE_LABELS[m].icon;
                  return (
                    <SelectItem key={m} value={m}>
                      <Icon aria-hidden className="size-4 text-muted-foreground" />
                      {MODE_LABELS[m].label}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {mode === 'rehearse' ? (
              <div className="flex min-w-[12rem] flex-1 items-center gap-1.5 sm:flex-none">
                <label
                  htmlFor={ids.counterpart}
                  className="text-caption whitespace-nowrap text-muted-foreground"
                >
                  Rehearsing with
                </label>
                <Input
                  id={ids.counterpart}
                  value={counterpart}
                  maxLength={COUNTERPART_MAX}
                  disabled={disabled}
                  onChange={(event) => {
                    onCounterpartChange(event.target.value);
                  }}
                  placeholder="A role, e.g. seed investor"
                  className="h-8 sm:w-52"
                />
              </div>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              <p
                id={ids.count}
                className={cn(
                  'tabular mr-1 text-caption',
                  nearLimit ? '' : 'sr-only',
                  tooLong ? 'font-medium text-destructive' : 'text-warning',
                )}
              >
                {nearLimit ? `${formatNumber(length)}/${formatNumber(MAX_TURN_CHARS)}` : null}
                {tooLong ? <span className="sr-only"> characters — too long to send</span> : null}
              </p>
              {actions}
              {streaming ? (
                <Button
                  key="stop"
                  type="button"
                  size="icon-sm"
                  aria-label="Stop generating"
                  className="rounded-full"
                  onClick={stop}
                >
                  <Square aria-hidden className="size-3 fill-current" />
                </Button>
              ) : (
                <Button
                  key="send"
                  type="submit"
                  size="icon-sm"
                  loading={busy}
                  disabled={disabled || empty || tooLong}
                  aria-label="Send message"
                  className="rounded-full"
                >
                  {busy ? null : <ArrowUp aria-hidden />}
                </Button>
              )}
            </div>
          </div>
        </form>
      </div>
      <DisclosureBanner variant="line" text={disclosure} veirName={veirName} />
    </div>
  );
}
