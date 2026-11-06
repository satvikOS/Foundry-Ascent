import type { CallConfigResponse } from '@foundry/contracts';
import { ChevronDown, EyeOff, History, Phone, Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { CallEngine, CallFailure } from '@/lib/realtime/call-engine';
import { cn } from '@/lib/utils';

import type { ConversationPrivacy } from '../chat/privacy-choice';
import type { CallKind } from './call-kind';
import { CallKindSwitch } from './call-kind-switch';
import { CallSettings } from './call-settings';
import { CallStage } from './call-stage';
import { useCaptionsPreference, useTalkModePreference } from './preferences';
import type { CallVeir } from './use-call-veir';

/** Why a call cannot start right now, or null when it can. */
export interface CallBlocker {
  readonly title: string;
  readonly message: string;
  /** The problem may pass (a failed request): offer to try again. */
  readonly retry: boolean;
}

export function callBlocker(input: {
  writable: boolean;
  name: string;
  config: CallConfigResponse | undefined;
  configError: string | null;
}): CallBlocker | null {
  const { writable, name, config, configError } = input;
  if (!writable) {
    return {
      title: 'Calls are for the team',
      message: `Only founders and the team can call ${name}.`,
      retry: false,
    };
  }
  if (configError) return { title: 'Can’t start a call', message: configError, retry: true };
  if (!config) return null;
  if (!config.aiEnabled) {
    return {
      title: 'Calls are paused',
      message: 'An admin paused AI. Your conversations are safe.',
      retry: false,
    };
  }
  // The calls switch (`calls_enabled`), once the call settings carry it.
  if ('callsEnabled' in config && config.callsEnabled === false) {
    return {
      title: 'Calls are paused',
      message: 'The program paused calls. You can keep chatting.',
      retry: false,
    };
  }
  if (config.remainingMinutesToday < 1) {
    return {
      title: 'No call minutes left today',
      message: 'They reset at midnight UTC. Chat still works.',
      retry: false,
    };
  }
  return null;
}

interface CallLobbyProps {
  engine: CallEngine;
  veir: CallVeir;
  config: CallConfigResponse | undefined;
  blocker: CallBlocker | null;
  /** A start that failed: the server's refusal (which will not pass by trying again) or a hiccup. */
  failure: CallFailure | null;
  busy: boolean;
  /** The call about to start: voice (the sphere) or video (the vEIR's face once live). */
  kind?: CallKind;
  /** Switches the call about to start to the other kind; null to offer no switch. */
  onSwitchKind?: ((kind: CallKind) => void) | null;
  /** Why a video call cannot start (none offered to this person); null when it can. */
  videoBlocked?: string | null;
  /** A note under the status (a video call asked for, but only voice is offered). */
  note?: string | null;
  /**
   * The person has not met their vEIR yet (the call screen opened before the welcome): its two lines, said here
   * once, and Start call acknowledges them. Null when already read.
   */
  welcome: { readonly title: string; readonly lines: readonly [string, string] } | null;
  /**
   * A call that starts a new conversation (from New chat): remembered (the default) or private, chosen before
   * it starts. Null for a call in an existing conversation, which keeps that conversation's choice.
   */
  privacy: { value: ConversationPrivacy; onChange: (privacy: ConversationPrivacy) => void } | null;
  onStart: () => void;
  onRetry: () => void;
  /** Already in a call elsewhere and the founder said yes: start here, ending the other call. */
  onMoveHere: () => void;
  onClose: () => void;
}

/** The primary control in the microphone's place: a 56 px pill, the call screen's two-tone focus ring. */
const startControl = cn(
  'fa-call-focus inline-flex h-14 shrink-0 items-center justify-center gap-2 rounded-full px-6 text-body font-medium transition-colors duration-150',
  'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-5',
);

/**
 * Before the call, on the same surface as the call itself (design-spec §11): the sphere idle on the canvas with
 * the vEIR's name tag, what the call allows as one status line, and Start call in the microphone's place
 * (bottom left). The settings (top right) hold the presentation, captions and talk mode and, for a call that
 * starts a new conversation, Remember (the default) or Private, whose current choice also shows under the status
 * and opens them. Top right also switches between a voice and a video call. A first meeting waits here so the
 * founder reads what their mentor is (the call's disclosure, a dialog over this screen, comes before the first call
 * of each kind); otherwise a call opened by a click starts at once and this shows "Connecting". When a call cannot
 * start, the title says why and the same place offers Try again, Move here or Back.
 */
export function CallLobby({
  engine,
  veir,
  config,
  blocker,
  failure,
  busy,
  kind = 'voice',
  onSwitchKind = null,
  videoBlocked = null,
  note = null,
  welcome,
  privacy,
  onStart,
  onRetry,
  onMoveHere,
  onClose,
}: CallLobbyProps) {
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const memoryRef = useRef<HTMLButtonElement | null>(null);
  const [captions, setCaptions] = useCaptionsPreference();
  const [talkMode, setTalkMode] = useTalkModePreference();
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The settings were opened from the memory line: focus returns there. */
  const [fromMemory, setFromMemory] = useState(false);
  const loaded = config !== undefined;
  // Focus the primary control once it can be used (Start call waits for the call settings to load).
  useEffect(() => {
    primaryRef.current?.focus();
  }, [blocker, failure, busy, loaded]);

  const problem =
    blocker ??
    (failure
      ? {
          title: failure.elsewhere
            ? 'You’re already in a call'
            : failure.retry
              ? 'The call didn’t connect'
              : 'Can’t call right now',
          message: failure.message,
          retry: failure.retry,
        }
      : null);
  const moveHere = failure?.elsewhere === true;
  const videoMinutes =
    kind === 'video' && config?.faceMinutesLeft !== undefined
      ? ` · ${String(Math.floor(config.faceMinutesLeft))} video min this month`
      : '';
  const minutes =
    config && !problem
      ? `Up to ${String(config.maxMinutes)} min · ${String(Math.floor(config.remainingMinutesToday))} left today${videoMinutes}`
      : null;
  const StartIcon = kind === 'video' ? Video : Phone;
  const isPrivate = privacy?.value === 'ephemeral';

  return (
    <div data-slot="call-lobby" className="flex flex-1 flex-col">
      {problem ? null : (
        <div className="absolute top-1.5 right-2 z-10 flex items-center sm:right-4">
          {onSwitchKind ? (
            <CallKindSwitch
              kind={kind}
              blockedReason={kind === 'voice' ? videoBlocked : null}
              onSwitch={() => {
                onSwitchKind(kind === 'voice' ? 'video' : 'voice');
              }}
            />
          ) : null}
          <CallSettings
            name={veir.name}
            captions={captions}
            onCaptions={() => {
              setCaptions(!captions);
            }}
            pushToTalk={talkMode === 'push_to_talk'}
            onPushToTalk={() => {
              setTalkMode(talkMode === 'push_to_talk' ? 'hands_free' : 'push_to_talk');
            }}
            live={null}
            memory={privacy ? { ...privacy, disabled: busy } : null}
            open={settingsOpen}
            onOpenChange={(open) => {
              setSettingsOpen(open);
              // Opened from its own glyph: focus returns there.
              if (open) setFromMemory(false);
            }}
            returnFocusRef={fromMemory ? memoryRef : undefined}
          />
        </div>
      )}
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-4 text-center sm:gap-5">
        <CallStage
          veir={veir}
          engine={engine}
          state={busy ? 'connecting' : failure ? 'disconnected' : 'idle'}
          // The header names the vEIR.
          nameTag={null}
        />
        <div className="-mt-2 flex max-w-md flex-col items-center gap-1.5">
          {problem ? <h2 className="text-heading font-semibold">{problem.title}</h2> : null}
          <p
            role="status"
            className={cn('text-pretty text-muted-foreground', problem ? 'text-body' : 'text-small')}
          >
            {busy ? 'Connecting…' : problem ? problem.message : (minutes ?? 'Getting ready…')}
          </p>
          {note && !problem ? (
            <p data-slot="call-note" className="text-small text-pretty text-muted-foreground">
              {note}
            </p>
          ) : null}
          {privacy && !problem ? (
            <button
              ref={memoryRef}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              // The visible word first (WCAG 2.5.3), then what pressing it does.
              aria-label={`${isPrivate ? 'Private' : 'Remembered'}: change memory for this call`}
              disabled={busy}
              onClick={() => {
                setFromMemory(true);
                setSettingsOpen(true);
              }}
              data-slot="call-memory"
              className="fa-call-focus inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 text-small text-muted-foreground transition-colors duration-150 hover:text-foreground disabled:opacity-50"
            >
              {isPrivate ? (
                <EyeOff aria-hidden className="size-3.5" />
              ) : (
                <History aria-hidden className="size-3.5" />
              )}
              {isPrivate ? 'Private' : 'Remembered'}
              <ChevronDown aria-hidden className="size-3.5" />
            </button>
          ) : null}
        </div>
        {welcome && !problem ? (
          <div
            data-testid="veir-welcome-inline"
            data-slot="veir-welcome"
            className="grid max-w-md gap-1 text-body text-pretty text-muted-foreground"
          >
            {welcome.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        ) : null}
      </div>

      {/* The microphone's place (bottom left) holds what starts the call; End's place stays empty until then. */}
      <div className="flex shrink-0 items-center justify-between gap-3 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5 sm:pb-5">
        {problem ? (
          moveHere ? (
            <button
              ref={primaryRef}
              type="button"
              onClick={onMoveHere}
              disabled={busy}
              aria-label="Move here, ending the other call"
              className={cn(startControl, 'bg-primary text-primary-foreground hover:bg-primary/90')}
            >
              <Phone aria-hidden />
              Move here
            </button>
          ) : problem.retry ? (
            <button
              ref={primaryRef}
              type="button"
              onClick={onRetry}
              className={cn(startControl, 'bg-primary text-primary-foreground hover:bg-primary/90')}
            >
              Try again
            </button>
          ) : (
            <button
              ref={primaryRef}
              type="button"
              onClick={onClose}
              aria-label="Back to chat"
              className={cn(startControl, 'fa-call-control')}
            >
              Back
            </button>
          )
        ) : (
          <button
            ref={primaryRef}
            type="button"
            onClick={onStart}
            disabled={!config || busy}
            aria-busy={busy || undefined}
            className={cn(startControl, 'bg-primary text-primary-foreground hover:bg-primary/90')}
          >
            <StartIcon aria-hidden />
            Start call
          </button>
        )}
        <span aria-hidden className="size-14" />
      </div>
    </div>
  );
}
