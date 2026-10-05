import { type SessionContext } from '@foundry/core';
import { type Context } from 'hono';

/** Per-request values set by the middleware chain. */
export interface AppVariables {
  /** Correlation id (accepted from `x-request-id` when well-formed, otherwise generated). */
  requestId: string;
  /** Verified session (set by `requireSession`; absent on public routes). */
  session: SessionContext | undefined;
  /** Exact request body bytes of non-GET requests (read once, hashed, parsed). */
  rawBody: Uint8Array | undefined;
  /** Error code of the problem response, for the request log line. */
  errorCode: string | undefined;
}

export interface AppEnv {
  Variables: AppVariables;
}

export type AppContext = Context<AppEnv>;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** How a route treats `Idempotency-Key` (system design §3: every write honours it). */
export type IdempotencyMode =
  /** Not applicable (reads, public routes, sign-out). */
  | 'none'
  /** Store the response for 24 h and replay it for retries with the same key and body. */
  | 'standard'
  /**
   * The response contains a one-time secret (plaintext access code). Only a redacted marker is stored;
   * a retry gets `409 idempotency_conflict` instead of a second copy of the secret.
   */
  | 'secret'
  /** SSE turns: the key maps to the accepted turn ordinal, and retries replay the stored turn. */
  | 'turn';

export interface RouteInfo {
  readonly method: HttpMethod;
  /** Path relative to `/api/v1`, Hono syntax (`/ventures/:id`). */
  readonly path: string;
  readonly auth: 'public' | 'session';
  readonly idempotency: IdempotencyMode;
  /** Mounted only in development (local upload target). */
  readonly developmentOnly?: boolean;
}
