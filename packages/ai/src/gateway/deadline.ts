/**
 * A time budget combined with optional caller cancellation. `timedOut` distinguishes our own
 * timeout (eligible for fallback) from caller cancellation (never falls back).
 */
export class Deadline {
  readonly signal: AbortSignal;
  readonly #controller = new AbortController();
  readonly #expiresAt: number;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #callerSignal: AbortSignal | undefined;
  readonly #onCallerAbort = (): void => {
    this.#controller.abort(this.#callerSignal?.reason);
  };
  #timedOut = false;

  constructor(timeoutMs: number, callerSignal?: AbortSignal) {
    const ms = Math.max(1, Math.floor(timeoutMs));
    this.#expiresAt = Date.now() + ms;
    this.#callerSignal = callerSignal;
    this.signal = this.#controller.signal;
    this.#timer = setTimeout(() => {
      this.#timedOut = true;
      this.#controller.abort(new DOMException('Model call timed out', 'TimeoutError'));
    }, ms);
    if (callerSignal) {
      if (callerSignal.aborted) this.#onCallerAbort();
      else callerSignal.addEventListener('abort', this.#onCallerAbort, { once: true });
    }
  }

  get timedOut(): boolean {
    return this.#timedOut;
  }

  get callerAborted(): boolean {
    return this.#callerSignal?.aborted === true;
  }

  get aborted(): boolean {
    return this.signal.aborted;
  }

  remainingMs(): number {
    return Math.max(0, this.#expiresAt - Date.now());
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#callerSignal?.removeEventListener('abort', this.#onCallerAbort);
  }
}

/** Monotonic-enough wall clock helper for latency measurement. */
export function elapsedSince(start: number): number {
  return Math.max(0, Math.round(performance.now() - start));
}
