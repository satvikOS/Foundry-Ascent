/**
 * Conversation lab (docs/runbooks/conversation-lab.md, suite `client`): adds one synthetic venture, founder and record
 * per scenario of the client's test (packages/db `seedLabClientVentures`) to the lab's own, freshly reset database,
 * from a plan file the harness writes; or, between sessions, moves one venture's path back in time with its aged
 * conversations (`--age-path`). Refuses anything but a local Postgres outside production. Prints keys, ids and counts.
 *
 *   DATABASE_URL=postgresql://…@localhost/… tsx src/scripts/lab-client-ventures.ts --plan <file.json>
 *   DATABASE_URL=postgresql://…@localhost/… tsx src/scripts/lab-client-ventures.ts --age-path <venture uuid> --days 3
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { ageVenturePathForLab, parseLabClientPlan, seedLabClientVentures } from '@foundry/db';

import { createDatabase } from '../runtime/common.js';
import { refusal } from './lab-local-db.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ClientRequest =
  | { readonly kind: 'seed'; readonly planFile: string }
  | { readonly kind: 'age'; readonly ventureId: string; readonly days: number };

/** The validated request, or why the script must not run (a bad argument, or not the lab's local database). */
export function clientRequest(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): { readonly ok: true; readonly request: ClientRequest } | { readonly ok: false; readonly reason: string } {
  const refused = refusal(env);
  if (refused !== null) return { ok: false, reason: refused };
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      options: { plan: { type: 'string' }, 'age-path': { type: 'string' }, days: { type: 'string' } },
    }));
  } catch {
    return { ok: false, reason: 'unknown or malformed argument' };
  }
  const venture = values['age-path'];
  if (typeof venture === 'string') {
    if (!UUID.test(venture) || values.plan !== undefined) return { ok: false, reason: '--age-path' };
    const days = Number(values.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) return { ok: false, reason: '--days (1-365)' };
    return { ok: true, request: { kind: 'age', ventureId: venture, days } };
  }
  if (typeof values.plan !== 'string') return { ok: false, reason: '--plan <file.json> is required' };
  return { ok: true, request: { kind: 'seed', planFile: values.plan } };
}

async function main(): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DB_DRIVER: process.env.DB_DRIVER ?? 'pg',
  };
  const prepared = clientRequest(process.argv.slice(2), env);
  if (!prepared.ok) {
    process.stderr.write(`lab-client-ventures: refused (${prepared.reason})\n`);
    process.exit(2);
  }
  const { request } = prepared;
  const db = createDatabase(env);
  try {
    if (request.kind === 'age') {
      const { ventureId, days } = request;
      const moved = await db.system((sx) => ageVenturePathForLab(sx, { ventureId, days }));
      process.stdout.write(
        `lab-client-ventures: aged days=${String(days)} tables=${String(moved.tables)} rows=${String(moved.rows)}\n`,
      );
      return;
    }
    const plan = parseLabClientPlan(JSON.parse(readFileSync(request.planFile, 'utf8')) as unknown);
    const slug = env.HOME_TENANT_SLUG?.trim() ?? '';
    const tenantSlug = slug === '' ? 'ain' : slug;
    const seeded = await db.system((sx) => seedLabClientVentures(sx, { tenantSlug, plan }));
    for (const v of seeded) {
      process.stdout.write(
        `lab-client-ventures: key=${v.key} venture=${v.ventureId} founder=${v.founderId}\n`,
      );
    }
  } finally {
    await db.close();
  }
}

if (process.argv[1]?.endsWith('lab-client-ventures.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`lab-client-ventures: ${err instanceof Error ? err.name : typeof err}\n`);
    process.exit(2);
  });
}
