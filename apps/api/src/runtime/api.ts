import {
  createCore,
  MEDIA_VENDORS,
  type EmbodimentProvider,
  type EnvLike,
  type SpeechSynthesizer,
  type SttGrantIssuer,
  type VoiceProvider,
} from '@foundry/core';

import { ElevenLabsVoice } from '../adapters/elevenlabs-voice.js';
import { HeygenLiveAvatarFace } from '../adapters/heygen-liveavatar.js';
import { MediaSecrets } from '../adapters/media-secrets.js';
import { PollySpeechSynthesizer } from '../adapters/polly-speech.js';
import { S3ObjectStore } from '../adapters/s3-object-store.js';
import { SqsJobQueue } from '../adapters/sqs-job-queue.js';
import { TranscribeStreamingPresigner } from '../adapters/transcribe-presigner.js';
import { type ApiApp, createApp } from '../app.js';
import { type ApiConfig, loadApiConfig, loadCoreConfig, required } from '../config.js';
import { API_DB_RESUME_BUDGET_MS } from '../lambda-contract.js';
import { type Logger } from '../logging.js';
import { createDatabase, createGateway, createProcessLogger } from './common.js';
import { observeDatabase } from './db-observer.js';
import { InflightTracker } from './inflight.js';

export interface ApiRuntime {
  readonly app: ApiApp;
  readonly inflight: InflightTracker;
  readonly logger: Logger;
  readonly config: ApiConfig;
}

/**
 * Whether calls may use Amazon Polly and Amazon Transcribe: the models run on Bedrock (the deployed stacks)
 * and `SPEECH_ENABLED` is not `false` (infra `speech.enabled`, which also decides the IAM grants). Local
 * development and tests run the mock model and use neither.
 */
export function callSpeechEnabled(env: EnvLike, config: ApiConfig): boolean {
  return config.speech.enabled && env.MODEL_PROVIDER?.trim().toLowerCase() === 'bedrock';
}

/**
 * Text-to-speech for calls: Amazon Polly with the deployment's engine (`SPEECH_ENGINE`) tried first, where
 * {@link callSpeechEnabled}. Otherwise none: `POST /speech` answers 501 `speech_unavailable` and the browser
 * reads validated replies aloud itself. No network I/O at construction.
 */
export function speechFor(env: EnvLike, config: ApiConfig): { speech?: SpeechSynthesizer } {
  const engine = config.speech.engine;
  return callSpeechEnabled(env, config)
    ? { speech: new PollySpeechSynthesizer({ region: config.awsRegion, engine }) }
    : {};
}

/**
 * Speech-to-text grants for calls: Amazon Transcribe streaming URLs presigned with the API role's credentials,
 * where {@link callSpeechEnabled}. With `SPEECH_ENABLED=false` infra grants no Transcribe access, so no grant
 * is minted (one would fail at AWS); local development and tests get none either: calls start without a
 * grant and the founder types. No network I/O at construction.
 */
export function sttGrantsFor(env: EnvLike, config: ApiConfig): { sttGrants?: SttGrantIssuer } {
  return callSpeechEnabled(env, config)
    ? { sttGrants: new TranscribeStreamingPresigner({ region: config.awsRegion }) }
    : {};
}

/**
 * The vEIR's digital twin (docs/runbooks/avatars.md): the vendor face (`MEDIA_FACE_PROVIDER=heygen-liveavatar`) and
 * the EIRs' cloned voices (`MEDIA_VOICE_PROVIDER=elevenlabs`), each only when configured (infra `media`, off in
 * production.json). Their API keys come from Secrets Manager on first use (the names are
 * packages/core/media-vendors.json), never at construction and never to the browser. Even wired, a face or a
 * clone is used only once the platform settings turn it on (`faces_enabled`, `cloned_voice_enabled`) and the
 * persona's consent covers it.
 */
export function mediaFor(
  config: ApiConfig,
  secrets: MediaSecrets = new MediaSecrets({ region: config.awsRegion }),
): { embodiment?: EmbodimentProvider; clonedVoice?: VoiceProvider } {
  const face = MEDIA_VENDORS.face.heygen;
  const voice = MEDIA_VENDORS.voice.elevenlabs;
  const full = config.media.faceMode === 'full';
  return {
    ...(config.media.face === 'heygen-liveavatar'
      ? {
          // LITE: the EIR's own avatar renders our audio. FULL (MEDIA_FACE_MODE=full): a stock avatar voices
          // admitted text with its stock voice, at the FULL price; the same key and API either way.
          embodiment: new HeygenLiveAvatarFace({
            apiKey: secrets.apiKey(face.secretName),
            apiOrigin: face.apiOrigin,
            sandbox: config.media.faceSandbox,
            mode: config.media.faceMode,
            ...(config.media.faceStock === null ? {} : { stock: config.media.faceStock }),
            adminsOnly: config.media.faceAudience === 'admins',
            // The vendor's sandbox costs nothing (lab run 41219394722: 0 credits used, while the ledger billed $0.30
            // at list price and counted it against the daily cap).
            usdPerMinute: config.media.faceSandbox ? 0 : full ? face.full.usdPerMinute : face.usdPerMinute,
          }),
        }
      : {}),
    ...(config.media.voice === 'elevenlabs'
      ? {
          clonedVoice: new ElevenLabsVoice({
            apiKey: secrets.apiKey(voice.secretName),
            apiOrigin: voice.apiOrigin,
            model: config.media.voiceModel,
            usdPer1kCharacters: voice.usdPer1kCharacters,
            zeroRetention: config.media.voiceZeroRetention,
          }),
        }
      : {}),
  };
}

/**
 * Everything the API Lambda needs, built once per container (cold start): config, logger, Data API
 * database, model gateway, S3/SQS/Polly adapters, core and the Hono app. No network I/O happens here.
 */
export function createApiRuntime(env: EnvLike): ApiRuntime {
  const config = loadApiConfig(env, 'api');
  const logger = createProcessLogger(config, 'api');
  // A request waits at most API_DB_RESUME_BUDGET_MS (40 s) per call for Aurora to resume, then answers
  // 503 database_resuming + Retry-After: well inside the 60 s Lambda and CloudFront read timeouts.
  // Every call is observed, so the public /health can report the database state without a query.
  const { db, state: dbState } = observeDatabase(
    createDatabase(env, { defaultResumeBudgetMs: API_DB_RESUME_BUDGET_MS }),
  );
  const gateway = createGateway(env, logger);
  const inflight = new InflightTracker();
  const core = createCore({
    db,
    gateway,
    config: loadCoreConfig(env),
    objectStore: new S3ObjectStore({
      bucket: required(config.documentsBucket, 'DOCUMENTS_BUCKET'),
      region: config.awsRegion,
    }),
    jobQueue: new SqsJobQueue({
      queueUrl: required(config.jobsQueueUrl, 'JOBS_QUEUE_URL'),
      region: config.awsRegion,
    }),
    logger: logger.child({ component: 'core' }),
    // Settling a turn's kept memory follows the response: the handler drains it before the invocation returns.
    afterResponse: (task) => {
      void inflight.track(task);
    },
    ...speechFor(env, config),
    ...sttGrantsFor(env, config),
    ...mediaFor(config),
  });
  const app = createApp({
    core,
    db,
    dbState,
    logger,
    appEnv: config.appEnv,
    appVersion: config.appVersion,
    inflight,
  });
  return { app, inflight, logger, config };
}
