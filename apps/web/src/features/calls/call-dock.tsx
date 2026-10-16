import {
  Captions,
  CaptionsOff,
  Hand,
  Keyboard,
  MessageSquareText,
  Mic,
  MicOff,
  PhoneOff,
  type LucideIcon,
} from 'lucide-react';
import type { ComponentProps, KeyboardEvent, PointerEvent } from 'react';

import { Kbd } from '@/components/ui/kbd';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface DockButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  /** Toggle state; omit for plain actions. */
  pressed?: boolean;
  /** A pressed toggle that needs attention (muted) is drawn inverted. */
  emphasis?: boolean;
}

const roundButton = cn(
  'relative inline-flex size-12 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-colors duration-150',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
  'disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-5',
);

export function DockButton({
  icon: Icon,
  label,
  shortcut,
  pressed,
  emphasis = false,
  className,
  ...props
}: DockButtonProps) {
  return (
    <SimpleTooltip
      content={
        <span className="flex items-center gap-2">
          {label}
          {shortcut ? <Kbd>{shortcut}</Kbd> : null}
        </span>
      }
    >
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        aria-keyshortcuts={shortcut}
        className={cn(
          roundButton,
          pressed && emphasis
            ? 'border-foreground bg-foreground text-background hover:bg-foreground/90'
            : pressed
              ? 'border-border-strong bg-accent text-foreground hover:bg-accent/80'
              : 'border-border bg-card/60 text-foreground hover:border-border-strong hover:bg-accent',
          className,
        )}
        {...props}
      >
        <Icon aria-hidden />
      </button>
    </SimpleTooltip>
  );
}

interface CallDockProps {
  name: string;
  voice: boolean;
  muted: boolean;
  pushToTalk: boolean;
  captions: boolean;
  typing: boolean;
  disabled: boolean;
  onMute: () => void;
  onPushToTalk: () => void;
  onCaptions: () => void;
  onTyping: () => void;
  onSwitchToChat: () => void;
  onEnd: () => void;
}

/**
 * The call's controls, one row: mute, push-to-talk, captions, type, switch to chat — and End, set apart.
 * Every control is a 48 px target with a name, a pressed state where it toggles, and its shortcut.
 */
export function CallDock({
  name,
  voice,
  muted,
  pushToTalk,
  captions,
  typing,
  disabled,
  onMute,
  onPushToTalk,
  onCaptions,
  onTyping,
  onSwitchToChat,
  onEnd,
}: CallDockProps) {
  return (
    <div
      role="toolbar"
      aria-label="Call controls"
      className="flex items-center justify-center gap-2 sm:gap-3"
    >
      {voice ? (
        <>
          <DockButton
            icon={muted ? MicOff : Mic}
            label="Mute"
            shortcut="M"
            pressed={muted}
            emphasis
            disabled={disabled}
            onClick={onMute}
          />
          <DockButton
            icon={Hand}
            label="Push to talk"
            shortcut="P"
            pressed={pushToTalk}
            disabled={disabled}
            onClick={onPushToTalk}
          />
        </>
      ) : null}
      <DockButton
        icon={captions ? Captions : CaptionsOff}
        label="Captions"
        shortcut="C"
        pressed={captions}
        onClick={onCaptions}
      />
      {voice ? (
        <DockButton
          icon={Keyboard}
          label="Type instead"
          shortcut="T"
          pressed={typing}
          disabled={disabled}
          onClick={onTyping}
        />
      ) : null}
      <DockButton icon={MessageSquareText} label="Switch to chat" onClick={onSwitchToChat} />
      <SimpleTooltip content={`End call with ${name}`}>
        <button
          type="button"
          onClick={onEnd}
          aria-label="End call"
          className={cn(
            roundButton,
            'ml-1 border-destructive-strong bg-destructive-strong text-destructive-foreground hover:bg-destructive-strong/90 sm:ml-3 sm:w-auto sm:gap-2 sm:px-5',
          )}
        >
          <PhoneOff aria-hidden />
          <span className="hidden text-sm font-medium sm:inline">End</span>
        </button>
      </SimpleTooltip>
    </div>
  );
}

interface HoldToTalkProps {
  talking: boolean;
  onChange: (pressed: boolean) => void;
}

/** Push-to-talk: hold the button (or Space anywhere on the call screen) to talk; release to send. */
export function HoldToTalk({ talking, onChange }: HoldToTalkProps) {
  const press = (event: PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    onChange(true);
  };
  const release = () => {
    onChange(false);
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
      event.preventDefault();
      onChange(true);
    }
  };
  const keyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      onChange(false);
    }
  };
  return (
    <button
      type="button"
      aria-pressed={talking}
      aria-keyshortcuts="Space"
      onPointerDown={press}
      onPointerUp={release}
      onPointerCancel={release}
      onKeyDown={keyDown}
      onKeyUp={keyUp}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
      className={cn(
        'h-12 w-full max-w-xs touch-none rounded-full border text-sm font-medium transition-colors duration-150 select-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        talking
          ? 'border-foreground bg-foreground text-background'
          : 'border-border-strong bg-card text-foreground hover:bg-accent',
      )}
    >
      {talking ? 'Listening… release to send' : 'Hold to talk'}
    </button>
  );
}
