/**
 * Platform settings (kill switch, spend caps, thresholds). Readable by any authenticated request
 * (`app_rls` SELECT); writable only through the SystemExecutor after an admin authorization check.
 */
import { PlatformSettingsView } from '@foundry/contracts';
import { z } from 'zod';

import { col } from '../columns.js';
import { type SqlExecutor, type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { readPart, rowsPart, type ReadPart } from './common.js';

type PlatformSettingsValue = z.infer<typeof PlatformSettingsView>;

/** Contract field ↔ `platform_settings.key`. */
export const SETTING_KEYS = {
  aiEnabled: 'ai_enabled',
  dailyUsdCapGlobal: 'daily_usd_cap_global',
  dailyUsdCapPerPrincipal: 'daily_usd_cap_per_principal',
  maxTurnsPerSession: 'max_turns_per_session',
  groundingCoverageThreshold: 'grounding_coverage_threshold',
  portfolioMinGroupSize: 'portfolio_min_group_size',
  dailyUploadDocumentsPerPrincipal: 'daily_upload_documents_per_principal',
  dailyUploadBytesPerPrincipal: 'daily_upload_bytes_per_principal',
  maxCallMinutes: 'max_call_minutes',
  dailyCallMinutesPerPrincipal: 'daily_call_minutes_per_principal',
  streamingEnabled: 'streaming_enabled',
  callsEnabled: 'calls_enabled',
  facesEnabled: 'faces_enabled',
  clonedVoiceEnabled: 'cloned_voice_enabled',
  faceMinutesPerPrincipalMonth: 'face_minutes_per_principal_month',
  faceMinutesPerCall: 'face_minutes_per_call',
} as const satisfies Record<keyof PlatformSettingsValue, string>;

/** Settings with every optional (additive) field present: what {@link getPlatformSettings} returns. */
export type ResolvedPlatformSettings = Required<PlatformSettingsValue>;

/**
 * Values seeded by migrations 0001, 0003, 0004 and 0006; used when a key is missing. Fail closed for the kill
 * switch; AI spend is capped at $15 per UTC day for the platform and $1 per person; the upload quota defaults
 * are 20 documents and 50 MB per person per UTC day; calls last at most 30 minutes and one person may talk 60
 * minutes per UTC day. Streaming and calls are on unless switched off (the AI kill switch still stops both).
 * The vEIR's video face and cloned voice (0017) are off until the program turns them on (fail closed), with 60
 * video minutes per person per month and 20 per call.
 */
export const DEFAULT_SETTINGS: ResolvedPlatformSettings = {
  aiEnabled: false,
  dailyUsdCapGlobal: 15,
  dailyUsdCapPerPrincipal: 1,
  maxTurnsPerSession: 40,
  groundingCoverageThreshold: 0.6,
  portfolioMinGroupSize: 3,
  dailyUploadDocumentsPerPrincipal: 20,
  dailyUploadBytesPerPrincipal: 50 * 1024 * 1024,
  maxCallMinutes: 30,
  dailyCallMinutesPerPrincipal: 60,
  streamingEnabled: true,
  callsEnabled: true,
  facesEnabled: false,
  clonedVoiceEnabled: false,
  faceMinutesPerPrincipalMonth: 60,
  faceMinutesPerCall: 20,
};

/**
 * A digest of every setting as stored (keys and JSON values): equal while nothing in `platform_settings` changed. A
 * statement that acts on settings read earlier checks it, so it acts only while they are still what it decided on.
 */
export const SETTINGS_FINGERPRINT_SQL = `(SELECT md5(coalesce(string_agg(ps.key || '=' || ps.value::text, ',' ORDER BY ps.key), ''))
   FROM platform_settings ps)`;

/** The settings' digest ({@link SETTINGS_FINGERPRINT_SQL}) as a read of a combined statement (`readTogether`). */
export function settingsFingerprintPart(): ReadPart<string> {
  return {
    sql: `SELECT ${SETTINGS_FINGERPRINT_SQL} AS fp`,
    params: {},
    decode: (rows) => col.text.decode(rows[0]?.fp ?? null, 'fp'),
  };
}

const Coerced = z.object({
  aiEnabled: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]),
  dailyUsdCapGlobal: z.coerce.number(),
  dailyUsdCapPerPrincipal: z.coerce.number(),
  maxTurnsPerSession: z.coerce.number().int(),
  groundingCoverageThreshold: z.coerce.number(),
  portfolioMinGroupSize: z.coerce.number().int(),
  dailyUploadDocumentsPerPrincipal: z.coerce.number().int(),
  dailyUploadBytesPerPrincipal: z.coerce.number().int(),
  maxCallMinutes: z.coerce.number().int(),
  dailyCallMinutesPerPrincipal: z.coerce.number().int(),
  streamingEnabled: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]),
  callsEnabled: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]),
  facesEnabled: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]),
  clonedVoiceEnabled: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]),
  faceMinutesPerPrincipalMonth: z.coerce.number().int(),
  faceMinutesPerCall: z.coerce.number().int(),
});

/** Current settings as the contract view (missing or malformed keys fall back to {@link DEFAULT_SETTINGS}). */
export function getPlatformSettings(ex: SqlExecutor): Promise<ResolvedPlatformSettings> {
  return readPart(ex, platformSettingsPart());
}

/**
 * {@link getPlatformSettings} as a read of a combined statement (`readTogether`). The value is read as its JSON text,
 * so a setting stored as a JSON string decodes the same whichever way the statement is run.
 */
export function platformSettingsPart(): ReadPart<ResolvedPlatformSettings> {
  const part = rowsPart('SELECT key, value::text AS value FROM platform_settings', {}, (r) => ({
    key: col.text.decode(r.key, 'key'),
    value: col.json().decode(r.value, 'value'),
  }));
  return { ...part, decode: (rows) => resolveSettings(part.decode(rows)) };
}

function resolveSettings(rows: readonly { key: string; value: unknown }[]): ResolvedPlatformSettings {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out: Record<string, unknown> = {};
  for (const [field, key] of Object.entries(SETTING_KEYS)) {
    const fieldSchema = Coerced.shape[field as keyof typeof Coerced.shape];
    const parsed = fieldSchema.safeParse(byKey.get(key));
    out[field] = parsed.success ? parsed.data : DEFAULT_SETTINGS[field as keyof PlatformSettingsValue];
  }
  return PlatformSettingsView.required().parse(out);
}

/**
 * Applies a validated partial update (system executor; the caller has verified platform_admin).
 * Returns the full settings after the update.
 */
export async function updatePlatformSettings(
  sx: SystemExecutor,
  patch: Partial<PlatformSettingsValue>,
  updatedBy: string | null,
): Promise<ResolvedPlatformSettings> {
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
