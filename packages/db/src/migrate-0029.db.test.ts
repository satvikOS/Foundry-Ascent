/**
 * Migration 0029 (the welcome per mentor) on a database where people read 0016's single welcome: it applies cleanly
 * as the non-superuser owner; everyone starts with no introductions read (so a founder who read "Meet Corin's vEIR"
 * meets Thomas once), while 0016's acknowledgement is kept and its functions still work; a person adds and reads
 * only their own introductions (each once, at most 20 kept, only well-formed keys); nobody reads or writes anyone
 * else's; and the file re-runs without changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from './db.js';
import { DbError } from './errors.js';
import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import { principalsRepo } from './repositories/index.js';
import { seedDatabase, type SeedConfig, type SeedResult } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, makeContext, type TestDatabase } from './testing/test-database.js';

const WELCOME = MIGRATIONS.find((m) => m.version === '0029_veir_welcome_persona');
const BEFORE = MIGRATIONS.filter((m) => m.version < '0029');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };
const PERSONA = '7c8d9e0f-1a2b-4c3d-8e4f-6a7b8c9d0e08';

let t: TestDatabase;
let seed: SeedResult;
let readBefore: string;

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

const ctx = (key: string) => makeContext(must(seed.principals[key]), seed.tenantId);
const lead = () => makeContext(must(seed.programLeadId), seed.tenantId);
const key = (n: number, presentation: 'twin' | 'mentor' = 'mentor') =>
  `${PERSONA.slice(0, -2)}${String(n).padStart(2, '0')}:${presentation}`;

/** app functions with their grants, and principals' columns and app_rls column privileges: equal after a re-run. */
async function schemaFingerprint(db: Db): Promise<string> {
  return db.system(async (sx) => {
    const parts: unknown[] = [];
    for (const sql of [
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src,
                coalesce(array_to_string(p.proacl, ','), '') AS acl
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' ORDER BY 1, 2`,
      `SELECT column_name, privilege_type FROM information_schema.column_privileges
          WHERE table_schema = 'public' AND table_name = 'principals' AND grantee = 'app_rls' ORDER BY 1, 2`,
      `SELECT column_name, data_type, column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'principals' ORDER BY 1`,
    ]) {
      parts.push((await sx.query(sql)).rows);
    }
    return JSON.stringify(parts);
  });
}

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  await migrate(t.db, { migrations: BEFORE });
  seed = await seedDatabase(t.db, CONFIG);
  // Maya read the single welcome of 0016 before the upgrade ("Meet Corin's vEIR").
  readBefore = must(
    await t.db.withContext(ctx('maya'), (tx) => principalsRepo.acknowledgeVeirWelcome(tx)),
  ).acknowledgedAt;
}, 120_000);
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0029_veir_welcome_persona', () => {
  it('applies cleanly on top of the earlier migrations with existing data, as the non-superuser owner', async () => {
    const report = await migrate(t.db);
    expect(report.applied).toEqual(MIGRATIONS.map((m) => m.version).filter((v) => v >= '0029'));
    expect(report.applied[0]).toBe('0029_veir_welcome_persona');
    expect(WELCOME && splitStatements(WELCOME.sql).length).toBeGreaterThanOrEqual(7);
  });

  it('starts everyone with no introduction read, and keeps the single acknowledgement of 0016', async () => {
    const r = await t.db.system((sx) =>
      sx.query(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE cardinality(veir_welcome_introductions) > 0)::int AS read
           FROM principals`,
      ),
    );
    expect(r.rows[0]).toMatchObject({ read: 0 });
    const maya = ctx('maya');
    expect(await t.db.withContext(maya, (tx) => principalsRepo.veirWelcomeIntroductions(tx))).toEqual([]);
    expect(await t.db.withContext(maya, (tx) => principalsRepo.veirWelcomeAcknowledgedAt(tx))).toBe(
      readBefore,
    );
  });

  it('adds each introduction once, for the person only, and says when one was new', async () => {
    const maya = ctx('maya');
    const thomas = must(
      await t.db.withContext(maya, (tx) => principalsRepo.acknowledgeVeirIntroductions(tx, [key(1)])),
    );
    // New (Thomas), so audited; the first acknowledgement keeps its time.
    expect(thomas).toEqual({ acknowledgedAt: readBefore, firstTime: true });
    const again = must(
      await t.db.withContext(maya, (tx) => principalsRepo.acknowledgeVeirIntroductions(tx, [key(1), key(1)])),
    );
    expect(again).toEqual({ acknowledgedAt: readBefore, firstTime: false });
    expect(await t.db.withContext(maya, (tx) => principalsRepo.veirWelcomeIntroductions(tx))).toEqual([
      key(1),
    ]);
    // Someone who never read a welcome: the first acknowledgement is set, and counts as new even with no mentor.
    const devin = ctx('devin');
    const none = must(
      await t.db.withContext(devin, (tx) => principalsRepo.acknowledgeVeirIntroductions(tx, [])),
    );
    expect(none.firstTime).toBe(true);
    expect(await t.db.withContext(devin, (tx) => principalsRepo.veirWelcomeIntroductions(tx))).toEqual([]);
    expect(
      must(await t.db.withContext(devin, (tx) => principalsRepo.acknowledgeVeirIntroductions(tx, [])))
        .firstTime,
    ).toBe(false);
    // Others are untouched; without a request principal nothing is set.
    expect(await t.db.withContext(lead(), (tx) => principalsRepo.veirWelcomeIntroductions(tx))).toEqual([]);
    expect(await t.db.system((sx) => principalsRepo.acknowledgeVeirIntroductions(sx, [key(2)]))).toBeNull();
    const stored = await t.db.system((sx) =>
      sx.query('SELECT id FROM principals WHERE cardinality(veir_welcome_introductions) > 0'),
    );
    expect(stored.rows.map((row) => row.id)).toEqual([maya.principalId]);
  });

  it('keeps the 20 newest and refuses keys that are not a persona and a presentation', async () => {
    const maya = ctx('maya');
    for (let n = 2; n <= 22; n += 4) {
      await t.db.withContext(maya, (tx) =>
        principalsRepo.acknowledgeVeirIntroductions(tx, [key(n), key(n + 1), key(n + 2), key(n + 3)]),
      );
    }
    const kept = await t.db.withContext(maya, (tx) => principalsRepo.veirWelcomeIntroductions(tx));
    expect(kept).toHaveLength(20);
    expect(kept.at(-1)).toBe(key(25));
    expect(kept).not.toContain(key(1));
    for (const bad of [['Thomas'], [`${PERSONA}:guide`], [`${PERSONA.toUpperCase()}:mentor`], [PERSONA]]) {
      expect(
        await sqlState(t.db.withContext(maya, (tx) => principalsRepo.acknowledgeVeirIntroductions(tx, bad))),
      ).toBe('22023');
    }
    const many = Array.from({ length: 21 }, (_, n) => key(n, 'twin'));
    expect(
      await sqlState(t.db.withContext(maya, (tx) => principalsRepo.acknowledgeVeirIntroductions(tx, many))),
    ).toBe('22023');
  });

  it('closes the column itself to app_rls: nobody reads or writes another person’s introductions', async () => {
    const mayaId = must(seed.principals.maya);
    const read = `SELECT veir_welcome_introductions FROM principals WHERE id = :id`;
    const write = `UPDATE principals SET veir_welcome_introductions = '{}' WHERE id = :id`;
    for (const who of [ctx('maya'), ctx('devin'), lead()]) {
      expect(await sqlState(t.db.withContext(who, (tx) => tx.query(read, { id: p.uuid(mayaId) })))).toBe(
        '42501',
      );
      expect(await sqlState(t.db.withContext(who, (tx) => tx.query(write, { id: p.uuid(mayaId) })))).toBe(
        '42501',
      );
    }
    // The previous code's reads of principals keep working.
    await t.db.withContext(ctx('maya'), async (tx) => {
      expect((await principalsRepo.getPrincipal(tx, mayaId))?.displayName).toBe('Maya Okafor-Lindqvist');
    });
  });

  it('is idempotent: re-running every statement, then the runner, changes nothing', async () => {
    if (!WELCOME) throw new Error('0029 missing');
    const before = await schemaFingerprint(t.db);
    const kept = await t.db.withContext(ctx('maya'), (tx) => principalsRepo.veirWelcomeIntroductions(tx));
    await t.db.system(async (sx) => {
      for (const statement of splitStatements(WELCOME.sql)) await sx.query(statement);
    });
    expect(await schemaFingerprint(t.db)).toBe(before);
    expect((await migrate(t.db)).applied).toEqual([]);
    expect(await t.db.withContext(ctx('maya'), (tx) => principalsRepo.veirWelcomeIntroductions(tx))).toEqual(
      kept,
    );
  });
});
