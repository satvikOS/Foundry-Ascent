/**
 * The startup knowledge base (packages/db/knowledge/startup-knowledge-base):
 *
 *   pnpm --filter @foundry/db knowledge-pack validate
 *       Validates the canonical JSON (validate_kb.py semantics, its seventeen self-test corruptions) and renders
 *       every item; prints a report and exits non-zero on any problem. Offline: no database.
 *
 *   pnpm --filter @foundry/db knowledge-pack sync [--tenant <slug>]
 *       Ingests the pack into the common pool of one tenant (default: every active tenant), idempotently. Uses the
 *       runtime database variables (DB_DRIVER, DATABASE_URL or the Data API ones). Deploys need not run it: the
 *       seed (migrate custom resource) syncs every active tenant on every deploy and the backfill embeds new passages.
 *
 * To update the pack: replace the JSON (keep the owner's serialization), run `validate`, commit; the next deploy
 * re-ingests exactly the items whose text changed and withdraws the ones the JSON no longer has.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createDbFromEnv } from '../db.js';
import { loadKnowledgePack, rawKnowledgePack } from '../knowledge-pack/pack.js';
import { packItems } from '../knowledge-pack/render.js';
import { syncKnowledgePackToTenants } from '../knowledge-pack/sync.js';
import { CORRUPTION_CASES, validateKnowledgePack } from '../knowledge-pack/validate.js';

export interface ValidationReport {
  readonly status: 'PASS' | 'FAIL';
  readonly errors: readonly string[];
  readonly selfTestsPassed: readonly string[];
  readonly selfTestsMissed: readonly string[];
  readonly items: Readonly<Record<string, number>>;
  readonly passages: number;
  readonly ragDocuments: Readonly<Record<string, string>>;
}

/** The `validate` command's report (exported for tests). */
export function validationReport(): ValidationReport {
  const errors = validateKnowledgePack(rawKnowledgePack());
  const passed: string[] = [];
  const missed: string[] = [];
  for (const c of CORRUPTION_CASES) {
    const trial = rawKnowledgePack() as Record<string, never>;
    c.mutate(trial);
    (validateKnowledgePack(trial).length > 0 ? passed : missed).push(c.name);
  }
  const items: Record<string, number> = {};
  const ragDocuments: Record<string, string> = {};
  let passages = 0;
  if (errors.length === 0) {
    try {
      for (const item of packItems(loadKnowledgePack())) {
        items[item.kind] = (items[item.kind] ?? 0) + 1;
        passages += item.passages.length;
        if (item.ragDocId !== null) ragDocuments[item.ragDocId] = item.key;
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return {
    status: errors.length === 0 && missed.length === 0 ? 'PASS' : 'FAIL',
    errors,
    selfTestsPassed: passed,
    selfTestsMissed: missed,
    items,
    passages,
    ragDocuments,
  };
}

async function sync(tenantSlug: string | null): Promise<void> {
  const db = createDbFromEnv();
  const reports = await db.system((sx) => syncKnowledgePackToTenants(sx, { slug: tenantSlug }));
  if (reports.length === 0) throw new Error(`no active tenant${tenantSlug ? ` "${tenantSlug}"` : ''}`);
  for (const { slug, report } of reports) process.stdout.write(`${slug}: ${JSON.stringify(report)}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'validate') {
    const report = validationReport();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.status === 'PASS' ? 0 : 1;
  }
  if (command === 'sync') {
    const i = rest.indexOf('--tenant');
    await sync(i === -1 ? null : (rest[i + 1] ?? null));
    return 0;
  }
  process.stderr.write('usage: knowledge-pack validate | knowledge-pack sync [--tenant <slug>]\n');
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
