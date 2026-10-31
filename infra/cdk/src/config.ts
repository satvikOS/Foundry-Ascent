/**
 * Deployment configuration: `config/production.json`, validated at synth time so a malformed value fails
 * `cdk synth` with a precise message instead of producing a template that fails half-way through a deploy.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_DB_RESUME_BUDGET_SECONDS, API_TIMING_MARGIN_SECONDS } from './lib/constants.js';
import { SPEECH_ENGINES, type SpeechEngine } from './lib/speech-voices.js';
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
    /**
     * 0 (production) lets the cluster pause after `autoPauseMinutes` idle (USD 0 while paused; the first
     * request after a pause waits 15-20 s for it to resume); 0.5 or more never pauses (about USD 44 a month at
     * 0.5).
     */
    readonly minCapacityAcu: number;
    readonly maxCapacityAcu: number;
    /** Idle minutes before pausing; used only when `minCapacityAcu` is 0. */
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
    /**
     * Polly engine tried first: `neural` (default: faster, half the price) or `generative` (see ADR-0010).
     * Voices and prices are `packages/core/speech-voices.json`, shared with the API.
     */
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
  /**
   * The vEIR's digital twin (docs/runbooks/avatars.md): the vendor that draws the face (HeyGen LiveAvatar, LITE
   * mode) and the one that voices the EIRs' clones (ElevenLabs). Optional in the file; absent means off. Even
   * wired, a face or a clone is used only once Admin › Settings turns it on and the persona's consent covers it.
   */
  readonly media: {
    readonly face: {
      readonly provider: 'none' | 'heygen-liveavatar';
      /** LiveAvatar sandbox sessions (free, about a minute, the sandbox avatar only). */
      readonly sandbox: boolean;
      /**
       * Exact origins the browser needs for the face's video (the vendor's LiveKit project host, `wss://` and
       * `https://`), added to the CSP's `connect-src` / `media-src` only while a face provider is wired. Empty
       * otherwise; never a wildcard.
       */
      readonly csp: { readonly connect: readonly string[]; readonly media: readonly string[] };
      /**
       * How the vendor face speaks (`MEDIA_FACE_MODE`). `lite` (default): the face lip-syncs audio our server made
       * (Polly or the EIR's clone), the path for an EIR's own likeness. `full`: a vendor STOCK avatar speaks, in the
       * vendor's stock voice, only text our server admitted (docs/architecture/calls.md §4.2). `full` never renders
       * an EIR's likeness, so it requires `stock`.
       */
      readonly mode: FaceMode;
      /**
       * FULL mode only (refused in LITE): the vendor stock avatar that replaces the persona's own face
       * (`MEDIA_FACE_AVATAR_ID`, `MEDIA_FACE_VOICE_ID`). No likeness consent is involved, and the call tile labels it
       * "AI avatar". `voiceId` is a vendor stock voice; absent, the avatar's default voice speaks. Null: the persona's
       * own face (LITE).
       */
      readonly stock: { readonly avatarId: string; readonly voiceId: string | null } | null;
      /**
       * Who is offered the face (`MEDIA_FACE_AUDIENCE`): `admins` (platform admins only) or `everyone` the
       * persona's consent covers. Defaults: `admins` in FULL (the only audience it accepts: in FULL a browser can
       * make the face say other text on its own screen, which the transcript check only catches afterwards),
       * `everyone` in LITE (a sandbox face is offered to platform admins only either way).
       */
      readonly audience: FaceAudience;
    };
    readonly voice: {
      readonly provider: 'polly' | 'elevenlabs';
      readonly model: string;
      /** ElevenLabs zero-retention mode (Enterprise accounts only). */
      readonly zeroRetention: boolean;
    };
  };
  readonly logRetentionDays: number;
}

export const FACE_MODES = ['lite', 'full'] as const;
export type FaceMode = (typeof FACE_MODES)[number];
export const FACE_AUDIENCES = ['admins', 'everyone'] as const;
export type FaceAudience = (typeof FACE_AUDIENCES)[number];

/** Used when `media` is absent from the file: no face, stock voices only. */
const MEDIA_OFF: PlatformConfig['media'] = {
  face: {
    provider: 'none',
    sandbox: false,
    csp: { connect: [], media: [] },
    mode: 'lite',
    stock: null,
    audience: 'everyone',
  },
  voice: { provider: 'polly', model: 'eleven_flash_v2_5', zeroRetention: false },
};

