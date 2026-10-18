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
import { refusal } from './lab-local-db.js';

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
