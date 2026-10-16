/**
 * Migration 0011 (EIR profiles made in the product; the knowledge source of a cited passage) on top of the schema
 * production has, with evidence the previous code wrote: it applies cleanly as the non-superuser owner, backfills
 * the source of every passage whose chunk still exists (and of nothing else), lets platform admins (and still
 * program leads, never EIRs) create profiles of people of their own tenant, keeps one profile per person, keeps the
 * previous code's writes working, and re-runs without changes. A database where someone already has two profiles
 * migrates too, without the one-per-person index.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from './db.js';
import { DbError } from './errors.js';
import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import { assignmentsRepo, eirRepo, principalsRepo, tenantsRepo, turnsRepo } from './repositories/index.js';
import { seedDatabase, type SeedConfig, type SeedResult } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, makeContext, type TestDatabase } from './testing/test-database.js';

const SOURCES = MIGRATIONS.find((m) => m.version === '0011_eir_profiles_evidence_sources');
const BEFORE = MIGRATIONS.filter((m) => m.version < '0011');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };

let t: TestDatabase;
let seed: SeedResult;
let adminOnly: string;
let otherTenantPerson: string;

interface Cited {
  readonly turnId: string;
  readonly venture: { chunk: string; source: string };
  readonly program: { chunk: string; source: string };
  readonly persona: { chunk: string; source: string };
  readonly goneChunk: string;
  readonly memory: string;
}
let cited: Cited;

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
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

const lead = () => makeContext(must(seed.programLeadId), seed.tenantId);
const admin = () => makeContext(adminOnly, seed.tenantId);
const corin = () => makeContext(must(seed.principals['eir-corin']), seed.tenantId);

/** Policies, constraints and indexes of the two tables: equal after a re-run. */
async function schemaFingerprint(db: Db): Promise<string> {
  return db.system(async (sx) => {
    const parts: unknown[] = [];
    for (const sql of [
      `SELECT tablename, policyname, cmd, coalesce(qual, '') AS qual, coalesce(with_check, '') AS with_check
         FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('eir_profiles', 'turn_evidence')
        ORDER BY tablename, policyname`,
      `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid IN ('eir_profiles'::regclass, 'turn_evidence'::regclass) ORDER BY 1, 2`,
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN ('eir_profiles', 'turn_evidence') ORDER BY 1`,
    ]) {
      parts.push((await sx.query(sql)).rows);
    }
    return JSON.stringify(parts);
  });
}

/** A chunk of the given scope and its source (venture chunks of QuietQuad). */
async function chunkOf(db: Db, scope: 'venture' | 'program' | 'persona', ventureId: string) {
  const r = await db.system((sx) =>
    sx.query(
      `SELECT c.id, c.source_id FROM knowledge_chunks c
        WHERE c.scope = :scope AND (:scope <> 'venture' OR c.venture_id = :venture)
        ORDER BY c.id LIMIT 1`,
      { scope: p.text(scope), venture: p.uuid(ventureId) },
    ),
  );
  const row = must(r.rows[0]);
  return { chunk: String(row.id), source: String(row.source_id) };
}

/** A completed turn citing a venture document, the program handbook, the vEIR's library, a gone chunk and memory. */
async function writeCitations(db: Db): Promise<Cited> {
  const venture = must(seed.ventures.find((v) => v.key === 'quietquad'));
  const maya = must(seed.principals.maya);
  const chunks = {
    venture: await chunkOf(db, 'venture', venture.id),
    program: await chunkOf(db, 'program', venture.id),
    persona: await chunkOf(db, 'persona', venture.id),
  };
  return db.system(async (sx) => {
    const resolved = must(await assignmentsRepo.resolveActiveAssignment(sx, venture.id));
    const session = await sx.query(
      `INSERT INTO coaching_sessions (tenant_id, venture_id, assignment_id, persona_release_id, started_by, mode,
                                      privacy, policy_version)
       VALUES (:tenant, :venture, :assignment, :release, :maya, 'coach', 'standard', 'legacy') RETURNING id`,
      {
        tenant: p.uuid(seed.tenantId),
        venture: p.uuid(venture.id),
        assignment: p.uuid(resolved.assignment.id),
        release: p.uuid(must(resolved.release).id),
        maya: p.uuid(maya),
      },
    );
    const turn = await sx.query(
      `INSERT INTO turns (tenant_id, venture_id, session_id, ordinal, author_id, mode, founder_text, status,
                          model_id, input_tokens, output_tokens, cost_usd, latency_ms, completed_at)
       VALUES (:tenant, :venture, :session, 1, :maya, 'coach', 'Where are the quiet seats?', 'completed', 'mock',
               1, 1, 0, 1, now())
       RETURNING id`,
      {
        tenant: p.uuid(seed.tenantId),
        venture: p.uuid(venture.id),
        session: p.uuid(String(must(session.rows[0]).id)),
        maya: p.uuid(maya),
      },
    );
    const turnId = String(must(turn.rows[0]).id);
    const memory = await sx.query(
      `SELECT id FROM memory_objects WHERE venture_id = :venture AND visibility <> 'founder_private' LIMIT 1`,
      { venture: p.uuid(venture.id) },
    );
    const memoryId = String(must(memory.rows[0]).id);
    const goneChunk = randomUUID();
    // Evidence exactly as the previous code wrote it: no source columns.
    await sx.query(
      `INSERT INTO turn_evidence (turn_id, evidence_key, venture_id, kind, ref_id, score, title)
       VALUES (:turn, 'E1', :venture, 'memory', :memory, 0.9, 'Memory'),
              (:turn, 'E2', :venture, 'chunk', :ventureChunk, 0.8, 'Interview notes'),
              (:turn, 'E3', NULL, 'chunk', :programChunk, 0.7, 'Program handbook'),
              (:turn, 'E4', NULL, 'doctrine', :personaChunk, 0.6, 'Library note'),
              (:turn, 'E5', :venture, 'chunk', :gone, 0.5, '[deleted]')`,
      {
        turn: p.uuid(turnId),
        venture: p.uuid(venture.id),
        memory: p.uuid(memoryId),
        ventureChunk: p.uuid(chunks.venture.chunk),
        programChunk: p.uuid(chunks.program.chunk),
        personaChunk: p.uuid(chunks.persona.chunk),
        gone: p.uuid(goneChunk),
      },
    );
    return { turnId, ...chunks, goneChunk, memory: memoryId };
  });
}

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  await migrate(t.db, { migrations: BEFORE });
  seed = await seedDatabase(t.db, CONFIG);
  cited = await writeCitations(t.db);
  const people = await t.db.system(async (sx) => {
    const created = await principalsRepo.createPrincipal(sx, {
      tenantId: seed.tenantId,
      displayName: 'Admin Only',
    });
    await principalsRepo.grantRole(sx, {
      principalId: created.id,
      tenantId: seed.tenantId,
      role: 'platform_admin',
    });
    const partner = await tenantsRepo.upsertTenant(sx, {
      slug: 'partner-u',
      name: 'Partner',
      kind: 'partner',
    });
    const outsider = await principalsRepo.createPrincipal(sx, {
      tenantId: partner.id,
      displayName: 'Partner Person',
    });
    return { admin: created.id, outsider: outsider.id };
  });
  adminOnly = people.admin;
  otherTenantPerson = people.outsider;
});
afterAll(async () => {
  await t.cleanup();
});

const INSERT_PROFILE = `INSERT INTO eir_profiles (tenant_id, principal_id, display_name, synthetic)
                        VALUES (:tenant, :principal, :name, false)`;

describe('migration 0011_eir_profiles_evidence_sources', () => {
  it('refused platform admins a profile before it (the gap it closes)', async () => {
    const someone = await t.db.system((sx) =>
      principalsRepo.createPrincipal(sx, { tenantId: seed.tenantId, displayName: 'Before 0011' }),
    );
    expect(
      await sqlState(
        t.db.withContext(admin(), (tx) =>
          tx.query(INSERT_PROFILE, {
            tenant: p.uuid(seed.tenantId),
            principal: p.uuid(someone.id),
            name: p.text('Before 0011'),
          }),
        ),
      ),
    ).toBe('42501');
  });

  it('applies cleanly on top of the earlier migrations with existing evidence, as the non-superuser owner', async () => {
    const report = await migrate(t.db);
    // Later migrations follow in the same run (their own suites cover them).
    expect(report.applied).toEqual(MIGRATIONS.map((m) => m.version).filter((v) => v >= '0011'));
    expect(report.applied[0]).toBe('0011_eir_profiles_evidence_sources');
    expect(SOURCES && splitStatements(SOURCES.sql).length).toBeGreaterThanOrEqual(10);
  });

  it('backfills the source of each passage whose chunk exists, and of nothing else', async () => {
    const rows = await t.db.system((sx) =>
      sx.query(
        `SELECT evidence_key, source_id, source_scope FROM turn_evidence WHERE turn_id = :turn
          ORDER BY evidence_key`,
        { turn: p.uuid(cited.turnId) },
      ),
    );
    expect(rows.rows).toEqual([
      { evidence_key: 'E1', source_id: null, source_scope: null },
      { evidence_key: 'E2', source_id: cited.venture.source, source_scope: 'venture' },
      { evidence_key: 'E3', source_id: cited.program.source, source_scope: 'program' },
      { evidence_key: 'E4', source_id: cited.persona.source, source_scope: 'persona' },
      { evidence_key: 'E5', source_id: null, source_scope: null },
    ]);
    // Read back as evidence items: the source by id, nothing for memory or an unknown passage.
    const items = must(
      (await t.db.system((sx) => turnsRepo.listTurnEvidence(sx, [cited.turnId]))).get(cited.turnId),
    );
    expect(items.map((i) => i.source)).toEqual([
      null,
      { id: cited.venture.source, scope: 'venture' },
      { id: cited.program.source, scope: 'program' },
      { id: cited.persona.source, scope: 'persona' },
      null,
    ]);
  });

  it('records a source only for passages, and always with its scope', async () => {
    const write = (sql: string) =>
      sqlState(t.db.system((sx) => sx.query(sql, { turn: p.uuid(cited.turnId), id: p.uuid(randomUUID()) })));
    const insert = (key: string, kind: string, source: string, scope: string) =>
      `INSERT INTO turn_evidence (turn_id, evidence_key, kind, ref_id, score, title, source_id, source_scope)
       VALUES (:turn, '${key}', '${kind}', :id, 0.1, 'x', ${source}, ${scope})`;
    expect(await write(insert('E6', 'memory', ':id', `'venture'`))).toBe('23514');
    expect(await write(insert('E6', 'chunk', ':id', 'NULL'))).toBe('23514');
    expect(await write(insert('E6', 'chunk', 'NULL', `'program'`))).toBe('23514');
    expect(await write(insert('E6', 'chunk', ':id', `'elsewhere'`))).toBe('23514');
    expect(await write(insert('E6', 'doctrine', ':id', `'persona'`))).toBeNull();
  });

  it('lets platform admins and program leads create profiles of people of their tenant; never EIRs', async () => {
    const people = await t.db.system(async (sx) => ({
      a: await principalsRepo.createPrincipal(sx, { tenantId: seed.tenantId, displayName: 'Ada Admin-Made' }),
      b: await principalsRepo.createPrincipal(sx, { tenantId: seed.tenantId, displayName: 'Bo Lead-Made' }),
      c: await principalsRepo.createPrincipal(sx, { tenantId: seed.tenantId, displayName: 'Cy Never' }),
    }));
    const byAdmin = await t.db.withContext(admin(), (tx) =>
      eirRepo.createEirProfile(tx, {
        tenantId: seed.tenantId,
        principalId: people.a.id,
        displayName: 'Ada Admin-Made',
        bio: 'Built two hardware companies.',
        synthetic: false,
      }),
    );
    expect(byAdmin).toMatchObject({ principalId: people.a.id, bio: 'Built two hardware companies.' });
    const edited = await t.db.withContext(admin(), (tx) =>
      eirRepo.updateEirProfile(tx, byAdmin.id, { title: 'Hardware EIR', bio: null }),
    );
    expect(edited).toMatchObject({ title: 'Hardware EIR', bio: null });
    await t.db.withContext(lead(), (tx) =>
      eirRepo.createEirProfile(tx, { tenantId: seed.tenantId, principalId: people.b.id, displayName: 'Bo' }),
    );
    const params = { tenant: p.uuid(seed.tenantId), principal: p.uuid(people.c.id), name: p.text('Cy') };
    expect(await sqlState(t.db.withContext(corin(), (tx) => tx.query(INSERT_PROFILE, params)))).toBe('42501');
    // Nobody links a person of another tenant.
    for (const who of [admin(), lead()]) {
      expect(
        await sqlState(
          t.db.withContext(who, (tx) =>
            tx.query(INSERT_PROFILE, { ...params, principal: p.uuid(otherTenantPerson) }),
          ),
        ),
      ).toBe('42501');
    }
    // A bio is short.
    expect(
      await sqlState(
        t.db.withContext(admin(), (tx) =>
          eirRepo.updateEirProfile(tx, byAdmin.id, { bio: 'x'.repeat(2001) }),
        ),
      ),
    ).toBe('23514');
  });

  it('keeps one profile per person', async () => {
    const corinId = must(seed.principals['eir-corin']);
    expect(
      await sqlState(
        t.db.withContext(lead(), (tx) =>
          tx.query(INSERT_PROFILE, {
            tenant: p.uuid(seed.tenantId),
            principal: p.uuid(corinId),
            name: p.text('Corin again'),
          }),
        ),
      ),
    ).toBe('23505');
    // Profiles without an account are not limited.
    await t.db.withContext(lead(), async (tx) => {
      await eirRepo.createEirProfile(tx, { tenantId: seed.tenantId, displayName: 'No account one' });
      await eirRepo.createEirProfile(tx, { tenantId: seed.tenantId, displayName: 'No account two' });
    });
  });

  it('keeps the previous code working: its evidence and profile writes, and EIRs editing their own profile', async () => {
    const before = await t.db.system((sx) =>
      sx.query(
        `INSERT INTO turn_evidence (turn_id, evidence_key, kind, ref_id, score, title)
         VALUES (:turn, 'E9', 'chunk', :id, 0.2, 'Old build') RETURNING source_id`,
        { turn: p.uuid(cited.turnId), id: p.uuid(cited.program.chunk) },
      ),
    );
    expect(before.rows[0]).toEqual({ source_id: null });
    const someone = await t.db.system((sx) =>
      principalsRepo.createPrincipal(sx, { tenantId: seed.tenantId, displayName: 'Old Build' }),
    );
    await t.db.withContext(lead(), (tx) =>
      tx.query(INSERT_PROFILE, {
        tenant: p.uuid(seed.tenantId),
        principal: p.uuid(someone.id),
        name: p.text('Old Build'),
      }),
    );
    const own = must(
      await t.db.withContext(corin(), (tx) => eirRepo.getEirProfileByPrincipal(tx, corin().principalId)),
    );
    const renamed = await t.db.withContext(corin(), (tx) =>
      eirRepo.updateEirProfile(tx, own.id, { title: 'Go-to-market EIR' }),
    );
    expect(renamed?.title).toBe('Go-to-market EIR');
  });

  it('is idempotent: re-running every statement, then the runner, changes nothing', async () => {
    if (!SOURCES) throw new Error('0011 missing');
    const before = await schemaFingerprint(t.db);
    await t.db.system(async (sx) => {
      for (const statement of splitStatements(SOURCES.sql)) await sx.query(statement);
    });
    expect(await schemaFingerprint(t.db)).toBe(before);
    expect((await migrate(t.db)).applied).toEqual([]);
  });
});

describe('migration 0011 where someone already has two profiles', () => {
  let d: TestDatabase;
  beforeAll(async () => {
    d = await createTestDatabase({ migrate: false });
    await migrate(d.db, { migrations: BEFORE });
    await d.db.system(async (sx) => {
      const tenant = await tenantsRepo.upsertTenant(sx, { slug: 'dup', name: 'Dup', kind: 'home' });
      const person = await principalsRepo.createPrincipal(sx, { tenantId: tenant.id, displayName: 'Twice' });
      for (const name of ['Twice', 'Twice again']) {
        await sx.query(INSERT_PROFILE, {
          tenant: p.uuid(tenant.id),
          principal: p.uuid(person.id),
          name: p.text(name),
        });
      }
    });
  });
  afterAll(async () => {
    await d.cleanup();
  });

  it('applies without the one-per-person index (the service still refuses a second profile)', async () => {
    const report = await migrate(d.db);
    expect(report.applied[0]).toBe('0011_eir_profiles_evidence_sources');
    const index = await d.db.system((sx) =>
      sx.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'eir_profiles_principal_uq'`),
    );
    expect(index.rows).toHaveLength(0);
    const bio = await d.db.system((sx) =>
      sx.query('SELECT count(*)::int AS n FROM eir_profiles WHERE bio IS NULL'),
    );
    expect(bio.rows[0]).toEqual({ n: 2 });
  });
});
