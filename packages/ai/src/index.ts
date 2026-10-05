// @foundry/ai — model gateway, prompts, deterministic risk classifier and output validators.

// Gateway -------------------------------------------------------------------------------------------
export {
  EMBEDDING_DIMENSIONS,
  MODEL_PURPOSES,
  noopLogger,
  type AttemptKind,
  type AttemptOutcome,
  type ChatMessage,
  type EmbedOptions,
  type EmbedResult,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type LogFields,
  type ModelAttempt,
  type ModelGateway,
  type ModelGatewayInfo,
  type ModelLogger,
  type ModelProviderName,
  type ModelPurpose,
  type ModelUsage,
  type RawModelAttempt,
} from './gateway/types.js';
export {
  ModelGatewayError,
  ModelOutputInvalidError,
  ModelRefusalError,
  ModelUnavailableError,
  isModelGatewayError,
  type ModelErrorCode,
  type UnavailableReason,
} from './gateway/errors.js';
export {
  DEFAULT_FALLBACK_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MODEL_IDS,
  DEFAULT_PRIMARY_TIMEOUT_MS,
  MANTLE_MODEL_PREFIX,
  createModelGateway,
  modelGatewayConfigFromEnv,
  reasoningAdapterFor,
  type BedrockGatewayConfig,
  type MockGatewayConfig,
  type ModelGatewayConfig,
} from './gateway/router.js';
export {
  MOCK_EMBEDDINGS_MODEL_ID,
  MOCK_FALLBACK_MODEL_ID,
  MOCK_MODEL_ID,
  MockModelGateway,
  mockCoachResponse,
  type MockCall,
  type MockGenerateContext,
  type MockModelGatewayOptions,
  type MockScriptedOutcome,
} from './gateway/mock.js';
export {
  LunaProvider,
  mantleBaseUrl,
  type LunaProviderOptions,
  type LunaReasoningEffort,
} from './gateway/luna.js';
export {
  NovaProvider,
  SUBMIT_TOOL_NAME,
  inferenceProfilePrefix,
  type NovaProviderOptions,
} from './gateway/nova.js';
export { TitanEmbedder, TITAN_MAX_INPUT_CHARS, type TitanEmbedderOptions } from './gateway/titan.js';
export {
  createBedrockRuntimeTransport,
  type BedrockRuntimeTransport,
  type ConverseFn,
  type InvokeModelFn,
} from './gateway/bedrock-runtime.js';
export {
  createSigV4Fetch,
  type AwsCredentialProvider,
  type AwsCredentials,
  type FetchFn,
  type SigV4FetchOptions,
} from './gateway/sigv4-fetch.js';
export {
  toStrictJsonSchema,
  type JsonObject,
  type JsonValue,
  type StrictJsonSchema,
} from './gateway/json-schema.js';
export type { StructuredProvider, ProviderRequest, ProviderResult } from './gateway/provider.js';
export { cosineSimilarity, hashEmbedding } from './gateway/hash-embedding.js';

// Pricing -------------------------------------------------------------------------------------------
export {
  DEFAULT_MODEL_PRICES,
  costFor,
  createPricingTable,
  normalizeModelId,
  priceFor,
  sumUsd,
  type ModelPrice,
  type PricingTable,
} from './pricing.js';

// Prompts -------------------------------------------------------------------------------------------
export * from './prompts/index.js';

// Risk ------------------------------------------------------------------------------------------------
export {
  classifyRisk,
  isHighRiskCategory,
  riskLabel,
  type ClassifyRiskOptions,
  type RiskClassification,
} from './risk/classifier.js';
export {
  FORCED_ESCALATION_CATEGORIES,
  RISK_ESCALATION_MAP,
  morePressing,
  primaryForcedCategory,
  type RequestedRoleValue,
  type RiskEscalation,
} from './risk/escalation-map.js';
export { CRISIS_SUPPORT_MESSAGE, buildCrisisResponse } from './risk/crisis.js';
export { RISK_RULES, type RiskRule } from './risk/rules.js';

// Validators --------------------------------------------------------------------------------------------
export {
  CROSS_VENTURE_BLOCK_ANSWER,
  DEFAULT_COACH_RESPONSE_LIMITS,
  EMPTY_ANSWER_FALLBACK,
  INVALID_RESPONSE_ANSWER,
  NARROWING_NOTE_PREFIX,
  containsOtherVenture,
  forcedEscalationFor,
  responseStrings,
  validateCoachResponse,
  type CoachResponseBlockReason,
  type CoachResponseLimits,
  type CoachResponseValidation,
  type ValidateCoachResponseOptions,
} from './validators/coach-response.js';
export {
  isSafeLinkTarget,
  sanitizeMarkdown,
  sanitizePlainText,
  type SanitizeReport,
} from './validators/markdown.js';
export {
  rewriteIdentity,
  type IdentityCheckOptions,
  type IdentityFinding,
  type IdentityViolationKind,
} from './validators/identity.js';
