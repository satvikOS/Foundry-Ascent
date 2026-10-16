/**
 * Deployment configuration: `config/production.json`, validated at synth time so a malformed value fails
 * `cdk synth` with a precise message instead of producing a template that fails half-way through a deploy.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_DB_RESUME_BUDGET_SECONDS, API_TIMING_MARGIN_SECONDS } from './lib/constants.js';
import { INFRA_ROOT } from './paths.js';

export interface PlatformConfig {
  readonly region: 'us-east-1';
  /** `owner/repo` of the GitHub repository allowed to assume the deploy role. */
  readonly githubRepository: string;
  /**
   * Immutable numeric ids of the repository owner and the repository. GitHub's OIDC `sub` claim pins them
   * (`repo:<owner>@<ownerId>/<repo>@<repoId>:…`), so a later repository reusing the name cannot match.
   */
  readonly githubOwnerId: string;
  readonly githubRepositoryId: string;
  readonly githubBranch: string;
  readonly homeTenant: { readonly slug: string; readonly name: string };
  readonly owner: {
    readonly displayName: string;
    readonly accessCodePrefix: string;
    readonly accessCodeHash: string;
  };
  readonly models: {
    /** Reasoning model while Luna is disabled (a Bedrock inference profile id, e.g. `us.amazon.nova-2-lite-v1:0`). */
    readonly primary: string;
    readonly fallback: string;
    readonly embeddings: string;
    /** GPT-6 Luna on Bedrock Mantle, gated per account by AWS. See lib/models.ts for how it is applied. */
    readonly luna?: { readonly modelId: string; readonly enabled: boolean };
  };
  readonly aurora: {
    readonly minCapacityAcu: number;
    readonly maxCapacityAcu: number;
    readonly autoPauseMinutes: number;
    readonly engineVersion: string;
  };
  readonly api: {
    /**
     * Reserved concurrency of the API function, or null for none (the unreserved account pool). Optional
     * in the file: accounts with a total concurrency quota of 10 cannot reserve any. The daily AI spend
     * caps in platform_settings remain the cost guardrail either way.
     */
    readonly reservedConcurrency: number | null;
    readonly memoryMb: number;
    readonly timeoutSeconds: number;
  };
  readonly worker: {
    /** Reserved concurrency of the jobs worker, or null for none (default). */
    readonly reservedConcurrency: number | null;
  };
  /**
   * Live voice calls (ADR-0010): the browser streams the founder's speech to Amazon Transcribe over a URL the
   * API presigns, and the API speaks validated vEIR text with Amazon Polly. Optional in the file; absent
   * means off (no Polly or Transcribe permission, no speech alarms, `SPEECH_ENABLED=false`).
   */
  readonly speech: {
    readonly enabled: boolean;
    /** Polly voice id for personas without a consented voice of their own; must exist for `engine`. */
    readonly defaultVoice: string;
    /** Polly engine: `neural` (default: faster, half the price) or `generative` (see ADR-0010). */
    readonly engine: SpeechEngine;
    /**
     * Polly spend per day (USD) above which the daily speech alarm fires: the global daily AI cap
     * (`platform_settings.daily_usd_cap_global`), which speech is metered against. Keep the two in step.
     */
    readonly dailyAlarmUsd: number;
  };
  /**
   * Knowledge-pool growth (ADR-0018). Distillation is driven by jobs the API enqueues (a delayed message
   * after each turn, one at session end) plus the daily maintenance backstop. The optional sweep schedule
   * asks the worker every `sweepIntervalMinutes` to distill idle conversations itself; it ships disabled,
   * because a query every 15 minutes would keep Aurora from pausing. Absent means disabled.
   */
  readonly distillation: {
    readonly sweepEnabled: boolean;
    readonly sweepIntervalMinutes: number;
  };
  readonly logRetentionDays: number;
}

/** Polly engines the call pipeline supports (standard voices sound robotic; long-form is not real-time). */
export const SPEECH_ENGINES = ['neural', 'generative'] as const;
export type SpeechEngine = (typeof SPEECH_ENGINES)[number];

/**
 * Adult US-English Amazon Polly voices per engine, all available in us-east-1 (Polly developer guide,
 * "Available voices", checked 2026-10-16). A default voice the engine lacks would fail every
 * SynthesizeSpeech call at runtime (ValidationException), so synth refuses it.
 */
export const POLLY_EN_US_VOICES: Readonly<Record<SpeechEngine, readonly string[]>> = {
  neural: [
    'Danielle',
    'Gregory',
    'Joanna',
    'Joey',
    'Kendra',
    'Kimberly',
    'Matthew',
    'Ruth',
    'Salli',
    'Stephen',
  ],
  generative: ['Danielle', 'Joanna', 'Matthew', 'Ruth', 'Salli', 'Stephen', 'Tiffany'],
};

