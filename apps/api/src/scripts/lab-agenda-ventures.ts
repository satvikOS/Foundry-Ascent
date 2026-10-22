/**
 * Conversation lab (docs/runbooks/conversation-lab.md, suite `agenda`): adds the two synthetic ventures whose
 * notebook holds one dominant open commitment dated in the past (packages/db seedLabAgendaVentures) to the lab's
 * own, freshly reset database. Refuses anything but a local Postgres outside production. Prints names only.
 *
 *   DATABASE_URL=postgresql://…@localhost/… tsx src/scripts/lab-agenda-ventures.ts
 */
import { seedLabAgendaVentures } from '@foundry/db';

import { createDatabase } from '../runtime/common.js';
import { refusal } from './lab-local-db.js';

async function main(): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DB_DRIVER: process.env.DB_DRIVER ?? 'pg',
  };
  const refused = refusal(env);
  if (refused) {
    process.stderr.write(`lab-agenda-ventures: refused (${refused})\n`);
    process.exit(2);
  }
  const db = createDatabase(env);
  try {
    const slug = env.HOME_TENANT_SLUG?.trim() ?? '';
    const tenantSlug = slug === '' ? 'ain' : slug;
    const seeded = await db.system((sx) => seedLabAgendaVentures(sx, { tenantSlug }));
    for (const v of seeded) {
      process.stdout.write(
        `lab-agenda-ventures: venture=${v.name} channel=${v.channel} founder=${v.founder}\n`,
      );
    }
  } finally {
    await db.close();
  }
}

if (process.argv[1]?.endsWith('lab-agenda-ventures.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`lab-agenda-ventures: ${err instanceof Error ? err.name : typeof err}\n`);
    process.exit(2);
  });
}
