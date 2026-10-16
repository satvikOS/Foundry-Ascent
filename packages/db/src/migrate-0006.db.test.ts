/**
 * Migration 0006 (turn engine) on top of the state before it: spend caps rise only where an administrator kept
 * the old defaults, the streaming and calls switches are added without overriding a stored choice, openers exist
 * only on standard conversations and disappear when a conversation is deleted, and the file re-runs unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import { settingsRepo } from './repositories/index.js';
import { seedDatabase, type SeedConfig, type SeedResult } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const BEFORE = MIGRATIONS.filter((m) => m.version < '0006');
const TURN_ENGINE = MIGRATIONS.find((m) => m.version === '0006_turn_engine');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };

let t: TestDatabase;
let seed: SeedResult;

async function settingValue(key: string): Promise<unknown> {
  const r = await t.db.system((sx) =>
    sx.query('SELECT value::text AS v FROM platform_settings WHERE key = :key', { key: p.text(key) }),
  );
  const raw = r.rows[0]?.v;
  return typeof raw === 'string' ? (JSON.parse(raw) as unknown) : null;
}

async function insertSession(privacy: 'standard' | 'ephemeral', opener: string | null): Promise<string> {
  const quietquad = seed.ventures.find((v) => v.key === 'quietquad');
  if (!quietquad) throw new Error('no quietquad');
  const r = await t.db.system((sx) =>
    sx.query(
      `INSERT INTO coaching_sessions (tenant_id, venture_id, assignment_id, persona_release_id, started_by, mode,
                                      privacy, policy_version, opener)
       SELECT :tenant, :venture, a.id, r.id, :maya, 'coach', :privacy, 'test', :opener
       FROM assignments a JOIN persona_releases r ON r.persona_id = a.persona_id AND r.status = 'approved'
       WHERE a.venture_id = :venture AND a.status = 'active' LIMIT 1
       RETURNING id`,
      {
        tenant: p.uuid(seed.tenantId),
        venture: p.uuid(quietquad.id),
        maya: p.uuid(seed.principals.maya ?? ''),
        privacy: p.text(privacy),
        opener: p.nullable.text(opener),
      },
    ),
  );
  return String(r.rows[0]?.id);
}

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  await migrate(t.db, { migrations: BEFORE });
  seed = await seedDatabase(t.db, CONFIG);
  // An administrator lowered the per-person cap and switched calls off before the migration ran.
  await t.db.system(async (sx) => {
    await sx.query(`UPDATE platform_settings SET value = '0.25' WHERE key = 'daily_usd_cap_per_principal'`);
    await sx.query(
      `INSERT INTO platform_settings (key, value) VALUES ('calls_enabled', 'false')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
  });
}, 180_000);

afterAll(async () => {
  await t.cleanup();
});

describe('migration 0006_turn_engine', () => {
  it('applies on top of the previous migrations', async () => {
    expect(await settingValue('daily_usd_cap_global')).toBe(2);
    const report = await migrate(t.db);
    // The later migrations follow in the same run (their own suites cover them).
    expect(report.applied).toEqual(MIGRATIONS.map((m) => m.version).filter((v) => v >= '0006'));
    expect(report.applied[0]).toBe('0006_turn_engine');
  });

  it('raises the spend caps only where the old default is still stored', async () => {
    expect(await settingValue('daily_usd_cap_global')).toBe(15);
    expect(await settingValue('daily_usd_cap_per_principal')).toBe(0.25);
    const settings = await t.db.system((sx) => settingsRepo.getPlatformSettings(sx));
    expect(settings).toMatchObject({ dailyUsdCapGlobal: 15, dailyUsdCapPerPrincipal: 0.25 });
  });

  it('adds the streaming switch on, and keeps a calls switch an administrator turned off', async () => {
    expect(await settingValue('streaming_enabled')).toBe(true);
    expect(await settingValue('calls_enabled')).toBe(false);
  });

  it('re-runs without changing anything', async () => {
    if (!TURN_ENGINE) throw new Error('0006 is not bundled');
    await t.db.system(async (sx) => {
      await sx.query(`UPDATE platform_settings SET value = '0.50' WHERE key = 'daily_usd_cap_per_principal'`);
      for (const statement of splitStatements(TURN_ENGINE.sql)) await sx.query(statement);
      for (const statement of splitStatements(TURN_ENGINE.sql)) await sx.query(statement);
    });
    expect(await settingValue('daily_usd_cap_global')).toBe(15);
    expect(await settingValue('daily_usd_cap_per_principal')).toBe(1);
    expect(await settingValue('calls_enabled')).toBe(false);
  });

  it('keeps openers to standard conversations, at most 300 characters', async () => {
    const standard = await insertSession(
      'standard',
      'Last time you planned five interviews. How did they go?',
    );
    expect(standard).toMatch(/^[0-9a-f-]{36}$/);
    await expect(insertSession('ephemeral', 'Welcome back.')).rejects.toMatchObject({ sqlState: '23514' });
    await expect(insertSession('standard', 'x'.repeat(301))).rejects.toMatchObject({ sqlState: '23514' });
    await expect(insertSession('standard', '')).rejects.toMatchObject({ sqlState: '23514' });
    expect(await insertSession('ephemeral', null)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('clears the opener when a conversation is deleted', async () => {
    const id = await insertSession('standard', 'Welcome back, Maya.');
    const row = await t.db.system(async (sx) => {
      await sx.query('UPDATE coaching_sessions SET deleted_at = now() WHERE id = :id', { id: p.uuid(id) });
      return (await sx.query('SELECT opener FROM coaching_sessions WHERE id = :id', { id: p.uuid(id) }))
        .rows[0];
    });
    expect(row).toEqual({ opener: null });
  });

  it('accepts only non-negative first-token times', async () => {
    const r = await t.db.system((sx) =>
      sx.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'turns_first_token_ms_check'`,
      ),
    );
    expect(String(r.rows[0]?.def)).toContain('first_token_ms >= 0');
  });

  it('adds both checks without scanning the table, and enforces them on every later write', async () => {
    const r = await t.db.system((sx) =>
      sx.query(
        `SELECT conname, convalidated FROM pg_constraint
         WHERE conname IN ('coaching_sessions_opener_check', 'turns_first_token_ms_check') ORDER BY conname`,
      ),
    );
    expect(r.rows).toEqual([
      { conname: 'coaching_sessions_opener_check', convalidated: false },
      { conname: 'turns_first_token_ms_check', convalidated: false },
    ]);
    // A conversation that existed before (earlier tests inserted some) cannot be given an invalid opener.
    await expect(
      t.db.system((sx) =>
        sx.query(
          `UPDATE coaching_sessions SET opener = repeat('x', 301)
           WHERE id = (SELECT id FROM coaching_sessions ORDER BY started_at LIMIT 1)`,
        ),
      ),
    ).rejects.toMatchObject({ sqlState: '23514' });
  });
});
