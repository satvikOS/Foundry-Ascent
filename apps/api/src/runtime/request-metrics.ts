import { AsyncLocalStorage } from 'node:async_hooks';

import { awsConnectionStats, type ConnectionStats } from '@foundry/ai';
import { type DbCallEvent } from '@foundry/db';

import { type LogFields } from '../logging.js';

/**
 * Per-request timings and counts (identifiers and numbers only, never content): the database round trips
 * the request made and how long it waited on them, the time to verify the session, and the model and
 * embedding calls. The access log line (`http.request`) and the turn timing line (`turn.timing`) report
 * them, so production latency can be broken down by stage from the logs alone
 * (docs/runbooks/latency.md).
 *
 * The metrics of a request travel with its async context (AsyncLocalStorage), so database and model calls
 * made anywhere below the handler, including a streamed turn that outlives the response headers, count for
 * the request that made them. Work outside a request (jobs, startup) is not counted.
 */
export class RequestMetrics {
  /** `performance.now()` when the request reached the API. */
  readonly startedAt: number;
  db = { roundTrips: 0, statements: 0, transactions: 0, waitMs: 0 };
  /** The last database transaction that ended: when (request-relative) and how long it took. */
  lastTransaction: { readonly endedAt: number; readonly spanMs: number } | null = null;
  /** Time spent verifying the session cookie (null on public routes). */
  authMs: number | null = null;
  /** Query embeddings: calls and their total time. */
  embed = { calls: 0, ms: 0 };
  /** Streamed model calls: when the first one started and its time to first text (request-relative). */
  stream: { startedAt: number | null; firstTokenAt: number | null; calls: number } = {
    startedAt: null,
    firstTokenAt: null,
    calls: 0,
  };
  /** Structured (whole-object) model calls: count and total time. */
  structured = { calls: 0, ms: 0 };
  /**
   * Other requests this process was serving alongside: when this one started, and the most at any time while it
   * ran (LAB-P2: the browser's concurrent requests during a turn). Counted while the request is open (`open`).
   */
  inflight = { atStart: 0, max: 0 };
  /** The process's AWS connection counts when the request started (`awsConnectionStats`). */
  readonly #connectionsAtStart: ConnectionStats;

  constructor(startedAt: number = performance.now()) {
    this.startedAt = startedAt;
    this.#connectionsAtStart = awsConnectionStats();
  }

  /**
   * AWS connections opened and reused since the request started (process-wide: exact where a process serves one
   * request at a time, as a Lambda does; an upper bound where it serves several).
   */
  connectionFields(): LogFields {
    const now = awsConnectionStats();
    return {
      awsConnectionsOpened: now.opened - this.#connectionsAtStart.opened,
      awsConnectionsReused: now.reused - this.#connectionsAtStart.reused,
    };
  }

  /** In-flight fields for a log line. */
  inflightFields(): LogFields {
    return { inflightAtStart: this.inflight.atStart, inflightMax: this.inflight.max };
  }

  /** Milliseconds since the request reached the API. */
  elapsed(now: number = performance.now()): number {
    return now - this.startedAt;
  }

  recordDb(event: DbCallEvent): void {
    this.db.roundTrips += event.roundTrips;
    this.db.waitMs += event.ms;
    if (event.kind === 'statement') this.db.statements += 1;
    else {
      this.db.transactions += 1;
      this.lastTransaction = { endedAt: this.elapsed(), spanMs: event.spanMs ?? event.ms };
    }
  }

  /** Database fields for a log line. */
  dbFields(): LogFields {
    return {
      dbRoundTrips: this.db.roundTrips,
      dbTransactions: this.db.transactions,
      dbWaitMs: Math.round(this.db.waitMs),
    };
  }
}

const storage = new AsyncLocalStorage<RequestMetrics>();

/** The requests the process is serving now. */
const open = new Set<RequestMetrics>();

/**
 * Counts `metrics` as in flight until the returned function is called: every request open meanwhile records how
 * many others it ran alongside ({@link RequestMetrics.inflight}).
 */
export function openRequest(metrics: RequestMetrics): () => void {
  metrics.inflight.atStart = open.size;
  metrics.inflight.max = open.size;
  open.add(metrics);
  for (const other of open) other.inflight.max = Math.max(other.inflight.max, open.size - 1);
  return () => {
    open.delete(metrics);
  };
}

/** Runs `fn` with `metrics` as the current request's metrics. */
export function withRequestMetrics<T>(metrics: RequestMetrics, fn: () => T): T {
  return storage.run(metrics, fn);
}

/** The metrics of the request being served, or undefined outside a request. */
export function currentRequestMetrics(): RequestMetrics | undefined {
  return storage.getStore();
}

/** Reports a database call to the current request's metrics (the driver's `onCall` hook). */
export function recordDbCall(event: DbCallEvent): void {
  storage.getStore()?.recordDb(event);
}

/** Rounds a request-relative time for a log line (null stays null). */
export function ms(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Math.round(value);
}
