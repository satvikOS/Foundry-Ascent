import { type TurnStreamEvent } from '@foundry/contracts';
import {
  DomainError,
  type Orchestrator,
  type RunTurnOutcome,
  RunTurnInput,
  type SessionContext,
} from '@foundry/core';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { errorFields, type Logger } from '../logging.js';
import { type InflightTracker } from '../runtime/inflight.js';
import { EventChannel } from './event-channel.js';
import {
  IDEMPOTENCY_REPLAYED_HEADER,
  IN_FLIGHT,
  idempotencyKeyOf,
  type IdempotencyScope,
  type IdempotencyStore,
  KEY_REUSED,
  requestHash,
  routeKey,
} from './idempotency.js';
import { jsonBody, pathParam } from './input.js';
import { type AppContext } from './types.js';

export interface TurnStreamOptions {
  readonly orchestrator: Pick<Orchestrator, 'runTurn'>;
  readonly idempotency: IdempotencyStore;
  readonly logger: Logger;
  readonly inflight?: InflightTracker | undefined;
  /** SSE comment interval keeping proxies from closing an idle stream (15 s). */
  readonly keepAliveMs: number;
  /** A frame that cannot be written within this time means the client is gone (10 s). */
  readonly writeTimeoutMs: number;
  /** Turn budget when no Lambda deadline is known (dev server, tests). */
  readonly turnTimeoutMs: number;
}

/** What an Idempotency-Key of a turn stores: the accepted turn (replayed via `expectedOrdinal`). */
const StoredTurn = z.object({ turnId: z.uuid(), ordinal: z.number().int().min(1) });

/** Margin kept before the Lambda deadline to persist a cancelled turn. */
const LAMBDA_DEADLINE_MARGIN_MS = 4_000;

