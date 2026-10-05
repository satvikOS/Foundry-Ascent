import { randomBytes } from 'node:crypto';

import pg from 'pg';

import { createDb, type Db, type DbContext } from '../db.js';
import { migrate, type MigrationReport } from '../migrate.js';
import { accessCodePrefix, generateAccessCode, hashAccessCode } from '../seed/access-code.js';
import { seedDatabase, type SeedConfig, type SeedResult } from '../seed/seed.js';

/** Local default: the PostgreSQL 16 + pgvector cluster used in development (unix socket, trust auth). */
export const DEFAULT_TEST_ADMIN_URL = 'postgresql://postgres@localhost/postgres?host=/var/tmp&port=54329';

/** Non-superuser role that owns test databases and runs migrations (mirrors Aurora's master user). */
export const TEST_OWNER_ROLE = 'fa_master';
export const TEST_OWNER_PASSWORD = 'fa_master';
const BOOTSTRAP_LOCK_KEY = 7_012_099;
const NAME_PREFIX = 'fa_t_';
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export interface TestDatabase {
  /** Facade connected as the non-superuser owner role (system executor = owner, withContext = app_rls). */
  readonly db: Db;
  /** Connection URL of the owner role for this database. */
  readonly url: string;
  /** Superuser URL for this database (extensions, inspection). */
  readonly adminUrl: string;
  readonly name: string;
  readonly migrations: MigrationReport | null;
  /** Seed result when created with `seed` (ids of tenant, people, ventures, canaries). */
  readonly seed: SeedResult | null;
  /** Plaintext owner access code generated for the seeded owner (tests only). */
  readonly ownerAccessCode: string | null;
  /** Closes the pool and drops the database. */
  cleanup(): Promise<void>;
}

export interface CreateTestDatabaseOptions {
  /** Run migrations (default true). */
  readonly migrate?: boolean;
  /**
   * Seed synthetic data after migrating: `true` uses tenant `ain` and a freshly generated owner code;
   * an object overrides parts of the seed configuration.
   */
  readonly seed?: boolean | Partial<SeedConfig>;
  /** Superuser URL; defaults to TEST_DATABASE_ADMIN_URL, then {@link DEFAULT_TEST_ADMIN_URL}. */
  readonly adminUrl?: string;
}

/** Request context for tests: `withContext(makeContext(principalId, tenantId), …)`. */
export function makeContext(
  principalId: string,
  tenantId: string,
  requestId = `test-${randomBytes(4).toString('hex')}`,
): DbContext {
  return { principalId, tenantId, requestId };
}

export function testAdminUrl(): string {
  return process.env.TEST_DATABASE_ADMIN_URL ?? DEFAULT_TEST_ADMIN_URL;
}

/** Replaces the database (and optionally the credentials) of a postgres:// URL. */
export function withDatabase(
  url: string,
  database: string,
  user?: { name: string; password?: string },
): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user) {
    u.username = encodeURIComponent(user.name);
    u.password = user.password ? encodeURIComponent(user.password) : '';
  }
  return u.toString();
}

export function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('unsafe identifier');
  return `"${name}"`;
}

/** Runs `fn` with a single short-lived client. */
export async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Cluster bootstrap, serialised across parallel test workers: the owner role (LOGIN CREATEROLE CREATEDB,
 * no superuser) and the cluster-wide `app_rls` role created *by the owner role* so it holds ADMIN OPTION
 * exactly as Aurora's master user does after the first migration. Also drops stale test databases.
 */
