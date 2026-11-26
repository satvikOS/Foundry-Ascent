/**
 * Model selection and the Bedrock resources each model needs, derived from `config.models`.
 *
 * While `models.luna.enabled` is false (AWS gates GPT-6 Luna per account), the configured `primary` and
 * `fallback` (the coach, Mistral Large 3, with Nova 2 Lite's US profile behind it: ADR-0025) are used as-is. Once enabled, Luna
 * becomes primary and the configured `primary` becomes the fallback. The background route (`models.background`) is
 * never changed by Luna. The runtime contract (MODEL_PRIMARY_ID / MODEL_FALLBACK_ID / MODEL_EMBEDDINGS_ID and
 * MODEL_BACKGROUND_PRIMARY_ID / MODEL_BACKGROUND_FALLBACK_ID / MODEL_BACKGROUND_PURPOSES) carries the effective ids.
 * The understand call's own model and its SUMS part's (`models.understand`) are granted with them, to the API alone (the
 * only function that runs it and is given its variables), when it names them.
 */
import type { BackgroundPurpose, PlatformConfig } from '../config.js';

export interface EffectiveModels {
  readonly primary: string;
  readonly fallback: string;
  readonly embeddings: string;
  /** The background purposes' own models, or absent (every purpose then uses `primary` and `fallback`). */
  readonly background?: {
    readonly primary: string;
    readonly fallback: string;
    readonly purposes: readonly BackgroundPurpose[];
  };
  /** The understand call's own model, when the configuration names one (docs/architecture/understand.md). */
  readonly understand?: string;
  /** Its SUMS part's own model, when the configuration names one. */
  readonly understandSums?: string;
}

/** Cross-region inference profile prefixes (`us.amazon.nova-2-lite-v1:0`, `global.…`). */
const PROFILE_PREFIX = /^(us|us-gov|eu|apac|jp|au|ca|in|global)\./;

export function effectiveModels(models: PlatformConfig['models']): EffectiveModels {
  const background = {
    ...(models.background ? { background: models.background } : {}),
    ...(models.understand?.modelId === undefined ? {} : { understand: models.understand.modelId }),
    ...(models.understand?.sumsModelId === undefined
      ? {}
      : { understandSums: models.understand.sumsModelId }),
  };
  if (models.luna?.enabled) {
    return {
      primary: models.luna.modelId,
      fallback: models.primary,
      embeddings: models.embeddings,
      ...background,
    };
  }
  return { primary: models.primary, fallback: models.fallback, embeddings: models.embeddings, ...background };
}

/**
 * Every reasoning model id the app may call: the conversation's pair, the background pair, the understand call's and its
 * SUMS part's.
 */
export function reasoningModelIds(models: EffectiveModels): string[] {
  return unique([
    models.primary,
    models.fallback,
    ...(models.background ? [models.background.primary, models.background.fallback] : []),
    ...(models.understand === undefined ? [] : [models.understand]),
    ...(models.understandSums === undefined ? [] : [models.understandSums]),
  ]);
}

/** The models without the understand call's own (`understand`, `understandSums`): what a function that never runs it calls. */
export function withoutUnderstand(models: EffectiveModels): EffectiveModels {
  const { understand: _understand, understandSums: _understandSums, ...rest } = models;
  return rest;
}

/**
 * Models served by Bedrock Mantle (OpenAI-compatible endpoint, `bedrock-mantle:CreateInference`). OpenAI's open-weight
 * models have a runtime id of their own (`openai.gpt-oss-120b-1:0`, their model cards, checked 2026-11-25): Converse, as
 * packages/ai router.ts `reasoningAdapterFor`.
 */
export function isMantleModel(modelId: string): boolean {
  return modelId.startsWith('openai.') && !/^openai\.gpt-oss-\d+b-\d+:\d+$/.test(modelId);
}

export function isInferenceProfile(modelId: string): boolean {
  return PROFILE_PREFIX.test(modelId);
}

