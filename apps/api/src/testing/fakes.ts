import { type TurnStreamEvent } from '@foundry/contracts';
import {
  type Core,
  type Orchestrator,
  type RunTurnInput,
  type RunTurnOptions,
  type RunTurnOutcome,
  type SessionContext,
  type TurnEmitter,
} from '@foundry/core';
import { type Db } from '@foundry/db';

import { type IdempotencyScope, type IdempotencyStore, type Reservation } from '../http/idempotency.js';

export const TEST_SESSION: SessionContext = {
  principalId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  roles: [],
  requestId: 'req-test-0001',
  sessionId: '33333333-3333-4333-8333-333333333333',
  sessionExpiresAt: '2026-10-06T00:00:00.000Z',
};

export type FakeTurn = (
  input: RunTurnInput,
  emit: TurnEmitter,
  options: RunTurnOptions,
) => Promise<RunTurnOutcome>;

/**
 * A Core whose auth accepts the cookie `fa_session=valid` and whose orchestrator runs `turn`. Other
 * services are absent (unit tests of the HTTP layer only touch these two).
 */
export function fakeCore(turn: FakeTurn): Core & { readonly calls: RunTurnInput[] } {
  const calls: RunTurnInput[] = [];
  const orchestrator: Orchestrator = {
    runTurn: (_ctx, _sessionId, input, emit, options = {}) => {
      calls.push(input);
      return turn(input, emit, options);
    },
  };
  const core = {
    calls,
    auth: {
      verifySession: (token: string) =>
        token === 'valid'
          ? Promise.resolve(TEST_SESSION)
          : Promise.reject(Object.assign(new Error('bad'), { name: 'DomainError' })),
      signIn: () => Promise.reject(new Error('not in unit tests')),
      signOut: () => Promise.resolve(),
      invalidatePrincipal: () => undefined,
    },
    orchestrator,
  };
  return core as unknown as Core & { readonly calls: RunTurnInput[] };
}

/** In-memory IdempotencyStore with the same semantics as the database store (no expiry). */
export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly records = new Map<string, { hash: string; status: number; body: unknown }>();

  #id(scope: IdempotencyScope): string {
    return `${scope.principalId} ${scope.route} ${scope.key}`;
  }

  reserve(scope: IdempotencyScope, requestHash: string): Promise<Reservation> {
    const existing = this.records.get(this.#id(scope));
    if (existing === undefined) {
      this.records.set(this.#id(scope), { hash: requestHash, status: 0, body: null });
      return Promise.resolve({ kind: 'reserved' });
    }
    if (existing.hash !== requestHash) return Promise.resolve({ kind: 'mismatch' });
    if (existing.status === 0) return Promise.resolve({ kind: 'in_progress' });
    return Promise.resolve({ kind: 'replay', statusCode: existing.status, body: existing.body });
  }

  complete(scope: IdempotencyScope, requestHash: string, statusCode: number, body: unknown): Promise<void> {
    const existing = this.records.get(this.#id(scope));
    if (existing?.hash === requestHash && existing.status === 0) existing.status = statusCode;
    if (existing) existing.body = body;
    return Promise.resolve();
  }

  release(scope: IdempotencyScope, requestHash: string): Promise<void> {
    const existing = this.records.get(this.#id(scope));
    if (existing?.hash === requestHash && existing.status === 0) this.records.delete(this.#id(scope));
    return Promise.resolve();
  }
}

/** A Db that only answers ping (unit tests never reach repositories). */
export const pingOnlyDb: Pick<Db, 'ping' | 'system'> = {
  ping: () => Promise.resolve(),
  system: () => Promise.reject(new Error('no database in unit tests')),
};

export const TURN_ID = '44444444-4444-4444-8444-444444444444';

export function acceptedEvent(ordinal = 1): TurnStreamEvent {
  return { event: 'turn.accepted', turnId: TURN_ID, ordinal };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
