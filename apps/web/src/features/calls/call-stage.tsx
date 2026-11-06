import { AudioLines, Phone, RotateCw, VideoOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, type ReactNode, type Ref } from 'react';

import { Button } from '@/components/ui/button';
import { useMe } from '@/lib/auth/use-me';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { createAvatarProvider, type AvatarProvider } from '@/lib/realtime/avatar';
import type { CallEngine } from '@/lib/realtime/call-engine';
import type { SphereState } from '@/lib/realtime/sphere';
import { cn } from '@/lib/utils';

import { CallFaceVideo } from './call-video-tile';
import { callTimeline } from './timeline/call-timeline';
import { useCallFace, type CallFaceController } from './use-call-face';
import type { CallVeir } from './use-call-veir';

interface CallStageProps {
  veir: CallVeir;
  engine: CallEngine;
  /** What the presence shows (the engine's avatar state, or the call screen's own: paused, disconnected, ended). */
  state: SphereState;
  /**
   * The name tag in the corner of a face's video, and under the presence unless null (the call screen names the
   * vEIR in its header). By default the vEIR's display name.
   */
  nameTag?: ReactNode;
  /** The call's venture and, once live, the call: a vendor face is minted for that call only. */
  ventureId?: string | null;
  callId?: string | null;
  className?: string;
  /**
   * A video call: the vendor face is asked for once the call is live (when the call settings name one), and until it
   * shows the tile says the call is connecting to the vEIR (never a stand-in presence; the conversation waits for the
   * face); a face the vendor ended is replaced (the tile says it is reconnecting); one that cannot start or come back
   * makes the tile say video is not available right now, with the voice call one tap away. A voice call never asks for
   * it: the sphere is its presence.
   */
  video?: boolean;
  /** A video call whose face is not available offers this (switch to a voice call); null: no offer. */
  onVoiceInstead?: (() => void) | null;
  /** The call's face (it outlives this screen: minimized, the call keeps it). Null: always the presence. */
  face?: CallFaceController | null;
}

/** A local presentation's provider (the engine's states only; the sphere also takes the call screen's). */
type LocalProvider = AvatarProvider & { setState(state: SphereState): void };

/**
 * The vEIR's presence on the call. On a voice call, the voice sphere, centred on the call's canvas, following the
 * call's state and both measured voices every animation frame (the call's one frame loop). On a video call (when
 * the call settings name a vendor face), the stage asks for the face's session once the call is live and shows the
 * face's video in a 16:9 tile, labelled "AI avatar", with the name tag in its corner; until its first frame the tile
 * says the video is starting, and if the face cannot start or drops, the tile says that (owner, round 3: no stand-in
 * presence for video).
 */
