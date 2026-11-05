import { lazy, Suspense, useRef } from 'react';

import { DeviceStage } from './device-ad/frames';
import { useNearViewport } from './use-near-viewport';

const DeviceAd = lazy(() => import('./device-ad/device-ad'));

/**
 * The hero's media card: an art field holding the device ad. The frames are drawn at once (they reserve the
 * card's full size, so nothing shifts); the ad's screens load as a separate chunk when the card comes near the
 * viewport. One described image for assistive technology, with its caption.
 */
export function HeroMedia() {
  const ref = useRef<HTMLDivElement | null>(null);
  const near = useNearViewport(ref, { rootMargin: '200px' });
  return (
    <figure id="see-a-session" className="l-wrap scroll-mt-20">
      <div
        ref={ref}
        role="img"
        aria-label="A synthetic example. On a laptop, a student asks Corin, a vEIR, whether to raise now or finish a paid pilot; the answer cites two pieces of evidence and suggests a next step. On a phone, the student calls Corin, who asks what a site would need to see to pay; the student decides to finish the pilot first, and the decision is saved to Knowledge."
        className="l-media art art--hero grain"
      >
        {near ? (
          <Suspense fallback={<DeviceStage />}>
            <DeviceAd />
          </Suspense>
        ) : (
          <DeviceStage />
        )}
      </div>
      <figcaption className="mt-3 text-center text-small text-muted-foreground">
        Synthetic example. A real session is private to your venture.
      </figcaption>
    </figure>
  );
}
