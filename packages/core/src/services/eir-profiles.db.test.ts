/**
 * The EIR registry through the core services: program leads and platform admins add the real people vEIRs are
 * built from (linked to an account invited through the usual access-code flow) and edit them; adding one never
 * records consent, so a vEIR built from the person is only approved once they record it themselves. Also the
 * curator's lesson queue across vEIRs.
 */
import { EirProfileView, LessonListResponse } from '@foundry/contracts';
import { p, personasRepo, principalsRepo, tenantsRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRequestContext, type RequestContext } from '../context.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';

let h: CoreHarness;
let owner: RequestContext;
let lead: RequestContext;
let admin: RequestContext;
let corin: RequestContext;
let maya: RequestContext;

/** A person with the EIR role, added through the admin console as the access-code flow does. */
async function invitedEir(displayName: string): Promise<string> {
  return (await h.core.admin.createPrincipal(owner, { displayName, roles: ['eir'] })).principal.id;
}

/** Audit events of one action on one object, oldest first, with their metadata. */
async function audits(action: string, objectId: string): Promise<{ actorId: string; metadata: unknown }[]> {
  const r = await h.t.db.system((sx) =>
    sx.query(
      `SELECT actor_id, metadata FROM audit_events WHERE action = :action AND object_id = :id ORDER BY id`,
      { action: p.text(action), id: p.text(objectId) },
    ),
  );
  return r.rows.map((row) => ({
    actorId: String(row.actor_id),
    metadata: JSON.parse(String(row.metadata)) as unknown,
  }));
}

async function sampleRelease() {
  const persona = await h.core.eir.getPersona(lead, h.ventures.quietquad.personaId);
  return h.core.eir.getRelease(lead, persona.activeRelease?.id ?? '');
}

