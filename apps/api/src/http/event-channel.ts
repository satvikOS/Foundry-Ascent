/**
 * Unbounded single-consumer channel: the producer (the orchestrator's `emit`) never blocks, so a slow or
 * vanished client can never stall a turn mid-pipeline; the consumer (the SSE writer) reads every item in
 * order from the beginning, including items pushed before it started.
 */
export class EventChannel<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #closed = false;
  #waiters: (() => void)[] = [];

  push(item: T): void {
    if (this.#closed) return;
    this.#items.push(item);
    this.#wake();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The first item, or null when the channel closed without any. */
  async first(): Promise<T | null> {
    while (this.#items.length === 0 && !this.#closed) await this.#wait();
    return this.#items[0] ?? null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let index = 0;
    for (;;) {
      if (index < this.#items.length) {
        yield this.#items[index] as T;
        index += 1;
        continue;
      }
      if (this.#closed) return;
      await this.#wait();
    }
  }

  #wait(): Promise<void> {
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
}
