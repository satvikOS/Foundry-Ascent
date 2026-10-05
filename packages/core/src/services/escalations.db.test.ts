import { EscalationQueueItem, EscalationView } from '@foundry/contracts';
import { p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';

let h: CoreHarness;
let maya: RequestContext;
let corin: RequestContext;
let ruth: RequestContext;
let lead: RequestContext;
let ventureId: string;

beforeAll(async () => {
  h = await createCoreHarness();
  maya = await h.ctxFor(h.people.maya);
  corin = await h.ctxFor(h.people.eirCorin);
  ruth = await h.ctxFor(h.people.eirRuth);
  lead = await h.ctxFor(h.people.lead);
  ventureId = h.ventures.quietquad.id;
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

describe('escalation consent gate', () => {
  it('the assignee cannot read a packet before the founder consents; after consent it is routed to the assigned EIR', async () => {
    const question = 'Is a two-library pilot enough evidence to approach the provost?';
    const created = await h.core.escalations.create(maya, ventureId, {
      category: 'expert_judgment',
      priority: 'P2',
      requestedRole: 'eir',
      founderQuestion: question,
      desiredDecision: 'Go / no-go on the provost pitch',
    });
    EscalationView.parse(created);
    expect(created).toMatchObject({ status: 'awaiting_consent', sharingConsentAt: null, assignee: null });
    expect(created.packet).toMatchObject({ founderQuestion: question, sharedFacts: [], aiGenerated: true });

    // Even if the escalation already names Corin, nothing is visible to him before consent.
    await h.t.db.system((sx) =>
      sx.query('UPDATE escalations SET assignee_principal_id = :a WHERE id = :id', {
        a: p.uuid(h.people.eirCorin),
        id: p.uuid(created.id),
      }),
    );
    expect(await h.core.escalations.inbox(corin)).toEqual([]);
    await expect(h.core.escalations.act(corin, created.id, { action: 'acknowledge' })).rejects.toMatchObject({
      code: 'not_found',
    });

    // Only confirmed memory of this venture can be shared.
    const proposed = (await h.core.memory.list(maya, ventureId, { status: 'proposed' }))[0];
    const confirmed = (await h.core.memory.list(maya, ventureId, { status: 'confirmed' })).find(
      (m) => m.visibility === 'venture',
    );
    const otherVenture = (
      await h.core.memory.list(await h.ctxFor(h.people.priya), h.ventures.benchtally.id, {
        status: 'confirmed',
      })
    )[0];
    if (!proposed || !confirmed || !otherVenture) throw new Error('seed memory missing');
    for (const bad of [proposed.id, otherVenture.id]) {
      await expect(
        h.core.escalations.act(maya, created.id, { action: 'approve_sharing', sharedMemoryIds: [bad] }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    }

    const shared = await h.core.escalations.act(maya, created.id, {
      action: 'approve_sharing',
      sharedMemoryIds: [confirmed.id],
    });
    expect(shared).toMatchObject({ status: 'routed' });
    expect(shared.assignee?.id).toBe(h.people.eirCorin);
    expect(shared.sharingConsentAt).not.toBeNull();
    const due = Date.parse(shared.dueAt ?? '');
    expect(due - Date.now()).toBeGreaterThan(4.9 * 86_400_000);
    expect(shared.packet?.sharedFacts).toEqual([
      { memoryId: confirmed.id, text: expect.stringContaining(confirmed.title) as string },
    ]);

    const inbox = await h.core.escalations.inbox(corin);
    expect(inbox.map((e) => e.id)).toEqual([created.id]);
    expect(inbox[0]?.packet?.founderQuestion).toBe(question);

    await expect(h.core.escalations.act(ruth, created.id, { action: 'acknowledge' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(h.core.escalations.act(maya, created.id, { action: 'acknowledge' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    const acked = await h.core.escalations.act(corin, created.id, { action: 'acknowledge' });
    expect(acked.status).toBe('acknowledged');
    const resolved = await h.core.escalations.act(corin, created.id, {
      action: 'resolve',
      resolution: {
        summary: 'Run one more week of counts first.',
        nextSteps: ['Extend the door counter test'],
      },
    });
    expect(resolved).toMatchObject({
      status: 'resolved',
      resolution: { summary: 'Run one more week of counts first.' },
    });
    await expect(h.core.escalations.act(maya, created.id, { action: 'withdraw' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('non-EIR requests go to the program queue (metadata only) and a program lead routes them', async () => {
    const created = await h.core.escalations.create(maya, ventureId, {
      category: 'legal',
      priority: 'P1',
      requestedRole: 'specialist',
      founderQuestion: 'Can the library share anonymised occupancy data with us?',
    });
    const queueBefore = await h.core.program.escalationQueue(lead);
    const before = queueBefore.find((e) => e.id === created.id);
    expect(before).toMatchObject({ status: 'awaiting_consent', shared: false });
    await expect(
      h.core.program.routeEscalation(lead, created.id, { assigneeId: h.people.eirRuth }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const shared = await h.core.escalations.act(maya, created.id, {
      action: 'approve_sharing',
      sharedMemoryIds: [],
    });
    // Consented with nobody assigned: it waits in the program team's routing queue.
    expect(shared).toMatchObject({ status: 'awaiting_assignment', assignee: null });
    expect(shared.sharingConsentAt).not.toBeNull();
    const item = (await h.core.program.escalationQueue(lead)).find((e) => e.id === created.id);
    expect(item).toMatchObject({ shared: true, status: 'awaiting_assignment', assigneeId: null });
    expect(Object.keys(EscalationQueueItem.parse(item))).not.toContain('packet');
    // Sharing is decided once; the shared packet is no longer editable.
    await expect(
      h.core.escalations.act(maya, created.id, { action: 'approve_sharing', sharedMemoryIds: [] }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      h.core.escalations.act(maya, created.id, { action: 'edit', packet: { founderQuestion: 'Changed' } }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // The routing dialog offers exactly the people routing accepts.
    const assignees = await h.core.program.listAssignees(lead);
    expect(assignees.map((a) => a.principal.id)).toEqual(
      expect.arrayContaining([h.people.eirRuth, h.people.eirCorin, h.people.lead]),
    );
    expect(assignees.map((a) => a.principal.id)).not.toContain(h.people.jonah);

    // Never to another venture's founder.
    await expect(
      h.core.program.routeEscalation(lead, created.id, { assigneeId: h.people.jonah }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const routed = await h.core.program.routeEscalation(lead, created.id, { assigneeId: h.people.eirRuth });
    expect(routed).toMatchObject({ status: 'routed', assigneeId: h.people.eirRuth });
    expect(routed.dueAt).not.toBeNull();
    const ruthInbox = await h.core.escalations.inbox(ruth);
    expect(ruthInbox.map((e) => e.id)).toContain(created.id);
    const declined = await h.core.escalations.act(ruth, created.id, {
      action: 'decline',
      reason: 'Needs the legal clinic.',
    });
    expect(declined).toMatchObject({
      status: 'declined',
      resolution: { summary: 'Needs the legal clinic.', nextSteps: [] },
    });
    // A declined escalation is closed: it stays visible in the queue but cannot be routed again.
    await expect(
      h.core.program.routeEscalation(lead, created.id, { assigneeId: h.people.eirCorin }),
    ).rejects.toMatchObject({ code: 'conflict', reason: 'invalid_transition' });
  });

  it('a founder can withdraw while waiting for assignment; closed escalations cannot be routed', async () => {
    const created = await h.core.escalations.create(maya, ventureId, {
      category: 'conflict_harassment',
      priority: 'P2',
      requestedRole: 'program_lead',
      founderQuestion: 'How do we handle a co-founder dispute about equity?',
    });
    const shared = await h.core.escalations.act(maya, created.id, {
      action: 'approve_sharing',
      sharedMemoryIds: [],
    });
    expect(shared.status).toBe('awaiting_assignment');
    // Nobody is assigned yet, so nobody can acknowledge it.
    await expect(h.core.escalations.act(ruth, created.id, { action: 'acknowledge' })).rejects.toMatchObject({
      code: 'not_found',
    });
    const withdrawn = await h.core.escalations.act(maya, created.id, { action: 'withdraw' });
    expect(withdrawn.status).toBe('withdrawn');
    // Withdrawn escalations leave the program queue altogether.
    await expect(
      h.core.program.routeEscalation(lead, created.id, { assigneeId: h.people.eirRuth }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('only program leads and platform admins list escalation assignees', async () => {
    const assignees = await h.core.program.listAssignees(lead);
    for (const a of assignees) {
      expect(a.roles.length).toBeGreaterThan(0);
      expect(['eir', 'program_lead']).toEqual(expect.arrayContaining(a.roles));
    }
    expect(assignees.find((a) => a.principal.id === h.people.eirRuth)?.expertiseTags.length).toBeGreaterThan(
      0,
    );
    for (const who of [maya, ruth, corin]) {
      await expect(h.core.program.listAssignees(who)).rejects.toMatchObject({ code: 'forbidden' });
    }
  });

  it('founders edit and withdraw drafts; edits keep the AI-generated label', async () => {
    const created = await h.core.escalations.create(maya, ventureId, {
      category: 'other',
      founderQuestion: 'Original question',
    });
    const edited = await h.core.escalations.act(maya, created.id, {
      action: 'edit',
      packet: { founderQuestion: 'Edited question', unknowns: ['Budget owner'] },
    });
    expect(edited.packet).toMatchObject({
      founderQuestion: 'Edited question',
      unknowns: ['Budget owner'],
      aiGenerated: true,
    });
    const withdrawn = await h.core.escalations.act(maya, created.id, { action: 'withdraw' });
    expect(withdrawn.status).toBe('withdrawn');
    await expect(
      h.core.escalations.act(maya, created.id, { action: 'edit', packet: {} }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('escalations from a turn carry the founder question and no venture records', async () => {
    const session = await h.core.sessions.create(maya, ventureId, {});
    const outcome = await h.core.orchestrator.runTurn(
      maya,
      session.id,
      { text: 'Is our pilot pricing right?' },
      () => undefined,
    );
    const created = await h.core.escalations.create(maya, ventureId, {
      turnId: outcome.turnId,
      category: 'expert_judgment',
      founderQuestion: 'Is our pilot pricing right?',
    });
    expect(created.turnId).toBe(outcome.turnId);
    expect(created.sessionId).toBe(session.id);
    for (const e of created.packet?.evidenceConsidered ?? []) {
      expect(e.key).toMatch(/^E\d+$/);
    }
    await expect(
      h.core.escalations.create(maya, h.ventures.quietquad.id, {
        turnId: '00000000-0000-4000-8000-000000000001',
        category: 'other',
        founderQuestion: 'x',
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
