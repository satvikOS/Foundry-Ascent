// @foundry/ai — model gateway, prompts, deterministic risk classifier and output validators.

// Gateway -------------------------------------------------------------------------------------------
export {
  EMBEDDING_DIMENSIONS,
  MODEL_PURPOSES,
  modelsForPurpose,
  noopLogger,
  type AttemptKind,
  type BackgroundModels,
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
  type Reranker,
  type ModelGatewayInfo,
  type ModelLogger,
  type ModelProviderName,
  type ModelPurpose,
  type ModelUsage,
  type PromptCacheHint,
  type RawModelAttempt,
  type StreamStopReason,
  type StreamTextRequest,
  type ThinkEffort,
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
  DEFAULT_COACH_TEMPERATURE,
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
export { PathAnnotations, annotationsOfPath } from './prompts/annotations.js';
export { termsIn, withMeanings } from './validators/glossary.js';
export { methodText, methodUnit, type MethodFinding, type MethodUnit } from './validators/method.js';
export { ownFactsUnit, type OwnFacts } from './validators/own-facts.js';
export {
  LunaProvider,
  mantleBaseUrl,
  type LunaProviderOptions,
  type LunaReasoningEffort,
} from './gateway/luna.js';
export {
  CONVERSE_REASONING_EFFORTS,
  NovaProvider,
  OSS_REASONING_MAX_TOKENS,
  SUBMIT_TOOL_NAME,
  THINK_LOW_MAX_TOKENS,
  inferenceProfilePrefix,
  isClaudeModelId,
  isGptOssModelId,
  isOpenAiModelId,
  thinksOnRequest,
  usesCachePoints,
  type ConverseReasoningEffort,
  type NovaProviderOptions,
} from './gateway/nova.js';
export { TitanEmbedder, TITAN_MAX_INPUT_CHARS, type TitanEmbedderOptions } from './gateway/titan.js';
export {
  EMBEDDING_BATCH,
  EMBEDDING_SIZES,
  embeddingBody,
  embeddingFamily,
  parseEmbeddings,
  parseRerank,
  rerankBody,
  type EmbeddingFamily,
  type EmbeddingInput,
} from './gateway/retrieval-models.js';
export {
  awsErrorName,
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
export { hashEmbedding } from './gateway/hash-embedding.js';
export {
  CountingAgent,
  KEEP_ALIVE_MSECS,
  awsConnectionStats,
  sharedAwsAgent,
  type ConnectionStats,
} from './gateway/http-agent.js';

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

// Distillation (digest, notebook, memory and lesson candidates) -------------------------------------
export * from './distill/index.js';

// Understanding (what a message asks, read against the record) -----------------------------------------
export {
  checkUnderstanding,
  readParts,
  readUnderstanding,
  type ReadUnderstanding,
  type UnderstandContext,
  type UnderstandExchange,
  type UnderstandPlay,
  type UnderstandReport,
} from './understand/check.js';
export { mergeReadings } from './understand/merge.js';
export { readJudge, readRoute, readSums, salvaged } from './understand/salvage.js';
export {
  JUDGE_SYSTEM_PROMPT,
  SUMS_SYSTEM_PROMPT,
  UNDERSTAND_EXAMPLES,
  exchangesInView,
  routeSystemPrompt,
  sumsAgain,
  sumsDue,
  understandCacheHint,
  understandMessages,
  type UnderstandExample,
  type UnderstandPrompt,
} from './understand/prompt.js';
export {
  JudgeReading,
  RouteReading,
  SumsReading,
  UNDERSTAND_JUDGE_WAIT_MS,
  UNDERSTAND_MAX_OUTPUT_TOKENS,
  UNDERSTAND_PARTS,
  UNDERSTAND_SCHEMAS,
  UNDERSTAND_SCHEMA_NAMES,
  UNDERSTAND_TIMEOUT_MS,
  type RawUnderstanding,
  type UnderstandPart,
  type UnderstandReadings,
} from './understand/schema.js';
export { type SumDrop } from './understand/sums.js';
export {
  RESULT_VERDICTS,
  SUM_UNITS,
  UNDERSTOOD_KINDS,
  UNDERSTOOD_REFERRALS,
  type RecordLine,
  type ResultVerdict,
  type SumUnit,
  type Understanding,
  type UnderstoodChoice,
  type UnderstoodKind,
  type UnderstoodReferral,
  type UnderstoodResult,
  type UnderstoodSum,
} from './understand/types.js';

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
export {
  ideationPrefilter,
  type IdeationFamily,
  type IdeationPrefilterResult,
} from './risk/ideation-prefilter.js';
export {
  SAFETY_SCREEN_CRISIS_RULE,
  SAFETY_SCREEN_MAX_OUTPUT_TOKENS,
  SAFETY_SCREEN_SCHEMA_NAME,
  SAFETY_SCREEN_SYSTEM_PROMPT,
  SAFETY_SCREEN_TIMEOUT_MS,
  SAFETY_SCREEN_WELLBEING_RULE,
  SafetyScreenVerdict,
  buildSafetyScreenMessages,
  safetyScreenOutcome,
  safetyScreenReason,
  withSafetyScreen,
  type SafetyScreenInput,
  type SafetyScreenOutcome,
} from './risk/safety-screen.js';
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
  DISCLAIMER_FALLBACK,
  IDENTITY_MARGIN_CHARS,
  identityQuestionOf,
  identityReplacement,
  isStyleFinding,
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
  MIN_KEPT_WORDS,
  cutMetaNarration,
  findMetaNarration,
  isThinkingAloudOpener,
  metaNarrationCue,
  type MetaNarrationCue,
  type MetaNarrationCut,
  type NarrationNames,
} from './validators/meta-narration.js';
export {
  REPEATED_GREETING_FALLBACK,
  openerSaidHello,
  withoutRepeatedGreeting,
} from './validators/greeting.js';
export {
  CLOSING_FALLBACK,
  REPEAT_FALLBACK,
  SHORT_BUDGET,
  SOCIAL_BUDGETS,
  YES_NO_BUDGET,
  asksToRepeat,
  isOnlyLeadIn,
  fourGramsOf,
  repeatsPrevious,
  signsOff,
  withinSocialBudget,
  withoutRepeats,
  withoutUnits,
  announcedCountGap,
  isProtectedLine,
  askedBefore,
  asksOnly,
  stuckOn,
  type QuestionTerms,
  type WithoutRepeats,
  type WithoutRepeatsOptions,
} from './validators/social.js';
export {
  asksForVerdict,
  nameBudgetSpent,
  withoutStockOpener,
  withoutVocativeName,
  type OpenerRewrite,
} from './validators/openers.js';
export {
  inventedFigures,
  numbersIn,
  withoutExampleFigures,
  type InventedFigures,
} from './validators/figures.js';
export {
  buildSupportIndex,
  checkCitationSupport,
  supportUnit,
  type CitationSupport,
  type SupportFinding,
  type SupportIndex,
  type SupportInput,
  type SupportSource,
  type UnitSupport,
} from './validators/citation-support.js';
export {
  carriesContract,
  checkReplyContract,
  composeFromGuidance,
  composedAnswer,
  contractApplies,
  contractTail,
  firstUnitVerdict,
  fitSpoken,
  namesStep,
  saidVerbatim,
  spokenReserve,
  standingLine,
  stepLine,
  type ContractVerdict,
  type ReplyContractInput,
} from './validators/reply-contract.js';
export {
  SentenceGate,
  findUnitEnd,
  holdBackFor,
  type GateBlockReason,
  type GateCutReason,
  type GateFallbackReason,
  type GateResult,
  type DroppedUnit,
  type GateStats,
  type GateTrace,
  type GateUnit,
  type SentenceGateOptions,
} from './validators/sentence-gate.js';
