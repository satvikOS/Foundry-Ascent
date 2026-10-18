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
 *   `foundry-ascent/media/heygen`) for a LITE session of the persona's avatar that ends by itself at the call's
 *   limit (`max_session_duration`; a vendor that refuses the limit gets no session at all, so nothing bills past
 *   it), then `POST /v1/sessions/start` with that session token. The browser gets only `livekit_url` and
 *   `livekit_client_token` (it watches the room); `ws_url`, the channel that makes the face speak, stays on the
 *   server.
 * - The control channel follows the vendor's LITE events (docs.liveavatar.com/docs/lite-mode/events, 2026-10-18):
 *   after the socket opens, nothing is sent until `session.state_updated` says `connected`; every command carries
 *   its own `event_id` and is acknowledged by an event whose `source_event_id` names it; an `error` event fails
 *   the command. `speak` sends a part of a unit's PCM (16-bit mono 24 kHz, base64) as one-second `agent.speak`
 *   chunks (the size the vendor recommends; the first chunk's id names the utterance), waits until the vendor
 *   took every chunk (`agent.audio_buffer_appended`), and on the unit's last part sends `agent.speak_end` and
 *   waits for `agent.audio_buffer_committed` before closing. `interrupt` sends `agent.interrupt` and waits for
 *   `agent.audio_buffer_cleared`.
 * - `keepAlive` / `end`: `POST /v1/sessions/keep-alive` and `/v1/sessions/stop` with the API key (no socket, so
 *   they never replace a speak in progress: the vendor allows one socket per session).
 *
 * Responses are `{code, data, message}`; `code` 1000 is success. Nothing here logs or returns the API key, the
 * session token or `ws_url` in an error message.
 */

/** LiveAvatar's success code in its response envelope (the vendor's web SDK 0.0.19 checks the same). */
const SUCCESS_CODE = 1000;
/**
 * Bytes per `agent.speak` event: one second of 24 kHz 16-bit mono, the chunk the vendor recommends (its web SDK
 * 0.0.19 sends 400 ms, then 1 s). A face-audio part is whole seconds already, so each chunk is one manifest chunk.
 */
const SPEAK_CHUNK_BYTES = 48_000;
const HTTP_TIMEOUT_MS = 8_000;
/** From opening the socket to the vendor's `connected`. */
const CONNECT_TIMEOUT_MS = 8_000;
/** From the last command sent to its acknowledgement. */
const ACK_TIMEOUT_MS = 8_000;

/** The sandbox's only avatar (vendor docs, "Developing in Sandbox Mode"). */
export const LIVEAVATAR_SANDBOX_AVATAR = 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a';

/** The part of a WebSocket the adapter uses (Node's global WebSocket; injectable for tests). */
export interface FaceSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: 'open' | 'error' | 'close', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
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
  /** Control-channel waits (tests shorten them). */
  readonly timeouts?: { readonly connectMs?: number; readonly ackMs?: number };
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

/** A server event on the control channel (only the fields the adapter reads). */
interface ControlEvent {
  readonly type?: unknown;
  readonly source_event_id?: unknown;
  readonly state?: unknown;
  readonly error?: { readonly type?: unknown; readonly event_id?: unknown } | null;
}

/** The vendor's error type, when it is a plain identifier (never its message, which may echo anything). */
function errorType(event: ControlEvent): string {
  const type = event.error?.type;
  return typeof type === 'string' && /^[a-z][a-z_]{0,39}$/.test(type) ? type : 'error';
}

/**
 * One open control channel: commands sent after the vendor said `connected`, each awaited by its
 * acknowledgement. Any `error` event (other than a video-starvation diagnostic), a `disconnected` state or the
 * socket closing fails what is still awaited.
 */
class ControlChannel {
  readonly #socket: FaceSocket;
  readonly #ids: () => string;
  readonly #ackMs: number;
  #connected = false;
  #failed: EmbodimentSessionError | null = null;
  readonly #acked = new Set<string>();
  #wake: (() => void) | null = null;

  constructor(socket: FaceSocket, ids: () => string, ackMs: number) {
    this.#socket = socket;
    this.#ids = ids;
    this.#ackMs = ackMs;
    socket.addEventListener('message', (message) => {
      this.#receive(message.data);
    });
    socket.addEventListener('error', () => {
      this.#fail(failure('control channel lost'));
    });
    socket.addEventListener('close', () => {
      this.#fail(failure('control channel lost'));
    });
  }

  #receive(data: unknown): void {
    if (typeof data !== 'string') return;
    let event: ControlEvent;
    try {
      event = JSON.parse(data) as ControlEvent;
    } catch {
      return;
    }
    if (event.type === 'session.state_updated') {
      if (event.state === 'connected') this.#connected = true;
      if (event.state === 'disconnected') this.#fail(failure('control channel lost'));
    } else if (event.type === 'error') {
      // Video starvation is a frame-gap diagnostic: the audio was taken.
      if (errorType(event) !== 'video_starvation') this.#fail(failure(`control ${errorType(event)}`));
    } else if (typeof event.source_event_id === 'string') {
      this.#acked.add(event.source_event_id);
    }
    this.#wake?.();
  }

  #fail(error: EmbodimentSessionError): void {
    this.#failed ??= error;
    this.#wake?.();
  }

  /** Resolves once `done()` holds, rejects on a failure or after `ms`. */
  async #until(done: () => boolean, ms: number, timeout: string): Promise<void> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (this.#failed !== null) throw this.#failed;
      if (done()) return;
      const left = deadline - Date.now();
      if (left <= 0) throw failure(timeout);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#wake = null;
    }
  }

  /** Waits for the vendor's `connected` (nothing may be sent before it). */
  connected(ms: number): Promise<void> {
    return this.#until(() => this.#connected, ms, 'control channel not connected');
  }

  /** Sends a command with its own event id and returns the id (its acknowledgement names it). */
  send(command: Record<string, unknown>): string {
    if (this.#failed !== null) throw this.#failed;
    const eventId = this.#ids();
    this.#socket.send(JSON.stringify({ ...command, event_id: eventId }));
    return eventId;
  }

  /** Waits until every one of `eventIds` was acknowledged. */
  acknowledged(eventIds: readonly string[]): Promise<void> {
    return this.#until(
      () => eventIds.every((id) => this.#acked.has(id)),
      this.#ackMs,
      'control channel timed out',
    );
  }
}

