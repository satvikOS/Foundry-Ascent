import type { TurnBlockedDetail } from '@foundry/contracts';
import { ArrowUp, Info, Mic, Play, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';

import { Button } from '@/components/ui/button';
import { BlockedPanel } from '@/features/coach/blocked-panel';
import { useHotkeys } from '@/lib/hooks/use-hotkeys';
import type { CallEngine, CallNotice, CallSnapshot, TypedReason } from '@/lib/realtime/call-engine';
import { cn } from '@/lib/utils';

import { CallCaptions } from './call-captions';
import { CallDock, HoldToTalk } from './call-dock';
import type { CallKind } from './call-kind';
import { CallKindSwitch } from './call-kind-switch';
import { CallSettings } from './call-settings';
import { CallStage, videoPending, videoPendingText } from './call-stage';
import { END_UNDO_MS, useEndWithUndo } from './use-end-with-undo';
import { storeTalkMode, useAnnounceCaptions, useCaptionSize, useCaptionsPreference } from './preferences';
import { ConversationTimeline, clockLabel } from './timeline/ConversationTimeline';
import { callTimeline } from './timeline/call-timeline';
import type { TimelineTurn } from './timeline/timeline-model';
import { sphereState } from './voice-sphere';
import { useCallFace, type CallFaceController } from './use-call-face';
import type { CallVeir } from './use-call-veir';

/** The words under the presence: what the call is doing, as text (never colour or motion alone). */
export function callStatusLabel(snapshot: CallSnapshot): string {
  if (snapshot.phase === 'starting') return 'Connecting…';
  if (snapshot.phase === 'ending') return 'Ending…';
  // Nothing can be heard until the founder taps Turn on sound: say that, not "Speaking" to silence.
  if (snapshot.audioBlocked) return 'Sound is off';
  if (snapshot.reconnecting) return 'Reconnecting…';
  if (snapshot.held) return 'On hold';
  switch (snapshot.activity) {
    case 'connecting':
      return 'Connecting…';
    case 'speaking':
      return snapshot.voice === 'captions' ? 'Replying on screen' : 'Speaking';
    case 'thinking':
      return 'Thinking…';
    case 'listening':
      if (snapshot.muted) return 'Muted';
      if (snapshot.input === 'typed') return 'Your turn';
      if (snapshot.talkMode === 'push_to_talk' && !snapshot.talking) return 'Hold to talk';
      return 'Listening';
  }
}

const TYPED_REASONS: Record<TypedReason, string> = {
  stt_unavailable: 'No voice input here. Type instead.',
  mic_denied: 'Microphone blocked. Allow it in site settings, or type.',
  mic_unavailable: 'No microphone. Type instead.',
  mic_lost: 'Microphone disconnected. Reconnect it, or type.',
  stt_failed: 'Voice input stopped. Type instead.',
};

/** A voice call whose microphone went away (or was refused when asked again) can ask for it again. */
function canReconnectMic(snapshot: CallSnapshot): boolean {
  const reason = snapshot.typedReason;
  return (
    snapshot.input === 'typed' &&
    snapshot.call?.inputMode === 'transcribe' &&
    (reason === 'mic_lost' || reason === 'mic_denied' || reason === 'mic_unavailable')
  );
}

function isInteractive(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('button, a, input, textarea, select, [role="button"], [contenteditable="true"]') !== null
  );
}

interface CallLiveProps {
  tenant: string;
  engine: CallEngine;
  snapshot: CallSnapshot;
  veir: CallVeir;
  onSwitchToChat: () => void;
  /** The call's face (null: the presence only). */
  face?: CallFaceController | null;
  /** Voice (the sphere, no face) or video (the vEIR's face, once it shows). */
  kind?: CallKind;
  /** Switches the call to the other kind; null when the screen offers no switch. */
  onSwitchKind?: ((kind: CallKind) => void) | null;
  /** Why turning video on is not possible in this call (none offered, or the call already had its face). */
  videoBlocked?: string | null;
  /** The call screen's heading (the vEIR's name in its header), focused when the call opens. */
  headingRef?: RefObject<HTMLHeadingElement | null>;
}

