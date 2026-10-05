/**
 * LOCAL ONLY: (re)creates the development database, migrates it as the non-superuser owner role
 * (`fa_master`, like Aurora's master user), seeds synthetic data and prints a freshly generated DEV owner
 * access code. Never run against a shared or production database.
 *
 *   pnpm --filter @foundry/db db:reset
 *
 * Environment: TEST_DATABASE_ADMIN_URL (superuser URL, default local unix socket cluster on port 54329),
 * LOCAL_DB_NAME (default `foundry`), HOME_TENANT_SLUG / HOME_TENANT_NAME, OWNER_DISPLAY_NAME.
 */
import { createDb } from '../db.js';
import { migrate } from '../migrate.js';
import { accessCodePrefix, generateAccessCode, hashAccessCode } from '../seed/access-code.js';
import { seedDatabase } from '../seed/seed.js';
import {
  TEST_OWNER_PASSWORD,
  TEST_OWNER_ROLE,
  bootstrapCluster,
  quoteIdent,
  testAdminUrl,
  withClient,
  withDatabase,
} from '../testing/test-database.js';

function isLocal(url: string): boolean {
  const u = new URL(url);
  const socketHost = u.searchParams.get('host');
  if (socketHost?.startsWith('/')) return true;
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
}

async function main(): Promise<void> {
  if (process.env.APP_ENV === 'production')
    throw new Error('reset-local refuses to run with APP_ENV=production');
  const adminUrl = testAdminUrl();
  if (!isLocal(adminUrl) && process.env.ALLOW_NON_LOCAL_RESET !== '1') {
    throw new Error(
      'reset-local only targets a local cluster (set ALLOW_NON_LOCAL_RESET=1 for a disposable remote one)',
    );
  }
  const name = process.env.LOCAL_DB_NAME ?? 'foundry';
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('LOCAL_DB_NAME must be a simple identifier');

  await withClient(adminUrl, async (admin) => {
    await bootstrapCluster(admin);
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoteIdent(name)} OWNER ${quoteIdent(TEST_OWNER_ROLE)}`);
  });
  await withClient(withDatabase(adminUrl, name), async (admin) => {
    await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  });

  const url = withDatabase(adminUrl, name, { name: TEST_OWNER_ROLE, password: TEST_OWNER_PASSWORD });
  const db = createDb({ driver: 'pg', connectionString: url, max: 2 });
  try {
    const report = await migrate(db);
    const code = generateAccessCode();
    const result = await seedDatabase(db, {
      homeTenant: {
        slug: process.env.HOME_TENANT_SLUG ?? 'ain',
        name: process.env.HOME_TENANT_NAME ?? 'Ain Foundry',
      },
      owner: {
        displayName: process.env.OWNER_DISPLAY_NAME ?? 'Local Owner',
        accessCodePrefix: accessCodePrefix(code),
        accessCodeHash: await hashAccessCode(code),
      },
    });
    process.stdout.write(
      [
        `Local database "${name}" reset (${String(report.applied.length)} migrations, ${String(result.ventures.length)} synthetic ventures).`,
        `DB_DRIVER=pg`,
        `DATABASE_URL=${url}`,
        `DEV owner access code (local only, shown once): ${code}`,
        '',
      ].join('\n'),
    );
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(`reset-local failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exit(1);
});
