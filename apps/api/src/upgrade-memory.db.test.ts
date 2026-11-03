import { MemoryObjectView, MemoryListResponse, TurnStreamEvent } from '@foundry/contracts';
import { memoryRepo, notebooksRepo, p, retrievalRepo, sessionsRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApiHarness, type ApiHarness } from './testing/api-harness.js';
import { parseSse } from './testing/sse.js';

let api: ApiHarness;
let cookie: string;
beforeAll(async () => {
  api = await createApiHarness();
  cookie = await api.signInAs(api.h.people.maya);
});
afterAll(async () => {
  await api.cleanup();
});

describe('human-approved durable memory', () => {
  it('keeps turn candidates pending, excludes them from retrieval, and admits only an explicit approval', async () => {
    const ventureId = api.h.ventures.quietquad.id;
    const session = await api.request(`/ventures/${ventureId}/sessions`, { cookie, body: {} });
    expect(session.status).toBe(201);
    const { id } = (await session.json()) as { id: string };
    const turn = await api.request(`/sessions/${id}/turns`, {
      cookie,
      body: { text: "We've decided to ask each library for a paid commitment before the pilot starts." },
      idempotencyKey: 'review-policy-turn',
    });
    const events = parseSse(await turn.text()).frames.map((f) => TurnStreamEvent.parse(JSON.parse(f.data)));
    expect(events.at(-1)?.event).toBe('turn.completed');
    const list = MemoryListResponse.parse(
      await (await api.request(`/ventures/${ventureId}/memory`, { cookie })).json(),
    );
    const candidates = list.items.filter((m) =>
      m.sourceRefs.some((s) => s.kind === 'session' && s.id === id),
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((m) => m.status === 'proposed' && m.approvedBy === null)).toBe(true);
    const item = candidates[0];
    if (!item) throw new Error('missing proposal');
    const ctx = await api.h.ctxFor(api.h.people.maya);
    const retrieve = () =>
      api.h.t.db.withContext(ctx, (tx) =>
        retrievalRepo.searchVentureMemory(tx, {
          tenantId: ctx.tenantId,
          ventureId,
          query: item.content,
          embedding: null,
          limit: 100,
          minScore: 0,
        }),
      );
    expect((await retrieve()).some((m) => m.refId === item.id)).toBe(false);
    const approved = await api.request(`/memory/${item.id}`, {
      cookie,
      method: 'PATCH',
      body: { action: 'approve' },
    });
    expect(approved.status).toBe(200);
    expect(MemoryObjectView.parse(await approved.json()).status).toBe('confirmed');
    expect((await retrieve()).some((m) => m.refId === item.id)).toBe(true);
  });

  it('does not let maintenance approve a student proposal or leak it to another venture', async () => {
    const ctx = await api.h.ctxFor(api.h.people.maya);
    const proposal = await api.h.t.db.withContext(ctx, (tx) =>
      memoryRepo.createMemory(tx, {
        tenantId: ctx.tenantId,
        ventureId: api.h.ventures.quietquad.id,
        type: 'hypothesis',
        title: 'Unapproved capacity claim',
        content: 'The service can deliver forty orders with one student.',
        origin: 'ai',
        createdBy: ctx.principalId,
        sourceRefs: [],
        visibility: 'team',
      }),
    );
    await api.h.core.maintenance.runDaily({ requestId: 'upgrade-memory-policy' });
    const stored = await api.h.t.db.system((sx) => memoryRepo.getMemory(sx, proposal.id));
    expect(stored?.status).toBe('proposed');
    const wrong = await api.request(`/memory/${proposal.id}`, {
      cookie: await api.signInAs(api.h.people.priya),
    });
    expect([403, 404]).toContain(wrong.status);
    // SQL policy independently refuses the other student, even without the service guard.
    const other = await api.h.ctxFor(api.h.people.priya);
    const rows = await api.h.t.db.withContext(other, (tx) =>
      tx.query('SELECT id FROM memory_objects WHERE id = :id', { id: p.uuid(proposal.id) }),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it.each(['reject', 'correct', 'delete'] as const)(
    '%s withdraws old summaries and fences a queued distillation without deleting the transcript',
    async (action) => {
      const ventureId = api.h.ventures.quietquad.id;
      const ctx = await api.h.ctxFor(api.h.people.maya);
      const session = await api.h.core.sessions.create(ctx, ventureId, { privacy: 'standard' });
      await api.request(`/sessions/${session.id}/turns`, {
        cookie,
        body: { text: `Discuss the ${action} continuity experiment.` },
        idempotencyKey: `continuity-${action}`,
      });
      await api.h.core.distill.distillSession({
        sessionId: session.id,
        requestId: `before-${action}`,
        settled: true,
      });
      const personaId = api.h.ventures.quietquad.personaId;
      await api.h.t.db.system(async (sx) => {
        const current = await notebooksRepo.getNotebook(sx, { ventureId, personaId });
        await notebooksRepo.saveNotebook(sx, {
          tenantId: ctx.tenantId,
          ventureId,
          personaId,
          expectedVersion: current?.version ?? 0,
          content: {
            ...notebooksRepo.EMPTY_NOTEBOOK,
            summary: 'The original commitment remains certain.',
            summarySources: [session.id],
            nextOpener: 'How is the original commitment?',
            nextOpenerSource: session.id,
          },
          suppressed: [],
          editedBy: 'veir',
          sourceSessionId: session.id,
        });
      });
      const item = await api.h.t.db.withContext(ctx, (tx) =>
        memoryRepo.createMemory(tx, {
          tenantId: ctx.tenantId,
          ventureId,
          type: 'hypothesis',
          title: `Continuity ${action}`,
          content: 'The original commitment remains certain.',
          origin: 'ai',
          createdBy: ctx.principalId,
          sourceRefs: [{ kind: 'session', id: session.id }],
          visibility: 'team',
        }),
      );
      if (action === 'correct') await api.h.core.memory.act(ctx, item.id, { action: 'approve' });
      await api.h.core.memory.act(
        ctx,
        item.id,
        action === 'correct' ? { action, patch: { content: 'The commitment was withdrawn.' } } : { action },
      );
      const after = await api.h.t.db.system((sx) => notebooksRepo.getNotebook(sx, { ventureId, personaId }));
      expect(after?.content.summary).toBe('');
      expect(after?.content.nextOpener).toBeNull();
      const left = await api.h.t.db.withContext(ctx, (tx) =>
        sessionsRepo.listLeftOffConversations(tx, { ventureId, principalId: ctx.principalId }),
      );
      expect(left.some((s) => s.id === session.id)).toBe(false);
      const detail = await api.request(`/sessions/${session.id}`, { cookie });
      expect(((await detail.json()) as { turns: unknown[] }).turns).toHaveLength(1);
      await api.h.core.distill.distillSession({
        sessionId: session.id,
        requestId: `retry-${action}`,
        settled: true,
      });
      const retried = await api.h.t.db.system((sx) =>
        notebooksRepo.getNotebook(sx, { ventureId, personaId }),
      );
      expect(retried?.version).toBe(after?.version);
      expect(retried?.content.summary).toBe('');
    },
  );
});
