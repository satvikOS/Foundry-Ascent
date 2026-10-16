/**
 * Migration 0009 (fixes from the review of 5105c40), against real transactions: a turn never lands on a
 * deleted conversation however the two interleave, risky first messages never title a conversation, and what
 * a founder heard of a reply is erased with the conversation even when a barge-in races the erasure, and
 * deleting a conversation purges the stored idempotent responses that carry what it erases and every opener
 * of unknown origin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbError } from '../errors.js';
import { type AppExecutor } from '../executor.js';
import { p } from '../params.js';
import { type SeedResult } from '../seed/seed.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import * as assignmentsRepo from './assignments.js';
import * as callsRepo from './calls.js';
import * as idempotencyRepo from './idempotency.js';
import * as memoryRepo from './memory.js';
import * as notebooksRepo from './notebooks.js';
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

async function newSession(
  ctx: Ctx,
  v: Venture,
  privacy: 'standard' | 'ephemeral' = 'standard',
): Promise<string> {
  return t.db.withContext(ctx, async (tx) => {
    const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, v.id));
    const session = await sessionsRepo.createSession(tx, {
      tenantId: seed.tenantId,
      ventureId: v.id,
      assignmentId: resolved.assignment.id,
      personaReleaseId: must(resolved.release).id,
      startedBy: ctx.principalId,
      mode: 'coach',
      privacy,
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

describe('what the founder heard, when a barge-in races the erasure', () => {
  const HEARD = 'Run it in exam weeks.';

  /** A conversation with a live call and an answered spoken turn of it. */
  async function spokenTurn(
    ctx: Ctx,
    privacy: 'standard' | 'ephemeral' = 'standard',
  ): Promise<{ sessionId: string; callId: string; turnId: string }> {
    const sessionId = await newSession(ctx, quietquad, privacy);
    return t.db.withContext(ctx, async (tx) => {
      const call = await callsRepo.startCall(tx, {
        tenantId: seed.tenantId,
        ventureId: quietquad.id,
        sessionId,
        personaId: quietquad.personaId,
        startedBy: ctx.principalId,
        provider: 'builtin',
        inputMode: 'transcribe',
        voiceId: 'Matthew',
        maxSeconds: 1800,
      });
      const turn = await turnsRepo.createTurn(tx, {
        ...turnInput(ctx, quietquad, sessionId, 'Spoken words'),
        channel: 'voice',
      });
      await tx.query(
        `UPDATE turns SET status = 'completed', response = :r, completed_at = now() WHERE id = :id`,
        { id: p.uuid(turn.id), r: p.json({ answer: 'Run it in exam weeks. Then compare.' }) },
      );
      await callsRepo.endCall(tx, { callId: call.id, reason: 'user', detail: 'client_user' });
      return { sessionId, callId: call.id, turnId: turn.id };
    });
  }

  async function heard(turnId: string): Promise<{ founder_text: string; heard_text: string | null }> {
    const r = await t.db.system((sx) =>
      sx.query('SELECT founder_text, heard_text FROM turns WHERE id = :id', { id: p.uuid(turnId) }),
    );
    const row = must(r.rows[0]);
    return { founder_text: String(row.founder_text), heard_text: (row.heard_text as string | null) ?? null };
  }

  function interrupt(ctx: Ctx, ids: { callId: string; turnId: string }) {
    return t.db.withContext(ctx, (tx) =>
      callsRepo.markTurnInterrupted(tx, {
        turnId: ids.turnId,
        callId: ids.callId,
        authorId: ctx.principalId,
        heardSeq: 0,
        heardText: HEARD,
      }),
    );
  }

  /** Runs `erase` in a transaction held open while a barge-in is recorded, then commits it. */
  async function racing(
    erase: (tx: AppExecutor) => Promise<void>,
    ids: { callId: string; turnId: string },
  ): Promise<callsRepo.TurnInterruption | null> {
    const erased = gate();
    const committing = gate();
    const erasure = t.db.withContext(maya, async (tx) => {
      await erase(tx);
      erased.open();
      await committing.promise;
    });
    await erased.promise;
    const bargeIn = watch(interrupt(maya, ids));
    await pause(300);
    expect(bargeIn.settled()).toBe(false);
    committing.open();
    await erasure;
    return bargeIn.promise;
  }

  it('a barge-in while the conversation is being deleted records nothing', async () => {
    const ids = await spokenTurn(maya);
    const recorded = await racing(async (tx) => {
      expect(await sessionsRepo.softDeleteSession(tx, ids.sessionId)).toBe(true);
    }, ids);
    expect(recorded).toBeNull();
    expect(await heard(ids.turnId)).toEqual({ founder_text: '[deleted conversation]', heard_text: null });
  });

  it('a barge-in while a temporary chat is being ended records nothing', async () => {
    const ids = await spokenTurn(maya, 'ephemeral');
    const recorded = await racing(async (tx) => {
      expect(await sessionsRepo.endSession(tx, { sessionId: ids.sessionId, recap: null })).not.toBeNull();
      await turnsRepo.redactSessionTurns(tx, ids.sessionId);
    }, ids);
    expect(recorded).toBeNull();
    expect(await heard(ids.turnId)).toEqual({
      founder_text: turnsRepo.EPHEMERAL_REDACTION_TEXT,
      heard_text: null,
    });
  });

  /** Heard words left on a turn whose own words are already redacted (what the race used to leave). */
  async function leftOver(turnId: string, founderText: string): Promise<void> {
    await t.db.system(async (sx) => {
      await sx.query('UPDATE turns SET founder_text = :text, response = NULL WHERE id = :id', {
        id: p.uuid(turnId),
        text: p.text(founderText),
      });
      // Only the heard columns: the redaction trigger does not fire.
      await sx.query(
        'UPDATE turns SET heard_seq = 0, interrupted_at = now(), heard_text = :heard WHERE id = :id',
        { id: p.uuid(turnId), heard: p.text(HEARD) },
      );
    });
    expect((await heard(turnId)).heard_text).toBe(HEARD);
  }

  it('deleting, ending a temporary chat and the daily sweep each clear heard words left on redacted turns', async () => {
    // Deleting a conversation whose turn's words were already redacted.
    const deleted = await spokenTurn(maya);
    await leftOver(deleted.turnId, '[deleted conversation]');
    expect(await t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, deleted.sessionId))).toBe(
      true,
    );
    expect((await heard(deleted.turnId)).heard_text).toBeNull();

    // Ending a temporary chat redacts again.
    const ended = await spokenTurn(maya, 'ephemeral');
    await t.db.withContext(maya, (tx) =>
      sessionsRepo.endSession(tx, { sessionId: ended.sessionId, recap: null }),
    );
    await leftOver(ended.turnId, turnsRepo.EPHEMERAL_REDACTION_TEXT);
    await t.db.withContext(maya, (tx) => turnsRepo.redactSessionTurns(tx, ended.sessionId));
    expect((await heard(ended.turnId)).heard_text).toBeNull();

    // The daily sweep of ended temporary chats.
    await leftOver(ended.turnId, turnsRepo.EPHEMERAL_REDACTION_TEXT);
    const sweep = await t.db.system((sx) =>
      sessionsRepo.expireStaleEphemeralSessions(sx, { idleSeconds: 86_400 }),
    );
    expect(sweep.turnsRedacted).toBeGreaterThanOrEqual(1);
    expect((await heard(ended.turnId)).heard_text).toBeNull();
  });
});

