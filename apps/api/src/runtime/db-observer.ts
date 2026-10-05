import { DatabaseResumingError, type Db } from '@foundry/db';

/** What the public health route may say about the database without querying it. */
export type ObservedDbState = 'awake' | 'resuming';

export interface DbStateSource {
  /** The state seen by this API instance's own recent database calls, or null without a recent one. */
  observed(): ObservedDbState | null;
}

/**
 * How long an observation stays meaningful. Aurora auto-pauses after 10 idle minutes, so a successful
 * call less than 4 minutes ago means the cluster is still awake; a resume in progress ages out faster.
 */
export const AWAKE_OBSERVATION_MS = 4 * 60_000;
export const FAILURE_OBSERVATION_MS = 60_000;

/**
 * Wraps a Db so every call's outcome is remembered (timestamps only; nothing about the query). The
 * public `GET /health` reads this instead of probing, so anonymous polling never wakes a paused cluster.
 */
export function observeDatabase(
  db: Db,
  now: () => number = Date.now,
): { readonly db: Db; readonly state: DbStateSource } {
  let last: { readonly state: ObservedDbState; readonly at: number } | null = null;

  const record = <T>(work: Promise<T>): Promise<T> =>
    work.then(
      (value) => {
        last = { state: 'awake', at: now() };
        return value;
      },
      (err: unknown) => {
        // Only a resume failure says something certain about the cluster: other errors (SQL errors,
        // authorization failures thrown inside the callback) leave the last observation as it was.
        if (err instanceof DatabaseResumingError) last = { state: 'resuming', at: now() };
        throw err;
      },
    );

  const observed: Db = {
    driver: db.driver,
    withContext: (ctx, fn) => record(db.withContext(ctx, fn)),
    system: (fn, options) => record(db.system(fn, options)),
    ping: (options) => record(db.ping(options)),
    close: () => db.close(),
  };

  return {
    db: observed,
    state: {
      observed() {
        if (last === null) return null;
        const age = now() - last.at;
        const ttl = last.state === 'awake' ? AWAKE_OBSERVATION_MS : FAILURE_OBSERVATION_MS;
        return age <= ttl ? last.state : null;
      },
    },
  };
}
