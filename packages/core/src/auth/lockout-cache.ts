import { createHmac, randomBytes } from 'node:crypto';

/**
 * Per-container memory of viewers that are locked out of sign-in (finding: anonymous traffic kept Aurora
 * awake and flooded the audit log). Once the database has refused a viewer for its lockout window, further
 * attempts from that viewer are answered from memory (429 + Retry-After) until the window ends, with no
 * database call and no audit row; only the first refusal per window is audited. Other containers learn
 * the lockout from the database on their own first refusal.
 *
 * Keys are an HMAC of the viewer network (IPv4 address or IPv6 /64, see `viewerNetwork`) under a random
 * per-container key, so raw IP addresses are never held, and the map is bounded (oldest entries are
 * evicted first). A single anonymous attempt from an unknown viewer still reaches the database: deciding
 * whether a code is valid needs it (inherent to the design).
 */
export class LockoutCache {
  readonly #key = randomBytes(32);
  readonly #entries = new Map<string, number>();

  constructor(private readonly maxEntries: number) {}

  /** Keyed hash of a viewer network (null = the shared "unknown viewer" bucket). */
  keyFor(network: string | null): string {
    return createHmac('sha256', this.#key)
      .update(network ?? '<unknown>')
      .digest('base64url');
  }

  /** Remaining lockout in ms, or 0 when the viewer is not known to be locked out. */
  remainingMs(key: string, nowMs: number): number {
    const until = this.#entries.get(key);
    if (until === undefined) return 0;
    if (until <= nowMs) {
      this.#entries.delete(key);
      return 0;
    }
    return until - nowMs;
  }

  /** Remembers that the viewer is locked out until `untilMs`. */
  lock(key: string, untilMs: number): void {
    if (this.maxEntries <= 0) return;
    this.#entries.delete(key);
    this.#entries.set(key, untilMs);
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}
