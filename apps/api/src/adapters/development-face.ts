import { randomBytes } from 'node:crypto';

import {
  type EmbodimentProvider,
  type EnvLike,
  type FaceSessionHandle,
  type FaceSessionRequest,
  type FaceTranscript,
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
 *
 * In `full` mode (`MEDIA_FACE_MODE=full`) it stands in for a FULL stock face: voicing `text`, labelled as an AI
 * avatar, each unit admitted through `POST /calls/:id/face/say` before the browser's in-page room "says" it
 * silently. It keeps no transcript (nothing to reconcile), and `MEDIA_FACE_AUDIENCE=admins` makes it admins-only.
 *
 * With `MEDIA_FACE_LITE_ROUTE=browser` (LITE only) it stands in for a LITE stock face the page feeds: labelled as an
 * AI avatar, units admitted as the server signs them (or through `face/say`), and a `controlUrl` the browser's
 * stand-in opens in the page (an in-page speak channel that answers like the vendor's; nothing reaches the network:
 * the `.invalid` host can never resolve).
 */
export class DevelopmentFace implements EmbodimentProvider {
  readonly id = 'fake' as const;
  readonly mode: 'lite' | 'full';
  readonly voicing: 'audio' | 'text';
  readonly liteRoute: 'server' | 'browser';
  readonly likeness = false;
  readonly stock: boolean;
  readonly adminsOnly: boolean;
  readonly usdPerMinute = 0;

  constructor(
    options: {
      readonly mode?: 'lite' | 'full';
      readonly adminsOnly?: boolean;
      readonly liteRoute?: 'server' | 'browser';
    } = {},
  ) {
    this.mode = options.mode ?? 'lite';
    this.voicing = this.mode === 'full' ? 'text' : 'audio';
    this.liteRoute = this.mode === 'lite' ? (options.liteRoute ?? 'server') : 'server';
    this.stock = this.mode === 'full' || this.liteRoute === 'browser';
    this.adminsOnly = options.adminsOnly === true;
  }

  createSession(request: FaceSessionRequest): Promise<StartedFaceSession> {
    const seconds = Math.max(1, Math.min(TOKEN_SECONDS, request.maxSeconds));
    return Promise.resolve({
      browser: {
        token: `fake.${randomBytes(18).toString('base64url')}`,
        url: null,
        expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
        ...(this.liteRoute === 'browser'
          ? { controlUrl: `wss://lite.stand-in.invalid/${randomBytes(12).toString('base64url')}` }
          : {}),
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

  /** The stand-in keeps no transcript: there is never anything to reconcile. */
  transcriptSince(_session: FaceSessionHandle, _since: number | null): Promise<FaceTranscript> {
    return Promise.resolve({ lines: [], complete: true });
  }
}

/**
 * `EMBODIMENT_PROVIDER=fake` on the local API (dev-server) gives calls the stand-in face once faces are switched
 * on (Admin › Settings), in `MEDIA_FACE_MODE` (`lite` by default, or `full`) for `MEDIA_FACE_AUDIENCE` (everyone by
 * default, or `admins`). Anything else is refused at start-up: an unknown provider, mode or audience, or the
 * stand-in outside development, where a real vendor adapter takes its place.
 */
export function developmentFaceFor(env: EnvLike): { embodiment?: EmbodimentProvider } {
  const wanted = env.EMBODIMENT_PROVIDER?.trim().toLowerCase() ?? '';
  if (wanted === '') return {};
  if (wanted !== 'fake') throw new Error('EMBODIMENT_PROVIDER must be "fake" (the development stand-in)');
  if (env.APP_ENV !== 'development') {
    throw new Error('EMBODIMENT_PROVIDER=fake is for local development only');
  }
  const wantedMode = env.MEDIA_FACE_MODE?.trim().toLowerCase() ?? '';
  const mode = wantedMode === '' ? 'lite' : wantedMode;
  if (mode !== 'lite' && mode !== 'full') throw new Error('MEDIA_FACE_MODE must be "lite" or "full"');
  const wantedAudience = env.MEDIA_FACE_AUDIENCE?.trim().toLowerCase() ?? '';
  const audience = wantedAudience === '' ? 'everyone' : wantedAudience;
  if (audience !== 'admins' && audience !== 'everyone') {
    throw new Error('MEDIA_FACE_AUDIENCE must be "admins" or "everyone"');
  }
  const wantedRoute = env.MEDIA_FACE_LITE_ROUTE?.trim().toLowerCase() ?? '';
  const liteRoute = wantedRoute === '' ? 'server' : wantedRoute;
  if (liteRoute !== 'server' && liteRoute !== 'browser') {
    throw new Error('MEDIA_FACE_LITE_ROUTE must be "server" or "browser"');
  }
  if (liteRoute === 'browser' && mode !== 'lite')
    throw new Error('MEDIA_FACE_LITE_ROUTE=browser is LITE only');
  return { embodiment: new DevelopmentFace({ mode, adminsOnly: audience === 'admins', liteRoute }) };
}
