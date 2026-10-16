/**
 * Migration 0013 (memory the vEIR keeps by itself) on top of the schema production has, with memory the previous
 * code wrote: it applies cleanly as the non-superuser owner, leaves pending proposals as they are (the daily
 * maintenance settles AI ones with the checks new memory goes through; EIR proposals stay proposals), admits an
 * AI item without an approver only when it records that it was kept automatically, erases on a conversation's
 * deletion what was kept automatically from that conversation alone (and only unlinks what other conversations
 * support too), keeps what the founder made the vEIR forget as fingerprints only the founder's team can use and
 * that go with their conversation, takes back only items it kept itself, accepts the notebook's next topic, and
 * re-runs without changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from './db.js';
import { DbError } from './errors.js';
import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import { assignmentsRepo, memoryRepo, sessionsRepo } from './repositories/index.js';
import { seedDatabase, type SeedConfig, type SeedResult } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, makeContext, type TestDatabase } from './testing/test-database.js';

const KEEP = MIGRATIONS.find((m) => m.version === '0013_automatic_memory');
const BEFORE = MIGRATIONS.filter((m) => m.version < '0013');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };

let t: TestDatabase;
let seed: SeedResult;

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

async function sqlState(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    if (err instanceof DbError) return err.sqlState;
    throw err;
  }
}

const venture = () => must(seed.ventures.find((v) => v.key === 'quietquad'));
const maya = () => makeContext(must(seed.principals.maya), seed.tenantId);

interface Row extends Record<string, unknown> {
  id: string;
  status: string;
  approved_by: string | null;
  kept: boolean;
  source_refs: { kind: string; id: string }[];
}

async function row(id: string): Promise<Row> {
  const rows = await t.db.system((sx) =>
    sx.query(
      `SELECT id, status, approved_by, auto_kept_at IS NOT NULL AS kept, source_refs FROM memory_objects WHERE id = :id`,
      { id: p.uuid(id) },
    ),
  );
  const found = must(rows.rows[0]);
  return { ...found, source_refs: json(found.source_refs) } as Row;
}

/** A jsonb value as the executor returns it (text on this driver). */
function json(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/** The history of an item: actions and diffs, oldest first. */
async function history(id: string): Promise<{ action: string; diff: unknown }[]> {
  const rows = await t.db.system((sx) =>
    sx.query(`SELECT action, diff FROM memory_events WHERE memory_id = :id ORDER BY id`, { id: p.uuid(id) }),
  );
  return rows.rows.map((r) => ({ action: String(r.action), diff: json(r.diff) }));
}

/** An item written the way the code before 0013 wrote one (raw insert as the owner, no `auto_kept_at`). */
async function legacyItem(args: {
  origin: 'ai' | 'eir';
  status: 'proposed' | 'confirmed';
  refs: { kind: string; id: string }[];
}): Promise<string> {
  const rows = await t.db.system((sx) =>
    sx.query(
      `WITH ins AS (
         INSERT INTO memory_objects (tenant_id, venture_id, type, title, content, status, visibility, origin,
                                     created_by, approved_by, approved_at, source_refs)
         VALUES (:tenant, :venture, 'insight', 'Legacy item', 'Written before 0013.', :status, 'team', :origin,
                 :author, CASE WHEN :status = 'confirmed' THEN CAST(:author AS uuid) END,
                 CASE WHEN :status = 'confirmed' THEN now() END, :refs)
         RETURNING id, venture_id, created_by)
       , ev AS (INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
                SELECT id, venture_id, created_by, 'proposed', '{}'::jsonb FROM ins)
       SELECT id FROM ins`,
      {
        tenant: p.uuid(seed.tenantId),
        venture: p.uuid(venture().id),
        status: p.text(args.status),
        origin: p.text(args.origin),
        author: p.uuid(must(seed.principals.maya)),
        refs: p.json(args.refs),
      },
    ),
  );
  return String(must(rows.rows[0]).id);
}

/** A standard conversation of Maya's with one completed turn; returns its id and the turn's id. */
async function conversation(): Promise<{ sessionId: string; turnId: string }> {
  return t.db.withContext(maya(), async (tx) => {
    const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, venture().id));
    const session = await sessionsRepo.createSession(tx, {
      tenantId: seed.tenantId,
      ventureId: venture().id,
      assignmentId: resolved.assignment.id,
      personaReleaseId: must(resolved.release).id,
      startedBy: maya().principalId,
      mode: 'coach',
      privacy: 'standard',
      policyVersion: 'test',
    });
    const turn = await tx.query(
      `INSERT INTO turns (tenant_id, venture_id, session_id, ordinal, author_id, mode, founder_text, status)
       VALUES (:tenant, :venture, :session, 1, :author, 'coach', 'Pricing per library?', 'completed')
       RETURNING id`,
      {
        tenant: p.uuid(seed.tenantId),
        venture: p.uuid(venture().id),
        session: p.uuid(session.id),
        author: p.uuid(maya().principalId),
      },
    );
    return { sessionId: session.id, turnId: String(must(turn.rows[0]).id) };
  });
}

