import { randomUUID, timingSafeEqual } from 'node:crypto';

import { MEDIA_VENDORS, type EmbodimentProvider, type EnvLike } from '@foundry/core';

import {
  HeygenLiveAvatarFace,
  LIVEAVATAR_FULL_MAX_SECONDS,
  LIVEAVATAR_SANDBOX_AVATAR,
} from '../adapters/heygen-liveavatar.js';
import { type ApiConfig } from '../config.js';

/**
 * The vendor face on the LOCAL dev server (never deployed), for the conversation lab's `face` suite
 * (docs/runbooks/conversation-lab.md): the deployed API reads the HeyGen LiveAvatar key from Secrets Manager
 * (`foundry-ascent/media/heygen`), which the local server and the lab's AWS role cannot read. Here the key comes
 * from {@link LOCAL_FACE_KEY} instead, set by the lab on the dev server's process only:
 *
 * - only with `MEDIA_FACE_PROVIDER=heygen-liveavatar` (the same `MEDIA_FACE_*` variables as deployed choose the
 *   mode, stock avatar and voice) and only in development: `APP_ENV=production` refuses the variable at
 *   configuration already (config.ts), and anything but development refuses it here;
 * - only in the vendor's free sandbox (`MEDIA_FACE_SANDBOX=true`) and only for admins (`MEDIA_FACE_AUDIENCE=admins`):
 *   the key never buys billable minutes from a dev server, nor offers the face to every local founder;
 * - never together with the stand-in face (`EMBODIMENT_PROVIDER=fake`);
 * - the key is held in this closure, never logged, never returned, never put in an error.
 *
 * With {@link LAB_FACE_PROBE_TOKEN} (the lab's random per-run token), the server also answers the
 * lab's vendor probes under `/api/v1/_lab/face/` (see {@link LabFaceProbe}): checks the vendor must be asked
 * directly (its success code, credits, a raw sandbox room to command), with the key staying in this process.
 */

/** The local dev server's HeyGen LiveAvatar API key (development only; never read by a deployed API). */
export const LOCAL_FACE_KEY = 'LOCAL_MEDIA_FACE_API_KEY';
/** Enables the lab's vendor probes on the local dev server; requests carry it in {@link PROBE_HEADER}. */
export const LAB_FACE_PROBE_TOKEN = 'LAB_FACE_PROBE_TOKEN';
export const PROBE_HEADER = 'x-lab-probe-token';
/** Where the probes answer (under the API's own prefix, so the web preview's proxy reaches them too). */
export const PROBE_PREFIX = '/api/v1/_lab/face/';
/** Vendor calls remembered for the probe (method, path, status and the envelope's code only). */
const VENDOR_CALLS_KEPT = 200;
/** Raw probe sessions alive at once at most (each a free sandbox session of about a minute). */
const PROBE_SESSIONS_MAX = 4;
const HTTP_TIMEOUT_MS = 8_000;

/** One call to the vendor as the probe reports it: never a body, a header or a query string. */
export interface VendorCall {
  readonly at: string;
  readonly method: string;
  /** The path with session ids replaced by `{id}`. */
  readonly path: string;
  readonly status: number | null;
  /** The response envelope's `code` (the vendor's own success or error code), when it had one. */
  readonly code: number | null;
  readonly ms: number;
}

/** `/v1/sessions/<id>/transcript` → `/v1/sessions/{id}/transcript`; the query string is dropped. */
export function vendorPath(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return 'unparsable';
  }
  return path.replace(/^\/v1\/sessions\/(?!(?:token|start|stop|keep-alive)$)[^/]+/, '/v1/sessions/{id}');
}

/** A fetch that remembers each vendor call (method, path, status, envelope code), newest last. */
export function recordingFetch(
  inner: typeof fetch,
  calls: VendorCall[],
  now: () => number = Date.now,
): typeof fetch {
  return async (input, init) => {
    const started = now();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const remember = (status: number | null, code: number | null) => {
      calls.push({
        at: new Date(started).toISOString(),
        method,
        path: vendorPath(url),
        status,
        code,
        ms: Math.max(0, now() - started),
      });
      if (calls.length > VENDOR_CALLS_KEPT) calls.splice(0, calls.length - VENDOR_CALLS_KEPT);
    };
    let response: Response;
    try {
      response = await inner(input, init);
    } catch (err) {
      remember(null, null);
      throw err;
    }
    remember(response.status, await envelopeCode(response));
    return response;
  };
}

/** The `code` of a vendor response envelope (read from a copy, so the adapter still reads the body), or null. */
async function envelopeCode(response: Response): Promise<number | null> {
  try {
    const body = (await response.clone().json()) as { code?: unknown } | null;
    return typeof body?.code === 'number' && Number.isInteger(body.code) ? body.code : null;
  } catch {
    return null;
  }
}

