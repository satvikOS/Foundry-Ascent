import { AudioLines } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';

import { VeirName } from '@/components/faces/veir-name';
import { useMe } from '@/lib/auth/use-me';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { createAvatarProvider, type AvatarProvider } from '@/lib/realtime/avatar';
import type { CallEngine } from '@/lib/realtime/call-engine';
import { loadLocalCharacter } from '@/lib/realtime/presentation';
import type { SphereState } from '@/lib/realtime/sphere';
import { cn } from '@/lib/utils';

import { CallFaceVideo } from './call-video-tile';
import { usePresentationPreference } from './preferences';
import { callTimeline } from './timeline/call-timeline';
import { useCallFace, type CallFaceController } from './use-call-face';
import type { CallVeir } from './use-call-veir';

interface CallStageProps {
  veir: CallVeir;
  engine: CallEngine;
  /** What the presence shows (the engine's avatar state, or the call screen's own: paused, disconnected, ended). */
  state: SphereState;
  /**
   * The name tag under the presence (in the corner of a face's video), "Thomas". The call screen passes its
   * heading; by default the mentor's name.
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

/** A local presentation's provider (the engine's states only; the sphere also takes the call screen's). */
type LocalProvider = AvatarProvider & { setState(state: SphereState): void };

/**
 * The vEIR's presence on the call. By default the voice sphere, centred on the call's canvas, following the call's
 * state and both measured voices every animation frame (the call's one frame loop). The person may pick the
 * character instead (call settings), which is always labelled "AI avatar". When the call settings name a vendor
 * face, the stage asks for its session once the call is live and, as soon as the face shows its first frame, shows
 * the face's video in a tile instead, with the name tag in its corner. Until then, and whenever the face is
 * unavailable, the sphere or character is the face.
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
  const sphere = useMemo(() => createAvatarProvider() as LocalProvider, []);
  const [presentation] = usePresentationPreference();
  const [character, setCharacter] = useState<AvatarProvider | null>(null);
  const [characterFailed, setCharacterFailed] = useState(false);
  useEffect(() => {
    if (presentation !== 'character') {
      setCharacterFailed(false);
      return undefined;
    }
    let current = true;
    void loadLocalCharacter()
      .then((provider) => {
        if (current) setCharacter(provider);
        else provider.unmount();
      })
      .catch(() => {
        if (current) setCharacterFailed(true);
      });
    return () => {
      current = false;
    };
  }, [presentation]);
  const local: AvatarProvider =
    presentation === 'character' && character && !characterFailed ? character : sphere;
  const face = useCallFace(controller);
  const video = face.status === 'live';
  const active = face.status === 'live' ? face.provider : local;
  const isCharacter = !video && local.drawsFace;

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

  // The presence draws into the stage, which is shown whenever no video is.
  useEffect(() => {
    const stage = stageRef.current;
    if (video || !stage) return undefined;
    local.mount(stage, { reducedMotion });
    return () => {
      local.unmount();
    };
  }, [local, reducedMotion, video]);

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
  }, [video]);

  const tag = nameTag ?? <CallNameTag veir={veir} speaking={speaking} />;

  return (
    <div
      data-slot="call-tile"
      data-speaking={speaking || undefined}
      data-face={video ? 'video' : isCharacter ? 'character' : 'presence'}
      className={cn('flex w-full flex-col items-center gap-4', className)}
    >
      {face.status === 'live' ? (
        <div
          className={cn(
            'relative grid aspect-video w-full max-w-3xl max-h-[44dvh] place-items-center overflow-hidden rounded-3xl border bg-black shadow-sm transition-[box-shadow,border-color] duration-300',
            speaking && 'border-foreground/30 ring-2 ring-foreground/20',
          )}
        >
          <CallFaceVideo
            stream={face.stream}
            media={face.media}
            you={me.data?.principal.displayName ?? 'You'}
            levels={levels}
            reducedMotion={reducedMotion}
            stock={face.stock}
          />
          <div className="glass-strong absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] items-center rounded-full border">
            {tag}
          </div>
        </div>
      ) : (
        <>
          <div
            ref={stageRef}
            data-slot="call-stage"
            data-state={state}
            className={cn(
              'relative grid place-items-center',
              isCharacter &&
                'aspect-square w-[clamp(168px,34vmin,340px)] overflow-hidden rounded-[2rem] bg-card/60',
            )}
          >
            {isCharacter ? (
              // The character is a drawn stand-in, never a likeness: it always says what it is.
              <p
                data-slot="ai-avatar-label"
                className="absolute top-3 left-3 rounded-full border border-border-strong bg-background/85 px-2 py-0.5 text-[0.6875rem] font-medium text-muted-foreground"
              >
                AI avatar
              </p>
            ) : null}
          </div>
          <div className="flex max-w-full items-center gap-2">{tag}</div>
        </>
      )}
      {characterFailed && !video ? (
        <p role="status" className="text-caption text-muted-foreground">
          Avatar unavailable. Voice stays on.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The presence's name tag: a voice mark while the vEIR speaks, then its name ("Thomas"). With
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
    'flex min-w-0 items-center gap-1.5 rounded-full py-1 pr-1.5 pl-2 text-small font-medium text-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring';
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
