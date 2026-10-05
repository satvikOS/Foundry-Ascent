import {
  AdminPrincipalRow,
  AuditListResponse,
  Me,
  PortfolioSummary,
  UsageSummary,
  VentureDetail,
  VentureOverview,
} from '@foundry/contracts';
import { GUIDE_DOCTRINE, GUIDE_STYLE, eirRepo, personasRepo, p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';

let h: CoreHarness;
let lead: RequestContext;
let owner: RequestContext;
let maya: RequestContext;
let graham: RequestContext;
let corin: RequestContext;

beforeAll(async () => {
  h = await createCoreHarness();
  lead = await h.ctxFor(h.people.lead);
  owner = await h.ctxFor(h.people.owner);
  maya = await h.ctxFor(h.people.maya);
  graham = await h.ctxFor(h.people.graham);
  corin = await h.ctxFor(h.people.eirCorin);
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

describe('me and ventures', () => {
  it('me reports memberships, assignments, roles and the disclosure', async () => {
    const me = Me.parse(await h.core.me.get(maya));
    expect(me.memberships).toEqual([
      { ventureId: h.ventures.quietquad.id, ventureName: 'QuietQuad', role: 'founder' },
    ]);
    expect(me.roles).toEqual([]);
    expect(me.disclosure).toMatch(/AI coach/);
    const eir = await h.core.me.get(corin);
    expect(eir.roles).toEqual(['eir']);
    expect([...eir.assignedVentureIds].sort()).toEqual(
      [h.ventures.benchtally.id, h.ventures.quietquad.id].sort(),
    );
  });

  it('venture list/detail/overview are scoped to the viewer', async () => {
    const list = await h.core.ventures.list(maya);
    expect(list.map((v) => v.name)).toEqual(['QuietQuad']);
    expect(list[0]?.pendingMemory).toBeGreaterThan(0);
    const detail = VentureDetail.parse(await h.core.ventures.get(maya, h.ventures.quietquad.id));
    expect(detail.persona).toMatchObject({ name: 'Foundry Guide', kind: 'neutral_guide', status: 'active' });
    expect(detail.assignedEir?.displayName).toBe('Corin Halvorsen');

    const overview = VentureOverview.parse(await h.core.ventures.overview(maya, h.ventures.quietquad.id));
    expect(overview.currentGoal).toBe(detail.currentGoal);
    expect(overview.verifiedDecisions.every((m) => m.type === 'decision' && m.status === 'confirmed')).toBe(
      true,
    );
    expect(overview.openAssumptions.every((m) => m.type === 'hypothesis')).toBe(true);
    expect(overview.pendingMemoryCount).toBeGreaterThan(0);

    // The advisor of SoleSignal sees venture/advisor-visible items only, and no sessions.
    const advisorView = await h.core.ventures.overview(graham, h.ventures.solesignal.id);
    const items = [
      ...advisorView.verifiedDecisions,
      ...advisorView.openAssumptions,
      ...advisorView.upcomingMilestones,
    ];
    for (const m of items) expect(['venture', 'advisors']).toContain(m.visibility);
    expect(advisorView.recentSessions).toEqual([]);
    // The assigned EIR reads the venture brief but not session recaps.
    await h.core.sessions.create(maya, h.ventures.quietquad.id, {});
    expect(
      (await h.core.ventures.overview(maya, h.ventures.quietquad.id)).recentSessions.length,
    ).toBeGreaterThan(0);
    expect((await h.core.ventures.overview(corin, h.ventures.quietquad.id)).recentSessions).toEqual([]);

    const updated = await h.core.ventures.update(maya, h.ventures.quietquad.id, {
      currentGoal: 'Two-library pilot by May',
    });
    expect(updated.currentGoal).toBe('Two-library pilot by May');
    await expect(h.core.ventures.update(maya, h.ventures.quietquad.id, {})).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});

describe('program console', () => {
  it('portfolio is k-anonymous: groups below the minimum are null', async () => {
    const before = PortfolioSummary.parse(await h.core.program.portfolio(lead));
    expect(before.minGroupSize).toBe(3);
    for (const value of Object.values(before.venturesByStage)) expect(value).toBeNull();
    expect(JSON.stringify(before)).not.toMatch(/QuietQuad|BenchTally|CANARY/);

    for (const name of ['Discovery Two', 'Discovery Three']) {
      const row = await h.core.program.createVenture(lead, { name, stage: 'discovery', domain: 'software' });
      expect(row).toMatchObject({ name, stage: 'discovery', personaName: 'Foundry Guide', memberCount: 0 });
    }
    const after = await h.core.program.portfolio(lead);
    expect(after.venturesByStage.discovery).toBe(3);
    expect(after.venturesByStage.validation).toBeNull();
    const admin = await h.core.program.portfolio(owner);
    expect(admin.venturesByStage.discovery).toBe(3);
  });

  it('a new venture gets the active Foundry Guide; an invited founder can start a session', async () => {
    const row = await h.core.program.createVenture(lead, { name: 'Fresh Venture', oneLiner: 'New idea' });
    const issued = await h.core.team.invite(lead, row.id, { displayName: 'Fresh Founder', role: 'founder' });
    const founder = await h.ctxFor(issued.principal.id);
    const session = await h.core.sessions.create(founder, row.id, { mode: 'teach' });
    expect(session).toMatchObject({ personaName: 'Foundry Guide', mode: 'teach', status: 'active' });
    const team = await h.core.team.list(lead, row.id);
    expect(team.map((m) => m.principal.id)).toEqual([issued.principal.id]);
    expect((await h.core.program.listVentures(lead)).map((v) => v.id)).toContain(row.id);
  });

  it('resources CRUD: founders read, program leads write, retired resources are hidden', async () => {
    const created = await h.core.program.createResource(lead, {
      name: 'Prototype grant',
      kind: 'funding',
      description: 'Small grants for hardware prototypes.',
      tags: ['hardware', 'grant'],
      stages: ['validation'],
    });
    expect(created).toMatchObject({ status: 'active', tags: ['hardware', 'grant'] });
    const forFounder = await h.core.program.listResources(maya, { q: 'prototype grant' });
    expect(forFounder.map((r) => r.id)).toContain(created.id);
    await expect(
      h.core.program.updateResource(maya, created.id, { status: 'retired' }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
    const retired = await h.core.program.updateResource(lead, created.id, { status: 'retired' });
    expect(retired.status).toBe('retired');
    expect((await h.core.program.listResources(maya, {})).map((r) => r.id)).not.toContain(created.id);
    await expect(h.core.program.updateResource(lead, created.id, {})).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});

describe('admin console', () => {
  it('settings, kill-switch audit, principals, audit pages and usage', async () => {
    const settings = await h.core.admin.updateSettings(owner, { portfolioMinGroupSize: 2, aiEnabled: false });
    expect(settings).toMatchObject({ portfolioMinGroupSize: 2, aiEnabled: false });
    await h.core.admin.updateSettings(owner, { aiEnabled: true });
    const audit = AuditListResponse.parse(await h.core.admin.listAudit(owner, { limit: 3 }));
    expect(audit.items).toHaveLength(3);
    expect(audit.nextCursor).not.toBeNull();
    const next = await h.core.admin.listAudit(owner, { limit: 3, cursor: audit.nextCursor ?? undefined });
    expect(next.items[0]?.id).toBeLessThan(audit.items[2]?.id ?? 0);
    const engaged = await h.core.admin.listAudit(owner, { action: 'kill_switch.engaged' });
    expect(engaged.items.length).toBe(1);
    await expect(h.core.admin.listAudit(owner, { cursor: 'abc' })).rejects.toMatchObject({
      code: 'validation_failed',
    });

    const created = AdminPrincipalRow.parse(
      await h.core.admin.createPrincipal(owner, { displayName: 'New EIR', roles: ['eir'] }),
    );
    expect(created.roles).toEqual(['eir']);
    const rows = await h.core.admin.listPrincipals(owner);
    const ownerRow = rows.find((r) => r.principal.id === h.people.owner);
    expect(ownerRow?.roles).toEqual(['platform_admin', 'program_lead']);
    expect(ownerRow?.activeAccessCodes.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('scrypt$');
    const mayaRow = rows.find((r) => r.principal.id === h.people.maya);
    expect(mayaRow?.memberships).toEqual([
      { ventureId: h.ventures.quietquad.id, ventureName: 'QuietQuad', role: 'founder' },
    ]);

    const usage = UsageSummary.parse(await h.core.admin.usageSummary(owner));
    expect(usage.byDay).toHaveLength(30);
    expect(usage.capGlobalUsd).toBe(2);
  });
});

describe('EIR studio', () => {
  const release = {
    doctrine: GUIDE_DOCTRINE,
    style: GUIDE_STYLE,
    disclosureText:
      'You are working with Foundry Guide, an AI coach. It is not a person, and no human EIR authored or approved these responses.',
    allowedModes: ['diagnose', 'coach', 'challenge'] as ('diagnose' | 'coach' | 'challenge')[],
  };

  it('program leads draft and approve releases; new sessions use the new version', async () => {
    const draft = await h.core.eir.createRelease(lead, h.seed.personaId, release);
    expect(draft).toMatchObject({ status: 'draft', version: 2 });
    await expect(h.core.eir.approveRelease(maya, draft.id)).rejects.toMatchObject({ code: 'forbidden' });
    const approved = await h.core.eir.approveRelease(lead, draft.id);
    expect(approved).toMatchObject({ status: 'approved', version: 2 });
    await expect(h.core.eir.approveRelease(lead, draft.id)).rejects.toMatchObject({ code: 'conflict' });
    const persona = await h.core.eir.getPersona(corin, h.seed.personaId);
    expect(persona.activeRelease?.version).toBe(2);
    expect(persona.releases.find((r) => r.version === 1)?.status).toBe('superseded');
    const session = await h.core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    expect(session.personaVersion).toBe(2);
    await expect(
      h.core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'rehearse' }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('EIR personas need consent before a release can be approved', async () => {
    const personaId = await h.t.db.system(async (sx) => {
      const profile = await eirRepo.getEirProfileByPrincipal(sx, h.people.eirCorin);
      const persona = await personasRepo.createPersona(sx, {
        tenantId: h.seed.tenantId,
        name: 'Corin persona (synthetic)',
        kind: 'eir_persona',
        eirProfileId: profile?.id ?? null,
      });
      return persona.id;
    });
    const draft = await h.core.eir.createRelease(corin, personaId, release);
    await expect(h.core.eir.approveRelease(corin, draft.id)).rejects.toMatchObject({
      code: 'forbidden',
      reason: 'consent_required',
    });
    await h.t.db.system(async (sx) => {
      const consent = await personasRepo.createConsent(sx, {
        tenantId: h.seed.tenantId,
        subjectPrincipalId: h.people.eirCorin,
        assetTypes: ['doctrine', 'style'],
      });
      await sx.query('UPDATE personas SET consent_id = :c WHERE id = :id', {
        c: p.uuid(consent.id),
        id: p.uuid(personaId),
      });
    });
    await expect(h.core.eir.approveRelease(corin, draft.id)).resolves.toMatchObject({ status: 'approved' });
    const view = await h.core.eir.getPersona(lead, personaId);
    expect(view).toMatchObject({ status: 'active', hasConsent: true });
    const ruth = await h.ctxFor(h.people.eirRuth);
    await expect(
      h.core.eir.suspendPersona(ruth, personaId, { reason: 'not my persona' }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      h.core.eir.suspendPersona(corin, personaId, { reason: 'pausing my persona' }),
    ).resolves.toMatchObject({
      status: 'suspended',
    });
    const profiles = await h.core.eir.listEirProfiles(lead);
    expect(profiles.map((e) => e.displayName)).toEqual(
      expect.arrayContaining(['Corin Halvorsen', 'Ruth Abernathy-Song']),
    );
  });
});
