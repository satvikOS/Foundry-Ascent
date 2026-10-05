/**
 * Platform settings (kill switch, spend caps, thresholds). Readable by any authenticated request
 * (`app_rls` SELECT); writable only through the SystemExecutor after an admin authorization check.
 */
import { PlatformSettingsView } from '@foundry/contracts';
import { z } from 'zod';

import { col } from '../columns.js';
import { type SqlExecutor, type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { queryRows } from './common.js';

type PlatformSettingsValue = z.infer<typeof PlatformSettingsView>;

/** Contract field ↔ `platform_settings.key`. */
export const SETTING_KEYS = {
  aiEnabled: 'ai_enabled',
  dailyUsdCapGlobal: 'daily_usd_cap_global',
  dailyUsdCapPerPrincipal: 'daily_usd_cap_per_principal',
  maxTurnsPerSession: 'max_turns_per_session',
  groundingCoverageThreshold: 'grounding_coverage_threshold',
  portfolioMinGroupSize: 'portfolio_min_group_size',
} as const satisfies Record<keyof PlatformSettingsValue, string>;

/** Values seeded by migration 0001; used when a key is missing. Fail closed for the kill switch. */
export const DEFAULT_SETTINGS: PlatformSettingsValue = {
  aiEnabled: false,
  dailyUsdCapGlobal: 2,
  dailyUsdCapPerPrincipal: 0.5,
  maxTurnsPerSession: 40,
  groundingCoverageThreshold: 0.6,
  portfolioMinGroupSize: 3,
};

const Coerced = z.object({
  aiEnabled: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]),
  dailyUsdCapGlobal: z.coerce.number(),
  dailyUsdCapPerPrincipal: z.coerce.number(),
  maxTurnsPerSession: z.coerce.number().int(),
  groundingCoverageThreshold: z.coerce.number(),
  portfolioMinGroupSize: z.coerce.number().int(),
});

/** Current settings as the contract view (missing or malformed keys fall back to {@link DEFAULT_SETTINGS}). */
export async function getPlatformSettings(ex: SqlExecutor): Promise<PlatformSettingsValue> {
  const rows = await queryRows(ex, 'SELECT key, value FROM platform_settings', {}, (r) => ({
    key: col.text.decode(r.key, 'key'),
    value: col.json().decode(r.value, 'value'),
  }));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out: Record<string, unknown> = {};
  for (const [field, key] of Object.entries(SETTING_KEYS)) {
    const fieldSchema = Coerced.shape[field as keyof typeof Coerced.shape];
    const parsed = fieldSchema.safeParse(byKey.get(key));
    out[field] = parsed.success ? parsed.data : DEFAULT_SETTINGS[field as keyof PlatformSettingsValue];
  }
  return PlatformSettingsView.parse(out);
}

/**
 * Applies a validated partial update (system executor; the caller has verified platform_admin).
 * Returns the full settings after the update.
 */
export async function updatePlatformSettings(
  sx: SystemExecutor,
  patch: Partial<PlatformSettingsValue>,
  updatedBy: string | null,
): Promise<PlatformSettingsValue> {
  const valid = PlatformSettingsView.partial().parse(patch);
  const rows: { key: string; value: unknown }[] = [];
  for (const [field, value] of Object.entries(valid) as [string, unknown][]) {
    if (value !== undefined) rows.push({ key: SETTING_KEYS[field as keyof PlatformSettingsValue], value });
  }
  if (rows.length > 0) {
    await sx.query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       SELECT x.key, x.value, :updatedBy, now() FROM jsonb_to_recordset(:rows) AS x (key text, value jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      { rows: p.json(rows), updatedBy: p.nullable.uuid(updatedBy) },
    );
  }
  return getPlatformSettings(sx);
}
