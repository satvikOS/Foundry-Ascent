/**
 * Migration 0005 (wave-1 fixes) on the state production has: a database seeded before vEIRs existed, migrated
 * to 0004 and seeded again, with data the 0004 code wrote. It applies cleanly, backfills who set each title,
 * clears temporary-chat titles, repairs notebooks to the stricter shape, removes chunks an earlier seed run
 * brought back, turns the program corpus into a note, stays compatible with rows written the 0004 way,
 * re-runs without changes, and the seed that follows changes nothing on its second run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from './db.js';
import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import { auditRepo } from './repositories/index.js';
import { seedDatabase, type SeedConfig, type SeedResult } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const FIXES = MIGRATIONS.find((m) => m.version === '0005_wave1_fixes');
const THROUGH_VEIR = MIGRATIONS.filter((m) => m.version <= '0004_veir_knowledge');
/** 0005 on its own: later migrations have their own suites. */
const THROUGH_FIXES = MIGRATIONS.filter((m) => m.version <= '0005_wave1_fixes');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };

let t: TestDatabase;
let seed: SeedResult;
let legacy: {
  renamed: string;
  named: string;
  automatic: string;
  temporary: string;
  notebook: string;
  edited: string;
  withdrawn: string;
  program: string;
};

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

/** Conversations, a notebook and knowledge chunks as the 0004 code and seed left them. */
async function writeLegacyData(db: Db): Promise<typeof legacy> {
  const quietquad = must(seed.ventures.find((v) => v.key === 'quietquad'));
  const emberloop = must(seed.ventures.find((v) => v.key === 'emberloop'));
  const maya = must(seed.principals.maya);
  const created = await db.system(async (sx) => {
    const release = await sx.query(
      `SELECT r.id FROM persona_releases r WHERE r.persona_id = :persona AND r.status = 'approved'`,
      { persona: p.uuid(quietquad.personaId) },
    );
    const session = async (privacy: 'standard' | 'ephemeral', title: string | null, first: string) => {
      const r = await sx.query(
        `INSERT INTO coaching_sessions (tenant_id, venture_id, assignment_id, persona_release_id, started_by, mode,
                                        privacy, goal, policy_version, title)
         VALUES (:tenant, :venture, :assignment, :release, :maya, 'coach', :privacy, 'Plan the pilot', '0004', :title)
         RETURNING id`,
        {
          tenant: p.uuid(seed.tenantId),
          venture: p.uuid(quietquad.id),
          assignment: p.uuid(quietquad.assignmentId),
          release: p.uuid(String(release.rows[0]?.id)),
          maya: p.uuid(maya),
          privacy: p.text(privacy),
          title: p.nullable.text(title),
        },
      );
      const id = String(r.rows[0]?.id);
      await sx.query(
        `INSERT INTO turns (tenant_id, venture_id, session_id, ordinal, author_id, mode, founder_text, status, risk_label)
         VALUES (:tenant, :venture, :session, 1, :maya, 'coach', :text, 'completed', 'none')`,
        {
          tenant: p.uuid(seed.tenantId),
          venture: p.uuid(quietquad.id),
          session: p.uuid(id),
          maya: p.uuid(maya),
          text: p.text(first),
        },
      );
      return id;
    };
    const renamed = await session('standard', null, 'Where do students study?');
    await sx.query(`UPDATE coaching_sessions SET title = 'Study spots' WHERE id = :id`, { id: p.uuid(renamed) });
    await auditRepo.appendAudit(sx, {
      action: 'session.renamed',
      outcome: 'succeeded',
      tenantId: seed.tenantId,
      actorId: maya,
      ventureId: quietquad.id,
      objectType: 'session',
      objectId: renamed,
    });
    const named = await session('standard', 'Library pilot', 'How do we pick the libraries?');
    const automatic = await session('standard', null, 'How many seats do we need?');
    // 0004 let a temporary chat be renamed.
    const temporary = await session('ephemeral', null, 'A private question');
    await sx.query(`UPDATE coaching_sessions SET title = 'Private' WHERE id = :id`, { id: p.uuid(temporary) });

    // A notebook line whose source and time the 0004 CHECK accepted but the contract does not.
    const notebook = await sx.query(
      `UPDATE veir_notebooks SET content = content || jsonb_build_object('founderProfile', :entries)
       WHERE venture_id = :venture RETURNING id`,
      {
        venture: p.uuid(emberloop.id),
        entries: p.json([
          { id: 'fp-1', text: 'Prefers numbers first', sourceSessionId: 'spreadsheet-row-4', createdAt: 'last week' },
        ]),
      },
    );

    const library = await sx.query(
      `SELECT s.id FROM knowledge_sources s JOIN knowledge_chunks c ON c.source_id = s.id
       WHERE s.scope = 'persona' AND s.kind <> 'document' AND s.persona_id <> :guide
       GROUP BY s.id, s.title HAVING count(*) > 1 ORDER BY s.title LIMIT 2`,
      { guide: p.uuid(seed.personaId) },
    );
    const program = await sx.query(`SELECT id FROM knowledge_sources WHERE scope = 'program'`);
    return {
      renamed,
      named,
      automatic,
      temporary,
      notebook: String(notebook.rows[0]?.id),
      edited: String(library.rows[0]?.id),
      withdrawn: String(library.rows[1]?.id),
      program: String(program.rows[0]?.id),
    };
  });
  // A curator edits one note and withdraws another (each in its own transaction, as the library does)...
  await db.system(async (sx) => {
    await sx.query(`UPDATE knowledge_sources SET body = 'One section now.', updated_at = now() WHERE id = :id`, {
      id: p.uuid(created.edited),
    });
    await sx.query('DELETE FROM knowledge_chunks WHERE source_id = :id AND ordinal > 1', {
      id: p.uuid(created.edited),
    });
  });
  await db.system(async (sx) => {
    await sx.query('DELETE FROM knowledge_chunks WHERE source_id = :id', { id: p.uuid(created.withdrawn) });
    await sx.query(`UPDATE knowledge_sources SET status = 'withdrawn', updated_at = now() WHERE id = :id`, {
      id: p.uuid(created.withdrawn),
    });
  });
  // ...and the next deploy's 0004-era seed inserts their seeded chunks again (ON CONFLICT DO NOTHING).
  await db.system((sx) =>
    sx.query(
      `INSERT INTO knowledge_chunks (source_id, tenant_id, scope, persona_id, ordinal, heading, content, token_count)
       SELECT s.id, s.tenant_id, s.scope, s.persona_id, x.n, s.title, 'Seeded text ' || x.n, 3
       FROM knowledge_sources s CROSS JOIN generate_series(1, 3) AS x (n)
       WHERE s.id IN (:edited, :withdrawn)
       ON CONFLICT DO NOTHING`,
      { edited: p.uuid(created.edited), withdrawn: p.uuid(created.withdrawn) },
    ),
  );
  return created;
}

