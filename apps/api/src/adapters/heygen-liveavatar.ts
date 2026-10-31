import { randomUUID } from 'node:crypto';

import {
  EmbodimentSessionError,
  type EmbodimentProvider,
  type FaceSessionHandle,
  type FaceSessionRequest,
  type FaceTranscript,
  type FaceTranscriptLine,
  type StartedFaceSession,
  type VerifiedFaceAudio,
} from '@foundry/core';

import { type ApiKeySource } from './media-secrets.js';

/**
 * The vEIR's face through **HeyGen LiveAvatar**, in LITE ("avatar only") or FULL mode (core `EmbodimentProvider`
 * port; docs/runbooks/avatars.md). Written from the vendor's API reference (docs.liveavatar.com, 2026-10-17 and
 * 2026-10-31) and the behaviour of its web SDK 0.0.19; never called in CI (tests use recorded responses).
 *
 * **FULL** (a stock avatar with its stock voice, for the presentation; never the EIR's likeness): the token asks for
 * the configured stock avatar (`avatar_persona.voice_id`, or the avatar's default voice), with no `context_id`, so
 * the vendor's LLM never writes a word (restricted mode: the avatar only says text it is sent), `PUSH_TO_TALK`
 * that is never started (the vendor never listens), 720p H.264 and a session of at most 20 minutes (the Essential
 * plan's limit). FULL has no server-side control channel: the browser sends `avatar.speak_text` over the room with
 * the words of each unit the server admitted, and `transcriptSince` reads the vendor's transcript
 * (`GET /v1/sessions/{id}/transcript`) so the server can check the face said nothing else.
 *
 * **LITE**:
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
 * Responses are `{code, data, message}`. The success `code` is 1000 in the vendor's web SDK 0.0.19 and 100 in its
 * published OpenAPI document: both are taken, since a wrong guess would silently keep every call on the presence
 * (runbook §8.6 records the one a live start returns). Nothing here logs or returns the API key, the session
 * token or `ws_url` in an error message.
 */

/** LiveAvatar's success codes in its response envelope (web SDK 0.0.19: 1000; OpenAPI: 100). */
const SUCCESS_CODES: ReadonlySet<number> = new Set([100, 1000]);
/** The longest FULL session the Essential plan allows (20 minutes); the call's own limit is usually lower. */
export const LIVEAVATAR_FULL_MAX_SECONDS = 1200;
/** Transcript pages read per check at most (a 20-minute session has a few hundred lines). */
const TRANSCRIPT_PAGES = 10;
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
  /** `lite` (default): the EIR's avatar renders our audio. `full`: a stock avatar voices admitted text. */
  readonly mode?: 'lite' | 'full';
  /** FULL: the stock avatar (required outside the sandbox) and its voice (absent: the avatar's default voice). */
  readonly stock?: { readonly avatarId: string | null; readonly voiceId: string | null };
  /** Shown to platform admins only (`MEDIA_FACE_AUDIENCE=admins`). */
  readonly adminsOnly?: boolean;
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

interface TranscriptData {
  readonly session_active?: boolean;
  readonly next_timestamp?: number | null;
  readonly transcript_data?: readonly {
    readonly role?: unknown;
    readonly transcript?: unknown;
    readonly absolute_timestamp?: unknown;
  }[];
}

interface StartData {
  readonly session_id?: string;
  readonly livekit_url?: string;
  readonly livekit_client_token?: string;
  readonly ws_url?: string;
  readonly max_session_duration?: number | null;
}

