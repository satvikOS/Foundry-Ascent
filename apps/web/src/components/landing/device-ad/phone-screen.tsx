import { ChevronDown, Mic, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useMemo, useRef, type ComponentType, type RefObject } from 'react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { VeirName } from '@/components/faces/veir-name';
import { CallCaptions } from '@/features/calls/call-captions';
import type { AvatarProvider, AvatarState } from '@/lib/realtime/avatar';
import { veirFromIdentity } from '@/lib/veir';

import { AD_CALL_CONFIG, AD_SESSION } from './fixtures';
import { BEATS, type Frame } from './script';
import type { TimelineSlotProps } from './timeline';

const VEIR = veirFromIdentity(AD_CALL_CONFIG.veir);

const STATUS: Record<AvatarState, string> = {
  idle: '',
  connecting: 'Connecting',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: `${AD_SESSION.eir.firstName} is speaking`,
  muted: 'Muted',
};

export interface PhoneScreenProps {
  frame: Frame;
  /** Makes the vEIR's presence (the call's own provider): mounted once, driven by the ad. */
  createPresence: () => AvatarProvider;
  /** The vEIR's monogram sits inside the presence (the ring presence) rather than as a badge under it. */
  monogramInside: boolean;
  Timeline: ComponentType<TimelineSlotProps>;
  /** Receives the mounted presence, so the player can give it the voices' levels every frame. */
  presenceRef: RefObject<AvatarProvider | null>;
  reducedMotion: boolean;
}

/**
 * The phone's screen: the live call, with the vEIR's presence centred on black, its name and state, the
 * captions, the conversation timeline and the two controls. The presence is the call's own provider, given the
 * call's state and both voices' recorded levels exactly as a call gives them.
 */
export function PhoneScreen({
  frame,
  createPresence,
  monogramInside,
  Timeline,
  presenceRef,
  reducedMotion,
}: PhoneScreenProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const presence = useMemo(createPresence, [createPresence]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    presence.mount(stage, { reducedMotion });
    presenceRef.current = presence;
    return () => {
      presenceRef.current = null;
      presence.unmount();
    };
  }, [presence, presenceRef, reducedMotion]);

  useEffect(() => {
    presence.setState(frame.voice);
  }, [presence, frame.voice]);

  const clock = `0:${String(frame.callSeconds).padStart(2, '0')}`;
  return (
    <div className="ad-call" data-screen={frame.phone}>
      <div className="flex items-center justify-between text-muted-foreground">
        <ChevronDown aria-hidden className="size-6" />
        <span className="tabular text-small">{clock}</span>
        <SlidersHorizontal aria-hidden className="size-5" />
      </div>
      <div className="grid content-center justify-items-center gap-5">
        <div ref={stageRef} className="ad-call__stage">
          {monogramInside ? (
            <PersonaAvatar name={VEIR.name} size="2xl" decorative className="relative" />
          ) : null}
        </div>
        <div className="grid justify-items-center gap-1 text-small">
          <VeirName veir={VEIR} interactive={false} className="font-medium" />
          <span className="text-muted-foreground">{STATUS[frame.voice]}</span>
        </div>
        <CallCaptions
          name={VEIR.name}
          veir={frame.veirCaption}
          founder={frame.studentCaption}
          founderLive={frame.voice === 'listening'}
          size="sm"
          readAloud={false}
        />
      </div>
      <Timeline
        turns={frame.turns}
        elapsedMs={frame.t - BEATS.phoneAt}
        spanMs={BEATS.end - BEATS.phoneAt}
        className="mb-6"
      />
      <div className="flex items-center justify-between">
        <span className="ad-call__control">
          <Mic aria-hidden className="size-6" />
        </span>
        <span className="ad-call__control">
          <X aria-hidden className="size-6" />
        </span>
      </div>
      <span className="ad-call__off" />
    </div>
  );
}
