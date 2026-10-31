/**
 * Migration 0019 (per-person video-face access) on top of the schema production has, with people the previous code
 * wrote: it applies cleanly as the non-superuser owner; everyone starts without face access; a person reads only
 * their own value (false once disabled or without a request principal); the column stays closed to app_rls (nobody
 * reads or writes anyone's value through the table), while the owner role sets it within one tenant; and the file
 * re-runs without changes.
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

const ACCESS = MIGRATIONS.find((m) => m.version === '0019_face_access');
const BEFORE = MIGRATIONS.filter((m) => m.version < '0019');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };
const OTHER_TENANT = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

let t: TestDatabase;
let seed: SeedResult;

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

/** The function with its grants, principals' columns and app_rls's column privileges: equal after a re-run. */
async function schemaFingerprint(db: Db): Promise<string> {
  return db.system(async (sx) => {
    const parts: unknown[] = [];
    for (const sql of [
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src,
                p.prosecdef, coalesce(array_to_string(p.proacl, ','), '') AS acl
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' ORDER BY 1, 2`,
      `SELECT column_name, privilege_type FROM information_schema.column_privileges
          WHERE table_schema = 'public' AND table_name = 'principals' AND grantee = 'app_rls' ORDER BY 1, 2`,
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
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
}, 120_000);
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0019_face_access', () => {
  it('applies cleanly on top of the earlier migrations with existing people, as the non-superuser owner', async () => {
    const report = await migrate(t.db);
    // Later migrations follow in the same run (their own suites cover them).
    expect(report.applied).toEqual(MIGRATIONS.map((m) => m.version).filter((v) => v >= '0019'));
    expect(report.applied[0]).toBe('0019_face_access');
    expect(ACCESS && splitStatements(ACCESS.sql).length).toBeGreaterThanOrEqual(4);
  });

  it('starts everyone without face access', async () => {
    const r = await t.db.system((sx) =>
      sx.query(
        'SELECT count(*)::int AS n, count(*) FILTER (WHERE face_access)::int AS granted FROM principals',
      ),
    );
    expect(r.rows[0]).toMatchObject({ granted: 0 });
    expect(Number(r.rows[0]?.n)).toBeGreaterThan(5);
    for (const who of [ctx('maya'), ctx('devin'), lead()]) {
      expect(await t.db.withContext(who, (tx) => principalsRepo.faceAccess(tx))).toBe(false);
    }
  });

  it('lets the owner role set a person’s value within their tenant, and that person read only their own', async () => {
    const mayaId = must(seed.principals.maya);
    const set = (faceAccess: boolean, tenantId = seed.tenantId) =>
      t.db.system((sx) => principalsRepo.setFaceAccess(sx, { principalId: mayaId, tenantId, faceAccess }));
    expect(await set(true)).toEqual({ before: false, after: true });
    expect(await set(true)).toEqual({ before: true, after: true });
    // Another tenant has no such principal.
    expect(await set(false, OTHER_TENANT)).toBeNull();

    expect(await t.db.withContext(ctx('maya'), (tx) => principalsRepo.faceAccess(tx))).toBe(true);
    expect(await t.db.withContext(ctx('devin'), (tx) => principalsRepo.faceAccess(tx))).toBe(false);
    expect(await t.db.withContext(lead(), (tx) => principalsRepo.faceAccess(tx))).toBe(false);
    // Without a request principal there is no "own" value.
    expect(await t.db.system((sx) => principalsRepo.faceAccess(sx))).toBe(false);
    // A principal id under another tenant's context reads nothing.
    expect(
      await t.db.withContext(makeContext(mayaId, OTHER_TENANT), (tx) => principalsRepo.faceAccess(tx)),
    ).toBe(false);
    expect(
      await t.db.system((sx) => principalsRepo.listFaceAccess(sx, [mayaId, must(seed.principals.devin)])),
    ).toEqual([mayaId]);

    // A disabled account has no face access, whatever its value says.
    await t.db.system((sx) =>
      sx.query(`UPDATE principals SET status = 'disabled' WHERE id = :id`, { id: p.uuid(mayaId) }),
    );
    expect(await t.db.withContext(ctx('maya'), (tx) => principalsRepo.faceAccess(tx))).toBe(false);
    await t.db.system((sx) =>
      sx.query(`UPDATE principals SET status = 'active' WHERE id = :id`, { id: p.uuid(mayaId) }),
    );

    expect(await set(false)).toEqual({ before: true, after: false });
    expect(await t.db.withContext(ctx('maya'), (tx) => principalsRepo.faceAccess(tx))).toBe(false);
  });

  it('closes the column itself to app_rls: nobody reads, sets or inserts a value through the table', async () => {
    const mayaId = must(seed.principals.maya);
    const read = `SELECT face_access FROM principals WHERE id = :id`;
    const write = `UPDATE principals SET face_access = true WHERE id = :id`;
    for (const who of [ctx('maya'), ctx('devin'), lead()]) {
      expect(await sqlState(t.db.withContext(who, (tx) => tx.query(read, { id: p.uuid(mayaId) })))).toBe(
        '42501',
      );
      expect(await sqlState(t.db.withContext(who, (tx) => tx.query(write, { id: p.uuid(mayaId) })))).toBe(
        '42501',
      );
    }
    expect(
      await sqlState(
        t.db.withContext(lead(), (tx) =>
          tx.query(`INSERT INTO principals (tenant_id, display_name, face_access) VALUES (:t, 'x', true)`, {
            t: p.uuid(seed.tenantId),
          }),
        ),
      ),
    ).toBe('42501');
    const granted = await t.db.system((sx) =>
      sx.query(
        `SELECT DISTINCT column_name FROM information_schema.column_privileges
          WHERE table_schema = 'public' AND table_name = 'principals' AND grantee = 'app_rls' ORDER BY 1`,
      ),
    );
    expect(granted.rows.map((row) => row.column_name)).not.toContain('face_access');
    // The function is the only way in, and only for app_rls.
    const fn = await t.db.system((sx) =>
      sx.query(
        `SELECT p.prosecdef, has_function_privilege('app_rls', p.oid, 'EXECUTE') AS app_rls,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app' AND p.proname = 'face_access'`,
      ),
    );
    expect(fn.rows).toEqual([{ prosecdef: true, app_rls: true, public: false }]);
    // The previous code's reads of principals keep working.
    await t.db.withContext(ctx('maya'), async (tx) => {
      expect((await principalsRepo.getPrincipal(tx, mayaId))?.displayName).toBe('Maya Okafor-Lindqvist');
    });
  });

  it('is idempotent: re-running every statement, then the runner, changes nothing', async () => {
    if (!ACCESS) throw new Error('0019 missing');
    await t.db.system((sx) =>
      principalsRepo.setFaceAccess(sx, {
        principalId: must(seed.principals.maya),
        tenantId: seed.tenantId,
        faceAccess: true,
      }),
    );
    const before = await schemaFingerprint(t.db);
    await t.db.system(async (sx) => {
      for (const statement of splitStatements(ACCESS.sql)) await sx.query(statement);
    });
    expect(await schemaFingerprint(t.db)).toBe(before);
    expect((await migrate(t.db)).applied).toEqual([]);
    // A value set before the re-run is kept.
    expect(await t.db.withContext(ctx('maya'), (tx) => principalsRepo.faceAccess(tx))).toBe(true);
  });
});
