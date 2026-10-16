/**
 * Migration 0004 (vEIR knowledge pools, conversations, calls) on top of the 0001–0003 state production has,
 * with data the previous seed and the previous code wrote: it applies cleanly, backfills conversations and the
 * seeded doctrine corpus, stays compatible with rows written the old way, re-runs without changes, and the
 * seed that follows re-points the demo ventures to their vEIRs exactly once (twice changes nothing; a venture
 * a program lead re-assigned is left alone).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from './db.js';
import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import { assignmentsRepo } from './repositories/index.js';
import { seedDatabase, type SeedConfig, type SeedResult } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const BEFORE = MIGRATIONS.filter((m) => m.version < '0004');
const VEIR = MIGRATIONS.find((m) => m.version === '0004_veir_knowledge');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };

let t: TestDatabase;
let oldSeed: SeedResult;
let legacy: { standard: string; ephemeral: string; emberAssignment: string };

function venture(seed: SeedResult, key: string): SeedResult['ventures'][number] {
  const v = seed.ventures.find((x) => x.key === key);
  if (!v) throw new Error(`no venture ${key}`);
  return v;
}

/** Conversations as the previous code wrote them, and a venture a program lead re-assigned in the product. */
async function writeLegacyData(db: Db): Promise<typeof legacy> {
  const quietquad = venture(oldSeed, 'quietquad');
  const maya = oldSeed.principals.maya ?? '';
  return db.system(async (sx) => {
    const session = async (privacy: 'standard' | 'ephemeral'): Promise<string> => {
      const r = await sx.query(
        `INSERT INTO coaching_sessions (tenant_id, venture_id, assignment_id, persona_release_id, started_by, mode,
                                        privacy, goal, policy_version, started_at)
         VALUES (:tenant, :venture, :assignment, :release, :maya, 'coach', :privacy, 'Plan the pilot', 'legacy',
                 now() - interval '3 days')
         RETURNING id`,
        {
          tenant: p.uuid(oldSeed.tenantId),
          venture: p.uuid(quietquad.id),
          assignment: p.uuid(quietquad.assignmentId),
          release: p.uuid(oldSeed.releaseId),
          maya: p.uuid(maya),
          privacy: p.text(privacy),
        },
      );
      return String(r.rows[0]?.id);
    };
    const turn = async (
      sessionId: string,
      ordinal: number,
      text: string,
      label: string,
      hoursAgo: number,
    ) => {
      await sx.query(
        `INSERT INTO turns (tenant_id, venture_id, session_id, ordinal, author_id, mode, founder_text, status,
                            risk_label, created_at)
         VALUES (:tenant, :venture, :session, :ordinal, :maya, 'coach', :text, 'completed', :label,
                 now() - make_interval(hours => :hours))`,
        {
          tenant: p.uuid(oldSeed.tenantId),
          venture: p.uuid(quietquad.id),
          session: p.uuid(sessionId),
          ordinal: p.int(ordinal),
          maya: p.uuid(maya),
          text: p.text(text),
          label: p.text(label),
          hours: p.int(hoursAgo),
        },
      );
    };
    const standard = await session('standard');
    await turn(standard, 1, 'I feel like I cannot cope with this anymore', 'crisis', 50);
    await turn(standard, 2, '## How do we price a **two-library** pilot for the exam weeks?', 'none', 49);
    const ephemeral = await session('ephemeral');
    await turn(ephemeral, 1, 'A temporary question', 'none', 48);
    // A program lead moved EmberLoop to a fresh Foundry Guide assignment through the product.
    const ember = venture(oldSeed, 'emberloop');
    const reassigned = await assignmentsRepo.createAssignment(sx, {
      tenantId: oldSeed.tenantId,
      ventureId: ember.id,
      personaId: oldSeed.personaId,
    });
    return { standard, ephemeral, emberAssignment: reassigned.id };
  });
}

async function counts(db: Db): Promise<Record<string, number>> {
  return db.system(async (sx) => {
    const out: Record<string, number> = {};
    for (const table of [
      'personas',
      'persona_releases',
      'consents',
      'assignments',
      'knowledge_sources',
      'knowledge_chunks',
      'patterns',
      'veir_notebooks',
      'coaching_sessions',
      'turns',
    ]) {
      const r = await sx.query(`SELECT count(*) AS n FROM ${table}`);
      out[table] = Number(r.rows[0]?.n);
    }
    return out;
  });
}

