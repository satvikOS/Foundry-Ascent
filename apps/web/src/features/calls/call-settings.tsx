import { SlidersHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';

import { Kbd } from '@/components/ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { CAPTION_SIZES, useAnnounceCaptions, useCaptionSize, usePresentationPreference } from './preferences';

interface CallSettingsProps {
  /** The vEIR's name in the legend ("Corin · vEIR"). */
  name: string;
  voice: boolean;
  captions: boolean;
  pushToTalk: boolean;
  typing: boolean;
  disabled: boolean;
  /** A vendor face is on screen: the presentation choice does not apply. */
  video: boolean;
  onCaptions: () => void;
  onPushToTalk: () => void;
  onTyping: () => void;
  onSwitchToChat: () => void;
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
              'fa-call-focus min-h-9 flex-1 rounded-full px-3 text-small transition-colors duration-150',
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
 * The call settings (the sliders glyph, top right): presentation (the sphere by default, or the character, always
 * labelled "AI avatar"), captions and their size, screen-reader captions, push to talk, typing, switching to chat,
 * and the timeline's legend. Choices are remembered in this browser; none changes the voice, identity or session.
 */
export function CallSettings({
  name,
  voice,
  captions,
  pushToTalk,
  typing,
  disabled,
  video,
  onCaptions,
  onPushToTalk,
  onTyping,
  onSwitchToChat,
}: CallSettingsProps) {
  const [presentation, setPresentation] = usePresentationPreference();
  const [size, setSize] = useCaptionSize();
  const [announce, setAnnounce] = useAnnounceCaptions();
  return (
    <Popover>
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
        className="grid w-[min(20rem,calc(100vw-2rem))] gap-3"
      >
        {!video ? (
          <Section>
            <Segmented
              label="Presentation"
              value={presentation}
              options={[
                { value: 'sphere', label: 'Sphere' },
                { value: 'character', label: 'AI avatar' },
              ]}
              onChange={setPresentation}
            />
          </Section>
        ) : null}
        <Section>
          <Toggle label="Captions" pressed={captions} shortcut="C" onClick={onCaptions} />
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
              shortcut="P"
              disabled={disabled}
              onClick={onPushToTalk}
            />
            <Toggle
              label="Type instead"
              pressed={typing}
              shortcut="T"
              disabled={disabled}
              onClick={onTyping}
            />
          </Section>
        ) : null}
        <Section>
          <button
            type="button"
            onClick={onSwitchToChat}
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
              <span aria-hidden className="size-3 rounded-[3px] bg-[light-dark(#d8e6cf,#344b2a)]" />
              You
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="size-3 rounded-[3px] bg-[light-dark(#d5dcf5,#303d71)]" />
              {name}
            </li>
          </ul>
        </Section>
      </PopoverContent>
    </Popover>
  );
}