/** Remaining invocation time when running in Lambda (streamHandle passes the context as env). */
export function lambdaRemainingMs(c: AppContext): number | null {
  const env: unknown = c.env;
  if (typeof env !== 'object' || env === null) return null;
  const context: unknown = (env as Record<string, unknown>).context;
  if (typeof context !== 'object' || context === null) return null;
  const remaining: unknown = (context as Record<string, unknown>).getRemainingTimeInMillis;
  if (typeof remaining !== 'function') return null;
  const value: unknown = (remaining as () => unknown).call(context);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Resolves true when `promise` settles within `ms`, false otherwise (the write is abandoned). */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

interface HeldReservation {
  readonly scope: IdempotencyScope;
  readonly hash: string;
}

/**
 * POST /sessions/:id/turns (system design §6.1). Runs the orchestrator and streams its events as SSE
 * (`event: <name>` + `data: <json>`), with keep-alive comments and cancellation when the client goes away
 * or the deadline approaches. A turn refused before acceptance (not found, session ended, kill switch,
 * rate limit, spend cap, …) is answered with a plain problem+json response instead of a stream.
 *
 * `Idempotency-Key`: the key is bound to the accepted turn's ordinal; a retry with the same key and body
 * replays that turn from storage (core `expectedOrdinal`), without a second model call.
 */
export async function handleTurnRequest(
  c: AppContext,
  ctx: SessionContext,
  options: TurnStreamOptions,
): Promise<Response> {
  const { logger, idempotency } = options;
  const sessionId = pathParam(c, 'id');
  let input = jsonBody(c, RunTurnInput);
  const requestId = ctx.requestId;

  let held: HeldReservation | null = null;
  let replayed = false;
  const key = idempotencyKeyOf(c);
  if (key !== null) {
    const scope: IdempotencyScope = { principalId: ctx.principalId, route: routeKey(c), key };
    const hash = requestHash(c.req.method, new URL(c.req.url).pathname, c.get('rawBody'));
    const reservation = await idempotency.reserve(scope, hash);
    switch (reservation.kind) {
      case 'mismatch':
        throw KEY_REUSED();
      case 'in_progress':
        throw IN_FLIGHT();
      case 'replay': {
        const stored = StoredTurn.safeParse(reservation.body);
        if (!stored.success) throw KEY_REUSED();
        input = { ...input, expectedOrdinal: stored.data.ordinal };
        replayed = true;
        break;
      }
      case 'reserved':
        held = { scope, hash };
        break;
    }
  }
  const release = async (): Promise<void> => {
    if (held === null) return;
    await idempotency.release(held.scope, held.hash).catch((err: unknown) => {
      logger.warn('idempotency.release_failed', { requestId, ...errorFields(err) });
    });
  };

  // Cancellation: client disconnect (node-server request signal, stream cancel, stalled writes) or the
  // deadline (Lambda remaining time, else the configured budget). Core cancels the model call and
  // records the turn as failed.
  const controller = new AbortController();
  const abort = (reason: string): void => {
    if (!controller.signal.aborted) controller.abort(new DOMException(reason, 'AbortError'));
  };
  const requestSignal = c.req.raw.signal;
  const onRequestAbort = (): void => {
    abort('client_disconnected');
  };
  requestSignal.addEventListener('abort', onRequestAbort, { once: true });
  const remaining = lambdaRemainingMs(c);
  const budget =
    remaining === null ? options.turnTimeoutMs : Math.max(1_000, remaining - LAMBDA_DEADLINE_MARGIN_MS);
  const deadline = setTimeout(() => {
    abort('deadline');
  }, budget);

  const started = performance.now();
  const channel = new EventChannel<TurnStreamEvent>();
  let acceptedTurnId: string | null = null;
  const run: Promise<RunTurnOutcome> = options.orchestrator
    .runTurn(
      ctx,
      sessionId,
      input,
      (event) => {
        if (event.event === 'turn.accepted') acceptedTurnId = event.turnId;
        channel.push(event);
      },
      { signal: controller.signal },
    )
    .catch((err: unknown): RunTurnOutcome => {
      // runTurn reports failures as events; this only guards against a bug escaping it.
      logger.error('turn.unexpected_rejection', { requestId, ...errorFields(err) });
      const error = new DomainError('internal', 'Something went wrong while answering. Please try again.', {
        reason: 'orchestrator_rejected',
      });
      channel.push({
        event: 'turn.error',
        turnId: acceptedTurnId,
        code: error.code,
        message: error.message,
        retryable: true,
      });
      return {
        status: acceptedTurnId === null ? 'rejected' : 'failed',
        turnId: acceptedTurnId,
        replayed: false,
        error,
      };
    })
    .finally(() => {
      clearTimeout(deadline);
      requestSignal.removeEventListener('abort', onRequestAbort);
      channel.close();
    });
  void options.inflight?.track(run);

  const first = await channel.first();
  if (first === null || (first.event === 'turn.error' && first.turnId === null)) {
    const outcome = await run;
    await release();
    throw (
      outcome.error ??
      new DomainError('internal', 'Something went wrong while answering. Please try again.', {
        reason: 'turn_without_events',
      })
    );
  }
  if (held !== null && first.event === 'turn.accepted') {
    const { scope, hash } = held;
    const stored: z.infer<typeof StoredTurn> = { turnId: first.turnId, ordinal: first.ordinal };
    await idempotency.complete(scope, hash, 200, stored).catch((err: unknown) => {
      logger.warn('idempotency.store_failed', { requestId, route: scope.route, ...errorFields(err) });
    });
  }

  let clientGone = false;
  let frames = 0;
  const response = streamSSE(c, async (stream) => {
    const gone = (reason: string): void => {
      if (clientGone) return;
      clientGone = true;
      abort(reason);
    };
    stream.onAbort(() => {
      gone('client_disconnected');
    });
    const keepAlive = setInterval(() => {
      if (clientGone) return;
      void within(stream.write(': keep-alive\n\n'), options.writeTimeoutMs).then((ok) => {
        if (!ok || stream.aborted) gone('client_unresponsive');
      });
    }, options.keepAliveMs);
    try {
      for await (const event of channel) {
        if (clientGone) continue; // keep draining until the turn settles
        const ok = await within(
          stream.writeSSE({ event: event.event, data: JSON.stringify(event) }),
          options.writeTimeoutMs,
        );
        if (!ok || stream.aborted) gone('client_unresponsive');
        else frames += 1;
      }
    } finally {
      clearInterval(keepAlive);
    }
    const outcome = await run;
    logger.info('turn.stream_finished', {
      requestId,
      turnId: outcome.turnId,
      outcome: outcome.status,
      code: outcome.error?.code,
      replayed: outcome.replayed,
      frames,
      clientGone,
      durationMs: Math.round(performance.now() - started),
    });
  });
  // Hop-by-hop headers are invalid over HTTP/2 and in Lambda streaming metadata; the runtime frames
  // the body itself.
  response.headers.delete('transfer-encoding');
  response.headers.delete('connection');
  response.headers.set('content-type', 'text/event-stream; charset=utf-8');
  response.headers.set('x-accel-buffering', 'no');
  if (replayed) response.headers.set(IDEMPOTENCY_REPLAYED_HEADER, 'true');
  return response;
}
