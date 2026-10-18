import { randomUUID } from 'node:crypto';

import {
  EmbodimentSessionError,
  type EmbodimentProvider,
  type FaceSessionHandle,
  type FaceSessionRequest,
  type StartedFaceSession,
  type VerifiedFaceAudio,
} from '@foundry/core';

import { type ApiKeySource } from './media-secrets.js';

/**
 * The vEIR's face through **HeyGen LiveAvatar in LITE ("avatar only") mode** (core `EmbodimentProvider` port;
 * docs/runbooks/avatars.md). Written from the vendor's API reference (docs.liveavatar.com, 2026-10-17) and the
 * behaviour of its web SDK 0.0.19; never called in CI (tests use recorded responses).
 *
 * - `createSession`: `POST /v1/sessions/token` with the API key (`X-API-KEY`; Secrets Manager
 *   `foundry-ascent/media/heygen`) for a LITE session of the persona's avatar, then `POST /v1/sessions/start` with
 *   that session token. The browser gets only `livekit_url` and `livekit_client_token` (it watches the room);
 *   `ws_url`, the channel that makes the face speak, stays on the server.
 * - `speak`: opens `ws_url`, sends the unit's PCM (16-bit mono 24 kHz, base64) as `agent.speak` events under one
 *   `event_id`, then `agent.speak_end` on the unit's last part, and closes. `interrupt` sends `agent.interrupt`.
 * - `keepAlive` / `end`: `POST /v1/sessions/keep-alive` and `/v1/sessions/stop` with the API key.
 *
 * Responses are `{code, data, message}`; `code` 1000 is success. Nothing here logs or returns the API key, the
 * session token or `ws_url` in an error message.
 */

/** LiveAvatar's success code in its response envelope. */
const SUCCESS_CODE = 1000;
/** Bytes per `agent.speak` event: 20 ms of 24 kHz 16-bit mono, as the vendor's SDK sends it. */
const SPEAK_CHUNK_BYTES = 960;
const HTTP_TIMEOUT_MS = 8_000;
const SOCKET_TIMEOUT_MS = 8_000;

/** The sandbox's only avatar (vendor docs, "Developing in Sandbox Mode"). */
export const LIVEAVATAR_SANDBOX_AVATAR = 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a';

/** The part of a WebSocket the adapter uses (Node's global WebSocket; injectable for tests). */
export interface FaceSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: 'open' | 'error' | 'close', listener: () => void): void;
}

export interface HeygenLiveAvatarOptions {
  readonly apiKey: ApiKeySource;
  /** `https://api.liveavatar.com` (packages/core/media-vendors.json). */
  readonly apiOrigin: string;
  /** Sandbox sessions: free, about a minute long, the sandbox avatar only (`MEDIA_FACE_SANDBOX`). */
  readonly sandbox: boolean;
  readonly usdPerMinute: number;
  readonly fetch?: typeof fetch;
  readonly openSocket?: (url: string) => FaceSocket;
  readonly ids?: () => string;
}

interface Envelope<T> {
  readonly code?: number;
  readonly data?: T | null;
  readonly message?: string;
}

interface TokenData {
  readonly session_id?: string;
  readonly session_token?: string;
}

interface StartData {
  readonly session_id?: string;
  readonly livekit_url?: string;
  readonly livekit_client_token?: string;
  readonly ws_url?: string;
  readonly max_session_duration?: number | null;
}

function failure(what: string, status?: number): EmbodimentSessionError {
  return new EmbodimentSessionError(
    status === undefined ? `liveavatar ${what}` : `liveavatar ${what} ${String(status)}`,
  );
}

export class HeygenLiveAvatarFace implements EmbodimentProvider {
  readonly id = 'heygen' as const;
  readonly voicing = 'audio' as const;
  readonly likeness = true;
  readonly usdPerMinute: number;
  readonly #options: HeygenLiveAvatarOptions;
  readonly #fetch: typeof fetch;
  readonly #openSocket: (url: string) => FaceSocket;
  readonly #ids: () => string;

  constructor(options: HeygenLiveAvatarOptions) {
    this.#options = options;
    this.usdPerMinute = options.usdPerMinute;
    this.#fetch = options.fetch ?? fetch;
    this.#openSocket = options.openSocket ?? ((url) => new WebSocket(url));
    this.#ids = options.ids ?? randomUUID;
  }