/**
 * The understand call's variables, for the API alone (turns run there): none while the configuration does not name it, as
 * SITE_ORIGIN without a custom domain; the API then reads its own default (off).
 */
export function understandEnvironment(models: PlatformConfig['models']): Record<string, string> {
  const { understand } = models;
  if (understand === undefined) return {};
  return {
    CORE_UNDERSTAND: understand.enabled ? 'on' : 'off',
    ...(understand.modelId === undefined ? {} : { MODEL_UNDERSTAND_ID: understand.modelId }),
    ...(understand.think === undefined ? {} : { MODEL_UNDERSTAND_THINK: understand.think }),
    ...(understand.sumsModelId === undefined ? {} : { MODEL_UNDERSTAND_SUMS_ID: understand.sumsModelId }),
    ...(understand.sumsThink === undefined ? {} : { MODEL_UNDERSTAND_SUMS_THINK: understand.sumsThink }),
  };
}

/** Foundation model behind an inference profile id (`global.amazon.x` -> `amazon.x`). */
export function foundationModelId(modelId: string): string {
  return modelId.replace(PROFILE_PREFIX, '');
}

/**
 * Where a geography inference profile routes a request from the platform's region, for the models whose destination
 * regions were checked on their Bedrock model cards (2026-11-06, GPT-6 Luna and Cohere Embed 4 2026-11-24; "Geo
 * inference details", source region us-east-1).
 * AWS states that a geography profile's destination list never changes (a new region comes as a new profile). A
 * model or profile not listed here keeps its foundation model granted in every region.
 */
const GEO_DESTINATIONS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  'us-east-1': {
    'us.anthropic.claude-haiku-4-5-20251001-v1:0': ['us-east-1', 'us-east-2', 'us-west-2'],
    'us.amazon.nova-2-lite-v1:0': ['us-east-1', 'us-east-2', 'us-west-2'],
    'us.openai.gpt-6-luna': ['us-east-1', 'us-east-2', 'us-west-2'],
    'us.cohere.embed-v4:0': ['us-east-1', 'us-east-2', 'us-west-2'],
  },
};

/** The destination regions of a geography profile called from `region`, or null when they were not checked. */
export function geoDestinations(profileId: string, region: string): readonly string[] | null {
  return GEO_DESTINATIONS[region]?.[profileId] ?? null;
}

/**
 * Bare foundation-model ids served on demand in `region` itself and through no inference profile there: their Bedrock
 * model cards list In-Region for the region and "Not supported" as both the Geo and the Global inference ID (checked
 * 2026-11-25: Mistral Large 3, the coach; gpt-oss-120b, the understand call's SUMS part). A call with such an id runs
 * in the invoking region alone, so its foundation model is granted there alone, and no `us.` retry profile is granted
 * (none exists). A bare id not listed here keeps the wider grant (every region, and its `us.` profile).
 */
const IN_REGION_ONLY: Readonly<Record<string, readonly string[]>> = {
  'us-east-1': ['mistral.mistral-large-3-675b-instruct', 'openai.gpt-oss-120b-1:0'],
};

/** Whether a bare model id is served in `region` with no inference profile (checked on its model card). */
export function servedInRegionOnly(modelId: string, region: string): boolean {
  return !isInferenceProfile(modelId) && (IN_REGION_ONLY[region]?.includes(modelId) ?? false);
}

