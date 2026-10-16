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
  type GatewayPurpose,
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
  type StreamStopReason,
  type StreamTextRequest,
  type StreamTextResult,
  type TextChunkHandler,
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
  DEFAULT_STREAM_MAX_OUTPUT_TOKENS,
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
  MOCK_STREAM_DELAY_MS,
  MockModelGateway,
  mockCoachResponse,
  mockDistillDraft,
  mockStreamChunks,
  type MockCall,
  type MockGenerateContext,
  type MockModelGatewayOptions,
  type MockScriptedOutcome,
  type MockStreamOutcome,
} from './gateway/mock.js';
export { COACH_ANNOTATIONS_SCHEMA_NAME, CoachAnnotations } from './gateway/coach-annotations.js';
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
  isClaudeModelId,
  type NovaProviderOptions,
} from './gateway/nova.js';
export { TitanEmbedder, TITAN_MAX_INPUT_CHARS, type TitanEmbedderOptions } from './gateway/titan.js';
export {
  createBedrockRuntimeTransport,
  type BedrockRuntimeTransport,
  type ConverseFn,
  type ConverseStreamFn,
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
export type {
  StructuredProvider,
  ProviderRequest,
  ProviderResult,
  ProviderStreamRequest,
  ProviderStreamResult,
} from './gateway/provider.js';
export { cosineSimilarity, hashEmbedding } from './gateway/hash-embedding.js';

// Pricing -------------------------------------------------------------------------------------------
export {
  DEFAULT_MODEL_PRICES,
  DEFAULT_SPEECH_PRICES,
  costFor,
  createPricingTable,
  normalizeModelId,
  priceFor,
  speechAttempt,
  speechCharacters,
  speechCostFor,
  speechModelId,
  sumUsd,
  type ModelPrice,
  type PricingTable,
  type SpeechEngine,
  type SpeechPricingTable,
} from './pricing.js';

// Prompts -------------------------------------------------------------------------------------------
export * from './prompts/index.js';

// Distillation (digest, notebook, memory and lesson candidates) -------------------------------------
export * from './distill/index.js';

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
export { CRISIS_SPOKEN_MESSAGE, CRISIS_SUPPORT_MESSAGE, buildCrisisResponse } from './risk/crisis.js';
export { RISK_RULES, type RiskRule } from './risk/rules.js';
export { COMMON_WORDS } from './risk/common-words.js';
export { ventureNameProblem, ventureNameRegExp, type VentureNameProblem } from './risk/normalize.js';

// Validators --------------------------------------------------------------------------------------------
export {
  CROSS_VENTURE_BLOCK_ANSWER,
  DEFAULT_COACH_RESPONSE_LIMITS,
  EMPTY_ANSWER_FALLBACK,
  INVALID_RESPONSE_ANSWER,
  NARROWING_NOTE_PREFIX,
  SPOKEN_NARROWING_CAVEAT,
  containsOtherVenture,
  forcedEscalationFor,
  responseStrings,
  textsContainOtherVenture,
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
  IDENTITY_MARGIN_CHARS,
  identityReplacement,
  rewriteIdentity,
  type IdentityCheckOptions,
  type IdentityFinding,
  type IdentityViolationKind,
} from './validators/identity.js';
export {
  SPOKEN_MAX_CHARS,
  SPOKEN_MAX_WORDS,
  clampWords,
  deriveSpoken,
  toSpeakable,
} from './validators/speech.js';
export {
  SentenceGate,
  findUnitEnd,
  holdBackFor,
  type GateBlockReason,
  type GateResult,
  type GateStats,
  type GateUnit,
  type SentenceGateOptions,
} from './validators/sentence-gate.js';
