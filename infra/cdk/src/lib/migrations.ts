import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Same file filter as packages/db/src/scripts/gen-migrations.ts. */
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Checksum over every migration (version + sha256 of its LF-normalised SQL, the per-file checksum the
 * generated bundle carries). It is a property of the migrate custom resource, so adding or editing a
 * migration always produces a CloudFormation update even when the app version is unchanged.
 */
export function migrationsChecksum(migrationsDir: string): string {
  const files = readdirSync(migrationsDir)
    .filter((f) => MIGRATION_FILE.test(f))
    .sort();
  if (files.length === 0) throw new Error(`No migrations found in ${migrationsDir}`);
  const outer = createHash('sha256');
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8').replace(/\r\n/g, '\n');
    const fileChecksum = createHash('sha256').update(sql, 'utf8').digest('hex');
    outer.update(`${file.replace(/\.sql$/, '')}:${fileChecksum}\n`, 'utf8');
  }
  return outer.digest('hex');
}
