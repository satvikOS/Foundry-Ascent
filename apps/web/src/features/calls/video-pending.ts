import type { CallFace, CallFaceController } from './use-call-face';
import type { CallVeir } from './use-call-veir';

/** A video call's face that is not shown: joining, being replaced, paused with the call, or not available now. */
export type VideoPending = 'connecting' | 'reconnecting' | 'paused' | 'unavailable';

/** What a video call's tile (and its status line) says while its face is not shown (`name`: the vEIR's). */
export function videoPendingText(pending: VideoPending, name: string): string {
  switch (pending) {
    case 'connecting':
      return `Connecting to ${name}…`;
    case 'reconnecting':
      return 'Reconnecting…';
    case 'paused':
      return 'Video paused';
    case 'unavailable':
      return 'Video isn’t available right now';
  }
}

/**
 * A video call's face that is not shown (null when it is shown, or on a voice call, or with no vendor face to ask
 * for): `connecting` until the face first shows (the conversation waits for it), `reconnecting` while a new vendor
 * session replaces one that ended, `paused` while the call is on hold, `unavailable` when it could not start or come
 * back (the call screen offers the voice call). A call (`callId`) that may not ask for a face any more (a crisis turn,
 * the server stopped it) and has none is `unavailable`, never "connecting" to a face that is not coming.
 */
export function videoPending(
  wantsVideo: boolean,
  controller: CallFaceController | null,
  provider: CallVeir['provider'],
  face: CallFace,
  callId: string | null = null,
): VideoPending | null {
  if (!wantsVideo || controller === null || provider === 'builtin') return null;
  switch (face.status) {
    case 'live':
      return null;
    case 'presence':
      return callId !== null && !controller.canAsk(callId) ? 'unavailable' : 'connecting';
    case 'connecting':
      return 'connecting';
    case 'reconnecting':
    case 'paused':
    case 'unavailable':
      return face.status;
  }
}
