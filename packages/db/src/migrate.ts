import { createHash } from 'node:crypto';

import { col, row } from './columns.js';
import { type Db } from './db.js';
import { MigrationChecksumError, SqlUsageError } from './errors.js';
import { all } from './executor.js';
import { MIGRATIONS } from './migrations/bundle.generated.js';
import { type Migration } from './migrations/types.js';
import { p } from './params.js';
import { splitStatements } from './sql-lexer.js';

export { MIGRATIONS } from './migrations/bundle.generated.js';
export { type Migration } from './migrations/types.js';

/** Session-independent key for pg_advisory_xact_lock (app.append_audit uses 7012026). */
export const MIGRATION_LOCK_KEY = 7_012_025;

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
)`;

export interface MigrationEvent {
  readonly type: 'applied' | 'already_applied';
  readonly version: string;
  readonly statements?: number;
  readonly durationMs?: number;
}

export interface MigrateOptions {
  /** Defaults to the generated bundle. */
  readonly migrations?: readonly Migration[];
  /** Progress callback (versions and counts only). */
  readonly onEvent?: (event: MigrationEvent) => void;
}

export interface MigrationReport {
  /** Versions applied by this run, in order. */
  readonly applied: readonly string[];
  /** Versions already present before this run. */
  readonly alreadyApplied: readonly string[];
  /** Versions recorded in the database that this build does not know (database is ahead of the code). */
  readonly unknown: readonly string[];
}

const appliedRow = row({ version: col.text, checksum: col.text });

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Applies pending migrations in version order. Each migration runs in its own transaction, as the
 * owner role, holding a transaction-scoped advisory lock, so concurrent runners serialise and every
 * runner re-reads the applied set under the lock. Checksums of applied migrations are verified on every
 * run; a mismatch throws {@link MigrationChecksumError} (never auto-repaired). Statements are split and
 * executed one per call, which the RDS Data API requires.
 */
export async function migrate(db: Db, options: MigrateOptions = {}): Promise<MigrationReport> {
  const migrations = [...(options.migrations ?? MIGRATIONS)].sort((a, b) =>
    a.version.localeCompare(b.version),
  );
  for (const m of migrations) {
    if (sha256(m.sql) !== m.checksum) {
      throw new SqlUsageError(
        `bundled migration ${m.version} does not match its checksum; regenerate the bundle`,
      );
    }
  }
  const known = new Set(migrations.map((m) => m.version));
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  let unknown: string[] = [];

  // Always at least one pass so checksums are verified even when nothing is pending.
  for (let index = 0; index <= migrations.length; index += 1) {
    const pending = await db.system(async (sx) => {
      // Wrapped so the result column is an integer, not `void` (which the Data API need not serialise).
      await sx.query('SELECT count(*) AS n FROM (SELECT pg_advisory_xact_lock(:key)) AS l', {
        key: p.bigint(MIGRATION_LOCK_KEY),
      });
      await sx.query(CREATE_TABLE_SQL);
      const rows = await all(
        sx,
        'SELECT version, checksum FROM schema_migrations ORDER BY version',
        {},
        appliedRow,
      );
      const done = new Map(rows.map((r) => [r.version, r.checksum]));
      for (const m of migrations) {
        const checksum = done.get(m.version);
        if (checksum !== undefined && checksum !== m.checksum) {
          throw new MigrationChecksumError(m.version, m.checksum, checksum);
        }
      }
      unknown = rows.map((r) => r.version).filter((v) => !known.has(v));
      const next = migrations.find((m) => !done.has(m.version));
      if (!next) return null;

      const started = Date.now();
      const statements = splitStatements(next.sql);
      for (const statement of statements) await sx.query(statement);
      await sx.query('INSERT INTO schema_migrations (version, checksum) VALUES (:version, :checksum)', {
        version: p.text(next.version),
        checksum: p.text(next.checksum),
      });
      options.onEvent?.({
        type: 'applied',
        version: next.version,
        statements: statements.length,
        durationMs: Date.now() - started,
      });
      return next.version;
    });
    if (pending === null) break;
    applied.push(pending);
  }

  for (const m of migrations) {
    if (!applied.includes(m.version)) {
      alreadyApplied.push(m.version);
      options.onEvent?.({ type: 'already_applied', version: m.version });
    }
  }
  return { applied, alreadyApplied, unknown };
}
