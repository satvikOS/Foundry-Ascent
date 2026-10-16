/**
 * Migration 0010 (the first-call privacy notice) on top of the schema production has, with people the previous
 * code wrote: it applies cleanly as the non-superuser owner, everyone starts unacknowledged, a person reads and
 * sets only their own value (staff included: nobody reads or writes anyone else's), the previous code's reads and
 * writes of principals keep working, and the file re-runs without changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from './db.js';
import { DbError } from './errors.js';
import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import { principalsRepo, venturesRepo } from './repositories/index.js';
import { seedDatabase, type SeedConfig, type SeedResult } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, makeContext, type TestDatabase } from './testing/test-database.js';

const NOTICE = MIGRATIONS.find((m) => m.version === '0010_call_notice');
const BEFORE = MIGRATIONS.filter((m) => m.version < '0010');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };

let t: TestDatabase;
let seed: SeedResult;
/** A person created through the previous code (a program lead's invitation), before the migration. */
let invitedId: string;

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

/** Policies, app functions with their grants, and the column privileges of principals: equal after a re-run. */
async function schemaFingerprint(db: Db): Promise<string> {
  return db.system(async (sx) => {
    const parts: unknown[] = [];
    for (const sql of [
      `SELECT tablename, policyname, cmd, coalesce(qual, '') AS qual, coalesce(with_check, '') AS with_check
           FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`,
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src,
                coalesce(array_to_string(p.proacl, ','), '') AS acl
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' ORDER BY 1, 2`,
      `SELECT column_name, privilege_type FROM information_schema.column_privileges
          WHERE table_schema = 'public' AND table_name = 'principals' AND grantee = 'app_rls' ORDER BY 1, 2`,
      `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND table_name = 'principals' AND grantee = 'app_rls' ORDER BY 1`,
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
  invitedId = (
    await t.db.withContext(lead(), (tx) =>
      principalsRepo.createPrincipal(tx, {
        tenantId: seed.tenantId,
        displayName: 'Invited Before',
        title: 'Team (synthetic)',
        synthetic: true,
      }),
    )
  ).id;
});
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0010_call_notice', () => {
  it('applies cleanly on top of the earlier migrations with existing people, as the non-superuser owner', async () => {
    const report = await migrate(t.db);
    expect(report.applied).toEqual(['0010_call_notice']);
    expect(NOTICE && splitStatements(NOTICE.sql).length).toBeGreaterThanOrEqual(10);
  });

  it('starts everyone unacknowledged', async () => {
    const r = await t.db.system((sx) =>
      sx.query(
        'SELECT count(*)::int AS n, count(call_notice_acknowledged_at)::int AS acknowledged FROM principals',
      ),
    );
    expect(r.rows[0]).toMatchObject({ acknowledged: 0 });
    expect(Number(r.rows[0]?.n)).toBeGreaterThan(5);
  });

  it('lets a person read and set only their own value, once', async () => {
    const maya = ctx('maya');
    expect(await t.db.withContext(maya, (tx) => principalsRepo.callNoticeAcknowledgedAt(tx))).toBeNull();
    const first = must(await t.db.withContext(maya, (tx) => principalsRepo.acknowledgeCallNotice(tx)));
    expect(first.firstTime).toBe(true);
    const again = must(await t.db.withContext(maya, (tx) => principalsRepo.acknowledgeCallNotice(tx)));
    expect(again).toEqual({ acknowledgedAt: first.acknowledgedAt, firstTime: false });
    expect(await t.db.withContext(maya, (tx) => principalsRepo.callNoticeAcknowledgedAt(tx))).toBe(
      first.acknowledgedAt,
    );
    // Another person of the same venture, and staff, still have their own (unset) value.
    expect(
      await t.db.withContext(ctx('devin'), (tx) => principalsRepo.callNoticeAcknowledgedAt(tx)),
    ).toBeNull();
    expect(await t.db.withContext(lead(), (tx) => principalsRepo.callNoticeAcknowledgedAt(tx))).toBeNull();
    // Nothing is acknowledged without a request principal (the system executor).
    expect(await t.db.system((sx) => principalsRepo.acknowledgeCallNotice(sx))).toBeNull();
    const stored = await t.db.system((sx) =>
      sx.query('SELECT id FROM principals WHERE call_notice_acknowledged_at IS NOT NULL'),
    );
    expect(stored.rows.map((row) => row.id)).toEqual([maya.principalId]);
  });

  it('closes the column itself to app_rls: nobody reads or writes another person’s value', async () => {
    const mayaId = must(seed.principals.maya);
    const read = `SELECT call_notice_acknowledged_at FROM principals WHERE id = :id`;
    const write = `UPDATE principals SET call_notice_acknowledged_at = NULL WHERE id = :id`;
    // Not even one's own row directly (only through the functions), nor a program lead on anyone's.
    for (const who of [ctx('maya'), ctx('devin'), lead()]) {
      expect(await sqlState(t.db.withContext(who, (tx) => tx.query(read, { id: p.uuid(mayaId) })))).toBe(
        '42501',
      );
      expect(await sqlState(t.db.withContext(who, (tx) => tx.query(write, { id: p.uuid(mayaId) })))).toBe(
        '42501',
      );
      expect(
        await sqlState(t.db.withContext(who, (tx) => tx.query('SELECT * FROM principals LIMIT 1'))),
      ).toBe('42501');
    }
    // A program lead creating a person cannot set it either.
    expect(
      await sqlState(
        t.db.withContext(lead(), (tx) =>
          tx.query(
            `INSERT INTO principals (tenant_id, display_name, call_notice_acknowledged_at) VALUES (:t, 'x', now())`,
            { t: p.uuid(seed.tenantId) },
          ),
        ),
      ),
    ).toBe('42501');
    const stillSet = await t.db.system((sx) =>
      sx.query('SELECT call_notice_acknowledged_at IS NOT NULL AS set FROM principals WHERE id = :id', {
        id: p.uuid(mayaId),
      }),
    );
    expect(stillSet.rows[0]).toEqual({ set: true });
  });

  it('keeps the previous code working: people are read, listed, created and updated as before', async () => {
    const maya = ctx('maya');
    await t.db.withContext(maya, async (tx) => {
      expect((await principalsRepo.getPrincipal(tx, invitedId))?.displayName).toBe('Invited Before');
      const listed = await principalsRepo.listPrincipals(tx, { tenantId: seed.tenantId });
      expect(listed.map((row) => row.id)).toContain(maya.principalId);
      const quietquad = must(seed.ventures.find((v) => v.key === 'quietquad'));
      const team = await venturesRepo.listTeam(tx, quietquad.id);
      expect(team.map((m) => m.principal.displayName)).toContain('Maya Okafor-Lindqvist');
      const count = await tx.query('SELECT count(*)::int AS n FROM principals');
      expect(Number(count.rows[0]?.n)).toBeGreaterThan(5);
    });
    await t.db.withContext(lead(), async (tx) => {
      const created = await principalsRepo.createPrincipal(tx, {
        tenantId: seed.tenantId,
        displayName: 'Invited After',
        synthetic: true,
      });
      const renamed = await principalsRepo.updatePrincipal(tx, created.id, { title: 'Founder (synthetic)' });
      expect(renamed?.title).toBe('Founder (synthetic)');
      expect((await principalsRepo.updatePrincipal(tx, invitedId, { status: 'disabled' }))?.status).toBe(
        'disabled',
      );
    });
  });

  it('is idempotent: re-running every statement, then the runner, changes nothing', async () => {
    if (!NOTICE) throw new Error('0010 missing');
    const before = await schemaFingerprint(t.db);
    await t.db.system(async (sx) => {
      for (const statement of splitStatements(NOTICE.sql)) await sx.query(statement);
    });
    expect(await schemaFingerprint(t.db)).toBe(before);
    expect((await migrate(t.db)).applied).toEqual([]);
    const kept = await t.db.withContext(ctx('maya'), (tx) => principalsRepo.callNoticeAcknowledgedAt(tx));
    expect(kept).not.toBeNull();
  });
});
