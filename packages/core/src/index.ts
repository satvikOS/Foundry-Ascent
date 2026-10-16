// @foundry/core — domain services, authorization and the coaching orchestrator.

export { createCore, type Core } from './core.js';
export { resolveDeps, type CoreDeps, type ResolvedDeps } from './deps.js';
export { createRequestContext, toDbContext, type RequestContext } from './context.js';
export {
  DomainError,
  fail,
  fieldErrors,
  isDomainError,
  parseInput,
  toDomainError,
  type DomainErrorOptions,
  type FieldError,
} from './errors.js';
export { CoreConfig, DEFAULT_CORE_CONFIG, coreConfig, loadConfig, type EnvLike } from './config.js';
export {
  ExtractionFailedError,
  IngestDocumentJob,
  IngestKnowledgeSourceJob,
  JobMessage,
  MAX_JOB_DELAY_SECONDS,
  ObjectNotFoundError,
  ObjectTooLargeError,
  noopCoreLogger,
  randomIds,
  systemClock,
  type Clock,
  type CoreLogFields,
  type CoreLogger,
  type EnqueueOptions,
  type ExtractedText,
  type IdGenerator,
  type JobQueue,
  type ObjectStore,
  type PresignPutInput,
  type PresignedUpload,
  SpeechSynthesisError,
  type SpeechEngine,
  type SpeechSynthesisInput,
  type SpeechSynthesizer,
  type SynthesizedSpeech,
  SttGrantError,
  type IssuedSttGrant,
  type SttGrantIssuer,
  type SttGrantRequest,
  type TextExtractor,
} from './ports.js';

export * from './auth/index.js';
export * from './authz/index.js';

export { type MeService } from './services/me.js';
export { type VenturesService } from './services/ventures.js';
export { type SessionsService, type EndSessionResult, type SessionPageResult } from './services/sessions.js';
export {
  applyNotebookEdit,
  isSuppressed,
  notebookFingerprint,
  type NotebookEditResult,
  type NotebookService,
} from './services/notebook.js';
export {
  embodimentView,
  resolveVeir,
  shortName,
  type ResolvedVeir,
  type VeirService,
} from './services/veir.js';
export { type SpeechService } from './services/speech.js';
export {
  historyAsHeard,
  isCrisisMessage,
  speakableRun,
  speakableText,
  splitSentences,
} from './services/spoken-text.js';
export { CALL_LIMITS } from './services/call-usage.js';
export { admitVoiceTurn, type AdmitVoiceTurn, type VoiceTurnAdmission } from './services/call-admission.js';
export { STT_LANGUAGE, STT_SAMPLE_RATE_HERTZ, type CallsService } from './services/calls.js';
export {
  DEFAULT_SPEECH_VOICE,
  SPEECH_PRICE_PER_MILLION_CHARS,
  SPEECH_VOICES,
  isSpeechVoice,
  speechCostUsd,
  speechEngines,
} from './services/voices.js';
export { type PersonaManagementService } from './services/personas.js';
export {
  personaSourceKey,
  summarize as summarizeAuthoredText,
  type KnowledgeLibraryService,
} from './services/knowledge-library.js';
export { type LessonsService } from './services/lessons.js';
export { MEMORY_PAGE_DEFAULT, type MemoryPage, type MemoryService } from './services/memory.js';
export { type MaintenanceReport, type MaintenanceService } from './services/maintenance.js';
export {
  RetryableDistillError,
  type DistillBackstopReport,
  type DistillJobInput,
  type DistillOutcome,
  type DistillRunOptions,
  type DistillService,
} from './services/distill.js';
export { documentKey, storageFilename, type DocumentsService } from './services/documents.js';
export { type EscalationsService } from './services/escalations.js';
export { assemblePacket, dueAtFor, type PacketInput } from './services/escalation-packet.js';
export { type TeamService } from './services/team.js';
export { type EirStudioService } from './services/eir-studio.js';
export { type EirProfilesService } from './services/eir-profiles.js';
export { ResourceFilter, UpdateResourceRequest, type ProgramService } from './services/program.js';
export { type AdminService, type AuditPage } from './services/admin.js';

export {
  RunTurnInput,
  errorEvent as turnErrorEvent,
  type Orchestrator,
  type RunTurnOptions,
  type RunTurnOutcome,
  type TurnEmitter,
} from './orchestrator/run-turn.js';
export { type RunTestTurnInput, type TestBench } from './orchestrator/test-turn.js';
export {
  buildEvidencePack,
  candidateVisibility,
  classificationsFor,
  type EvidencePack,
  type EvidencePackOptions,
  type KeyedEvidence,
} from './orchestrator/evidence.js';
export { privateRetrievalOwner } from './orchestrator/retrieval.js';
export { assembleContext, estimateTokens, type AssembledContext } from './orchestrator/context-budget.js';
export { secondsUntilUtcMidnight, shouldSampleForReview } from './orchestrator/sampling.js';
export {
  blockedDetailOf,
  participantBlockReason,
  participantRiskLabel,
  participantTurnView,
  participantValidator,
  supportMessageFor,
} from './orchestrator/blocked.js';
export { VENTURE_NAME_UNIQUE_CONSTRAINT, assertDistinctiveVentureName } from './internal/venture-names.js';
export { spendCapExceeded, type SpendState } from './orchestrator/guards.js';
export { RECAP_SCHEMA_NAME, RecapDraft, buildRecapPrompt, sanitizeRecap } from './orchestrator/recap.js';

export {
  RetryableIngestionError,
  type IngestionProcessOptions,
  type IngestionProcessor,
  type IngestionResult,
} from './ingestion/processor.js';
export {
  chunkText,
  chunkTokens,
  normalizeExtractedText,
  type ChunkOptions,
  type TextChunk,
} from './ingestion/chunker.js';
