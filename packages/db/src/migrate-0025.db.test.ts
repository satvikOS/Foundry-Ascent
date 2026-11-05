/**
 * Migration 0025 (the stock vendor voice's runtime switch) on top of the schema production has: it applies cleanly as
 * the non-superuser owner and seeds `vendor_voice_enabled` on; settings read before it (a missing key) resolve to on
 * as well; an admin's choice is kept when the file re-runs; and the file re-runs without changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS, migrate } from './migrate.js';
import { settingsRepo } from './repositories/index.js';
import { seedDatabase, type SeedConfig } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const SWITCH = MIGRATIONS.find((m) => m.version === '0025_vendor_voice_switch');
const BEFORE = MIGRATIONS.filter((m) => m.version < '0025');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };

let t: TestDatabase;

async function stored(): Promise<unknown[]> {
  return t.db.system(async (sx) =>
    (
      await sx.query(`SELECT value::text AS value FROM platform_settings WHERE key = 'vendor_voice_enabled'`)
    ).rows.map((r) => r.value),
  );
}

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  await migrate(t.db, { migrations: BEFORE });
  await seedDatabase(t.db, CONFIG);
}, 120_000);
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0025_vendor_voice_switch', () => {
  it('before it, a missing key resolves to on (the stock voice is on where one is configured)', async () => {
    expect(await stored()).toEqual([]);
    expect((await t.db.system((sx) => settingsRepo.getPlatformSettings(sx))).vendorVoiceEnabled).toBe(true);
  });

  it('applies cleanly as the non-superuser owner and seeds the switch on', async () => {
    const report = await migrate(t.db);
    expect(report.applied).toEqual(MIGRATIONS.map((m) => m.version).filter((v) => v >= '0025'));
    expect(report.applied[0]).toBe('0025_vendor_voice_switch');
    expect(await stored()).toEqual(['true']);
    expect((await t.db.system((sx) => settingsRepo.getPlatformSettings(sx))).vendorVoiceEnabled).toBe(true);
  });

  it('is idempotent and keeps an admin’s choice when it re-runs', async () => {
    if (!SWITCH) throw new Error('0025 missing');
    await t.db.system((sx) => settingsRepo.updatePlatformSettings(sx, { vendorVoiceEnabled: false }, null));
    await t.db.system(async (sx) => {
      for (const statement of splitStatements(SWITCH.sql)) await sx.query(statement);
    });
    expect(await stored()).toEqual(['false']);
    expect((await migrate(t.db)).applied).toEqual([]);
    expect((await t.db.system((sx) => settingsRepo.getPlatformSettings(sx))).vendorVoiceEnabled).toBe(false);
  });
});