export { END_UNDO_MS, useEndWithUndo };

/** How long a turn picked on the timeline stays in place of the live captions. */
const REVIEW_MS = 8_000;

/**
 * The call in progress, laid out like the owner's reference: the vEIR's presence (the voice sphere by default; on a
 * video call the vEIR's face once it shows, labelled as an AI avatar) centred on the canvas with its state as words,
 * live captions (or, after a held-back turn, the support it offers), any notice, the typed line, the conversation
 * timeline, and two controls: the microphone bottom-left and End bottom-right. Top right: switch voice/video, then
 * the call settings with everything rarer. No disclaimer line: the person read the call's disclosure before their
 * first call, and the settings keep it a tap away.
 */
export function CallLive({
  tenant,
  engine,
  snapshot,
  veir,
  onSwitchToChat,
  face = null,
  kind = 'voice',
  onSwitchKind = null,
  videoBlocked = null,
  headingRef,
}: CallLiveProps) {
  const [captions, setCaptions] = useCaptionsPreference();
  const [captionSize] = useCaptionSize();
  const [announceCaptions] = useAnnounceCaptions();
  const typedOnly = snapshot.input === 'typed';
  const [typingOpen, setTypingOpen] = useState(false);
  const [review, setReview] = useState<TimelineTurn | null>(null);
  const typing = typedOnly || typingOpen;
  const live = snapshot.phase === 'live';
  const voice = snapshot.input === 'voice';
  const pushToTalk = snapshot.talkMode === 'push_to_talk';
  const typeRef = useRef<HTMLInputElement | null>(null);
  const currentFace = useCallFace(face);
  const endRef = useRef<HTMLButtonElement | null>(null);
  const undoRef = useRef<HTMLButtonElement | null>(null);
  const ending = useEndWithUndo(engine, snapshot);
  const timeline = callTimeline(engine).recorder;
  const hasTurns = useSyncExternalStore(
    timeline.subscribe,
    () => timeline.turns().length > 0,
    () => false,
  );

  // Focus starts on the vEIR's name (the header's heading); typing-only calls focus the line.
  useEffect(() => {
    headingRef?.current?.focus();
  }, [headingRef]);

  // A video call whose face is not shown says so in the status line (the tile says it too, and offers a voice call
  // when video is not available: it never turns into a voice call by itself, owner round 3). Not while ending, nor
  // over a held-back turn (its support comes first).
  const callId = live ? (snapshot.call?.id ?? null) : null;
  const videoNote =
    kind === 'video' && !ending.pending && !snapshot.blocked
      ? videoPending(true, face, veir.provider, currentFace)
      : null;
  // A video call waiting for its face: nothing has been said yet, so there is nothing to type, caption or interrupt.
  const awaiting = snapshot.awaitingFace || (kind === 'video' && snapshot.phase === 'starting');
  useEffect(() => {
    if (live && typedOnly) typeRef.current?.focus();
  }, [live, typedOnly]);

  // A turn picked on the timeline shows its words for a while, then the live captions return.
  useEffect(() => {
    if (!review) return undefined;
    const timer = setTimeout(() => {
      setReview(null);
    }, REVIEW_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [review]);

  const toggleMute = () => {
    engine.setMuted(!snapshot.muted);
  };
  const toggleTalkMode = () => {
    const next = pushToTalk ? 'hands_free' : 'push_to_talk';
    storeTalkMode(next);
    engine.setTalkMode(next);
  };
  const toggleTyping = () => {
    setTypingOpen((open) => !open);
  };
  useEffect(() => {
    if (typingOpen) typeRef.current?.focus();
  }, [typingOpen]);

  useHotkeys(
    {
      m: () => {
        if (voice) toggleMute();
      },
      p: () => {
        if (voice) toggleTalkMode();
      },
      c: () => {
        setCaptions(!captions);
      },
      t: () => {
        if (voice) toggleTyping();
        else typeRef.current?.focus();
      },
    },
    live && !ending.pending,
  );

  // Hold Space anywhere on the call screen to talk (push-to-talk), unless a control has focus. Space released
  // in another app or tab never reaches the page, so leaving the window or hiding the page lets go too.
  useEffect(() => {
    if (!live || !pushToTalk || !voice || ending.pending) return undefined;
    const down = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || isInteractive(event.target)) return;
      event.preventDefault();
      engine.pushToTalk(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || isInteractive(event.target)) return;
      event.preventDefault();
      engine.pushToTalk(false);
    };
    const letGo = () => {
      engine.pushToTalk(false);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') letGo();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', letGo);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', letGo);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [engine, live, pushToTalk, voice, ending.pending]);

  // "Call ended · Undo": Undo takes focus while it is offered, and gives it back to End once used.
  useEffect(() => {
    if (ending.pending) undoRef.current?.focus();
  }, [ending.pending]);

  const status = ending.pending
    ? 'Call ended'
    : awaiting && videoNote !== null
      ? videoPendingText(videoNote, veir.name)
      : callStatusLabel(snapshot);
  const speaking =
    !ending.pending &&
    live &&
    snapshot.activity === 'speaking' &&
    snapshot.voice !== 'captions' &&
    !snapshot.audioBlocked &&
    !snapshot.held;
  const halfDuplexInterrupt = speaking && voice && snapshot.halfDuplex;
  // Replies on screen only (no voice for them): they are shown whatever the captions setting, and read to a
  // screen reader, since there is no voice to talk over.
  const onScreenOnly = snapshot.voice === 'captions';
  const readCaptions = announceCaptions || onScreenOnly;
  const veirLine = snapshot.captions.veir;
  const names = { veir: veir.name, student: 'You' };

  return (
    // Content taller than the screen (support resources, a long caption) scrolls the call screen instead of
    // running under the controls.
    <div data-slot="call-live" className="flex flex-1 flex-col">
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
          pushToTalk={pushToTalk}
          onPushToTalk={toggleTalkMode}
          live={{
            voice,
            typing: typingOpen,
            disabled: !live || ending.pending,
            onTyping: toggleTyping,
            onSwitchToChat,
          }}
        />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-4 sm:gap-5">
        {snapshot.blocked ? null : (
          <CallStage
            veir={veir}
            engine={engine}
            state={ending.pending ? 'ended' : sphereState(snapshot, engine.avatarState())}
            // The header names the vEIR; a face's video carries its name in its corner.
            nameTag={null}
            ventureId={snapshot.ventureId}
            callId={callId}
            face={face}
            video={kind === 'video'}
            onVoiceInstead={
              onSwitchKind
                ? () => {
                    onSwitchKind('voice');
                  }
                : null
            }
          />
        )}
        <div className="-mt-2 flex flex-col items-center gap-1.5">
          {/* Always present, so each new line is announced (a live region added with its text is not). */}
          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {readCaptions && veirLine ? `${veir.name}: ${veirLine}` : ''}
          </p>
          <p className="flex items-center gap-2 text-small text-muted-foreground">
            <span role="status" aria-live="polite">
              {status}
              {videoNote && !awaiting ? ` · ${videoPendingText(videoNote, veir.name)}` : ''}
            </span>
            {speaking && !halfDuplexInterrupt ? (
              <>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  onClick={() => {
                    engine.interrupt();
                  }}
                  aria-keyshortcuts="Escape"
                  data-touch-target
                  className="fa-call-focus relative rounded-sm font-medium text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
                >
                  Interrupt
                </button>
              </>
            ) : null}
          </p>
        </div>
        {ending.pending ? null : live && snapshot.audioBlocked ? (
          // Beside "Sound is off": short on screen, the whole action in its name.
          <Button
            size="lg"
            aria-label="Turn on sound"
            onClick={() => {
              engine.resumeAudio();
            }}
          >
            <Volume2 aria-hidden />
            Turn on
          </Button>
        ) : live && snapshot.held ? (
          <Button
            size="lg"
            onClick={() => {
              engine.resume();
            }}
          >
            <Play aria-hidden />
            Resume call
          </Button>
        ) : halfDuplexInterrupt ? (
          <Button
            size="lg"
            variant="secondary"
            aria-keyshortcuts="Escape"
            onClick={() => {
              engine.interrupt();
            }}
          >
            Interrupt
          </Button>
        ) : null}
        {snapshot.blocked && snapshot.ventureId ? (
          <CallBlocked
            tenant={tenant}
            ventureId={snapshot.ventureId}
            blocked={snapshot.blocked}
            personaName={veir.name}
            onSwitchToChat={live ? onSwitchToChat : null}
          />
        ) : review ? (
          <TurnReview
            turn={review}
            name={review.speaker === 'veir' ? veir.name : 'You'}
            onBack={() => {
              setReview(null);
            }}
          />
        ) : awaiting ? null : captions || onScreenOnly ? (
          <CallCaptions
            name={veir.name}
            veir={veirLine}
            founder={captions ? snapshot.captions.founder : null}
            founderLive={snapshot.captions.founderLive}
            size={captionSize}
            readAloud={readCaptions}
          />
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col items-center gap-4 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5 sm:pb-5">
        {live && snapshot.voice === 'captions' ? (
          <p role="status" className="flex max-w-xl items-start gap-2 text-small text-muted-foreground">
            <VolumeX aria-hidden className="mt-0.5 size-4 shrink-0" />
            {snapshot.voicePaused
              ? 'Voice paused for this call. Replies continue as text.'
              : 'Voice replies are unavailable.'}
          </p>
        ) : null}
        {snapshot.notice ? (
          <Notice
            notice={snapshot.notice}
            onPushToTalk={() => {
              storeTalkMode('push_to_talk');
              engine.setTalkMode('push_to_talk');
            }}
          />
        ) : null}
        {typing && !awaiting ? (
          <TypeLine
            inputRef={typeRef}
            name={veir.name}
            hint={snapshot.typedReason ? TYPED_REASONS[snapshot.typedReason] : null}
            queued={snapshot.queued}
            disabled={!live || ending.pending}
            onSend={(text) => {
              engine.sendText(text);
            }}
            onReconnectMic={
              live && canReconnectMic(snapshot)
                ? () => {
                    void engine.reconnectMicrophone();
                  }
                : null
            }
          />
        ) : null}
        {voice && pushToTalk && live && !ending.pending && !awaiting ? (
          <HoldToTalk
            talking={snapshot.talking}
            onChange={(pressed) => {
              engine.pushToTalk(pressed);
            }}
          />
        ) : null}
        {hasTurns ? (
          <ConversationTimeline
            source={timeline}
            names={names}
            onSelectTurn={setReview}
            className="max-w-[45rem]"
          />
        ) : null}
        {ending.pending ? (
          <EndUndo
            undoRef={undoRef}
            onUndo={() => {
              ending.undo();
              endRef.current?.focus();
            }}
          />
        ) : null}
        <CallDock
          name={veir.name}
          voice={voice}
          muted={snapshot.muted}
          disabled={!live || ending.pending}
          endRef={endRef}
          onMute={toggleMute}
          onEnd={ending.request}
        />
      </div>
    </div>
  );
}

/** "Call ended · Undo": the short window in which End can be taken back, in the call screen itself. */
function EndUndo({ undoRef, onUndo }: { undoRef: RefObject<HTMLButtonElement | null>; onUndo: () => void }) {
  return (
    <div
      role="group"
      aria-label="Call ended"
      data-slot="end-undo"
      className="glass flex h-11 items-center gap-3 rounded-full border border-(--glass-border) pr-1.5 pl-4 text-small text-popover-foreground"
    >
      <span aria-hidden>Call ended</span>
      <span aria-hidden className="text-muted-foreground">
        ·
      </span>
      <button
        ref={undoRef}
        type="button"
        onClick={onUndo}
        className="fa-call-focus inline-flex min-h-8 items-center rounded-full px-3 font-medium text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
      >
        Undo
      </button>
    </div>
  );
}

/** A turn picked on the timeline: its words, in place of the live captions for a few seconds. */
function TurnReview({ turn, name, onBack }: { turn: TimelineTurn; name: string; onBack: () => void }) {
  return (
    <section
      aria-label="Earlier in the call"
      className="mx-auto grid w-full max-w-2xl justify-items-center gap-2 px-2 text-center"
    >
      <p className="tabular text-caption text-muted-foreground">
        {clockLabel(turn.startMs)} · {name}
      </p>
      <p className="line-clamp-4 text-xl leading-[1.5] text-pretty text-foreground sm:line-clamp-5">
        {turn.text || 'Nothing transcribed.'}
      </p>
      <button
        type="button"
        onClick={onBack}
        className="fa-call-focus rounded-sm text-small font-medium text-muted-foreground underline decoration-border-strong underline-offset-4 hover:text-foreground"
      >
        Live captions
      </button>
    </section>
  );
}

/**
 * A held-back turn on a call: the same support the conversation shows (crisis resources first, the drafted
 * request for a person), announced at once. The microphone is already muted.
 */
function CallBlocked({
  tenant,
  ventureId,
  blocked,
  personaName,
  onSwitchToChat,
}: {
  tenant: string;
  ventureId: string;
  blocked: TurnBlockedDetail;
  personaName: string;
  /** Null while the call is ending: the support stays, and the summary follows it. */
  onSwitchToChat: (() => void) | null;
}) {
  return (
    <div role="alert" className="flex w-full max-w-xl flex-col gap-3 text-left">
      <BlockedPanel
        tenant={tenant}
        ventureId={ventureId}
        supportMessage={blocked.supportMessage}
        reason={blocked.reason}
        escalationId={blocked.escalationId}
        personaName={personaName}
      />
      {onSwitchToChat ? (
        <Button size="sm" variant="secondary" onClick={onSwitchToChat} className="self-center">
          Switch to chat
        </Button>
      ) : null}
    </div>
  );
}

function Notice({ notice, onPushToTalk }: { notice: CallNotice; onPushToTalk: () => void }) {
  return (
    <div
      role="status"
      className={cn(
        'flex max-w-xl flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-small text-muted-foreground',
        notice.kind === 'time_warning' && 'text-warning',
      )}
    >
      <p className="flex items-start gap-2">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        {notice.message}
      </p>
      {notice.kind === 'barge_hint' ? (
        // The name says it switches the mode, apart from the dock's Push to talk control.
        <Button size="sm" variant="secondary" onClick={onPushToTalk} aria-label="Use push to talk">
          Push to talk
        </Button>
      ) : null}
    </div>
  );
}

interface TypeLineProps {
  inputRef: RefObject<HTMLInputElement | null>;
  name: string;
  hint: string | null;
  queued: number;
  disabled: boolean;
  onSend: (text: string) => void;
  /** The microphone went away mid-call: offered next to the reason. */
  onReconnectMic: (() => void) | null;
}

/** One line to type to the vEIR during the call; it answers aloud like any spoken line. */
function TypeLine({ inputRef, name, hint, queued, disabled, onSend, onReconnectMic }: TypeLineProps) {
  const [text, setText] = useState('');
  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value);
    setText('');
  };
  return (
    <form onSubmit={submit} className="w-full max-w-xl">
      {hint ? (
        <div className="mb-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
          <p role="status" className="text-center text-small text-muted-foreground">
            {hint}
          </p>
          {onReconnectMic ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={onReconnectMic}
              aria-label="Reconnect microphone"
            >
              <Mic aria-hidden />
              Reconnect
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="glass flex items-center gap-2 rounded-full border border-border-strong py-1.5 pr-1.5 pl-4 transition-[border-color] duration-150 focus-within:border-ring/60">
        <input
          ref={inputRef}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
          maxLength={2000}
          aria-label={`Reply to ${name}`}
          placeholder={`Reply to ${name}…`}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground"
        />
        <Button
          type="submit"
          size="icon-sm"
          className="rounded-full"
          aria-label="Send"
          disabled={disabled || text.trim() === ''}
        >
          <ArrowUp aria-hidden />
        </Button>
      </div>
      {queued > 0 ? (
        <p role="status" className="mt-2 text-center text-caption text-muted-foreground">
          Answering that next.
        </p>
      ) : null}
    </form>
  );
}
