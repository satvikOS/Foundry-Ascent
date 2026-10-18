/**
 * The server names a vEIR after the EIR it is built from (its own consented profile), never after the venture
 * assignment's reviewing EIR, everywhere: identity, call configuration, venture detail and overview,
 * conversation views and disclosures, and the call's spoken intro. The fixture is an assignment whose reviewer
 * (Corin) differs from the persona's own EIR (Noor), as data written before the assignment rule, or by a
 * future change to it, could hold.
 */
import {
  CallConfigResponse,
  SessionDetailResponse,
  SessionView,
  StartCallResponse,
  VeirIdentity,
} from '@foundry/contracts';
import { assignmentsRepo, p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';

let h: CoreHarness;
let lead: RequestContext;
let priya: RequestContext;
let ventureId: string;
let personaId: string;
const DISCLOSURE =
  "You are talking with Noor's vEIR, an AI coach built from Noor Example's approved doctrine. It is not a person, and no human EIR wrote these.";

beforeAll(async () => {
  h = await createCoreHarness();
  lead = await h.ctxFor(h.people.lead);
  priya = await h.ctxFor(h.people.priya);
  ventureId = h.ventures.benchtally.id;
  // A synthetic EIR, Noor, and her vEIR with her consent (doctrine, style and voice) and an approved release.
  const profileId = await h.t.db.system(async (sx) => {
    const principal = await sx.query(
      `INSERT INTO principals (tenant_id, display_name, synthetic) VALUES (:t, 'Noor Example', true) RETURNING id`,
      { t: p.uuid(h.seed.tenantId) },
    );
    const principalId = String(principal.rows[0]?.id);
    await sx.query(`INSERT INTO role_grants (principal_id, tenant_id, role) VALUES (:p, :t, 'eir')`, {
      p: p.uuid(principalId),
      t: p.uuid(h.seed.tenantId),
    });
    const created = await sx.query(
      `INSERT INTO eir_profiles (tenant_id, principal_id, display_name, synthetic)
       VALUES (:t, :p, 'Noor Example', true) RETURNING id`,
      { t: p.uuid(h.seed.tenantId), p: p.uuid(principalId) },
    );
    return String(created.rows[0]?.id);
  });
  const corins = await h.core.eir.getPersona(lead, h.ventures.quietquad.personaId);
  const doctrine = corins.activeRelease;
  if (doctrine === null) throw new Error('Corin’s vEIR has no active release');
  const persona = await h.core.personas.createEirPersona(lead, {
    eirProfileId: profileId,
    name: "Noor's vEIR",
    doctrine: doctrine.doctrine,
    style: doctrine.style,
    disclosureText: DISCLOSURE,
  });
  personaId = persona.id;
  await h.core.personas.recordConsent(lead, personaId, {
    assetTypes: ['doctrine', 'style', 'voice'],
    evidenceRef: 'Synthetic consent form (test)',
  });
  await h.core.personas.updateEmbodiment(lead, personaId, { voiceId: 'Joanna' });
  await h.core.eir.approveRelease(lead, persona.releases[0]?.id ?? '');
  const corinProfile = h.seed.eirs.find((e) => e.key === 'eir-corin')?.profileId;
  if (corinProfile === undefined) throw new Error('seed is missing Corin’s profile');
  await h.t.db.system(async (sx) => {
    // Named before vEIRs had to carry "vEIR" (a bare EIR name), and reviewed by another EIR than its own.
    await sx.query(`UPDATE personas SET name = 'Noor' WHERE id = :id`, { id: p.uuid(personaId) });
    await assignmentsRepo.createAssignment(sx, {
      tenantId: h.seed.tenantId,
      ventureId,
      personaId,
      eirProfileId: corinProfile,
    });
  });
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

describe('vEIR attribution when the reviewing EIR is not the vEIR’s own', () => {
  it('the fixture: the venture is reviewed by Corin and coached by Noor’s vEIR', async () => {
    const resolved = await h.t.db.system((sx) => assignmentsRepo.resolveActiveAssignment(sx, ventureId));
    expect(resolved?.persona.id).toBe(personaId);
    expect(resolved?.eir?.displayName).toBe('Corin Halvorsen');
  });

  it('identity and call configuration name the persona’s own EIR', async () => {
    const identity = VeirIdentity.parse(await h.core.veir.identity(priya, ventureId));
    expect(identity).toMatchObject({
      personaId,
      kind: 'eir_persona',
      shortName: 'Noor',
      eirDisplayName: 'Noor Example',
      disclosure: DISCLOSURE,
    });
    const config = CallConfigResponse.parse(await h.core.veir.callConfig(priya, ventureId));
    expect(config.veir).toEqual(identity);
    expect(JSON.stringify([identity, config])).not.toContain('Corin');
  });

  it('venture detail, overview and conversation views carry the persona, never the reviewer, as the vEIR', async () => {
    const detail = await h.core.ventures.get(priya, ventureId);
    expect(detail.persona).toMatchObject({
      personaId,
      name: 'Noor',
      kind: 'eir_persona',
      disclosure: DISCLOSURE,
    });
    // The reviewer stays named as the person who reviews the venture, apart from the vEIR.
    expect(detail.assignedEir?.displayName).toBe('Corin Halvorsen');
    expect(JSON.stringify(detail.persona)).not.toContain('Corin');
    const overview = await h.core.ventures.overview(priya, ventureId);
    expect(overview.venture.persona).toEqual(detail.persona);

    const session = SessionView.parse(await h.core.sessions.create(priya, ventureId, {}));
    expect(session).toMatchObject({ personaId, personaName: 'Noor', disclosure: DISCLOSURE });
    const reloaded = SessionDetailResponse.parse(await h.core.sessions.get(priya, session.id));
    expect(reloaded.session).toMatchObject({ personaName: 'Noor', disclosure: DISCLOSURE });
    expect(JSON.stringify(reloaded.session)).not.toContain('Corin');
  });

  it('the call introduces Noor’s vEIR on a first meeting, as Noor’s digital twin, and greets afterwards', async () => {
    // A first meeting: none of Priya's earlier conversations of the venture is left.
    for (const earlier of await h.core.sessions.list(priya, ventureId)) {
      await h.core.sessions.remove(priya, earlier.id);
    }
    const session = SessionView.parse(await h.core.sessions.create(priya, ventureId, {}));
    const started = StartCallResponse.parse(await h.core.calls.start(priya, session.id, {}));
    expect(started.intro?.text).toMatch(/^Hi Priya, I'm Noor's vEIR, Noor's digital twin\. /);
    expect(started.intro?.text).not.toContain('Corin');
    await h.core.calls.end(priya, started.call.id, { reason: 'user' });
    // Met now: the next call in another conversation greets her.
    const next = SessionView.parse(await h.core.sessions.create(priya, ventureId, {}));
    const again = StartCallResponse.parse(await h.core.calls.start(priya, next.id, {}));
    expect(again.intro?.text).toMatch(/^Hi Priya\. /);
    await h.core.calls.end(priya, again.call.id, { reason: 'user' });
  });
});
