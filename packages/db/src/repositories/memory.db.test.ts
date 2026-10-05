import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryObjectView } from '@foundry/contracts';

import { type DbContext } from '../db.js';
import { DbError } from '../errors.js';
import { p } from '../params.js';
import { type SeedResult } from '../seed/seed.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import * as memoryRepo from './memory.js';
import * as turnsRepo from './turns.js';

let t: TestDatabase;
let seed: SeedResult;
let ventureId: string;
let maya: DbContext;
let devin: DbContext;
let advisor: DbContext;
let corin: DbContext;

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  if (!t.seed) throw new Error('seed missing');
  seed = t.seed;
  const v = seed.ventures.find((x) => x.key === 'quietquad');
  if (!v) throw new Error('venture missing');
  ventureId = v.id;
  maya = makeContext(seed.principals.maya ?? '', seed.tenantId);
  devin = makeContext(seed.principals.devin ?? '', seed.tenantId);
  advisor = makeContext(seed.principals.graham ?? '', seed.tenantId);
  corin = makeContext(seed.principals['eir-corin'] ?? '', seed.tenantId);
}, 120_000);

afterAll(async () => {
  await t.cleanup();
});

describe('memory lifecycle', () => {
  it('proposes, approves, corrects (supersedes), pins and records history', async () => {
    const result = await t.db.withContext(maya, async (tx) => {
      const proposed = await memoryRepo.createMemory(tx, {
        tenantId: seed.tenantId,
        ventureId,
        type: 'decision',
        title: 'Charge libraries, not students',
        content: 'Libraries pay a campus licence; students use the app for free.',
        origin: 'ai',
        createdBy: maya.principalId,
        attributes: { rationale: 'Students will not pay', reversal_condition: 'No library budget' },
        sourceRefs: [{ kind: 'turn', id: '00000000-0000-4000-8000-000000000001' }],
      });
      expect(MemoryObjectView.safeParse(proposed).success).toBe(true);
      expect(proposed.status).toBe('proposed');
      expect(proposed.approvedBy).toBeNull();

      const approved = await memoryRepo.approveMemory(tx, {
        memoryId: proposed.id,
        actorId: maya.principalId,
      });
      expect(approved?.status).toBe('confirmed');
      expect(approved?.approvedBy?.id).toBe(maya.principalId);
      expect(
        await memoryRepo.approveMemory(tx, { memoryId: proposed.id, actorId: maya.principalId }),
      ).toBeNull();

      const corrected = await memoryRepo.correctMemory(tx, {
        memoryId: proposed.id,
        actorId: maya.principalId,
        patch: { content: 'Libraries pay a per-building licence; students use it free.', confidence: 0.7 },
        reason: 'Pricing unit clarified',
      });
      expect(corrected?.version).toBe(2);
      expect(corrected?.supersedesId).toBe(proposed.id);
      expect(corrected?.status).toBe('confirmed');
      expect(corrected?.confidence).toBe(0.7);
      expect(corrected?.title).toBe('Charge libraries, not students');
      const old = await memoryRepo.getMemory(tx, proposed.id);
      expect(old?.status).toBe('superseded');

      const pinned = await memoryRepo.setMemoryPinned(tx, {
        memoryId: corrected?.id ?? '',
        actorId: maya.principalId,
        pinned: true,
      });
      expect(pinned?.pinned).toBe(true);
      const disputed = await memoryRepo.disputeMemory(tx, {
        memoryId: corrected?.id ?? '',
        actorId: maya.principalId,
        reason: 'One library said budgets are frozen',
      });
      expect(disputed?.status).toBe('disputed');

      const history = await memoryRepo.listMemoryHistory(tx, corrected?.id ?? '');
      return { history, newId: corrected?.id ?? '', oldId: proposed.id };
    });
    expect(result.history.map((e) => e.action)).toEqual([
      'proposed',
      'approved',
      'superseded',
      'corrected',
      'pinned',
      'disputed',
    ]);
    const corrected = result.history.find((e) => e.action === 'corrected');
    expect(corrected?.diff).toMatchObject({
      fields: ['content', 'confidence'],
      reason: 'Pricing unit clarified',
      version: 2,
    });
    expect(corrected?.memoryId).toBe(result.newId);
  });

  it('rejects proposed items and hides history items from the default list', async () => {
    await t.db.withContext(devin, async (tx) => {
      const candidate = await memoryRepo.createMemory(tx, {
        tenantId: seed.tenantId,
        ventureId,
        type: 'insight',
        title: 'Rejectable candidate',
        content: 'A weak inference',
        origin: 'ai',
        createdBy: devin.principalId,
      });
      const rejected = await memoryRepo.rejectMemory(tx, {
        memoryId: candidate.id,
        actorId: devin.principalId,
        reason: 'Wrong',
      });
      expect(rejected?.status).toBe('rejected');
      const active = await memoryRepo.listMemory(tx, { ventureId });
      expect(active.some((m) => m.id === candidate.id)).toBe(false);
      const rejectedOnly = await memoryRepo.listMemory(tx, { ventureId, status: 'rejected' });
      expect(rejectedOnly.map((m) => m.id)).toContain(candidate.id);
    });
  });

  it('filters by type, pin, full text, open status and due dates', async () => {
    await t.db.withContext(maya, async (tx) => {
      const actions = await memoryRepo.listMemory(tx, {
        ventureId,
        type: 'action',
        openOnly: true,
        orderBy: 'due',
      });
      expect(actions.length).toBe(2);
      expect(actions.every((a) => a.type === 'action')).toBe(true);
      const today = new Date().toISOString().slice(0, 10);
      const overdue = await memoryRepo.listMemory(tx, {
        ventureId,
        types: ['action'],
        openOnly: true,
        dueBefore: today,
      });
      expect(overdue.map((m) => m.title)).toEqual(['Ask facilities whether door-counter data can be shared']);
      const upcoming = await memoryRepo.listMemory(tx, { ventureId, type: 'milestone', dueOnOrAfter: today });
      expect(upcoming).toHaveLength(1);
      const pinned = await memoryRepo.listMemory(tx, { ventureId, pinned: true });
      expect(pinned.every((m) => m.pinned)).toBe(true);
      const search = await memoryRepo.listMemory(tx, { ventureId, q: 'group chats workaround' });
      expect(search[0]?.title).toBe('Group chats are the current workaround');
      expect(await memoryRepo.countPendingMemory(tx, ventureId)).toBeGreaterThanOrEqual(1);
    });
  });

  it('lets assigned EIRs propose but not approve; advisors of other ventures see nothing', async () => {
    const proposed = await t.db.withContext(corin, async (tx) => {
      const item = await memoryRepo.createMemory(tx, {
        tenantId: seed.tenantId,
        ventureId,
        type: 'insight',
        title: 'EIR suggestion',
        content: 'Talk to residence-hall staff too.',
        origin: 'eir',
        createdBy: corin.principalId,
      });
      expect(
        await memoryRepo.approveMemory(tx, { memoryId: item.id, actorId: corin.principalId }),
      ).toBeNull();
      return item;
    });
    expect(proposed.status).toBe('proposed');
    await expect(
      t.db.withContext(corin, (tx) =>
        memoryRepo.createMemory(tx, {
          tenantId: seed.tenantId,
          ventureId,
          type: 'fact',
          title: 'Confirmed by EIR',
          content: 'Not allowed',
          origin: 'eir',
          createdBy: corin.principalId,
          status: 'confirmed',
        }),
      ),
    ).rejects.toBeInstanceOf(DbError);
    await t.db.withContext(advisor, async (tx) => {
      expect(await memoryRepo.getMemory(tx, proposed.id)).toBeNull();
      expect(
        await memoryRepo.approveMemory(tx, { memoryId: proposed.id, actorId: advisor.principalId }),
      ).toBeNull();
    });
  });

  it('deletes every version, erases content, redacts history and evidence titles', async () => {
    const { first, second, turnId } = await t.db.withContext(maya, async (tx) => {
      const a = await memoryRepo.createMemory(tx, {
        tenantId: seed.tenantId,
        ventureId,
        type: 'fact',
        title: 'Sensitive fact v1',
        content: 'Sensitive content',
        origin: 'founder',
        createdBy: maya.principalId,
        status: 'confirmed',
      });
      const b = await memoryRepo.correctMemory(tx, {
        memoryId: a.id,
        actorId: maya.principalId,
        patch: { title: 'Sensitive fact v2' },
      });
      const session = await tx.query(
        `INSERT INTO coaching_sessions (tenant_id, venture_id, assignment_id, persona_release_id, started_by, policy_version)
         SELECT :t, :v, a.id, :r, :me, 'test' FROM assignments a WHERE a.venture_id = :v AND a.status = 'active'
         RETURNING id`,
        {
          t: p.uuid(seed.tenantId),
          v: p.uuid(ventureId),
          r: p.uuid(seed.releaseId),
          me: p.uuid(maya.principalId),
        },
      );
      const turn = await turnsRepo.createTurn(tx, {
        tenantId: seed.tenantId,
        ventureId,
        sessionId: String(session.rows[0]?.id),
        authorId: maya.principalId,
        mode: 'coach',
        founderText: 'q',
      });
      await turnsRepo.insertTurnEvidence(tx, turn.id, [
        { key: 'E1', kind: 'memory', refId: b?.id ?? '', score: 1, title: 'Sensitive fact v2', ventureId },
      ]);
      return { first: a.id, second: b?.id ?? '', turnId: turn.id };
    });
    expect(await t.db.withContext(devin, (tx) => memoryRepo.deleteMemory(tx, second))).toBe(2);
    await t.db.withContext(maya, async (tx) => {
      expect(await memoryRepo.getMemory(tx, first)).toBeNull();
      expect(await memoryRepo.getMemory(tx, second)).toBeNull();
      const evidence = await turnsRepo.listTurnEvidence(tx, [turnId]);
      expect(evidence.get(turnId)?.[0]).toMatchObject({ title: '[deleted]', excerpt: '' });
    });
    const raw = await t.db.system((sx) =>
      sx.query(
        `SELECT m.status, m.title, m.content,
                (SELECT count(*) FROM memory_events e WHERE e.memory_id = m.id AND e.diff ? 'redacted') AS redacted,
                (SELECT count(*) FROM memory_events e WHERE e.memory_id = m.id AND e.action = 'deleted') AS deleted_events
         FROM memory_objects m WHERE m.id IN (:a, :b)`,
        { a: p.uuid(first), b: p.uuid(second) },
      ),
    );
    for (const row of raw.rows) {
      expect(row).toMatchObject({ status: 'deleted', title: '[deleted]', content: '' });
      expect(Number(row.redacted)).toBeGreaterThan(0);
      expect(Number(row.deleted_events)).toBe(1);
    }
  });

  it('refuses deletion by an advisor of the venture (visible items need founder/team)', async () => {
    const solesignal = seed.ventures.find((v) => v.key === 'solesignal');
    const advisorItem = solesignal?.memoryIds['e-clinic-interviews'];
    if (!advisorItem) throw new Error('seed item missing');
    await expect(
      t.db.withContext(advisor, (tx) => memoryRepo.deleteMemory(tx, advisorItem)),
    ).rejects.toMatchObject({
      sqlState: '42501',
    });
  });
});
