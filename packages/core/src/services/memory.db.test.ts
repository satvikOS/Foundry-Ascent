import { memoryRepo, p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';

let h: CoreHarness;
let maya: RequestContext;
let devin: RequestContext;
let corin: RequestContext;
let ventureId: string;

beforeAll(async () => {
  h = await createCoreHarness();
  maya = await h.ctxFor(h.people.maya);
  devin = await h.ctxFor(h.people.devin);
  corin = await h.ctxFor(h.people.eirCorin);
  ventureId = h.ventures.quietquad.id;
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

async function rawStatus(
  id: string,
): Promise<{ status: string; title: string; content: string; embedded: boolean }> {
  const result = await h.t.db.system((sx) =>
    sx.query(
      'SELECT status, title, content, embedding IS NOT NULL AS embedded FROM memory_objects WHERE id = :id',
      {
        id: p.uuid(id),
      },
    ),
  );
  const row = result.rows[0];
  if (!row) throw new Error('memory row missing');
  return {
    status: String(row.status),
    title: String(row.title),
    content: String(row.content),
    embedded: row.embedded === true,
  };
}

describe('memory lifecycle', () => {
  it('founder items are confirmed with origin founder and embedded after commit', async () => {
    const item = await h.core.memory.create(maya, ventureId, {
      type: 'decision',
      title: 'Pilot in the science library first',
      content: 'We start with the science library because it has the longest exam-week queues.',
    });
    expect(item).toMatchObject({ status: 'confirmed', origin: 'founder', version: 1, visibility: 'venture' });
    expect(item.approvedBy?.id).toBe(h.people.maya);
    expect((await rawStatus(item.id)).embedded).toBe(true);
    expect(h.gateway.calls.some((c) => c.kind === 'embed' && c.purpose === 'embedding')).toBe(true);
  });

  it('correct creates a superseding version, keeps history, and only the new version is listed', async () => {
    const v1 = await h.core.memory.create(maya, ventureId, {
      type: 'fact',
      title: 'Seat turnover',
      content: 'Seats turn over every 90 minutes during finals.',
    });
    const v2 = await h.core.memory.act(maya, v1.id, {
      action: 'correct',
      patch: { content: 'Seats turn over every 70 minutes during finals.' },
      reason: 'new door counter data',
    });
    expect(v2).toMatchObject({ version: 2, supersedesId: v1.id, status: 'confirmed' });
    expect(v2?.id).not.toBe(v1.id);
    expect((await rawStatus(v1.id)).status).toBe('superseded');

    const listed = await h.core.memory.list(maya, ventureId, { type: 'fact' });
    expect(listed.map((m) => m.id)).toContain(v2?.id);
    expect(listed.map((m) => m.id)).not.toContain(v1.id);

    const history = await h.core.memory.history(maya, v2?.id ?? '');
    expect(history.map((e) => `${e.memoryId === v1.id ? 'v1' : 'v2'}:${e.action}`)).toEqual([
      'v1:created',
      'v1:superseded',
      'v2:corrected',
    ]);
    expect(JSON.stringify(history)).not.toContain('70 minutes');

    const disputed = await h.core.memory.act(devin, v2?.id ?? '', {
      action: 'dispute',
      reason: 'counter was miscalibrated',
    });
    expect(disputed?.status).toBe('disputed');
    const pinned = await h.core.memory.act(maya, v2?.id ?? '', { action: 'pin' });
    expect(pinned?.pinned).toBe(true);
    const reconfirmed = await h.core.memory.act(maya, v2?.id ?? '', { action: 'approve' });
    expect(reconfirmed?.status).toBe('confirmed');
    await expect(h.core.memory.act(maya, v2?.id ?? '', { action: 'reject' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      h.core.memory.act(maya, v2?.id ?? '', { action: 'correct', patch: {} }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('delete hides every version, erases content and redacts history', async () => {
    const v1 = await h.core.memory.create(maya, ventureId, {
      type: 'insight',
      title: 'Sensitive partner note',
      content: 'The library director prefers we do not publish occupancy data.',
    });
    const v2 = await h.core.memory.act(maya, v1.id, { action: 'correct', patch: { title: 'Partner note' } });
    const result = await h.core.memory.act(maya, v2?.id ?? '', {
      action: 'delete',
      reason: 'no longer relevant',
    });
    expect(result).toBeNull();
    const listed = await h.core.memory.list(maya, ventureId, {});
    expect(listed.map((m) => m.id)).not.toContain(v2?.id);
    await expect(h.core.memory.history(maya, v2?.id ?? '')).rejects.toMatchObject({ code: 'not_found' });
    for (const id of [v1.id, v2?.id ?? '']) {
      const raw = await rawStatus(id);
      expect(raw).toMatchObject({ status: 'deleted', title: '[deleted]', content: '', embedded: false });
    }
    await expect(h.core.memory.act(maya, v1.id, { action: 'delete' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('AI proposals stay proposed until a founder approves; rejected items cannot be approved', async () => {
    const proposal = await h.t.db.system((sx) =>
      memoryRepo.createMemory(sx, {
        tenantId: h.seed.tenantId,
        ventureId,
        type: 'hypothesis',
        title: 'Students will pay for alerts',
        content: 'Proposed by the coach after session 3.',
        origin: 'ai',
        status: 'proposed',
        visibility: 'team',
        createdBy: h.people.maya,
      }),
    );
    const approved = await h.core.memory.act(devin, proposal.id, { action: 'approve' });
    expect(approved).toMatchObject({ status: 'confirmed', origin: 'ai' });
    expect(approved?.approvedBy?.id).toBe(h.people.devin);

    const other = await h.t.db.system((sx) =>
      memoryRepo.createMemory(sx, {
        tenantId: h.seed.tenantId,
        ventureId,
        type: 'risk',
        title: 'Library IT may block the sensor',
        content: 'Proposed risk.',
        origin: 'ai',
        status: 'proposed',
        createdBy: h.people.maya,
      }),
    );
    await expect(
      h.core.memory.act(maya, other.id, { action: 'reject', reason: 'not accurate' }),
    ).resolves.toMatchObject({
      status: 'rejected',
    });
    await expect(h.core.memory.act(maya, other.id, { action: 'approve' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('assigned EIRs can only propose venture-visible items', async () => {
    const proposal = await h.core.memory.create(corin, ventureId, {
      type: 'insight',
      title: 'Consider a waitlist experiment',
      content: 'A waitlist would test willingness to commit before building the full app.',
      visibility: 'venture',
    });
    expect(proposal).toMatchObject({ status: 'proposed', origin: 'eir' });
    await expect(
      h.core.memory.create(corin, ventureId, {
        type: 'insight',
        title: 'Private',
        content: 'x',
        visibility: 'team',
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(h.core.memory.act(corin, proposal.id, { action: 'approve' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('founder_private items are invisible to teammates', async () => {
    const secret = await h.core.memory.create(maya, ventureId, {
      type: 'preference',
      title: 'Personal runway',
      content: 'I can fund myself until March.',
      visibility: 'founder_private',
    });
    const teamView = await h.core.memory.list(devin, ventureId, {});
    expect(teamView.map((m) => m.id)).not.toContain(secret.id);
    await expect(h.core.memory.act(devin, secret.id, { action: 'pin' })).rejects.toMatchObject({
      code: 'not_found',
    });
    const search = await h.core.memory.list(maya, ventureId, { q: 'runway' });
    expect(search.map((m) => m.id)).toContain(secret.id);
  });
});