describe('stored idempotent responses of what a delete erases', () => {
  let keys = 0;

  /** Stores a 2xx response for one of Maya's requests, as the API's idempotency store does. */
  async function stored(route: string, response: unknown): Promise<idempotencyRepo.IdempotencyKey> {
    keys += 1;
    const key = { principalId: maya.principalId, route, key: `review-privacy-${keys}` };
    expect(
      await t.db.system((sx) =>
        idempotencyRepo.saveIdempotencyRecord(sx, { ...key, requestHash: 'h', statusCode: 200, response }),
      ),
    ).toBe(true);
    return key;
  }

  const replayable = async (key: idempotencyRepo.IdempotencyKey): Promise<boolean> =>
    (await t.db.system((sx) => idempotencyRepo.getIdempotencyRecord(sx, key))) !== null;

  it('purges responses holding a memory proposal drawn from the deleted conversation', async () => {
    const sessionId = await newSession(maya, quietquad);
    const rejected = await t.db.withContext(maya, (tx) =>
      memoryRepo.createMemory(tx, {
        tenantId: seed.tenantId,
        ventureId: quietquad.id,
        type: 'insight',
        title: 'Exam-week demand',
        content: 'Students said they would pay for a quiet seat during exams.',
        origin: 'ai',
        status: 'rejected',
        createdBy: maya.principalId,
        visibility: 'team',
        sourceRefs: [{ kind: 'session', id: sessionId }],
      }),
    );
    // PATCH /memory/:id (reject) answered with the proposal: its id and text, not the conversation's id.
    const review = await stored('PATCH /memory/:id', {
      id: rejected.id,
      title: rejected.title,
      content: rejected.content,
      status: 'rejected',
    });
    const unrelated = await stored('PATCH /memory/:id', { id: '00000000-0000-4000-8000-000000000001' });
    expect(await t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, sessionId))).toBe(true);
    expect(await replayable(review)).toBe(false);
    expect(await replayable(unrelated)).toBe(true);
  });

  it('purges the start response of a conversation whose copy of the opener is erased', async () => {
    const source = await newSession(maya, quietquad);
    const later = await t.db.withContext(maya, async (tx) => {
      const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, quietquad.id));
      return sessionsRepo.createSession(tx, {
        tenantId: seed.tenantId,
        ventureId: quietquad.id,
        assignmentId: resolved.assignment.id,
        personaReleaseId: must(resolved.release).id,
        startedBy: maya.principalId,
        mode: 'coach',
        privacy: 'standard',
        policyVersion: 'test',
        opener: 'Last time you planned five library-staff interviews. How did they go?',
        openerSourceSessionId: source,
      });
    });
    // POST /ventures/:id/sessions answered with the new conversation and its opener.
    const start = await stored('POST /ventures/:id/sessions', { id: later.id, opener: later.opener });
    expect(await t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, source))).toBe(true);
    const copy = await t.db.withContext(maya, (tx) => sessionsRepo.getSession(tx, later.id));
    expect(copy?.opener).toBeNull();
    expect(await replayable(start)).toBe(false);
  });
});

