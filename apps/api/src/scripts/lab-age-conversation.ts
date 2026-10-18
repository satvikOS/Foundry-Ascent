/**
 * Conversation lab (docs/runbooks/conversation-lab.md): evals' `--between-sessions-cmd` for a remembered
 * conversation "days later". Once the conversation that just ended has been distilled (it writes the digest, the
 * notebook and memory), it moves that conversation, the venture's earlier live ones and everything they produced
 * back by the scenario's gap (packages/db `ageConversationsForLab`), so the next conversation's opener and "Where
 * you left off" truthfully say "3 days ago" or "two weeks ago". Refuses anything but the lab's local Postgres.
 * Prints counts only.
 *
 *   DATABASE_URL=postgresql://…@localhost/… tsx src/scripts/lab-age-conversation.ts \
 *     --session-id <uuid> --gap-days 3 [--venture <key> --venture-id <uuid> --actor <label> --principal-id <uuid>]
 */
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { ageConversationsForLab, conversationDistilled, DbError, SqlUsageError } from '@foundry/db';

import { createDatabase } from '../runtime/common.js';
import { refusal } from './lab-local-db.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_WAIT_SECONDS = 120;

export interface AgeRequest {
  readonly sessionId: string;
  readonly days: number;
  readonly waitSeconds: number;
}

/** The validated request, or why the script must not run (a bad argument, or not the lab's local database). */
export function ageRequest(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): { readonly ok: true; readonly request: AgeRequest } | { readonly ok: false; readonly reason: string } {
  const refused = refusal(env);
  if (refused !== null) return { ok: false, reason: refused };
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      options: {
        'session-id': { type: 'string' },
        'gap-days': { type: 'string' },
        'wait-seconds': { type: 'string' },
        // What evals passes besides (the actor and venture are read from the conversation itself).
        venture: { type: 'string' },
        'venture-id': { type: 'string' },
        actor: { type: 'string' },
        'principal-id': { type: 'string' },
      },
    }));
  } catch {
    return { ok: false, reason: 'unknown or malformed argument' };
  }
  const sessionId = values['session-id'];
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return { ok: false, reason: '--session-id' };
  const days = Number(values['gap-days']);
  if (!Number.isInteger(days) || days < 1 || days > 365) return { ok: false, reason: '--gap-days (1-365)' };
  const wait = values['wait-seconds'] === undefined ? DEFAULT_WAIT_SECONDS : Number(values['wait-seconds']);
  if (!Number.isInteger(wait) || wait < 0 || wait > 900)
    return { ok: false, reason: '--wait-seconds (0-900)' };
  return { ok: true, request: { sessionId, days, waitSeconds: wait } };
}

async function main(): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DB_DRIVER: process.env.DB_DRIVER ?? 'pg',
  };
  const prepared = ageRequest(process.argv.slice(2), env);
  if (!prepared.ok) {
    process.stderr.write(`lab-age: refused (${prepared.reason})\n`);
    process.exit(2);
  }
  const { sessionId, days, waitSeconds } = prepared.request;
  const db = createDatabase(env);
  try {
    const until = Date.now() + waitSeconds * 1000;
    let distilled = await db.system((sx) => conversationDistilled(sx, sessionId));
    while (!distilled && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      distilled = await db.system((sx) => conversationDistilled(sx, sessionId));
    }
    const moved = await db.system((sx) => ageConversationsForLab(sx, { sessionId, days }));
    const line =
      `lab-age: days=${String(days)} sessions=${String(moved.sessions)} turns=${String(moved.turns)} ` +
      `memory=${String(moved.memory)} notebooks=${String(moved.notebooks)} digests=${String(moved.digests)} ` +
      `distilled=${distilled ? 'yes' : 'no'}\n`;
    process.stdout.write(line);
    // evals keeps none of a command's output: the lab reads the counts from its own private log.
    const log = env.LAB_AGE_LOG?.trim();
    if (log) appendFileSync(log, line);
  } finally {
    await db.close();
  }
}

if (process.argv[1]?.endsWith('lab-age-conversation.ts')) {
  main().catch((err: unknown) => {
    // Our own refusals carry content-free messages; anything else is named only.
    const what = err instanceof SqlUsageError ? err.message : err instanceof Error ? err.name : typeof err;
    const code =
      err instanceof DbError
        ? ` ${err.sqlState ?? ''}${err.constraint ? ` ${err.constraint}` : ''}`.trimEnd()
        : '';
    process.stderr.write(`lab-age: ${what}${code}\n`);
    const log = process.env.LAB_AGE_LOG?.trim();
    if (log) appendFileSync(log, `lab-age: failed (${what}${code})\n`);
    process.exit(2);
  });
}
