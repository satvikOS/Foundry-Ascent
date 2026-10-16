/**
 * Synthetic fixtures for the Knowledge, memory, documents and help tests. Imported by *.test.ts(x)
 * files only, never by application code.
 */
import type {
  DocumentView,
  EvidenceItem,
  MemoryObjectView,
  SessionView,
  TurnView,
  VeirNotebook,
  VentureDetail,
} from '@foundry/contracts';

export const IDS = {
  venture: '0b9d1f0e-6a0c-4f39-9d0e-5d3b8a1c2e01',
  persona: '7c8d9e0f-1a2b-4c3d-8e4f-6a7b8c9d0e08',
  session: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e02',
  session2: '8d9e0f1a-2b3c-4d4e-9f5a-7b8c9d0e1f09',
  turn: '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f03',
  memory: '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a04',
  memory2: '4f5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b05',
  memory3: '9e0f1a2b-3c4d-4e5f-8a6b-8c9d0e1f2a10',
  principal: '5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c06',
  document: '6b7c8d9e-0f1a-4b2c-9d4e-5f6a7b8c9d07',
  chunk: 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c11',
  resource: 'b1c2d3e4-f5a6-4b7c-9d8e-0f1a2b3c4d12',
  escalation: 'c2d3e4f5-a6b7-4c8d-8e9f-1a2b3c4d5e13',
  release: 'd3e4f5a6-b7c8-4d9e-9f0a-2b3c4d5e6f14',
  eir: 'e4f5a6b7-c8d9-4e0f-8a1b-3c4d5e6f7a15',
} as const;

export const NOW = '2026-10-01T12:00:00.000Z';

/** `count` distinct, valid ids (for selections larger than one request takes). */
export function manyIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  );
}
const person = { id: IDS.principal, displayName: 'Maya Okafor-Lindqvist', title: null, synthetic: true };

/** QuietQuad-like venture with Corin's vEIR assigned (what the vEIR's name and author copy read). */
export function makeVenture(overrides: Partial<VentureDetail> = {}): VentureDetail {
  return {
    id: IDS.venture,
    name: 'QuietQuad',
    oneLiner: 'Live study-seat map for exam weeks.',
    stage: 'validation',
    domain: 'consumer',
    status: 'active',
    myRole: 'founder',
    lastSessionAt: NOW,
    openActions: 0,
    pendingMemory: 0,
    openEscalations: 0,
    cohort: null,
    classification: 'synthetic',
    currentGoal: null,
    persona: {
      personaId: IDS.persona,
      releaseId: IDS.release,
      name: 'Corin’s vEIR',
      kind: 'eir_persona',
      version: 1,
      status: 'active',
      disclosure: 'Corin’s vEIR is an AI coach.',
      allowedModes: ['diagnose', 'coach'],
    },
    assignedEir: { id: IDS.eir, displayName: 'Corin Halvorsen', synthetic: true },
    createdAt: NOW,
    ...overrides,
  };
}

export function makeMemory(overrides: Partial<MemoryObjectView> = {}): MemoryObjectView {
  return {
    id: IDS.memory,
    ventureId: IDS.venture,
    type: 'insight',
    title: 'Exam weeks drive demand',
    content: 'Usage spikes in the two weeks before exams.',
    contentLength: 44,
    attributes: {},
    status: 'proposed',
    visibility: 'venture',
    confidence: 0.6,
    sourceRefs: [{ kind: 'session', id: IDS.session, label: 'Conversation' }],
    origin: 'ai',
    createdBy: person,
    approvedBy: null,
    approvedAt: null,
    version: 1,
    supersedesId: null,
    pinned: false,
    expiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeNotebook(overrides: Partial<VeirNotebook> = {}): VeirNotebook {
  const entry = (id: string, text: string) => ({ id, text, sourceSessionId: IDS.session, createdAt: NOW });
  return {
    ventureId: IDS.venture,
    personaId: IDS.persona,
    personaName: 'Corin’s vEIR',
    summary: 'Maya is testing whether exam-week seat scarcity is painful enough to use a live map.',
    founderProfile: [entry('fp-numbers', 'Likes to see the numbers first.')],
    commitments: [
      {
        id: 'c-interviews',
        text: 'Interview five library staff',
        due: '2026-10-08',
        status: 'open',
        sourceSessionId: IDS.session,
        createdAt: NOW,
      },
    ],
    openQuestions: [entry('q-chat', 'Would students open a map instead of the group chat?')],
    lastAdvice: [entry('a-rerun', 'Rerun the map only in the two weeks before finals.')],
    nextOpener: 'Last time you planned five library-staff interviews. How did they go?',
    version: 3,
    updatedAt: NOW,
    lastEditedBy: 'veir',
    ...overrides,
  };
}

export function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: IDS.session,
    ventureId: IDS.venture,
    mode: 'diagnose',
    privacy: 'standard',
    goal: null,
    status: 'ended',
    personaName: 'Corin’s vEIR',
    personaVersion: 1,
    disclosure: 'Corin’s vEIR is an AI coach.',
    startedBy: { id: IDS.principal, displayName: 'Maya Okafor-Lindqvist' },
    startedAt: NOW,
    endedAt: NOW,
    turnCount: 2,
    recap: null,
    title: 'Is exam-week demand strong enough for a pilot?',
    personaId: IDS.persona,
    lastActivityAt: NOW,
    hasCalls: false,
    digest: {
      summary: 'Maya reviewed the seat-map test and chose to rerun it before finals.',
      topics: ['Seat-map test', 'Exam-week focus'],
      commitments: [{ text: 'Interview five library staff', due: '2026-10-08' }],
      openQuestions: ['Will students open a map instead of the group chat?'],
      generatedAt: NOW,
    },
    opener: null,
    ...overrides,
  };
}

export function makeDocument(overrides: Partial<DocumentView> = {}): DocumentView {
  return {
    id: IDS.document,
    ventureId: IDS.venture,
    filename: 'exam-week-interviews.md',
    contentType: 'text/markdown',
    sizeBytes: 769,
    status: 'ready',
    failureReason: null,
    uploadedBy: person,
    createdAt: NOW,
    chunkCount: 4,
    ...overrides,
  };
}

export function makeEvidence(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    key: 'E1',
    kind: 'memory',
    refId: IDS.memory,
    title: 'Exam weeks drive demand',
    excerpt: 'Usage spikes in the two weeks before exams.',
    score: 0.8,
    freshnessAt: NOW,
    status: 'confirmed',
    ...overrides,
  };
}

/** A completed turn carrying only what the Knowledge page reads (its evidence). */
export function makeTurnWithEvidence(evidence: EvidenceItem[], id: string = IDS.turn): TurnView {
  return {
    id,
    sessionId: IDS.session,
    ordinal: 1,
    mode: 'diagnose',
    founderText: 'What should we test next?',
    status: 'completed',
    response: null,
    evidence,
    validator: null,
    usage: null,
    createdAt: NOW,
    completedAt: NOW,
    blocked: null,
    channel: 'text',
  };
}
