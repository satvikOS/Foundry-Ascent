/**
 * Migration 0009 (fixes from the review of 5105c40), against real transactions: a turn never lands on a
 * deleted conversation however the two interleave, and risky first messages never title a conversation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbError } from '../errors.js';
import { p } from '../params.js';
import { type SeedResult } from '../seed/seed.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import * as assignmentsRepo from './assignments.js';
import * as sessionsRepo from './sessions.js';
import * as turnsRepo from './turns.js';

type Ctx = ReturnType<typeof makeContext>;
type Venture = SeedResult['ventures'][number];

let t: TestDatabase;
let seed: SeedResult;
let quietquad: Venture;
let maya: Ctx;
let corin: Ctx;

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise with its resolver, to hold a transaction open at a chosen point. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Tracks whether a promise settled, without changing its outcome. */
function watch<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false;
  const tracked = promise.then(
    (value) => {
      done = true;
      return value;
    },
    (err: unknown) => {
      done = true;
      throw err;
    },
  );
  tracked.catch(() => undefined);
  return { promise: tracked, settled: () => done };
}

async function newSession(ctx: Ctx, v: Venture): Promise<string> {
  return t.db.withContext(ctx, async (tx) => {
    const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, v.id));
    const session = await sessionsRepo.createSession(tx, {
      tenantId: seed.tenantId,
      ventureId: v.id,
      assignmentId: resolved.assignment.id,
      personaReleaseId: must(resolved.release).id,
      startedBy: ctx.principalId,
      mode: 'coach',
      privacy: 'standard',
      policyVersion: 'test',
    });
    return session.id;
  });
}

function turnInput(ctx: Ctx, v: Venture, sessionId: string, text: string, riskLabel = 'none') {
  return {
    tenantId: seed.tenantId,
    ventureId: v.id,
    sessionId,
    authorId: ctx.principalId,
    mode: 'coach' as const,
    founderText: text,
    riskLabel,
  };
}

/** The conversation row as stored (owner role: deleted ones included). */
async function storedSession(id: string): Promise<{ title: string | null; deleted: boolean }> {
  const r = await t.db.system((sx) =>
    sx.query('SELECT title, deleted_at IS NOT NULL AS deleted FROM coaching_sessions WHERE id = :id', {
      id: p.uuid(id),
    }),
  );
  const row = must(r.rows[0]);
  return { title: (row.title as string | null) ?? null, deleted: row.deleted === true };
}

async function storedTurns(sessionId: string): Promise<{ founder_text: string; status: string }[]> {
  const r = await t.db.system((sx) =>
    sx.query('SELECT founder_text, status FROM turns WHERE session_id = :id ORDER BY ordinal', {
      id: p.uuid(sessionId),
    }),
  );
  return r.rows.map((row) => ({ founder_text: String(row.founder_text), status: String(row.status) }));
}

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  seed = must(t.seed);
  quietquad = must(seed.ventures.find((v) => v.key === 'quietquad'));
  maya = makeContext(must(seed.principals.maya), seed.tenantId);
  corin = makeContext(must(seed.principals['eir-corin']), seed.tenantId);
});
afterAll(async () => {
  await t.cleanup();
});