  async #post<T>(
    path: string,
    body: unknown,
    auth: { readonly apiKey?: string; readonly bearer?: string },
  ): Promise<{ readonly status: number; readonly envelope: Envelope<T> | null }> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#options.apiOrigin}${path}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(auth.apiKey === undefined ? {} : { 'x-api-key': auth.apiKey }),
          ...(auth.bearer === undefined ? {} : { authorization: `Bearer ${auth.bearer}` }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      throw failure(`${path} unreachable`);
    }
    let envelope: Envelope<T> | null;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch {
      envelope = null;
    }
    return { status: response.status, envelope };
  }

  async createSession(request: FaceSessionRequest): Promise<StartedFaceSession> {
    const apiKey = await this.#options.apiKey();
    const avatarId = this.#options.sandbox ? LIVEAVATAR_SANDBOX_AVATAR : request.avatarRef;
    if (avatarId === null) throw failure('needs an avatar');
    const base = {
      mode: 'LITE',
      avatar_id: avatarId,
      video_settings: { quality: 'high', encoding: 'H264' },
      ...(this.#options.sandbox ? { is_sandbox: true } : {}),
    };
    // The vendor session ends by itself at the call's (and the person's video minutes') limit.
    let token = await this.#post<TokenData>(
      '/v1/sessions/token',
      { ...base, max_session_duration: Math.max(1, Math.floor(request.maxSeconds)) },
      { apiKey },
    );
    if (token.status === 422) {
      // An API that does not take the limit here: the call's own heartbeat still ends the face at its limit.
      token = await this.#post<TokenData>('/v1/sessions/token', base, { apiKey });
    }
    const tokenData = token.envelope?.data;
    if (token.status >= 300 || token.envelope?.code !== SUCCESS_CODE || !tokenData?.session_token) {
      throw failure('token', token.status);
    }
    const started = await this.#post<StartData>('/v1/sessions/start', undefined, {
      bearer: tokenData.session_token,
    });
    const data = started.envelope?.data;
    if (
      started.status >= 300 ||
      started.envelope?.code !== SUCCESS_CODE ||
      !data?.session_id ||
      !data.livekit_url ||
      !data.livekit_client_token ||
      !data.ws_url
    ) {
      // A started session must not run unseen: stop it if it got that far.
      if (data?.session_id) await this.#stop(apiKey, data.session_id).catch(() => undefined);
      throw failure('start', started.status);
    }
    const seconds = Math.min(request.maxSeconds, data.max_session_duration ?? request.maxSeconds);
    return {
      browser: {
        token: data.livekit_client_token,
        url: data.livekit_url,
        expiresAt: new Date(Date.now() + Math.max(1, seconds) * 1000).toISOString(),
      },
      sessionRef: data.session_id,
      control: data.ws_url,
    };
  }

  /** Opens the control channel, runs `send`, waits for the bytes to leave, and closes it. */
  async #withControl(handle: FaceSessionHandle, send: (socket: FaceSocket) => void): Promise<void> {
    if (handle.control === null) throw failure('has no control channel');
    const socket = this.#openSocket(handle.control);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(failure('control channel timed out'));
        }, SOCKET_TIMEOUT_MS);
        socket.addEventListener('open', () => {
          clearTimeout(timer);
          resolve();
        });
        const lost = () => {
          clearTimeout(timer);
          reject(failure('control channel refused'));
        };
        socket.addEventListener('error', lost);
        socket.addEventListener('close', lost);
      });
      send(socket);
      // Wait until everything was handed to the network before closing (bounded).
      const deadline = Date.now() + SOCKET_TIMEOUT_MS;
      while (socket.bufferedAmount > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (socket.bufferedAmount > 0) throw failure('control channel stalled');
    } finally {
      try {
        socket.close(1000);
      } catch {
        /* already closed */
      }
    }
  }

  async speak(handle: FaceSessionHandle, audio: VerifiedFaceAudio): Promise<void> {
    const eventId = this.#ids();
    await this.#withControl(handle, (socket) => {
      for (let offset = 0; offset < audio.pcm.byteLength; offset += SPEAK_CHUNK_BYTES) {
        const chunk = audio.pcm.subarray(offset, Math.min(audio.pcm.byteLength, offset + SPEAK_CHUNK_BYTES));
        socket.send(
          JSON.stringify({
            type: 'agent.speak',
            event_id: eventId,
            audio: Buffer.from(chunk).toString('base64'),
          }),
        );
      }
      if (audio.last) socket.send(JSON.stringify({ type: 'agent.speak_end', event_id: eventId }));
    });
  }

  async interrupt(handle: FaceSessionHandle): Promise<void> {
    await this.#withControl(handle, (socket) => {
      socket.send(JSON.stringify({ type: 'agent.interrupt', event_id: this.#ids() }));
    });
  }

  async keepAlive(handle: FaceSessionHandle): Promise<void> {
    const apiKey = await this.#options.apiKey();
    const result = await this.#post('/v1/sessions/keep-alive', { session_id: handle.sessionRef }, { apiKey });
    if (result.status >= 300) throw failure('keep-alive', result.status);
  }

  async #stop(apiKey: string, sessionId: string): Promise<number> {
    const result = await this.#post(
      '/v1/sessions/stop',
      { session_id: sessionId, reason: 'USER_CLOSED' },
      { apiKey },
    );
    return result.status;
  }

  async end(handle: FaceSessionHandle): Promise<void> {
    const status = await this.#stop(await this.#options.apiKey(), handle.sessionRef);
    // A session the vendor already closed (it timed out, ran out of credits) is not an error.
    if (status >= 500) throw failure('stop', status);
  }
}
