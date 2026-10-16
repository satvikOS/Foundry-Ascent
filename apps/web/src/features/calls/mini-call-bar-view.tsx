import { Maximize2, Mic, MicOff, PhoneOff, X } from 'lucide-react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { VeirBadge } from '@/components/faces/veir-badge';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { useCall } from './call-context';
import { formatClock, spokenDuration, useCallClock } from './use-call-clock';
import { useCallVeir } from './use-call-veir';

/**
 * A call that continues while the person looks elsewhere: the vEIR's face and AI marker, the timer, mute,
 * back to the call and end. After a call ended out of view (its time ran out, or the program paused calls),
 * it offers the summary instead. Rendered by `MiniCallBar` only while there is a call to show.
 */
export function MiniCallBarView() {
  const { engine, snapshot, showCall } = useCall();
  const veir = useCallVeir(snapshot.ventureId);
  const clock = useCallClock(snapshot);
  const ended = snapshot.phase === 'ended';
  if (!engine || !veir) return null;

  const speaking = snapshot.phase === 'live' && snapshot.activity === 'speaking';
  const duration = ended ? (snapshot.ended?.durationSeconds ?? 0) : clock.elapsed;

  return (
    <section
      aria-label={`Call with ${veir.name}`}
      data-print="hide"
      className={cn(
        'sticky top-(--header-height) z-20 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card/95 px-3 backdrop-blur-md supports-[backdrop-filter]:bg-card/80 sm:gap-3 sm:px-4 md:top-0',
      )}
    >
      <PersonaAvatar
        name={veir.shortName}
        portraitUrl={veir.portraitUrl}
        size="sm"
        speaking={speaking}
        decorative
      />
      <div className="flex min-w-0 flex-1 items-center gap-2 text-small">
        <p className="min-w-0 truncate">
          <span className="font-medium">
            {ended ? (
              'Call ended'
            ) : (
              <>
                <span className="hidden sm:inline">Call with </span>
                {veir.shortName}
              </>
            )}
          </span>
          <span className="text-muted-foreground"> · </span>
          {snapshot.held ? (
            <span className="text-muted-foreground">On hold</span>
          ) : (
            <>
              <span className="font-mono tabular text-muted-foreground" aria-hidden>
                {formatClock(duration)}
              </span>
              <span className="sr-only">{spokenDuration(duration)}</span>
            </>
          )}
        </p>
        <VeirBadge kind={veir.kind} />
      </div>
      {ended ? (
        <>
          <Button size="sm" variant="secondary" onClick={showCall}>
            Summary
          </Button>
          <SimpleTooltip content="Dismiss">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Dismiss"
              onClick={() => {
                engine.reset();
              }}
            >
              <X aria-hidden />
            </Button>
          </SimpleTooltip>
        </>
      ) : (
        <>
          {snapshot.input === 'voice' ? (
            <SimpleTooltip content={snapshot.muted ? 'Unmute' : 'Mute'}>
              <Button
                size="icon-sm"
                variant={snapshot.muted ? 'default' : 'ghost'}
                aria-label="Mute"
                aria-pressed={snapshot.muted}
                disabled={snapshot.phase !== 'live'}
                onClick={() => {
                  if (snapshot.held) engine.resume();
                  else engine.setMuted(!snapshot.muted);
                }}
              >
                {snapshot.muted ? <MicOff aria-hidden /> : <Mic aria-hidden />}
              </Button>
            </SimpleTooltip>
          ) : null}
          <Button size="sm" variant="secondary" onClick={showCall} aria-label="Return to call">
            <Maximize2 aria-hidden className="sm:hidden" />
            <span className="hidden sm:inline">Return to call</span>
          </Button>
          <SimpleTooltip content="End call">
            <Button
              size="icon-sm"
              variant="destructive"
              aria-label="End call"
              disabled={snapshot.phase === 'ending'}
              onClick={() => {
                void engine.end('user');
              }}
            >
              <PhoneOff aria-hidden />
            </Button>
          </SimpleTooltip>
        </>
      )}
    </section>
  );
}
