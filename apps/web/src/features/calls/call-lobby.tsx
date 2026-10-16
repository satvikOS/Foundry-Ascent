import type { CallConfigResponse } from '@foundry/contracts';
import { Phone } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { DisclosureBanner } from '@/components/disclosure-banner';
import { Button } from '@/components/ui/button';
import type { CallEngine } from '@/lib/realtime/call-engine';

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
      message: 'AI coaching is turned off for now. Your conversations are still here.',
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
  /** A start that failed (the engine's message). */
  failure: string | null;
  busy: boolean;
  onStart: () => void;
  onRetry: () => void;
  onClose: () => void;
}

/**
 * Before the call: start it (a click is what lets the browser play audio), or learn why it can't start.
 * When the person arrived by clicking Call, the call starts on its own and this shows only "Connecting".
 */
export function CallLobby({
  engine,
  veir,
  config,
  blocker,
  failure,
  busy,
  onStart,
  onRetry,
  onClose,
}: CallLobbyProps) {
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    primaryRef.current?.focus();
  }, [blocker, failure, busy]);

  const problem =
    blocker ?? (failure ? { title: 'The call didn’t connect', message: failure, retry: true } : null);
  const minutes =
    config && !problem
      ? `Up to ${String(config.maxMinutes)} minutes · ${String(Math.floor(config.remainingMinutesToday))} min left today`
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-4 py-6 text-center">
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