/** Memory columns, the approval constraint and the app functions with their grants: equal after a re-run. */
async function schemaFingerprint(db: Db): Promise<string> {
  return db.system(async (sx) => {
    const parts: unknown[] = [];
    for (const sql of [
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'memory_objects'::regclass ORDER BY conname`,
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_name = 'memory_objects' ORDER BY column_name`,
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src,
                coalesce(array_to_string(p.proacl, ','), '') AS acl
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' ORDER BY 1, 2`,
    ]) {
      parts.push((await sx.query(sql)).rows);
    }
    return JSON.stringify(parts);
  });
}

let legacyAi: string;
let legacyEir: string;

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  await migrate(t.db, { migrations: BEFORE });
  seed = await seedDatabase(t.db, CONFIG);
  legacyAi = await legacyItem({ origin: 'ai', status: 'proposed', refs: [{ kind: 'manual', id: 'legacy' }] });
  legacyEir = await legacyItem({ origin: 'eir', status: 'proposed', refs: [] });
});
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0013_automatic_memory', () => {
  it('refuses durable AI memory nobody approved before it applies', async () => {
    expect(
      await sqlState(
        t.db.system((sx) =>
          sx.query(`UPDATE memory_objects SET status = 'confirmed' WHERE id = :id`, { id: p.uuid(legacyAi) }),
        ),
      ),
    ).toBe('23514');
  });

  it('applies cleanly on top of the earlier migrations with existing memory, as the non-superuser owner', async () => {
    const report = await migrate(t.db);
    // Later migrations follow in the same run (their own suites cover them).
    expect(report.applied).toEqual(MIGRATIONS.map((m) => m.version).filter((v) => v >= '0013'));
    expect(report.applied[0]).toBe('0013_automatic_memory');
    expect(KEEP && splitStatements(KEEP.sql).length).toBeGreaterThanOrEqual(6);
  });

  it('leaves pending proposals as they are: SQL cannot tell a restatement or the coach’s advice', async () => {
    // Production had duplicates of the coach's own advice waiting next to the founder's goal; the daily
    // maintenance runs each AI proposal through the checks new memory goes through (core memory.db.test.ts).
    expect(await row(legacyAi)).toMatchObject({ status: 'proposed', approved_by: null, kept: false });
    expect(await row(legacyEir)).toMatchObject({ status: 'proposed', kept: false });
    expect((await history(legacyAi)).map((e) => e.action)).toEqual(['proposed']);
  });

  it('admits an AI item without an approver only when it records that it was kept automatically', async () => {
    const kept = await t.db.withContext(maya(), (tx) =>
      memoryRepo.createMemory(tx, {
        tenantId: seed.tenantId,
        ventureId: venture().id,
        type: 'fact',
        title: 'Kept by the vEIR',
        content: 'Learned from a conversation.',
        origin: 'ai',
        keptAutomatically: true,
        createdBy: maya().principalId,
      }),
    );
    expect(kept).toMatchObject({ status: 'confirmed', keptAutomatically: true, approvedBy: null });
    expect(
      await sqlState(
        t.db.system((sx) =>
          sx.query(`UPDATE memory_objects SET auto_kept_at = NULL WHERE id = :id`, { id: p.uuid(kept.id) }),
        ),
      ),
    ).toBe('23514');
    // A founder's own item and an approved one are unchanged by the rule.
    const founders = await t.db.withContext(maya(), (tx) =>
      memoryRepo.createMemory(tx, {
        tenantId: seed.tenantId,
        ventureId: venture().id,
        type: 'fact',
        title: 'Written by Maya',
        content: 'Her own words.',
        status: 'confirmed',
        origin: 'founder',
        createdBy: maya().principalId,
      }),
    );
    expect(founders).toMatchObject({ keptAutomatically: false, approvedBy: { id: maya().principalId } });
  });

  it('erases on deletion what was kept from that conversation alone, and unlinks what others support', async () => {
    const a = await conversation();
    const b = await conversation();
    const keep = (refs: { kind: 'session' | 'turn'; id: string }[], title: string) =>
      t.db.withContext(maya(), (tx) =>
        memoryRepo.createMemory(tx, {
          tenantId: seed.tenantId,
          ventureId: venture().id,
          type: 'insight',
          title,
          content: `${title}.`,
          origin: 'ai',
          keptAutomatically: true,
          createdBy: maya().principalId,
          sourceRefs: refs,
        }),
      );
    const onlyA = await keep([{ kind: 'session', id: a.sessionId }], 'Only from A');
    const turnOfA = await keep([{ kind: 'turn', id: a.turnId }], 'From a turn of A');
    const both = await keep(
      [
        { kind: 'session', id: a.sessionId },
        { kind: 'session', id: b.sessionId },
      ],
      'From A and B',
    );
    const onlyB = await keep([{ kind: 'session', id: b.sessionId }], 'Only from B');
    // Kept automatically, then approved by a person: theirs now.
    const approved = await keep([{ kind: 'session', id: a.sessionId }], 'Approved after');
    await t.db.withContext(maya(), async (tx) => {
      expect(
        await memoryRepo.disputeMemory(tx, {
          memoryId: approved.id,
          actorId: maya().principalId,
          reason: 'x',
        }),
      ).not.toBeNull();
      expect(
        await memoryRepo.approveMemory(tx, { memoryId: approved.id, actorId: maya().principalId }),
      ).not.toBeNull();
    });

    expect(await t.db.withContext(maya(), (tx) => sessionsRepo.softDeleteSession(tx, a.sessionId))).toBe(
      true,
    );

    for (const id of [onlyA.id, turnOfA.id]) {
      expect(await row(id)).toMatchObject({ status: 'deleted', source_refs: [] });
    }
    const unlinked = await row(both.id);
    expect(unlinked.status).toBe('confirmed');
    expect(unlinked.source_refs).toEqual([{ kind: 'session', id: b.sessionId }]);
    expect(await row(onlyB.id)).toMatchObject({ status: 'confirmed' });
    expect(await row(approved.id)).toMatchObject({ status: 'confirmed', approved_by: maya().principalId });
    // The erased items' history names the deletion only.
    const erased = await history(onlyA.id);
    expect(erased.at(-1)).toEqual({ action: 'deleted', diff: { conversationDeleted: true } });
    expect(erased.slice(0, -1).map((e) => e.diff)).toEqual([{ redacted: true }]);
  });

  it('keeps what the founder made the vEIR forget as fingerprints, closed to app_rls, gone with the conversation', async () => {
    const a = await conversation();
    const b = await conversation();
    const item = await t.db.withContext(maya(), (tx) =>
      memoryRepo.createMemory(tx, {
        tenantId: seed.tenantId,
        ventureId: venture().id,
        type: 'preference',
        title: 'Personal goal',
        content: 'Maya wants the startup to make her rich quickly.',
        origin: 'ai',
        keptAutomatically: true,
        createdBy: maya().principalId,
        sourceRefs: [
          { kind: 'session', id: a.sessionId },
          { kind: 'turn', id: b.turnId },
        ],
      }),
    );
    const print = {
      type: 'preference' as const,
      titleKey: 'a'.repeat(32),
      contentKey: 'b'.repeat(32),
      numbersKey: 'c'.repeat(16),
      signature: 'd'.repeat(64),
    };
    // Nobody reads or writes the table directly as app_rls.
    expect(
      await sqlState(t.db.withContext(maya(), (tx) => tx.query('SELECT count(*) FROM memory_forgotten'))),
    ).toBe('42501');
    // Someone outside the venture records nothing.
    const priya = makeContext(must(seed.principals.priya), seed.tenantId);
    expect(
      await t.db.withContext(priya, (tx) =>
        memoryRepo.recordForgottenMemory(tx, { memoryId: item.id, reason: 'deleted', fingerprints: [print] }),
      ),
    ).toBe(0);
    // One row per conversation it was learned from (a session ref and a turn ref of another one).
    expect(
      await t.db.withContext(maya(), (tx) =>
        memoryRepo.recordForgottenMemory(tx, { memoryId: item.id, reason: 'deleted', fingerprints: [print] }),
      ),
    ).toBe(2);
    expect(await t.db.withContext(maya(), (tx) => memoryRepo.deleteMemory(tx, item.id))).toBe(1);
    const seen = await t.db.withContext(maya(), (tx) =>
      memoryRepo.listForgottenMemory(tx, { ventureId: venture().id }),
    );
    expect(seen.map((f) => f.sessionId).sort()).toEqual([a.sessionId, b.sessionId].sort());
    expect(seen[0]).toMatchObject({
      type: 'preference',
      titleKey: print.titleKey,
      signature: print.signature,
    });
    // Another venture's people see none of them.
    expect(
      await t.db.withContext(priya, (tx) => memoryRepo.listForgottenMemory(tx, { ventureId: venture().id })),
    ).toEqual([]);
    expect(
      (
        await t.db.system((sx) =>
          memoryRepo.listForgottenMemory(sx, { ventureId: venture().id, system: true }),
        )
      ).length,
    ).toBe(2);
    // Deleting a conversation takes its fingerprints with it; the other conversation's stay.
    expect(await t.db.withContext(maya(), (tx) => sessionsRepo.softDeleteSession(tx, a.sessionId))).toBe(
      true,
    );
    const left = await t.db.system((sx) =>
      memoryRepo.listForgottenMemory(sx, { ventureId: venture().id, system: true }),
    );
    expect(left.map((f) => f.sessionId)).toEqual([b.sessionId]);
  });

  it('takes back only an item the vEIR kept itself, nobody approved and nobody corrected', async () => {
    const kept = await t.db.withContext(maya(), (tx) =>
      memoryRepo.createMemory(tx, {
        tenantId: seed.tenantId,
        ventureId: venture().id,
        type: 'fact',
        title: 'Restated',
        content: 'Said twice in other words.',
        origin: 'ai',
        keptAutomatically: true,
        createdBy: maya().principalId,
      }),
    );
    const founders = await t.db.withContext(maya(), (tx) =>
      memoryRepo.createMemory(tx, {
        tenantId: seed.tenantId,
        ventureId: venture().id,
        type: 'fact',
        title: 'Hers',
        content: 'Written by Maya.',
        status: 'confirmed',
        origin: 'founder',
        createdBy: maya().principalId,
      }),
    );
    expect(
      await t.db.withContext(maya(), (tx) =>
        memoryRepo.discardKeptMemory(tx, { memoryId: founders.id, reason: 'duplicate', intoId: kept.id }),
      ),
    ).toBe(false);
    expect(
      await t.db.withContext(maya(), (tx) =>
        memoryRepo.discardKeptMemory(tx, { memoryId: kept.id, reason: 'duplicate', intoId: founders.id }),
      ),
    ).toBe(true);
    expect(await row(kept.id)).toMatchObject({ status: 'deleted', source_refs: [] });
    expect((await history(kept.id)).at(-1)).toEqual({
      action: 'deleted',
      diff: { system: true, reason: 'duplicate', into: founders.id },
    });
    expect(await row(founders.id)).toMatchObject({ status: 'confirmed' });
  });

  it('accepts the notebook’s next topic (a phrase of at most 120 characters), and clears it with its opener', async () => {
    const content = (topic: unknown) =>
      JSON.stringify({
        summary: '',
        founderProfile: [],
        commitments: [],
        openQuestions: [],
        lastAdvice: [],
        nextOpener: 'Last time you planned interviews. How did they go?',
        nextTopic: topic,
      });
    const valid = async (topic: unknown) =>
      (
        await t.db.system((sx) =>
          sx.query('SELECT app.notebook_content_valid(CAST(:c AS jsonb)) AS ok', {
            c: p.text(content(topic)),
          }),
        )
      ).rows[0]?.ok;
    expect(await valid('the five library-staff interviews you planned')).toBe(true);
    expect(await valid(null)).toBe(true);
    expect(await valid('x'.repeat(121))).toBe(false);
    expect(await valid(7)).toBe(false);
  });

  it('is idempotent: re-running every statement, then the runner, changes nothing', async () => {
    if (!KEEP) throw new Error('0013 missing');
    const before = await schemaFingerprint(t.db);
    const events = await t.db.system((sx) => sx.query('SELECT count(*)::int AS n FROM memory_events'));
    await t.db.system(async (sx) => {
      for (const statement of splitStatements(KEEP.sql)) await sx.query(statement);
    });
    expect(await schemaFingerprint(t.db)).toBe(before);
    const after = await t.db.system((sx) => sx.query('SELECT count(*)::int AS n FROM memory_events'));
    expect(after.rows[0]).toEqual(events.rows[0]);
    expect((await migrate(t.db)).applied).toEqual([]);
  });
});
