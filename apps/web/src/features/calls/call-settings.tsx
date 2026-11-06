import { Info, SlidersHorizontal } from 'lucide-react';
import { useState, type ReactNode, type RefObject } from 'react';

import { Kbd } from '@/components/ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { PrivacyChoice, type ConversationPrivacy } from '../chat/privacy-choice';
import { CallDisclosureDialog } from './call-disclosure';
import { CAPTION_SIZES, useAnnounceCaptions, useCaptionSize } from './preferences';

/** The controls that exist only once the call is live. */
export interface LiveCallSettings {
  voice: boolean;
  typing: boolean;
  disabled: boolean;
  onTyping: () => void;
  onSwitchToChat: () => void;
}

interface CallSettingsProps {
  /** The vEIR's display name ("Thomas"), in the legend and the disclosure. */
  name: string;
  captions: boolean;
  onCaptions: () => void;
  pushToTalk: boolean;
  onPushToTalk: () => void;
  /** The live call's own controls; null on the start screen. */
  live: LiveCallSettings | null;
  /** A call that starts a new conversation: remembered (the default) or private, chosen before it starts. */
  memory?: {
    value: ConversationPrivacy;
    onChange: (privacy: ConversationPrivacy) => void;
    disabled: boolean;
  } | null;
  /** Controlled opening (the start screen's memory line opens the settings too). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Where focus goes when the settings close, instead of their glyph (the control that opened them). */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/** One segmented choice: buttons with a pressed state, named by their group. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { readonly value: T; readonly label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <p className="text-caption text-muted-foreground" aria-hidden>
        {label}
      </p>
      <div role="group" aria-label={label} className="flex rounded-full border bg-background/60 p-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => {
              onChange(option.value);
            }}
            className={cn(
              'fa-call-focus min-h-9 flex-1 rounded-full px-3 text-small transition-colors duration-150 pointer-coarse:min-h-11',
              value === option.value
                ? 'bg-secondary font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A setting that is on or off: a full-width row with its state and shortcut. */
function Toggle({
  label,
  pressed,
  shortcut,
  disabled,
  onClick,
}: {
  label: string;
  pressed: boolean;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut}
      disabled={disabled}
      onClick={onClick}
      className="fa-call-focus flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-2 text-left text-small text-foreground transition-colors duration-150 hover:bg-accent disabled:opacity-50"
    >
      <span className="flex items-center gap-2">
        {label}
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </span>
      <span
        aria-hidden
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-150',
          pressed ? 'border-foreground bg-foreground' : 'border-border-strong bg-muted',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-3.5 rounded-full transition-[left] duration-150',
            pressed ? 'left-[1.125rem] bg-background' : 'left-0.5 bg-muted-foreground',
          )}
        />
      </span>
    </button>
  );
}

function Section({ children }: { children: ReactNode }) {
  return <div className="grid gap-1 border-t pt-3 first:border-t-0 first:pt-0">{children}</div>;
}

/**
 * The call settings (the sliders glyph, top right, on the start screen and during the call): captions and their size, screen-reader
 * captions, push to talk; before a call into a new conversation, Remember or Private; during the call, typing,
 * switching to chat and the timeline's legend; always, the call's disclosure to read again ("About calls
 * Thomas"). The face is solid over the call (globals.css), never glass over the captions. Choices are remembered in
 * this browser; none changes the voice, identity or session.
 */
export function CallSettings({
  name,
  captions,
  onCaptions,
  pushToTalk,
  onPushToTalk,
  live,
  memory = null,
  open,
  onOpenChange,
  returnFocusRef,
}: CallSettingsProps) {
  const [size, setSize] = useCaptionSize();
  const [announce, setAnnounce] = useAnnounceCaptions();
  const [innerOpen, setInnerOpen] = useState(false);
  const [about, setAbout] = useState(false);
  const voice = live?.voice ?? true;
  const shown = open ?? innerOpen;
  const setShown = (next: boolean) => {
    if (open === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  };
  return (
    <>
      <Popover open={shown} onOpenChange={setShown}>
        <SimpleTooltip content="Call settings" side="bottom">
          <PopoverTrigger
            aria-label="Call settings"
            className="fa-call-focus inline-flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            <SlidersHorizontal aria-hidden className="size-5" />
          </PopoverTrigger>
        </SimpleTooltip>
        <PopoverContent
          align="end"
          aria-label="Call settings"
          className="grid max-h-[calc(100dvh-5rem)] w-[min(20rem,calc(100vw-2rem))] gap-3 overflow-y-auto"
          onCloseAutoFocus={(event) => {
            const target = returnFocusRef?.current;
            if (!target) return;
            event.preventDefault();
            target.focus();
          }}
        >
          {memory ? (
            <Section>
              <PrivacyChoice
                value={memory.value}
                onChange={memory.onChange}
                what="call"
                disabled={memory.disabled}
                className="items-start text-left sm:flex-col sm:items-start sm:justify-start"
              />
            </Section>
          ) : null}
          <Section>
            <Toggle
              label="Captions"
              pressed={captions}
              shortcut={live ? 'C' : undefined}
              onClick={onCaptions}
            />
            <Segmented label="Caption size" value={size} options={CAPTION_SIZES} onChange={setSize} />
            <Toggle
              label="Read captions with my screen reader"
              pressed={announce}
              onClick={() => {
                setAnnounce(!announce);
              }}
            />
          </Section>
          {voice ? (
            <Section>
              <Toggle
                label="Push to talk"
                pressed={pushToTalk}
                shortcut={live ? 'P' : undefined}
                disabled={live?.disabled}
                onClick={onPushToTalk}
              />
              {live ? (
                <Toggle
                  label="Type instead"
                  pressed={live.typing}
                  shortcut="T"
                  disabled={live.disabled}
                  onClick={live.onTyping}
                />
              ) : null}
            </Section>
          ) : null}
          {live ? (
            <>
              <Section>
                <button
                  type="button"
                  onClick={live.onSwitchToChat}
                  className="fa-call-focus flex min-h-11 w-full items-center rounded-lg px-2 text-left text-small text-foreground transition-colors duration-150 hover:bg-accent"
                >
                  Switch to chat
                </button>
              </Section>
              <Section>
                <ul
                  aria-label="Timeline colours"
                  className="flex flex-wrap gap-x-4 gap-y-1 px-2 text-caption text-muted-foreground"
                >
                  <li className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="size-3 rounded-[3px] bg-(--tl-student) shadow-[inset_0_0_0_1px_var(--tl-bar-student)]"
                    />
                    You
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="size-3 rounded-[3px] bg-(--tl-veir) shadow-[inset_0_0_0_1px_var(--tl-bar-veir)]"
                    />
                    {name}
                  </li>
                </ul>
              </Section>
            </>
          ) : null}
          <Section>
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={() => {
                setShown(false);
                setAbout(true);
              }}
              className="fa-call-focus flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-small text-foreground transition-colors duration-150 hover:bg-accent"
            >
              <Info aria-hidden className="size-4 text-muted-foreground" />
              About calls
            </button>
          </Section>
        </PopoverContent>
      </Popover>
      <CallDisclosureDialog
        open={about}
        name={name}
        kind={null}
        onCancel={() => {
          setAbout(false);
        }}
      />
    </>
  );
}