export interface BedrockRuntimeAccess {
  /**
   * Foundation-model ids granted in every region: a bare id (served in the invoking region, or through its `us.`
   * profile on the gateway's retry), a `global.` profile's model, or a geography profile whose destinations were not
   * checked.
   */
  readonly foundationModels: readonly string[];
  /**
   * Foundation-model ids reached through a `global.` profile: Bedrock authorizes those calls against the
   * region-less ARN (`arn:aws:bedrock:::foundation-model/<id>`), which is granted explicitly as well.
   */
  readonly globalFoundationModels: readonly string[];
  /**
   * Foundation models reached only through geography profiles with checked destinations: granted in those regions
   * alone (GPT-6 Luna behind `us.`: us-east-1, us-east-2, us-west-2); and a bare id served in the invoking region
   * with no profile (`servedInRegionOnly`): granted in that region alone.
   */
  readonly regionalFoundationModels: readonly {
    readonly modelId: string;
    readonly regions: readonly string[];
  }[];
  /** Inference-profile ids, granted in the invoking region. */
  readonly inferenceProfiles: readonly string[];
}

/**
 * Whether an OpenAI model behind an inference profile is among `profiles` (`us.openai.gpt-6-luna`, through Converse).
 * Its model card asks for bedrock:InvokeModel on the account's default project beside the profile
 * (`arn:aws:bedrock:<region>:<account>:project/default`): the project is no model, so this grants no other one.
 */
export function usesOpenAiProfile(profiles: readonly string[]): boolean {
  return profiles.some((id) => isInferenceProfile(id) && isMantleModel(foundationModelId(id)));
}

/** Global (all commercial regions) inference profiles: `global.amazon.nova-2-lite-v1:0`. */
export function isGlobalInferenceProfile(modelId: string): boolean {
  return modelId.startsWith('global.');
}

/**
 * The Bedrock runtime resources for a set of model ids called from `region`: each profile in that region, and the
 * foundation model behind it where the profile routes (every region unless the destinations were checked; the
 * region-less ARN for a `global.` profile). A foundation model reached in several ways gets the widest grant.
 */
export function runtimeAccess(ids: readonly string[], region: string): BedrockRuntimeAccess {
  const everywhere = new Set<string>();
  const regional = new Map<string, Set<string>>();
  for (const id of ids) {
    const model = foundationModelId(id);
    const regions = isInferenceProfile(id)
      ? geoDestinations(id, region)
      : servedInRegionOnly(id, region)
        ? [region]
        : null;
    if (regions === null) {
      everywhere.add(model);
      continue;
    }
    const known = regional.get(model) ?? new Set<string>();
    for (const r of regions) known.add(r);
    regional.set(model, known);
  }
  return {
    foundationModels: [...everywhere],
    globalFoundationModels: unique(ids.filter(isGlobalInferenceProfile).map(foundationModelId)),
    regionalFoundationModels: [...regional]
      .filter(([model]) => !everywhere.has(model))
      .map(([modelId, regions]) => ({ modelId, regions: [...regions].sort() })),
    inferenceProfiles: unique(ids.filter(isInferenceProfile)),
  };
}

/**
 * Bedrock runtime resources for reasoning models (Converse). A bare foundation-model id also gets its
 * `us.` profile: the gateway retries with it when on-demand throughput is not offered for the bare id. A bare id
 * served in the region with no profile (`servedInRegionOnly`) gets none: that retry never happens for it.
 */
export function reasoningAccess(models: EffectiveModels, region = 'us-east-1'): BedrockRuntimeAccess {
  const ids = reasoningModelIds(models).filter((id) => !isMantleModel(id));
  const bare = ids.filter((id) => !isInferenceProfile(id) && !servedInRegionOnly(id, region));
  const access = runtimeAccess(ids, region);
  return {
    ...access,
    // The bare id's foundation model is already granted everywhere; its retry profile is granted beside it.
    inferenceProfiles: unique([...access.inferenceProfiles, ...bare.map((id) => `us.${id}`)]),
  };
}

/** Bedrock runtime resources for the embeddings model (InvokeModel). */
export function embeddingsAccess(models: EffectiveModels, region = 'us-east-1'): BedrockRuntimeAccess {
  return runtimeAccess([models.embeddings], region);
}

export function usesMantle(models: EffectiveModels): boolean {
  return reasoningModelIds(models).some(isMantleModel);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