beforeAll(async () => {
  h = await createCoreHarness();
  owner = await h.ctxFor(h.people.owner);
  lead = await h.ctxFor(h.people.lead);
  corin = await h.ctxFor(h.people.eirCorin);
  maya = await h.ctxFor(h.people.maya);
  const adminOnly = await h.t.db.system(async (sx) => {
    const created = await principalsRepo.createPrincipal(sx, {
      tenantId: h.seed.tenantId,
      displayName: 'Admin Only',
    });
    await principalsRepo.grantRole(sx, {
      principalId: created.id,
      tenantId: h.seed.tenantId,
      role: 'platform_admin',
    });
    return created.id;
  });
  admin = await h.ctxFor(adminOnly);
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

describe('adding an EIR', () => {
  it('offers the invited EIRs without a profile, to program leads and platform admins only', async () => {
    const noor = await invitedEir('Noor Haddad');
    for (const who of [lead, admin]) {
      const candidates = await h.core.eirProfiles.listCandidates(who);
      expect(candidates.map((c) => c.id)).toContain(noor);
      // The seeded EIRs already have profiles.
      expect(candidates.map((c) => c.displayName)).not.toContain('Corin Halvorsen');
    }
    for (const who of [corin, maya]) {
      await expect(h.core.eirProfiles.listCandidates(who)).rejects.toMatchObject({ code: 'forbidden' });
    }
  });

  it('creates a profile linked to the person, audited without its text, and records no consent', async () => {
    const principalId = await invitedEir('Ines Okoro');
    const created = EirProfileView.parse(
      await h.core.eirProfiles.create(lead, {
        principalId,
        displayName: 'Ines Okoro',
        title: 'Former VP Sales, Gridline',
        expertiseTags: ['B2B Sales', 'pricing'],
        bio: 'Built the sales team at a grid-storage company from zero to 40 people.',
      }),
    );
    expect(created).toMatchObject({
      displayName: 'Ines Okoro',
      title: 'Former VP Sales, Gridline',
      expertiseTags: ['b2b-sales', 'pricing'],
      bio: 'Built the sales team at a grid-storage company from zero to 40 people.',
      // A real person (invited, not synthetic): only they can consent.
      synthetic: false,
      status: 'active',
      principal: { id: principalId, displayName: 'Ines Okoro', synthetic: false },
    });
    expect((await h.core.eir.listEirProfiles(corin)).map((p) => p.id)).toContain(created.id);
    expect((await h.core.eirProfiles.listCandidates(lead)).map((c) => c.id)).not.toContain(principalId);
    const consents = await h.t.db.system((sx) => personasRepo.listConsents(sx, principalId));
    expect(consents).toEqual([]);
    // Identifiers and counts only: never the bio's text.
    expect(await audits('eir_profile.created', created.id)).toEqual([
      { actorId: lead.principalId, metadata: { principalId, expertiseTags: 2, bio: true } },
    ]);
  });

  it('lets a platform admin who leads no program add one too; never an EIR or a founder', async () => {
    const principalId = await invitedEir('Tomas Reyes');
    const input = { principalId, displayName: 'Tomas Reyes' };
    for (const who of [corin, maya]) {
      await expect(h.core.eirProfiles.create(who, input)).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(await h.core.eirProfiles.create(admin, input)).toMatchObject({ principal: { id: principalId } });
  });

  it('refuses at the field someone who can’t have a profile, and a second profile for the same person', async () => {
    const field = async (input: Parameters<CoreHarness['core']['eirProfiles']['create']>[1]) => {
      try {
        await h.core.eirProfiles.create(lead, input);
      } catch (err) {
        const e = err as { code: string; errors?: { path: string; message: string }[] };
        return { code: e.code, errors: e.errors?.map((x) => `${x.path}: ${x.message}`) };
      }
      return null;
    };
    // Not an EIR.
    const founderLike = (await h.core.admin.createPrincipal(owner, { displayName: 'Not An Eir' })).principal
      .id;
    expect(await field({ principalId: founderLike, displayName: 'Not An Eir' })).toEqual({
      code: 'validation_failed',
      errors: [
        'principalId: Not An Eir doesn’t have the EIR role. A platform admin gives it under People & access.',
      ],
    });
    // A disabled account.
    const disabled = await invitedEir('Disabled Eir');
    await h.t.db.system((sx) => principalsRepo.updatePrincipal(sx, disabled, { status: 'disabled' }));
    expect(await field({ principalId: disabled, displayName: 'Disabled Eir' })).toEqual({
      code: 'validation_failed',
      errors: ['principalId: Disabled Eir’s account is disabled.'],
    });
    // Someone of another program, or no one at all, is not found among this program's people.
    const outsider = await h.t.db.system(async (sx) => {
      const partner = await tenantsRepo.upsertTenant(sx, {
        slug: 'partner-x',
        name: 'Partner',
        kind: 'partner',
      });
      return (await principalsRepo.createPrincipal(sx, { tenantId: partner.id, displayName: 'Outsider' })).id;
    });
    for (const principalId of [outsider, '00000000-0000-4000-8000-000000000000']) {
      expect(await field({ principalId, displayName: 'Someone' })).toEqual({
        code: 'validation_failed',
        errors: ['principalId: Choose someone from this program.'],
      });
    }
    // Corin already has one.
    expect(await field({ principalId: h.people.eirCorin, displayName: 'Corin again' })).toEqual({
      code: 'conflict',
      errors: ['principalId: Corin Halvorsen already has an EIR profile.'],
    });
    // The contract's own limits, at their fields.
    const tooMany = Array.from({ length: 13 }, (_, i) => `area-${String(i)}`);
    const limits = await field({ principalId: disabled, displayName: 'X', expertiseTags: tooMany });
    expect(limits?.code).toBe('validation_failed');
    expect(limits?.errors?.map((e) => e.split(':')[0])).toEqual(['displayName', 'expertiseTags']);
    expect(limits?.errors).toContain('expertiseTags: List at most 12 areas.');
  });
});

describe('consent comes first', () => {
  it('a vEIR built from a new EIR is only approved once the EIR has recorded their own consent', async () => {
    const principalId = await invitedEir('Amira Nasser');
    const profile = await h.core.eirProfiles.create(lead, { principalId, displayName: 'Amira Nasser' });
    const release = await sampleRelease();
    const persona = await h.core.personas.createEirPersona(lead, {
      eirProfileId: profile.id,
      name: "Amira's vEIR",
      doctrine: release.doctrine,
      style: release.style,
      disclosureText:
        "You are talking with Amira's vEIR, an AI coach. It is not a person, and no human EIR wrote these replies.",
    });
    expect(persona).toMatchObject({ status: 'draft', hasConsent: false });
    const draft = persona.releases[0]?.id ?? '';
    await expect(h.core.eir.approveRelease(lead, draft)).rejects.toMatchObject({
      code: 'forbidden',
      reason: 'consent_required',
    });
    // A program lead can't consent for a real person.
    const consent = {
      assetTypes: ['doctrine', 'style'] as ('doctrine' | 'style')[],
      approvedUses: ['coaching'],
    };
    await expect(h.core.personas.recordConsent(lead, persona.id, consent)).rejects.toMatchObject({
      code: 'forbidden',
      reason: 'consent_by_subject_only',
    });
    const amira = await h.ctxFor(principalId);
    await h.core.personas.recordConsent(amira, persona.id, consent);
    expect((await h.core.eir.approveRelease(lead, draft)).status).toBe('approved');
    expect(await h.core.eir.getPersona(lead, persona.id)).toMatchObject({
      status: 'active',
      hasConsent: true,
    });
  });
});

describe('editing an EIR', () => {
  it('changes the name, title, expertise or bio (program lead or platform admin), audited by field', async () => {
    const principalId = await invitedEir('Lena Park');
    const profile = await h.core.eirProfiles.create(lead, {
      principalId,
      displayName: 'Lena Park',
      title: 'Operator',
      bio: 'Ran operations at two logistics start-ups.',
    });
    const edited = await h.core.eirProfiles.update(admin, profile.id, {
      title: '',
      expertiseTags: ['Supply Chain'],
    });
    expect(edited).toMatchObject({
      displayName: 'Lena Park',
      title: null,
      expertiseTags: ['supply-chain'],
      bio: 'Ran operations at two logistics start-ups.',
    });
    expect(await h.core.eirProfiles.update(lead, profile.id, { bio: null })).toMatchObject({ bio: null });
    expect(await audits('eir_profile.updated', profile.id)).toEqual([
      { actorId: admin.principalId, metadata: { fields: ['expertiseTags', 'title'] } },
      { actorId: lead.principalId, metadata: { fields: ['bio'] } },
    ]);
    for (const who of [corin, maya]) {
      await expect(h.core.eirProfiles.update(who, profile.id, { title: 'x' })).rejects.toMatchObject({
        code: 'forbidden',
      });
    }
    await expect(h.core.eirProfiles.update(lead, profile.id, {})).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(
      h.core.eirProfiles.update(lead, '00000000-0000-4000-8000-000000000000', { title: 'x' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // From another program, even by a platform admin of every program, the profile is not found.
    const partner = await h.t.db.system((sx) =>
      tenantsRepo.upsertTenant(sx, { slug: 'partner-y', name: 'P', kind: 'partner' }),
    );
    const elsewhere = createRequestContext({
      principalId: owner.principalId,
      tenantId: partner.id,
      roles: ['platform_admin'],
      requestId: 'partner',
    });
    await expect(h.core.eirProfiles.update(elsewhere, profile.id, { title: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('teaches the identity guard a new or changed name at once (a vEIR is never named as an EIR)', async () => {
    const release = await sampleRelease();
    const veir = (eirProfileId: string, name: string) =>
      h.core.personas.createEirPersona(lead, {
        eirProfileId,
        name,
        doctrine: release.doctrine,
        style: release.style,
        disclosureText: `You are talking with ${name}, an AI coach. It is not a person, and no human EIR wrote these.`,
      });
    const bea = await h.core.eirProfiles.create(lead, {
      principalId: await invitedEir('Bea Lindqvist'),
      displayName: 'Bea Lindqvist',
    });
    // The tenant's EIR names are now loaded (and cached) by the persona name check.
    await expect(veir(bea.id, 'Coach Bea vEIR')).rejects.toMatchObject({ code: 'validation_failed' });
    await h.core.eirProfiles.create(lead, {
      principalId: await invitedEir('Odile Ferrand'),
      displayName: 'Odile Ferrand',
    });
    await expect(veir(bea.id, 'Odile vEIR')).rejects.toMatchObject({ code: 'validation_failed' });
    // A renamed EIR too.
    const renamed = await h.core.eirProfiles.create(lead, {
      principalId: await invitedEir('Pat Example'),
      displayName: 'Pat Example',
    });
    await expect(veir(bea.id, 'Coach Bea vEIR')).rejects.toMatchObject({ code: 'validation_failed' });
    await h.core.eirProfiles.update(lead, renamed.id, { displayName: 'Quentin Moreau' });
    await expect(veir(bea.id, 'Quentin vEIR')).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await veir(bea.id, "Bea's vEIR")).toMatchObject({ name: "Bea's vEIR", status: 'draft' });
  });
});

describe('the lesson queue', () => {
  it('lists the drafts of every vEIR the caller curates in one request', async () => {
    const draft = (ctx: RequestContext, personaId: string, title: string) =>
      h.core.lessons.create(ctx, personaId, {
        title,
        context: 'Early discovery.',
        signal: 'Compliments counted as demand.',
        intervention: 'Ask for a commitment.',
        outcome: 'Signals that hold up.',
        limits: 'Less useful after paid pilots.',
      });
    const corinDraft = await draft(corin, h.ventures.quietquad.personaId, 'Corin queue draft');
    const ruthDraft = await draft(lead, h.ventures.benchtally.personaId, 'Ruth queue draft');
    const published = await draft(corin, h.ventures.quietquad.personaId, 'Corin published');
    await h.core.lessons.act(corin, published.id, { action: 'publish' });

    const forLead = LessonListResponse.parse(await h.core.lessons.queue(lead, { status: 'draft,in_review' }));
    const leadIds = forLead.items.map((l) => l.id);
    expect(leadIds).toEqual(expect.arrayContaining([corinDraft.id, ruthDraft.id]));
    expect(leadIds).not.toContain(published.id);
    expect(forLead.items.every((l) => l.status === 'draft' || l.status === 'in_review')).toBe(true);
    expect(forLead.total).toBe(forLead.items.length);

    const forCorin = await h.core.lessons.queue(corin, { status: 'draft' });
    expect(forCorin.items.map((l) => l.id)).toContain(corinDraft.id);
    expect(forCorin.items.every((l) => l.personaId === h.ventures.quietquad.personaId)).toBe(true);
    // Every state when none is asked for.
    expect((await h.core.lessons.queue(corin)).items.map((l) => l.id)).toContain(published.id);
    // A platform admin who curates nothing sees none; founders are refused.
    expect(await h.core.lessons.queue(admin, { status: 'draft' })).toEqual({ items: [], total: 0 });
    await expect(h.core.lessons.queue(maya, { status: 'draft' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(h.core.lessons.queue(lead, { status: 'drafts' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});
