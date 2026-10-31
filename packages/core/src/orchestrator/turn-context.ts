import { personasRepo, venturesRepo, type AppExecutor } from '@foundry/db';

import { loadContinuity, type LoadedContinuity } from './continuity.js';

/**
 * The part of a turn's context that only the conversation decides, read alongside the turn's checks rather than after
 * them (docs/runbooks/latency.md, "What a call's turns read before the model").
 *
 * On the Data API every statement is a round trip (~45 ms) and a transaction runs one statement at a time, so the
 * turn's preflight transaction (session, access, settings, assignment, release, history, then these reads) is a chain
 * of ~16 round trips. Five of them depend only on who is talking in which conversation with which vEIR: the persona's
 * presence, the founder, the vEIR's notes, the venture's earlier conversations and the venture. Once a conversation's
 * keys are known in the process (its call started here, or an earlier turn ran here), a turn starts those reads at
 * once in a transaction of their own, beside its preflight, and the preflight uses them when its own authorization
 * reads resolve to the same keys.
 *
 * What is remembered is the keys, never the data: the reads run during the turn, so a note, memory or persona that
 * changed mid-call is what the turn reads (nothing to invalidate, on any Lambda container), and both paths run the
 * same function ({@link readTurnContext}), so the prompt is byte for byte what it would be without (turn-context.db
 * test). Keys that no longer match (another vEIR assigned, a new release's persona) or a prefetch that failed fall
 * back to reading in the preflight, as before.
 */
export interface TurnContextKeys {
  readonly tenantId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly ventureId: string;
  readonly personaId: string;
  /** The EIR of the venture's active assignment (whether the persona's EIR sees the work). */
  readonly assignedEirProfileId: string | null;
  readonly privacy: 'standard' | 'ephemeral';
}

/** What {@link readTurnContext} reads. */
export interface TurnContextReads {
  readonly presence: personasRepo.PersonaPresence;
  readonly memory: LoadedContinuity;
  readonly venture: venturesRepo.VentureRecord | null;
}

/**
 * The reads, in one place for both paths: the persona's presence, the founder and the vEIR's notes and the venture's
 * earlier conversations (`loadContinuity`), and the venture.
 */
export async function readTurnContext(tx: AppExecutor, keys: TurnContextKeys): Promise<TurnContextReads> {
  const presence = await personasRepo.getPersonaPresence(tx, {
    personaId: keys.personaId,
    assignedEirProfileId: keys.assignedEirProfileId,
  });
  const memory = await loadContinuity(tx, {
    ventureId: keys.ventureId,
    personaId: keys.personaId,
    sessionId: keys.sessionId,
    principalId: keys.principalId,
    privacy: keys.privacy,
  });
  const venture = await venturesRepo.getVenture(tx, keys.ventureId);
  return { presence, memory, venture };
}

export function sameTurnContextKeys(a: TurnContextKeys, b: TurnContextKeys): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.principalId === b.principalId &&
    a.sessionId === b.sessionId &&
    a.ventureId === b.ventureId &&
    a.personaId === b.personaId &&
    a.assignedEirProfileId === b.assignedEirProfileId &&
    a.privacy === b.privacy
  );
}

/** How many conversations' keys a process remembers (the oldest is forgotten first). */
export const MAX_TURN_CONTEXT_KEYS = 2_000;

/**
 * The keys of the conversations this process has seen, by tenant, person and conversation: filled when a call starts
 * and after every turn's preflight. Identifiers only; a wrong or stale entry costs a prefetch that is not used.
 */
export class TurnContextKeyring {
  readonly #keys = new Map<string, TurnContextKeys>();

  constructor(private readonly max: number = MAX_TURN_CONTEXT_KEYS) {}

  static #id(tenantId: string, principalId: string, sessionId: string): string {
    return `${tenantId}/${principalId}/${sessionId}`;
  }

  get(tenantId: string, principalId: string, sessionId: string): TurnContextKeys | null {
    return this.#keys.get(TurnContextKeyring.#id(tenantId, principalId, sessionId)) ?? null;
  }

  remember(keys: TurnContextKeys): void {
    const id = TurnContextKeyring.#id(keys.tenantId, keys.principalId, keys.sessionId);
    this.#keys.delete(id);
    this.#keys.set(id, keys);
    while (this.#keys.size > this.max) {
      const oldest = this.#keys.keys().next();
      if (oldest.done === true) break;
      this.#keys.delete(oldest.value);
    }
  }

  get size(): number {
    return this.#keys.size;
  }
}