export function CallStage({
  veir,
  engine,
  state,
  nameTag,
  ventureId = null,
  callId = null,
  className,
  face: controller = null,
  video: wantsVideo = true,
  onVoiceInstead = null,
}: CallStageProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const sphere = useMemo(() => createAvatarProvider() as LocalProvider, []);
  const face = useCallFace(controller);
  const video = face.status === 'live';
  const active = video ? face.provider : sphere;
  const pending = videoPending(wantsVideo, controller, veir.provider, face);

  // A video call warms its face's adapter at once (while the call opens), then asks for the face once it is live (the
  // controller keeps it while minimized).
  useEffect(() => {
    if (wantsVideo) controller?.warm(veir.provider);
  }, [wantsVideo, controller, veir.provider]);
  useEffect(() => {
    if (!wantsVideo || controller === null || ventureId === null || callId === null) return;
    controller.request({ provider: veir.provider, ventureId, callId, reducedMotion });
  }, [wantsVideo, controller, veir.provider, ventureId, callId, reducedMotion]);
  const speaking = state === 'speaking';
  const me = useMe();
  const levels = useCallback(() => engine.levels(), [engine]);

  // The sphere draws into the stage, which is shown whenever no video (or video tile) is.
  useEffect(() => {
    const stage = stageRef.current;
    if (video || pending !== null || !stage) return undefined;
    sphere.mount(stage, { reducedMotion });
    return () => {
      sphere.unmount();
    };
  }, [sphere, reducedMotion, video, pending]);

  useEffect(() => {
    if (active === sphere) sphere.setState(state);
    else
      active.setState(state === 'paused' || state === 'disconnected' || state === 'ended' ? 'muted' : state);
  }, [active, sphere, state]);

  useEffect(
    () =>
      engine.onSpeak((unit) => {
        active.speak(unit);
      }),
    [engine, active],
  );

  // The call's one frame loop hands the measured levels over while the call is live and the page visible.
  useEffect(() => {
    if (reducedMotion) return undefined;
    return callTimeline(engine).onFrame((frame) => {
      active.setLevels(frame);
    });
  }, [engine, active, reducedMotion]);

  // CSS breathing pauses while the page is hidden.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const visibility = () => {
      stage.dataset.hidden = String(document.visibilityState === 'hidden');
    };
    document.addEventListener('visibilitychange', visibility);
    visibility();
    return () => {
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [video, pending]);

  const tag = nameTag === undefined ? <CallNameTag veir={veir} speaking={speaking} /> : nameTag;
  const videoTag = tag ?? <CallNameTag veir={veir} speaking={speaking} />;

  // 16:9 at the largest size the screen allows: as wide as the stage (up to 768 px, 1024 px on a monitor) and as tall
  // as leaves room for the captions and controls, never stretched out of shape.
  const videoFrame =
    'relative grid aspect-video w-[min(100%,calc(max(12rem,min(40dvh,calc(100dvh-30rem)))*16/9))] max-w-3xl min-[100rem]:max-w-5xl place-items-center overflow-hidden rounded-3xl border bg-black shadow-sm';

  return (
    <div
      data-slot="call-tile"
      data-speaking={speaking || undefined}
      data-face={video ? 'video' : pending === null ? 'presence' : `video-${pending}`}
      className={cn('flex w-full flex-col items-center gap-4', className)}
    >
      {face.status === 'live' ? (
        <div
          className={cn(
            videoFrame,
            'transition-[box-shadow,border-color] duration-300',
            speaking && 'border-foreground/30 ring-2 ring-foreground/20',
          )}
        >
          <CallFaceVideo
            stream={face.stream}
            media={face.media}
            you={me.data?.principal.displayName ?? 'You'}
            levels={levels}
            reducedMotion={reducedMotion}
          />
          <div className="glass-strong absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] items-center rounded-full border">
            {videoTag}
          </div>
        </div>
      ) : pending !== null ? (
        <VideoPendingTile
          pending={pending}
          frameClass={videoFrame}
          name={veir.name}
          still={face.status === 'reconnecting' ? face.still : null}
          reducedMotion={reducedMotion}
          tag={videoTag}
          onVoiceInstead={onVoiceInstead}
          onRetry={
            controller !== null && callId !== null && controller.canAsk(callId)
              ? () => {
                  controller.retry(callId);
                }
              : null
          }
        />
      ) : (
        <>
          <div
            ref={stageRef}
            data-slot="call-stage"
            data-state={state}
            className="relative grid place-items-center"
          />
          {tag === null ? null : <div className="flex max-w-full items-center gap-2">{tag}</div>}
        </>
      )}
    </div>
  );
}

/** A video call's face that is not shown: joining, being replaced, paused with the call, or not available now. */
export type VideoPending = 'connecting' | 'reconnecting' | 'paused' | 'unavailable';

/** What a video call's tile (and its status line) says while its face is not shown (`name`: the vEIR's). */
export function videoPendingText(pending: VideoPending, name: string): string {
  switch (pending) {
    case 'connecting':
      return `Connecting to ${name}…`;
    case 'reconnecting':
      return 'Reconnecting…';
    case 'paused':
      return 'Video paused';
    case 'unavailable':
      return 'Video isn’t available right now';
  }
}

/**
 * A video call's face that is not shown (null when it is shown, or on a voice call, or with no vendor face to ask
 * for): `connecting` until the face first shows (the conversation waits for it), `reconnecting` while a new vendor
 * session replaces one that ended, `paused` while the call is on hold, `unavailable` when it could not start or come
 * back (the call screen offers the voice call).
 */
