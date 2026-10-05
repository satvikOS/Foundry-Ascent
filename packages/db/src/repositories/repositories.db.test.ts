import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DocumentView,
  EscalationView,
  PersonaView,
  ResourceView,
  SessionView,
  TurnView,
  VentureSummary,
} from '@foundry/contracts';

import { type DbContext } from '../db.js';
import { p } from '../params.js';
import { GUIDE_DOCTRINE, GUIDE_STYLE } from '../seed/doctrine.js';
import { type SeedResult } from '../seed/seed.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import * as assignmentsRepo from './assignments.js';
import * as authRepo from './auth.js';
import * as documentsRepo from './documents.js';
import * as escalationsRepo from './escalations.js';
import * as idempotencyRepo from './idempotency.js';
import * as knowledgeRepo from './knowledge.js';
import * as personasRepo from './personas.js';
import * as principalsRepo from './principals.js';
import * as resourcesRepo from './resources.js';
import * as sessionsRepo from './sessions.js';
import * as settingsRepo from './settings.js';
import * as tenantsRepo from './tenants.js';
import * as turnsRepo from './turns.js';
import * as usageRepo from './usage.js';
import * as venturesRepo from './ventures.js';

let t: TestDatabase;
let seed: SeedResult;
let ventureId: string;
let maya: DbContext;
let lead: DbContext;
let ruth: DbContext;
let amara: DbContext;

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  if (!t.seed) throw new Error('seed missing');
  seed = t.seed;
  ventureId = seed.ventures.find((v) => v.key === 'quietquad')?.id ?? '';
  maya = makeContext(seed.principals.maya ?? '', seed.tenantId);
  lead = makeContext(seed.programLeadId ?? '', seed.tenantId);
  ruth = makeContext(seed.principals['eir-ruth'] ?? '', seed.tenantId);
  amara = makeContext(seed.principals.amara ?? '', seed.tenantId);
}, 120_000);

afterAll(async () => {
  await t.cleanup();
});

