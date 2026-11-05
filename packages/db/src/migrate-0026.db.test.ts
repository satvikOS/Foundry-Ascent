/**
 * Migration 0026 (memory is automatic again) on a fixture that reproduces production after 0021: memory the vEIR
 * kept by itself before 2026-11-03 (plain, disputed, pinned, raised again), what 0021 did to it, and what students
 * and maintenance did between 0021 and 0026 (approved, rejected, deleted, corrected, retired as a restatement,
 * forgot something else from the same conversation), next to items 0021 never touched (an EIR proposal, an approved
 * AI item, a founder's own item, AI proposals left pending before and written after 0021). 0026 puts back exactly
 * the items 0021 demoted that nobody acted on since, with their old status and pin and a history event marked
 * `system`; it never brings back anything a student rejected, corrected or deleted; it leaves an item whose
 * conversation had something forgotten since to the daily maintenance; it re-runs without changes; and the
 * documented undo puts the restored items (and only those) back to `proposed`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import { assignmentsRepo, memoryRepo, sessionsRepo } from './repositories/index.js';
import { seedDatabase, type SeedConfig, type SeedResult } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, makeContext, type TestDatabase } from './testing/test-database.js';

const RESTORE = MIGRATIONS.find((m) => m.version === '0026_automatic_memory_restored');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };
const MARK = '0026_automatic_memory_restored';

let t: TestDatabase;
let seed: SeedResult;

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

const venture = () => must(seed.ventures.find((v) => v.key === 'quietquad'));
const maya = () => makeContext(must(seed.principals.maya), seed.tenantId);

interface Row {
  status: string;
  pinned: boolean;
  approved_by: string | null;
  kept: boolean;
}

async function row(id: string): Promise<Row> {
  const rows = await t.db.system((sx) =>
    sx.query(
      `SELECT status, pinned, approved_by, auto_kept_at IS NOT NULL AS kept FROM memory_objects WHERE id = :id`,
      { id: p.uuid(id) },
    ),
  );
  return must(rows.rows[0]) as unknown as Row;
}

/** Events of an item, oldest first. */
async function history(id: string): Promise<{ action: string; diff: Record<string, unknown> }[]> {
  const rows = await t.db.system((sx) =>
    sx.query(`SELECT action, diff FROM memory_events WHERE memory_id = :id ORDER BY id`, { id: p.uuid(id) }),
  );
  return rows.rows.map((r) => ({
    action: String(r.action),
    diff: (typeof r.diff === 'string' ? JSON.parse(r.diff) : r.diff) as Record<string, unknown>,
  }));
}

const restoredBy0026 = async (id: string) => (await history(id)).filter((e) => e.diff.migration === MARK);

/** A standard conversation of Maya's with one completed turn. */
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

