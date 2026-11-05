import { Mic, MicOff, X } from 'lucide-react';
import type { KeyboardEvent, PointerEvent } from 'react';

import { Kbd } from '@/components/ui/kbd';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import './voice.css';

/** The call's round controls: 56 px, a quiet control surface, the two-tone focus ring of the call screen. */
export const callControl = cn(
  'fa-call-control relative inline-flex size-14 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors duration-150',
  'disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-6',
);

interface CallDockProps {
  name: string;
  voice: boolean;
  muted: boolean;
  disabled: boolean;
  onMute: () => void;
  onEnd: () => void;
}

/**
 * The call's controls, as in the owner's reference: the microphone in the bottom-left corner and End in the
 * bottom-right, nothing in between. The rarer controls (captions, push to talk, typing, switching to chat) are in
 * the call settings; their shortcuts work without opening it. Each is a 56 px target with a name, a pressed state
 * where it toggles, and its shortcut.
 */
export function CallDock({ name, voice, muted, disabled, onMute, onEnd }: CallDockProps) {
  return (
    <div role="toolbar" aria-label="Call controls" className="flex w-full items-center justify-between gap-3">
      {voice ? (
        <SimpleTooltip
          content={
            <span className="flex items-center gap-2">
              {muted ? 'Unmute' : 'Mute'}
              <Kbd>M</Kbd>
            </span>
          }
        >
          <button
            type="button"
            aria-label="Mute"
            aria-pressed={muted}
            aria-keyshortcuts="M"
            disabled={disabled}
            onClick={onMute}
            className={callControl}
          >
            {muted ? <MicOff aria-hidden /> : <Mic aria-hidden />}
          </button>
        </SimpleTooltip>
      ) : (
        <span aria-hidden className="size-14" />
      )}
      <SimpleTooltip content={`End call with ${name}`}>
        <button type="button" onClick={onEnd} aria-label="End call" className={callControl}>
          <X aria-hidden />
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
        'fa-call-control h-12 w-full max-w-xs touch-none rounded-full text-sm font-medium transition-colors duration-150 select-none',
        talking && 'fa-call-control--on',
      )}
    >
      {talking ? 'Listening… release to send' : 'Hold to talk'}
    </button>
  );
}