describe('openers of unknown origin', () => {
  /** A conversation that opened with `opener`, recorded with where it came from. */
  async function openedWith(
    opener: string,
    origin: { sourceSessionId?: string; byPerson?: boolean },
  ): Promise<string> {
    return t.db.withContext(maya, async (tx) => {
      const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, quietquad.id));
      const session = await sessionsRepo.createSession(tx, {
        tenantId: seed.tenantId,
        ventureId: quietquad.id,
        assignmentId: resolved.assignment.id,
        personaReleaseId: must(resolved.release).id,
        startedBy: maya.principalId,
        mode: 'coach',
        privacy: 'standard',
        policyVersion: 'test',
        opener,
        openerSourceSessionId: origin.sourceSessionId ?? null,
        openerByPerson: origin.byPerson ?? false,
      });
      return session.id;
    });
  }

  async function openerOf(sessionId: string): Promise<string | null> {
    const r = await t.db.system((sx) =>
      sx.query('SELECT opener FROM coaching_sessions WHERE id = :id', { id: p.uuid(sessionId) }),
    );
    return (must(r.rows[0]).opener as string | null) ?? null;
  }

  it('deleting any conversation of the venture erases them, in conversations and in the notebook', async () => {
    const elsewhere = await newSession(maya, quietquad);
    const unknown = await openedWith('Did the deposit question get an answer?', {});
    const persons = await openedWith('How did the call with the second library go?', { byPerson: true });
    const drawn = await openedWith('What did the staff interviews show?', { sourceSessionId: elsewhere });
    // The notebook's own opener, written by distillation without a source (a legacy write).
    const current = await t.db.system((sx) =>
      notebooksRepo.getNotebook(sx, { ventureId: quietquad.id, personaId: quietquad.personaId }),
    );
    const saved = await t.db.system((sx) =>
      notebooksRepo.saveNotebook(sx, {
        tenantId: seed.tenantId,
        ventureId: quietquad.id,
        personaId: quietquad.personaId,
        expectedVersion: current?.version ?? 0,
        content: {
          ...(current?.content ?? notebooksRepo.EMPTY_NOTEBOOK),
          nextOpener: 'Did the deposit question get an answer?',
        },
        suppressed: current?.suppressed ?? [],
        editedBy: 'veir',
      }),
    );
    expect(saved?.content.nextOpenerSource).toBeUndefined();

    // An undistilled conversation no line cites: before, nothing tied the openers to it.
    const deleted = await newSession(maya, quietquad);
    expect(await t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, deleted))).toBe(true);
    expect(await openerOf(unknown)).toBeNull();
    expect(await openerOf(persons)).toBe('How did the call with the second library go?');
    expect(await openerOf(drawn)).toBe('What did the staff interviews show?');
    const after = await t.db.system((sx) =>
      notebooksRepo.getNotebook(sx, { ventureId: quietquad.id, personaId: quietquad.personaId }),
    );
    expect(after?.content.nextOpener).toBeNull();
  });

  it('a copy is never both drawn from a conversation and written by a person', async () => {
    const source = await newSession(maya, quietquad);
    await expect(
      t.db.system((sx) =>
        sx.query(
          `UPDATE coaching_sessions SET opener = 'x', opener_source_session_id = :s, opener_by_person = true
           WHERE id = :s`,
          { s: p.uuid(source) },
        ),
      ),
    ).rejects.toMatchObject({ sqlState: '23514' });
  });
});

