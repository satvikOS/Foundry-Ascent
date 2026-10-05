/** Exercises every repository function not covered by the scenario suites (catches SQL/decoding errors). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type DbContext } from '../db.js';
import { type SeedResult } from '../seed/seed.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import * as assignmentsRepo from './assignments.js';
import * as authRepo from './auth.js';
import * as documentsRepo from './documents.js';
import * as eirRepo from './eir.js';
import * as escalationsRepo from './escalations.js';
import * as knowledgeRepo from './knowledge.js';
import * as memoryRepo from './memory.js';
import * as personasRepo from './personas.js';
import * as principalsRepo from './principals.js';
import * as resourcesRepo from './resources.js';
import * as sessionsRepo from './sessions.js';
import * as tenantsRepo from './tenants.js';
import * as turnsRepo from './turns.js';

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

let t: TestDatabase;
let seed: SeedResult;
let maya: DbContext;
let lead: DbContext;
let corin: DbContext;
let ventureId: string;

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  if (!t.seed) throw new Error('seed missing');
  seed = t.seed;
  maya = makeContext(seed.principals.maya ?? '', seed.tenantId);
  lead = makeContext(seed.programLeadId ?? '', seed.tenantId);
  corin = makeContext(seed.principals['eir-corin'] ?? '', seed.tenantId);
  ventureId = seed.ventures.find((v) => v.key === 'quietquad')?.id ?? '';
}, 120_000);

afterAll(async () => {
  await t.cleanup();
});

describe('remaining repository functions', () => {
  it('tenants and principals', async () => {
    await t.db.system(async (sx) => {
      expect((await tenantsRepo.listTenants(sx)).map((x) => x.slug)).toEqual(['ain']);
      expect((await tenantsRepo.getTenantBySlug(sx, 'ain'))?.id).toBe(seed.tenantId);
      expect(tenantsRepo.toTenantView(must(await tenantsRepo.getTenant(sx, seed.tenantId)))).toMatchObject({
        kind: 'home',
      });
    });
    await t.db.withContext(lead, async (tx) => {
      const all = await principalsRepo.listPrincipals(tx, { tenantId: seed.tenantId, status: 'active' });
      expect(all.length).toBe(12);
      const subset = await principalsRepo.listPrincipals(tx, {
        tenantId: seed.tenantId,
        ids: [maya.principalId],
      });
      expect(subset.map((x) => x.id)).toEqual([maya.principalId]);
      expect(await principalsRepo.countPrincipals(tx, seed.tenantId)).toBe(12);
      const grants = await principalsRepo.listRoleGrants(tx, {
        principalIds: all.map((x) => x.id),
        tenantId: seed.tenantId,
      });
      expect(grants.filter((g) => g.role === 'eir')).toHaveLength(2);
      const updated = await principalsRepo.updatePrincipal(tx, maya.principalId, {
        title: 'Founder (synthetic, updated)',
      });
      expect(updated?.title).toBe('Founder (synthetic, updated)');
      expect(principalsRepo.toPrincipalView(must(updated))).toMatchObject({
        id: maya.principalId,
        synthetic: true,
      });
      expect(await principalsRepo.getPrincipal(tx, maya.principalId)).toMatchObject({ status: 'active' });
    });
  });

  it('EIR profiles, consents and personas', async () => {
    await t.db.withContext(corin, async (tx) => {
      const own = await eirRepo.getEirProfileByPrincipal(tx, corin.principalId);
      expect(own?.displayName).toBe('Corin Halvorsen');
      const updated = await eirRepo.updateEirProfile(tx, must(own).id, {
        expertiseTags: ['pricing', 'b2b-sales'],
      });
      expect(eirRepo.toEirProfileView(must(updated)).expertiseTags).toEqual(['pricing', 'b2b-sales']);
      expect(await eirRepo.getEirProfile(tx, must(own).id)).not.toBeNull();
      const consent = await personasRepo.createConsent(tx, {
        tenantId: seed.tenantId,
        subjectPrincipalId: corin.principalId,
        assetTypes: ['doctrine', 'style'],
        approvedUses: ['coaching'],
      });
      expect((await personasRepo.getConsent(tx, consent.id))?.assetTypes).toEqual(['doctrine', 'style']);
      expect(await personasRepo.listConsents(tx, corin.principalId)).toHaveLength(1);
    });
    const { personaId, consentId } = await t.db.withContext(lead, async (tx) => {
      expect(await eirRepo.listEirProfiles(tx, { tenantId: seed.tenantId })).toHaveLength(2);
      const profile = await eirRepo.createEirProfile(tx, {
        tenantId: seed.tenantId,
        displayName: 'Profile Only',
      });
      expect(profile.synthetic).toBe(true);
      const consents = await personasRepo.listConsents(tx, corin.principalId);
      const persona = await personasRepo.createPersona(tx, {
        tenantId: seed.tenantId,
        name: 'Corin persona (synthetic)',
        kind: 'eir_persona',
        eirProfileId: seed.eirs[0]?.profileId ?? null,
        consentId: consents[0]?.id ?? null,
        status: 'active',
      });
      expect((await personasRepo.getPersona(tx, persona.id))?.kind).toBe('eir_persona');
      const draft = await personasRepo.createRelease(tx, {
        personaId: persona.id,
        doctrine: must(await personasRepo.getRelease(tx, seed.releaseId)).doctrine,
        style: must(await personasRepo.getRelease(tx, seed.releaseId)).style,
        disclosureText: 'Synthetic persona disclosure text for tests only, not a person.',
        allowedModes: ['coach'],
        createdBy: lead.principalId,
      });
      expect(await personasRepo.withdrawRelease(tx, draft.id)).toBe(true);
      expect(await personasRepo.withdrawRelease(tx, draft.id)).toBe(false);
      const view = await personasRepo.getPersonaView(tx, persona.id);
      expect(view).toMatchObject({ hasConsent: true, activeRelease: null });
      return { personaId: persona.id, consentId: consents[0]?.id ?? '' };
    });
    // Revoking the consent suspends the persona that relies on it.
    expect(await t.db.withContext(corin, (tx) => personasRepo.revokeConsent(tx, consentId))).toBe(1);
    await t.db.withContext(lead, async (tx) => {
      expect(await personasRepo.getPersona(tx, personaId)).toMatchObject({
        status: 'suspended',
        suspendedReason: 'consent revoked',
      });
      expect((await personasRepo.getPersonaView(tx, personaId))?.hasConsent).toBe(false);
    });
  });

  it('assignments, knowledge sources and documents', async () => {
    await t.db.withContext(lead, async (tx) => {
      const [current] = await assignmentsRepo.listAssignments(tx, ventureId);
      expect((await assignmentsRepo.getAssignment(tx, must(current).id))?.status).toBe('active');
      expect(
        (
          await assignmentsRepo.setAssignmentStatus(tx, {
            assignmentId: must(current).id,
            status: 'suspended',
          })
        )?.status,
      ).toBe('suspended');
      expect(await assignmentsRepo.resolveActiveAssignment(tx, ventureId)).toBeNull();
      await assignmentsRepo.setAssignmentStatus(tx, { assignmentId: must(current).id, status: 'active' });
      expect(await assignmentsRepo.resolveActiveAssignment(tx, ventureId)).not.toBeNull();
    });
    await t.db.withContext(maya, async (tx) => {
      const sources = await knowledgeRepo.listKnowledgeSources(tx, { tenantId: seed.tenantId, ventureId });
      expect(sources).toHaveLength(1);
      expect((await knowledgeRepo.getKnowledgeSource(tx, must(sources[0]).id))?.scope).toBe('venture');
      expect(
        await knowledgeRepo.setKnowledgeSourceStatus(tx, { sourceId: must(sources[0]).id, status: 'stale' }),
      ).toBe(true);
      const shared = await knowledgeRepo.listKnowledgeSources(tx, {
        tenantId: seed.tenantId,
        scope: 'program',
      });
      expect(shared).toHaveLength(1);
      const doc = await documentsRepo.getDocument(tx, must(must(seed.ventures[0]).documentIds[0]));
      expect(doc?.status).toBe('ready');
    });
    await t.db.system(async (sx) => {
      const source = must(
        (await knowledgeRepo.listKnowledgeSources(sx, { tenantId: seed.tenantId, ventureId }))[0],
      );
      expect(await knowledgeRepo.deleteChunksForSource(sx, source.id)).toBeGreaterThan(0);
      const backlog = await knowledgeRepo.listMemoryMissingEmbeddings(sx, 5);
      expect(backlog).toHaveLength(5);
      expect(backlog[0]?.text.length).toBeGreaterThan(0);
      const vec = new Array<number>(1024).fill(0).map((_, i) => (i === 3 ? 1 : 0));
      expect(
        await knowledgeRepo.setMemoryEmbeddings(
          sx,
          backlog.map((b) => ({ id: b.id, embedding: vec })),
        ),
      ).toBe(5);
      const missing = await sx.query(
        `SELECT count(*) AS n FROM memory_objects WHERE status IN ('proposed', 'confirmed', 'disputed') AND embedding IS NULL`,
      );
      expect(await knowledgeRepo.listMemoryMissingEmbeddings(sx, 500)).toHaveLength(
        Number(missing.rows[0]?.n),
      );
      await expect(
        knowledgeRepo.setChunkEmbeddings(sx, [{ id: source.id, embedding: [1, 2] }]),
      ).rejects.toThrow(/1024/);
    });
  });

  it('memory supersession, lookups and session/turn/escalation leftovers', async () => {
    await t.db.withContext(maya, async (tx) => {
      const v = must(seed.ventures.find((x) => x.key === 'quietquad'));
      const oldId = must(v.memoryIds['h-seat-search']);
      const replacement = await memoryRepo.createMemory(tx, {
        tenantId: seed.tenantId,
        ventureId,
        type: 'hypothesis',
        title: 'Students lose 15+ minutes in exam weeks',
        content: 'Revised after the seat-map test.',
        origin: 'founder',
        createdBy: maya.principalId,
        status: 'confirmed',
      });
      const superseding = await memoryRepo.supersedeMemory(tx, {
        memoryId: oldId,
        replacementId: replacement.id,
        actorId: maya.principalId,
      });
      expect(superseding).toMatchObject({ supersedesId: oldId, version: 2 });
      expect((await memoryRepo.getMemory(tx, oldId))?.status).toBe('superseded');
      expect((await memoryRepo.getMemoryByIds(tx, [oldId, replacement.id])).map((m) => m.id).sort()).toEqual(
        [oldId, replacement.id].sort(),
      );
      await memoryRepo.appendMemoryEvent(tx, {
        memoryId: replacement.id,
        ventureId,
        actorId: maya.principalId,
        action: 'pinned',
      });
      expect((await memoryRepo.listMemoryHistory(tx, replacement.id)).map((e) => e.action)).toContain(
        'superseded',
      );

      const resolved = await assignmentsRepo.resolveActiveAssignment(tx, ventureId);
      const session = await sessionsRepo.createSession(tx, {
        tenantId: seed.tenantId,
        ventureId,
        assignmentId: must(resolved).assignment.id,
        personaReleaseId: must(must(resolved).release).id,
        startedBy: maya.principalId,
        mode: 'coach',
        privacy: 'ephemeral',
        policyVersion: 'test',
      });
      expect((await sessionsRepo.setSessionMode(tx, { sessionId: session.id, mode: 'rehearse' }))?.mode).toBe(
        'rehearse',
      );
      expect((await sessionsRepo.getSession(tx, session.id))?.privacy).toBe('ephemeral');
      const turn = await turnsRepo.createTurn(tx, {
        tenantId: seed.tenantId,
        ventureId,
        sessionId: session.id,
        authorId: maya.principalId,
        mode: 'rehearse',
        founderText: 'Practice my pitch',
      });
      expect(
        (await turnsRepo.finishTurn(tx, { turnId: turn.id, status: 'blocked', riskLabel: 'high' }))?.status,
      ).toBe('blocked');
      expect(await turnsRepo.finishTurn(tx, { turnId: turn.id, status: 'completed' })).toBeNull();
      expect((await turnsRepo.getTurn(tx, turn.id))?.riskLabel).toBe('high');
      expect(
        (await sessionsRepo.setSessionStatus(tx, { sessionId: session.id, status: 'ended' }))?.endedAt,
      ).not.toBeNull();

      const esc = await escalationsRepo.createEscalation(tx, {
        tenantId: seed.tenantId,
        ventureId,
        category: 'expert_judgment',
        priority: 'P3',
        status: 'awaiting_consent',
        createdBy: maya.principalId,
        packet: {
          founderQuestion: 'Original',
          desiredDecision: null,
          sharedFacts: [],
          evidenceConsidered: [],
          conflictingSignals: [],
          unknowns: [],
          reason: 'r',
          urgency: 'u',
          proposedNextStep: null,
          sessionSummary: null,
          aiGenerated: true,
        },
      });
      const edited = await escalationsRepo.updateEscalationPacket(tx, {
        escalationId: esc.id,
        packet: { ...must(esc.packet), founderQuestion: 'Edited' },
      });
      expect(edited?.packet?.founderQuestion).toBe('Edited');
      const listed = await escalationsRepo.listVentureEscalations(tx, {
        ventureId,
        statuses: ['awaiting_consent'],
      });
      expect(listed.map((e) => e.id)).toContain(esc.id);
      const withdrawn = await escalationsRepo.transitionEscalation(tx, {
        escalationId: esc.id,
        action: 'withdraw',
        actorId: maya.principalId,
      });
      expect(withdrawn?.status).toBe('withdrawn');
      expect(
        (
          await resourcesRepo.getResource(
            tx,
            must((await resourcesRepo.listResources(tx, { tenantId: seed.tenantId }))[0]).id,
          )
        )?.tenantId,
      ).toBe(seed.tenantId);
    });
  });

  it('auth session revocation helpers', async () => {
    await t.db.system(async (sx) => {
      const s1 = await authRepo.createAuthSession(sx, {
        principalId: maya.principalId,
        expiresAt: new Date(Date.now() + 1000),
      });
      const s2 = await authRepo.createAuthSession(sx, {
        principalId: maya.principalId,
        expiresAt: new Date(Date.now() + 1000),
      });
      expect(await authRepo.revokeAuthSession(sx, s1.id)).toBe(true);
      expect(await authRepo.revokeAuthSession(sx, s1.id)).toBe(false);
      expect(await authRepo.revokeAuthSessionsForPrincipal(sx, maya.principalId)).toBe(1);
      expect((await authRepo.getAuthSession(sx, s2.id))?.revokedAt).not.toBeNull();
      const owner = await authRepo.listActiveAccessCodes(sx, [must(seed.ownerId)]);
      expect((await authRepo.getAccessCode(sx, must(owner[0]).id))?.label).toBe('owner (deploy)');
    });
  });
});