export async function bootstrapCluster(admin: pg.Client): Promise<void> {
  await admin.query('SELECT pg_advisory_lock($1)', [BOOTSTRAP_LOCK_KEY]);
  try {
    const owner = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [TEST_OWNER_ROLE]);
    if (owner.rowCount === 0) {
      await admin.query(
        `CREATE ROLE ${quoteIdent(TEST_OWNER_ROLE)} LOGIN CREATEROLE CREATEDB NOSUPERUSER PASSWORD '${TEST_OWNER_PASSWORD}'`,
      );
    }
    const appRls = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'app_rls'");
    if (appRls.rowCount === 0) {
      await admin.query(`SET ROLE ${quoteIdent(TEST_OWNER_ROLE)}`);
      await admin.query('CREATE ROLE app_rls NOLOGIN NOBYPASSRLS');
      await admin.query('RESET ROLE');
    }
    const member = await admin.query(
      `SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
       WHERE r.rolname = 'app_rls' AND u.rolname = $1 AND m.set_option`,
      [TEST_OWNER_ROLE],
    );
    if (member.rowCount === 0) {
      await admin.query(`SET ROLE ${quoteIdent(TEST_OWNER_ROLE)}`);
      await admin.query(`GRANT app_rls TO ${quoteIdent(TEST_OWNER_ROLE)}`);
      await admin.query('RESET ROLE');
    }
    const stale = await admin.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname LIKE $1',
      [`${NAME_PREFIX}%`],
    );
    for (const { datname } of stale.rows) {
      const created = Number.parseInt(datname.slice(NAME_PREFIX.length).split('_')[0] ?? '', 36);
      if (Number.isFinite(created) && Date.now() - created > STALE_AFTER_MS) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(datname)} WITH (FORCE)`);
      }
    }
  } finally {
    await admin.query('SELECT pg_advisory_unlock($1)', [BOOTSTRAP_LOCK_KEY]);
  }
}

/**
 * Creates a fresh database for one test file: the superuser creates the database (owned by the
 * non-superuser `fa_master`) and the `vector`/`pgcrypto` extensions; migrations then run as `fa_master`
 * through the same code path as production. Honours TEST_DATABASE_ADMIN_URL (CI service container).
 */
export async function createTestDatabase(options: CreateTestDatabaseOptions = {}): Promise<TestDatabase> {
  const adminUrl = options.adminUrl ?? testAdminUrl();
  const name = `${NAME_PREFIX}${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;

  await withClient(adminUrl, async (admin) => {
    await bootstrapCluster(admin);
    await admin.query(`CREATE DATABASE ${quoteIdent(name)} OWNER ${quoteIdent(TEST_OWNER_ROLE)}`);
  });
  const dbAdminUrl = withDatabase(adminUrl, name);
  await withClient(dbAdminUrl, async (admin) => {
    await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  });

  const url = withDatabase(adminUrl, name, { name: TEST_OWNER_ROLE, password: TEST_OWNER_PASSWORD });
  const db = createDb({ driver: 'pg', connectionString: url, max: 4 });
  let migrations: MigrationReport | null = null;
  let seed: SeedResult | null = null;
  let ownerAccessCode: string | null = null;
  try {
    if (options.migrate !== false) migrations = await migrate(db);
    if (options.seed) {
      const overrides = options.seed === true ? {} : options.seed;
      let owner = overrides.owner;
      if (owner === undefined) {
        ownerAccessCode = generateAccessCode();
        owner = {
          displayName: 'Test Owner',
          accessCodePrefix: accessCodePrefix(ownerAccessCode),
          accessCodeHash: await hashAccessCode(ownerAccessCode),
        };
      }
      seed = await seedDatabase(db, {
        homeTenant: overrides.homeTenant ?? { slug: 'ain', name: 'Ain Foundry (test)' },
        owner,
        ...(overrides.includeDemoData === undefined ? {} : { includeDemoData: overrides.includeDemoData }),
        ...(overrides.now === undefined ? {} : { now: overrides.now }),
      });
    }
  } catch (err) {
    await db.close();
    await dropDatabase(adminUrl, name);
    throw err;
  }

  let cleaned = false;
  return {
    db,
    url,
    adminUrl: dbAdminUrl,
    name,
    migrations,
    seed,
    ownerAccessCode,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await db.close();
      await dropDatabase(adminUrl, name);
    },
  };
}

/** Drops a database (FORCE terminates remaining connections). */
export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  await withClient(adminUrl, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
  });
}