/** Used when `speech` is absent from the file: speech off; the voice, engine and alarm are then never used. */
const SPEECH_OFF = { enabled: false, defaultVoice: 'Matthew', engine: 'neural', dailyAlarmUsd: 15 } as const;
/** Used when `distillation` is absent from the file. */
const DISTILLATION_OFF = { sweepEnabled: false, sweepIntervalMinutes: 15 } as const;

export const CONFIG_FILE = join(INFRA_ROOT, 'config', 'production.json');

/** Smallest API Lambda timeout: the database resume budget (40 s) plus the timing margin (15 s). */
export const MIN_API_TIMEOUT_SECONDS = API_DB_RESUME_BUDGET_SECONDS + API_TIMING_MARGIN_SECONDS;

/** Crockford base32 group, as used by access codes (`FA-AAAAA-…`). */
const CROCKFORD_GROUP = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$/;
/** `scrypt$N=32768,r=8,p=1$<salt b64url>$<32-byte key b64url>` (runtime contract). */
const SCRYPT_HASH = /^scrypt\$N=32768,r=8,p=1\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{43}$/;
const SLUG = /^[a-z][a-z0-9-]{1,62}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9.:-]{2,127}$/;
const GITHUB_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const GIT_REF_NAME = /^[A-Za-z0-9._/-]+$/;
const GITHUB_ID = /^[1-9][0-9]{0,19}$/;

export class ConfigError extends Error {
  constructor(path: string, problem: string) {
    super(`${CONFIG_FILE}: ${path} ${problem}`);
    this.name = 'ConfigError';
  }
}

type Json = Record<string, unknown>;

function obj(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(path, 'must be an object');
  }
  return value as Json;
}

