/**
 * Migration 0016 (the vEIR's presence) on top of the schema production has, with people and consents the previous
 * code wrote: it applies cleanly as the non-superuser owner; consents may now cover `first_person` (and nothing
 * unknown), the seed extends its own fictional EIRs' consents once and never a revoked one, a persona's presence
 * reads the scope; everyone starts with the welcome unacknowledged, a person reads and sets only their own value
 * (nobody reads or writes anyone else's), and the file re-runs without changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from './db.js';
import { DbError } from './errors.js';
import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import { assignmentsRepo, personasRepo, principalsRepo } from './repositories/index.js';
import { seedDatabase, type SeedConfig, type SeedResult } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, makeContext, type TestDatabase } from './testing/test-database.js';

const PRESENCE = MIGRATIONS.find((m) => m.version === '0016_veir_presence');
const BEFORE = MIGRATIONS.filter((m) => m.version < '0016');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };

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
const corin = () => must(seed.veirs.find((v) => v.eirKey === 'eir-corin'));
const ruth = () => must(seed.veirs.find((v) => v.eirKey === 'eir-ruth'));

async function assetsOf(consentId: string): Promise<string[]> {
  const r = await t.db.system((sx) =>
    sx.query('SELECT asset_types FROM consents WHERE id = :id', { id: p.uuid(consentId) }),
  );
  return r.rows[0]?.asset_types as string[];
}

/** The consent check, app functions with their grants, and principals' column privileges: equal after a re-run. */
async function schemaFingerprint(db: Db): Promise<string> {
  return db.system(async (sx) => {
    const parts: unknown[] = [];
    for (const sql of [
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'public.consents'::regclass ORDER BY conname`,
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS src,
                coalesce(array_to_string(p.proacl, ','), '') AS acl
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' ORDER BY 1, 2`,
      `SELECT column_name, privilege_type FROM information_schema.column_privileges
          WHERE table_schema = 'public' AND table_name = 'principals' AND grantee = 'app_rls' ORDER BY 1, 2`,
      `SELECT column_name, data_type FROM information_schema.columns
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
  // A consent revoked in the product before the upgrade (Ruth's), which the seed must leave alone.
  await t.db.system((sx) =>
    sx.query('UPDATE consents SET revoked_at = now() WHERE id = :id', { id: p.uuid(ruth().consentId) }),
  );
}, 120_000);
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0016_veir_presence', () => {
  it('applies cleanly on top of the earlier migrations with existing data, as the non-superuser owner', async () => {
    expect(await assetsOf(corin().consentId)).toEqual(['doctrine', 'style', 'voice', 'cases']);
    const report = await migrate(t.db);
    // Later migrations follow in the same run (their own suites cover them).
    expect(report.applied).toEqual(MIGRATIONS.map((m) => m.version).filter((v) => v >= '0016'));
    expect(report.applied[0]).toBe('0016_veir_presence');
    expect(PRESENCE && splitStatements(PRESENCE.sql).length).toBeGreaterThanOrEqual(8);
  });

  it('lets a consent cover first_person, and still nothing unknown', async () => {
    const insert = (assets: string) =>
      t.db.system((sx) =>
        sx.query(
          `INSERT INTO consents (tenant_id, subject_principal_id, asset_types)
           VALUES (:t, :s, ${assets})`,
          { t: p.uuid(seed.tenantId), s: p.uuid(must(seed.principals['eir-corin'])) },
        ),
      );
    expect(await sqlState(insert(`ARRAY['doctrine', 'first_person']`))).toBeNull();
    expect(await sqlState(insert(`ARRAY['doctrine', 'portrait']`))).toBe('23514');
  });

  it('extends the seed’s own fictional consents once on the next seed run, never a revoked one', async () => {
    await seedDatabase(t.db, CONFIG);
    expect(await assetsOf(corin().consentId)).toEqual([
      'doctrine',
      'style',
      'voice',
      'cases',
      'first_person',
    ]);
    expect(await assetsOf(ruth().consentId)).toEqual(['doctrine', 'style', 'voice', 'cases']);
    await seedDatabase(t.db, CONFIG);
    expect(await assetsOf(corin().consentId)).toEqual([
      'doctrine',
      'style',
      'voice',
      'cases',
      'first_person',
    ]);
  });

  it('reads a persona’s presence: the first-person scope and whether its EIR is the venture’s', async () => {
    const quietquad = must(seed.ventures.find((v) => v.key === 'quietquad'));
    const emberloop = must(seed.ventures.find((v) => v.key === 'emberloop'));
    const presence = await t.db.withContext(ctx('maya'), async (tx) => {
      const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, quietquad.id));
      return personasRepo.getPersonaPresence(tx, {
        personaId: resolved.persona.id,
        assignedEirProfileId: resolved.eir?.id ?? null,
      });
    });
    expect(presence).toEqual({ eirName: 'Corin Halvorsen', firstPerson: true, eirSeesWork: true });
    // Another EIR assigned to review the venture: the persona's EIR does not see its work.
    const elsewhere = await t.db.withContext(ctx('maya'), (tx) =>
      personasRepo.getPersonaPresence(tx, { personaId: corin().personaId, assignedEirProfileId: null }),
    );
    expect(elsewhere.eirSeesWork).toBe(false);
    // Ruth's consent was revoked: no first-person presentation (and no consent in force at all).
    const revoked = await t.db.withContext(lead(), async (tx) => {
      const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, emberloop.id));
      return personasRepo.getPersonaPresence(tx, {
        personaId: resolved.persona.id,
        assignedEirProfileId: resolved.eir?.id ?? null,
      });
    });
    expect(revoked.firstPerson).toBe(false);
    // The neutral guide is no one's twin.
    const guide = await t.db.withContext(lead(), (tx) =>
      personasRepo.getPersonaPresence(tx, { personaId: seed.personaId, assignedEirProfileId: null }),
    );
    expect(guide).toEqual({ eirName: null, firstPerson: false, eirSeesWork: false });
  });

  it('starts everyone with the welcome unacknowledged', async () => {
    const r = await t.db.system((sx) =>
      sx.query(
        'SELECT count(*)::int AS n, count(veir_welcome_acknowledged_at)::int AS acknowledged FROM principals',
      ),
    );
    expect(r.rows[0]).toMatchObject({ acknowledged: 0 });
    expect(Number(r.rows[0]?.n)).toBeGreaterThan(5);
  });

  it('lets a person read and set only their own welcome, once', async () => {
    const maya = ctx('maya');
    expect(await t.db.withContext(maya, (tx) => principalsRepo.veirWelcomeAcknowledgedAt(tx))).toBeNull();
    const first = must(await t.db.withContext(maya, (tx) => principalsRepo.acknowledgeVeirWelcome(tx)));
    expect(first.firstTime).toBe(true);
    const again = must(await t.db.withContext(maya, (tx) => principalsRepo.acknowledgeVeirWelcome(tx)));
    expect(again).toEqual({ acknowledgedAt: first.acknowledgedAt, firstTime: false });
    expect(await t.db.withContext(maya, (tx) => principalsRepo.veirWelcomeAcknowledgedAt(tx))).toBe(
      first.acknowledgedAt,
    );
    expect(
      await t.db.withContext(ctx('devin'), (tx) => principalsRepo.veirWelcomeAcknowledgedAt(tx)),
    ).toBeNull();
    expect(await t.db.withContext(lead(), (tx) => principalsRepo.veirWelcomeAcknowledgedAt(tx))).toBeNull();
    // The call notice (0010) is a separate answer.
    expect(await t.db.withContext(maya, (tx) => principalsRepo.callNoticeAcknowledgedAt(tx))).toBeNull();
    expect(await t.db.system((sx) => principalsRepo.acknowledgeVeirWelcome(sx))).toBeNull();
    const stored = await t.db.system((sx) =>
      sx.query('SELECT id FROM principals WHERE veir_welcome_acknowledged_at IS NOT NULL'),
    );
    expect(stored.rows.map((row) => row.id)).toEqual([maya.principalId]);
  });

  it('closes the column itself to app_rls: nobody reads or writes another person’s value', async () => {
    const mayaId = must(seed.principals.maya);
    const read = `SELECT veir_welcome_acknowledged_at FROM principals WHERE id = :id`;
    const write = `UPDATE principals SET veir_welcome_acknowledged_at = NULL WHERE id = :id`;
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
    if (!PRESENCE) throw new Error('0016 missing');
    const before = await schemaFingerprint(t.db);
    await t.db.system(async (sx) => {
      for (const statement of splitStatements(PRESENCE.sql)) await sx.query(statement);
    });
    expect(await schemaFingerprint(t.db)).toBe(before);
    expect((await migrate(t.db)).applied).toEqual([]);
    const kept = await t.db.withContext(ctx('maya'), (tx) => principalsRepo.veirWelcomeAcknowledgedAt(tx));
    expect(kept).not.toBeNull();
    expect(await assetsOf(corin().consentId)).toContain('first_person');
  });
});
