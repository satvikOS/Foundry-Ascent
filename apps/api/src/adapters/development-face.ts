import { randomBytes } from 'node:crypto';

import {
  type EmbodimentProvider,
  type EnvLike,
  type FaceSessionRequest,
  type StartedFaceSession,
} from '@foundry/core';

/** A stand-in token opens a (fake) session for at most this long, like a vendor's short-lived token. */
const TOKEN_SECONDS = 60;

/**
 * The development stand-in for a vendor face (docs/architecture/calls.md §4): it opens a pretend session whose
 * random `fake.` token the call screen's canvas face accepts, so the whole seam (faces switched on → call settings →
 * avatar session → the browser adapter → the video tile → verified audio handed back through
 * `POST /calls/:id/face/speak` → the face) runs without a vendor account. It draws no one's likeness, so it serves
 * every persona; no key, no network and no control channel are involved, and speaking does nothing (the canvas
 * face plays the audio itself once the server accepted it).
 */
export class DevelopmentFace implements EmbodimentProvider {
  readonly id = 'fake' as const;
  readonly voicing = 'audio' as const;
  readonly likeness = false;
  readonly usdPerMinute = 0;

  createSession(request: FaceSessionRequest): Promise<StartedFaceSession> {
    const seconds = Math.max(1, Math.min(TOKEN_SECONDS, request.maxSeconds));
    return Promise.resolve({
      browser: {
        token: `fake.${randomBytes(18).toString('base64url')}`,
        url: null,
        expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
      },
      sessionRef: `dev-${randomBytes(9).toString('base64url')}`,
      control: null,
    });
  }

  speak(): Promise<void> {
    return Promise.resolve();
  }

  interrupt(): Promise<void> {
    return Promise.resolve();
  }

  keepAlive(): Promise<void> {
    return Promise.resolve();
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * `EMBODIMENT_PROVIDER=fake` on the local API (dev-server) gives calls the stand-in face once faces are switched
 * on (Admin › Settings). Anything else is refused at start-up: an unknown provider, or the stand-in outside
 * development, where a real vendor adapter takes its place.
 */
export function developmentFaceFor(env: EnvLike): { embodiment?: EmbodimentProvider } {
  const wanted = env.EMBODIMENT_PROVIDER?.trim().toLowerCase() ?? '';
  if (wanted === '') return {};
  if (wanted !== 'fake') throw new Error('EMBODIMENT_PROVIDER must be "fake" (the development stand-in)');
  if (env.APP_ENV !== 'development') {
    throw new Error('EMBODIMENT_PROVIDER=fake is for local development only');
  }
  return { embodiment: new DevelopmentFace() };
}
