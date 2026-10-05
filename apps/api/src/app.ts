import { type Core } from '@foundry/core';
import { type Db } from '@foundry/db';
import { Hono } from 'hono';

import { type LocalUploadTarget } from './adapters/local-object-store.js';
import { MAX_JSON_BODY_BYTES } from './config.js';
import { SSE_KEEP_ALIVE_MS } from './lambda-contract.js';
import { createDbIdempotencyStore, type IdempotencyStore } from './http/idempotency.js';
import { bodyReader, csrfGuard, errorHandler, requestContext } from './http/middleware.js';
import { httpError, problemResponse } from './http/problem.js';
import { RouteBuilder } from './http/router.js';
import { type AppEnv, type RouteInfo } from './http/types.js';
import { type Logger } from './logging.js';
import { registerLocalUploadRoutes } from './routes/local-uploads.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerStudioRoutes } from './routes/studio.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerVentureRoutes } from './routes/ventures.js';
import { type DbStateSource } from './runtime/db-observer.js';
import { type InflightTracker } from './runtime/inflight.js';

export interface HttpOptions {
  /** Largest JSON body (1 MiB). */
  readonly maxBodyBytes: number;
  /**
   * SSE keep-alive comment interval (15 s, lambda-contract.json): well under CloudFront's 60 s origin read
   * timeout, so a turn waiting on the model never looks idle to the edge.
   */
  readonly sseKeepAliveMs: number;
  /** A stalled SSE write longer than this ends the stream and cancels the turn (10 s). */
  readonly sseWriteTimeoutMs: number;
  /** Turn budget outside Lambda (Lambda uses its remaining time). */
  readonly turnTimeoutMs: number;
  /** Health probe bound. */
  readonly healthTimeoutMs: number;
}

export const DEFAULT_HTTP_OPTIONS: HttpOptions = {
  maxBodyBytes: MAX_JSON_BODY_BYTES,
  sseKeepAliveMs: SSE_KEEP_ALIVE_MS,
  sseWriteTimeoutMs: 10_000,
  turnTimeoutMs: 55_000,
  healthTimeoutMs: 3_000,
};

export interface AppDeps {
  readonly core: Core;
  /** Admin health probe and idempotency records (owner role). */
  readonly db: Pick<Db, 'ping' | 'system'>;
  /** Database state observed by this instance's own calls (public /health); omitted → no `db` field. */
  readonly dbState?: DbStateSource;
  readonly logger: Logger;
  readonly appEnv: 'production' | 'development' | 'test';
  readonly appVersion: string;
  /** Defaults to the `idempotency_keys` store on `db`. */
  readonly idempotency?: IdempotencyStore;
  /** Lambda: background work drained before the invocation returns. */
  readonly inflight?: InflightTracker;
  /** DEVELOPMENT ONLY: local stand-in for S3 presigned uploads. Refused in any other environment. */
  readonly localUploads?: LocalUploadTarget;
  readonly http?: Partial<HttpOptions>;
  readonly now?: () => Date;
}

export type ApiApp = Hono<AppEnv> & {
  /** Every registered endpoint with its auth and idempotency policy (relative to /api/v1). */
  readonly routeTable: readonly RouteInfo[];
};

/**
 * The Foundry Ascent HTTP API (system design §6), mounted at `/api/v1`. Middleware order: request id +
 * access log + security headers → CSRF header → bounded body read (+ x-amz-content-sha256 check) → per
 * route: session cookie → Idempotency-Key → handler. Errors become RFC 9457 problem+json.
 */
export function createApp(deps: AppDeps): ApiApp {
  if (deps.localUploads !== undefined && deps.appEnv !== 'development') {
    throw new Error('Local uploads can only be mounted when APP_ENV=development');
  }
  const http: HttpOptions = { ...DEFAULT_HTTP_OPTIONS, ...deps.http };
  const now = deps.now ?? (() => new Date());
  const idempotencyStore = deps.idempotency ?? createDbIdempotencyStore(deps.db);
  const app = new Hono<AppEnv>();

  app.use('*', requestContext({ logger: deps.logger }));
  app.use('*', csrfGuard());
  app.use('*', bodyReader(http.maxBodyBytes));
  app.onError(errorHandler(deps.logger));
  // `requestContext` matches '*', so the request id is set before this runs.
  app.notFound((c) => problemResponse(c, httpError.notFound('No such endpoint')));

  const routes = new RouteBuilder(app, {
    auth: deps.core.auth,
    idempotency: idempotencyStore,
    logger: deps.logger,
  });
  registerSystemRoutes(routes, {
    core: deps.core,
    db: deps.db,
    dbState: deps.dbState,
    logger: deps.logger,
    appEnv: deps.appEnv,
    appVersion: deps.appVersion,
    healthTimeoutMs: http.healthTimeoutMs,
    now,
  });
  registerVentureRoutes(routes, deps.core);
  registerSessionRoutes(routes, deps.core, {
    idempotency: idempotencyStore,
    logger: deps.logger,
    inflight: deps.inflight,
    keepAliveMs: http.sseKeepAliveMs,
    writeTimeoutMs: http.sseWriteTimeoutMs,
    turnTimeoutMs: http.turnTimeoutMs,
  });
  registerStudioRoutes(routes, deps.core);
  if (deps.localUploads !== undefined) registerLocalUploadRoutes(routes, deps.localUploads);

  return Object.assign(app, { routeTable: [...routes.routes] as readonly RouteInfo[] });
}
