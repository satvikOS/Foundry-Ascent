/**
 * Conversation lab (docs/runbooks/conversation-lab.md, suite `live`): adds one synthetic venture and founder per
 * live-evaluation scenario run (packages/db `seedLabLiveVentures`) to the lab's own, freshly reset database, from a
 * plan file the harness writes. Refuses anything but a local Postgres outside production. Prints keys and ids only.
 *
 *   DATABASE_URL=postgresql://…@localhost/… tsx src/scripts/lab-live-ventures.ts --plan <file.json>
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { parseLabLivePlan, seedLabLiveVentures } from '@foundry/db';

import { createDatabase } from '../runtime/common.js';
import { refusal } from './lab-local-db.js';

async function main(): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DB_DRIVER: process.env.DB_DRIVER ?? 'pg',
  };
  const refused = refusal(env);
  if (refused) {
    process.stderr.write(`lab-live-ventures: refused (${refused})\n`);
    process.exit(2);
  }
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: { plan: { type: 'string' } },
  });
  if (typeof values.plan !== 'string') {
    process.stderr.write('lab-live-ventures: --plan <file.json> is required\n');
    process.exit(2);
  }
  const plan = parseLabLivePlan(JSON.parse(readFileSync(values.plan, 'utf8')) as unknown);
  const db = createDatabase(env);
  try {
    const slug = env.HOME_TENANT_SLUG?.trim() ?? '';
    const tenantSlug = slug === '' ? 'ain' : slug;
    const seeded = await db.system((sx) => seedLabLiveVentures(sx, { tenantSlug, plan }));
    for (const v of seeded) {
      process.stdout.write(`lab-live-ventures: key=${v.key} venture=${v.ventureId} founder=${v.founderId}\n`);
    }
  } finally {
    await db.close();
  }
}

if (process.argv[1]?.endsWith('lab-live-ventures.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`lab-live-ventures: ${err instanceof Error ? err.name : typeof err}\n`);
    process.exit(2);
  });
}
