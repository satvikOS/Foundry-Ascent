import { API_PREFIX } from '@foundry/contracts';
import { type AuthService, DomainError, type SessionContext } from '@foundry/core';
import { type Hono, type MiddlewareHandler } from 'hono';
import { type H } from 'hono/types';

import { type Logger } from '../logging.js';
import { idempotency, type IdempotencyStore } from './idempotency.js';
import { requireSession } from './middleware.js';
import {
  type AppContext,
  type AppEnv,
  type HttpMethod,
  type IdempotencyMode,
  type RouteInfo,
} from './types.js';

export type SessionHandler = (c: AppContext, ctx: SessionContext) => Promise<Response>;
export type PublicHandler = (c: AppContext) => Promise<Response>;

/** The verified session of the request (set by `requireSession`). */
export function sessionOf(c: AppContext): SessionContext {
  const session = c.get('session');
  if (session === undefined) {
    throw new DomainError('unauthenticated', 'Please sign in.', { reason: 'no_session' });
  }
  return session;
}

export interface RouteBuilderDeps {
  readonly auth: Pick<AuthService, 'verifySession'>;
  readonly idempotency: IdempotencyStore;
  readonly logger: Logger;
}

/**
 * Registers routes under `/api/v1` and records each one's auth and idempotency policy, so the table is
 * documented and tested (every non-public route rejects anonymous requests).
 */
export class RouteBuilder {
  readonly #app: Hono<AppEnv>;
  readonly #deps: RouteBuilderDeps;
  readonly #session: MiddlewareHandler<AppEnv>;
  readonly routes: RouteInfo[] = [];

  constructor(app: Hono<AppEnv>, deps: RouteBuilderDeps) {
    this.#app = app;
    this.#deps = deps;
    this.#session = requireSession(deps.auth);
  }

  /** Anonymous route (health, sign-in, sign-out, local uploads). */
  public(
    method: HttpMethod | 'OPTIONS',
    path: string,
    handler: PublicHandler,
    options: { readonly developmentOnly?: boolean } = {},
  ): void {
    if (method !== 'OPTIONS') {
      this.routes.push({
        method,
        path,
        auth: 'public',
        idempotency: 'none',
        ...(options.developmentOnly ? { developmentOnly: true } : {}),
      });
    }
    this.#app.on(method, `${API_PREFIX}${path}`, (c) => handler(c));
  }

  /**
   * Authenticated route. Writes default to `standard` idempotency; `turn` routes handle the key
   * themselves (SSE).
   */
  session(
    method: HttpMethod,
    path: string,
    handler: SessionHandler,
    options: { readonly idempotency?: IdempotencyMode } = {},
  ): void {
    const mode = options.idempotency ?? (method === 'GET' ? 'none' : 'standard');
    this.routes.push({ method, path, auth: 'session', idempotency: mode });
    const handlers: [H<AppEnv>, ...H<AppEnv>[]] = [this.#session];
    if (mode === 'standard' || mode === 'secret') {
      handlers.push(idempotency(this.#deps.idempotency, mode, this.#deps.logger));
    }
    handlers.push((c: AppContext) => handler(c, sessionOf(c)));
    this.#app.on(method, `${API_PREFIX}${path}`, ...handlers);
  }

  get(path: string, handler: SessionHandler): void {
    this.session('GET', path, handler);
  }

  post(path: string, handler: SessionHandler, options?: { readonly idempotency?: IdempotencyMode }): void {
    this.session('POST', path, handler, options);
  }

  patch(path: string, handler: SessionHandler): void {
    this.session('PATCH', path, handler);
  }

  delete(path: string, handler: SessionHandler): void {
    this.session('DELETE', path, handler);
  }
}
