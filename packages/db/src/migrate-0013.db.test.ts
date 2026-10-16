/**
 * Migration 0013 (memory the vEIR keeps by itself) on top of the schema production has, with memory the previous
 * code wrote: it applies cleanly as the non-superuser owner, keeps the pending AI proposals automatically with a
 * system event (EIR proposals stay proposals), admits an AI item without an approver only when it records that
 * it was kept automatically, erases on a conversation's deletion what was kept automatically from that
 * conversation alone (and only unlinks what other conversations support too), and re-runs without changes.
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

  it('keeps pending AI proposals automatically, with a system event; EIR proposals stay proposals', async () => {
    expect(await row(legacyAi)).toMatchObject({ status: 'confirmed', approved_by: null, kept: true });
    expect(await row(legacyEir)).toMatchObject({ status: 'proposed', kept: false });
    expect((await history(legacyAi)).at(-1)).toEqual({
      action: 'approved',
      diff: { to: 'confirmed', system: true, reason: 'kept_automatically' },
    });
    // The founder sees it as kept automatically, never as approved by a person.
    const seen = await t.db.withContext(maya(), (tx) => memoryRepo.getMemory(tx, legacyAi));
    expect(seen).toMatchObject({ status: 'confirmed', keptAutomatically: true, approvedBy: null });
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