describe('a turn and the delete of its conversation', () => {
  it('a turn inserted while the delete is committing waits for it, then is refused', async () => {
    const sessionId = await newSession(maya, quietquad);
    await t.db.withContext(maya, (tx) =>
      turnsRepo.createTurn(tx, turnInput(maya, quietquad, sessionId, 'Pricing the pilot')),
    );
    const deleting = gate();
    const deleted = gate();
    const deletion = t.db.withContext(maya, async (tx) => {
      expect(await sessionsRepo.softDeleteSession(tx, sessionId)).toBe(true);
      deleted.open();
      await deleting.promise;
    });
    await deleted.promise;
    // A second connection adds a turn while the delete is still uncommitted.
    const late = watch(
      t.db.withContext(maya, (tx) =>
        turnsRepo.createTurn(tx, turnInput(maya, quietquad, sessionId, 'Something I want gone at once')),
      ),
    );
    await pause(300);
    expect(late.settled()).toBe(false);
    deleting.open();
    await deletion;
    const err: unknown = await late.promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).sqlState).toBe('55000');
    // Nothing of the late message was stored, and the conversation was not re-titled from it.
    expect(await storedTurns(sessionId)).toEqual([
      { founder_text: '[deleted conversation]', status: 'failed' },
    ]);
    expect(await storedSession(sessionId)).toEqual({ title: null, deleted: true });
  });

  it('the turn admission lock sees a delete that committed first', async () => {
    const sessionId = await newSession(maya, quietquad);
    expect(await t.db.withContext(maya, (tx) => sessionsRepo.lockSessionForTurn(tx, sessionId))).toBe(true);
    expect(await t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, sessionId))).toBe(true);
    expect(await t.db.withContext(maya, (tx) => sessionsRepo.lockSessionForTurn(tx, sessionId))).toBe(false);
    // The database refuses the insert even without that check.
    await expect(
      t.db.withContext(maya, (tx) =>
        turnsRepo.createTurn(tx, turnInput(maya, quietquad, sessionId, 'After the delete')),
      ),
    ).rejects.toMatchObject({ sqlState: '55000' });
    expect(await storedTurns(sessionId)).toEqual([]);
  });

  it('a delete that comes after the admission lock waits for the turn, then erases it', async () => {
    const sessionId = await newSession(maya, quietquad);
    const admitted = gate();
    const committing = gate();
    const admission = t.db.withContext(maya, async (tx) => {
      expect(await sessionsRepo.lockSessionForTurn(tx, sessionId)).toBe(true);
      await turnsRepo.createTurn(tx, turnInput(maya, quietquad, sessionId, 'Sent just before the delete'));
      admitted.open();
      await committing.promise;
    });
    await admitted.promise;
    const deletion = watch(t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, sessionId)));
    await pause(300);
    expect(deletion.settled()).toBe(false);
    committing.open();
    await admission;
    expect(await deletion.promise).toBe(true);
    // The pending turn was failed (a late answer is never stored) and its words erased.
    expect(await storedTurns(sessionId)).toEqual([
      { founder_text: '[deleted conversation]', status: 'failed' },
    ]);
    expect(await storedSession(sessionId)).toEqual({ title: null, deleted: true });
  });

  it('an ended conversation is refused by the admission lock', async () => {
    const sessionId = await newSession(maya, quietquad);
    await t.db.withContext(maya, (tx) => sessionsRepo.endSession(tx, { sessionId, recap: null }));
    expect(await t.db.withContext(maya, (tx) => sessionsRepo.lockSessionForTurn(tx, sessionId))).toBe(false);
  });

  it('the review queue never lists a turn of a deleted conversation', async () => {
    const sessionId = await newSession(maya, quietquad);
    const turn = await t.db.withContext(maya, async (tx) => {
      const created = await turnsRepo.createTurn(
        tx,
        turnInput(maya, quietquad, sessionId, 'Sampled question'),
      );
      await turnsRepo.finishTurn(tx, { turnId: created.id, status: 'completed', sampledForReview: true });
      return created;
    });
    const queued = async (): Promise<boolean> =>
      (
        await t.db.withContext(corin, (tx) =>
          turnsRepo.listReviewQueue(tx, { reviewerId: corin.principalId }),
        )
      ).some((row) => row.turn.id === turn.id);
    expect(await queued()).toBe(true);
    expect(await t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, sessionId))).toBe(true);
    // Deleting un-samples the turn; a turn sampled after the delete (the race a late answer could win) stays out.
    await t.db.system((sx) =>
      sx.query('UPDATE turns SET sampled_for_review = true WHERE id = :id', { id: p.uuid(turn.id) }),
    );
    expect(await queued()).toBe(false);
  });
});

describe('conversation titles from risky messages', () => {
  it.each([['crisis'], ['high']])(
    'a first message labelled %s never titles the conversation; the next ordinary one does',
    async (label) => {
      const sessionId = await newSession(maya, quietquad);
      await t.db.withContext(maya, (tx) =>
        turnsRepo.createTurn(
          tx,
          turnInput(maya, quietquad, sessionId, 'The words of a risky message', label),
        ),
      );
      expect((await storedSession(sessionId)).title).toBeNull();
      await t.db.withContext(maya, (tx) =>
        turnsRepo.createTurn(tx, turnInput(maya, quietquad, sessionId, 'How should we price the pilot?')),
      );
      expect((await storedSession(sessionId)).title).toBe('How should we price the pilot?');
    },
  );
});
