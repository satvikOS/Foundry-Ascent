import { type TurnStreamEvent } from '@foundry/contracts';
import {
  DomainError,
  turnErrorEvent,
  type Orchestrator,
  type RunTurnOutcome,
  RunTurnInput,
  type SessionContext,
  type SpeechService,
  type TurnVoice,
} from '@foundry/core';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { errorFields, type Logger } from '../logging.js';
import { type InflightTracker } from '../runtime/inflight.js';
import { currentRequestMetrics, RequestMetrics } from '../runtime/request-metrics.js';
import { EventChannel } from './event-channel.js';
import {
  IDEMPOTENCY_REPLAYED_HEADER,
  IN_FLIGHT,
  idempotencyKeyOf,
  type IdempotencyScope,
  type IdempotencyStore,
  KEY_REUSED,
  requestHash,
  type Reservation,
  routeKey,
} from './idempotency.js';
import { jsonBody, pathParam } from './input.js';
import { endpointFields, TurnTimeline } from './turn-timing.js';
import { TurnAudio } from './turn-voice.js';
import { type AppContext } from './types.js';

export interface TurnStreamOptions {
  readonly orchestrator: Pick<Orchestrator, 'runTurn'>;
  /**
   * Speech inside the turn's stream (`speechAudio: 'pcm'` on a spoken turn): the turn's voice is prepared once the turn
   * is accepted, and each unit it takes is voiced here and sent as `turn.audio` frames (`turn-voice.ts`). Absent: every
   * unit goes through `POST /speech`.
   */
  readonly speech?: Pick<SpeechService, 'prepareTurnVoice'> | undefined;
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

/** Refuses a turn whose Idempotency-Key this request did not reserve; the reservation then decides the response. */
const NOT_RESERVED = (): DomainError =>
  new DomainError('conflict', 'A request with this Idempotency-Key is still being processed', {
    reason: 'idempotency_not_reserved',
  });

/**
 * POST /sessions/:id/turns (system design §6.1). Runs the orchestrator and streams its events as SSE
 * (`event: <name>` + `data: <json>`), with keep-alive comments and cancellation when the client goes away
 * or the deadline approaches. Each event is written as soon as the orchestrator emits it, so validated
 * `turn.delta` (and, on a call, `turn.speech`) units reach the client while the answer is still being
 * written; Lambda Function URL response streaming carries them (ADR-0017). A turn refused before acceptance
 * (not found, session ended, kill switch, rate limit, spend cap, …) is answered with a plain problem+json
 * response instead of a stream.
 *
 * `Idempotency-Key`: the key is bound to the accepted turn's ordinal; a retry with the same key and body
 * replays that turn from storage (core `expectedOrdinal`), without a second model call. The key is reserved while the
 * turn's checks run (one round trip off the way to the stream), and the turn is admitted only once it is reserved: a
 * key used for another request, a request with this key still being answered, or one already answered decide the
 * response as they did when the reservation came first (the last replays the stored turn). The accepted turn is
 * stored against the key once the stream is open, and the stream ends only after it is: a retry meanwhile finds the
 * key still reserved (`IN_FLIGHT`), as it does while the turn is answered.
 *
 * A spoken turn that asks for it (`speechAudio: 'pcm'`) also carries its units' audio (`TurnAudio`): the stream then
 * ends after the last unit's audio, which may come after the terminal event.
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

  // Set once the reservation decided (`reservationOutcome`): the reservation this request holds, and whether the turn
  // is a replay of the stored one.
  const reserved: { held: HeldReservation | null; replayed: boolean } = { held: null, replayed: false };
  const key = idempotencyKeyOf(c);
  // The reservation, made while the turn's checks run; the turn waits for it before it is admitted (`beforeAdmission`).
  let reserving: Promise<Reservation> | null = null;
  let reservedScope: HeldReservation | null = null;
  if (key !== null) {
    const scope: IdempotencyScope = { principalId: ctx.principalId, route: routeKey(c), key };
    const hash = requestHash(c.req.method, new URL(c.req.url).pathname, c.get('rawBody'));
    reservedScope = { scope, hash };
    reserving = idempotency.reserve(scope, hash);
    reserving.catch(() => undefined); // decided below, once the turn says whether it got that far
  }
  /**
   * What the reservation decides, as when it came first: the key's other request or a request still answered refuse
   * this one, and a stored turn replays (`expectedOrdinal`); null to go on (reserved, or no key).
   */
  const reservationOutcome = async (): Promise<'replay' | null> => {
    if (reserving === null || reservedScope === null) return null;
    const reservation = await reserving;
    switch (reservation.kind) {
      case 'mismatch':
        throw KEY_REUSED();
      case 'in_progress':
        throw IN_FLIGHT();
      case 'replay': {
        const stored = StoredTurn.safeParse(reservation.body);
        if (!stored.success) throw KEY_REUSED();
        input = { ...input, expectedOrdinal: stored.data.ordinal };
        reserved.replayed = true;
        return 'replay';
      }
      case 'reserved':
        reserved.held = reservedScope;
        return null;
    }
  };
  // The turn is admitted only on a reservation this request holds.
  const beforeAdmission =
    reserving === null
      ? undefined
      : reserving.then((reservation) => {
          if (reservation.kind !== 'reserved') throw NOT_RESERVED();
        });
  // A turn refused before admission never waits for it: the reservation then decides the response (below).
  beforeAdmission?.catch(() => undefined);
  const release = async (): Promise<void> => {
    const { held } = reserved;
    if (held === null) return;
    await idempotency.release(held.scope, held.hash).catch((err: unknown) => {
      logger.warn('idempotency.release_failed', { requestId, ...errorFields(err) });
    });
  };

