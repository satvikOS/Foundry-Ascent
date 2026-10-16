import { lazy, Suspense } from 'react';

import { useCall } from './call-context';

const MiniCallBarView = lazy(() =>
  import('./mini-call-bar-view').then((module) => ({ default: module.MiniCallBarView })),
);

/**
 * The mini call bar's place in the app shell. The bar itself loads with the call (most visits never make
 * one), and shows while a call goes on out of view, or ended out of view with its summary waiting.
 */
export function MiniCallBar() {
  const { engine, snapshot, route, quietEnd } = useCall();
  const shown =
    snapshot.phase === 'starting' ||
    snapshot.phase === 'live' ||
    snapshot.phase === 'ending' ||
    snapshot.phase === 'ended';
  if (!engine || route?.open === true || quietEnd || !shown) return null;
  return (
    <Suspense fallback={null}>
      <MiniCallBarView />
    </Suspense>
  );
}
