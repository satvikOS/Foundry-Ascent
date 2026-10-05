import { auditRepo, memoryRepo, principalsRepo, tenantsRepo, venturesRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRequestContext, type RequestContext } from '../context.js';
import { isDomainError } from '../errors.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';

/**
 * Authorization matrix (system design §4.2/§4.3): every service operation × every kind of principal.
 * Target venture: QuietQuad (founder Maya, team Devin, advisor Graham (added here), assigned EIR Corin).
 */
type Who =
  | 'founder'
  | 'team'
  | 'advisor'
  | 'eirAssigned'
  | 'eirUnassigned'
  | 'programLead'
  | 'admin'
  | 'stranger'
  | 'crossTenant';
const WHO: readonly Who[] = [
  'founder',
  'team',
  'advisor',
  'eirAssigned',
  'eirUnassigned',
  'programLead',
  'admin',
  'stranger',
  'crossTenant',
];

let h: CoreHarness;
const ctx = {} as Record<Who, RequestContext>;
let ventureId: string;
let sessionId: string;
let plainTurnId: string;
let sampledTurnId: string;
let visibleMemoryId: string;

beforeAll(async () => {
  h = await createCoreHarness({ random: () => 0.99 });
  ventureId = h.ventures.quietquad.id;
  const { adminOnly, partnerPrincipal, partnerTenant } = await h.t.db.system(async (sx) => {
    await venturesRepo.addMembership(sx, { ventureId, principalId: h.people.graham, role: 'advisor' });
    const admin = await principalsRepo.createPrincipal(sx, {
      tenantId: h.seed.tenantId,
      displayName: 'Admin Only',
    });
    await principalsRepo.grantRole(sx, {
      principalId: admin.id,
      tenantId: h.seed.tenantId,
      role: 'platform_admin',
    });
    const tenant = await tenantsRepo.upsertTenant(sx, {
      slug: 'partner-u',
      name: 'Partner University',
      kind: 'partner',
    });
    const partner = await principalsRepo.createPrincipal(sx, {
      tenantId: tenant.id,
      displayName: 'Partner Person',
    });
    return { adminOnly: admin.id, partnerPrincipal: partner.id, partnerTenant: tenant.id };
  });
  ctx.founder = await h.ctxFor(h.people.maya);
  ctx.team = await h.ctxFor(h.people.devin);
  ctx.advisor = await h.ctxFor(h.people.graham);
  ctx.eirAssigned = await h.ctxFor(h.people.eirCorin);
  ctx.eirUnassigned = await h.ctxFor(h.people.eirRuth);
  ctx.programLead = await h.ctxFor(h.people.lead);
  ctx.admin = await h.ctxFor(adminOnly);
  ctx.stranger = await h.ctxFor(h.people.jonah);
  ctx.crossTenant = createRequestContext({
    principalId: partnerPrincipal,
    tenantId: partnerTenant,
    requestId: 'x-tenant',
  });

  const session = await h.core.sessions.create(ctx.founder, ventureId, { mode: 'coach' });
  sessionId = session.id;
  const plain = await h.core.orchestrator.runTurn(
    ctx.founder,
    sessionId,
    { text: 'Which library should host the pilot?' },
    () => undefined,
  );
  const sampled = await h.core.orchestrator.runTurn(
    ctx.founder,
    sessionId,
    { text: 'Do we need a lawyer to review the data sharing contract with the library?' },
    () => undefined,
  );
  plainTurnId = plainTurnIdOf(plain.turnId);
  sampledTurnId = plainTurnIdOf(sampled.turnId);
  const visible = await h.core.memory.create(ctx.founder, ventureId, {
    type: 'fact',
    title: 'Two libraries open late during finals',
    content: 'Both campus libraries extend hours to 2am during finals week.',
    visibility: 'venture',
  });
  visibleMemoryId = visible.id;
}, 240_000);

function plainTurnIdOf(id: string | null): string {
  if (id === null) throw new Error('turn was not accepted');
  return id;
}

afterAll(async () => {
  await h.cleanup();
});

/** A fresh AI proposal (visibility team) to approve. */
async function freshProposal(): Promise<string> {
  const m = await h.t.db.system((sx) =>
    memoryRepo.createMemory(sx, {
      tenantId: h.seed.tenantId,
      ventureId,
      type: 'hypothesis',
      title: 'Students would pay for seat alerts',
      content: 'Proposed by the coach.',
      origin: 'ai',
      status: 'proposed',
      visibility: 'team',
      createdBy: h.people.maya,
    }),
  );
  return m.id;
}

