import { createAuthService, type AuthService } from './auth/service.js';
import { resolveDeps, type CoreDeps } from './deps.js';
import { createIngestionProcessor, type IngestionProcessor } from './ingestion/processor.js';
import { DirectoryCache } from './internal/directory.js';
import { Kit } from './internal/kit.js';
import { createOrchestrator, type Orchestrator } from './orchestrator/run-turn.js';
import { createAdminService, type AdminService } from './services/admin.js';
import { createDocumentsService, type DocumentsService } from './services/documents.js';
import { createEirStudioService, type EirStudioService } from './services/eir-studio.js';
import { createEscalationsService, type EscalationsService } from './services/escalations.js';
import { createMaintenanceService, type MaintenanceService } from './services/maintenance.js';
import { createMeService, type MeService } from './services/me.js';
import { createMemoryService, type MemoryService } from './services/memory.js';
import { createProgramService, type ProgramService } from './services/program.js';
import { createSessionsService, type SessionsService } from './services/sessions.js';
import { createTeamService, type TeamService } from './services/team.js';
import { createVenturesService, type VenturesService } from './services/ventures.js';

/** Every domain service, bound to one set of dependencies. Create once per container. */
export interface Core {
  readonly auth: AuthService;
  readonly me: MeService;
  readonly ventures: VenturesService;
  readonly sessions: SessionsService;
  readonly orchestrator: Orchestrator;
  readonly memory: MemoryService;
  readonly documents: DocumentsService;
  readonly ingestion: IngestionProcessor;
  readonly escalations: EscalationsService;
  readonly team: TeamService;
  readonly eir: EirStudioService;
  readonly program: ProgramService;
  readonly admin: AdminService;
  readonly maintenance: MaintenanceService;
}

export function createCore(deps: CoreDeps): Core {
  const kit = new Kit(resolveDeps(deps));
  const directory = new DirectoryCache(kit);
  const auth = createAuthService(kit);
  const onPrincipalChanged = (principalId: string): void => {
    auth.invalidatePrincipal(principalId);
  };
  return {
    auth,
    me: createMeService(kit),
    ventures: createVenturesService(kit, directory),
    sessions: createSessionsService(kit, directory),
    orchestrator: createOrchestrator(kit, directory),
    memory: createMemoryService(kit),
    documents: createDocumentsService(kit),
    ingestion: createIngestionProcessor(kit),
    escalations: createEscalationsService(kit),
    team: createTeamService(kit, onPrincipalChanged),
    eir: createEirStudioService(kit),
    program: createProgramService(kit, directory),
    admin: createAdminService(kit, onPrincipalChanged),
    maintenance: createMaintenanceService(kit),
  };
}