  // Cancellation: client disconnect (node-server request signal, stream cancel, stalled writes) or the
  // deadline (Lambda remaining time, else the configured budget). Core cancels the model call and
  // records the turn as failed, except a spoken turn cancelled after some of its speech was sent (a barge-in),
  // which it keeps as interrupted (docs/architecture/calls.md §2.6).
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
  const counts = { deltas: 0, speech: 0, firstDeltaMs: null as number | null };
  const timeline = new TurnTimeline(currentRequestMetrics() ?? new RequestMetrics(started));
  // The turn's voice, prepared once when the turn is accepted (its checks run while the model starts).
  const voiceCallId =
    options.speech !== undefined && input.channel === 'voice' && input.speechAudio === 'pcm'
      ? (input.callId ?? null)
      : null;
  let voice: Promise<TurnVoice | null> | null = null;
  const start = (
    gate: Promise<unknown> | undefined,
  ): { run: Promise<RunTurnOutcome>; channel: EventChannel<TurnStreamEvent> } => {
    const events = new EventChannel<TurnStreamEvent>();
    let acceptedTurnId: string | null = null;
    const running: Promise<RunTurnOutcome> = options.orchestrator
      .runTurn(
        ctx,
        sessionId,
        input,
        (event) => {
          timeline.observe(event);
          if (event.event === 'turn.accepted') {
            acceptedTurnId = event.turnId;
            if (voiceCallId !== null && voice === null && options.speech !== undefined) {
              voice = options.speech.prepareTurnVoice(ctx, { sessionId, callId: voiceCallId });
            }
          }
          if (event.event === 'turn.delta') {
            counts.deltas += 1;
            counts.firstDeltaMs ??= Math.round(performance.now() - started);
          }
          if (event.event === 'turn.speech') counts.speech += 1;
          events.push(event);
        },
        { signal: controller.signal, ...(gate === undefined ? {} : { beforeAdmission: gate }) },
      )
      .catch((err: unknown): RunTurnOutcome => {
        // runTurn reports failures as events; this only guards against a bug escaping it.
        logger.error('turn.unexpected_rejection', { requestId, ...errorFields(err) });
        const error = new DomainError('internal', 'Something went wrong while answering. Please try again.', {
          reason: 'orchestrator_rejected',
        });
        events.push({ ...turnErrorEvent(acceptedTurnId, error, requestId), retryable: true });
        return {
          status: acceptedTurnId === null ? 'rejected' : 'failed',
          turnId: acceptedTurnId,
          replayed: false,
          error,
        };
      })
      .finally(() => {
        events.close();
      });
    void options.inflight?.track(running);
    return { run: running, channel: events };
  };
  const settle = (): void => {
    clearTimeout(deadline);
    requestSignal.removeEventListener('abort', onRequestAbort);
  };

