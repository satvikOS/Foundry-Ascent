import type { CallConfigResponse } from '@foundry/contracts';
import { AudioLines, Phone } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Button } from '@/components/ui/button';
import type { CallEngine, CallFailure } from '@/lib/realtime/call-engine';

import { PrivacyChoice, type ConversationPrivacy } from '../chat/privacy-choice';
import { CallStage } from './call-stage';
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
      title: 'Calls are for the venture team',
      message: `You can read this venture’s conversations, but only its founders and team can call ${name}.`,
      retry: false,
    };
  }
  if (configError) return { title: 'Can’t start a call', message: configError, retry: true };
  if (!config) return null;
  if (!config.aiEnabled) {
    return {
      title: 'Calls are paused',
      message: 'AI is paused by an administrator. Your conversations are still here.',
      retry: false,
    };
  }
  // The calls switch (`calls_enabled`), once the call settings carry it.
  if ('callsEnabled' in config && config.callsEnabled === false) {
    return {
      title: 'Calls are paused',
      message: 'The program has paused calls for now. You can keep chatting.',
      retry: false,
    };
  }
  if (config.remainingMinutesToday < 1) {
    return {
      title: 'No call minutes left today',
      message: 'They reset at midnight UTC. You can keep going in chat.',
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
  /** The first call: say how the founder's voice is handled before it starts. */
  voiceNotice: boolean;
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

/**
 * Before the call: start it (a click is what lets the browser play audio), or learn why it can't start.
 * When the person arrived by clicking Call, the call starts on its own and this shows only "Connecting";
 * the first call ever waits here so the founder reads how their voice is handled (and, on a first meeting,
 * what a vEIR is: the welcome, said here instead of over the page). A call that starts a new
 * conversation offers Remember (the default) or Private here, and waits for Start call unless it came from
 * New chat's Call button, beside the same choice.
 */
export function CallLobby({
  engine,
  veir,
  config,
  blocker,
  failure,
  busy,
  voiceNotice,
  welcome,
  privacy,
  onStart,
  onRetry,
  onMoveHere,
  onClose,
}: CallLobbyProps) {
  const primaryRef = useRef<HTMLButtonElement | null>(null);
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
  const minutes =
    config && !problem
      ? `Up to ${String(config.maxMinutes)} minutes · ${String(Math.floor(config.remainingMinutesToday))} min left today`
      : null;

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-6 text-center">
        <CallStage
          veir={veir}
          engine={engine}
          state={busy ? 'connecting' : 'idle'}
          className="h-[min(16rem,30dvh)] sm:h-[min(20rem,34dvh)]"
        />
        <div className="flex max-w-md flex-col items-center gap-2">
          <h2 className="font-serif text-heading font-normal">
            {problem ? problem.title : `Call ${veir.name}`}
          </h2>
          <p role="status" className="text-body text-pretty text-muted-foreground">
            {busy ? 'Connecting…' : problem ? problem.message : (minutes ?? 'Getting ready…')}
          </p>
        </div>
        {privacy && !problem ? (
          <PrivacyChoice
            value={privacy.value}
            onChange={privacy.onChange}
            veirName={veir.name}
            what="call"
            disabled={busy}
            className="max-w-md sm:flex-col"
          />
        ) : null}
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
        {voiceNotice && !problem ? (
          <p
            data-testid="voice-notice"
            className="flex max-w-md items-start gap-3 rounded-xl border border-border bg-card/70 px-4 py-3 text-left text-small text-muted-foreground"
          >
            <AudioLines aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground" />
            <span>
              Your voice goes to Amazon Transcribe to become text. No audio is kept; the transcript is saved
              here like chat, and you can type instead at any time.
            </span>
          </p>
        ) : null}
        <div className="flex w-full max-w-xs flex-col gap-2 sm:max-w-none sm:flex-row sm:justify-center">
          {problem ? (
            moveHere ? (
              <Button ref={primaryRef} size="lg" onClick={onMoveHere} loading={busy}>
                <Phone aria-hidden />
                Move the call here
              </Button>
            ) : problem.retry ? (
              <Button ref={primaryRef} size="lg" onClick={onRetry}>
                Try again
              </Button>
            ) : null
          ) : (
            <Button ref={primaryRef} size="lg" onClick={onStart} loading={busy} disabled={!config}>
              <Phone aria-hidden />
              Start call
            </Button>
          )}
          <Button
            ref={problem && !problem.retry && !moveHere ? primaryRef : undefined}
            size="lg"
            variant="secondary"
            onClick={onClose}
          >
            {problem && !moveHere ? 'Back to chat' : 'Not now'}
          </Button>
        </div>
      </div>
    </div>
  );
}
