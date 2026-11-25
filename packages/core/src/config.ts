import { UNDERSTAND_TIMEOUT_MS } from '@foundry/ai';
import { z } from 'zod';

import { THINK_MODES, type ThinkMode } from './orchestrator/think.js';

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
    /**
     * Viewers this container remembers as locked out (in memory, keyed by a keyed hash of the IP or IPv6
     * /64): their attempts are refused before any database call until the lockout ends (10 000).
     */
    lockoutCacheEntries: z.number().int().min(0).max(1_000_000),
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
    /**
     * Turns one principal may have being answered at once (3). Admission is serialised per principal, and
     * spend is only recorded once a turn's model call returns, so this bounds how far parallel turns can
     * overshoot the daily spend caps.
     */
    maxInFlight: z.number().int().min(1).max(50),
    /** A pending turn older than this belongs to a request that died and no longer counts (120 s). */
    inFlightWindowSeconds: z.number().int().min(30).max(3_600),
    /** Share of ordinary turns sampled for EIR calibration review (all high-risk turns are sampled). */
    reviewSampleRate: z.number().min(0).max(1),
    /** Input token budget for the assembled prompt (12k). */
    maxInputTokens: z.number().int().min(1_000),
    /** Earlier turns included as conversation context (8). */
    historyTurns: z.number().int().min(0).max(50),
    /** Turn generation budget for the primary model (the gateway adds the fallback budget). */
    modelTimeoutMs: z.number().int().min(1_000).max(60_000),
    /**
     * Log the streamed reply's raw text and the units the gate left out (`turn.phase_a`). The conversation lab only
     * (`LAB_TRACE_STREAM=1`, synthetic data, sealed logs); never in production, whatever the environment says.
     */
    traceStreamText: z.boolean(),
    /**
     * The model-based safety screen (orchestrator/safety-screen.ts): a message the ideation prefilter flags and the
     * crisis rules do not is read by one short model call once the turn is admitted. Off by default
     * (`CORE_SAFETY_SCREEN=on|off`): off, a turn runs exactly as without the screen (no call, no wait). The
     * conversation lab turns it on; production waits for its evaluation on the real model (docs/runbooks/
     * conversation-lab.md, "Safety screen evaluation").
     */
    safetyScreen: z.boolean(),
    /**
     * The founder path decides every coaching turn's step (core `path/`; `CORE_FOUNDER_PATH=on|off`, on by default): off,
     * a turn runs without one (no guidance, no step in the prompt, nothing stored), as before the path.
     */
    founderPath: z.boolean(),
    /**
     * An ask no rule of the playbook names is matched by meaning (core `path/semantic.ts`; `CORE_SEMANTIC_PLAYS=on|off`,
     * on by default): off, the rules alone choose a play.
     */
    semanticPlays: z.boolean(),
    /**
     * Shared notes near the founder's own words are evidence of a turn that asks something, whatever the topics and the
     * vocabulary say of it (`retrievalRepo.SEMANTIC_ADMISSION`; `CORE_SEMANTIC_NOTES=on|off`, on by default): off, the
     * gates alone bring notes.
     */
    semanticNotes: z.boolean(),
    /**
     * A typed turn's notes are chosen by a reranker when the gateway has one (`MODEL_RERANK_ID`; `CORE_RERANK=on|off`,
     * off by default), within 600 ms (`RERANK_TIMEOUT_MS`); never a call's.
     */
    rerank: z.boolean(),
    /**
     * A message is read against the record by a short structured call before the path decides (orchestrator/understand.ts;
     * `CORE_UNDERSTAND=on|off`, off by default): off, the rules alone read it, as before.
     */
    understand: z.boolean(),
    /**
     * How long a turn waits for that reading, by channel (`CORE_UNDERSTAND_TYPED_MS`, `CORE_UNDERSTAND_VOICE_MS`): the parts
     * that are in by then are used.
     */
    understandTypedMs: z.number().int().min(500).max(10_000),
    understandVoiceMs: z.number().int().min(500).max(5_000),
    /**
     * Which typed turns let the model reason before it answers (orchestrator/think.ts; `CORE_THINK=off|judgement|typed`,
     * off by default): a model that cannot (any but Amazon Nova 2) answers as always.
     */
    think: z.enum(THINK_MODES),
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
  maintenance: z.object({
    /** An ephemeral session nobody wrote in for this long is ended and its content erased (24 h). */
    ephemeralIdleSeconds: z
      .number()
      .int()
      .min(3_600)
      .max(30 * 86_400),
  }),
  distillation: z
    .object({
      /**
       * Delay of the distillation queued after every completed turn (9 min, inside Aurora's auto-pause window,
       * 30 minutes in production, so the job finds the database awake). Each turn queues its own job; only the last one of
       * a conversation finds it idle.
       */
      turnDelaySeconds: z.number().int().min(1).max(900),
      /**
       * A conversation with a turn this recent is still active (8 min): a delayed job skips it, because the
       * job queued by the later turn covers it.
       */
      activeWindowSeconds: z.number().int().min(0).max(3_600),
      /**
       * Starting a conversation distils the person's previous one at once when its last turn is older than this
       * (60 s), even inside the active window: they moved on, and their next call must find it distilled.
       */
      settleGraceSeconds: z.number().int().min(0).max(3_600),
      /** Conversations one backstop run (daily maintenance, or the sweep message) distils at most (50). */
      backstopBatch: z.number().int().min(1).max(500),
    })
    .refine((d) => d.activeWindowSeconds < d.turnDelaySeconds, {
      message: 'activeWindowSeconds must be shorter than turnDelaySeconds',
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
  signIn: {
    lockoutCacheEntries: 10_000,
    ipFailureLimit: 10,
    ipWindowSeconds: 15 * 60,
    globalSoftLimit: 500,
    globalRetryAfterSeconds: 60,
  },
  turns: {
    rateLimit: 20,
    rateWindowSeconds: 10 * 60,
    maxInFlight: 3,
    inFlightWindowSeconds: 120,
    reviewSampleRate: 0.3,
    maxInputTokens: 16_000,
    // Live pilot 42099643194: sessions ran to 27 turns, and with 8 in view the coach re-asked what was answered before.
    historyTurns: 12,
    modelTimeoutMs: 25_000,
    traceStreamText: false,
    safetyScreen: false,
    founderPath: true,
    semanticPlays: true,
    semanticNotes: true,
    rerank: false,
    understand: false,
    understandTypedMs: UNDERSTAND_TIMEOUT_MS.text,
    understandVoiceMs: UNDERSTAND_TIMEOUT_MS.voice,
    think: 'off',
  },
  // The persona's library gives two items, not four (live pilot 42099643194: its method notes were injected on almost
  // every turn, whatever the topic, and replies on grants, leases and tutoring cited the interview guide). The path's
  // play is the turn's first evidence, so the rest is what the founder's record and one or two passages add to it
  // (2026-11-24: a typed turn carried about 3,100 tokens of evidence).
  retrieval: { memory: 6, chunks: 3, doctrine: 2, resources: 1, patterns: 1 },
  ingestion: { chunkTokens: 800, overlapRatio: 0.15, embedBatchSize: 16, maxChunks: 2_000 },
  uploads: { presignTtlSeconds: 5 * 60 },
  escalations: { businessTimeZone: 'America/New_York' },
  maintenance: { ephemeralIdleSeconds: 24 * 3_600 },
  distillation: {
    turnDelaySeconds: 540,
    activeWindowSeconds: 480,
    settleGraceSeconds: 60,
    backstopBatch: 50,
  },
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

/** An `on`/`off` switch (unset or empty: `fallback`); any other value is a configuration error. */
function switchFrom(env: EnvLike, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  throw new Error(`environment variable ${name} must be on or off`);
}

/** `CORE_THINK` (unset or empty: off); any other value is a configuration error. */
function thinkFrom(env: EnvLike): ThinkMode {
  const raw = env.CORE_THINK?.trim().toLowerCase();
  if (raw === undefined || raw === '') return DEFAULT_CORE_CONFIG.turns.think;
  const mode = THINK_MODES.find((m) => m === raw);
  if (mode === undefined)
    throw new Error(`environment variable CORE_THINK must be ${THINK_MODES.join(', ')}`);
  return mode;
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
 * (CORE_TURN_RATE_LIMIT, CORE_REVIEW_SAMPLE_RATE_PCT, CORE_SESSION_CACHE_SECONDS, CORE_SAFETY_SCREEN=on|off,
 * CORE_FOUNDER_PATH=on|off, CORE_SEMANTIC_PLAYS=on|off, CORE_SEMANTIC_NOTES=on|off, CORE_RERANK=on|off,
 * CORE_UNDERSTAND=on|off with CORE_UNDERSTAND_TYPED_MS and CORE_UNDERSTAND_VOICE_MS, CORE_THINK=off|judgement|typed, and
 * for local demos CORE_DISTILL_DELAY_SECONDS / CORE_DISTILL_ACTIVE_SECONDS).
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
      traceStreamText: env.LAB_TRACE_STREAM === '1' && appEnv !== 'production',
      safetyScreen: switchFrom(env, 'CORE_SAFETY_SCREEN', DEFAULT_CORE_CONFIG.turns.safetyScreen),
      founderPath: switchFrom(env, 'CORE_FOUNDER_PATH', DEFAULT_CORE_CONFIG.turns.founderPath),
      semanticPlays: switchFrom(env, 'CORE_SEMANTIC_PLAYS', DEFAULT_CORE_CONFIG.turns.semanticPlays),
      semanticNotes: switchFrom(env, 'CORE_SEMANTIC_NOTES', DEFAULT_CORE_CONFIG.turns.semanticNotes),
      rerank: switchFrom(env, 'CORE_RERANK', DEFAULT_CORE_CONFIG.turns.rerank),
      understand: switchFrom(env, 'CORE_UNDERSTAND', DEFAULT_CORE_CONFIG.turns.understand),
      understandTypedMs: intFrom(
        env,
        'CORE_UNDERSTAND_TYPED_MS',
        DEFAULT_CORE_CONFIG.turns.understandTypedMs,
      ),
      understandVoiceMs: intFrom(
        env,
        'CORE_UNDERSTAND_VOICE_MS',
        DEFAULT_CORE_CONFIG.turns.understandVoiceMs,
      ),
      think: thinkFrom(env),
    },
    distillation: {
      turnDelaySeconds: intFrom(
        env,
        'CORE_DISTILL_DELAY_SECONDS',
        DEFAULT_CORE_CONFIG.distillation.turnDelaySeconds,
      ),
      activeWindowSeconds: intFrom(
        env,
        'CORE_DISTILL_ACTIVE_SECONDS',
        DEFAULT_CORE_CONFIG.distillation.activeWindowSeconds,
      ),
    },
  });
}
