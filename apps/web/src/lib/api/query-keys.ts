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

/** `GET /sessions` filters (the caller's conversations; see `SessionListQuery`). */
export interface ConversationFilters {
  scope: 'mine' | 'all';
  ventureId?: string | undefined;
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
    all: () => [ROOT, 'venture'] as const,
    scope: (ventureId: string) => [ROOT, 'venture', ventureId] as const,
    detail: (ventureId: string) => [ROOT, 'venture', ventureId, 'detail'] as const,
    overview: (ventureId: string) => [ROOT, 'venture', ventureId, 'overview'] as const,
    memoryAll: (ventureId: string) => [ROOT, 'venture', ventureId, 'memory'] as const,
    memory: (ventureId: string, filters: MemoryFilters = {}) =>
      [ROOT, 'venture', ventureId, 'memory', filters] as const,
    documents: (ventureId: string) => [ROOT, 'venture', ventureId, 'documents'] as const,
    escalations: (ventureId: string) => [ROOT, 'venture', ventureId, 'escalations'] as const,
    team: (ventureId: string) => [ROOT, 'venture', ventureId, 'team'] as const,
    notebook: (ventureId: string) => [ROOT, 'venture', ventureId, 'notebook'] as const,
    /** `GET /ventures/:id/opener`: how the vEIR would open a new conversation now (New chat's greeting). */
    opener: (ventureId: string) => [ROOT, 'venture', ventureId, 'opener'] as const,
    /** `GET /ventures/:id/sessions`: one venture's conversations (Knowledge reads their digests). */
    sessions: (ventureId: string) => [ROOT, 'venture', ventureId, 'sessions'] as const,
  },
  session: {
    detail: (sessionId: string) => [ROOT, 'session', sessionId] as const,
  },
  conversations: {
    all: () => [ROOT, 'conversations'] as const,
    list: (filters: ConversationFilters) => [ROOT, 'conversations', filters] as const,
  },
  memory: {
    history: (memoryId: string) => [ROOT, 'memory', memoryId, 'history'] as const,
    item: (memoryId: string) => [ROOT, 'memory', memoryId, 'item'] as const,
  },
  inbox: {
    escalations: () => [ROOT, 'inbox', 'escalations'] as const,
  },
  personas: {
    all: () => [ROOT, 'personas'] as const,
    list: () => [ROOT, 'personas', 'list'] as const,
    detail: (personaId: string) => [ROOT, 'personas', 'detail', personaId] as const,
    release: (releaseId: string) => [ROOT, 'personas', 'release', releaseId] as const,
    library: (personaId: string) => [ROOT, 'personas', 'library', personaId] as const,
    lessons: (personaId: string) => [ROOT, 'personas', 'lessons', personaId] as const,
    /** `GET /lessons?status=draft,in_review`: lessons waiting in every vEIR the person curates. */
    lessonsToReview: () => [ROOT, 'personas', 'lessons-to-review'] as const,
    consents: (personaId: string) => [ROOT, 'personas', 'consents', personaId] as const,
    embodiment: (personaId: string) => [ROOT, 'personas', 'embodiment', personaId] as const,
  },
  eir: {
    reviews: () => [ROOT, 'eir', 'reviews'] as const,
    profiles: () => [ROOT, 'eir', 'profiles'] as const,
    candidates: () => [ROOT, 'eir', 'candidates'] as const,
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
    insights: () => [ROOT, 'admin', 'insights'] as const,
    audit: (filters: AuditFilters = {}) => [ROOT, 'admin', 'audit', filters] as const,
  },
} as const;
