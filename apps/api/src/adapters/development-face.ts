import { randomBytes } from 'node:crypto';

import {
  type EmbodimentSessionIssuer,
  type EmbodimentSessionRequest,
  type EnvLike,
  type IssuedEmbodimentSession,
} from '@foundry/core';

/** A stand-in token opens a (fake) session for at most this long, like a vendor's short-lived token. */
const TOKEN_SECONDS = 60;

/**
 * The development stand-in for a vendor face (docs/architecture/calls.md §4): it mints a random `fake.` token
 * the call screen's canvas face accepts, so the whole seam (call settings → avatar session → the browser
 * adapter → the video tile → the call's own audio rendered by the face) runs without a vendor account. It
 * draws no one's likeness, so it serves every persona, and no key or network is involved.
 */
export class DevelopmentFaceIssuer implements EmbodimentSessionIssuer {
  readonly provider = 'fake' as const;
  readonly voicing = 'audio' as const;
  readonly likeness = false;

  start(request: EmbodimentSessionRequest): Promise<IssuedEmbodimentSession> {
    const seconds = Math.max(1, Math.min(TOKEN_SECONDS, request.maxSeconds));
    return Promise.resolve({
      token: `fake.${randomBytes(18).toString('base64url')}`,
      expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
    });
  }
}

/**
 * `EMBODIMENT_PROVIDER=fake` on the local API (dev-server) gives every call the stand-in face. Anything else
 * is refused at start-up: an unknown provider, or the stand-in outside development, where a real vendor
 * adapter takes its place.
 */
export function developmentFaceFor(env: EnvLike): { embodiment?: EmbodimentSessionIssuer } {
  const wanted = env.EMBODIMENT_PROVIDER?.trim().toLowerCase() ?? '';
  if (wanted === '') return {};
  if (wanted !== 'fake') throw new Error('EMBODIMENT_PROVIDER must be "fake" (the development stand-in)');
  if (env.APP_ENV !== 'development') {
    throw new Error('EMBODIMENT_PROVIDER=fake is for local development only');
  }
  return { embodiment: new DevelopmentFaceIssuer() };
}