describe('notebook lines drawn from several conversations', () => {
  async function saveLines(lines: notebooksRepo.NotebookContent['commitments']): Promise<void> {
    const current = await t.db.system((sx) =>
      notebooksRepo.getNotebook(sx, { ventureId: quietquad.id, personaId: quietquad.personaId }),
    );
    const saved = await t.db.system((sx) =>
      notebooksRepo.saveNotebook(sx, {
        tenantId: seed.tenantId,
        ventureId: quietquad.id,
        personaId: quietquad.personaId,
        expectedVersion: current?.version ?? 0,
        content: { ...(current?.content ?? notebooksRepo.EMPTY_NOTEBOOK), commitments: lines },
        suppressed: current?.suppressed ?? [],
        editedBy: 'veir',
      }),
    );
    expect(saved).not.toBeNull();
  }

  const lineIds = async (): Promise<string[]> =>
    (
      await t.db.system((sx) =>
        notebooksRepo.getNotebook(sx, { ventureId: quietquad.id, personaId: quietquad.personaId }),
      )
    )?.content.commitments.map((c) => c.id) ?? [];

  it('deleting a conversation removes a line that lists it among its earlier sources', async () => {
    const earlier = await newSession(maya, quietquad);
    const later = await newSession(maya, quietquad);
    const other = await newSession(maya, quietquad);
    const line = (id: string, sourceSessionId: string, sourceSessionIds?: string[]) => ({
      id,
      text: `Commitment ${id}`,
      due: null,
      status: 'open' as const,
      sourceSessionId,
      ...(sourceSessionIds ? { sourceSessionIds } : {}),
      createdAt: '2026-10-16T10:00:00.000Z',
    });
    await saveLines([line('cm-reworded', later, [earlier]), line('cm-other', other)]);
    expect(await t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, earlier))).toBe(true);
    expect(await lineIds()).toEqual(['cm-other']);
  });

  it.each([
    ['not an array', 'x'],
    ['not conversation ids', ['not-a-uuid']],
    [
      'more than 20',
      Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`),
    ],
  ])('the database refuses earlier sources that are %s', async (_what, sources) => {
    const current = await t.db.system((sx) =>
      notebooksRepo.getNotebook(sx, { ventureId: quietquad.id, personaId: quietquad.personaId }),
    );
    const content = {
      ...(current?.content ?? notebooksRepo.EMPTY_NOTEBOOK),
      lastAdvice: [
        {
          id: 'la-bad',
          text: 'Advice',
          sourceSessionId: null,
          sourceSessionIds: sources,
          createdAt: '2026-10-16T10:00:00.000Z',
        },
      ],
    };
    await expect(
      t.db.system((sx) =>
        sx.query('UPDATE veir_notebooks SET content = :content WHERE venture_id = :v AND persona_id = :p', {
          content: p.json(content),
          v: p.uuid(quietquad.id),
          p: p.uuid(quietquad.personaId),
        }),
      ),
    ).rejects.toMatchObject({ sqlState: '23514' });
  });
});
