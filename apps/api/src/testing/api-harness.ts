import { CSRF_HEADER, CSRF_HEADER_VALUE, IDEMPOTENCY_HEADER, SESSION_COOKIE } from '@foundry/contracts';
import { type Core } from '@foundry/core';
import { type CoreHarness, createCoreHarness, type CoreHarnessOptions } from '@foundry/core/testing';
import { type Db } from '@foundry/db';

import { type ApiApp, type AppDeps, createApp } from '../app.js';
import { UPLOAD_URL_TTL_SECONDS } from '../config.js';
import { createJsonLogger, type Logger } from '../logging.js';

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  /** JSON-serialised when not a string. */
  readonly body?: unknown;
  /** `fa_session` token or a full `fa_session=...` cookie. */
  readonly cookie?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string;
  /** Send the CSRF header on non-GET requests (default true). */
  readonly csrf?: boolean;
}

export interface ApiHarness {
  readonly h: CoreHarness;
  readonly app: ApiApp;
  /** Every JSON log line the app wrote. */
  readonly logs: string[];
  readonly logger: Logger;
  request(path: string, options?: RequestOptions): Promise<Response>;
  /** Issues an access code to the principal (as the owner) and signs in; returns the session token. */
  signInAs(principalId: string): Promise<string>;
  /** Session token of the seeded owner (platform admin + program lead). */
  ownerToken(): Promise<string>;
  /** Builds another app over the same harness (e.g. a failing database or other options). */
  appWith(overrides: Partial<AppDeps>): ApiApp;
  cleanup(): Promise<void>;
}

let ipCounter = 0;
/** A distinct documentation-range IP per sign-in, so lockout windows never interfere across tests. */
export function nextViewerIp(): string {
  ipCounter += 1;
  return `198.51.${String(Math.floor(ipCounter / 250) % 250)}.${String((ipCounter % 250) + 1)}`;
}

/** The `fa_session` value from a Set-Cookie header list. */
export function sessionTokenFrom(res: Response): string | null {
  for (const cookie of res.headers.getSetCookie()) {
    const match = new RegExp(`^${SESSION_COOKIE}=([^;]*)`).exec(cookie);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function buildRequest(path: string, options: RequestOptions = {}): Request {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const headers = new Headers(options.headers);
  if (options.cookie !== undefined) {
    headers.set(
      'cookie',
      options.cookie.includes('=') ? options.cookie : `${SESSION_COOKIE}=${options.cookie}`,
    );
  }
  if (method !== 'GET' && options.csrf !== false && !headers.has(CSRF_HEADER))
    headers.set(CSRF_HEADER, CSRF_HEADER_VALUE);
  if (options.idempotencyKey !== undefined) headers.set(IDEMPOTENCY_HEADER, options.idempotencyKey);
  let body: string | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  const url = path.startsWith('http')
    ? path
    : `http://localhost${path.startsWith('/api/') ? path : `/api/v1${path}`}`;
  return new Request(url, { method, headers, ...(body === undefined ? {} : { body }) });
}

/**
 * A seeded database (fresh per test file) + core with in-memory ports and the mock model + the Hono app,
 * plus helpers that sign in through the real endpoint.
 */
export async function createApiHarness(
  options: CoreHarnessOptions & { readonly app?: Partial<AppDeps> } = {},
): Promise<ApiHarness> {
  const h = await createCoreHarness({
    ...options,
    config: { ...options.config, uploads: { presignTtlSeconds: UPLOAD_URL_TTL_SECONDS } },
  });
  const logs: string[] = [];
  const logger = createJsonLogger({ level: 'debug', write: (line) => logs.push(line) });
  const base: AppDeps = {
    core: h.core,
    db: h.t.db,
    logger,
    appEnv: 'test',
    appVersion: 'test-version',
    ...options.app,
  };
  const app = createApp(base);
  const request = async (path: string, opts?: RequestOptions): Promise<Response> =>
    app.request(buildRequest(path, opts));
  let owner: string | null = null;

  const signIn = async (accessCode: string): Promise<string> => {
    const res = await request('/auth/sign-in', {
      body: { accessCode },
      headers: { 'x-fa-viewer-ip': nextViewerIp() },
    });
    const token = sessionTokenFrom(res);
    if (res.status !== 200 || token === null) throw new Error(`sign-in failed with ${String(res.status)}`);
    return token;
  };

  return {
    h,
    app,
    logs,
    logger,
    request,
    async signInAs(principalId) {
      const ownerCtx = await h.ctxFor(h.people.owner);
      const issued = await h.core.admin.issueAccessCode(ownerCtx, principalId, { label: 'test' });
      return signIn(issued.accessCode);
    },
    async ownerToken() {
      if (owner === null) {
        const code = h.t.ownerAccessCode;
        if (code === null) throw new Error('test database has no owner access code');
        owner = await signIn(code);
      }
      return owner;
    },
    appWith: (overrides) => createApp({ ...base, ...overrides }),
    cleanup: () => h.cleanup(),
  };
}

/** A Db facade whose calls fail with `error` while `failing()` is true (outage simulation). */
export function failingDb(db: Db, failing: () => boolean, error: () => Error): Db {
  return {
    driver: db.driver,
    withContext: (ctx, fn) => (failing() ? Promise.reject(error()) : db.withContext(ctx, fn)),
    system: (fn, opts) => (failing() ? Promise.reject(error()) : db.system(fn, opts)),
    ping: (opts) => (failing() ? Promise.reject(error()) : db.ping(opts)),
    close: () => db.close(),
  };
}

export type { Core };