  let { run, channel } = start(beforeAdmission);
  let first = await channel.first();
  if (first === null || (first.event === 'turn.error' && first.turnId === null)) {
    const outcome = await run;
    // Refused before acceptance: the reservation decides first, as when it was made before the turn ran.
    let decided: 'replay' | null;
    try {
      decided = await reservationOutcome();
    } catch (err) {
      settle();
      throw err;
    }
    if (decided === 'replay') {
      // A turn already accepted for this key: replayed from storage.
      ({ run, channel } = start(undefined));
      first = await channel.first();
    }
    if (decided !== 'replay' || first === null || (first.event === 'turn.error' && first.turnId === null)) {
      const refused = decided === 'replay' ? await run : outcome;
      settle();
      await release();
      throw (
        refused.error ??
        new DomainError('internal', 'Something went wrong while answering. Please try again.', {
          reason: 'turn_without_events',
        })
      );
    }
  }
  // The stream as written: the turn's events in order, each unit the turn voices followed by its audio
  // (`turn.audio`), until the turn settled and the last unit's audio was sent.
  const outbox = new EventChannel<TurnStreamEvent>();
  const audio =
    voiceCallId === null
      ? null
      : new TurnAudio({
          voice: () => voice,
          signal: controller.signal,
          push: (event) => {
            timeline.observe(event);
            outbox.push(event);
          },
          logger,
          requestId,
        });
  const sequenced = (async () => {
    try {
      for await (const event of channel) {
        if (audio === null) {
          outbox.push(event);
          continue;
        }
        // A reply the whole-reply gate held back (not crisis support) or that failed is never voiced further, as
        // `POST /speech` refuses its units (`turn_not_speakable`): withdrawn before its terminal event is written.
        if (
          (event.event === 'turn.blocked' && event.reason !== 'crisis_support') ||
          event.event === 'turn.error'
        ) {
          audio.withdraw(event.turnId);
        }
        const { event: written, start } = await audio.announce(event);
        outbox.push(written);
        start?.();
      }
      await audio?.drained();
    } finally {
      outbox.close();
    }
  })();
  void options.inflight?.track(sequenced);
  void Promise.all([run, sequenced]).finally(settle);
  // Stored against the key once the stream is open; the stream ends after it (a retry meanwhile: IN_FLIGHT).
  let storing: Promise<void> = Promise.resolve();
  if (first.event === 'turn.accepted' && (await reservationOutcome()) === null && reserved.held !== null) {
    const { scope, hash } = reserved.held;
    const stored: z.infer<typeof StoredTurn> = { turnId: first.turnId, ordinal: first.ordinal };
    storing = idempotency.complete(scope, hash, 200, stored).catch((err: unknown) => {
      logger.warn('idempotency.store_failed', { requestId, route: scope.route, ...errorFields(err) });
    });
    void options.inflight?.track(storing);
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
      for await (const event of outbox) {
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
    await sequenced;
    await storing;
    logger.info('turn.stream_finished', {
      requestId,
      turnId: outcome.turnId,
      outcome: outcome.status,
      code: outcome.error?.code,
      replayed: outcome.replayed,
      frames,
      deltas: counts.deltas,
      speechUnits: counts.speech,
      ...(audio === null
        ? {}
        : {
            audioUnits: audio.stats.units,
            audioFrames: audio.stats.frames,
            audioBytes: audio.stats.bytes,
            audioFailed: audio.stats.failed,
            audioWithdrawn: audio.stats.withdrawn,
          }),
      firstDeltaMs: counts.firstDeltaMs,
      clientGone,
      durationMs: Math.round(performance.now() - started),
    });
    // Stage timings (docs/runbooks/latency.md): numbers only.
    logger.info('turn.timing', {
      requestId,
      turnId: outcome.turnId,
      outcome: outcome.status,
      ...timeline.fields(),
      ...endpointFields(input.endpointing),
    });
  });
  // Hop-by-hop headers are invalid over HTTP/2 and in Lambda streaming metadata; the runtime frames
  // the body itself.
  response.headers.delete('transfer-encoding');
  response.headers.delete('connection');
  response.headers.set('content-type', 'text/event-stream; charset=utf-8');
  response.headers.set('x-accel-buffering', 'no');
  if (reserved.replayed) response.headers.set(IDEMPOTENCY_REPLAYED_HEADER, 'true');
  return response;
}