/** Memory as the code of the time wrote it (as Maya, under RLS). */
function remember(
  title: string,
  options: {
    refs?: { kind: 'session' | 'turn'; id: string }[];
    origin?: 'ai' | 'eir' | 'founder';
    kept?: boolean;
    status?: 'proposed' | 'confirmed';
  } = {},
) {
  return t.db.withContext(maya(), (tx) =>
    memoryRepo.createMemory(tx, {
      tenantId: seed.tenantId,
      ventureId: venture().id,
      type: 'insight',
      title,
      content: `${title}, as the founder said it.`,
      origin: options.origin ?? 'ai',
      ...(options.kept === false ? {} : { keptAutomatically: options.origin === undefined }),
      ...(options.status === undefined ? {} : { status: options.status }),
      createdBy: maya().principalId,
      sourceRefs: options.refs ?? [],
      ...(options.origin === 'eir' ? { visibility: 'venture' as const } : {}),
    }),
  );
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  // Production before 2026-11-03: every migration up to 0020, and memory the vEIR kept by itself.
  await migrate(t.db, { migrations: MIGRATIONS.filter((m) => m.version < '0021') });
  seed = await seedDatabase(t.db, CONFIG);
  const a = await conversation();
  const b = await conversation();
  const c = await conversation();
  const actor = maya().principalId;
  const kept = async (key: string, refs: { kind: 'session' | 'turn'; id: string }[]) => {
    ids[key] = (await remember(`Kept ${key}`, { refs })).id;
  };
  await kept('plain', [{ kind: 'session', id: a.sessionId }]);
  await kept('fromTurn', [{ kind: 'turn', id: a.turnId }]);
  await kept('disputed', [{ kind: 'session', id: a.sessionId }]);
  await kept('pinned', [{ kind: 'session', id: a.sessionId }]);
  await kept('pinnedThenUnpinned', [{ kind: 'session', id: a.sessionId }]);
  await kept('approvedSince', [{ kind: 'session', id: a.sessionId }]);
  await kept('rejectedSince', [{ kind: 'session', id: a.sessionId }]);
  await kept('deletedSince', [{ kind: 'session', id: a.sessionId }]);
  await kept('correctedSince', [{ kind: 'session', id: a.sessionId }]);
  await kept('retiredSince', [{ kind: 'session', id: a.sessionId }]);
  await kept('repeatedSince', [{ kind: 'session', id: a.sessionId }]);
  await kept('forgottenNearby', [{ kind: 'session', id: b.sessionId }]);
  await kept('forgottenOther', [{ kind: 'turn', id: b.turnId }]);
  await kept('otherConversation', [{ kind: 'session', id: c.sessionId }]);
  await t.db.withContext(maya(), async (tx) => {
    must(
      await memoryRepo.disputeMemory(tx, { memoryId: ids.disputed ?? '', actorId: actor, reason: 'Unsure' }),
    );
    must(await memoryRepo.setMemoryPinned(tx, { memoryId: ids.pinned ?? '', actorId: actor, pinned: true }));
    const flip = ids.pinnedThenUnpinned ?? '';
    must(await memoryRepo.setMemoryPinned(tx, { memoryId: flip, actorId: actor, pinned: true }));
    must(await memoryRepo.setMemoryPinned(tx, { memoryId: flip, actorId: actor, pinned: false }));
  });
  ids.eir = (await remember('EIR suggestion', { origin: 'eir' })).id;
  ids.founder = (await remember('Founder note', { origin: 'founder', status: 'confirmed' })).id;
  ids.approvedBefore = (
    await t.db.withContext(maya(), async (tx) => {
      const proposal = await memoryRepo.createMemory(tx, {
        tenantId: seed.tenantId,
        ventureId: venture().id,
        type: 'fact',
        title: 'Approved before',
        content: 'A person approved this before 2026-11-03.',
        origin: 'ai',
        createdBy: maya().principalId,
      });
      return must(await memoryRepo.approveMemory(tx, { memoryId: proposal.id, actorId: actor }));
    })
  ).id;
  ids.pendingBefore = (
    await remember('Pending before', { kept: false, refs: [{ kind: 'session', id: c.sessionId }] })
  ).id;

  // 2026-11-03: 0021 to 0024 are deployed.
  await migrate(t.db, { migrations: MIGRATIONS.filter((m) => m.version < '0026') });

  // Between 0021 and 0026: what students and maintenance did with the demoted items.
  await t.db.withContext(maya(), async (tx) => {
    must(await memoryRepo.approveMemory(tx, { memoryId: ids.approvedSince ?? '', actorId: actor }));
    must(await memoryRepo.rejectMemory(tx, { memoryId: ids.rejectedSince ?? '', actorId: actor }));
    expect(await memoryRepo.deleteMemory(tx, ids.deletedSince ?? '')).toBeGreaterThan(0);
    ids.correction = must(
      await memoryRepo.correctMemory(tx, {
        memoryId: ids.correctedSince ?? '',
        actorId: actor,
        patch: { content: 'What the founder actually said.' },
        reason: null,
      }),
    ).id;
    must(
      await memoryRepo.repeatProposal(tx, {
        memoryId: ids.repeatedSince ?? '',
        actorId: actor,
        sourceRefs: [{ kind: 'session', id: c.sessionId }],
        confidence: 0.9,
      }),
    );
  });
  await t.db.system(async (sx) => {
    expect(
      await memoryRepo.settlePendingAiProposal(sx, {
        memoryId: ids.retiredSince ?? '',
        outcome: 'expire',
        reason: 'duplicate',
      }),
    ).toBe(true);
    // Maya made the vEIR forget something learned in conversation B (a fingerprint, never text).
    await sx.query(
      `INSERT INTO memory_forgotten (session_id, memory_type, title_key, content_key, numbers_key, signature, reason)
       VALUES (:session, 'insight', :k32, :k32, :k16, NULL, 'deleted')`,
      { session: p.uuid(b.sessionId), k32: p.text('a'.repeat(32)), k16: p.text('b'.repeat(16)) },
    );
  });
  ids.pendingSince = (
    await remember('Pending since', { kept: false, refs: [{ kind: 'session', id: c.sessionId }] })
  ).id;
});
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0026_automatic_memory_restored', () => {
  it('starts from production after 0021: every kept item nobody approved is waiting for approval', async () => {
    for (const key of ['plain', 'fromTurn', 'disputed', 'pinned', 'repeatedSince', 'forgottenNearby'])
      expect(await row(ids[key] ?? '')).toMatchObject({ status: 'proposed', pinned: false, kept: true });
    expect((await history(ids.plain ?? '')).map((e) => [e.action, e.diff.reason ?? null])).toEqual([
      ['created', 'kept_automatically'],
      ['proposed', 'approval_policy_restored'],
    ]);
  });

  it('applies cleanly as the non-superuser owner', async () => {
    const report = await migrate(t.db);
    expect(report.applied).toEqual(MIGRATIONS.map((m) => m.version).filter((v) => v >= '0026'));
    expect(report.applied[0]).toBe(MARK);
  });

  it('puts back what 0021 demoted and nobody acted on since, with its status and pin', async () => {
    for (const key of ['plain', 'fromTurn', 'repeatedSince', 'otherConversation'])
      expect(await row(ids[key] ?? '')).toEqual({
        status: 'confirmed',
        pinned: false,
        approved_by: null,
        kept: true,
      });
    expect(await row(ids.disputed ?? '')).toMatchObject({ status: 'disputed', approved_by: null });
    expect(await row(ids.pinned ?? '')).toMatchObject({ status: 'confirmed', pinned: true });
    expect(await row(ids.pinnedThenUnpinned ?? '')).toMatchObject({ status: 'confirmed', pinned: false });
    // One history event each, marked as the system's (never a person's approval) and as this migration's.
    expect((await history(ids.plain ?? '')).at(-1)).toEqual({
      action: 'approved',
      diff: { to: 'confirmed', system: true, reason: 'kept_automatically', migration: MARK },
    });
    expect((await restoredBy0026(ids.disputed ?? '')).map((e) => e.diff.to)).toEqual(['disputed']);
    // The memory API reads them as kept automatically again.
    const view = await t.db.withContext(maya(), (tx) => memoryRepo.getMemory(tx, ids.plain ?? ''));
    expect(view).toMatchObject({ status: 'confirmed', keptAutomatically: true, approvedBy: null });
  });

  it('never brings back what a student approved, rejected, corrected or deleted, or maintenance retired', async () => {
    expect(await row(ids.approvedSince ?? '')).toMatchObject({
      status: 'confirmed',
      approved_by: maya().principalId,
    });
    expect(await row(ids.rejectedSince ?? '')).toMatchObject({ status: 'rejected' });
    expect(await row(ids.deletedSince ?? '')).toMatchObject({ status: 'deleted' });
    expect(await row(ids.correctedSince ?? '')).toMatchObject({ status: 'superseded' });
    expect(await row(ids.retiredSince ?? '')).toMatchObject({ status: 'expired' });
    // The student's corrected version is theirs: 0026 does not touch it (the daily maintenance settles it).
    expect(await row(ids.correction ?? '')).toMatchObject({ status: 'proposed' });
    for (const key of [
      'approvedSince',
      'rejectedSince',
      'deletedSince',
      'correctedSince',
      'retiredSince',
      'correction',
    ])
      expect(await restoredBy0026(ids[key] ?? '')).toEqual([]);
  });

  it('leaves to maintenance an item whose conversation had something forgotten since 0021', async () => {
    // SQL cannot compare the fingerprint with the item: the maintenance checks keep or retire it.
    for (const key of ['forgottenNearby', 'forgottenOther'])
      expect(await row(ids[key] ?? '')).toMatchObject({ status: 'proposed', kept: true });
  });

  it('touches nothing 0021 never demoted', async () => {
    expect(await row(ids.eir ?? '')).toMatchObject({ status: 'proposed', kept: false });
    expect(await row(ids.founder ?? '')).toMatchObject({ status: 'confirmed', kept: false });
    expect(await row(ids.approvedBefore ?? '')).toMatchObject({
      status: 'confirmed',
      approved_by: maya().principalId,
    });
    expect(await row(ids.pendingBefore ?? '')).toMatchObject({ status: 'proposed', kept: false });
    expect(await row(ids.pendingSince ?? '')).toMatchObject({ status: 'proposed', kept: false });
    for (const key of ['eir', 'founder', 'approvedBefore', 'pendingBefore', 'pendingSince'])
      expect(await restoredBy0026(ids[key] ?? '')).toEqual([]);
  });

  it('is idempotent: re-running its statements, then the runner, changes nothing', async () => {
    const restore = must(RESTORE);
    const snapshot = () =>
      t.db.system(async (sx) =>
        JSON.stringify([
          (await sx.query('SELECT id, status, pinned FROM memory_objects ORDER BY id')).rows,
          (await sx.query('SELECT count(*)::int AS n FROM memory_events')).rows,
        ]),
      );
    const before = await snapshot();
    await t.db.system(async (sx) => {
      for (const statement of splitStatements(restore.sql)) await sx.query(statement);
    });
    expect(await snapshot()).toBe(before);
    expect((await migrate(t.db)).applied).toEqual([]);
  });

  it('is reversible: the documented undo puts back to proposed exactly the items it restored', async () => {
    const restore = must(RESTORE);
    // The undo is the comment block after "To undo" in the migration's header (indented SQL).
    const lines = restore.sql.split('\n');
    const from = lines.findIndex((line) => line.includes('To undo')) + 1;
    const to = lines.findIndex((line, i) => i >= from && !line.startsWith('--   '));
    const undo = lines
      .slice(from, to)
      .map((line) => line.slice(5))
      .join('\n');
    expect(undo).toContain('WITH back AS');
    await t.db.system((sx) => sx.query(undo));
    for (const key of ['plain', 'fromTurn', 'disputed', 'pinned', 'repeatedSince', 'otherConversation'])
      expect(await row(ids[key] ?? '')).toMatchObject({ status: 'proposed', pinned: false });
    expect(await row(ids.approvedSince ?? '')).toMatchObject({ status: 'confirmed' });
    expect(await row(ids.founder ?? '')).toMatchObject({ status: 'confirmed' });
    expect(await row(ids.rejectedSince ?? '')).toMatchObject({ status: 'rejected' });
  });
});
