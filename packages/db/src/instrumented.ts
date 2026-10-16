import { type QueryResult, type SqlConnection, type SqlDriver } from './executor.js';

/**
 * One database round trip as the RDS Data API counts it: every statement is one HTTPS call, and a
 * transaction adds two more (BeginTransaction, then CommitTransaction or RollbackTransaction). The pg driver
 * runs BEGIN and COMMIT as statements on its connection, so it makes the same number of round trips.
 */
export interface DbCallEvent {
  /** `statement`: one statement (autocommit or inside a transaction); `transaction`: its begin and end. */
  readonly kind: 'statement' | 'transaction';
  /** Round trips this event stands for: 1 for a statement, 2 for a transaction's begin and end. */
  readonly roundTrips: number;
  /** Time spent waiting on the database (a transaction: its begin plus its commit or rollback). */
  readonly ms: number;
  /** A transaction: wall time from begin to the end of its commit or rollback (application work included). */
  readonly spanMs: number | null;
  /** A transaction: statements run inside it. */
  readonly statements: number | null;
  readonly failed: boolean;
}

export interface DriverInstrumentation {
  /** Called after each round trip (identifiers and timings only: no SQL, no parameters). */
  readonly onCall?: (event: DbCallEvent) => void;
  /**
   * Network time added before every round trip. For the local latency harness only: it makes the local pg
   * driver behave like the RDS Data API, where each statement, begin and commit is one HTTPS call.
   */
  readonly simulatedRoundTripMs?: number;
  /** How the simulated network time is waited (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

const timerSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps a driver so every round trip is reported (and, in the latency harness, delayed). The results and
 * errors of the wrapped driver pass through unchanged.
 */
export function instrumentDriver(driver: SqlDriver, instrumentation: DriverInstrumentation): SqlDriver {
  const delay = instrumentation.simulatedRoundTripMs ?? 0;
  const wait = instrumentation.sleep ?? timerSleep;
  const sleep = (ms: number): Promise<void> => (ms > 0 ? wait(ms) : Promise.resolve());
  const report = instrumentation.onCall ?? (() => undefined);

  const statement = async (run: () => Promise<QueryResult>): Promise<QueryResult> => {
    const started = performance.now();
    let failed = false;
    try {
      await sleep(delay);
      return await run();
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      report({
        kind: 'statement',
        roundTrips: 1,
        ms: performance.now() - started,
        spanMs: null,
        statements: null,
        failed,
      });
    }
  };

  return {
    driver: driver.driver,
    query: (sql, params) => statement(() => driver.query(sql, params)),
    queryWithOptions: (sql, params, options) =>
      statement(() => driver.queryWithOptions(sql, params, options)),
    async transaction<T>(fn: (conn: SqlConnection) => Promise<T>): Promise<T> {
      const started = performance.now();
      // Set inside the driver's callback: when the transaction had begun, and when its work was done.
      const marks: { begun: number | null; workDone: number | null } = { begun: null, workDone: null };
      let statements = 0;
      let failed = false;
      try {
        await sleep(delay);
        const result = await driver.transaction(async (conn) => {
          marks.begun = performance.now();
          try {
            return await fn({
              query: (sql, params) => {
                statements += 1;
                return statement(() => conn.query(sql, params));
              },
            });
          } finally {
            marks.workDone = performance.now();
          }
        });
        await sleep(delay);
        return result;
      } catch (err) {
        failed = true;
        await sleep(delay);
        throw err;
      } finally {
        const ended = performance.now();
        const beginMs = (marks.begun ?? ended) - started;
        const endMs = marks.workDone === null ? 0 : ended - marks.workDone;
        report({
          kind: 'transaction',
          roundTrips: 2,
          ms: beginMs + endMs,
          spanMs: ended - started,
          statements,
          failed,
        });
      }
    },
    close: () => driver.close(),
  };
}
