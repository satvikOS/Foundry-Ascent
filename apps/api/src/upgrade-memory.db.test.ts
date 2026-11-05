import { MemoryListResponse, TurnStreamEvent } from '@foundry/contracts';
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

describe('automatic memory (owner decision 2026-10-16, reconfirmed 2026-11-05)', () => {
  it('keeps turn candidates at once, with no approver, and retrieval uses them', async () => {
    const ventureId = api.h.ventures.quietquad.id;
    const session = await api.request(`/ventures/${ventureId}/sessions`, { cookie, body: {} });
    expect(session.status).toBe(201);
    const { id } = (await session.json()) as { id: string };
    const turn = await api.request(`/sessions/${id}/turns`, {
      cookie,
      body: { text: "We've decided to ask each library for a paid commitment before the pilot starts." },
      idempotencyKey: 'automatic-policy-turn',
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
    // Nothing waits for an approval: every item is kept, recorded as kept by the vEIR itself.
    for (const m of candidates)
      expect(m).toMatchObject({
        origin: 'ai',
        status: 'confirmed',
        approvedBy: null,
        keptAutomatically: true,
      });
    const item = candidates[0];
    if (!item) throw new Error('missing kept memory');
    const ctx = await api.h.ctxFor(api.h.people.maya);
    const retrieved = await api.h.t.db.withContext(ctx, (tx) =>
      retrievalRepo.searchVentureMemory(tx, {
        tenantId: ctx.tenantId,
        ventureId,
        query: item.content,
        embedding: null,
        limit: 100,
        minScore: 0,
      }),
    );
    expect(retrieved.some((m) => m.refId === item.id)).toBe(true);
  });

  it('keeps nothing from a Private one-off conversation', async () => {
    const ventureId = api.h.ventures.quietquad.id;
    const session = await api.request(`/ventures/${ventureId}/sessions`, {
      cookie,
      body: { privacy: 'ephemeral' },
    });
    expect(session.status).toBe(201);
    const { id } = (await session.json()) as { id: string };
    const turn = await api.request(`/sessions/${id}/turns`, {
      cookie,
      body: { text: "We've decided to ask each library for a paid commitment before the private pilot." },
      idempotencyKey: 'automatic-policy-private-turn',
    });
    expect(parseSse(await turn.text()).frames.length).toBeGreaterThan(0);
    const rows = await api.h.t.db.system((sx) =>
      sx.query(
        `SELECT count(*)::int AS n FROM memory_objects m
         WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(m.source_refs) r (ref) WHERE r.ref ->> 'id' = :id)`,
        { id: p.text(id) },
      ),
    );
    expect(rows.rows[0]).toEqual({ n: 0 });
  });

  it('lets maintenance keep a pending AI proposal automatically, never leaking it to another venture', async () => {
    const ctx = await api.h.ctxFor(api.h.people.maya);
    const proposal = await api.h.t.db.withContext(ctx, (tx) =>
      memoryRepo.createMemory(tx, {
        tenantId: ctx.tenantId,
        ventureId: api.h.ventures.quietquad.id,
        type: 'hypothesis',
        title: 'Pending capacity claim',
        content: 'The service can deliver forty orders with one student.',
        origin: 'ai',
        createdBy: ctx.principalId,
        sourceRefs: [],
        visibility: 'team',
      }),
    );
    expect(proposal.status).toBe('proposed');
    await api.h.core.maintenance.runDaily({ requestId: 'upgrade-memory-policy' });
    const stored = await api.h.t.db.system((sx) => memoryRepo.getMemory(sx, proposal.id));
    expect(stored).toMatchObject({ status: 'confirmed', keptAutomatically: true, approvedBy: null });
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

  it('rejecting several at once forgets each one, as rejecting one does', async () => {
    const ventureId = api.h.ventures.quietquad.id;
    const ctx = await api.h.ctxFor(api.h.people.maya);
    const session = await api.h.core.sessions.create(ctx, ventureId, { privacy: 'standard' });
    await api.request(`/sessions/${session.id}/turns`, {
      cookie,
      body: { text: 'Discuss the batch rejection experiment.' },
      idempotencyKey: 'continuity-batch-reject',
    });
    const proposal = await api.h.t.db.withContext(ctx, (tx) =>
      memoryRepo.createMemory(tx, {
        tenantId: ctx.tenantId,
        ventureId,
        type: 'hypothesis',
        title: 'Batch rejection',
        content: 'A proposal left pending from before.',
        origin: 'ai',
        createdBy: ctx.principalId,
        sourceRefs: [{ kind: 'session', id: session.id }],
        visibility: 'team',
      }),
    );
    const result = await api.h.core.memory.batch(ctx, ventureId, { action: 'reject', ids: [proposal.id] });
    expect(result.items.map((m) => m.status)).toEqual(['rejected']);
    const forgotten = await api.h.t.db.system((sx) =>
      sx.query(
        `SELECT (SELECT count(*)::int FROM memory_forgotten WHERE session_id = :id) AS prints,
                (SELECT digest_deleted_at IS NOT NULL FROM coaching_sessions WHERE id = :id) AS fenced`,
        { id: p.uuid(session.id) },
      ),
    );
    expect(forgotten.rows[0]).toEqual({ prints: 1, fenced: true });
  });

  it.each(['reject', 'correct', 'delete'] as const)(
    '%s withdraws summary, opener, digest and retrieval for good, keeping the transcript',
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
          // Kept automatically, as the vEIR keeps what it learns; a rejection applies to what is in question
          // (a proposal left from before, or an item the student disputed), so that one is disputed first.
          keptAutomatically: true,
        }),
      );
      expect(item).toMatchObject({ status: 'confirmed', keptAutomatically: true });
      if (action === 'reject')
        await api.h.core.memory.act(ctx, item.id, { action: 'dispute', reason: 'Not what we decided.' });
      const retrieve = () =>
        api.h.t.db.withContext(ctx, (tx) =>
          retrievalRepo.searchVentureMemory(tx, {
            tenantId: ctx.tenantId,
            ventureId,
            query: 'original commitment remains certain',
            embedding: null,
            limit: 100,
            minScore: 0,
          }),
        );
      expect((await retrieve()).some((m) => m.refId === item.id)).toBe(true);
      // The conversation's digest, as distillation keeps one ("Previous conversations" in the prompt).
      await api.h.t.db.system((sx) =>
        sx.query(
          `UPDATE coaching_sessions SET digest = :digest, opener = 'How is the original commitment?'
           WHERE id = :id`,
          {
            id: p.uuid(session.id),
            digest: p.json({
              summary: 'The original commitment remains certain.',
              topics: ['commitment'],
              commitments: [],
              openQuestions: [],
              generatedAt: new Date().toISOString(),
            }),
          },
        ),
      );
      const digests = () =>
        api.h.t.db.withContext(ctx, (tx) => sessionsRepo.listRecentDigests(tx, { ventureId, limit: 20 }));
      expect((await digests()).some((d) => d.sessionId === session.id)).toBe(true);
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
      expect(retried?.content.nextOpener).toBeNull();
      // The digest stays withdrawn (a fenced re-distillation never writes it back), and the old words are never
      // retrieved again: the rejected or deleted item is gone, a corrected one only in its new words.
      expect((await digests()).some((d) => d.sessionId === session.id)).toBe(false);
      const fenced = await api.h.t.db.system((sx) =>
        sx.query(
          'SELECT digest IS NULL AS gone, digest_deleted_at IS NOT NULL AS fenced, opener IS NULL AS no_opener FROM coaching_sessions WHERE id = :id',
          {
            id: p.uuid(session.id),
          },
        ),
      );
      expect(fenced.rows[0]).toEqual({ gone: true, fenced: true, no_opener: true });
      const hits = await retrieve();
      expect(hits.some((m) => m.refId === item.id)).toBe(false);
      if (action === 'correct') {
        expect(hits.some((m) => m.excerpt.includes('original commitment remains certain'))).toBe(false);
      } else {
        expect(hits.some((m) => m.title === `Continuity ${action}`)).toBe(false);
      }
    },
  );
});
