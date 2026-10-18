import { CoreConfig, MEDIA_VENDORS, loadConfig, type EnvLike } from '@foundry/core';
import { z } from 'zod';

/**
 * Runtime configuration of the API package (system design §2, runtime contract). Every handler loads it
 * once per container with {@link loadApiConfig}; nothing else in apps/api reads `process.env` except the
 * packages' own loaders (`dbConfigFromEnv`, `modelGatewayConfigFromEnv`, `seedConfigFromEnv`, core
 * `loadConfig`), which read the same variables.
 */

/** Which process is loading the configuration: decides which variables are mandatory. */
export type ApiRole = 'api' | 'worker' | 'migrate' | 'insights' | 'dev';

export const LogLevel = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevel>;

/** Presigned upload lifetime (5 minutes): short enough that a leaked URL is near-useless. */
export const UPLOAD_URL_TTL_SECONDS = 300;
/** Largest JSON request body accepted by the API (documents go straight to S3, never through it). */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
const optionalText = z.preprocess(emptyToUndefined, z.string().trim().optional());

/** Amazon Polly engines a deployment can choose for calls (infra `speech.engine`). */
export const SpeechEngine = z.enum(['neural', 'generative']);
export type SpeechEngine = z.infer<typeof SpeechEngine>;

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
  /** infra `speech.enabled`: `false` when the API role has no Amazon Polly or Transcribe permission. */
  SPEECH_ENABLED: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).default('true')),
  /** infra `speech.engine`: the Polly engine tried first (ADR-0010). */
  SPEECH_ENGINE: z.preprocess(emptyToUndefined, SpeechEngine.default('neural')),
  /** infra `media.face.provider`: the vEIR's video face (docs/runbooks/avatars.md). Off: `none`. */
  MEDIA_FACE_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['none', 'heygen-liveavatar']).default('none')),
  /** infra `media.face.sandbox`: LiveAvatar sandbox sessions (free, a minute long, the sandbox avatar). */
  MEDIA_FACE_SANDBOX: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).default('false')),
  /** infra `media.voice.provider`: the EIRs' cloned voices. Off: `polly` (stock voices only). */
  MEDIA_VOICE_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['polly', 'elevenlabs']).default('polly')),
  /** infra `media.voice.model`: the ElevenLabs model. */
  MEDIA_VOICE_MODEL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^[a-z0-9_]{1,64}$/)
      .default(MEDIA_VENDORS.voice.elevenlabs.defaultModel),
  ),
  /** infra `media.voice.zeroRetention`: ask ElevenLabs to keep nothing (Enterprise accounts only). */
  MEDIA_VOICE_ZERO_RETENTION: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).default('false')),
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
  /** Voice calls (ADR-0010): whether Polly and Transcribe may be used, and the Polly engine to try first. */
  readonly speech: { readonly enabled: boolean; readonly engine: SpeechEngine };
  /**
   * The vEIR's digital twin (docs/runbooks/avatars.md): which vendor draws the face and voices the EIRs' clones,
   * each off unless configured (and then still off until the platform settings turn them on).
   */
  readonly media: {
    readonly face: 'none' | 'heygen-liveavatar';
    readonly faceSandbox: boolean;
    readonly voice: 'polly' | 'elevenlabs';
    readonly voiceModel: string;
    readonly voiceZeroRetention: boolean;
  };
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
    speech: { enabled: e.SPEECH_ENABLED === 'true', engine: e.SPEECH_ENGINE },
    media: {
      face: e.MEDIA_FACE_PROVIDER,
      faceSandbox: e.MEDIA_FACE_SANDBOX === 'true',
      voice: e.MEDIA_VOICE_PROVIDER,
      voiceModel: e.MEDIA_VOICE_MODEL,
      voiceZeroRetention: e.MEDIA_VOICE_ZERO_RETENTION === 'true',
    },
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
