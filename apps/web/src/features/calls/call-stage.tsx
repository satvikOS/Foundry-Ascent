import { useEffect, useMemo, useRef } from 'react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { createAvatarProvider, type AvatarState } from '@/lib/realtime/avatar';
import type { CallEngine } from '@/lib/realtime/call-engine';
import { cn } from '@/lib/utils';

import type { CallVeir } from './use-call-veir';

interface CallStageProps {
  veir: CallVeir;
  engine: CallEngine;
  state: AvatarState;
  className?: string;
}

/**
 * The avatar stage: the provider (the built-in presence today) mounts into it and follows the call's state
 * and both voices, every animation frame. The vEIR's monogram or consented portrait sits in the middle
 * unless the provider draws its own face.
 */
export function CallStage({ veir, engine, state, className }: CallStageProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const provider = useMemo(() => createAvatarProvider(veir.provider), [veir.provider]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    provider.mount(stage, { reducedMotion });
    return () => {
      provider.unmount();
    };
  }, [provider, reducedMotion]);

  useEffect(() => {
    provider.setState(state);
  }, [provider, state]);

  useEffect(
    () =>
      engine.onSpeak((unit) => {
        provider.speak(unit);
      }),
    [engine, provider],
  );

  useEffect(() => {
    if (reducedMotion) return undefined;
    let frame = 0;
    const loop = () => {
      provider.setLevels(engine.levels());
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [engine, provider, reducedMotion]);

  return (
    <div
      ref={stageRef}
      data-slot="call-stage"
      data-state={state}
      className={cn('relative grid aspect-square place-items-center', className)}
    >
      {provider.drawsFace ? null : (
        <PersonaAvatar
          name={veir.name}
          portraitUrl={veir.portraitUrl}
          size="2xl"
          decorative
          className="relative shadow-lg"
        />
      )}
    </div>
  );
}
