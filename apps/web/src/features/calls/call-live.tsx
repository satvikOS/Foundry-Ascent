import type { TurnBlockedDetail } from '@foundry/contracts';
import { ArrowUp, Info, Mic, Play, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';

import { DisclosureBanner } from '@/components/disclosure-banner';
import { VeirBadge } from '@/components/faces/veir-badge';
import { Button } from '@/components/ui/button';
import { BlockedPanel } from '@/features/coach/blocked-panel';
import { useHotkeys } from '@/lib/hooks/use-hotkeys';
import type { CallEngine, CallNotice, CallSnapshot, TypedReason } from '@/lib/realtime/call-engine';
import { cn } from '@/lib/utils';

import { CallCaptions } from './call-captions';
import { CallDock, HoldToTalk } from './call-dock';
import { CallStage } from './call-stage';
import { storeTalkMode, useAnnounceCaptions, useCaptionSize, useCaptionsPreference } from './preferences';
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
}

/**
 * The call in progress: the presence and the vEIR's name and state, live captions (or, after a held-back
 * turn, the support it offers), any notice, the typed line, the controls and the AI disclosure.
 */
export function CallLive({ tenant, engine, snapshot, veir, onSwitchToChat }: CallLiveProps) {
  const [captions, setCaptions] = useCaptionsPreference();
  const [captionSize] = useCaptionSize();
  const [announceCaptions] = useAnnounceCaptions();
  const typedOnly = snapshot.input === 'typed';
  const [typingOpen, setTypingOpen] = useState(false);
  const typing = typedOnly || typingOpen;
  const live = snapshot.phase === 'live';
  const voice = snapshot.input === 'voice';
  const pushToTalk = snapshot.talkMode === 'push_to_talk';
  const typeRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLHeadingElement | null>(null);

  // Focus starts on the vEIR's name (the state is announced next to it); typing-only calls focus the line.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  useEffect(() => {
    if (live && typedOnly) typeRef.current?.focus();
  }, [live, typedOnly]);

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
    live,
  );

  // Hold Space anywhere on the call screen to talk (push-to-talk), unless a control has focus. Space released
  // in another app or tab never reaches the page, so leaving the window or hiding the page lets go too.
  useEffect(() => {
    if (!live || !pushToTalk || !voice) return undefined;
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
  }, [engine, live, pushToTalk, voice]);

  const status = callStatusLabel(snapshot);
  const speaking = live && snapshot.activity === 'speaking';
  const halfDuplexInterrupt = speaking && voice && snapshot.halfDuplex;
  // Replies on screen only (no voice for them): they are shown whatever the captions setting, and read to a
  // screen reader, since there is no voice to talk over.
  const onScreenOnly = snapshot.voice === 'captions';
  const readCaptions = announceCaptions || onScreenOnly;
  const veirLine = snapshot.captions.veir;

  return (
    // Content taller than the screen (support resources, a long caption) scrolls the call screen instead of
    // running under the dock.
    <div className="flex flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-4 py-4 sm:gap-6">
        {snapshot.blocked ? null : (
          <CallStage
            veir={veir}
            engine={engine}
            state={engine.avatarState()}
            className="w-[min(15rem,58vw,32dvh)] sm:w-[min(18rem,34dvh)]"
          />
        )}
        <div className="flex flex-col items-center gap-1.5">
          <h2
            ref={nameRef}
            tabIndex={-1}
            className="flex items-center gap-2 font-serif text-subheading font-normal outline-none"
          >
            {veir.name}
            <VeirBadge kind={veir.kind} mode="Live voice" />
          </h2>
          {/* Always present, so each new line is announced (a live region added with its text is not). */}
          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {readCaptions && veirLine ? `${veir.name}: ${veirLine}` : ''}
          </p>
          <p className="flex items-center gap-2 text-small text-muted-foreground">
            <span role="status" aria-live="polite">
              {status}
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
                  className="rounded-sm font-medium text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  Interrupt
                </button>
              </>
            ) : null}
          </p>
        </div>
        {live && snapshot.audioBlocked ? (
          <Button
            size="lg"
            onClick={() => {
              engine.resumeAudio();
            }}
          >
            <Volume2 aria-hidden />
            Turn on sound
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
        ) : captions || onScreenOnly ? (
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

      <div className="flex shrink-0 flex-col items-center gap-4 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
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
        {typing ? (
          <TypeLine
            inputRef={typeRef}
            name={veir.name}
            hint={snapshot.typedReason ? TYPED_REASONS[snapshot.typedReason] : null}
            queued={snapshot.queued}
            disabled={!live}
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
        {voice && pushToTalk && live ? (
          <HoldToTalk
            talking={snapshot.talking}
            onChange={(pressed) => {
              engine.pushToTalk(pressed);
            }}
          />
        ) : null}
        <CallDock
          name={veir.name}
          voice={voice}
          muted={snapshot.muted}
          pushToTalk={pushToTalk}
          captions={captions}
          typing={typingOpen}
          disabled={!live}
          onMute={toggleMute}
          onPushToTalk={toggleTalkMode}
          onCaptions={() => {
            setCaptions(!captions);
          }}
          onTyping={toggleTyping}
          onSwitchToChat={onSwitchToChat}
          onEnd={() => {
            void engine.end('user');
          }}
        />
        <DisclosureBanner
          variant="line"
          text={veir.disclosure}
          veirName={veir.name}
          className="max-w-2xl text-center"
        />
      </div>
    </div>
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
      <div className="flex items-center gap-2 rounded-full border border-border-strong bg-card py-1.5 pr-1.5 pl-4 shadow-xs transition-[border-color,box-shadow] duration-150 focus-within:border-ring/60 focus-within:shadow-md">
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