/** Used when `speech` is absent from the file: speech off; the engine and alarm are then never used. */
const SPEECH_OFF = { enabled: false, engine: 'neural', dailyAlarmUsd: 15 } as const;
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
  // The platform voice lives in the voices file the API reads (it has every engine); a voice set here would
  // reach nobody, so it is refused rather than ignored.
  if (speech.defaultVoice !== undefined) {
    throw new ConfigError(
      '$.speech.defaultVoice',
      'is not read: the platform voice is platformVoice in packages/core/speech-voices.json',
    );
  }
  return {
    enabled: bool(speech, 'enabled', '$.speech'),
    engine: engineName as SpeechEngine,
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

/** An exact `wss://` or `https://` origin: a host (no wildcard, no path), optionally a port. */
const EXACT_ORIGIN =
  /^(wss|https):\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$/;

function origins(parent: Json, key: string, path: string): string[] {
  const value = parent[key];
  if (!Array.isArray(value) || value.length > 4) {
    throw new ConfigError(`${path}.${key}`, 'must be a list of at most 4 origins');
  }
  return value.map((origin, i) => {
    if (typeof origin !== 'string' || !EXACT_ORIGIN.test(origin)) {
      throw new ConfigError(
        `${path}.${key}[${String(i)}]`,
        'must be an exact wss:// or https:// origin (no wildcard)',
      );
    }
    return origin;
  });
}

/** LiveAvatar avatar and voice ids are UUIDs (e.g. the sandbox avatar `dd73ea75-1218-4ef3-92ce-606d5f7fbc0a`). */
const VENDOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function oneOf<T extends string>(
  parent: Json,
  key: string,
  path: string,
  allowed: readonly T[],
): T | undefined {
  if (parent[key] === undefined) return undefined;
  const value = parent[key];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(`${path}.${key}`, `must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/**
 * `media.face.mode`, `media.face.stock` and `media.face.audience` (all optional: absent means LITE with the
 * persona's own face, offered to everyone the consent covers, which is how faces worked before FULL existed).
 */
function parseFaceVoicing(face: Json): Pick<PlatformConfig['media']['face'], 'mode' | 'stock' | 'audience'> {
  const path = '$.media.face';
  const mode = oneOf(face, 'mode', path, FACE_MODES) ?? 'lite';
  let stock: PlatformConfig['media']['face']['stock'] = null;
  if (face.stock !== undefined && face.stock !== null) {
    const raw = obj(face.stock, `${path}.stock`);
    const extra = Object.keys(raw).filter((key) => key !== 'avatarId' && key !== 'voiceId');
    if (extra.length > 0) {
      throw new ConfigError(
        `${path}.stock`,
        `has unknown keys: ${extra.join(', ')} (only avatarId, voiceId)`,
      );
    }
    stock = {
      avatarId: str(raw, 'avatarId', `${path}.stock`, VENDOR_UUID),
      voiceId:
        raw.voiceId === undefined || raw.voiceId === null
          ? null
          : str(raw, 'voiceId', `${path}.stock`, VENDOR_UUID),
    };
  }
  // FULL hands the vendor text and lets the vendor's own voice say it: never for an EIR's likeness, whose face
  // only ever lip-syncs audio our server made (LITE). So FULL needs a stock avatar.
  if (mode === 'full' && stock === null) {
    throw new ConfigError(
      `${path}.stock`,
      'must name a vendor stock avatar (stock.avatarId) when mode is full: FULL never renders an EIR’s likeness (docs/runbooks/avatars.md §9)',
    );
  }
  // A stock avatar and its voice are FULL mode only: in LITE the face is the persona's own likeness saying our own
  // audio, and the API ignores a stock face there, so naming one would be a silent misconfiguration.
  if (mode === 'lite' && stock !== null) {
    throw new ConfigError(
      `${path}.stock`,
      'is FULL mode only (in LITE the face is the persona’s own, saying our own audio; docs/runbooks/avatars.md §9)',
    );
  }
  const audience = oneOf(face, 'audience', path, FACE_AUDIENCES) ?? (mode === 'full' ? 'admins' : 'everyone');
  // In FULL the browser's room token can publish commands, so a modified page could make the face say other text
  // on its own screen until the server's transcript check ends it: acceptable for platform admins presenting, not
  // for founders.
  if (mode === 'full' && audience !== 'admins') {
    throw new ConfigError(
      `${path}.audience`,
      'must be admins when mode is full (docs/runbooks/avatars.md §9)',
    );
  }
  return { mode, stock, audience };
}

function parseMedia(raw: unknown): PlatformConfig['media'] {
  if (raw === undefined) return MEDIA_OFF;
  const media = obj(raw, '$.media');
  const face = obj(media.face, '$.media.face');
  const voice = obj(media.voice, '$.media.voice');
  const faceProvider = str(face, 'provider', '$.media.face');
  if (faceProvider !== 'none' && faceProvider !== 'heygen-liveavatar') {
    throw new ConfigError('$.media.face.provider', 'must be one of none, heygen-liveavatar');
  }
  const voiceProvider = str(voice, 'provider', '$.media.voice');
  if (voiceProvider !== 'polly' && voiceProvider !== 'elevenlabs') {
    throw new ConfigError('$.media.voice.provider', 'must be one of polly, elevenlabs');
  }
  const csp = obj(face.csp, '$.media.face.csp');
  const connect = origins(csp, 'connect', '$.media.face.csp');
  const mediaOrigins = origins(csp, 'media', '$.media.face.csp');
  // The CSP stays exactly as strict as before while no face is wired.
  if (faceProvider === 'none' && (connect.length > 0 || mediaOrigins.length > 0)) {
    throw new ConfigError('$.media.face.csp', 'must be empty while media.face.provider is none');
  }
  // A wired face whose room the CSP blocks would silently never show (livekit-client signals over wss:// and
  // asks the same host over https:// for its regions), so the first deploy already names both.
  if (
    faceProvider !== 'none' &&
    !(connect.some((o) => o.startsWith('wss://')) && connect.some((o) => o.startsWith('https://')))
  ) {
    throw new ConfigError(
      '$.media.face.csp.connect',
      'must name the vendor room’s wss:// and https:// origins while a face is wired (docs/runbooks/avatars.md §5)',
    );
  }
  return {
    face: {
      provider: faceProvider,
      sandbox: bool(face, 'sandbox', '$.media.face'),
      csp: { connect, media: mediaOrigins },
      ...parseFaceVoicing(face),
    },
    voice: {
      provider: voiceProvider,
      model: str(voice, 'model', '$.media.voice', /^[a-z0-9_]{1,64}$/),
      zeroRetention: bool(voice, 'zeroRetention', '$.media.voice'),
    },
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
    media: parseMedia(root.media),
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
