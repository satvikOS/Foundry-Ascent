import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MigrationChecksumError } from './errors.js';
import { MIGRATIONS, migrate, type MigrationEvent } from './migrate.js';
import { p } from './params.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.cleanup();
});

describe('migrate', () => {
  it('applies all bundled migrations as a non-superuser, then is a no-op', async () => {
    expect(t.migrations?.applied).toEqual(['0001_init', '0002_rls_helpers']);
    const role = await t.db.system((sx) =>
      sx.query('SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user'),
    );
    expect(role.rows[0]).toMatchObject({ rolsuper: false, rolcreaterole: true });
    const events: MigrationEvent[] = [];
    const again = await migrate(t.db, { onEvent: (e) => events.push(e) });
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toEqual(['0001_init', '0002_rls_helpers']);
    expect(again.unknown).toEqual([]);
    expect(events.every((e) => e.type === 'already_applied')).toBe(true);
    const rows = await t.db.system((sx) =>
      sx.query('SELECT version, checksum FROM schema_migrations ORDER BY version'),
    );
    expect(rows.rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version, checksum: m.checksum })));
  });

  it('serialises concurrent runners on a fresh database', async () => {
    const fresh = await createTestDatabase({ migrate: false });
    try {
      const [a, b] = await Promise.all([migrate(fresh.db), migrate(fresh.db)]);
      expect([...a.applied, ...b.applied].sort()).toEqual(MIGRATIONS.map((m) => m.version).sort());
      const n = await fresh.db.system((sx) => sx.query('SELECT count(*) AS n FROM schema_migrations'));
      expect(Number(n.rows[0]?.n)).toBe(MIGRATIONS.length);
    } finally {
      await fresh.cleanup();
    }
  });

  it('refuses to run when an applied migration no longer matches the bundle', async () => {
    const first = MIGRATIONS[0];
    if (!first) throw new Error('no migrations');
    await t.db.system((sx) =>
      sx.query(`UPDATE schema_migrations SET checksum = 'tampered' WHERE version = :v`, {
        v: p.text(first.version),
      }),
    );
    await expect(migrate(t.db)).rejects.toBeInstanceOf(MigrationChecksumError);
    await t.db.system((sx) =>
      sx.query('UPDATE schema_migrations SET checksum = :c WHERE version = :v', {
        v: p.text(first.version),
        c: p.text(first.checksum),
      }),
    );
    await expect(migrate(t.db)).resolves.toMatchObject({ applied: [] });
  });

  it('reports versions the database has but the build does not know', async () => {
    await t.db.system((sx) =>
      sx.query(`INSERT INTO schema_migrations (version, checksum) VALUES ('9999_future', 'x')`),
    );
    const report = await migrate(t.db);
    expect(report.unknown).toEqual(['9999_future']);
    await t.db.system((sx) => sx.query(`DELETE FROM schema_migrations WHERE version = '9999_future'`));
  });

  it('applies a migration with $$ bodies, comments and literal semicolons one statement at a time', async () => {
    const sql = [
      '-- comment; with a semicolon',
      'CREATE TABLE mig_probe (id int PRIMARY KEY, note text);',
      "INSERT INTO mig_probe VALUES (1, 'a;b'), (2, $q$c;d$q$);",
      '/* block; comment */',
      'CREATE FUNCTION mig_probe_fn() RETURNS bigint LANGUAGE plpgsql AS $$',
      'BEGIN',
      '  PERFORM 1; -- inner ; comment',
      "  RETURN (SELECT count(*) FROM mig_probe WHERE note LIKE '%;%');",
      'END',
      '$$;',
    ].join('\n');
    const extra = { version: '9000_probe', sql, checksum: createHash('sha256').update(sql).digest('hex') };
    const report = await migrate(t.db, { migrations: [...MIGRATIONS, extra] });
    expect(report.applied).toEqual(['9000_probe']);
    const r = await t.db.system((sx) => sx.query('SELECT mig_probe_fn() AS n'));
    expect(Number(r.rows[0]?.n)).toBe(2);
  });

  it('rejects a bundle whose checksum does not match its SQL', async () => {
    const bad = { version: '9001_bad', sql: 'SELECT 1', checksum: 'nope' };
    await expect(migrate(t.db, { migrations: [...MIGRATIONS, bad] })).rejects.toThrow(
      /does not match its checksum/,
    );
  });
});
