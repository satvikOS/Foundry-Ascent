import { CreateTurnRequest, type CoachMode } from '@foundry/contracts';
import { ArrowUp, Bot, Square } from 'lucide-react';
import { useId, type KeyboardEvent, type Ref } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatNumber } from '@/lib/format';
import { MODE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

import { COACH_MODES } from './modes';

export const MAX_TURN_CHARS = CreateTurnRequest.shape.text.maxLength ?? 8000;
const COUNTERPART_MAX = 120;

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  mode: CoachMode;
  onModeChange: (mode: CoachMode) => void;
  /** Modes the persona release allows (all six when undefined). */
  allowedModes?: readonly CoachMode[] | undefined;
  counterpart: string;
  onCounterpartChange: (value: string) => void;
  streaming: boolean;
  /** When set, the composer is disabled and shows this reason. */
  disabledReason: string | null;
  onSend: () => void;
  onStop: () => void;
  textareaRef?: Ref<HTMLTextAreaElement>;
}

/**
 * Message composer: Enter sends, Shift+Enter adds a line, Escape stops a streaming answer. Shows the
 * mode switcher, the rehearsal counterpart (rehearse mode), a character count and a persistent short
 * AI reminder.
 */
export function Composer({
  value,
  onChange,
  mode,
  onModeChange,
  allowedModes,
  counterpart,
  onCounterpartChange,
  streaming,
  disabledReason,
  onSend,
  onStop,
  textareaRef,
}: ComposerProps) {
  const ids = { hint: useId(), count: useId(), mode: useId(), counterpart: useId() };
  const length = value.length;
  const tooLong = length > MAX_TURN_CHARS;
  const empty = value.trim().length === 0;
  const disabled = disabledReason !== null;
  const modes = COACH_MODES.filter((m) => !allowedModes || allowedModes.includes(m));
  const nearLimit = length > MAX_TURN_CHARS * 0.9;

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && streaming) {
      event.preventDefault();
      onStop();
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!streaming && !empty && !tooLong && !disabled) onSend();
  };

  return (
    <div
      data-slot="composer"
      className={cn(
        'rounded-xl border bg-card shadow-md transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-1 focus-within:ring-ring',
        tooLong ? 'border-destructive' : 'border-border-strong',
        disabled && 'opacity-80',
      )}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (streaming) onStop();
          else if (!empty && !tooLong && !disabled) onSend();
        }}
        aria-label="Message Foundry Guide"
      >
        <label htmlFor={`${ids.hint}-input`} className="sr-only">
          Message Foundry Guide
        </label>
        <Textarea
          id={`${ids.hint}-input`}
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
          placeholder={disabledReason ?? 'Ask Foundry Guide about your venture…'}
          className="min-h-14 border-0 bg-transparent px-4 pt-3 text-[15px] leading-6 shadow-none hover:border-0 focus-visible:ring-0"
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-2.5 py-2">
          <label htmlFor={ids.mode} className="sr-only">
            Mode for the next message
          </label>
          <Select
            value={mode}
            disabled={disabled}
            onValueChange={(next) => {
              onModeChange(next as CoachMode);
            }}
          >
            <SelectTrigger
              id={ids.mode}
              size="sm"
              className="h-8 border-transparent shadow-none hover:border-border"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
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
              <label htmlFor={ids.counterpart} className="text-xs whitespace-nowrap text-muted-foreground">
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
          <div className="ml-auto flex items-center gap-3">
            <p id={ids.hint} className="hidden items-center gap-1 text-xs text-subtle-foreground lg:flex">
              {streaming ? (
                <>
                  <Kbd>Esc</Kbd> to stop
                </>
              ) : (
                <>
                  <Kbd>Enter</Kbd> to send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line
                </>
              )}
            </p>
            <p
              id={ids.count}
              className={cn(
                'tabular text-xs',
                tooLong
                  ? 'font-medium text-destructive'
                  : nearLimit
                    ? 'text-warning'
                    : 'text-subtle-foreground',
              )}
            >
              {formatNumber(length)}/{formatNumber(MAX_TURN_CHARS)}
              <span className="sr-only"> characters{tooLong ? ' — too long to send' : ''}</span>
            </p>
            {streaming ? (
              <Button type="submit" size="sm" variant="secondary" aria-label="Stop generating">
                <Square aria-hidden className="size-3.5 fill-current" />
                Stop
              </Button>
            ) : (
              <Button
                type="submit"
                size="sm"
                disabled={disabled || empty || tooLong}
                aria-label="Send message"
              >
                <ArrowUp aria-hidden />
                Send
              </Button>
            )}
          </div>
        </div>
      </form>
      <p className="flex items-center gap-1.5 border-t border-dashed border-border px-4 py-1.5 text-[11px] text-subtle-foreground">
        <Bot aria-hidden className="size-3" />
        Foundry Guide is an AI coach, not a person. Check important claims against the cited evidence.
      </p>
    </div>
  );
}
