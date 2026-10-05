import { z } from 'zod';

/**
 * Core configuration. The API builds it once per container (`loadConfig(process.env)`) and passes it to
 * `createCore`; nothing else in packages/core reads the environment. Values have production defaults;
 * tests override individual fields with `coreConfig({...})`.
 */
export const CoreConfig = z.object({
  appEnv: z.enum(['production', 'development', 'test']),
  appVersion: z.string().min(1).max(64),
  homeTenantSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  /** Public origin of the web app (CloudFront), e.g. https://foundry.example.edu. */
  siteOrigin: z.url().nullable(),
  session: z.object({
    /** Session JWT lifetime (12 h). */
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 86_400),
    /** How long verified session revocation state is cached in memory (60 s). */
    revocationCacheSeconds: z.number().int().min(0).max(600),
    /** Retired signing keys stay valid for verification this long (≥ ttl so rotation never logs anyone out). */
    keyGraceSeconds: z.number().int().min(0),
    /** Maximum cached sessions per container. */
    cacheMaxEntries: z.number().int().min(1).max(1_000_000),
  }),
  signIn: z.object({
    /** Failed attempts per hashed viewer IP within the window before lockout (10). */
    ipFailureLimit: z.number().int().min(1),
    /** Sliding window and lockout length (15 min). */
    ipWindowSeconds: z.number().int().min(60),
    /**
     * Global soft limit: when platform-wide failures in the window reach this, viewers that already
     * failed at least once in the window are rate limited (fresh viewers are unaffected).
     */
    globalSoftLimit: z.number().int().min(1),
    globalRetryAfterSeconds: z.number().int().min(1),
  }),
  turns: z.object({
    /** Per-principal rate limit: turns per window (20 / 10 min). */
    rateLimit: z.number().int().min(1),
    rateWindowSeconds: z.number().int().min(1),
    /** Share of ordinary turns sampled for EIR calibration review (all high-risk turns are sampled). */
    reviewSampleRate: z.number().min(0).max(1),
    /** Input token budget for the assembled prompt (12k). */
    maxInputTokens: z.number().int().min(1_000),
    /** Earlier turns included as conversation context (8). */
    historyTurns: z.number().int().min(0).max(50),
    /** Turn generation budget for the primary model (the gateway adds the fallback budget). */
    modelTimeoutMs: z.number().int().min(1_000).max(60_000),
  }),
  retrieval: z.object({
    memory: z.number().int().min(0).max(50),
    chunks: z.number().int().min(0).max(50),
    doctrine: z.number().int().min(0).max(50),
    resources: z.number().int().min(0).max(50),
    patterns: z.number().int().min(0).max(50),
  }),
  ingestion: z.object({
    /** Target chunk size in (estimated) tokens (~800). */
    chunkTokens: z.number().int().min(50).max(4_000),
    /** Overlap between consecutive chunks of a section (15 %). */
    overlapRatio: z.number().min(0).max(0.5),
    /** Texts per embedding call. */
    embedBatchSize: z.number().int().min(1).max(256),
    /** Hard cap on chunks per document. */
    maxChunks: z.number().int().min(1).max(10_000),
  }),
  uploads: z.object({
    /** Lifetime of presigned upload URLs (5 min: short enough that a leaked URL is near-useless). */
    presignTtlSeconds: z.number().int().min(60).max(3_600),
  }),
  escalations: z.object({
    /** IANA time zone used for "1 business day" due dates. */
    businessTimeZone: z.string().min(1),
  }),
});
export type CoreConfig = z.infer<typeof CoreConfig>;

export const DEFAULT_CORE_CONFIG: CoreConfig = {
  appEnv: 'development',
  appVersion: '0.0.0-dev',
  homeTenantSlug: 'ain',
  siteOrigin: null,
  session: {
    ttlSeconds: 12 * 3_600,
    revocationCacheSeconds: 60,
    keyGraceSeconds: 12 * 3_600,
    cacheMaxEntries: 10_000,
  },
  signIn: { ipFailureLimit: 10, ipWindowSeconds: 15 * 60, globalSoftLimit: 500, globalRetryAfterSeconds: 60 },
  turns: {
    rateLimit: 20,
    rateWindowSeconds: 10 * 60,
    reviewSampleRate: 0.3,
    maxInputTokens: 12_000,
    historyTurns: 8,
    modelTimeoutMs: 25_000,
  },
  retrieval: { memory: 8, chunks: 6, doctrine: 4, resources: 4, patterns: 2 },
  ingestion: { chunkTokens: 800, overlapRatio: 0.15, embedBatchSize: 16, maxChunks: 2_000 },
  uploads: { presignTtlSeconds: 5 * 60 },
  escalations: { businessTimeZone: 'America/New_York' },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

/** Validated configuration from defaults plus overrides (tests, local tooling). */
export function coreConfig(overrides: DeepPartial<CoreConfig> = {}): CoreConfig {
  const merged: Record<string, unknown> = { ...DEFAULT_CORE_CONFIG };
  for (const [key, value] of Object.entries(overrides)) {
    const base = (DEFAULT_CORE_CONFIG as Record<string, unknown>)[key];
    merged[key] =
      value !== null && typeof value === 'object' && base !== null && typeof base === 'object'
        ? { ...base, ...value }
        : value;
  }
  return CoreConfig.parse(merged);
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
}

function intFrom(env: EnvLike, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`environment variable ${name} must be a number`);
  return value;
}

/**
 * The single place where packages/core reads environment variables (runtime contract): APP_ENV,
 * APP_VERSION, HOME_TENANT_SLUG, SITE_ORIGIN, plus optional tuning knobs
 * (CORE_TURN_RATE_LIMIT, CORE_REVIEW_SAMPLE_RATE_PCT, CORE_SESSION_CACHE_SECONDS).
 */
export function loadConfig(env: EnvLike): CoreConfig {
  const appEnv = env.APP_ENV ?? 'development';
  const siteOrigin = env.SITE_ORIGIN?.trim();
  return coreConfig({
    appEnv: appEnv as CoreConfig['appEnv'],
    appVersion: nonEmpty(env.APP_VERSION) ?? DEFAULT_CORE_CONFIG.appVersion,
    homeTenantSlug: nonEmpty(env.HOME_TENANT_SLUG) ?? DEFAULT_CORE_CONFIG.homeTenantSlug,
    siteOrigin: siteOrigin ? siteOrigin.replace(/\/+$/, '') : null,
    session: {
      revocationCacheSeconds: intFrom(
        env,
        'CORE_SESSION_CACHE_SECONDS',
        DEFAULT_CORE_CONFIG.session.revocationCacheSeconds,
      ),
    },
    turns: {
      rateLimit: intFrom(env, 'CORE_TURN_RATE_LIMIT', DEFAULT_CORE_CONFIG.turns.rateLimit),
      reviewSampleRate:
        intFrom(env, 'CORE_REVIEW_SAMPLE_RATE_PCT', DEFAULT_CORE_CONFIG.turns.reviewSampleRate * 100) / 100,
    },
  });
}
