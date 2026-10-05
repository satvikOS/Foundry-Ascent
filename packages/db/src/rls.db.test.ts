/**
 * Row level security: every table with a venture_id or tenant_id is isolated, credential/ledger/audit
 * tables are closed to app_rls, and role-specific visibility holds (founder, advisor, EIR, program lead).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from './db.js';
import { DbError } from './errors.js';
import { type SqlExecutor } from './executor.js';
import { p, type SqlParams } from './params.js';
import {
  auditRepo,
  documentsRepo,
  escalationsRepo,
  knowledgeRepo,
  memoryRepo,
  personasRepo,
  principalsRepo,
  resourcesRepo,
  sessionsRepo,
  tenantsRepo,
  turnsRepo,
  usageRepo,
  venturesRepo,
  assignmentsRepo,
  eirRepo,
} from './repositories/index.js';
import { type SeedResult } from './seed/seed.js';
import { GUIDE_DOCTRINE, GUIDE_STYLE } from './seed/doctrine.js';
import { createTestDatabase, makeContext, type TestDatabase } from './testing/test-database.js';

let t: TestDatabase;
let seed: SeedResult;

interface Actor {
  readonly id: string;
  readonly tenantId: string;
}

interface Fixture {
  readonly home: string;
  readonly partner: string;
  readonly A: string; // quietquad — founder maya, team devin, EIR corin
  readonly B: string; // benchtally — founders priya, tomasz, EIR corin
  readonly C: string; // solesignal — founder amara, advisor graham, EIR ruth
  readonly P: string; // partner tenant venture
  readonly maya: Actor;
  readonly devin: Actor;
  readonly priya: Actor;
  readonly amara: Actor;
  readonly graham: Actor;
  readonly corin: Actor;
  readonly ruth: Actor;
  readonly lead: Actor;
  readonly partnerFounder: Actor;
  readonly turnB: string;
  readonly sessionB: string;
  readonly memoryB: string;
}
let f: Fixture;

function principal(key: string): Actor {
  const id = seed.principals[key];
  if (!id) throw new Error(`no principal ${key}`);
  return { id, tenantId: seed.tenantId };
}

function venture(key: string): string {
  const v = seed.ventures.find((x) => x.key === key);
  if (!v) throw new Error(`no venture ${key}`);
  return v.id;
}

function as<T>(db: Db, actor: Actor, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return db.withContext(makeContext(actor.id, actor.tenantId), fn);
}

async function count(ex: SqlExecutor, sql: string, params: SqlParams = {}): Promise<number> {
  const r = await ex.query(sql, params);
  return Number(r.rows[0]?.n ?? 0);
}

async function sqlState(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    if (err instanceof DbError) return err.sqlState;
    throw err;
  }
}

/** Adds sessions, turns, evidence, feedback, reviews, escalations, usage, audit and a partner tenant. */
async function buildFixture(db: Db): Promise<Fixture> {
  const A = venture('quietquad');
  const B = venture('benchtally');
  const C = venture('solesignal');
  const maya = principal('maya');
  const priya = principal('priya');
  const amara = principal('amara');
  const corin = principal('eir-corin');
  const ruth = principal('eir-ruth');

  // Sessions, turns (sampled), evidence, feedback, reviews, escalations in A, B, C — created as the founders.
  const perVenture: Record<string, { session: string; turn: string; memory: string }> = {};
  for (const [ventureId, founder, eir] of [
    [A, maya, corin],
    [B, priya, corin],
    [C, amara, ruth],
  ] as const) {
    const ids = await as(db, founder, async (tx) => {
      const resolved = await assignmentsRepo.resolveActiveAssignment(tx, ventureId);
      if (!resolved?.release) throw new Error('no assignment');
      const session = await sessionsRepo.createSession(tx, {
        tenantId: seed.tenantId,
        ventureId,
        assignmentId: resolved.assignment.id,
        personaReleaseId: resolved.release.id,
        startedBy: founder.id,
        mode: 'diagnose',
        privacy: 'standard',
        goal: 'Test session',
        policyVersion: 'test',
      });
      const turn = await turnsRepo.createTurn(tx, {
        tenantId: seed.tenantId,
        ventureId,
        sessionId: session.id,
        authorId: founder.id,
        mode: 'diagnose',
        founderText: 'What should we test next?',
      });
      await turnsRepo.finishTurn(tx, {
        turnId: turn.id,
        status: 'completed',
        modelId: 'mock',
        inputTokens: 10,
        outputTokens: 20,
        costUsd: 0.0001,
        latencyMs: 5,
        sampledForReview: true,
      });
      const [memory] = await memoryRepo.listMemory(tx, { ventureId, statuses: ['confirmed'], limit: 1 });
      if (!memory) throw new Error('no memory');
      await turnsRepo.insertTurnEvidence(tx, turn.id, [
        { key: 'E1', kind: 'memory', refId: memory.id, score: 0.9, title: memory.title, ventureId },
      ]);
      await turnsRepo.upsertFeedback(tx, { turnId: turn.id, ventureId, principalId: founder.id, rating: 4 });
      await escalationsRepo.createEscalation(tx, {
        tenantId: seed.tenantId,
        ventureId,
        sessionId: session.id,
        turnId: turn.id,
        category: 'legal',
        priority: 'P3',
        createdBy: founder.id,
        packet: {
          founderQuestion: 'Q',
          desiredDecision: null,
          sharedFacts: [],
          evidenceConsidered: [],
          conflictingSignals: [],
          unknowns: [],
          reason: 'test',
          urgency: 'low',
          proposedNextStep: null,
          sessionSummary: null,
          aiGenerated: true,
        },
      });
      return { session: session.id, turn: turn.id, memory: memory.id };
    });
    perVenture[ventureId] = ids;
    await as(db, eir, (tx) =>
      turnsRepo.upsertEirReview(tx, {
        turnId: ids.turn,
        ventureId,
        reviewerId: eir.id,
        scores: { correctness: 4, rigor: 4, specificity: 3, teachability: 4, personaFit: 5, escalation: 4 },
      }),
    );
  }
  // Consent recorded by an EIR for themselves.
  await as(db, corin, (tx) =>
    personasRepo.createConsent(tx, {
      tenantId: seed.tenantId,
      subjectPrincipalId: corin.id,
      assetTypes: ['doctrine'],
    }),
  );

  // Ledgers and audit.
  await db.system(async (sx) => {
    await usageRepo.recordUsage(sx, {
      tenantId: seed.tenantId,
      ventureId: B,
      principalId: priya.id,
      purpose: 'turn',
      modelId: 'mock',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.01,
    });
    await auditRepo.appendAudit(sx, {
      action: 'test.event',
      outcome: 'succeeded',
      tenantId: seed.tenantId,
      ventureId: B,
      actorId: priya.id,
    });
  });

  // Partner tenant with its own venture and content.
  const partnerFixture = await db.system(async (sx) => {
    const tenant = await tenantsRepo.upsertTenant(sx, {
      slug: 'partner-u',
      name: 'Partner University',
      kind: 'partner',
    });
    const founder = await principalsRepo.createPrincipal(sx, {
      tenantId: tenant.id,
      displayName: 'Partner Founder',
      synthetic: true,
    });
    const lead = await principalsRepo.createPrincipal(sx, {
      tenantId: tenant.id,
      displayName: 'Partner Lead',
      synthetic: true,
    });
    await principalsRepo.grantRole(sx, { principalId: lead.id, tenantId: tenant.id, role: 'program_lead' });
    const v = await venturesRepo.createVenture(sx, { tenantId: tenant.id, name: 'Partner Venture' });
    await venturesRepo.addMembership(sx, { ventureId: v.id, principalId: founder.id, role: 'founder' });
    const eirProfile = await eirRepo.createEirProfile(sx, {
      tenantId: tenant.id,
      displayName: 'Partner EIR',
    });
    const persona = await personasRepo.createPersona(sx, {
      tenantId: tenant.id,
      name: 'Partner Guide',
      kind: 'neutral_guide',
      status: 'active',
    });
    const release = await personasRepo.createRelease(sx, {
      personaId: persona.id,
      doctrine: GUIDE_DOCTRINE,
      style: GUIDE_STYLE,
      disclosureText: 'Synthetic partner disclosure text that is long enough for the contract.',
      allowedModes: ['coach'],
      createdBy: lead.id,
    });
    await personasRepo.approveRelease(sx, { releaseId: release.id, approvedBy: lead.id });
    const assignment = await assignmentsRepo.createAssignment(sx, {
      tenantId: tenant.id,
      ventureId: v.id,
      personaId: persona.id,
      eirProfileId: eirProfile.id,
    });
    await personasRepo.createConsent(sx, {
      tenantId: tenant.id,
      subjectPrincipalId: lead.id,
      assetTypes: ['style'],
    });
    const source = await knowledgeRepo.createKnowledgeSource(sx, {
      tenantId: tenant.id,
      scope: 'venture',
      ventureId: v.id,
      title: 'Partner doc',
    });
    await knowledgeRepo.insertChunks(sx, {
      sourceId: source.id,
      tenantId: tenant.id,
      scope: 'venture',
      ventureId: v.id,
      chunks: [{ ordinal: 1, content: 'Partner venture private chunk' }],
    });
    const programSource = await knowledgeRepo.createKnowledgeSource(sx, {
      tenantId: tenant.id,
      scope: 'program',
      title: 'Partner program handbook',
    });
    await knowledgeRepo.insertChunks(sx, {
      sourceId: programSource.id,
      tenantId: tenant.id,
      scope: 'program',
      chunks: [{ ordinal: 1, content: 'Partner program chunk' }],
    });
    await documentsRepo.createDocument(sx, {
      tenantId: tenant.id,
      ventureId: v.id,
      filename: 'p.md',
      contentType: 'text/markdown',
      sizeBytes: 10,
      s3Key: `tenants/${tenant.id}/ventures/${v.id}/documents/x/p.md`,
      uploadedBy: founder.id,
      status: 'ready',
    });
    await memoryRepo.createMemory(sx, {
      tenantId: tenant.id,
      ventureId: v.id,
      type: 'fact',
      title: 'Partner fact',
      content: 'Partner content',
      origin: 'founder',
      createdBy: founder.id,
      status: 'confirmed',
    });
    const session = await sessionsRepo.createSession(sx, {
      tenantId: tenant.id,
      ventureId: v.id,
      assignmentId: assignment.id,
      personaReleaseId: release.id,
      startedBy: founder.id,
      mode: 'coach',
      privacy: 'standard',
      policyVersion: 'test',
    });
    const turn = await turnsRepo.createTurn(sx, {
      tenantId: tenant.id,
      ventureId: v.id,
      sessionId: session.id,
      authorId: founder.id,
      mode: 'coach',
      founderText: 'Partner question',
    });
    await turnsRepo.insertTurnEvidence(sx, turn.id, [
      { key: 'E1', kind: 'chunk', refId: source.id, score: 0.5, title: 'x', ventureId: v.id },
    ]);
    await turnsRepo.upsertFeedback(sx, {
      turnId: turn.id,
      ventureId: v.id,
      principalId: founder.id,
      rating: 3,
    });
    await sx.query(
      `INSERT INTO eir_reviews (turn_id, venture_id, reviewer_id, scores) VALUES (:t, :v, :r, '{}'::jsonb)`,
      { t: p.uuid(turn.id), v: p.uuid(v.id), r: p.uuid(lead.id) },
    );
    await escalationsRepo.createEscalation(sx, {
      tenantId: tenant.id,
      ventureId: v.id,
      category: 'other',
      priority: 'P3',
      createdBy: founder.id,
      packet: {
        founderQuestion: 'Partner Q',
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
    await resourcesRepo.createResource(sx, {
      tenantId: tenant.id,
      name: 'Partner resource',
      kind: 'program',
      description: 'Partner resource description',
    });
    await resourcesRepo.createPattern(sx, {
      tenantId: tenant.id,
      title: 'Partner pattern',
      context: 'c',
      signal: 's',
      intervention: 'i',
      outcome: 'o',
      limits: 'l',
      sourceClass: 'synthetic',
      status: 'published',
    });
    await usageRepo.recordUsage(sx, {
      tenantId: tenant.id,
      ventureId: v.id,
      principalId: founder.id,
      purpose: 'turn',
      modelId: 'mock',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.01,
    });
    await auditRepo.appendAudit(sx, {
      action: 'partner.event',
      outcome: 'succeeded',
      tenantId: tenant.id,
      ventureId: v.id,
    });
    return { tenantId: tenant.id, ventureId: v.id, founder: { id: founder.id, tenantId: tenant.id } };
  });

  const b = perVenture[B];
  if (!b) throw new Error('fixture B missing');
  return {
    home: seed.tenantId,
    partner: partnerFixture.tenantId,
    A,
    B,
    C,
    P: partnerFixture.ventureId,
    maya,
    devin: principal('devin'),
    priya,
    amara,
    graham: principal('graham'),
    corin,
    ruth,
    lead: principal('lead-elise'),
    partnerFounder: partnerFixture.founder,
    turnB: b.turn,
    sessionB: b.session,
    memoryB: b.memory,
  };
}

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  if (!t.seed) throw new Error('seed missing');
  seed = t.seed;
  f = await buildFixture(t.db);
}, 120_000);

afterAll(async () => {
  await t.cleanup();
});

/** Tables app_rls must not be able to read at all. */
const CLOSED_TABLES = [
  'access_codes',
  'auth_sessions',
  'auth_attempts',
  'platform_keys',
  'usage_ledger',
  'audit_events',
  'idempotency_keys',
  'schema_migrations',
] as const;

/** Every table with a venture_id column that app_rls can read, and how rows map to a venture. */
const VENTURE_TABLES = [
  'venture_memberships',
  'assignments',
  'knowledge_sources',
  'knowledge_chunks',
  'documents',
  'memory_objects',
  'memory_events',
  'coaching_sessions',
  'turns',
  'turn_evidence',
  'feedback',
  'eir_reviews',
  'escalations',
] as const;

/** Tables with a tenant_id column (and no venture_id) that app_rls can read. */
const TENANT_TABLES = [
  'principals',
  'role_grants',
  'ventures',
  'eir_profiles',
  'consents',
  'personas',
  'resources',
  'patterns',
] as const;

describe('RLS coverage', () => {
  it('covers every table that has a venture_id or tenant_id column', async () => {
    const r = await t.db.system((sx) =>
      sx.query(
        `SELECT DISTINCT table_name FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name IN ('venture_id', 'tenant_id')`,
      ),
    );
    const discovered = r.rows.map((row) => String(row.table_name)).sort();
    const covered = [...VENTURE_TABLES, ...TENANT_TABLES, 'usage_ledger', 'audit_events'].sort();
    expect(discovered).toEqual(covered);
  });

  it('enables row level security on every application table', async () => {
    const r = await t.db.system((sx) =>
      sx.query(
        `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'`,
      ),
    );
    const without = r.rows.filter((row) => row.relrowsecurity !== true).map((row) => row.relname);
    expect(without).toEqual([]);
    expect(r.rows.length).toBeGreaterThanOrEqual(31);
  });

  it('switches to app_rls with the request GUCs in withContext, and back to the owner afterwards', async () => {
    const inside = await as(t.db, f.maya, (tx) =>
      tx.query(
        `SELECT current_user AS u, current_setting('app.principal_id') AS pid, current_setting('app.tenant_id') AS tid,
                current_setting('app.request_id') AS rid`,
      ),
    );
    expect(inside.rows[0]).toMatchObject({ u: 'app_rls', pid: f.maya.id, tid: f.home });
    expect(String(inside.rows[0]?.rid)).toMatch(/^test-/);
    const outside = await t.db.system((sx) =>
      sx.query(`SELECT current_user AS u, coalesce(current_setting('app.principal_id', true), '') AS pid`),
    );
    expect(outside.rows[0]?.u).not.toBe('app_rls');
    expect(outside.rows[0]?.pid).toBe('');
  });
});

describe('fixture sanity (as owner)', () => {
  it('has rows outside venture A and outside the home tenant for every table under test', async () => {
    await t.db.system(async (sx) => {
      for (const table of VENTURE_TABLES) {
        expect(
          await count(
            sx,
            `SELECT count(*) AS n FROM ${table} WHERE venture_id IS NOT NULL AND venture_id <> :a`,
            {
              a: p.uuid(f.A),
            },
          ),
          table,
        ).toBeGreaterThan(0);
      }
      for (const table of TENANT_TABLES) {
        expect(
          await count(
            sx,
            `SELECT count(*) AS n FROM ${table} WHERE tenant_id IS NOT NULL AND tenant_id <> :h`,
            {
              h: p.uuid(f.home),
            },
          ),
          table,
        ).toBeGreaterThan(0);
      }
    });
  });
});

describe('founder isolation', () => {
  it('founder A sees no rows of other ventures in any venture-scoped table', async () => {
    await as(t.db, f.maya, async (tx) => {
      for (const table of VENTURE_TABLES) {
        const own = await count(tx, `SELECT count(*) AS n FROM ${table} WHERE venture_id = :a`, {
          a: p.uuid(f.A),
        });
        const foreign = await count(
          tx,
          `SELECT count(*) AS n FROM ${table} WHERE venture_id IS NOT NULL AND venture_id <> :a`,
          { a: p.uuid(f.A) },
        );
        expect(foreign, `${table} foreign rows`).toBe(0);
        if (table !== 'eir_reviews') expect(own, `${table} own rows`).toBeGreaterThan(0);
      }
    });
  });

  it('founder A sees no rows of another tenant in tenant-scoped tables', async () => {
    await as(t.db, f.maya, async (tx) => {
      for (const table of TENANT_TABLES) {
        const foreign = await count(
          tx,
          `SELECT count(*) AS n FROM ${table} WHERE tenant_id IS NOT NULL AND tenant_id <> :h`,
          { h: p.uuid(f.home) },
        );
        expect(foreign, table).toBe(0);
      }
      expect(await count(tx, 'SELECT count(*) AS n FROM tenants')).toBe(1);
      expect(await count(tx, 'SELECT count(*) AS n FROM ventures')).toBe(1);
      // Shared corpora of the home tenant are visible; the partner's are not.
      expect(await count(tx, `SELECT count(*) AS n FROM knowledge_chunks WHERE scope = 'program'`)).toBe(6);
    });
  });

  it('partner founder sees nothing of the home tenant', async () => {
    await as(t.db, f.partnerFounder, async (tx) => {
      for (const table of [...VENTURE_TABLES, ...TENANT_TABLES]) {
        const foreign = await count(
          tx,
          `SELECT count(*) AS n FROM ${table} WHERE ${VENTURE_TABLES.includes(table as (typeof VENTURE_TABLES)[number]) ? 'venture_id' : 'tenant_id'} IN (SELECT id FROM ventures WHERE tenant_id = :h) OR (${VENTURE_TABLES.includes(table as (typeof VENTURE_TABLES)[number]) ? 'false' : 'tenant_id = :h'})`,
          { h: p.uuid(f.home) },
        );
        expect(foreign, table).toBe(0);
      }
      const homeVentures = await t.db.system((sx) =>
        sx.query('SELECT id FROM ventures WHERE tenant_id = :h', { h: p.uuid(f.home) }),
      );
      for (const row of homeVentures.rows) {
        const id = String(row.id);
        expect(
          await count(tx, 'SELECT count(*) AS n FROM memory_objects WHERE venture_id = :v', {
            v: p.uuid(id),
          }),
        ).toBe(0);
      }
    });
  });

  it('founder A cannot insert rows into venture B or another tenant', async () => {
    const B = p.uuid(f.B);
    const attempts: [string, string, SqlParams][] = [
      [
        'memory_objects',
        `INSERT INTO memory_objects (tenant_id, venture_id, type, title, content, origin, created_by)
         VALUES (:h, :b, 'fact', 'x', 'x', 'founder', :me)`,
        { h: p.uuid(f.home), b: B, me: p.uuid(f.maya.id) },
      ],
      [
        'documents',
        `INSERT INTO documents (tenant_id, venture_id, filename, content_type, size_bytes, s3_key, uploaded_by)
         VALUES (:h, :b, 'x.md', 'text/markdown', 1, 'x/' || gen_random_uuid(), :me)`,
        { h: p.uuid(f.home), b: B, me: p.uuid(f.maya.id) },
      ],
      [
        'knowledge_sources',
        `INSERT INTO knowledge_sources (tenant_id, scope, venture_id, title) VALUES (:h, 'venture', :b, 'x')`,
        { h: p.uuid(f.home), b: B },
      ],
      [
        'knowledge_chunks',
        `INSERT INTO knowledge_chunks (source_id, tenant_id, scope, venture_id, ordinal, content)
         SELECT id, tenant_id, 'venture', venture_id, 999, 'x' FROM (SELECT :src::uuid AS id, :h::uuid AS tenant_id, :b::uuid AS venture_id) s`,
        { src: p.uuid(seed.ventures[1]?.documentIds[0] ?? f.B), h: p.uuid(f.home), b: B },
      ],
      [
        'coaching_sessions',
        `INSERT INTO coaching_sessions (tenant_id, venture_id, assignment_id, persona_release_id, started_by, policy_version)
         VALUES (:h, :b, :asg, :rel, :me, 'x')`,
        {
          h: p.uuid(f.home),
          b: B,
          asg: p.uuid(seed.ventures[1]?.assignmentId ?? f.B),
          rel: p.uuid(seed.releaseId),
          me: p.uuid(f.maya.id),
        },
      ],
      [
        'turns',
        `INSERT INTO turns (tenant_id, venture_id, session_id, ordinal, author_id, mode, founder_text)
         VALUES (:h, :b, :s, 99, :me, 'coach', 'x')`,
        { h: p.uuid(f.home), b: B, s: p.uuid(f.sessionB), me: p.uuid(f.maya.id) },
      ],
      [
        'turn_evidence',
        `INSERT INTO turn_evidence (turn_id, evidence_key, venture_id, kind, ref_id, score, title)
         VALUES (:t, 'E9', :b, 'memory', :m, 1, 'x')`,
        { t: p.uuid(f.turnB), b: B, m: p.uuid(f.memoryB) },
      ],
      [
        'feedback',
        `INSERT INTO feedback (turn_id, venture_id, principal_id, rating) VALUES (:t, :b, :me, 5)`,
        { t: p.uuid(f.turnB), b: B, me: p.uuid(f.maya.id) },
      ],
      [
        'eir_reviews',
        `INSERT INTO eir_reviews (turn_id, venture_id, reviewer_id, scores) VALUES (:t, :b, :me, '{}'::jsonb)`,
        { t: p.uuid(f.turnB), b: B, me: p.uuid(f.maya.id) },
      ],
      [
        'escalations',
        `INSERT INTO escalations (tenant_id, venture_id, category, priority, packet, created_by)
         VALUES (:h, :b, 'other', 'P3', '{}'::jsonb, :me)`,
        { h: p.uuid(f.home), b: B, me: p.uuid(f.maya.id) },
      ],
      [
        'memory_events',
        `INSERT INTO memory_events (memory_id, venture_id, actor_id, action) VALUES (:m, :b, :me, 'pinned')`,
        { m: p.uuid(f.memoryB), b: B, me: p.uuid(f.maya.id) },
      ],
      [
        'venture_memberships',
        `INSERT INTO venture_memberships (venture_id, principal_id, role) VALUES (:b, :me, 'founder')`,
        { b: B, me: p.uuid(f.maya.id) },
      ],
      [
        'assignments',
        `INSERT INTO assignments (tenant_id, venture_id, persona_id) VALUES (:h, :b, :persona)`,
        { h: p.uuid(f.home), b: B, persona: p.uuid(seed.personaId) },
      ],
      [
        'ventures',
        `INSERT INTO ventures (tenant_id, name) VALUES (:partner, 'x')`,
        { partner: p.uuid(f.partner) },
      ],
      [
        'principals',
        `INSERT INTO principals (tenant_id, display_name) VALUES (:partner, 'x')`,
        { partner: p.uuid(f.partner) },
      ],
      [
        'resources',
        `INSERT INTO resources (tenant_id, name, kind, description) VALUES (:h, 'x', 'other', 'x')`,
        { h: p.uuid(f.home) },
      ],
      [
        'patterns',
        `INSERT INTO patterns (tenant_id, title, context, signal, intervention, outcome, limits, source_class)
         VALUES (:h, 'x', 'x', 'x', 'x', 'x', 'x', 'x')`,
        { h: p.uuid(f.home) },
      ],
      [
        'personas',
        `INSERT INTO personas (tenant_id, name, kind) VALUES (:h, 'x', 'neutral_guide')`,
        { h: p.uuid(f.home) },
      ],
      [
        'persona_releases',
        `INSERT INTO persona_releases (persona_id, version, doctrine, style, disclosure_text)
         VALUES (:persona, 99, '{}'::jsonb, '{}'::jsonb, 'x')`,
        { persona: p.uuid(seed.personaId) },
      ],
      [
        'consents',
        `INSERT INTO consents (tenant_id, subject_principal_id, asset_types) VALUES (:h, :other, ARRAY['voice'])`,
        { h: p.uuid(f.home), other: p.uuid(f.priya.id) },
      ],
      [
        'eir_profiles',
        `INSERT INTO eir_profiles (tenant_id, display_name) VALUES (:h, 'x')`,
        { h: p.uuid(f.home) },
      ],
      [
        'role_grants',
        `INSERT INTO role_grants (principal_id, tenant_id, role) VALUES (:me, :h, 'program_lead')`,
        { me: p.uuid(f.maya.id), h: p.uuid(f.home) },
      ],
    ];
    for (const [table, sql, params] of attempts) {
      const state = await sqlState(as(t.db, f.maya, (tx) => tx.query(sql, params)));
      expect(state, table).toBe('42501');
    }
  });

  it('founder A cannot update or delete venture B rows', async () => {
    await as(t.db, f.maya, async (tx) => {
      const updates = [
        `UPDATE memory_objects SET title = 'x' WHERE venture_id = :b`,
        `UPDATE ventures SET name = 'x' WHERE id = :b`,
        `UPDATE documents SET filename = 'x' WHERE venture_id = :b`,
        `UPDATE coaching_sessions SET goal = 'x' WHERE venture_id = :b`,
        `UPDATE turns SET founder_text = 'x' WHERE venture_id = :b`,
        `UPDATE escalations SET priority = 'P0' WHERE venture_id = :b`,
      ];
      for (const sql of updates) expect((await tx.query(sql, { b: p.uuid(f.B) })).rowCount, sql).toBe(0);
    });
    expect(await sqlState(as(t.db, f.maya, (tx) => memoryRepo.deleteMemory(tx, f.memoryB)))).toBeNull();
    expect(await as(t.db, f.maya, (tx) => memoryRepo.deleteMemory(tx, f.memoryB))).toBe(0);
    expect(
      await as(t.db, f.maya, (tx) =>
        documentsRepo.softDeleteDocument(tx, seed.ventures[1]?.documentIds[0] ?? ''),
      ),
    ).toBeNull();
  });
});

describe('role visibility', () => {
  it('team members see team items but not another member’s founder_private items', async () => {
    await as(t.db, f.devin, async (tx) => {
      expect(
        await count(tx, `SELECT count(*) AS n FROM memory_objects WHERE visibility = 'founder_private'`),
      ).toBe(0);
      expect(
        await count(tx, `SELECT count(*) AS n FROM memory_objects WHERE visibility = 'team'`),
      ).toBeGreaterThan(0);
    });
    await as(t.db, f.maya, async (tx) => {
      expect(
        await count(tx, `SELECT count(*) AS n FROM memory_objects WHERE visibility = 'founder_private'`),
      ).toBe(1);
    });
  });

  it('advisor sees venture/advisors memory but no founder_private/team items, sessions or turns', async () => {
    await as(t.db, f.graham, async (tx) => {
      expect(
        await count(
          tx,
          `SELECT count(*) AS n FROM memory_objects WHERE visibility IN ('founder_private', 'team')`,
        ),
      ).toBe(0);
      expect(
        await count(tx, `SELECT count(*) AS n FROM memory_objects WHERE visibility = 'advisors'`),
      ).toBeGreaterThan(0);
      expect(
        await count(tx, `SELECT count(*) AS n FROM memory_objects WHERE visibility = 'venture'`),
      ).toBeGreaterThan(0);
      expect(
        await count(tx, 'SELECT count(*) AS n FROM memory_objects WHERE venture_id <> :c', {
          c: p.uuid(f.C),
        }),
      ).toBe(0);
      for (const table of ['coaching_sessions', 'turns', 'turn_evidence', 'feedback', 'escalations']) {
        expect(await count(tx, `SELECT count(*) AS n FROM ${table}`), table).toBe(0);
      }
      // Advisors cannot write memory.
      expect(
        await sqlState(
          tx.query(
            `INSERT INTO memory_objects (tenant_id, venture_id, type, title, content, origin, created_by)
             VALUES (:h, :c, 'fact', 'x', 'x', 'founder', :me)`,
            { h: p.uuid(f.home), c: p.uuid(f.C), me: p.uuid(f.graham.id) },
          ),
        ),
      ).toBe('42501');
    });
  });

  it('program lead sees ventures and memberships but no memory, sessions, turns, documents or chunks', async () => {
    await as(t.db, f.lead, async (tx) => {
      expect(await count(tx, 'SELECT count(*) AS n FROM ventures')).toBe(4);
      expect(await count(tx, 'SELECT count(*) AS n FROM venture_memberships')).toBeGreaterThan(0);
      for (const table of [
        'memory_objects',
        'memory_events',
        'coaching_sessions',
        'turns',
        'turn_evidence',
        'feedback',
        'documents',
        'escalations',
      ]) {
        expect(await count(tx, `SELECT count(*) AS n FROM ${table}`), table).toBe(0);
      }
      expect(await count(tx, `SELECT count(*) AS n FROM knowledge_chunks WHERE scope = 'venture'`)).toBe(0);
      // Queue metadata only, through the SECURITY DEFINER function.
      const queue = await escalationsRepo.escalationQueue(tx);
      expect(queue.length).toBeGreaterThan(0);
      expect(queue.every((q) => q.ventureId !== f.P)).toBe(true);
      // Summaries are visible without content counts.
      const cards = await venturesRepo.listVentureSummaries(tx, {
        principalId: f.lead.id,
        tenantId: f.home,
        scope: 'tenant',
      });
      expect(cards).toHaveLength(4);
      expect(
        cards.every((c) => c.pendingMemory === 0 && c.openActions === 0 && c.lastSessionAt === null),
      ).toBe(true);
    });
  });

  it('assigned EIR sees assigned ventures’ shared memory and sampled turns only', async () => {
    await as(t.db, f.corin, async (tx) => {
      const ventures = await count(tx, 'SELECT count(DISTINCT venture_id) AS n FROM memory_objects');
      expect(ventures).toBe(2); // A and B
      expect(
        await count(tx, 'SELECT count(*) AS n FROM memory_objects WHERE venture_id = :c', { c: p.uuid(f.C) }),
      ).toBe(0);
      expect(
        await count(
          tx,
          `SELECT count(*) AS n FROM memory_objects WHERE visibility IN ('founder_private', 'team')`,
        ),
      ).toBe(0);
      expect(await count(tx, 'SELECT count(*) AS n FROM turns WHERE NOT sampled_for_review')).toBe(0);
      expect(await count(tx, 'SELECT count(*) AS n FROM turns')).toBe(2);
      const queue = await turnsRepo.listReviewQueue(tx, { reviewerId: f.corin.id });
      expect(queue.map((q) => q.ventureId).sort()).toEqual([f.A, f.B].sort());
      expect(queue.every((q) => q.reviewed)).toBe(true);
    });
  });

  it('nothing is visible without a request context', async () => {
    await t.db.system(async (sx) => {
      await sx.query(`SELECT set_config('role', 'app_rls', true)`);
      for (const table of [
        ...VENTURE_TABLES,
        ...TENANT_TABLES,
        'tenants',
        'platform_settings',
        'persona_releases',
      ]) {
        expect(await count(sx, `SELECT count(*) AS n FROM ${table}`), table).toBe(0);
      }
    });
  });

  it('credential, ledger and audit tables are closed to app_rls', async () => {
    for (const table of CLOSED_TABLES) {
      const state = await sqlState(as(t.db, f.maya, (tx) => tx.query(`SELECT count(*) AS n FROM ${table}`)));
      expect(state, table).toBe('42501');
      const lead = await sqlState(as(t.db, f.lead, (tx) => tx.query(`SELECT 1 FROM ${table} LIMIT 1`)));
      expect(lead, table).toBe('42501');
    }
    const writes: [string, string][] = [
      ['usage_ledger', `INSERT INTO usage_ledger (purpose, model_id) VALUES ('turn', 'x')`],
      [
        'audit_events',
        `INSERT INTO audit_events (action, outcome, prev_hash, hash) VALUES ('x', 'succeeded', 'a', 'b')`,
      ],
      ['access_codes', `UPDATE access_codes SET revoked_at = NULL`],
      ['auth_sessions', `DELETE FROM auth_sessions`],
      ['idempotency_keys', `DELETE FROM idempotency_keys`],
      ['platform_keys', `UPDATE platform_keys SET retired_at = now()`],
      ['tenants', `INSERT INTO tenants (slug, name, kind) VALUES ('evil', 'x', 'partner')`],
      ['platform_settings', `UPDATE platform_settings SET value = 'false'`],
      ['memory_objects', `DELETE FROM memory_objects`],
    ];
    for (const [table, sql] of writes) {
      expect(await sqlState(as(t.db, f.maya, (tx) => tx.query(sql))), table).toBe('42501');
    }
    // app_rls may append audit events (context-bound) but not forge the actor/tenant via append_audit.
    expect(
      await sqlState(
        as(t.db, f.maya, (tx) =>
          tx.query(
            `SELECT app.append_audit(NULL, NULL, NULL, 'x', NULL, NULL, 'succeeded', NULL, NULL, '{}'::jsonb)`,
          ),
        ),
      ),
    ).toBe('42501');
    const id = await as(t.db, f.maya, (tx) =>
      auditRepo.appendAudit(tx, { action: 'retrieval.authorized', outcome: 'allowed', ventureId: f.A }),
    );
    const row = await t.db.system((sx) =>
      sx.query('SELECT actor_id, tenant_id, request_id FROM audit_events WHERE id = :id', {
        id: p.bigint(id),
      }),
    );
    expect(row.rows[0]).toMatchObject({ actor_id: f.maya.id, tenant_id: f.home });
    expect(String(row.rows[0]?.request_id)).toMatch(/^test-/);
  });
});
