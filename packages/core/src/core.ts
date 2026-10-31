import { PlatformKeyCache } from './auth/keys.js';
import { createAuthService, type AuthService } from './auth/service.js';
import { resolveDeps, type CoreDeps } from './deps.js';
import { createIngestionProcessor, type IngestionProcessor } from './ingestion/processor.js';
import { DirectoryCache } from './internal/directory.js';
import { Kit } from './internal/kit.js';
import { createOrchestrator, type Orchestrator } from './orchestrator/run-turn.js';
import { createTestBench, type TestBench } from './orchestrator/test-turn.js';
import { createAdminService, type AdminService } from './services/admin.js';
import { createCallsService, type CallsService } from './services/calls.js';
import { createDistillService, type DistillService } from './services/distill.js';
import { createDocumentReaderService, type DocumentReaderService } from './services/document-reader.js';
import { createDocumentsService, type DocumentsService } from './services/documents.js';
import { createEirProfilesService, type EirProfilesService } from './services/eir-profiles.js';
import { createEirStudioService, type EirStudioService } from './services/eir-studio.js';
import { createEscalationsService, type EscalationsService } from './services/escalations.js';
import { createFaceHooks, createFaceService, type FaceService } from './services/face.js';
import { createKnowledgeLibraryService, type KnowledgeLibraryService } from './services/knowledge-library.js';
import { createLessonsService, type LessonsService } from './services/lessons.js';
import { createMaintenanceService, type MaintenanceService } from './services/maintenance.js';
import { createMeService, type MeService } from './services/me.js';
import { createMemoryService, type MemoryService } from './services/memory.js';
import { createNotebookService, type NotebookService } from './services/notebook.js';
import { createPersonaManagementService, type PersonaManagementService } from './services/personas.js';
import { createProgramService, type ProgramService } from './services/program.js';
import { createSessionsService, type SessionsService } from './services/sessions.js';
import { createSpeechService, type SpeechService } from './services/speech.js';
import { createTeamService, type TeamService } from './services/team.js';
import { createTwinService, type TwinService } from './services/twin.js';
import { createVeirService, type VeirService } from './services/veir.js';
import { createVenturesService, type VenturesService } from './services/ventures.js';

/** Every domain service, bound to one set of dependencies. Create once per container. */
export interface Core {
  readonly auth: AuthService;
  readonly me: MeService;
  readonly ventures: VenturesService;
  readonly sessions: SessionsService;
  readonly orchestrator: Orchestrator;
  /** The EIR studio test bench: a curator tries a release of their vEIR; nothing is stored. */
  readonly testBench: TestBench;
  readonly memory: MemoryService;
  readonly documents: DocumentsService;
  /** The document viewer: a document's original file and the text of the sources a vEIR cites. */
  readonly reader: DocumentReaderService;
  readonly ingestion: IngestionProcessor;
  readonly escalations: EscalationsService;
  readonly team: TeamService;
  readonly eir: EirStudioService;
  /** The EIR registry: profiles of the people vEIRs are built from (program lead or platform admin). */
  readonly eirProfiles: EirProfilesService;
  readonly program: ProgramService;
  readonly admin: AdminService;
  readonly maintenance: MaintenanceService;
  /** Distillation: digests, the notebook, memory proposals and lesson drafts from conversations. */
  readonly distill: DistillService;
  /** The vEIR notebook of a venture (specific pool). */
  readonly notebook: NotebookService;
  /** The vEIR a venture talks to, call configuration and avatar sessions. */
  readonly veir: VeirService;
  /** Voice calls: start, heartbeat, barge-in, end and summary. */
  readonly calls: CallsService;
  /** Text-to-speech of validated replies during calls. */
  readonly speech: SpeechService;
  /** The face of a call: its vendor session, and relaying verified audio to it. */
  readonly face: FaceService;
  /** The vEIR's digital twin in the studio: its face and cloned voice, and withdrawing a consent scope. */
  readonly twin: TwinService;
  /** Persona lifecycle: EIR personas, consent, embodiment, assignments. */
  readonly personas: PersonaManagementService;
  /** A persona's knowledge library (common pool). */
  readonly library: KnowledgeLibraryService;
  /** Lessons of a persona's common pool. */
  readonly lessons: LessonsService;
}

export function createCore(deps: CoreDeps): Core {
  const kit = new Kit(resolveDeps(deps));
  const directory = new DirectoryCache(kit);
  // Signs and verifies call speech units (retired keys verify for as long as a session token may live).
  const speechKeys = new PlatformKeyCache(
    kit,
    Math.max(kit.config.session.keyGraceSeconds, kit.config.session.ttlSeconds),
  );
  const auth = createAuthService(kit);
  const distill = createDistillService(kit, directory);
  const onPrincipalChanged = (principalId: string): void => {
    auth.invalidatePrincipal(principalId);
  };
  const faceHooks = createFaceHooks(kit);
  const face = createFaceService(kit, speechKeys, faceHooks);
  // A blocked or failed turn's pre-approved units are withdrawn from the face through its transcript check.
  const speech = createSpeechService(kit, speechKeys, faceHooks);
  return {
    auth,
    me: createMeService(kit),
    ventures: createVenturesService(kit, directory),
    sessions: createSessionsService(kit, directory),
    // One key cache signs the turn engine's speech units and verifies them for calls and /speech. A spoken turn on
    // a call with a live FULL face admits each unit to the face as it signs it (the speech service's checks).
    orchestrator: createOrchestrator(kit, directory, { speechKeys, facePreapproval: speech }),
    testBench: createTestBench(kit, directory),
    memory: createMemoryService(kit),
    documents: createDocumentsService(kit),
    reader: createDocumentReaderService(kit),
    ingestion: createIngestionProcessor(kit),
    escalations: createEscalationsService(kit),
    team: createTeamService(kit, onPrincipalChanged),
    eir: createEirStudioService(kit),
    eirProfiles: createEirProfilesService(kit, directory),
    program: createProgramService(kit, directory),
    admin: createAdminService(kit, onPrincipalChanged),
    maintenance: createMaintenanceService(kit, distill, faceHooks),
    distill,
    notebook: createNotebookService(kit, directory),
    veir: createVeirService(kit, face),
    calls: createCallsService(kit, directory, speechKeys, distill, faceHooks),
    speech,
    face,
    twin: createTwinService(kit),
    personas: createPersonaManagementService(kit, directory),
    library: createKnowledgeLibraryService(kit),
    lessons: createLessonsService(kit),
  };
}
