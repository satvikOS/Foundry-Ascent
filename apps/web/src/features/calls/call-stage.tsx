import { AudioLines } from 'lucide-react';
import { useEffect, useMemo, useRef, type ReactNode, type Ref } from 'react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { VeirName } from '@/components/faces/veir-name';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { createAvatarProvider, type AvatarState } from '@/lib/realtime/avatar';
import type { CallEngine } from '@/lib/realtime/call-engine';
import { cn } from '@/lib/utils';

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
  className?: string;
}

/**
 * The vEIR's tile, like a participant on a video call: the avatar stage (the provider, the built-in presence
 * today, mounts into it and follows the call's state and both voices every animation frame) with the vEIR's
 * monogram or consented portrait in the middle unless the provider draws its own face (a vendor's video later),
 * the name tag in the corner, and a speaking indicator: the tile's edge lights and the tag shows a voice mark
 * while the vEIR speaks (text says it too, beside the tile).
 */
export function CallStage({ veir, engine, state, nameTag, className }: CallStageProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const provider = useMemo(() => createAvatarProvider(veir.provider), [veir.provider]);
  const speaking = state === 'speaking';

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
      data-slot="call-tile"
      data-speaking={speaking || undefined}
      className={cn(
        'relative grid aspect-video max-w-[calc(100vw-2rem)] place-items-center overflow-hidden rounded-3xl border bg-card/60 shadow-sm transition-[box-shadow,border-color] duration-300',
        speaking && 'border-foreground/30 ring-2 ring-foreground/20',
        className,
      )}
    >
      <div
        ref={stageRef}
        data-slot="call-stage"
        data-state={state}
        className="relative grid aspect-square h-[86%] place-items-center"
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
