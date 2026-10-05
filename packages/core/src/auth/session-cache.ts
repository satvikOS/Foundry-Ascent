import { type PlatformRole } from '@foundry/contracts';

/** Revocation state of one auth session as last read from the database. */
export interface CachedSession {
  readonly sessionId: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly roles: readonly PlatformRole[];
  /** False when revoked, expired, the principal is disabled or the issuing code was revoked. */
  readonly valid: boolean;
  /** Session expiry (epoch ms). */
  readonly expiresAtMs: number;
  /** When the state was read (epoch ms). */
  readonly checkedAtMs: number;
}

/**
 * Bounded in-memory cache of session revocation state (system design §4.1: "checked with a 60 s
 * cache"). A revocation in this container takes effect immediately (`invalidate*`); other containers
 * see it within the TTL.
 */
export class SessionCache {
  readonly #entries = new Map<string, CachedSession>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  get(sessionId: string, nowMs: number): CachedSession | null {
    const entry = this.#entries.get(sessionId);
    if (!entry) return null;
    if (nowMs - entry.checkedAtMs >= this.ttlMs || nowMs >= entry.expiresAtMs) {
      this.#entries.delete(sessionId);
      return null;
    }
    // Refresh LRU position.
    this.#entries.delete(sessionId);
    this.#entries.set(sessionId, entry);
    return entry;
  }

  set(entry: CachedSession): void {
    if (this.ttlMs <= 0) return;
    this.#entries.delete(entry.sessionId);
    this.#entries.set(entry.sessionId, entry);
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  invalidate(sessionId: string): void {
    this.#entries.delete(sessionId);
  }

  /** Drops every cached session of a principal (code revoked, roles changed, principal disabled). */
  invalidatePrincipal(principalId: string): void {
    for (const [id, entry] of this.#entries) {
      if (entry.principalId === principalId) this.#entries.delete(id);
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}
