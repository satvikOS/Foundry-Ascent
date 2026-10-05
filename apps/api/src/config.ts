import { CoreConfig, loadConfig, type EnvLike } from '@foundry/core';
import { z } from 'zod';

/**
 * Runtime configuration of the API package (system design §2, runtime contract). Every handler loads it
 * once per container with {@link loadApiConfig}; nothing else in apps/api reads `process.env` except the
 * packages' own loaders (`dbConfigFromEnv`, `modelGatewayConfigFromEnv`, `seedConfigFromEnv`, core
 * `loadConfig`), which read the same variables.
 */

/** Which process is loading the configuration: decides which variables are mandatory. */
export type ApiRole = 'api' | 'worker' | 'migrate' | 'dev';

export const LogLevel = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevel>;

/** Presigned upload lifetime (5 minutes): short enough that a leaked URL is near-useless. */
export const UPLOAD_URL_TTL_SECONDS = 300;
/** Largest JSON request body accepted by the API (documents go straight to S3, never through it). */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
const optionalText = z.preprocess(emptyToUndefined, z.string().trim().optional());

const EnvSchema = z.object({
  APP_ENV: z.preprocess(
    emptyToUndefined,
    z.enum(['production', 'development', 'test']).default('development'),
  ),
  APP_VERSION: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(64).default('0.0.0-dev')),
  LOG_LEVEL: z.preprocess(
    (v) => (typeof emptyToUndefined(v) === 'string' ? String(v).trim().toLowerCase() : undefined),
    LogLevel.default('info'),
  ),
  AWS_REGION: optionalText,
  BEDROCK_REGION: optionalText,
  DOCUMENTS_BUCKET: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be an S3 bucket name')
      .optional(),
  ),
  JOBS_QUEUE_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  /** The jobs queue's redrive maxReceiveCount (last attempt marks a document failed). */
  JOBS_MAX_RECEIVE_COUNT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(1000).default(3)),
  SITE_ORIGIN: z.preprocess(emptyToUndefined, z.url().optional()),
});

export interface ApiConfig {
  readonly appEnv: 'production' | 'development' | 'test';
  readonly appVersion: string;
  readonly logLevel: LogLevel;
  /** Region of the S3 bucket and SQS queue (the Lambda runtime sets AWS_REGION). */
  readonly awsRegion: string;
  readonly documentsBucket: string | null;
  readonly jobsQueueUrl: string | null;
  readonly jobsMaxReceiveCount: number;
  /** Public origin of the SPA when statically known (custom domain); otherwise derived per request. */
  readonly siteOrigin: string | null;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Parses and validates the environment. Error messages name variables, never their values.
 * `api` needs DOCUMENTS_BUCKET and JOBS_QUEUE_URL; `worker` needs DOCUMENTS_BUCKET.
 */
export function loadApiConfig(env: EnvLike, role: ApiRole): ApiConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new ConfigError(`Invalid environment: ${names}`);
  }
  const e = parsed.data;
  const missing: string[] = [];
  if ((role === 'api' || role === 'worker') && e.DOCUMENTS_BUCKET === undefined)
    missing.push('DOCUMENTS_BUCKET');
  if (role === 'api' && e.JOBS_QUEUE_URL === undefined) missing.push('JOBS_QUEUE_URL');
  if (missing.length > 0) throw new ConfigError(`Missing required environment: ${missing.join(', ')}`);
  return {
    appEnv: e.APP_ENV,
    appVersion: e.APP_VERSION,
    logLevel: e.LOG_LEVEL,
    awsRegion: e.AWS_REGION ?? e.BEDROCK_REGION ?? 'us-east-1',
    documentsBucket: e.DOCUMENTS_BUCKET ?? null,
    jobsQueueUrl: e.JOBS_QUEUE_URL ?? null,
    jobsMaxReceiveCount: e.JOBS_MAX_RECEIVE_COUNT,
    siteOrigin: e.SITE_ORIGIN?.replace(/\/+$/, '') ?? null,
  };
}

/** A value `loadApiConfig` already required for the process role (narrows the type). */
export function required<T>(value: T | null, name: string): T {
  if (value === null) throw new ConfigError(`Missing required environment: ${name}`);
  return value;
}

/**
 * Core configuration for the API: core's own `loadConfig` plus the API's upload policy (5-minute
 * presigned URLs).
 */
export function loadCoreConfig(env: EnvLike): CoreConfig {
  const base = loadConfig(env);
  return CoreConfig.parse({
    ...base,
    uploads: { ...base.uploads, presignTtlSeconds: UPLOAD_URL_TTL_SECONDS },
  });
}
