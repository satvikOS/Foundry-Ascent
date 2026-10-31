import { AudioLines } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, type ReactNode, type Ref } from 'react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { VeirName } from '@/components/faces/veir-name';
import { useMe } from '@/lib/auth/use-me';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { createAvatarProvider, type AvatarState } from '@/lib/realtime/avatar';
import type { CallEngine } from '@/lib/realtime/call-engine';
import { cn } from '@/lib/utils';

import { CallFaceVideo } from './call-video-tile';
import { useCallFace, type CallFaceController } from './use-call-face';
import type { CallVeir } from './use-call-veir';

interface CallStageProps {
  veir: CallVeir;
  engine: CallEngine;
  state: AvatarState;
  /**
   * The name tag in the tile's corner, like a video call's ("Corin · vEIR"). The call screen passes its heading;
   * by default the vEIR's name and badge.
   */
  nameTag?: ReactNode;
  /** The call's venture and, once live, the call: a vendor face is minted for that call only. */
  ventureId?: string | null;
  callId?: string | null;
  className?: string;
  /** The face became a live video (true) or went back to the presence (false). */
  onVideoChange?: (live: boolean) => void;
  /** The call's face (it outlives this screen: minimized, the call keeps it). Null: always the presence. */
  face?: CallFaceController | null;
}

/**
 * The vEIR's tile, like a participant on a video call. By default the built-in presence mounts into it and
 * follows the call's state and both voices every animation frame, with the vEIR's monogram or consented
 * portrait in the middle. When the call settings name a vendor face, the tile asks for its session once the
 * call is live and, as soon as the face shows its first frame, the same tile shows the face's video instead
 * (the face follows the same state, voices and sentences) with the founder's initials in the corner. Until
 * then, and whenever the face is unavailable, the presence is the face. The tile keeps its size either way,
 * with the name tag in the corner and a speaking indicator: the edge lights and the tag shows a voice mark
 * while the vEIR speaks (text says it too, beside the tile).
 */
export function CallStage({
  veir,
  engine,
  state,
  nameTag,
  ventureId = null,
  callId = null,
  className,
  onVideoChange,
  face: controller = null,
}: CallStageProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const presence = useMemo(() => createAvatarProvider(), []);
  const face = useCallFace(controller);
  const video = face.status === 'live';
  const active = face.status === 'live' ? face.provider : presence;

  // Once the call is live, ask for its face (once per call; the controller keeps it while minimized).
  useEffect(() => {
    if (controller === null || ventureId === null || callId === null) return;
    controller.request({ provider: veir.provider, ventureId, callId, reducedMotion });
  }, [controller, veir.provider, ventureId, callId, reducedMotion]);
  const speaking = state === 'speaking';
  const me = useMe();
  const levels = useCallback(() => engine.levels(), [engine]);

  useEffect(() => {
    onVideoChange?.(video);
  }, [onVideoChange, video]);

  // The presence draws into the square stage, which is shown whenever no video is.
  useEffect(() => {
    const stage = stageRef.current;
    if (video || !stage) return undefined;
    presence.mount(stage, { reducedMotion });
    return () => {
      presence.unmount();
    };
  }, [presence, reducedMotion, video]);

  useEffect(() => {
    active.setState(state);
  }, [active, state]);

  useEffect(
    () =>
      engine.onSpeak((unit) => {
        active.speak(unit);
      }),
    [engine, active],
  );

  useEffect(() => {
    if (reducedMotion) return undefined;
    let frame = 0;
    const loop = () => {
      active.setLevels(engine.levels());
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [engine, active, reducedMotion]);

  return (
    <div
      data-slot="call-tile"
      data-speaking={speaking || undefined}
      data-face={video ? 'video' : 'presence'}
      className={cn(
        'relative grid aspect-video max-w-[calc(100vw-2rem)] place-items-center overflow-hidden rounded-3xl border shadow-sm transition-[box-shadow,border-color] duration-300',
        video ? 'bg-black' : 'bg-card/60',
        speaking && 'border-foreground/30 ring-2 ring-foreground/20',
        className,
      )}
    >
      {face.status === 'live' ? (
        <CallFaceVideo
          stream={face.stream}
          media={face.media}
          you={me.data?.principal.displayName ?? 'You'}
          levels={levels}
          reducedMotion={reducedMotion}
          stock={face.stock}
        />
      ) : (
        <div
          ref={stageRef}
          data-slot="call-stage"
          data-state={state}
          className="relative grid aspect-square h-[86%] place-items-center"
        >
          <PersonaAvatar
            name={veir.name}
            portraitUrl={veir.portraitUrl}
            size="2xl"
            decorative
            className="relative shadow-lg"
          />
        </div>
      )}
      <div className="absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] items-center">
        {nameTag ?? <CallNameTag veir={veir} speaking={speaking} />}
      </div>
    </div>
  );
}

/**
 * The tile's name tag: a voice mark while the vEIR speaks, then its name and badge ("Corin · vEIR"). With
 * `headingRef` it is the call screen's heading (focused when the call opens).
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
    'glass-strong flex min-w-0 items-center gap-1.5 rounded-full border py-1 pr-1.5 pl-3 text-small font-medium text-foreground outline-none';
  const content = (
    <>
      {speaking ? <AudioLines aria-hidden className="size-3.5 shrink-0" data-slot="speaking-mark" /> : null}
      <VeirName veir={veir} />
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
