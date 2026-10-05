/**
 * Query key factory. Keys are hierarchical so related data can be invalidated together:
 *   queryKeys.venture.scope(id) → everything cached for one venture (detail, overview, memory, …).
 * Always build keys through this factory; never inline arrays in components.
 */
export interface MemoryFilters {
  type?: string | undefined;
  status?: string | undefined;
  q?: string | undefined;
  pinned?: boolean | undefined;
}

export interface AuditFilters {
  action?: string | undefined;
  outcome?: string | undefined;
  limit?: number | undefined;
}

const ROOT = 'fa' as const;

export const queryKeys = {
  all: [ROOT] as const,
  health: () => [ROOT, 'health'] as const,
  me: () => [ROOT, 'me'] as const,

  ventures: {
    list: () => [ROOT, 'ventures'] as const,
  },
  venture: {
    scope: (ventureId: string) => [ROOT, 'venture', ventureId] as const,
    detail: (ventureId: string) => [ROOT, 'venture', ventureId, 'detail'] as const,
    overview: (ventureId: string) => [ROOT, 'venture', ventureId, 'overview'] as const,
    sessions: (ventureId: string) => [ROOT, 'venture', ventureId, 'sessions'] as const,
    memoryAll: (ventureId: string) => [ROOT, 'venture', ventureId, 'memory'] as const,
    memory: (ventureId: string, filters: MemoryFilters = {}) =>
      [ROOT, 'venture', ventureId, 'memory', filters] as const,
    documents: (ventureId: string) => [ROOT, 'venture', ventureId, 'documents'] as const,
    escalations: (ventureId: string) => [ROOT, 'venture', ventureId, 'escalations'] as const,
    team: (ventureId: string) => [ROOT, 'venture', ventureId, 'team'] as const,
  },
  session: {
    detail: (sessionId: string) => [ROOT, 'session', sessionId] as const,
  },
  turn: {
    evidence: (turnId: string) => [ROOT, 'turn', turnId, 'evidence'] as const,
  },
  memory: {
    history: (memoryId: string) => [ROOT, 'memory', memoryId, 'history'] as const,
  },
  inbox: {
    escalations: () => [ROOT, 'inbox', 'escalations'] as const,
  },
  personas: {
    all: () => [ROOT, 'personas'] as const,
    list: () => [ROOT, 'personas', 'list'] as const,
    detail: (personaId: string) => [ROOT, 'personas', 'detail', personaId] as const,
    release: (releaseId: string) => [ROOT, 'personas', 'release', releaseId] as const,
  },
  eir: {
    reviews: () => [ROOT, 'eir', 'reviews'] as const,
  },
  program: {
    all: () => [ROOT, 'program'] as const,
    portfolio: () => [ROOT, 'program', 'portfolio'] as const,
    ventures: () => [ROOT, 'program', 'ventures'] as const,
    resources: () => [ROOT, 'program', 'resources'] as const,
    escalations: () => [ROOT, 'program', 'escalations'] as const,
    assignees: () => [ROOT, 'program', 'assignees'] as const,
  },
  admin: {
    all: () => [ROOT, 'admin'] as const,
    principals: () => [ROOT, 'admin', 'principals'] as const,
    settings: () => [ROOT, 'admin', 'settings'] as const,
    usage: () => [ROOT, 'admin', 'usage'] as const,
    audit: (filters: AuditFilters = {}) => [ROOT, 'admin', 'audit', filters] as const,
  },
} as const;
