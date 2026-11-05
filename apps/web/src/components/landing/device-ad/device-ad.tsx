import { useCallback, useMemo, useRef } from 'react';

import type { AvatarProvider } from '@/lib/realtime/avatar';
import { useMediaQuery } from '@/lib/hooks/use-media-query';

import { DeviceStage, PHONE_ONLY } from './frames';
import { LaptopScreen } from './laptop-screen';
import { PhoneScreen } from './phone-screen';
import { useAdPlayer } from './player';
import { AdSandbox } from './sandbox';
import { BEATS, frameAt, levelsAt } from './script';
import { DEFAULT_VOICE_SLOTS, slowDevice, type VoiceSlots } from './slots';

/**
 * The landing page's laptop + phone ad: the app's real components inside CSS device frames, playing a ~14 s
 * synthetic session twice and resting on its last frame. Interactive nothing: the whole stage is inert and hidden
 * from assistive technology (the figure around it describes it). It plays only on screen in a visible tab, and
 * shows the final frame still under reduced motion or on a slow device. Loaded on demand (landing route chunk).
 */
export default function DeviceAd({ slots }: { slots?: Partial<VoiceSlots> }) {
  const { createPresence, monogramInside, Timeline } = { ...DEFAULT_VOICE_SLOTS, ...slots };
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const still = reducedMotion || slowDevice();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const presenceRef = useRef<AvatarProvider | null>(null);
  const onFrame = useCallback((time: number) => {
    presenceRef.current?.setLevels(levelsAt(time));
  }, []);
  // The phone alone (narrow screens, where the laptop is not shown) plays only its call.
  const phoneOnly = useMediaQuery(PHONE_ONLY);
  const t = useAdPlayer(rootRef, still, onFrame, phoneOnly ? BEATS.phoneAt - 300 : 0);
  const frame = useMemo(() => frameAt(t), [t]);

  return (
    <AdSandbox current={frame.chat === 'streaming' || frame.chat === 'answered'}>
      <div ref={rootRef} inert aria-hidden className="size-full" data-slot="device-ad" data-t={t}>
        <DeviceStage
          laptop={<LaptopScreen frame={frame} />}
          phone={
            <PhoneScreen
              frame={frame}
              createPresence={createPresence}
              monogramInside={monogramInside}
              Timeline={Timeline}
              presenceRef={presenceRef}
              reducedMotion={still}
            />
          }
        />
      </div>
    </AdSandbox>
  );
}