/** Whether a response envelope reports success (either code the vendor uses). */
function succeeded(envelope: Envelope<unknown> | null): boolean {
  return typeof envelope?.code === 'number' && SUCCESS_CODES.has(envelope.code);
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
  readonly mode: 'lite' | 'full';
  readonly voicing: 'audio' | 'text';
  /** LITE draws the EIR (likeness consent); FULL a stock avatar (no one's likeness, labelled "AI avatar"). */
  readonly likeness: boolean;
  readonly stock: boolean;
  readonly sandbox: boolean;
  readonly adminsOnly: boolean;
  readonly usdPerMinute: number;
  readonly #options: HeygenLiveAvatarOptions;
  readonly #fetch: typeof fetch;
  readonly #openSocket: (url: string) => FaceSocket;
  readonly #ids: () => string;

  constructor(options: HeygenLiveAvatarOptions) {
    this.#options = options;
    this.mode = options.mode ?? 'lite';
    this.voicing = this.mode === 'full' ? 'text' : 'audio';
    this.likeness = this.mode === 'lite';
    this.stock = this.mode === 'full';
    this.sandbox = options.sandbox;
    this.adminsOnly = options.adminsOnly === true;
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

  /** The token request of a session (LITE: the persona's avatar; FULL: the stock avatar, restricted mode). */
  tokenBody(request: FaceSessionRequest): Record<string, unknown> {
    const full = this.mode === 'full';
    const avatarId = this.#options.sandbox
      ? LIVEAVATAR_SANDBOX_AVATAR
      : full
        ? (this.#options.stock?.avatarId ?? null)
        : request.avatarRef;
    if (avatarId === null) throw failure('needs an avatar');
    const seconds = Math.max(1, Math.floor(request.maxSeconds));
    const common = {
      avatar_id: avatarId,
      // 720p: higher resolutions add streaming latency (vendor docs).
      video_settings: { quality: 'high', encoding: 'H264' },
      ...(this.#options.sandbox ? { is_sandbox: true } : {}),
    };
    if (!full) return { mode: 'LITE', ...common, max_session_duration: seconds };
    const voiceId = this.#options.stock?.voiceId ?? null;
    return {
      mode: 'FULL',
      ...common,
      // No `context_id`: restricted mode, the vendor's LLM never answers; the avatar says only text it is sent.
      avatar_persona: { ...(voiceId === null ? {} : { voice_id: voiceId }), language: 'en' },
      // Push-to-talk that is never started: the vendor never listens (and no microphone is ever published).
      interactivity_type: 'PUSH_TO_TALK',
      max_session_duration: Math.min(LIVEAVATAR_FULL_MAX_SECONDS, seconds),
    };
  }

  async #get<T>(
    path: string,
    auth: { readonly apiKey: string },
  ): Promise<{ readonly status: number; readonly envelope: Envelope<T> | null }> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#options.apiOrigin}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json', 'x-api-key': auth.apiKey },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      throw failure('transcript unreachable');
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
    const body = this.tokenBody(request);
    const apiKey = await this.#options.apiKey();
    // The vendor session ends by itself at the call's (and the person's video minutes') limit. A vendor that
    // refuses the limit (422: above the plan's session length) starts nothing: the call keeps the presence.
    const token = await this.#post<TokenData>('/v1/sessions/token', body, { apiKey });
    const tokenData = token.envelope?.data;
    if (token.status >= 300 || !succeeded(token.envelope) || !tokenData?.session_token) {
      throw failure('token', token.status);
    }
    const started = await this.#post<StartData>('/v1/sessions/start', undefined, {
      bearer: tokenData.session_token,
    });
    const data = started.envelope?.data;
    // LITE needs its speak channel (`ws_url`); FULL has none (the browser commands the room).
    if (
      started.status >= 300 ||
      !succeeded(started.envelope) ||
      !data?.session_id ||
      !data.livekit_url ||
      !data.livekit_client_token ||
      (this.mode === 'lite' && !data.ws_url)
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
      control: this.mode === 'lite' ? (data.ws_url ?? null) : null,
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
    // FULL: the browser sends `avatar.interrupt` over the room; the server has no channel to the vendor.
    if (this.mode === 'full') return;
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

  /**
   * FULL: the session's transcript at the vendor, oldest first, from `since` (the vendor's timestamp, inclusive;
   * null: the whole session), following its `next_timestamp` for at most {@link TRANSCRIPT_PAGES} pages; `complete`
   * is false when the vendor still had more. A page repeats the lines at or after the timestamp it starts from, so
   * those are taken off it once each (by timestamp, role and words, counting repeats), never by timestamp alone:
   * two lines in the same second are both kept. Lines with an unknown role are skipped; the words are never logged
   * or put in an error.
   */
  async transcriptSince(handle: FaceSessionHandle, since: number | null): Promise<FaceTranscript> {
    const apiKey = await this.#options.apiKey();
    const lines: FaceTranscriptLine[] = [];
    let from = since;
    for (let page = 0; page < TRANSCRIPT_PAGES; page += 1) {
      const query = from === null ? '' : `?start_timestamp=${String(Math.floor(from))}`;
      const result = await this.#get<TranscriptData>(
        `/v1/sessions/${encodeURIComponent(handle.sessionRef)}/transcript${query}`,
        { apiKey },
      );
      if (
        result.status >= 300 ||
        !succeeded(result.envelope) ||
        !Array.isArray(result.envelope?.data?.transcript_data)
      ) {
        throw failure('transcript', result.status);
      }
      const data = result.envelope.data;
      const fresh = (data.transcript_data ?? []).flatMap((entry): FaceTranscriptLine[] => {
        const role = entry.role;
        if ((role !== 'avatar' && role !== 'user') || typeof entry.transcript !== 'string') return [];
        const at = typeof entry.absolute_timestamp === 'number' ? entry.absolute_timestamp : 0;
        // The vendor's query takes whole seconds: nothing before the cursor asked for.
        if (since !== null && at < since) return [];
        return [{ role, text: entry.transcript, at }];
      });
      const start = from;
      const added = withoutRepeats(fresh, start === null ? [] : lines.filter((line) => line.at >= start));
      lines.push(...added);
      const next = typeof data.next_timestamp === 'number' ? data.next_timestamp : null;
      // The end: nothing new, no next page, or a next page that starts where this one did (the vendor's last page
      // names its own last second). More lines in one second than a page holds could only be a flood, and the
      // check refuses its first page already (each admitted unit is said once).
      if (added.length === 0 || next === null || (from !== null && next <= from)) {
        return { lines, complete: true };
      }
      from = next;
    }
    return { lines, complete: false };
  }

  async end(handle: FaceSessionHandle): Promise<void> {
    const status = await this.#stop(await this.#options.apiKey(), handle.sessionRef);
    // A session the vendor already closed (it timed out, ran out of credits) is not an error.
    if (status >= 500) throw failure('stop', status);
  }
}

/**
 * The lines of a page that are not among `seen` (the lines already kept at or after the timestamp the page starts
 * from, which it repeats): each seen line takes off one equal line (timestamp, role and words), so repeats and
 * lines sharing a second are counted, not merged.
 */
function withoutRepeats(
  fresh: readonly FaceTranscriptLine[],
  seen: readonly FaceTranscriptLine[],
): FaceTranscriptLine[] {
  const key = (line: FaceTranscriptLine): string => JSON.stringify([line.at, line.role, line.text]);
  const left = new Map<string, number>();
  for (const line of seen) left.set(key(line), (left.get(key(line)) ?? 0) + 1);
  return fresh.filter((line) => {
    const n = left.get(key(line)) ?? 0;
    if (n === 0) return true;
    left.set(key(line), n - 1);
    return false;
  });
}
