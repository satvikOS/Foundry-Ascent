import { readFileSync } from 'node:fs';

/** Production's deploy configuration, whose `homeTenant.ownerReleases` the deploy's seed applies (ADR-0021). */
export const PRODUCTION_CONFIG = new URL('../../../../infra/cdk/config/production.json', import.meta.url);

export interface LocalOwnerReleases {
  /** The value handed to `parseOwnerReleases`: comma-separated release keys, or empty for none. */
  readonly raw: string;
  /** `env`: SEED_OWNER_RELEASES was set (an empty value means none); `production`: production's configuration. */
  readonly source: 'env' | 'production';
}

/**
 * The owner releases a local reset applies: `SEED_OWNER_RELEASES` when it is set (empty = none, e.g. to look at the
 * seeded twin), else exactly the ones production's deploy applies (`infra/cdk/config/production.json` →
 * `homeTenant.ownerReleases`, the same value CI's e2e job and the lab workflows read). So a local stack, a demo
 * recorded from it and CI all meet the persona students meet in production (Thomas, ADR-0021).
 */
export function localOwnerReleases(
  env: Readonly<Record<string, string | undefined>>,
  readConfig: () => string = () => readFileSync(PRODUCTION_CONFIG, 'utf8'),
): LocalOwnerReleases {
  const fromEnv = env.SEED_OWNER_RELEASES;
  if (fromEnv !== undefined) return { raw: fromEnv, source: 'env' };
  let config: unknown;
  try {
    config = JSON.parse(readConfig());
  } catch {
    throw new Error(
      'could not read infra/cdk/config/production.json for its owner releases (set SEED_OWNER_RELEASES to choose them)',
    );
  }
  const releases =
    typeof config === 'object' && config !== null
      ? (config as { homeTenant?: { ownerReleases?: unknown } }).homeTenant?.ownerReleases
      : undefined;
  if (releases === undefined) return { raw: '', source: 'production' };
  if (!Array.isArray(releases) || !releases.every((key): key is string => typeof key === 'string')) {
    throw new Error(
      'infra/cdk/config/production.json homeTenant.ownerReleases must be a list of release keys',
    );
  }
  return { raw: releases.join(','), source: 'production' };
}
