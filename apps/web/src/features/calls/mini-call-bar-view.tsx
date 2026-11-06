import { Maximize2, Mic, MicOff, Phone, PhoneOff, Video, Volume2, X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { budgetEndLine, CALL_END_LINES } from '@/lib/realtime/call-api';
import type { CallSnapshot } from '@/lib/realtime/call-state';
import { cn } from '@/lib/utils';

import { useCall } from './call-context';
import { CALL_KIND_LABEL } from './call-kind';
import { useEndWithUndo } from './use-end-with-undo';
import { CallFaceThumbnail } from './call-video-tile';
import { formatClock, spokenDuration, useCallClock } from './use-call-clock';
import { useCallFace } from './use-call-face';
import { useCallConfig, useCallVeir } from './use-call-veir';
import { videoPending, videoPendingText } from './video-pending';
import { sphereState, VoiceSphere } from './voice-sphere';

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
 * A call that continues while the person looks elsewhere, on every page: the vEIR's face (or a small sphere), its
 * name, the kind of call and the timer (and the time left near the end), Turn on sound when the browser stopped the
 * call's sound (as the call screen offers), mute, back to the call and End, with a short Undo as on the call
 * screen. After a call ended out of view (its time ran out, or the program paused calls), it says so and offers its
 * review (in its conversation) instead. Rendered by `MiniCallBar` only while there is a call to show; while shown,
 * the page's sticky headers sit below it (`--mini-call-height`).
 */
export function MiniCallBarView() {
  const { engine, face, snapshot, showCall, kind } = useCall();
  // The call's settings as the call screen read them (cached, never fetched here): the vEIR's face provider too.
  const config = useCallConfig(snapshot.ventureId, false);
  const veir = useCallVeir(snapshot.ventureId, config.data?.veir, config.data?.provider);
  const clock = useCallClock(snapshot);
  const current = useCallFace(face);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const ended = snapshot.phase === 'ended';
  if (!engine || !veir) return null;
  // A video call minimized while its face is not shown says so here too ("Connecting to Thomas…": the conversation
  // waits for the face; "Reconnecting…"; "Video isn't available right now"), as the call screen's status line does.
  const callId = snapshot.phase === 'live' ? (snapshot.call?.id ?? null) : null;
  const pending =
    kind === 'video' && callId !== null && snapshot.blocked === null
      ? videoPending(true, face, veir.provider, current, callId)
      : null;
  return (
    <Bar
      engine={engine}
      snapshot={snapshot}
      name={veir.name}
      kind={kind}
      videoNote={pending === null ? null : videoPendingText(pending, veir.name)}
      clock={clock}
      faceThumb={
        current.status === 'live' && !ended && !reducedMotion ? (
          <CallFaceThumbnail
            stream={current.stream}
            speaking={snapshot.phase === 'live' && snapshot.activity === 'speaking'}
          />
        ) : null
      }
      showCall={showCall}
    />
  );
}

function Bar({
  engine,
  snapshot,
  name,
  kind,
  videoNote,
  clock,
  faceThumb,
  showCall,
}: {
  engine: NonNullable<ReturnType<typeof useCall>['engine']>;
  snapshot: CallSnapshot;
  name: string;
  kind: ReturnType<typeof useCall>['kind'];
  /** What a video call's tile would say while its face is not shown, or null. */
  videoNote: string | null;
  clock: ReturnType<typeof useCallClock>;
  faceThumb: ReactNode;
  showCall: () => void;
}) {
  const ended = snapshot.phase === 'ended';
  const ending = useEndWithUndo(engine, snapshot);
  const undoRef = useRef<HTMLButtonElement | null>(null);
  const endRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (ending.pending) undoRef.current?.focus();
  }, [ending.pending]);
  const KindIcon = kind === 'video' ? Video : Phone;

  const duration = ended ? (snapshot.ended?.durationSeconds ?? 0) : clock.elapsed;
  const micLost = !ended && snapshot.typedReason === 'mic_lost';
  // The browser stopped the call's sound (no tap yet, or an interruption such as a phone call on iOS).
  const soundOff = snapshot.phase === 'live' && snapshot.audioBlocked;

  return (
    <section
      aria-label={`Call with ${name}`}
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
      {faceThumb ?? (
        // A small, still sphere tinted by the call's state (muted and on hold are greyed).
        <VoiceSphere state={sphereState(snapshot, engine.avatarState())} size="1.75rem" reducedMotion />
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2 text-small">
        <p className="min-w-0 truncate">
          <span className="font-medium">{ended || ending.pending ? 'Call ended' : name}</span>
          {ended ? null : (
            <span className="text-muted-foreground">
              {' · '}
              <KindIcon aria-hidden className="inline size-3.5 align-[-2px] sm:hidden" />
              <span className="sr-only sm:not-sr-only">{CALL_KIND_LABEL[kind]}</span>
            </span>
          )}
          <span className="text-muted-foreground"> · </span>
          {snapshot.held ? (
            <span className="text-muted-foreground">On hold</span>
          ) : (
            <>
              <span className="tabular text-muted-foreground" aria-hidden>
                {formatClock(duration)}
              </span>
              <span className="sr-only">{spokenDuration(duration)}</span>
            </>
          )}
          {!ended && clock.warning && clock.leftLabel ? (
            <span className="font-medium text-warning"> · {clock.leftLabel}</span>
          ) : null}
          {!ended && !ending.pending && videoNote ? (
            <span className="text-muted-foreground" data-slot="mini-video-note">
              {' · '}
              {videoNote}
            </span>
          ) : null}
          {micLost ? <span className="text-warning"> · Microphone disconnected</span> : null}
          {soundOff ? <span className="text-warning"> · Sound is off</span> : null}
        </p>
      </div>
      {ended ? (
        <>
          <Button size="sm" variant="secondary" onClick={showCall} aria-label="Review the call">
            Review
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
      ) : ending.pending ? (
        <div role="group" aria-label="Call ended" data-slot="end-undo" className="flex items-center gap-1">
          <Button
            ref={undoRef}
            size="sm"
            variant="secondary"
            onClick={() => {
              ending.undo();
              endRef.current?.focus();
            }}
          >
            Undo
          </Button>
        </div>
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
              ref={endRef}
              size="icon-sm"
              variant="destructive"
              aria-label="End call"
              disabled={snapshot.phase === 'ending'}
              onClick={ending.request}
            >
              <PhoneOff aria-hidden />
            </Button>
          </SimpleTooltip>
        </>
      )}
    </section>
  );
}