describe('tenants, principals, ventures', () => {
  it('reads the tenant, roles, memberships and assignment-derived access', async () => {
    await t.db.withContext(maya, async (tx) => {
      const tenant = await tenantsRepo.getTenant(tx, seed.tenantId);
      expect(tenant?.slug).toBe('ain');
      expect(
        await principalsRepo.listActiveRoles(tx, { principalId: maya.principalId, tenantId: seed.tenantId }),
      ).toEqual([]);
      const memberships = await principalsRepo.listMembershipsForPrincipals(tx, [maya.principalId]);
      expect(memberships).toEqual([
        { principalId: maya.principalId, ventureId, ventureName: 'QuietQuad', role: 'founder' },
      ]);
      const access = await venturesRepo.getVentureAccess(tx, { ventureId, principalId: maya.principalId });
      expect(access).toMatchObject({
        membershipRole: 'founder',
        isAssignedEir: false,
        tenantId: seed.tenantId,
      });
      const summary = await venturesRepo.getVentureSummary(tx, { ventureId, principalId: maya.principalId });
      expect(VentureSummary.safeParse(summary).success).toBe(true);
      const team = await venturesRepo.listTeam(tx, ventureId);
      expect(team.map((m) => m.role)).toEqual(['founder', 'team']);
      const updated = await venturesRepo.updateVenture(tx, ventureId, {
        currentGoal: 'Run the exam-week pilot',
      });
      expect(updated?.currentGoal).toBe('Run the exam-week pilot');
    });
    const corin = makeContext(seed.principals['eir-corin'] ?? '', seed.tenantId);
    await t.db.withContext(corin, async (tx) => {
      expect(
        await principalsRepo.listActiveRoles(tx, { principalId: corin.principalId, tenantId: seed.tenantId }),
      ).toEqual(['eir']);
      const assigned = await principalsRepo.listAssignedVentureIds(tx, corin.principalId);
      expect(assigned).toHaveLength(2);
      const access = await venturesRepo.getVentureAccess(tx, { ventureId, principalId: corin.principalId });
      expect(access).toMatchObject({ membershipRole: null, isAssignedEir: true });
    });
  });

  it('lets a program lead create principals, ventures, memberships and assignments', async () => {
    await t.db.withContext(lead, async (tx) => {
      const person = await principalsRepo.createPrincipal(tx, {
        tenantId: seed.tenantId,
        displayName: 'New Founder',
        email: 'new.founder@example.edu',
        synthetic: true,
      });
      expect(
        await principalsRepo.grantRole(tx, { principalId: person.id, tenantId: seed.tenantId, role: 'eir' }),
      ).toBe(true);
      expect(
        await principalsRepo.grantRole(tx, { principalId: person.id, tenantId: seed.tenantId, role: 'eir' }),
      ).toBe(false);
      expect(
        await principalsRepo.revokeRole(tx, { principalId: person.id, tenantId: seed.tenantId, role: 'eir' }),
      ).toBe(1);
      const v = await venturesRepo.createVenture(tx, {
        tenantId: seed.tenantId,
        name: 'Fresh Venture',
        stage: 'idea',
      });
      await venturesRepo.addMembership(tx, {
        ventureId: v.id,
        principalId: person.id,
        role: 'founder',
        grantedBy: lead.principalId,
      });
      await venturesRepo.addMembership(tx, {
        ventureId: v.id,
        principalId: person.id,
        role: 'team',
        grantedBy: lead.principalId,
      });
      const first = await assignmentsRepo.createAssignment(tx, {
        tenantId: seed.tenantId,
        ventureId: v.id,
        personaId: seed.personaId,
        createdBy: lead.principalId,
      });
      const second = await assignmentsRepo.createAssignment(tx, {
        tenantId: seed.tenantId,
        ventureId: v.id,
        personaId: seed.personaId,
        eirProfileId: seed.eirs[0]?.profileId ?? null,
        allowedModes: ['coach', 'route'],
        createdBy: lead.principalId,
      });
      const all = await assignmentsRepo.listAssignments(tx, v.id);
      expect(all.find((a) => a.id === first.id)?.status).toBe('ended');
      const resolved = await assignmentsRepo.resolveActiveAssignment(tx, v.id);
      expect(resolved?.assignment.id).toBe(second.id);
      expect(resolved?.assignment.allowedModes).toEqual(['coach', 'route']);
      expect(resolved?.release?.version).toBe(1);
      expect(resolved?.eir?.synthetic).toBe(true);
      const rows = await venturesRepo.listProgramVentures(tx, seed.tenantId);
      expect(rows.find((r) => r.id === v.id)).toMatchObject({ memberCount: 1, personaName: 'Foundry Guide' });
      expect(await venturesRepo.revokeMembership(tx, { ventureId: v.id, principalId: person.id })).toBe(1);
    });
  });
});

