import { Maximize2, Mic, MicOff, PhoneOff, Volume2, X } from 'lucide-react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { VeirName } from '@/components/faces/veir-name';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { budgetEndLine, CALL_END_LINES } from '@/lib/realtime/call-api';
import type { CallSnapshot } from '@/lib/realtime/call-state';
import { cn } from '@/lib/utils';

import { useCall } from './call-context';
import { formatClock, spokenDuration, useCallClock } from './use-call-clock';
import { useCallVeir } from './use-call-veir';

/**
 * What the bar announces (its status region): the time warning, a microphone that went away, sound the
 * browser stopped, and the end of a call that ended out of view, with why. The call screen says these
 * itself while it is open.
 */
function barAnnouncement(snapshot: CallSnapshot): string {
  if (snapshot.phase === 'ended') {
    const reason = snapshot.ended?.reason;
    const why = reason === 'budget' ? budgetEndLine(undefined) : reason ? CALL_END_LINES[reason] : undefined;
    return why ? `Call ended. ${why}` : 'Call ended.';
  }
  if (snapshot.typedReason === 'mic_lost') {
    return 'Microphone disconnected. Return to the call to reconnect it.';
  }
  if (snapshot.phase === 'live' && snapshot.audioBlocked) return 'Sound is off.';
  return snapshot.notice?.kind === 'time_warning' ? snapshot.notice.message : '';
}

/**
 * A call that continues while the person looks elsewhere: the vEIR's face and AI marker, the timer (and the
 * time left near the end), Turn on sound when the browser stopped the call's sound (as the call screen
 * offers), mute, back to the call and end. After a call ended out of view (its time ran out, or the program
 * paused calls), it says so and offers the summary instead. Rendered by `MiniCallBar` only while there is a
 * call to show; while shown, the page's sticky headers sit below it (`--mini-call-height`).
 */
export function MiniCallBarView() {
  const { engine, snapshot, showCall } = useCall();
  const veir = useCallVeir(snapshot.ventureId);
  const clock = useCallClock(snapshot);
  const ended = snapshot.phase === 'ended';
  if (!engine || !veir) return null;

  const speaking = snapshot.phase === 'live' && snapshot.activity === 'speaking';
  const duration = ended ? (snapshot.ended?.durationSeconds ?? 0) : clock.elapsed;
  const micLost = !ended && snapshot.typedReason === 'mic_lost';
  // The browser stopped the call's sound (no tap yet, or an interruption such as a phone call on iOS).
  const soundOff = snapshot.phase === 'live' && snapshot.audioBlocked;

  return (
    <section
      aria-label={`Call with ${veir.name}`}
      data-print="hide"
      data-mini-call-bar=""
      className={cn(
        // Below the phone bar when the page shows it, at the top otherwise (a conversation's own header
        // replaces the phone bar, and sits below this bar).
        'glass-bar sticky top-(--phone-bar-height) z-20 flex h-(--mini-call-bar-height) shrink-0 items-center gap-2 border-b px-3 sm:gap-3 sm:px-4 md:top-0',
      )}
    >
      <span role="status" className="sr-only">
        {barAnnouncement(snapshot)}
      </span>
      <PersonaAvatar
        name={veir.name}
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
                <VeirName veir={veir} className="align-middle" />
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
          {!ended && clock.warning && clock.leftLabel ? (
            <span className="font-medium text-warning"> · {clock.leftLabel}</span>
          ) : null}
          {micLost ? <span className="text-warning"> · Microphone disconnected</span> : null}
          {soundOff ? <span className="text-warning"> · Sound is off</span> : null}
        </p>
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
          {soundOff ? (
            <Button
              size="sm"
              aria-label="Turn on sound"
              onClick={() => {
                engine.resumeAudio();
              }}
            >
              <Volume2 aria-hidden />
              <span className="hidden sm:inline">Turn on</span>
            </Button>
          ) : null}
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