export class HeygenLiveAvatarFace implements EmbodimentProvider {
  readonly id = 'heygen' as const;
  readonly voicing = 'audio' as const;
  readonly likeness = true;
  readonly sandbox: boolean;
  readonly usdPerMinute: number;
  readonly #options: HeygenLiveAvatarOptions;
  readonly #fetch: typeof fetch;
  readonly #openSocket: (url: string) => FaceSocket;
  readonly #ids: () => string;

  constructor(options: HeygenLiveAvatarOptions) {
    this.#options = options;
    this.sandbox = options.sandbox;
    this.usdPerMinute = options.usdPerMinute;
    // Bound, so the global fetch never runs with this adapter as its receiver.
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
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
    // The vendor session ends by itself at the call's (and the person's video minutes') limit. A vendor that
    // refuses the limit (422: above the plan's session length) starts nothing: the call keeps the presence.
    const token = await this.#post<TokenData>(
      '/v1/sessions/token',
      { ...base, max_session_duration: Math.max(1, Math.floor(request.maxSeconds)) },
      { apiKey },
    );
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

  /**
   * Opens the control channel, waits until it opened and the vendor reported the session `connected`, runs
   * `use` (which waits for its own acknowledgements), and closes it.
   */
  async #withControl(
    handle: FaceSessionHandle,
    use: (channel: ControlChannel) => Promise<void>,
  ): Promise<void> {
    if (handle.control === null) throw failure('has no control channel');
    const connectMs = this.#options.timeouts?.connectMs ?? CONNECT_TIMEOUT_MS;
    const socket = this.#openSocket(handle.control);
    const channel = new ControlChannel(socket, this.#ids, this.#options.timeouts?.ackMs ?? ACK_TIMEOUT_MS);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(failure('control channel not connected'));
        }, connectMs);
        socket.addEventListener('open', () => {
          clearTimeout(timer);
          resolve();
        });
        const refused = () => {
          clearTimeout(timer);
          reject(failure('control channel refused'));
        };
        socket.addEventListener('error', refused);
        socket.addEventListener('close', refused);
      });
      await channel.connected(connectMs);
      await use(channel);
    } finally {
      try {
        socket.close(1000);
      } catch {
        /* already closed */
      }
    }
  }

  async speak(handle: FaceSessionHandle, audio: VerifiedFaceAudio): Promise<void> {
    await this.#withControl(handle, async (channel) => {
      const sent: string[] = [];
      for (let offset = 0; offset < audio.pcm.byteLength; offset += SPEAK_CHUNK_BYTES) {
        const chunk = audio.pcm.subarray(offset, Math.min(audio.pcm.byteLength, offset + SPEAK_CHUNK_BYTES));
        sent.push(channel.send({ type: 'agent.speak', audio: Buffer.from(chunk).toString('base64') }));
      }
      // The utterance stays open between parts; the unit's last part seals it, and the socket closes only once
      // the vendor took all of it.
      if (audio.last) sent.push(channel.send({ type: 'agent.speak_end' }));
      await channel.acknowledged(sent);
    });
  }

  async interrupt(handle: FaceSessionHandle): Promise<void> {
    await this.#withControl(handle, async (channel) => {
      await channel.acknowledged([channel.send({ type: 'agent.interrupt' })]);
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
