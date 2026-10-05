/**
 * Background work that must finish before a Lambda invocation returns (the execution environment is
 * frozen afterwards). The streaming API handler drains it after the response stream ends, so a turn whose
 * client disconnected still records its outcome instead of staying `pending` until the next thaw.
 */
export class InflightTracker {
  readonly #pending = new Set<Promise<void>>();

  /** Registers `promise` and returns it unchanged. */
  track<T>(promise: Promise<T>): Promise<T> {
    const settled = promise.then(
      () => undefined,
      () => undefined,
    );
    this.#pending.add(settled);
    void settled.then(() => this.#pending.delete(settled));
    return promise;
  }

  get size(): number {
    return this.#pending.size;
  }

  /** Waits until all tracked work settled or `timeoutMs` elapsed; returns how many are still pending. */
  async drain(timeoutMs: number): Promise<number> {
    if (this.#pending.size === 0) return 0;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, timeoutMs));
    });
    try {
      await Promise.race([Promise.all([...this.#pending]), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return this.#pending.size;
  }
}
