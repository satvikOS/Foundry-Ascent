import { ChevronDown, Mic, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';

import { PersonaAvatar } from '@/components/faces/persona-avatar';
import { VeirName } from '@/components/faces/veir-name';
import { CallCaptions } from '@/features/calls/call-captions';
import type { AvatarState } from '@/lib/realtime/avatar';
import { SphereAvatar } from '@/lib/realtime/sphere';
import { veirFromIdentity } from '@/lib/veir';

import { AD_CALL_CONFIG, AD_SESSION } from './fixtures';
import { BEATS, type Frame } from './script';
import { AdTimeline } from './timeline';

const VEIR = veirFromIdentity(AD_CALL_CONFIG.veir);

const STATUS: Record<AvatarState, string> = {
  idle: '',
  connecting: 'Connecting',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: `${AD_SESSION.mentor} is speaking`,
  muted: 'Muted',
};

export interface PhoneScreenProps {
  frame: Frame;
  /** Receives the mounted sphere, so the player can give it both voices' recorded levels every frame. */
  sphereRef: RefObject<SphereAvatar | null>;
  reducedMotion: boolean;
}

/**
 * The phone's screen: the live call as the app draws it. The call's voice sphere centred on black, the vEIR's badge
 * and name under it with its state, the captions, the call's conversation timeline and the two controls. The
 * sphere is the call's own presence, given the call's state and both voices' recorded levels exactly as a call
 * gives them; the timeline is the call's own, reading the same turns.
 */
export function PhoneScreen({ frame, sphereRef, reducedMotion }: PhoneScreenProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [sphere] = useState(() => new SphereAvatar());

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    sphere.mount(stage, { reducedMotion });
    sphereRef.current = sphere;
    return () => {
      sphereRef.current = null;
      sphere.unmount();
    };
  }, [sphere, sphereRef, reducedMotion]);

  useEffect(() => {
    sphere.setState(frame.voice);
  }, [sphere, frame.voice]);

  const clock = `0:${String(frame.callSeconds).padStart(2, '0')}`;
  return (
    <div className="ad-call" data-screen={frame.phone}>
      <div className="flex items-center justify-between text-muted-foreground">
        <ChevronDown aria-hidden className="size-6" />
        <span className="tabular text-small">{clock}</span>
        <SlidersHorizontal aria-hidden className="size-5" />
      </div>
      <div className="grid content-center justify-items-center gap-5">
        <div ref={stageRef} data-slot="ad-sphere" data-state={frame.voice} className="ad-call__stage" />
        <div className="grid justify-items-center gap-1 text-small">
          <span className="flex items-center gap-2">
            <PersonaAvatar name={VEIR.name} size="md" decorative />
            <VeirName veir={VEIR} interactive={false} className="font-medium" />
          </span>
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
      <AdTimeline
        turns={frame.turns}
        elapsedMs={frame.t - BEATS.phoneAt}
        spanMs={BEATS.end - BEATS.phoneAt}
        veirName={VEIR.name}
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
