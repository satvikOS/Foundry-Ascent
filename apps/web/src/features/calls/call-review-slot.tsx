import { lazy, Suspense } from 'react';

import { useOptionalCall } from './call-context';

const CallReviewView = lazy(() =>
  import('./call-review').then((module) => ({ default: module.CallReviewView })),
);

/**
 * Where a conversation shows the review of a call that just ended in it (design-spec §11): at the end of its
 * transcript, until the founder dismisses it, calls again or the call is forgotten. Loads with the call.
 */
export function CallReviewSlot({ sessionId }: { sessionId: string }) {
  const call = useOptionalCall();
  if (!call?.engine || call.quietEnd || call.route?.open === true) return null;
  const { snapshot } = call;
  if (snapshot.phase !== 'ended' || snapshot.sessionId !== sessionId || !snapshot.ended) return null;
  return (
    <Suspense fallback={null}>
      <CallReviewView />
    </Suspense>
  );
}
