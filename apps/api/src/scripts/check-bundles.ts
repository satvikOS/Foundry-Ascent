/**
 *   pnpm --filter @foundry/api check:bundles [outDir]
 *
 * Bundles every Lambda handler like CDK does and import-checks it (see ./bundle.ts). Exit code 1 on any
 * failure. The bundles are written to a temporary directory unless one is given.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bundleHandler, HANDLERS, handlerEnv, importCheck } from './bundle.js';

async function main(): Promise<void> {
  const given = process.argv[2];
  const outDir = given ?? (await mkdtemp(join(tmpdir(), 'fa-bundles-')));
  let failed = false;
  try {
    for (const name of HANDLERS) {
      const bundle = await bundleHandler(name, outDir);
      // Each handler starts with exactly its deployed environment (lambda-contract.json), nothing more.
      const check = await importCheck(bundle.outfile, handlerEnv(name));
      const size = `${(bundle.bytes / 1024 / 1024).toFixed(2)} MiB`;
      process.stdout.write(
        `${check.ok ? 'ok  ' : 'FAIL'} ${name.padEnd(8)} ${size.padStart(10)}  ${bundle.outfile}\n`,
      );
      if (!check.ok) {
        failed = true;
        process.stdout.write(`${check.output}\n`);
      }
    }
  } finally {
    if (given === undefined) await rm(outDir, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('bundle check failed', err instanceof Error ? err.message : err);
  process.exit(1);
});
