import type { CallConfigResponse } from '@foundry/contracts';
import { AudioLines, Phone } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { DisclosureBanner } from '@/components/disclosure-banner';
import { Button } from '@/components/ui/button';
import type { CallEngine, CallFailure } from '@/lib/realtime/call-engine';

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
  onStart: () => void;
  onRetry: () => void;
  onClose: () => void;
}

/**
 * Before the call: start it (a click is what lets the browser play audio), or learn why it can't start.
 * When the person arrived by clicking Call, the call starts on its own and this shows only "Connecting";
 * the first call ever waits here so the founder reads how their voice is handled.
 */
export function CallLobby({
  engine,
  veir,
  config,
  blocker,
  failure,
  busy,
  voiceNotice,
  onStart,
  onRetry,
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
          title: failure.retry ? 'The call didn’t connect' : 'Can’t call right now',
          message: failure.message,
          retry: failure.retry,
        }
      : null);
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
          className="w-[min(15rem,58vw,32dvh)] sm:w-[min(18rem,34dvh)]"
        />
        <div className="flex max-w-md flex-col items-center gap-2">
          <h2 className="font-serif text-heading font-normal">
            {problem ? problem.title : `Call ${veir.shortName}`}
          </h2>
          <p role="status" className="text-body text-pretty text-muted-foreground">
            {busy ? 'Connecting…' : problem ? problem.message : (minutes ?? 'Getting ready…')}
          </p>
          {!problem && !busy ? (
            <p className="text-small text-muted-foreground">
              Headphones help {veir.shortName} hear you clearly.
            </p>
          ) : null}
        </div>
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
            problem.retry ? (
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
            ref={problem && !problem.retry ? primaryRef : undefined}
            size="lg"
            variant="secondary"
            onClick={onClose}
          >
            {problem ? 'Back to chat' : 'Not now'}
          </Button>
        </div>
      </div>
      <div className="flex shrink-0 justify-center px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <DisclosureBanner variant="line" text={veir.disclosure} className="max-w-2xl text-center" />
      </div>
    </div>
  );
}
