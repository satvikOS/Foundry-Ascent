import { useCallback, useEffect, useMemo, useRef } from 'react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { useMe } from '@/lib/auth/use-me';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { createAvatarProvider, type AvatarState } from '@/lib/realtime/avatar';
import type { CallEngine } from '@/lib/realtime/call-engine';
import { cn } from '@/lib/utils';

import { CallVideoTile } from './call-video-tile';
import { BROWSER_FACE_DEPS, useCallFace, type CallFaceDeps } from './use-call-face';
import type { CallVeir } from './use-call-veir';

interface CallStageProps {
  veir: CallVeir;
  engine: CallEngine;
  state: AvatarState;
  /** The call's venture and, once live, the call: a vendor face is minted for that call only. */
  ventureId?: string | null;
  callId?: string | null;
  className?: string;
  /** The face became a live video tile (true) or went back to the presence (false). */
  onVideoChange?: (live: boolean) => void;
  /** Injectable for tests. */
  faceDeps?: CallFaceDeps;
}

/**
 * The avatar stage. The built-in presence mounts into it and follows the call's state and both voices, every
 * animation frame, with the vEIR's monogram or consented portrait in the middle. When the call settings name a
 * vendor face, the stage asks for its session once the call is live and, as soon as the face shows its first
 * frame, becomes a video tile (the face follows the same state, voices and sentences). Until then, and whenever
 * the face is unavailable, the presence is the face.
 */
export function CallStage({
  veir,
  engine,
  state,
  ventureId = null,
  callId = null,
  className,
  onVideoChange,
  faceDeps = BROWSER_FACE_DEPS,
}: CallStageProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const presence = useMemo(() => createAvatarProvider(), []);
  const face = useCallFace({ provider: veir.provider, ventureId, callId, engine, reducedMotion }, faceDeps);
  const video = face.status === 'live';
  const active = video ? face.provider : presence;
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

  if (face.status === 'live') {
    return (
      <CallVideoTile
        veir={veir}
        stream={face.stream}
        speaking={state === 'speaking'}
        you={me.data?.principal.displayName ?? 'You'}
        levels={levels}
        reducedMotion={reducedMotion}
      />
    );
  }

  return (
    <div
      ref={stageRef}
      data-slot="call-stage"
      data-state={state}
      className={cn('relative grid aspect-square place-items-center', className)}
    >
      <PersonaAvatar
        name={veir.name}
        portraitUrl={veir.portraitUrl}
        size="2xl"
        decorative
        className="relative shadow-lg"
      />
    </div>
  );
}
