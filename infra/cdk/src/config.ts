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
  readonly logRetentionDays: number;
}

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

function parseLuna(raw: unknown): { modelId: string; enabled: boolean } {
  const luna = obj(raw, '$.models.luna');
  if (typeof luna.enabled !== 'boolean') throw new ConfigError('$.models.luna.enabled', 'must be a boolean');
  return { modelId: str(luna, 'modelId', '$.models.luna', MODEL_ID), enabled: luna.enabled };
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
