/**
 * Conversation lab (docs/runbooks/conversation-lab.md): embeds the local seed's knowledge chunks and memory with
 * the configured embeddings model, as every production deploy's migrate resource does after seeding, so the
 * lab's retrieval matches production's (the local seed stores no embeddings). Metered in the usage ledger
 * (purpose `seed`) under the daily caps like any embedding call. Prints counts only.
 *
 *   DATABASE_URL=… MODEL_PROVIDER=bedrock MODEL_EMBEDDINGS_ID=… tsx src/scripts/lab-backfill.ts
 */
import { randomUUID } from 'node:crypto';

import { loadApiConfig } from '../config.js';
import { backfillEmbeddings } from '../jobs/embedding-backfill.js';
import { createDatabase, createGateway, createProcessLogger } from '../runtime/common.js';

/** Enough for the synthetic seed (a few hundred items); production's deploy-time backfill uses a similar bound. */
const MAX_ITEMS = 5000;
const BUDGET_MS = 5 * 60_000;

async function main(): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    APP_ENV: 'development',
    DB_DRIVER: process.env.DB_DRIVER ?? 'pg',
  };
  if (env.MODEL_PROVIDER?.trim().toLowerCase() !== 'bedrock') {
    process.stdout.write('lab-backfill: skipped (MODEL_PROVIDER is not bedrock)\n');
    return;
  }
  const config = loadApiConfig(env, 'dev');
  const logger = createProcessLogger(config, 'dev');
  const db = createDatabase(env);
  try {
    const report = await backfillEmbeddings(
      { db, gateway: createGateway(env, logger), logger },
      {
        requestId: `lab-backfill-${randomUUID()}`,
        purpose: 'seed',
        maxItems: MAX_ITEMS,
        deadline: Date.now() + BUDGET_MS,
      },
    );
    process.stdout.write(
      `lab-backfill: chunks=${String(report.chunks)} memory=${String(report.memory)} stoppedBy=${report.stoppedBy}\n`,
    );
    if (report.stoppedBy !== 'done') process.exitCode = 1;
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`lab-backfill: ${err instanceof Error ? err.name : typeof err}\n`);
  process.exit(2);
});
