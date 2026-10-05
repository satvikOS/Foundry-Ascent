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
  JobMessage,
  ObjectNotFoundError,
  ObjectTooLargeError,
  noopCoreLogger,
  randomIds,
  systemClock,
  type Clock,
  type CoreLogFields,
  type CoreLogger,
  type ExtractedText,
  type IdGenerator,
  type JobQueue,
  type ObjectStore,
  type PresignPutInput,
  type PresignedUpload,
  type TextExtractor,
} from './ports.js';

export * from './auth/index.js';
export * from './authz/index.js';

export { type MeService } from './services/me.js';
export { type VenturesService } from './services/ventures.js';
export { type SessionsService, type EndSessionResult } from './services/sessions.js';
export { type MemoryService } from './services/memory.js';
export { documentKey, storageFilename, type DocumentsService } from './services/documents.js';
export { type EscalationsService } from './services/escalations.js';
export { assemblePacket, dueAtFor, type PacketInput } from './services/escalation-packet.js';
export { type TeamService } from './services/team.js';
export { type EirStudioService } from './services/eir-studio.js';
export { ResourceFilter, UpdateResourceRequest, type ProgramService } from './services/program.js';
export { type AdminService, type AuditPage } from './services/admin.js';

export {
  RunTurnInput,
  type Orchestrator,
  type RunTurnOptions,
  type RunTurnOutcome,
  type TurnEmitter,
} from './orchestrator/run-turn.js';
export {
  buildEvidencePack,
  classificationsFor,
  type EvidencePack,
  type KeyedEvidence,
} from './orchestrator/evidence.js';
export { assembleContext, estimateTokens, type AssembledContext } from './orchestrator/context-budget.js';
export { secondsUntilUtcMidnight, shouldSampleForReview } from './orchestrator/sampling.js';
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