/** The face and, when asked for, the lab's probe for the local dev server. */
export interface LocalFace {
  readonly embodiment?: EmbodimentProvider;
  readonly probe?: LabFaceProbe;
}

/**
 * The vendor face of the local dev server when {@link LOCAL_FACE_KEY} is set (see the module comment), else
 * nothing. Throws (the server does not start) on a key without the vendor face configured, the vendor face
 * without a key, the key outside development, the key with the stand-in face, or a face outside the sandbox or
 * offered to anyone but admins.
 */
export function localFaceFor(
  env: EnvLike,
  config: ApiConfig,
  options: { readonly fetch?: typeof fetch } = {},
): LocalFace {
  const key = env[LOCAL_FACE_KEY]?.trim() ?? '';
  const wired = config.media.face === 'heygen-liveavatar';
  if (key === '' && !wired) return {};
  if ((env.APP_ENV ?? '').trim() !== 'development' || config.appEnv !== 'development') {
    throw new Error(`${LOCAL_FACE_KEY} is for the local development server only`);
  }
  if (key === '') {
    // The local server never reads the platform's secrets.
    throw new Error(`MEDIA_FACE_PROVIDER=heygen-liveavatar on the local server needs ${LOCAL_FACE_KEY}`);
  }
  if (!wired) throw new Error(`${LOCAL_FACE_KEY} needs MEDIA_FACE_PROVIDER=heygen-liveavatar`);
  if ((env.EMBODIMENT_PROVIDER?.trim() ?? '') !== '') {
    throw new Error(`${LOCAL_FACE_KEY} cannot be combined with the stand-in face (EMBODIMENT_PROVIDER)`);
  }
  // The override exists for the lab, and all testing runs in the vendor's free sandbox, shown to admins only:
  // a dev server never spends the owner's credits, and never offers the face to every founder of the local stack.
  if (!config.media.faceSandbox) throw new Error(`${LOCAL_FACE_KEY} needs MEDIA_FACE_SANDBOX=true`);
  if (config.media.faceAudience !== 'admins') {
    throw new Error(`${LOCAL_FACE_KEY} needs MEDIA_FACE_AUDIENCE=admins`);
  }
  const calls: VendorCall[] = [];
  const inner = options.fetch ?? ((input, init) => fetch(input, init));
  const recorded = recordingFetch(inner, calls);
  const vendor = MEDIA_VENDORS.face.heygen;
  const apiKey = () => Promise.resolve(key);
  const full = config.media.faceMode === 'full';
  const embodiment = new HeygenLiveAvatarFace({
    apiKey,
    apiOrigin: vendor.apiOrigin,
    sandbox: config.media.faceSandbox,
    mode: config.media.faceMode,
    ...(config.media.faceStock === null ? {} : { stock: config.media.faceStock }),
    adminsOnly: true,
    usdPerMinute: full ? vendor.full.usdPerMinute : vendor.usdPerMinute,
    fetch: recorded,
  });
  const token = env[LAB_FACE_PROBE_TOKEN]?.trim() ?? '';
  if (token === '') return { embodiment };
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw new Error(`${LAB_FACE_PROBE_TOKEN} must be 32 to 128 URL-safe characters`);
  }
  return {
    embodiment,
    probe: new LabFaceProbe({ token, apiKey, apiOrigin: vendor.apiOrigin, fetch: recorded, calls }),
  };
}

interface ProbeSession {
  readonly face: HeygenLiveAvatarFace;
  readonly ref: string;
  readonly control: string | null;
}

/**
 * The lab's vendor probes on the local dev server (development only; enabled by {@link LAB_FACE_PROBE_TOKEN}):
 *
 *   GET  vendor-calls              the vendor calls this process made: method, path, status, envelope code
 *   GET  credits                   `GET /v1/users/credits`: the vendor's status and code and `credits_left`
 *   POST sessions                  a raw SANDBOX session ({mode: full|lite, maxSeconds}) for the lab's own page to
 *                                  command: the LiveKit URL and client token (never the LITE control channel)
 *   GET  sessions/:id/transcript   the vendor's transcript of a probe session (synthetic text the lab sent)
 *   POST sessions/:id/stop         stops a probe session
 *
 * A request without the token in {@link PROBE_HEADER} gets 404, as any unknown path. The key never leaves the
 * process; responses carry no header or body of the vendor's beyond the fields named.
 */
export class LabFaceProbe {
  readonly #token: Buffer;
  readonly #apiKey: () => Promise<string>;
  readonly #apiOrigin: string;
  readonly #fetch: typeof fetch;
  readonly #calls: VendorCall[];
  readonly #sessions = new Map<string, ProbeSession>();