type Op = (c: RequestContext) => Promise<unknown>;

const ALL_DENIED: readonly Who[] = [];
const MEMBERS_READ: readonly Who[] = ['founder', 'team', 'advisor', 'eirAssigned'];
const WRITERS: readonly Who[] = ['founder', 'team'];

const MATRIX: readonly { name: string; allowed: readonly Who[]; op: Op }[] = [
  { name: 'ventures.get', allowed: MEMBERS_READ, op: (c) => h.core.ventures.get(c, ventureId) },
  { name: 'ventures.overview', allowed: MEMBERS_READ, op: (c) => h.core.ventures.overview(c, ventureId) },
  {
    name: 'ventures.update',
    allowed: WRITERS,
    op: (c) => h.core.ventures.update(c, ventureId, { currentGoal: 'Pilot in two libraries' }),
  },
  { name: 'sessions.create', allowed: WRITERS, op: (c) => h.core.sessions.create(c, ventureId, {}) },
  { name: 'sessions.list', allowed: WRITERS, op: (c) => h.core.sessions.list(c, ventureId) },
  { name: 'sessions.get', allowed: WRITERS, op: (c) => h.core.sessions.get(c, sessionId) },
  {
    name: 'turns.evidence (unsampled)',
    allowed: WRITERS,
    op: (c) => h.core.sessions.getTurnEvidence(c, plainTurnId),
  },
  {
    name: 'turns.evidence (sampled)',
    allowed: [...WRITERS, 'eirAssigned'],
    op: (c) => h.core.sessions.getTurnEvidence(c, sampledTurnId),
  },
  {
    name: 'turns.feedback',
    allowed: WRITERS,
    op: (c) => h.core.sessions.submitFeedback(c, plainTurnId, { rating: 4 }),
  },
  { name: 'memory.list', allowed: MEMBERS_READ, op: (c) => h.core.memory.list(c, ventureId) },
  {
    name: 'memory.create',
    allowed: [...WRITERS, 'eirAssigned'],
    op: (c) =>
      h.core.memory.create(c, ventureId, {
        type: 'insight',
        title: 'Matrix item',
        content: 'Created in the matrix test.',
      }),
  },
  {
    name: 'memory.approve',
    allowed: WRITERS,
    op: async (c) => h.core.memory.act(c, await freshProposal(), { action: 'approve' }),
  },
  { name: 'memory.history', allowed: MEMBERS_READ, op: (c) => h.core.memory.history(c, visibleMemoryId) },
  { name: 'documents.list', allowed: MEMBERS_READ, op: (c) => h.core.documents.list(c, ventureId) },
  {
    name: 'documents.createUpload',
    allowed: WRITERS,
    op: (c) =>
      h.core.documents.createUpload(c, ventureId, {
        filename: 'notes.md',
        contentType: 'text/markdown',
        sizeBytes: 10,
      }),
  },
  { name: 'escalations.list', allowed: WRITERS, op: (c) => h.core.escalations.list(c, ventureId) },
  {
    name: 'escalations.create',
    allowed: WRITERS,
    op: (c) =>
      h.core.escalations.create(c, ventureId, {
        category: 'expert_judgment',
        founderQuestion: 'Is the pilot design sound?',
      }),
  },
  { name: 'team.list', allowed: [...MEMBERS_READ, 'programLead'], op: (c) => h.core.team.list(c, ventureId) },
  {
    name: 'team.invite',
    allowed: ['programLead'],
    op: (c) => h.core.team.invite(c, ventureId, { displayName: 'New Teammate', role: 'team' }),
  },
  { name: 'program.portfolio', allowed: ['programLead', 'admin'], op: (c) => h.core.program.portfolio(c) },
  { name: 'program.listVentures', allowed: ['programLead'], op: (c) => h.core.program.listVentures(c) },
  {
    name: 'program.createResource',
    allowed: ['programLead'],
    op: (c) =>
      h.core.program.createResource(c, {
        name: 'Matrix clinic',
        kind: 'legal_clinic',
        description: 'Free legal clinic.',
      }),
  },
  {
    name: 'program.escalationQueue',
    allowed: ['programLead', 'admin'],
    op: (c) => h.core.program.escalationQueue(c),
  },
  { name: 'admin.listPrincipals', allowed: ['admin'], op: (c) => h.core.admin.listPrincipals(c) },
  { name: 'admin.getSettings', allowed: ['admin'], op: (c) => h.core.admin.getSettings(c) },
  { name: 'admin.usageSummary', allowed: ['admin'], op: (c) => h.core.admin.usageSummary(c) },
  { name: 'admin.listAudit', allowed: ['admin'], op: (c) => h.core.admin.listAudit(c, { limit: 5 }) },
  {
    name: 'admin.issueAccessCode (founder)',
    allowed: ['programLead', 'admin'],
    op: (c) => h.core.admin.issueAccessCode(c, h.people.maya, { label: 'matrix' }),
  },
  {
    name: 'eir.listPersonas',
    allowed: ['eirAssigned', 'eirUnassigned', 'programLead', 'admin'],
    op: (c) => h.core.eir.listPersonas(c),
  },
  {
    name: 'eir.reviewQueue',
    allowed: ['eirAssigned', 'eirUnassigned'],
    op: (c) => h.core.eir.reviewQueue(c),
  },
  {
    name: 'eir.submitReview',
    allowed: ['eirAssigned'],
    op: (c) =>
      h.core.eir.submitReview(c, sampledTurnId, {
        scores: { correctness: 4, rigor: 4, specificity: 3, teachability: 4, personaFit: 5, escalation: 5 },
      }),
  },
  {
    name: 'eir.suspendPersona',
    allowed: ALL_DENIED,
    op: (c) =>
      h.core.eir.suspendPersona(c, '00000000-0000-4000-8000-000000000000', { reason: 'not a real persona' }),
  },
];