async function counts(db: Db): Promise<Record<string, number>> {
  return db.system(async (sx) => {
    const out: Record<string, number> = {};
    for (const table of [
      'knowledge_sources',
      'knowledge_chunks',
      'veir_notebooks',
      'coaching_sessions',
      'turns',
      'memory_objects',
      'assignments',
    ]) {
      const r = await sx.query(`SELECT count(*) AS n FROM ${table}`);
      out[table] = Number(r.rows[0]?.n);
    }
    return out;
  });
}

/** Policies, functions, constraints and comments, as text: equal before and after a re-run. */
async function schemaFingerprint(db: Db): Promise<string> {
  return db.system(async (sx) => {
    const policies = await sx.query(
      `SELECT tablename, policyname, cmd, coalesce(qual, '') AS qual, coalesce(with_check, '') AS with_check
         FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`,
    );
    const functions = await sx.query(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src,
              coalesce(array_to_string(p.proacl, ','), '') AS acl, coalesce(obj_description(p.oid, 'pg_proc'), '') AS doc
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' ORDER BY 1, 2`,
    );
    const constraints = await sx.query(
      `SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`,
    );
    return JSON.stringify([policies.rows, functions.rows, constraints.rows]);
  });
}

async function chunkCount(sourceId: string): Promise<number> {
  const r = await t.db.system((sx) =>
    sx.query('SELECT count(*)::int AS n FROM knowledge_chunks WHERE source_id = :id', { id: p.uuid(sourceId) }),
  );
  return Number(r.rows[0]?.n);
}

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  // Production's history: the pre-vEIR seed, migration 0004, the 0004-era seed.
  await migrate(t.db, { migrations: MIGRATIONS.filter((m) => m.version < '0004') });
  await seedDatabase(t.db, CONFIG);
  await migrate(t.db, { migrations: THROUGH_VEIR });
  seed = await seedDatabase(t.db, CONFIG);
  legacy = await writeLegacyData(t.db);
});
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0005_wave1_fixes', () => {
  it('applies cleanly on top of 0001–0004 with existing data, as the non-superuser owner', async () => {
    const report = await migrate(t.db, { migrations: THROUGH_FIXES });
    expect(report.applied).toEqual(['0005_wave1_fixes']);
    expect(FIXES && splitStatements(FIXES.sql).length).toBeGreaterThan(20);
  });

  it('records who set each title and clears the titles of temporary chats', async () => {
    const r = await t.db.system((sx) =>
      sx.query(`SELECT id, title, title_source FROM coaching_sessions WHERE id = ANY (:ids)`, {
        ids: p.uuidArray([legacy.renamed, legacy.named, legacy.automatic, legacy.temporary]),
      }),
    );
    const rows = new Map(r.rows.map((row) => [String(row.id), row]));
    expect(rows.get(legacy.renamed)).toMatchObject({ title: 'Study spots', title_source: 'person' });
    expect(rows.get(legacy.named)).toMatchObject({ title: 'Library pilot', title_source: 'person' });
    expect(rows.get(legacy.automatic)).toMatchObject({
      title: 'How many seats do we need?',
      title_source: 'auto',
    });
    expect(rows.get(legacy.temporary)).toMatchObject({ title: null, title_source: 'auto' });
    // The seeded conversation was titled by distillation.
    const seeded = await t.db.system((sx) =>
      sx.query(`SELECT title_source FROM coaching_sessions WHERE distilled_at IS NOT NULL`),
    );
    expect(seeded.rows).toEqual([{ title_source: 'auto' }]);
  });

  it('repairs notebooks to the contract shape without losing a line', async () => {
    const r = await t.db.system((sx) =>
      sx.query(
        `SELECT content -> 'founderProfile' -> 0 AS entry, created_at, app.notebook_content_valid(content) AS valid
         FROM veir_notebooks WHERE id = :id`,
        { id: p.uuid(legacy.notebook) },
      ),
    );
    const row = must(r.rows[0]);
    const entry = JSON.parse(String(row.entry)) as Record<string, unknown>;
    expect(row.valid).toBe(true);
    expect(entry).toMatchObject({ id: 'fp-1', text: 'Prefers numbers first', sourceSessionId: null });
    expect(Date.parse(String(entry.createdAt))).toBe(new Date(String(row.created_at)).getTime());
    const invalid = await t.db.system((sx) =>
      sx.query(`SELECT count(*)::int AS n FROM veir_notebooks WHERE NOT app.notebook_content_valid(content)`),
    );
    expect(invalid.rows[0]).toEqual({ n: 0 });
  });

  it('removes the chunks a seed run brought back and turns the program corpus into a note', async () => {
    expect(await chunkCount(legacy.edited)).toBe(1);
    expect(await chunkCount(legacy.withdrawn)).toBe(0);
    const program = await t.db.system((sx) =>
      sx.query(`SELECT kind, body IS NOT NULL AS has_body FROM knowledge_sources WHERE id = :id`, {
        id: p.uuid(legacy.program),
      }),
    );
    expect(program.rows[0]).toEqual({ kind: 'note', has_body: true });
    expect(await chunkCount(legacy.program)).toBeGreaterThan(1);
  });

  it('stays compatible with rows written the 0004 way', async () => {
    const quietquad = must(seed.ventures.find((v) => v.key === 'quietquad'));
    await t.db.system(async (sx) => {
      const r = await sx.query(
        `INSERT INTO coaching_sessions (tenant_id, venture_id, assignment_id, persona_release_id, started_by, mode,
                                        privacy, policy_version, title)
         SELECT tenant_id, venture_id, assignment_id, persona_release_id, started_by, 'coach', 'standard', '0004',
                'Old-style title'
         FROM coaching_sessions WHERE id = :id
         RETURNING title_source`,
        { id: p.uuid(legacy.named) },
      );
      expect(r.rows[0]).toEqual({ title_source: 'auto' });
      const notebook = await sx.query(
        `UPDATE veir_notebooks SET content = jsonb_build_object('summary', 'Old shape', 'founderProfile', '[]'::jsonb,
           'commitments', '[]'::jsonb, 'openQuestions', '[]'::jsonb, 'lastAdvice', '[]'::jsonb, 'nextOpener', NULL)
         WHERE venture_id = :venture RETURNING id`,
        { venture: p.uuid(quietquad.id) },
      );
      expect(notebook.rows).toHaveLength(1);
    });
  });

  it('is idempotent: re-running every statement, then the runner, changes nothing', async () => {
    if (!FIXES) throw new Error('0005 missing');
    const before = await schemaFingerprint(t.db);
    const rows = await counts(t.db);
    await t.db.system(async (sx) => {
      for (const statement of splitStatements(FIXES.sql)) await sx.query(statement);
    });
    expect(await schemaFingerprint(t.db)).toBe(before);
    expect(await counts(t.db)).toEqual(rows);
    const again = await migrate(t.db, { migrations: THROUGH_FIXES });
    expect(again.applied).toEqual([]);
  });

  it('the next seed changes nothing it should keep, and a second run changes nothing at all', async () => {
    await seedDatabase(t.db, CONFIG);
    const after = await counts(t.db);
    expect(await chunkCount(legacy.edited)).toBe(1);
    expect(await chunkCount(legacy.withdrawn)).toBe(0);
    await seedDatabase(t.db, CONFIG);
    expect(await counts(t.db)).toEqual(after);
  });
});