function str(parent: Json, key: string, path: string, pattern?: RegExp): string {
  const value = parent[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new ConfigError(`${path}.${key}`, 'must be a non-empty string');
  if (pattern && !pattern.test(value))
    throw new ConfigError(`${path}.${key}`, `does not match ${String(pattern)}`);
  return value;
}

function int(parent: Json, key: string, path: string, min: number, max: number): number {
  const value = parent[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${path}.${key}`, `must be an integer in [${min}, ${max}]`);
  }
  return value;
}

/** Aurora Serverless v2 capacity is set in 0.5 ACU steps. */
function acu(parent: Json, key: string, path: string, min: number, max: number): number {
  const value = parent[key];
  if (typeof value !== 'number' || value < min || value > max || !Number.isInteger(value * 2)) {
    throw new ConfigError(`${path}.${key}`, `must be a multiple of 0.5 in [${min}, ${max}]`);
  }
  return value;
}

/** Values accepted by CloudWatch Logs `RetentionInDays`. */
const LOG_RETENTION_DAYS = new Set([
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653,
]);

/** `null` or absent → null (no reservation); otherwise an integer in [min, max]. */
function optionalInt(parent: Json, key: string, path: string, min: number, max: number): number | null {
  if (parent[key] === undefined || parent[key] === null) return null;
  return int(parent, key, path, min, max);
}

/** A positive amount in USD with at most cent precision, no larger than `max`. */
function usd(parent: Json, key: string, path: string, max: number): number {
  const value = parent[key];
  const cents = typeof value === 'number' ? value * 100 : Number.NaN;
  if (
    typeof value !== 'number' ||
    !(value > 0) ||
    value > max ||
    Math.abs(cents - Math.round(cents)) > 1e-9
  ) {
    throw new ConfigError(
      `${path}.${key}`,
      `must be a USD amount (at most two decimals) in (0, ${String(max)}]`,
    );
  }
  return value;
}

function bool(parent: Json, key: string, path: string): boolean {
  const value = parent[key];
  if (typeof value !== 'boolean') throw new ConfigError(`${path}.${key}`, 'must be a boolean');
  return value;
}

function parseLuna(raw: unknown): { modelId: string; enabled: boolean } {
  const luna = obj(raw, '$.models.luna');
  return {
    modelId: str(luna, 'modelId', '$.models.luna', MODEL_ID),
    enabled: bool(luna, 'enabled', '$.models.luna'),
  };
}

function parseSpeech(raw: unknown): PlatformConfig['speech'] {
  if (raw === undefined) return SPEECH_OFF;
  const speech = obj(raw, '$.speech');
  const engineName = str(speech, 'engine', '$.speech');
  if (!(SPEECH_ENGINES as readonly string[]).includes(engineName)) {
    throw new ConfigError('$.speech.engine', `must be one of ${SPEECH_ENGINES.join(', ')}`);
  }
  const engine = engineName as SpeechEngine;
  const defaultVoice = str(speech, 'defaultVoice', '$.speech');
  const voices = POLLY_EN_US_VOICES[engine];
  if (!voices.includes(defaultVoice)) {
    throw new ConfigError(
      '$.speech.defaultVoice',
      `is not a US-English ${engine} voice (one of ${voices.join(', ')})`,
    );
  }
  return {
    enabled: bool(speech, 'enabled', '$.speech'),
    defaultVoice,
    engine,
    // The admin settings accept a global daily cap of at most USD 100.
    dailyAlarmUsd: usd(speech, 'dailyAlarmUsd', '$.speech', 100),
  };
}

function parseDistillation(raw: unknown): PlatformConfig['distillation'] {
  if (raw === undefined) return DISTILLATION_OFF;
  const distillation = obj(raw, '$.distillation');
  return {
    sweepEnabled: bool(distillation, 'sweepEnabled', '$.distillation'),
    // Faster than every 5 minutes buys nothing (a conversation counts as idle after 20); slower than hourly
    // leaves the notebook stale for the founder's next visit.
    sweepIntervalMinutes: int(distillation, 'sweepIntervalMinutes', '$.distillation', 5, 60),
  };
}

export function parseConfig(raw: unknown): PlatformConfig {
  const root = obj(raw, '$');
  const region = str(root, 'region', '$');
  if (region !== 'us-east-1')
    throw new ConfigError('$.region', 'must be us-east-1 (Luna on Bedrock Mantle is us-east-1 only)');

  const homeTenant = obj(root.homeTenant, '$.homeTenant');
  const owner = obj(root.owner, '$.owner');
  const models = obj(root.models, '$.models');
  const aurora = obj(root.aurora, '$.aurora');
  const api = obj(root.api, '$.api');
  const worker = root.worker === undefined ? {} : obj(root.worker, '$.worker');

  const minCapacityAcu = acu(aurora, 'minCapacityAcu', '$.aurora', 0, 256);
  const maxCapacityAcu = acu(aurora, 'maxCapacityAcu', '$.aurora', 1, 256);
  if (maxCapacityAcu < minCapacityAcu)
    throw new ConfigError('$.aurora.maxCapacityAcu', 'must be >= minCapacityAcu');

  const logRetentionDays = int(root, 'logRetentionDays', '$', 1, 3653);
  if (!LOG_RETENTION_DAYS.has(logRetentionDays)) {
    throw new ConfigError('$.logRetentionDays', 'is not a CloudWatch Logs retention value');
  }

  return {
    region,
    githubRepository: str(root, 'githubRepository', '$', GITHUB_REPO),
    githubOwnerId: str(root, 'githubOwnerId', '$', GITHUB_ID),
    githubRepositoryId: str(root, 'githubRepositoryId', '$', GITHUB_ID),
    githubBranch: str(root, 'githubBranch', '$', GIT_REF_NAME),
    homeTenant: {
      slug: str(homeTenant, 'slug', '$.homeTenant', SLUG),
      name: str(homeTenant, 'name', '$.homeTenant'),
    },
    owner: {
      displayName: str(owner, 'displayName', '$.owner'),
      accessCodePrefix: str(owner, 'accessCodePrefix', '$.owner', CROCKFORD_GROUP),
      accessCodeHash: str(owner, 'accessCodeHash', '$.owner', SCRYPT_HASH),
    },
    models: {
      primary: str(models, 'primary', '$.models', MODEL_ID),
      fallback: str(models, 'fallback', '$.models', MODEL_ID),
      embeddings: str(models, 'embeddings', '$.models', MODEL_ID),
      ...(models.luna === undefined ? {} : { luna: parseLuna(models.luna) }),
    },
    aurora: {
      minCapacityAcu,
      maxCapacityAcu,
      // Aurora accepts auto-pause between 5 minutes and 24 hours.
      autoPauseMinutes: int(aurora, 'autoPauseMinutes', '$.aurora', 5, 1440),
      engineVersion: str(aurora, 'engineVersion', '$.aurora', /^\d+\.\d+$/),
    },
    api: {
      reservedConcurrency: optionalInt(api, 'reservedConcurrency', '$.api', 1, 1000),
      memoryMb: int(api, 'memoryMb', '$.api', 128, 10240),
      // At least the API's database resume budget plus headroom, so a request that waited for Aurora to
      // resume can still finish (or answer 503) before Lambda stops it; see README "Timeouts".
      timeoutSeconds: int(api, 'timeoutSeconds', '$.api', MIN_API_TIMEOUT_SECONDS, 120),
    },
    worker: {
      reservedConcurrency: optionalInt(worker, 'reservedConcurrency', '$.worker', 1, 1000),
    },
    speech: parseSpeech(root.speech),
    distillation: parseDistillation(root.distillation),
    logRetentionDays,
  };
}

export function loadConfig(file: string = CONFIG_FILE): PlatformConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : 'unknown error'}`, {
      cause: error,
    });
  }
  return parseConfig(raw);
}
