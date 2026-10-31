/**
 * Conversation lab (docs/runbooks/conversation-lab.md, suite `face`): makes the seeded founder of the synthetic
 * venture QuietQuad (a synthetic person) a platform admin in the lab's own, freshly reset database, because the
 * HeyGen stock face is shown to platform admins only (`MEDIA_FACE_AUDIENCE=admins`). The lab then calls as that
 * founder: an admin of a synthetic venture. Refuses anything but a local Postgres outside production; a second run
 * changes nothing. Prints the name and the outcome only.
 *
 *   DATABASE_URL=postgresql://…@localhost/… tsx src/scripts/lab-face-admin.ts ["Founder Name"]
 */
import { type SqlParam } from '@foundry/db';

import { createDatabase } from '../runtime/common.js';
import { refusal } from './lab-local-db.js';

/** The seeded founder (packages/db seed: QuietQuad's founder, synthetic). */
export const LAB_FACE_FOUNDER = 'Maya Okafor-Lindqvist';

const text = (value: string): SqlParam => ({ type: 'text', value });

/** Grants `platform_admin` to the synthetic principal named `name` (once); the number of grants added (0 or 1). */
export const GRANT_SQL = `
  INSERT INTO role_grants (principal_id, tenant_id, role)
  SELECT p.id, NULL, 'platform_admin'
    FROM principals p
   WHERE p.display_name = :name AND p.synthetic
     AND NOT EXISTS (SELECT 1 FROM role_grants g
                      WHERE g.principal_id = p.id AND g.role = 'platform_admin' AND g.revoked_at IS NULL)
  RETURNING principal_id`;

/** Whether the synthetic principal `name` exists (an unknown or real person is never granted anything). */
export const FOUND_SQL = 'SELECT count(*)::int AS n FROM principals WHERE display_name = :name AND synthetic';

async function main(): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DB_DRIVER: process.env.DB_DRIVER ?? 'pg',
  };
  const refused = refusal(env);
  if (refused) {
    process.stderr.write(`lab-face-admin: refused (${refused})\n`);
    process.exit(2);
  }
  const given = process.argv[2]?.trim() ?? '';
  const name = given === '' ? LAB_FACE_FOUNDER : given;
  const db = createDatabase(env);
  try {
    const outcome = await db.system(async (sx) => {
      const found = await sx.query(FOUND_SQL, { name: text(name) });
      if (Number(found.rows[0]?.n ?? 0) !== 1) return 'not_found';
      const granted = await sx.query(GRANT_SQL, { name: text(name) });
      return granted.rows.length === 1 ? 'granted' : 'already';
    });
    process.stdout.write(`lab-face-admin: founder=${name} platform_admin=${outcome}\n`);
    if (outcome === 'not_found') process.exitCode = 3;
  } finally {
    await db.close();
  }
}

if (process.argv[1]?.endsWith('lab-face-admin.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`lab-face-admin: ${err instanceof Error ? err.name : typeof err}\n`);
    process.exit(2);
  });
}
