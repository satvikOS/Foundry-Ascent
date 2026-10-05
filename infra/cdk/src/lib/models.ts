/**
 * Model selection and the Bedrock resources each model needs, derived from `config.models`.
 *
 * While `models.luna.enabled` is false (AWS gates GPT-6 Luna per account), the configured `primary` and
 * `fallback` (Nova 2 Lite inference profiles) are used as-is. Once enabled, Luna becomes primary and the
 * configured `primary` (the in-geography `us.` profile) becomes the fallback. The runtime contract
 * (MODEL_PRIMARY_ID / MODEL_FALLBACK_ID / MODEL_EMBEDDINGS_ID) carries the effective ids.
 */
import type { PlatformConfig } from '../config.js';

export interface EffectiveModels {
  readonly primary: string;
  readonly fallback: string;
  readonly embeddings: string;
}

/** Cross-region inference profile prefixes (`us.amazon.nova-2-lite-v1:0`, `global.…`). */
const PROFILE_PREFIX = /^(us|us-gov|eu|apac|jp|au|ca|global)\./;

export function effectiveModels(models: PlatformConfig['models']): EffectiveModels {
  if (models.luna?.enabled) {
    return { primary: models.luna.modelId, fallback: models.primary, embeddings: models.embeddings };
  }
  return { primary: models.primary, fallback: models.fallback, embeddings: models.embeddings };
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

export interface BedrockRuntimeAccess {
  /** Foundation-model ids, granted in every region (cross-region and global profiles route anywhere). */
  readonly foundationModels: readonly string[];
  /** Inference-profile ids, granted in the invoking region. */
  readonly inferenceProfiles: readonly string[];
}

/**
 * Bedrock runtime resources for reasoning models (Converse). A bare foundation-model id also gets its
 * `us.` profile: the gateway retries with it when on-demand throughput is not offered for the bare id.
 */
export function reasoningAccess(models: EffectiveModels): BedrockRuntimeAccess {
  const ids = [models.primary, models.fallback].filter((id) => !isMantleModel(id));
  const profiles = ids.map((id) => (isInferenceProfile(id) ? id : `us.${id}`));
  return {
    foundationModels: unique(ids.map(foundationModelId)),
    inferenceProfiles: unique(profiles),
  };
}

/** Bedrock runtime resources for the embeddings model (InvokeModel). */
export function embeddingsAccess(models: EffectiveModels): BedrockRuntimeAccess {
  return {
    foundationModels: [foundationModelId(models.embeddings)],
    inferenceProfiles: isInferenceProfile(models.embeddings) ? [models.embeddings] : [],
  };
}

export function usesMantle(models: EffectiveModels): boolean {
  return isMantleModel(models.primary) || isMantleModel(models.fallback);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
