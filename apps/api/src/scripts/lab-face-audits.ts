/**
 * Conversation lab (docs/runbooks/conversation-lab.md, suite `face`): tells which of the `call.face_injection`
 * audits the injection test saw came from a HEARTBEAT check (`metadata.atEnd = false`, the face still live) and which
 * from the final check after the face had already ended (`atEnd = true`, e.g. the sandbox's minute running out).
 * The admin audit API returns no metadata, so the lab reads its own, freshly reset database (local Postgres only).
 * Prints counts only: never a word, never an id of a person.
 *
 *   DATABASE_URL=postgresql://…@localhost/… tsx src/scripts/lab-face-audits.ts <audit id> [<audit id> …]
 */
import { p, type SqlExecutor } from '@foundry/db';

import { createDatabase } from '../runtime/common.js';
import { refusal } from './lab-local-db.js';

/** At most this many ids (the lab passes the handful the injection test saw). */
export const MAX_IDS = 50;

/** The `call.face_injection` audits among `ids`, by where the check ran (heartbeat, at the end, unrecorded). */
export const AUDITS_SQL = `
  SELECT count(*) FILTER (WHERE metadata->>'atEnd' = 'false')::int AS heartbeat,
         count(*) FILTER (WHERE metadata->>'atEnd' = 'true')::int  AS at_end,
         count(*) FILTER (WHERE metadata->>'atEnd' IS NULL
                             OR metadata->>'atEnd' NOT IN ('true', 'false'))::int AS unknown
    FROM audit_events
   WHERE action = 'call.face_injection'
     AND id = ANY (string_to_array(:ids, ',')::bigint[])`;

export interface InjectionAudits {
  readonly heartbeat: number;
  readonly atEnd: number;
  readonly unknown: number;
}

/** The ids given on the command line (decimal, deduplicated), or null when any is not an audit id. */
export function parseIds(args: readonly string[]): string[] | null {
  const ids = [...new Set(args.map((a) => a.trim()).filter((a) => a !== ''))];
  if (ids.length === 0 || ids.length > MAX_IDS) return null;
  return ids.every((id) => /^[1-9]\d{0,14}$/.test(id)) ? ids : null;
}

/** The line the lab parses (conversation_lab/face.py `injection_audits`). */
export function formatLine(counts: InjectionAudits): string {
  return `lab-face-audits: heartbeat=${counts.heartbeat} at_end=${counts.atEnd} unknown=${counts.unknown}`;
}

/** Counts the injection audits among `ids` (the lab database, a system executor). */
export async function countInjectionAudits(
  ex: SqlExecutor,
  ids: readonly string[],
): Promise<InjectionAudits> {
  const result = await ex.query(AUDITS_SQL, { ids: p.text(ids.join(',')) });
  const row = result.rows[0] ?? {};
  return {
    heartbeat: Number(row.heartbeat ?? 0),
    atEnd: Number(row.at_end ?? 0),
    unknown: Number(row.unknown ?? 0),
  };
}

async function main(): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DB_DRIVER: process.env.DB_DRIVER ?? 'pg',
  };
  const refused = refusal(env);
  if (refused) {
    process.stderr.write(`lab-face-audits: refused (${refused})\n`);
    process.exit(2);
  }
  const ids = parseIds(process.argv.slice(2));
  if (ids === null) {
    process.stderr.write(`lab-face-audits: give 1 to ${MAX_IDS} audit ids\n`);
    process.exit(2);
  }
  const db = createDatabase(env);
  try {
    const counts = await db.system((sx) => countInjectionAudits(sx, ids));
    process.stdout.write(`${formatLine(counts)}\n`);
  } finally {
    await db.close();
  }
}

if (process.argv[1]?.endsWith('lab-face-audits.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`lab-face-audits: ${err instanceof Error ? err.name : typeof err}\n`);
    process.exit(2);
  });
}
