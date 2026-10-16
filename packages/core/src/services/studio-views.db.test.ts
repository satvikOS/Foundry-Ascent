/**
 * What the EIR studio, program and admin consoles read beyond the raw records: who may curate a persona or
 * manage its consent, which personas rely on each consent, who coaches each venture, and spend per purpose.
 */
import { ConsentListResponse, PersonaView, ProgramVentureRow, UsageSummary } from '@foundry/contracts';
import { p, personasRepo, usageRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';

let h: CoreHarness;
let lead: RequestContext;
let owner: RequestContext;
let corin: RequestContext;

const corinPersona = (): string => h.ventures.quietquad.personaId;
const ruthPersona = (): string => h.ventures.benchtally.personaId;

beforeAll(async () => {
  h = await createCoreHarness();
  lead = await h.ctxFor(h.people.lead);
  owner = await h.ctxFor(h.people.owner);
  corin = await h.ctxFor(h.people.eirCorin);
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

describe('persona access for the viewer', () => {
  it('a program lead curates every persona and manages consent for synthetic EIRs', async () => {
    const personas = (await h.core.eir.listPersonas(lead)).map((p) => PersonaView.parse(p));
    const byId = new Map(personas.map((p) => [p.id, p]));
    expect(byId.get(corinPersona())).toMatchObject({ canCurate: true, canManageConsent: true });
    expect(byId.get(ruthPersona())).toMatchObject({ canCurate: true, canManageConsent: true });
    const guide = personas.find((p) => p.kind === 'neutral_guide');
    expect(guide).toMatchObject({ canCurate: true, canManageConsent: false });
  });

  it('an EIR curates only the persona built from them', async () => {
    expect(await h.core.eir.getPersona(corin, corinPersona())).toMatchObject({
      canCurate: true,
      canManageConsent: true,
    });
    expect(await h.core.eir.getPersona(corin, ruthPersona())).toMatchObject({
      canCurate: false,
      canManageConsent: false,
    });
  });

  it('suspend and resume answer with the same access flags', async () => {
    const suspended = await h.core.eir.suspendPersona(corin, corinPersona(), { reason: 'Studio test' });
    expect(suspended).toMatchObject({ status: 'suspended', canCurate: true });
    const resumed = await h.core.eir.resumePersona(corin, corinPersona());
    expect(resumed).toMatchObject({ status: 'active', canCurate: true, canManageConsent: true });
  });
});

describe('consent dependents', () => {
  it('lists the personas that rely on each consent', async () => {
    const consents = ConsentListResponse.parse({
      items: await h.core.personas.listConsents(lead, corinPersona()),
    }).items;
    const active = consents.find((c) => c.revokedAt === null);
    expect(active?.personas).toEqual([
      expect.objectContaining({ id: corinPersona(), name: "Corin's vEIR", status: 'active' }),
    ]);
  });
});

describe('consent the persona can run on', () => {
  it('refuses a consent that does not cover doctrine and keeps the one in force', async () => {
    const before = await h.core.personas.listConsents(lead, corinPersona());
    await expect(
      h.core.personas.recordConsent(lead, corinPersona(), { assetTypes: ['style', 'voice'] }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      errors: [expect.objectContaining({ path: 'assetTypes' })],
    });
    expect(await h.core.personas.listConsents(lead, corinPersona())).toHaveLength(before.length);
    expect(await h.core.eir.getPersona(lead, corinPersona())).toMatchObject({
      status: 'active',
      hasConsent: true,
    });
  });

  it('does not count a linked consent without doctrine as consent on file', async () => {
    const original = await h.t.db.system((sx) => personasRepo.getPersona(sx, corinPersona()));
    if (original?.consentId == null) throw new Error('Corin’s vEIR has no consent in the seed');
    const subject = (await h.t.db.system((sx) => personasRepo.getConsent(sx, original.consentId ?? '')))
      ?.subjectPrincipalId;
    if (!subject) throw new Error('the seeded consent has no subject');
    // A record from before doctrine was required, linked straight in the database.
    await h.t.db.system(async (sx) => {
      const legacy = await sx.query(
        `INSERT INTO consents (tenant_id, subject_principal_id, asset_types)
         VALUES (:t, :s, ARRAY['style', 'voice']::text[]) RETURNING id`,
        { t: p.uuid(h.seed.tenantId), s: p.uuid(subject) },
      );
      await personasRepo.setPersonaConsent(sx, {
        personaId: corinPersona(),
        consentId: String(legacy.rows[0]?.id),
      });
    });
    try {
      expect((await h.core.eir.getPersona(lead, corinPersona())).hasConsent).toBe(false);
    } finally {
      await h.t.db.system((sx) =>
        personasRepo.setPersonaConsent(sx, {
          personaId: corinPersona(),
          consentId: original.consentId ?? '',
        }),
      );
    }
    expect((await h.core.eir.getPersona(lead, corinPersona())).hasConsent).toBe(true);
  });
});

describe('persona names and releases', () => {
  it('refuses a vEIR name that does not say it is a vEIR', async () => {
    const ruth = await h.core.eir.getPersona(lead, ruthPersona());
    const release = await h.core.eir.getRelease(lead, ruth.activeRelease?.id ?? '');
    const profileId = ruth.eirProfile?.id ?? '';
    for (const name of ['Ruth Abernathy-Song', 'Ruth', 'Ruth here']) {
      await expect(
        h.core.personas.createEirPersona(lead, {
          eirProfileId: profileId,
          name,
          doctrine: release.doctrine,
          style: release.style,
          disclosureText: release.disclosureText,
        }),
      ).rejects.toMatchObject({
        code: 'validation_failed',
        errors: [{ path: 'name', message: "Include “vEIR”, e.g. Ruth's vEIR." }],
      });
    }
  });

  it('refuses a draft older than the active release, which would roll doctrine back', async () => {
    const ruth = await h.core.eir.getPersona(lead, ruthPersona());
    const active = await h.core.eir.getRelease(lead, ruth.activeRelease?.id ?? '');
    const content = {
      doctrine: active.doctrine,
      style: active.style,
      disclosureText: active.disclosureText,
      allowedModes: active.allowedModes,
    };
    const older = await h.core.eir.createRelease(lead, ruthPersona(), content);
    const newer = await h.core.eir.createRelease(lead, ruthPersona(), content);
    expect(newer.version).toBe(older.version + 1);
    await h.core.eir.approveRelease(lead, newer.id);
    await expect(h.core.eir.approveRelease(lead, older.id)).rejects.toMatchObject({
      code: 'conflict',
      reason: 'release_outdated',
    });
    expect((await h.core.eir.getPersona(lead, ruthPersona())).activeRelease?.id).toBe(newer.id);
  });
});

describe('program assignments', () => {
  it('shows each venture’s vEIR, reviewing EIR and start, and follows a re-assignment', async () => {
    const rows = (await h.core.program.listVentures(lead)).map((r) => ProgramVentureRow.parse(r));
    const quietquad = rows.find((r) => r.id === h.ventures.quietquad.id);
    expect(quietquad).toMatchObject({
      personaId: corinPersona(),
      personaName: "Corin's vEIR",
      reviewingEir: { displayName: 'Corin Halvorsen' },
    });
    expect(quietquad?.assignedAt).not.toBeNull();

    // A neutral guide reviewed by Ruth, then back to Corin's vEIR (reviewed by Corin).
    const guide = (await h.core.eir.listPersonas(lead)).find((p) => p.kind === 'neutral_guide');
    const ruth = (await h.core.eir.listEirProfiles(lead)).find(
      (e) => e.displayName === 'Ruth Abernathy-Song',
    );
    if (!guide || !ruth) throw new Error('seed is missing the guide or Ruth');
    const moved = ProgramVentureRow.parse(
      await h.core.personas.assignVenture(lead, h.ventures.quietquad.id, {
        personaId: guide.id,
        eirProfileId: ruth.id,
      }),
    );
    expect(moved).toMatchObject({
      personaId: guide.id,
      reviewingEir: { id: ruth.id, displayName: 'Ruth Abernathy-Song' },
    });
    const back = ProgramVentureRow.parse(
      await h.core.personas.assignVenture(lead, h.ventures.quietquad.id, {
        personaId: corinPersona(),
        eirProfileId: null,
      }),
    );
    expect(back).toMatchObject({
      personaId: corinPersona(),
      reviewingEir: { displayName: 'Corin Halvorsen' },
    });
  });
});

describe('usage by purpose', () => {
  it('totals spend per purpose, speech and distillation included', async () => {
    await h.t.db.system(async (sx) => {
      await usageRepo.recordUsage(sx, {
        purpose: 'speech',
        modelId: 'polly:generative:Matthew',
        inputTokens: 1200,
        outputTokens: 0,
        costUsd: 0.036,
      });
      await usageRepo.recordUsage(sx, {
        purpose: 'distill',
        modelId: 'mock-model',
        inputTokens: 900,
        outputTokens: 300,
        costUsd: 0.01,
      });
      await usageRepo.recordUsage(sx, {
        purpose: 'distill',
        modelId: 'mock-model',
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.002,
      });
    });
    const usage = UsageSummary.parse(await h.core.admin.usageSummary(owner));
    const speech = usage.byPurpose.find((u) => u.purpose === 'speech');
    const distill = usage.byPurpose.find((u) => u.purpose === 'distill');
    expect(speech).toMatchObject({ calls: 1, inputTokens: 1200 });
    expect(speech?.usd).toBeCloseTo(0.036, 6);
    expect(distill).toMatchObject({ calls: 2, inputTokens: 1000, outputTokens: 350 });
    expect(distill?.usd).toBeCloseTo(0.012, 6);
    // Most expensive first.
    const spend = usage.byPurpose.map((u) => u.usd);
    expect(spend).toEqual([...spend].sort((a, b) => b - a));
  });

  it('older payloads without the purpose breakdown still parse', () => {
    const parsed = UsageSummary.parse({
      todayUsd: 0,
      last30DaysUsd: 0,
      capGlobalUsd: 2,
      byDay: [],
      byModel: [],
    });
    expect(parsed.byPurpose).toEqual([]);
  });
});
