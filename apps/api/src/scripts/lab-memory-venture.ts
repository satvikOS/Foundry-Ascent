/**
 * Conversation lab (docs/runbooks/conversation-lab.md): adds the dedicated synthetic venture that evals' matrix
 * needs for its remembered (multi-session) conversations (`--memory-venture`) to the lab's own, freshly reset
 * database. Refuses anything but a local Postgres outside production, so it can never touch a deployed
 * database. Prints the venture key and counts only.
 *
 *   DATABASE_URL=postgresql://…@localhost/… tsx src/scripts/lab-memory-venture.ts
 */
import { seedLabMemoryVenture } from '@foundry/db';

import { createDatabase } from '../runtime/common.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Why the lab must not write to this database, or null when it is a local Postgres outside production. */
export function refusal(env: Readonly<Record<string, string | undefined>>): string | null {
  if ((env.APP_ENV ?? '').trim().toLowerCase() === 'production') return 'APP_ENV is production';
  const driver = (env.DB_DRIVER ?? 'pg').trim().toLowerCase();
  if (driver !== 'pg') return 'not a Postgres connection (DB_DRIVER)';
  const raw = env.DATABASE_URL?.trim();
  if (!raw) return 'DATABASE_URL is not set';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'DATABASE_URL is not a URL';
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return 'DATABASE_URL is not postgres';
  // A Unix socket (`?host=/path`) is local too.
  const socket = url.searchParams.get('host');
  const local = LOCAL_HOSTS.has(url.hostname) && (socket === null || socket.startsWith('/'));
  return local ? null : 'DATABASE_URL is not a local database';
}

async function main(): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DB_DRIVER: process.env.DB_DRIVER ?? 'pg',
  };
  const refused = refusal(env);
  if (refused) {
    process.stderr.write(`lab-memory-venture: refused (${refused})\n`);
    process.exit(2);
  }
  const db = createDatabase(env);
  try {
    const slug = env.HOME_TENANT_SLUG?.trim() ?? '';
    const tenantSlug = slug === '' ? 'ain' : slug;
    const result = await db.system((sx) => seedLabMemoryVenture(sx, { tenantSlug }));
    process.stdout.write(`lab-memory-venture: key=${result.key} members=${String(result.members)}\n`);
  } finally {
    await db.close();
  }
}

if (process.argv[1]?.endsWith('lab-memory-venture.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`lab-memory-venture: ${err instanceof Error ? err.name : typeof err}\n`);
    process.exit(2);
  });
}
