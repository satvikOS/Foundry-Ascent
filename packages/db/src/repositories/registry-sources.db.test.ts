/**
 * Repositories behind wave 3 of the studio: the EIR registry (people a profile can be linked to, profiles with
 * their account), the curator's lesson queue in one statement, the knowledge source recorded with each cited
 * passage, and a document's knowledge source.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { p } from '../params.js';
import { type SeedResult } from '../seed/seed.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import * as assignmentsRepo from './assignments.js';
import * as documentsRepo from './documents.js';
import * as eirRepo from './eir.js';
import * as personasRepo from './personas.js';
import * as principalsRepo from './principals.js';
import * as resourcesRepo from './resources.js';
import * as retrievalRepo from './retrieval.js';
import * as sessionsRepo from './sessions.js';
import * as tenantsRepo from './tenants.js';
import * as turnsRepo from './turns.js';

let t: TestDatabase;
let seed: SeedResult;
let adminOnly: string;

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

const lead = () => makeContext(must(seed.programLeadId), seed.tenantId);
const admin = () => makeContext(adminOnly, seed.tenantId);
const person = (key: string) => makeContext(must(seed.principals[key]), seed.tenantId);
const veir = (eirKey: string) => must(seed.veirs.find((v) => v.eirKey === eirKey));

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  seed = must(t.seed);
  adminOnly = await t.db.system(async (sx) => {
    const created = await principalsRepo.createPrincipal(sx, {
      tenantId: seed.tenantId,
      displayName: 'Admin Only',
    });
    await principalsRepo.grantRole(sx, {
      principalId: created.id,
      tenantId: seed.tenantId,
      role: 'platform_admin',
    });
    return created.id;
  });
}, 120_000);

afterAll(async () => {
  await t.cleanup();
});

describe('EIR registry', () => {
  it('offers the tenant’s active EIRs without a profile to link one to, to program leads and admins alike', async () => {
    const people = await t.db.system(async (sx) => {
      const make = async (displayName: string, tenantId = seed.tenantId) =>
        principalsRepo.createPrincipal(sx, { tenantId, displayName, title: 'Investor' });
      const ready = await make('Noor Haddad');
      const disabled = await make('Disabled Eir');
      const noRole = await make('Not An Eir');
      const partner = await tenantsRepo.upsertTenant(sx, {
        slug: 'partner-r',
        name: 'Partner',
        kind: 'partner',
      });
      const elsewhere = await make('Elsewhere Eir', partner.id);
      for (const [eir, tenantId] of [
        [ready, seed.tenantId],
        [disabled, seed.tenantId],
        [elsewhere, partner.id],
      ] as const) {
        await principalsRepo.grantRole(sx, { principalId: eir.id, tenantId, role: 'eir' });
      }
      await principalsRepo.updatePrincipal(sx, disabled.id, { status: 'disabled' });
      return { ready, noRole };
    });
    for (const who of [lead(), admin()]) {
      const candidates = await t.db.withContext(who, (tx) =>
        eirRepo.listEirProfileCandidates(tx, seed.tenantId),
      );
      // The seeded EIRs already have profiles; the disabled, role-less and other-tenant people are not offered.
      expect(candidates).toEqual([
        { id: people.ready.id, displayName: 'Noor Haddad', title: 'Investor', synthetic: false },
      ]);
    }
    const profile = await t.db.withContext(lead(), (tx) =>
      eirRepo.createEirProfile(tx, {
        tenantId: seed.tenantId,
        principalId: people.ready.id,
        displayName: 'Noor Haddad',
        expertiseTags: ['climate-tech'],
        bio: 'Founded a grid-storage company.',
        synthetic: false,
      }),
    );
    expect(
      await t.db.withContext(lead(), (tx) => eirRepo.listEirProfileCandidates(tx, seed.tenantId)),
    ).toEqual([]);
    // Every EIR-studio role reads the registry with each profile's account.
    const views = await t.db.withContext(person('eir-corin'), (tx) =>
      eirRepo.listEirProfileViews(tx, seed.tenantId),
    );
    expect(views.find((v) => v.id === profile.id)).toMatchObject({
      displayName: 'Noor Haddad',
      bio: 'Founded a grid-storage company.',
      synthetic: false,
      principal: { id: people.ready.id, displayName: 'Noor Haddad', title: 'Investor', synthetic: false },
    });
    expect(views.find((v) => v.displayName === 'Corin Halvorsen')?.principal?.id).toBe(
      seed.principals['eir-corin'],
    );
    const accountless = await t.db.withContext(lead(), (tx) =>
      eirRepo.createEirProfile(tx, { tenantId: seed.tenantId, displayName: 'Profile Without Account' }),
    );
    expect(
      await t.db.withContext(lead(), (tx) => eirRepo.getEirProfileView(tx, accountless.id)),
    ).toMatchObject({
      principal: null,
      bio: null,
    });
  });
});

describe('the curator’s lesson queue', () => {
  it('lists the lessons of every vEIR a curator curates in one statement, newest change first', async () => {
    const corin = veir('eir-corin');
    const ruth = veir('eir-ruth');
    const ids = await t.db.system(async (sx) => {
      const lesson = (title: string, personaId: string | null, status: 'draft' | 'published' = 'draft') =>
        resourcesRepo.createPattern(sx, {
          tenantId: seed.tenantId,
          personaId,
          title,
          context: 'Context.',
          signal: 'Signal.',
          intervention: 'Intervention.',
          outcome: 'Outcome.',
          limits: 'Limits.',
          sourceClass: 'authored',
          status,
        });
      const retired = await personasRepo.createPersona(sx, {
        tenantId: seed.tenantId,
        name: 'Retired vEIR',
        kind: 'eir_persona',
        eirProfileId: must(seed.eirs.find((e) => e.key === 'eir-corin')).profileId,
        status: 'retired',
      });
      const corinDraft = (await lesson('Corin draft', corin.personaId)).id;
      // One transaction stamps every row alike: Corin's draft changed an hour earlier.
      await sx.query(`UPDATE patterns SET updated_at = now() - interval '1 hour' WHERE id = :id`, {
        id: p.uuid(corinDraft),
      });
      return {
        corinDraft,
        ruthDraft: (await lesson('Ruth draft', ruth.personaId)).id,
        programWide: (await lesson('Program-wide draft', null)).id,
        retiredDraft: (await lesson('Retired vEIR draft', retired.id)).id,
        corinPublished: (await lesson('Corin published', corin.personaId, 'published')).id,
      };
    });
    const queue = (who: ReturnType<typeof makeContext>, allPersonas: boolean, limit?: number) =>
      t.db.withContext(who, (tx) =>
        resourcesRepo.listCuratedLessons(tx, {
          tenantId: seed.tenantId,
          curatorId: who.principalId,
          allPersonas,
          statuses: ['draft', 'in_review'],
          ...(limit === undefined ? {} : { limit }),
        }),
      );

    // A program lead: every non-retired vEIR's drafts; never program-wide lessons or a retired vEIR's.
    const all = await queue(lead(), true);
    expect(all.items.map((l) => l.id)).toEqual([ids.ruthDraft, ids.corinDraft]);
    expect(all.total).toBe(2);
    // An EIR: the drafts of the vEIR built from them only.
    const own = await queue(person('eir-corin'), false);
    expect(own.items.map((l) => l.id)).toEqual([ids.corinDraft]);
    // Someone curating no vEIR (a founder) gets none.
    expect((await queue(person('maya'), false)).items).toEqual([]);
    // Bounded, with how many match.
    const first = await queue(lead(), true, 1);
    expect(first).toMatchObject({ total: 2 });
    expect(first.items.map((l) => l.id)).toEqual([ids.ruthDraft]);
    // Every state when no status is given: the published one too.
    const everything = await t.db.withContext(person('eir-corin'), (tx) =>
      resourcesRepo.listCuratedLessons(tx, {
        tenantId: seed.tenantId,
        curatorId: person('eir-corin').principalId,
        allPersonas: false,
      }),
    );
    expect(everything.items.map((l) => l.id)).toEqual(expect.arrayContaining([ids.corinPublished]));
    expect(everything.items.every((l) => l.personaId === corin.personaId)).toBe(true);
  });
});

describe('the source of a cited passage', () => {
  it('is recorded with the answer for passages only and read back by id and scope', async () => {
    const quietquad = must(seed.ventures.find((v) => v.key === 'quietquad'));
    const maya = person('maya');
    const result = await t.db.withContext(maya, async (tx) => {
      const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, quietquad.id));
      const session = await sessionsRepo.createSession(tx, {
        tenantId: seed.tenantId,
        ventureId: quietquad.id,
        assignmentId: resolved.assignment.id,
        personaReleaseId: must(resolved.release).id,
        startedBy: maya.principalId,
        mode: 'coach',
        privacy: 'standard',
        policyVersion: 'test',
      });
      const turn = await turnsRepo.createTurn(tx, {
        tenantId: seed.tenantId,
        ventureId: quietquad.id,
        sessionId: session.id,
        authorId: maya.principalId,
        mode: 'coach',
        founderText: 'Where are the quiet seats during finals?',
      });
      const [chunk] = await retrievalRepo.searchVentureChunks(tx, {
        tenantId: seed.tenantId,
        ventureId: quietquad.id,
        query: 'library seats finals',
        embedding: null,
        limit: 1,
      });
      const [shared] = await retrievalRepo.searchSharedChunks(tx, {
        tenantId: seed.tenantId,
        personaId: veir('eir-corin').personaId,
        query: 'kill criterion repeat users prediction',
        embedding: null,
        limit: 1,
      });
      const passage = must(chunk);
      const library = must(shared);
      expect(passage).toMatchObject({ sourceScope: 'venture' });
      expect(library).toMatchObject({ kind: 'doctrine', sourceScope: 'persona' });
      const [memory] = await retrievalRepo.searchVentureMemory(tx, {
        tenantId: seed.tenantId,
        ventureId: quietquad.id,
        query: 'library',
        embedding: null,
        limit: 1,
      });
      expect(memory?.sourceScope ?? null).toBeNull();
      await turnsRepo.insertTurnEvidence(tx, turn.id, [
        {
          key: 'E1',
          kind: 'chunk',
          refId: passage.refId,
          score: 0.9,
          title: passage.title,
          ventureId: quietquad.id,
          source: { id: must(passage.sourceId), scope: 'venture' },
        },
        {
          key: 'E2',
          kind: 'doctrine',
          refId: library.refId,
          score: 0.8,
          title: library.title,
          source: { id: must(library.sourceId), scope: 'persona' },
        },
        // A source given for something other than a passage is not recorded.
        {
          key: 'E3',
          kind: 'memory',
          refId: must(memory).refId,
          score: 0.7,
          title: must(memory).title,
          ventureId: quietquad.id,
          source: { id: must(passage.sourceId), scope: 'venture' },
        },
        { key: 'E4', kind: 'chunk', refId: library.refId, score: 0.6, title: 'No source given' },
      ]);
      return {
        evidence: must((await turnsRepo.listTurnEvidence(tx, [turn.id])).get(turn.id)),
        passageSource: must(passage.sourceId),
        librarySource: must(library.sourceId),
        documents: await documentsRepo.listDocuments(tx, quietquad.id),
      };
    });
    expect(result.evidence.map((e) => [e.key, e.source])).toEqual([
      ['E1', { id: result.passageSource, scope: 'venture' }],
      ['E2', { id: result.librarySource, scope: 'persona' }],
      ['E3', null],
      ['E4', null],
    ]);
    // The cited passage's document carries the same source id, so the citation links to it by id.
    const cited = result.documents.filter((d) => d.sourceId === result.passageSource);
    expect(cited).toHaveLength(1);
    expect(result.documents.every((d) => d.status !== 'ready' || d.sourceId !== null)).toBe(true);
  });
});