describe('authorization matrix', () => {
  for (const row of MATRIX) {
    it(row.name, async () => {
      for (const who of WHO) {
        const expected = row.allowed.includes(who);
        let error: unknown = null;
        try {
          await row.op(ctx[who]);
        } catch (err) {
          error = err;
        }
        if (expected) {
          expect(error, `${row.name} should allow ${who}`).toBeNull();
        } else {
          expect(isDomainError(error), `${row.name} should deny ${who}`).toBe(true);
          if (isDomainError(error)) {
            expect(['forbidden', 'not_found'], `${row.name} → ${who}: ${error.code}`).toContain(error.code);
          }
        }
      }
    });
  }

  it('records denials in the audit log (after rollback) without content', async () => {
    const page = await h.t.db.system((sx) =>
      auditRepo.listAuditEvents(sx, { outcome: 'denied', limit: 200 }),
    );
    const byActor = (id: string) => page.items.filter((e) => e.actorId === id);
    expect(byActor(h.people.jonah).some((e) => e.action === 'venture.access')).toBe(true);
    expect(
      byActor(h.people.graham).some((e) => e.policyReason?.startsWith('write:insufficient_relation')),
    ).toBe(true);
    expect(byActor(h.people.maya).some((e) => e.action === 'authz.denied')).toBe(true);
    const verify = await h.t.db.system((sx) => auditRepo.verifyAuditChain(sx));
    expect(verify.firstBrokenId).toBeNull();
  });

  it('program leads cannot issue codes for privileged principals; admins can', async () => {
    await expect(h.core.admin.issueAccessCode(ctx.programLead, h.people.owner, {})).rejects.toMatchObject({
      code: 'forbidden',
    });
    const issued = await h.core.admin.issueAccessCode(ctx.admin, h.people.owner, { label: 'break glass' });
    expect(issued.accessCode).toMatch(/^FA-/);
  });

  it('advisors only see venture/advisor-visible memory', async () => {
    const items = await h.core.memory.list(ctx.advisor, ventureId);
    expect(items.length).toBeGreaterThan(0);
    for (const m of items) expect(['venture', 'advisors']).toContain(m.visibility);
    const founderItems = await h.core.memory.list(ctx.founder, ventureId);
    expect(founderItems.some((m) => m.visibility === 'team' || m.visibility === 'founder_private')).toBe(
      true,
    );
  });

  it('a revoked membership loses access immediately', async () => {
    await h.t.db.system((sx) =>
      venturesRepo.revokeMembership(sx, { ventureId, principalId: h.people.devin }),
    );
    await expect(h.core.ventures.get(ctx.team, ventureId)).rejects.toMatchObject({ code: 'not_found' });
    await h.t.db.system((sx) =>
      venturesRepo.addMembership(sx, { ventureId, principalId: h.people.devin, role: 'team' }),
    );
    await expect(h.core.ventures.get(ctx.team, ventureId)).resolves.toMatchObject({
      id: ventureId,
      myRole: 'team',
    });
  });
});