  constructor(options: {
    readonly token: string;
    readonly apiKey: () => Promise<string>;
    readonly apiOrigin: string;
    readonly fetch: typeof fetch;
    readonly calls: VendorCall[];
  }) {
    this.#token = Buffer.from(options.token);
    this.#apiKey = options.apiKey;
    this.#apiOrigin = options.apiOrigin;
    this.#fetch = options.fetch;
    this.#calls = options.calls;
  }

  /** The probe's answer to `request`, or null when it is not a probe path (the app answers it). */
  handle(request: Request): Promise<Response> | null {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PROBE_PREFIX)) return null;
    if (!this.#authorized(request.headers.get(PROBE_HEADER))) return Promise.resolve(notFound());
    const route = url.pathname.slice(PROBE_PREFIX.length);
    return this.#route(request.method.toUpperCase(), route, request).catch((err: unknown) =>
      json(502, { error: err instanceof Error ? err.name : 'error' }),
    );
  }

  #authorized(given: string | null): boolean {
    if (given === null) return false;
    const candidate = Buffer.from(given);
    return candidate.length === this.#token.length && timingSafeEqual(candidate, this.#token);
  }

  async #route(method: string, route: string, request: Request): Promise<Response> {
    if (method === 'GET' && route === 'vendor-calls') return json(200, { items: [...this.#calls] });
    if (method === 'GET' && route === 'credits') return this.#credits();
    if (method === 'POST' && route === 'sessions') return this.#open(request);
    const match = /^sessions\/([A-Za-z0-9_-]{1,200})\/(transcript|stop)$/.exec(route);
    const session = match?.[1] === undefined ? undefined : this.#sessions.get(match[1]);
    if (match === null || session === undefined) return notFound();
    const handle = { sessionRef: session.ref, control: session.control, requestId: `lab-${randomUUID()}` };
    if (method === 'GET' && match[2] === 'transcript') {
      const read = await session.face.transcriptSince(handle, null);
      return json(200, { complete: read.complete, lines: read.lines });
    }
    if (method === 'POST' && match[2] === 'stop') {
      this.#sessions.delete(session.ref);
      await session.face.end(handle);
      return json(200, { stopped: true });
    }
    return notFound();
  }

  async #credits(): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiOrigin}/v1/users/credits`, {
        method: 'GET',
        headers: { accept: 'application/json', 'x-api-key': await this.#apiKey() },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      return json(200, { status: null, code: null, creditsLeft: null });
    }
    let body: { code?: unknown; data?: { credits_left?: unknown } | null } | null;
    try {
      body = (await response.json()) as typeof body;
    } catch {
      body = null;
    }
    const left = body?.data?.credits_left;
    return json(200, {
      status: response.status,
      code: typeof body?.code === 'number' ? body.code : null,
      // A number as the vendor writes it (a decimal string); anything else is not passed on.
      creditsLeft:
        typeof left === 'string' && /^[+-]?\d{0,12}(\.\d{0,6})?$/.test(left)
          ? left
          : typeof left === 'number' && Number.isFinite(left)
            ? String(left)
            : null,
    });
  }

  async #open(request: Request): Promise<Response> {
    let body: { mode?: unknown; maxSeconds?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json(400, { error: 'invalid_body' });
    }
    const mode = body.mode === 'lite' ? 'lite' : body.mode === 'full' ? 'full' : null;
    const maxSeconds = typeof body.maxSeconds === 'number' ? Math.floor(body.maxSeconds) : NaN;
    if (mode === null || !(maxSeconds >= 10 && maxSeconds <= Math.min(300, LIVEAVATAR_FULL_MAX_SECONDS))) {
      return json(400, { error: 'invalid_body' });
    }
    if (this.#sessions.size >= PROBE_SESSIONS_MAX) return json(429, { error: 'too_many_sessions' });
    // Always the free sandbox (the sandbox avatar, about a minute), whatever the app's face is configured as.
    const face = new HeygenLiveAvatarFace({
      apiKey: this.#apiKey,
      apiOrigin: this.#apiOrigin,
      sandbox: true,
      mode,
      ...(mode === 'full' ? { stock: { avatarId: LIVEAVATAR_SANDBOX_AVATAR, voiceId: null } } : {}),
      adminsOnly: true,
      usdPerMinute: 0,
      fetch: this.#fetch,
    });
    const started = await face.createSession({
      callId: randomUUID(),
      personaId: randomUUID(),
      avatarRef: LIVEAVATAR_SANDBOX_AVATAR,
      maxSeconds,
      requestId: `lab-${randomUUID()}`,
    });
    this.#sessions.set(started.sessionRef, { face, ref: started.sessionRef, control: started.control });
    return json(201, {
      sessionId: started.sessionRef,
      url: started.browser.url,
      token: started.browser.token,
      expiresAt: started.browser.expiresAt,
    });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function notFound(): Response {
  return json(404, { error: 'not_found' });
}
