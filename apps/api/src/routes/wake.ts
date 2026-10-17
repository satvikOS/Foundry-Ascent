import { type Db, DatabaseResumingError } from '@foundry/db';

import { viewerIp } from '../http/request-meta.js';
import { type RouteBuilder } from '../http/router.js';
import { errorFields, type Logger } from '../logging.js';
import { AWAKE_OBSERVATION_MS, type DbStateSource, type ObservedDbState } from '../runtime/db-observer.js';
import { type InflightTracker } from '../runtime/inflight.js';

/**
 * `POST /wake` (public, content-free). The web app calls it once when a page opens (the landing page, sign-in
 * or the app), so a paused Aurora cluster starts resuming while the person reads or signs in, not on their
 * first message (docs/runbooks/cost-controls.md, "Aurora: paused when idle").
 *
 * It answers 204 with no body at once, reads nothing of the request but the viewer IP, and sends at most one
 * `SELECT 1` as a single Data API attempt: on a paused cluster that call fails at once with
 * DatabaseResumingException and starts the resume. The call finishes in the background, tracked so that the
 * Lambda invocation waits for that one round trip before returning, never for the resume itself.
 *
 * A database call less than {@link AWAKE_OBSERVATION_MS} ago proves the cluster awake or resuming: it pauses
 * only after `aurora.autoPauseMinutes` idle, at least 5 (30 in production). So any wake after the first in that
 * window adds nothing, and the gate drops it:
 *   - none while this instance saw the database awake or resuming recently (db-observer);
 *   - none while an earlier wake of this instance is still in flight;
 *   - at most one per viewer IP every {@link WAKE_PER_IP_INTERVAL_MS} (in memory, the most recent
 *     {@link WAKE_MAX_TRACKED_IPS} IPs);
 *   - at most one per instance every {@link WAKE_INSTANCE_INTERVAL_MS} (a resume takes 15-20 s), however
 *     many callers there are.
 * Over a limit it still answers 204, with no query: a 429 would save nothing (the Lambda already ran), would
 * show a failed request to someone reloading the page, and would tell a prober where the limit is.
 *
 * Worst case: anyone can keep the cluster awake by calling this at least every 30 minutes, as they already can
 * with one sign-in attempt or by opening any page of the app. That costs what keeping it awake costs, about
 * USD 0.06 an hour at 0.5 ACU (at most about USD 44 a month), plus a fraction of a cent of Lambda and
 * CloudFront per request. `SELECT 1` never scales the cluster above its minimum, and this route adds at most
 * two statements a minute per API instance.
 */
export const WAKE_PER_IP_INTERVAL_MS = AWAKE_OBSERVATION_MS;
export const WAKE_INSTANCE_INTERVAL_MS = 30_000;
export const WAKE_MAX_TRACKED_IPS = 10_000;

/** What one wake request did: `sent` issued the `SELECT 1`; every other value skipped it. */
export type WakeDecision = 'sent' | 'recently_seen' | 'in_flight' | 'ip_limit' | 'instance_limit';

/** The per-instance gate in front of the wake query (state lives as long as the API container). */
export class WakeGate {
  readonly #now: () => number;
  /** Viewer IP → when its last wake was sent; insertion order is recency (re-inserted on every send). */
  readonly #sentByIp = new Map<string, number>();
  #lastSent = Number.NEGATIVE_INFINITY;
  #inFlight = false;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Decides one request. After `sent`, the caller reports the end of its call with {@link settled}. */
  decide(ip: string, observed: ObservedDbState | null): WakeDecision {
    if (observed !== null) return 'recently_seen';
    if (this.#inFlight) return 'in_flight';
    const now = this.#now();
    const lastForIp = this.#sentByIp.get(ip);
    if (lastForIp !== undefined && now - lastForIp < WAKE_PER_IP_INTERVAL_MS) return 'ip_limit';
    if (now - this.#lastSent < WAKE_INSTANCE_INTERVAL_MS) return 'instance_limit';
    this.#sentByIp.delete(ip);
    this.#sentByIp.set(ip, now);
    if (this.#sentByIp.size > WAKE_MAX_TRACKED_IPS) {
      const oldest = this.#sentByIp.keys().next();
      if (oldest.done !== true) this.#sentByIp.delete(oldest.value);
    }
    this.#lastSent = now;
    this.#inFlight = true;
    return 'sent';
  }

  settled(): void {
    this.#inFlight = false;
  }

  /** IPs currently remembered (bounded by {@link WAKE_MAX_TRACKED_IPS}). */
  get trackedIps(): number {
    return this.#sentByIp.size;
  }
}

export interface WakeRouteDeps {
  readonly db: Pick<Db, 'ping'>;
  /** What this instance's own database calls saw recently (null or absent: nothing recent). */
  readonly dbState?: DbStateSource | undefined;
  /** Lambda: the wake call is drained before the invocation returns. */
  readonly inflight?: InflightTracker | undefined;
  readonly logger: Logger;
  /** `x-forwarded-for` is only trusted for the viewer IP in development (see `viewerIp`). */
  readonly appEnv: 'production' | 'development' | 'test';
  /** Upper bound on the one database call (the admin health probe's bound). */
  readonly timeoutMs: number;
  readonly now?: (() => number) | undefined;
}

type WakeOutcome = 'awake' | 'resuming' | 'failed' | 'timeout';

async function wakeDatabase(deps: WakeRouteDeps, requestId: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<WakeOutcome>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, deps.timeoutMs);
  });
  const call = deps.db.ping({ maxWaitMs: 0 }).then(
    (): WakeOutcome => 'awake',
    (err: unknown): WakeOutcome => {
      if (err instanceof DatabaseResumingError) return 'resuming';
      deps.logger.warn('db.wake_failed', { requestId, ...errorFields(err) });
      return 'failed';
    },
  );
  try {
    const outcome = await Promise.race([call, timeout]);
    deps.logger.info('db.wake', { requestId, outcome });
  } finally {
    clearTimeout(timer);
  }
}

/** Registers `POST /wake`; returns its gate (tests read it). */
export function registerWakeRoute(r: RouteBuilder, deps: WakeRouteDeps): WakeGate {
  const gate = new WakeGate(deps.now);
  r.public('POST', '/wake', (c) => {
    const ip = viewerIp(c.req.raw.headers, { trustForwardedFor: deps.appEnv === 'development' }) ?? 'unknown';
    if (gate.decide(ip, deps.dbState?.observed() ?? null) === 'sent') {
      const work = wakeDatabase(deps, c.get('requestId')).finally(() => {
        gate.settled();
      });
      if (deps.inflight === undefined) void work;
      else void deps.inflight.track(work);
    }
    return Promise.resolve(c.body(null, 204));
  });
  return gate;
}