describe('auth (system executor)', () => {
  it('handles access codes, sessions, attempts and keys', async () => {
    await t.db.system(async (sx) => {
      const code = await authRepo.createAccessCode(sx, {
        principalId: seed.principals.maya ?? '',
        prefix: 'ZZZZ1',
        hash: 'scrypt$N=32768,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        label: 'test',
        createdBy: seed.ownerId,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      expect(await authRepo.accessCodePrefixExists(sx, 'ZZZZ1')).toBe(true);
      const lookup = await authRepo.findAccessCodeByPrefix(sx, 'ZZZZ1');
      expect(lookup).toMatchObject({
        id: code.id,
        principalStatus: 'active',
        tenantStatus: 'active',
        revokedAt: null,
      });
      expect(await authRepo.listActiveAccessCodes(sx, [seed.principals.maya ?? ''])).toHaveLength(1);
      const session = await authRepo.createAuthSession(sx, {
        principalId: seed.principals.maya ?? '',
        accessCodeId: code.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      expect(session.tenantId).toBe(seed.tenantId);
      await authRepo.markAccessCodeUsed(sx, code.id);
      const revoked = await authRepo.revokeAccessCode(sx, code.id);
      expect(revoked?.revokedAt).not.toBeNull();
      expect((await authRepo.getAuthSession(sx, session.id))?.revokedAt).not.toBeNull();
      expect(await authRepo.listActiveAccessCodes(sx, [seed.principals.maya ?? ''])).toHaveLength(0);

      for (let i = 0; i < 3; i += 1)
        await authRepo.recordAuthAttempt(sx, { subjectHash: 'ip-1', succeeded: false });
      await authRepo.recordAuthAttempt(sx, { subjectHash: 'ip-1', succeeded: true });
      const window = await authRepo.authFailureWindow(sx, { subjectHash: 'ip-1', windowSeconds: 900 });
      expect(window.failures).toBe(3);
      expect(window.lastFailureAt).not.toBeNull();
      expect(await authRepo.pruneAuthAttempts(sx, 0)).toBeGreaterThanOrEqual(0);

      const key = await authRepo.getActivePlatformKey(sx, 'session_signing');
      expect(Buffer.from(key?.keyBase64 ?? '', 'base64')).toHaveLength(32);
      const rotated = await authRepo.rotatePlatformKey(sx, 'session_signing');
      expect(rotated.id).not.toBe(key?.id);
      const verification = await authRepo.listVerificationKeys(sx, {
        purpose: 'session_signing',
        graceSeconds: 3600,
      });
      expect(verification.map((k) => k.id)).toEqual([rotated.id, key?.id]);
    });
  });
});

describe('usage, idempotency, settings (system executor)', () => {
  it('sums daily spend in UTC and aggregates by day and model', async () => {
    await t.db.system(async (sx) => {
      await usageRepo.recordUsage(sx, {
        tenantId: seed.tenantId,
        principalId: maya.principalId,
        purpose: 'turn',
        modelId: 'openai.gpt-6-luna',
        inputTokens: 1000,
        outputTokens: 200,
        costUsd: 0.12,
        requestId: 'r1',
      });
      await usageRepo.recordUsage(sx, {
        purpose: 'embedding',
        modelId: 'amazon.titan-embed-text-v2:0',
        inputTokens: 500,
        outputTokens: 0,
        costUsd: 0.00001,
      });
      await sx.query(
        `INSERT INTO usage_ledger (purpose, model_id, cost_usd, at) VALUES ('turn', 'old', 5, now() - interval '3 days')`,
      );
      expect(await usageRepo.spendToday(sx)).toBeCloseTo(0.12001, 6);
      expect(await usageRepo.spendToday(sx, { principalId: maya.principalId })).toBeCloseTo(0.12, 6);
      expect(await usageRepo.spendLastDays(sx, 30)).toBeCloseTo(5.12001, 6);
      const byDay = await usageRepo.usageByDay(sx, 7);
      expect(byDay).toHaveLength(7);
      expect(byDay[6]?.day).toBe(new Date().toISOString().slice(0, 10));
      expect(byDay[6]?.turns).toBe(1);
      expect(byDay.reduce((s, d) => s + d.usd, 0)).toBeCloseTo(5.12001, 6);
      const byModel = await usageRepo.usageByModel(sx, 30);
      expect(byModel[0]).toMatchObject({ modelId: 'old', usd: 5 });
      const summary = await usageRepo.getUsageSummary(sx, 30);
      expect(summary.byDay).toHaveLength(30);
    });
  });

  it('stores idempotent responses with a 24 h window', async () => {
    await t.db.system(async (sx) => {
      const key = { principalId: maya.principalId, route: 'POST /ventures/:id/memory', key: 'k-1' };
      expect(await idempotencyRepo.getIdempotencyRecord(sx, key)).toBeNull();
      expect(
        await idempotencyRepo.saveIdempotencyRecord(sx, {
          ...key,
          requestHash: 'h1',
          statusCode: 201,
          response: { id: 1 },
        }),
      ).toBe(true);
      expect(
        await idempotencyRepo.saveIdempotencyRecord(sx, {
          ...key,
          requestHash: 'h2',
          statusCode: 201,
          response: { id: 2 },
        }),
      ).toBe(false);
      expect(await idempotencyRepo.getIdempotencyRecord(sx, key)).toMatchObject({
        requestHash: 'h1',
        statusCode: 201,
        response: { id: 1 },
      });
      await sx.query(`UPDATE idempotency_keys SET created_at = now() - interval '25 hours'`);
      expect(await idempotencyRepo.getIdempotencyRecord(sx, key)).toBeNull();
      expect(
        await idempotencyRepo.saveIdempotencyRecord(sx, {
          ...key,
          requestHash: 'h3',
          statusCode: 200,
          response: [],
        }),
      ).toBe(true);
      expect(await idempotencyRepo.pruneIdempotencyKeys(sx)).toBe(0);
    });
  });

  it('reads settings for any principal and updates them via the system executor', async () => {
    const settings = await t.db.withContext(maya, (tx) => settingsRepo.getPlatformSettings(tx));
    expect(settings).toEqual({
      aiEnabled: true,
      dailyUsdCapGlobal: 2,
      dailyUsdCapPerPrincipal: 0.5,
      maxTurnsPerSession: 40,
      groundingCoverageThreshold: 0.6,
      portfolioMinGroupSize: 3,
    });
    const updated = await t.db.system((sx) =>
      settingsRepo.updatePlatformSettings(sx, { aiEnabled: false, dailyUsdCapGlobal: 3.5 }, seed.ownerId),
    );
    expect(updated).toMatchObject({ aiEnabled: false, dailyUsdCapGlobal: 3.5, maxTurnsPerSession: 40 });
    const denied = t.db.withContext(maya, (tx) =>
      tx.query(`UPDATE platform_settings SET value = 'true' WHERE key = 'ai_enabled'`),
    );
    await expect(denied).rejects.toMatchObject({ sqlState: '42501' });
  });
});

describe('personas and resources', () => {
  it('versions releases, supersedes on approval and suspends without engineering', async () => {
    await t.db.withContext(lead, async (tx) => {
      const draft = await personasRepo.createRelease(tx, {
        personaId: seed.personaId,
        doctrine: GUIDE_DOCTRINE,
        style: { ...GUIDE_STYLE, directness: 'balanced' },
        disclosureText: 'You are working with Foundry Guide, an AI coach. It is not a person (v2).',
        allowedModes: ['coach', 'challenge'],
        createdBy: lead.principalId,
      });
      expect(draft).toMatchObject({ version: 2, status: 'draft' });
      const approved = await personasRepo.approveRelease(tx, {
        releaseId: draft.id,
        approvedBy: lead.principalId,
      });
      expect(approved?.status).toBe('approved');
      const releases = await personasRepo.listReleases(tx, seed.personaId);
      expect(releases.map((r) => [r.version, r.status])).toEqual([
        [2, 'approved'],
        [1, 'superseded'],
      ]);
      expect((await personasRepo.getActiveRelease(tx, seed.personaId))?.version).toBe(2);
      const suspended = await personasRepo.setPersonaStatus(tx, {
        personaId: seed.personaId,
        status: 'suspended',
        reason: 'Calibration review',
      });
      expect(suspended).toMatchObject({ status: 'suspended', suspendedReason: 'Calibration review' });
      const views = await personasRepo.listPersonaViews(tx, seed.tenantId);
      expect(views).toHaveLength(1);
      expect(PersonaView.safeParse(views[0]).success).toBe(true);
      // Four seeded ventures plus the one created by the program-lead test above.
      expect(views[0]).toMatchObject({ assignedVentureCount: 5, hasConsent: false, status: 'suspended' });
      expect(views[0]?.activeRelease?.version).toBe(2);
      const resumed = await personasRepo.setPersonaStatus(tx, {
        personaId: seed.personaId,
        status: 'active',
      });
      expect(resumed?.suspendedReason).toBeNull();
    });
  });

  it('lists, creates and updates resources', async () => {
    await t.db.withContext(lead, async (tx) => {
      const all = await resourcesRepo.listResources(tx, { tenantId: seed.tenantId });
      expect(all.length).toBe(16);
      expect(all.every((r) => ResourceView.safeParse(r).success)).toBe(true);
      const funding = await resourcesRepo.listResources(tx, {
        tenantId: seed.tenantId,
        kind: 'funding',
        stage: 'validation',
      });
      expect(funding.length).toBeGreaterThan(0);
      const search = await resourcesRepo.listResources(tx, {
        tenantId: seed.tenantId,
        q: 'makerspace prototypes',
      });
      expect(search.map((r) => r.name)).toEqual(['Prototype lab access']);
      const created = await resourcesRepo.createResource(tx, {
        tenantId: seed.tenantId,
        name: 'Test resource',
        kind: 'other',
        description: 'Desc',
        tags: ['x'],
        stages: ['idea'],
      });
      const updated = await resourcesRepo.updateResource(tx, created.id, { status: 'retired' });
      expect(updated?.status).toBe('retired');
      expect(
        (await resourcesRepo.listResources(tx, { tenantId: seed.tenantId })).some((r) => r.id === created.id),
      ).toBe(false);
      expect(await resourcesRepo.listPatterns(tx, { tenantId: seed.tenantId })).toHaveLength(3);
    });
  });
});

describe('documents, sessions, turns, escalations', () => {
  it('runs a document through ingestion states and soft deletion', async () => {
    const doc = await t.db.withContext(maya, (tx) =>
      documentsRepo.createDocument(tx, {
        id: '11111111-1111-4111-8111-111111111111',
        tenantId: seed.tenantId,
        ventureId,
        filename: 'notes.md',
        contentType: 'text/markdown',
        sizeBytes: 42,
        s3Key: `tenants/${seed.tenantId}/ventures/${ventureId}/documents/11111111-1111-4111-8111-111111111111/notes.md`,
        uploadedBy: maya.principalId,
      }),
    );
    expect(doc.status).toBe('pending_upload');
    expect(
      await t.db.withContext(maya, (tx) =>
        documentsRepo.setDocumentStatus(tx, {
          documentId: doc.id,
          status: 'processing',
          fromStatuses: ['pending_upload'],
        }),
      ),
    ).toMatchObject({ status: 'processing' });
    // Worker (system): source + chunks, then ready.
    await t.db.system(async (sx) => {
      const source = await knowledgeRepo.createKnowledgeSource(sx, {
        tenantId: seed.tenantId,
        scope: 'venture',
        ventureId,
        title: 'notes.md',
        classification: 'venture_private',
        createdBy: maya.principalId,
      });
      await knowledgeRepo.insertChunks(sx, {
        sourceId: source.id,
        tenantId: seed.tenantId,
        scope: 'venture',
        ventureId,
        chunks: [
          { ordinal: 1, heading: 'A', content: 'First chunk', tokenCount: 3 },
          {
            ordinal: 2,
            heading: 'B',
            content: 'Second chunk',
            tokenCount: 3,
            embedding: new Array<number>(1024).fill(0.01),
          },
        ],
        maxPayloadChars: 10,
      });
      expect(await knowledgeRepo.countChunks(sx, source.id)).toBe(2);
      const ready = await documentsRepo.setDocumentStatus(sx, {
        documentId: doc.id,
        status: 'ready',
        sourceId: source.id,
        fromStatuses: ['processing'],
      });
      expect(ready?.sourceId).toBe(source.id);
    });
    const list = await t.db.withContext(maya, (tx) => documentsRepo.listDocuments(tx, ventureId));
    expect(list.every((d) => DocumentView.safeParse(d).success)).toBe(true);
    expect(list.find((d) => d.id === doc.id)).toMatchObject({ status: 'ready', chunkCount: 2 });
    const key = await t.db.withContext(maya, (tx) => documentsRepo.softDeleteDocument(tx, doc.id));
    expect(key).toBe(doc.s3Key);
    await t.db.withContext(maya, async (tx) => {
      expect(await documentsRepo.getDocumentView(tx, doc.id)).toBeNull();
      expect(
        await tx.query(
          'SELECT 1 FROM knowledge_chunks WHERE source_id = (SELECT source_id FROM documents WHERE id = :id)',
          { id: p.uuid(doc.id) },
        ),
      ).toMatchObject({ rowCount: 0 });
    });
  });

  it('creates sessions and turns, assembles views and ends sessions with a recap', async () => {
    const { sessionId } = await t.db.withContext(maya, async (tx) => {
      const resolved = await assignmentsRepo.resolveActiveAssignment(tx, ventureId);
      if (!resolved?.release) throw new Error('no release');
      const session = await sessionsRepo.createSession(tx, {
        tenantId: seed.tenantId,
        ventureId,
        assignmentId: resolved.assignment.id,
        personaReleaseId: resolved.release.id,
        startedBy: maya.principalId,
        mode: 'diagnose',
        privacy: 'standard',
        goal: 'Plan the pilot',
        policyVersion: '2026-10-05.1',
      });
      const memory = seed.ventures.find((v) => v.key === 'quietquad')?.memoryIds['h-seat-search'] ?? '';
      for (let i = 0; i < 2; i += 1) {
        const turn = await turnsRepo.createTurn(tx, {
          tenantId: seed.tenantId,
          ventureId,
          sessionId: session.id,
          authorId: maya.principalId,
          mode: 'diagnose',
          founderText: `Question ${String(i + 1)}`,
          riskCategories: [],
        });
        expect(turn.ordinal).toBe(i + 1);
        await turnsRepo.insertTurnEvidence(tx, turn.id, [
          {
            key: 'E1',
            kind: 'memory',
            refId: memory,
            score: 0.8,
            title: 'Seat search hypothesis',
            ventureId,
          },
          {
            key: 'E10',
            kind: 'resource',
            refId: seed.ventures[0]?.id ?? memory,
            score: 0.1,
            title: 'Gone',
            ventureId: null,
          },
          { key: 'E2', kind: 'doctrine', refId: memory, score: 0.5, title: 'Doctrine', ventureId: null },
        ]);
        await turnsRepo.finishTurn(tx, {
          turnId: turn.id,
          status: 'completed',
          response: {
            mode: 'diagnose',
            answer: 'Answer',
            claims: [{ text: 'c', kind: 'fact', evidence_ids: ['E1'] }],
            uncertainty: [],
            challenge: null,
            next_actions: [],
            escalation: {
              required: false,
              category: null,
              priority: null,
              reason: null,
              requested_role: null,
            },
            memory_candidates: [],
            follow_up_questions: [],
            rehearsal: null,
          },
          validatorResults: {
            unknownEvidenceIdsRemoved: 0,
            factsDowngraded: 0,
            groundingCoverage: 1,
            narrowed: false,
            escalationForced: false,
            identityViolation: false,
            crossVentureViolation: false,
            riskCategories: [],
            notes: [],
          },
          modelId: 'mock',
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.0002,
          latencyMs: 120,
        });
      }
      expect(await turnsRepo.countSessionTurns(tx, session.id)).toBe(2);
      expect(
        await turnsRepo.countRecentTurnsByAuthor(tx, { authorId: maya.principalId, windowSeconds: 600 }),
      ).toBe(2);
      const recent = await turnsRepo.listRecentTurns(tx, { sessionId: session.id, limit: 8 });
      expect(recent.map((r) => r.ordinal)).toEqual([1, 2]);
      return { sessionId: session.id };
    });
    await t.db.withContext(maya, async (tx) => {
      const views = await turnsRepo.listTurnViews(tx, sessionId);
      expect(views).toHaveLength(2);
      for (const v of views) expect(TurnView.safeParse(v).success).toBe(true);
      expect(views[0]?.evidence.map((e) => e.key)).toEqual(['E1', 'E2', 'E10']);
      expect(views[0]?.evidence[0]?.excerpt).toContain('twenty minutes');
      expect(views[0]?.evidence[0]?.status).toBe('confirmed');
      expect(views[0]?.usage).toMatchObject({ modelId: 'mock', latencyMs: 120 });
      const view = await sessionsRepo.getSessionView(tx, sessionId);
      expect(SessionView.safeParse(view).success).toBe(true);
      expect(view).toMatchObject({ personaName: 'Foundry Guide', turnCount: 2, status: 'active' });
      const ended = await sessionsRepo.endSession(tx, {
        sessionId,
        recap: {
          diagnosis: { stage: 'discovery', immediate_constraint: 'data', riskiest_assumption: 'demand' },
          evidence: [{ evidence_key: 'E1', title: 't', note: 'n' }],
          challenge: 'c',
          next_actions: [{ owner: 'Maya', action: 'a', target_date: null }],
          escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
          memory_candidate_ids: [],
          generated_at: new Date().toISOString(),
        },
      });
      expect(ended?.status).toBe('ended');
      expect(ended?.recap?.challenge).toBe('c');
      expect(await sessionsRepo.endSession(tx, { sessionId, recap: null })).toBeNull();
      const listed = await sessionsRepo.listSessionViews(tx, { ventureId });
      expect(listed[0]?.id).toBe(sessionId);
      expect(await sessionsRepo.lastSessionAt(tx, { ventureId })).toBe(listed[0]?.startedAt);
      const card = await venturesRepo.getVentureSummary(tx, { ventureId, principalId: maya.principalId });
      expect(card?.lastSessionAt).toBe(listed[0]?.startedAt);
    });
  });

  it('routes escalations through consent, queue, inbox and resolution', async () => {
    const solesignal = seed.ventures.find((v) => v.key === 'solesignal');
    if (!solesignal) throw new Error('missing venture');
    const created = await t.db.withContext(amara, (tx) =>
      escalationsRepo.createEscalation(tx, {
        tenantId: seed.tenantId,
        ventureId: solesignal.id,
        category: 'ip_licensing',
        priority: 'P2',
        createdBy: amara.principalId,
        packet: {
          founderQuestion: 'Who owns the sensor design?',
          desiredDecision: null,
          sharedFacts: [],
          evidenceConsidered: [],
          conflictingSignals: [],
          unknowns: ['Ownership'],
          reason: 'IP questions need a human',
          urgency: 'Before public demo',
          proposedNextStep: null,
          sessionSummary: null,
          aiGenerated: true,
        },
      }),
    );
    expect(EscalationView.safeParse(created).success).toBe(true);
    expect(created.status).toBe('draft');
    // Not yet visible to the EIR (no consent), nor routable.
    await expect(
      t.db.withContext(lead, (tx) =>
        escalationsRepo.routeEscalation(tx, { escalationId: created.id, assigneeId: ruth.principalId }),
      ),
    ).rejects.toMatchObject({ sqlState: '55000' });
    const consented = await t.db.withContext(amara, (tx) =>
      escalationsRepo.recordSharingConsent(tx, { escalationId: created.id, consentBy: amara.principalId }),
    );
    expect(consented).toMatchObject({ status: 'awaiting_consent' });
    expect(consented?.sharingConsentAt).not.toBeNull();
    const queue = await t.db.withContext(lead, (tx) => escalationsRepo.escalationQueue(tx));
    expect(queue.find((q) => q.id === created.id)).toMatchObject({ shared: true, priority: 'P2' });
    expect(
      await t.db.withContext(lead, (tx) =>
        escalationsRepo.routeEscalation(tx, {
          escalationId: created.id,
          assigneeId: ruth.principalId,
          dueAt: new Date(),
        }),
      ),
    ).toBe(true);
    const inbox = await t.db.withContext(ruth, (tx) =>
      escalationsRepo.listInboxEscalations(tx, { assigneeId: ruth.principalId }),
    );
    expect(inbox.map((e) => e.id)).toContain(created.id);
    expect(inbox.find((e) => e.id === created.id)?.packet?.founderQuestion).toBe(
      'Who owns the sensor design?',
    );
    const ack = await t.db.withContext(ruth, (tx) =>
      escalationsRepo.transitionEscalation(tx, {
        escalationId: created.id,
        action: 'acknowledge',
        actorId: ruth.principalId,
      }),
    );
    expect(ack?.status).toBe('acknowledged');
    const resolved = await t.db.withContext(ruth, (tx) =>
      escalationsRepo.transitionEscalation(tx, {
        escalationId: created.id,
        action: 'resolve',
        actorId: ruth.principalId,
        resolution: { summary: 'Talk to the TTO first.', nextSteps: ['Book TTO meeting'] },
      }),
    );
    expect(resolved).toMatchObject({ status: 'resolved', resolvedBy: ruth.principalId });
    expect(resolved?.resolution?.nextSteps).toEqual(['Book TTO meeting']);
    // Founder can no longer withdraw a resolved escalation.
    expect(
      await t.db.withContext(amara, (tx) =>
        escalationsRepo.transitionEscalation(tx, {
          escalationId: created.id,
          action: 'withdraw',
          actorId: amara.principalId,
        }),
      ),
    ).toBeNull();
    expect(
      await t.db.withContext(amara, (tx) => escalationsRepo.countOpenEscalations(tx, solesignal.id)),
    ).toBe(1);
  });
});
