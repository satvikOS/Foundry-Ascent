/**
 * Model selection and the Bedrock resources each model needs, derived from `config.models`.
 *
 * While `models.luna.enabled` is false (AWS gates GPT-6 Luna per account), the configured `primary` and
 * `fallback` (the coach, Claude Haiku 4.5, with Amazon Nova 2 Lite behind it) are used as-is. Once enabled, Luna
 * becomes primary and the configured `primary` becomes the fallback. The background route (`models.background`) is
 * never changed by Luna. The runtime contract (MODEL_PRIMARY_ID / MODEL_FALLBACK_ID / MODEL_EMBEDDINGS_ID and
 * MODEL_BACKGROUND_PRIMARY_ID / MODEL_BACKGROUND_FALLBACK_ID / MODEL_BACKGROUND_PURPOSES) carries the effective ids.
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
}

/** Cross-region inference profile prefixes (`us.amazon.nova-2-lite-v1:0`, `global.…`). */
const PROFILE_PREFIX = /^(us|us-gov|eu|apac|jp|au|ca|in|global)\./;

export function effectiveModels(models: PlatformConfig['models']): EffectiveModels {
  const background = models.background ? { background: models.background } : {};
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

/** Every reasoning model id the app may call: the conversation's pair and the background pair. */
export function reasoningModelIds(models: EffectiveModels): string[] {
  return unique([
    models.primary,
    models.fallback,
    ...(models.background ? [models.background.primary, models.background.fallback] : []),
  ]);
}

/** Models served by Bedrock Mantle (OpenAI-compatible endpoint, `bedrock-mantle:CreateInference`). */
export function isMantleModel(modelId: string): boolean {
  return modelId.startsWith('openai.');
}

export function isInferenceProfile(modelId: string): boolean {
  return PROFILE_PREFIX.test(modelId);
}

/** Foundation model behind an inference profile id (`global.amazon.x` -> `amazon.x`). */
export function foundationModelId(modelId: string): string {
  return modelId.replace(PROFILE_PREFIX, '');
}

/**
 * Where a geography inference profile routes a request from the platform's region, for the models whose destination
 * regions were checked on their Bedrock model cards (2026-11-06; "Geo inference details", source region us-east-1).
 * AWS states that a geography profile's destination list never changes (a new region comes as a new profile). A
 * model or profile not listed here keeps its foundation model granted in every region.
 */
const GEO_DESTINATIONS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  'us-east-1': {
    'us.anthropic.claude-haiku-4-5-20251001-v1:0': ['us-east-1', 'us-east-2', 'us-west-2'],
    'us.amazon.nova-2-lite-v1:0': ['us-east-1', 'us-east-2', 'us-west-2'],
  },
};

/** The destination regions of a geography profile called from `region`, or null when they were not checked. */
export function geoDestinations(profileId: string, region: string): readonly string[] | null {
  return GEO_DESTINATIONS[region]?.[profileId] ?? null;
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
   * alone (Claude Haiku 4.5 behind `us.`: us-east-1, us-east-2, us-west-2).
   */
  readonly regionalFoundationModels: readonly {
    readonly modelId: string;
    readonly regions: readonly string[];
  }[];
  /** Inference-profile ids, granted in the invoking region. */
  readonly inferenceProfiles: readonly string[];
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
    const regions = isInferenceProfile(id) ? geoDestinations(id, region) : null;
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
 * `us.` profile: the gateway retries with it when on-demand throughput is not offered for the bare id.
 */
export function reasoningAccess(models: EffectiveModels, region = 'us-east-1'): BedrockRuntimeAccess {
  const ids = reasoningModelIds(models).filter((id) => !isMantleModel(id));
  const bare = ids.filter((id) => !isInferenceProfile(id));
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