export function videoPending(
  wantsVideo: boolean,
  controller: CallFaceController | null,
  provider: CallVeir['provider'],
  face: ReturnType<typeof useCallFace>,
): VideoPending | null {
  if (!wantsVideo || controller === null || provider === 'builtin') return null;
  switch (face.status) {
    case 'live':
      return null;
    case 'presence':
    case 'connecting':
      return 'connecting';
    case 'reconnecting':
    case 'paused':
    case 'unavailable':
      return face.status;
  }
}

/**
 * The 16:9 tile of a video call while its face is not shown. Connecting: a calm "Connecting to Thomas…" on black (no
 * stand-in, no sphere). Reconnecting: the face's last frame, dimmed, under "Reconnecting…". Not available: says so,
 * with the voice call one tap away (the conversation is kept) and another try.
 */
function VideoPendingTile({
  pending,
  frameClass,
  name,
  still,
  reducedMotion,
  tag,
  onVoiceInstead,
  onRetry,
}: {
  pending: VideoPending;
  frameClass: string;
  name: string;
  /** The face's last frame (a data URL) while a new session replaces it. */
  still: string | null;
  reducedMotion: boolean;
  tag: ReactNode;
  onVoiceInstead: (() => void) | null;
  onRetry: (() => void) | null;
}) {
  const waiting = pending === 'connecting' || pending === 'reconnecting';
  const text = videoPendingText(pending, name);
  return (
    <div data-slot="call-video-pending" data-pending={pending} className={frameClass}>
      {still !== null ? (
        <img
          src={still}
          alt=""
          aria-hidden
          data-slot="call-video-still"
          className="absolute inset-0 size-full scale-105 object-cover opacity-60 blur-[2px]"
        />
      ) : null}
      <div className="relative flex max-w-md flex-col items-center gap-3 px-6 text-center text-small text-white/85">
        {waiting ? (
          <span
            aria-hidden
            data-slot="call-video-connecting"
            className={cn('size-2.5 rounded-full bg-white/75', !reducedMotion && 'motion-safe:animate-pulse')}
          />
        ) : (
          <VideoOff aria-hidden className="size-5 text-white/70" />
        )}
        {/* The call's status line announces the state; this is what the tile shows. */}
        <p className={cn(waiting ? 'text-body text-white/90' : 'font-medium text-white')}>{text}</p>
        {pending === 'unavailable' ? (
          <p className="text-white/70">
            Your conversation with {name} is kept.{onVoiceInstead ? ' You can carry on as a voice call.' : ''}
          </p>
        ) : null}
        {pending === 'unavailable' && (onVoiceInstead || onRetry) ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            {onVoiceInstead ? (
              <Button
                type="button"
                size="sm"
                data-slot="video-off"
                // The tile is black in both themes: its buttons are light on it.
                className="min-h-11 bg-white text-black hover:bg-white/90 sm:min-h-9"
                onClick={onVoiceInstead}
              >
                <Phone aria-hidden />
                Voice call
              </Button>
            ) : null}
            {onRetry ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-slot="video-retry"
                className="min-h-11 border border-white/30 text-white hover:bg-white/10 hover:text-white sm:min-h-9"
                onClick={onRetry}
              >
                <RotateCw aria-hidden />
                Try again
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {/* Not over the offer of a voice call (the header names the vEIR): a phone's tile has no room for both. */}
      {pending === 'unavailable' ? null : (
        <div className="glass-strong absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] items-center rounded-full border">
          {tag}
        </div>
      )}
    </div>
  );
}

/**
 * The presence's name tag: a voice mark while the vEIR speaks, then its display name ("Thomas"). With `headingRef`
 * it is a heading (focused when shown).
 */
export function CallNameTag({
  veir,
  speaking,
  headingRef,
}: {
  veir: CallVeir;
  speaking: boolean;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const className =
    'flex min-w-0 items-center gap-1.5 rounded-full py-1 pr-1.5 pl-2 text-small font-medium text-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring';
  const content = (
    <>
      {speaking ? <AudioLines aria-hidden className="size-3.5 shrink-0" data-slot="speaking-mark" /> : null}
      <span className="min-w-0 truncate">{veir.name}</span>
    </>
  );
  return headingRef ? (
    <h2 ref={headingRef} tabIndex={-1} data-slot="call-name-tag" className={className}>
      {content}
    </h2>
  ) : (
    <p data-slot="call-name-tag" className={className}>
      {content}
    </p>
  );
}
