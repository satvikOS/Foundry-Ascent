import { CreateTurnRequest, type CoachMode } from '@foundry/contracts';
import { ArrowUp, Sparkles, Square } from 'lucide-react';
import { useId, type KeyboardEvent, type ReactNode, type Ref } from 'react';

import { DisclosureBanner } from '@/components/disclosure-banner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatNumber } from '@/lib/format';
import { MODE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

import { COACH_MODES } from './modes';

export const MAX_TURN_CHARS = CreateTurnRequest.shape.text.maxLength ?? 8000;
const COUNTERPART_MAX = 120;

/** "Auto": the vEIR picks how to help (no mode is sent with the message). */
export type ComposerMode = CoachMode | 'auto';

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** The vEIR's short name ("Corin"): names the message box and its placeholder. */
  personaName: string;
  /** Persona release disclosure, shown as the conversation's one AI disclosure line. */
  disclosure?: string | null | undefined;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  /** Offer "Auto" (the vEIR picks the approach) as the first mode. */
  allowAuto?: boolean;
  /** Modes the persona release allows (all six when undefined). */
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
  /** Extra controls in the toolbar, before the send button (e.g. "Temporary chat"). */
  toolbarExtra?: ReactNode;
  className?: string;
}

/**
 * Message composer: Enter sends, Shift+Enter adds a line, Escape stops an answer being written. A
 * compact mode chip, the rehearsal counterpart (rehearse mode), a character count only near the limit,
 * and under it the conversation's single AI disclosure line.
 */
export function Composer({
  value,
  onChange,
  personaName,
  disclosure,
  mode,
  onModeChange,
  allowAuto = false,
  allowedModes,
  counterpart,
  onCounterpartChange,
  streaming,
  busy = false,
  disabledReason,
  onSend,
  onStop,
  textareaRef,
  toolbarExtra,
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
    <div data-slot="composer-region" className={cn('grid gap-2', className)}>
      <div
        data-slot="composer"
        className={cn(
          'rounded-2xl border bg-card shadow-sm transition-[border-color,box-shadow] duration-150',
          'focus-within:border-ring/60 focus-within:shadow-md',
          tooLong ? 'border-destructive' : 'border-border-strong',
          disabled && 'opacity-80',
        )}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (streaming) onStop();
            else if (!busy && !empty && !tooLong && !disabled) onSend();
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
            minRows={2}
            maxRows={10}
            disabled={disabled}
            aria-describedby={`${ids.hint} ${ids.count}`}
            aria-invalid={tooLong || undefined}
            placeholder={disabledReason ?? `Message ${personaName}…`}
            className="min-h-14 resize-none border-0 bg-transparent px-4 pt-3.5 text-body shadow-none hover:border-0 focus-visible:ring-0"
          />
          <p id={ids.hint} className="sr-only">
            {streaming ? 'Press Escape to stop the answer.' : 'Enter sends. Shift and Enter adds a new line.'}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-1 pb-2.5">
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
                className="h-8 rounded-full border-border bg-transparent px-3 text-small shadow-none hover:border-border-strong"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {allowAuto ? (
                  <SelectItem value="auto">
                    <Sparkles aria-hidden className="size-4 text-muted-foreground" />
                    Auto
                  </SelectItem>
                ) : null}
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
                  placeholder="e.g. Seed investor"
                  className="h-8 sm:w-48"
                />
              </div>
            ) : null}
            {toolbarExtra}
            <div className="ml-auto flex items-center gap-3">
              <p
                id={ids.count}
                className={cn(
                  'tabular text-caption',
                  nearLimit ? '' : 'sr-only',
                  tooLong ? 'font-medium text-destructive' : 'text-warning',
                )}
              >
                {nearLimit ? `${formatNumber(length)}/${formatNumber(MAX_TURN_CHARS)}` : null}
                {tooLong ? <span className="sr-only"> characters — too long to send</span> : null}
              </p>
              {streaming ? (
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  aria-label="Stop generating"
                  className="rounded-full"
                >
                  <Square aria-hidden className="size-3.5 fill-current" />
                  Stop
                </Button>
              ) : (
                <Button
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
      <DisclosureBanner variant="line" text={disclosure} />
    </div>
  );
}