async function activePersonas(db: Db): Promise<Record<string, string>> {
  const r = await db.system((sx) =>
    sx.query(
      `SELECT v.name AS venture, pe.name AS persona FROM assignments a
       JOIN ventures v ON v.id = a.venture_id JOIN personas pe ON pe.id = a.persona_id
       WHERE a.status = 'active' ORDER BY v.name`,
    ),
  );
  return Object.fromEntries(r.rows.map((row) => [String(row.venture), String(row.persona)]));
}

/** Policies, functions, triggers and settings, as text: equal before and after a re-run. */
async function schemaFingerprint(db: Db): Promise<string> {
  return db.system(async (sx) => {
    const policies = await sx.query(
      `SELECT tablename, policyname, cmd, coalesce(qual, '') AS qual, coalesce(with_check, '') AS with_check
         FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`,
    );
    const functions = await sx.query(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src,
              coalesce(array_to_string(p.proacl, ','), '') AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' ORDER BY 1, 2`,
    );
    const constraints = await sx.query(
      `SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`,
    );
    const triggers = await sx.query(
      `SELECT tgname, tgrelid::regclass::text AS rel FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`,
    );
    const settings = await sx.query(`SELECT key, value::text AS value FROM platform_settings ORDER BY key`);
    return JSON.stringify([policies.rows, functions.rows, constraints.rows, triggers.rows, settings.rows]);
  });
}

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  const base = await migrate(t.db, { migrations: BEFORE });
  expect(base.applied).toEqual(['0001_init', '0002_rls_helpers', '0003_security_hardening']);
  // The seed on a pre-0004 schema is the previous seed: Foundry Guide coaches every demo venture.
  oldSeed = await seedDatabase(t.db, CONFIG);
  legacy = await writeLegacyData(t.db);
});
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0004_veir_knowledge', () => {
  it('starts from the previous seed: no vEIRs, Foundry Guide everywhere', async () => {
    expect(oldSeed.veirs).toEqual([]);
    expect(Object.values(await activePersonas(t.db))).toEqual([
      'Foundry Guide',
      'Foundry Guide',
      'Foundry Guide',
      'Foundry Guide',
    ]);
  });

  it('applies cleanly on top of 0001–0003 with existing data, as the non-superuser owner', async () => {
    const report = await migrate(t.db);
    // The later migrations follow in the same run (their own suites cover them).
    expect(report.applied).toEqual(MIGRATIONS.map((m) => m.version).filter((v) => v >= '0004'));
    expect(report.applied[0]).toBe('0004_veir_knowledge');
    expect(VEIR && splitStatements(VEIR.sql).length).toBeGreaterThan(40);
  });

  it('backfills conversations: last activity, titles from the first non-crisis message, none for temporary chats', async () => {
    const rows = await t.db.system((sx) =>
      sx.query(
        `SELECT s.id, s.title, s.has_calls, s.digest,
                s.last_activity_at = (SELECT max(t.created_at) FROM turns t WHERE t.session_id = s.id) AS latest
         FROM coaching_sessions s WHERE s.id = ANY (:ids) ORDER BY s.privacy DESC`,
        { ids: p.uuidArray([legacy.standard, legacy.ephemeral]) },
      ),
    );
    expect(rows.rows).toEqual([
      {
        id: legacy.standard,
        title: 'How do we price a two-library pilot for the exam weeks?',
        has_calls: false,
        digest: null,
        latest: true,
      },
      { id: legacy.ephemeral, title: null, has_calls: false, digest: null, latest: true },
    ]);
    const turns = await t.db.system((sx) => sx.query(`SELECT DISTINCT channel FROM turns`));
    expect(turns.rows).toEqual([{ channel: 'text' }]);
  });

  it('turns the seeded doctrine corpus into an authored note and keeps every other source a document', async () => {
    const rows = await t.db.system((sx) =>
      sx.query(
        `SELECT scope, kind, body IS NOT NULL AS has_body, count(*)::int AS n FROM knowledge_sources
         GROUP BY 1, 2, 3 ORDER BY 1, 2`,
      ),
    );
    expect(rows.rows).toEqual([
      { scope: 'persona', kind: 'note', has_body: true, n: 1 },
      { scope: 'program', kind: 'document', has_body: false, n: 1 },
      { scope: 'venture', kind: 'document', has_body: false, n: 6 },
    ]);
  });

  it('stays compatible with rows written the previous way (defaults for every new column)', async () => {
    const quietquad = venture(oldSeed, 'quietquad');
    await t.db.system(async (sx) => {
      await sx.query(
        `INSERT INTO knowledge_sources (tenant_id, scope, persona_id, title) VALUES (:t, 'persona', :persona, 'Old way')`,
        { t: p.uuid(oldSeed.tenantId), persona: p.uuid(oldSeed.personaId) },
      );
      await sx.query(
        `INSERT INTO personas (tenant_id, name, kind, status) VALUES (:t, 'Old-style guide', 'neutral_guide', 'draft')`,
        { t: p.uuid(oldSeed.tenantId) },
      );
      await sx.query(
        `INSERT INTO patterns (tenant_id, title, context, signal, intervention, outcome, limits, source_class)
         VALUES (:t, 'Old lesson', 'c', 's', 'i', 'o', 'l', 'x')`,
        { t: p.uuid(oldSeed.tenantId) },
      );
      const r = await sx.query(
        `SELECT (SELECT embodiment ->> 'provider' FROM personas WHERE name = 'Old-style guide') AS provider,
                (SELECT origin FROM patterns WHERE title = 'Old lesson') AS origin,
                (SELECT kind FROM knowledge_sources WHERE title = 'Old way') AS kind,
                (SELECT count(*)::int FROM coaching_sessions WHERE venture_id = :v) AS sessions`,
        { v: p.uuid(quietquad.id) },
      );
      expect(r.rows[0]).toEqual({ provider: 'builtin', origin: 'authored', kind: 'document', sessions: 2 });
      await sx.query(`DELETE FROM knowledge_sources WHERE title = 'Old way'`);
      await sx.query(`DELETE FROM personas WHERE name = 'Old-style guide'`);
      await sx.query(`DELETE FROM patterns WHERE title = 'Old lesson'`);
    });
  });

  it('is idempotent: re-running every statement, then the runner, changes nothing', async () => {
    if (!VEIR) throw new Error('0004 missing');
    const before = await schemaFingerprint(t.db);
    await t.db.system(async (sx) => {
      for (const statement of splitStatements(VEIR.sql)) await sx.query(statement);
    });
    expect(await schemaFingerprint(t.db)).toBe(before);
    const again = await migrate(t.db);
    expect(again.applied).toEqual([]);
  });

  it('the next seed re-points the untouched demo ventures to their vEIRs once; a second run changes nothing', async () => {
    const first = await seedDatabase(t.db, CONFIG);
    expect(first.veirs.map((v) => v.name)).toEqual(["Corin's vEIR", "Ruth's vEIR"]);
    expect(await activePersonas(t.db)).toEqual({
      BenchTally: "Ruth's vEIR",
      // Re-assigned by a program lead in the product before this deploy: left alone.
      EmberLoop: 'Foundry Guide',
      QuietQuad: "Corin's vEIR",
      SoleSignal: "Corin's vEIR",
    });
    const ember = await t.db.system((sx) =>
      sx.query(`SELECT status FROM assignments WHERE id = :id`, { id: p.uuid(legacy.emberAssignment) }),
    );
    expect(ember.rows[0]).toEqual({ status: 'active' });
    // The original seeded guide assignments of the re-pointed ventures were ended, not deleted.
    const ended = await t.db.system((sx) =>
      sx.query(`SELECT count(*)::int AS n FROM assignments WHERE persona_id = :guide AND status = 'ended'`, {
        guide: p.uuid(oldSeed.personaId),
      }),
    );
    expect(ended.rows[0]).toEqual({ n: 4 });
    const after = await counts(t.db);
    expect(after.veir_notebooks).toBe(3);
    await seedDatabase(t.db, CONFIG);
    expect(await counts(t.db)).toEqual(after);
    expect((await activePersonas(t.db)).QuietQuad).toBe("Corin's vEIR");
  });
});
