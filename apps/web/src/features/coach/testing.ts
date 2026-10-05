/**
 * Test fixtures for the venture workspace features (synthetic data only). Imported by *.test.ts(x)
 * files; never by application code.
 */
import type {
  CoachResponse,
  EvidenceItem,
  MemoryObjectView,
  SessionView,
  TurnView,
  ValidatorResults,
} from '@foundry/contracts';

export const IDS = {
  venture: '0b9d1f0e-6a0c-4f39-9d0e-5d3b8a1c2e01',
  session: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e02',
  turn: '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f03',
  memory: '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a04',
  memory2: '4f5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b05',
  principal: '5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c06',
  ref: '6b7c8d9e-0f1a-4b2c-9d4e-5f6a7b8c9d07',
} as const;

const NOW = '2026-10-01T12:00:00.000Z';

export function makeEvidence(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    key: 'E1',
    kind: 'memory',
    refId: IDS.ref,
    title: '14 problem interviews with undergraduates',
    excerpt: 'Nine of fourteen students described walking between buildings.',
    score: 0.82,
    freshnessAt: NOW,
    status: 'confirmed',
    ...overrides,
  };
}

export function makeValidator(overrides: Partial<ValidatorResults> = {}): ValidatorResults {
  return {
    unknownEvidenceIdsRemoved: 0,
    factsDowngraded: 0,
    groundingCoverage: 0.9,
    narrowed: false,
    escalationForced: false,
    identityViolation: false,
    crossVentureViolation: false,
    riskCategories: [],
    notes: [],
    ...overrides,
  };
}

export function makeResponse(overrides: Partial<CoachResponse> = {}): CoachResponse {
  return {
    mode: 'diagnose',
    answer: 'Your riskiest assumption is repeat use outside exam weeks [E1].',
    claims: [
      {
        text: 'Nine of fourteen students walk between buildings to find a seat.',
        kind: 'fact',
        evidence_ids: ['E1'],
      },
      { text: 'Demand is concentrated before exams.', kind: 'inference', evidence_ids: ['E1', 'E2'] },
      { text: 'Students would install an app for this.', kind: 'hypothesis', evidence_ids: [] },
      { text: 'Rerun the test during exam week.', kind: 'recommendation', evidence_ids: [] },
    ],
    uncertainty: [{ item: 'Whether libraries will share occupancy data', level: 'high' }],
    challenge: 'What would convince you that everyday demand is real?',
    next_actions: [{ owner: 'Maya', action: 'Interview five library staff', target_date: '2026-10-10' }],
    escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
    memory_candidates: [
      {
        type: 'insight',
        title: 'Exam weeks drive demand',
        content: 'Usage spikes before exams.',
        evidence_ids: ['E1'],
        confidence: 0.6,
      },
    ],
    follow_up_questions: ['How would you measure repeat use?'],
    rehearsal: null,
    ...overrides,
  };
}

export function makeTurn(overrides: Partial<TurnView> = {}): TurnView {
  return {
    id: IDS.turn,
    sessionId: IDS.session,
    ordinal: 1,
    mode: 'diagnose',
    founderText: 'What is my riskiest assumption?',
    status: 'completed',
    response: makeResponse(),
    evidence: [
      makeEvidence(),
      makeEvidence({ key: 'E2', kind: 'chunk', title: 'Exam-week interview synthesis', status: null }),
    ],
    validator: makeValidator(),
    usage: null,
    createdAt: NOW,
    completedAt: NOW,
    blocked: null,
    ...overrides,
  };
}

export function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: IDS.session,
    ventureId: IDS.venture,
    mode: 'diagnose',
    privacy: 'standard',
    goal: 'Find the riskiest assumption',
    status: 'active',
    personaName: 'Foundry Guide',
    personaVersion: 1,
    disclosure: 'You are working with Foundry Guide, an AI coach.',
    startedBy: { id: IDS.principal, displayName: 'Maya Example' },
    startedAt: NOW,
    endedAt: null,
    turnCount: 1,
    recap: null,
    ...overrides,
  };
}

export function makeMemory(overrides: Partial<MemoryObjectView> = {}): MemoryObjectView {
  return {
    id: IDS.memory,
    ventureId: IDS.venture,
    type: 'insight',
    title: 'Exam weeks drive demand',
    content: 'Usage spikes before exams.',
    attributes: {},
    status: 'proposed',
    visibility: 'venture',
    confidence: 0.6,
    sourceRefs: [{ kind: 'turn', id: IDS.turn }],
    origin: 'ai',
    createdBy: { id: IDS.principal, displayName: 'Maya Example', title: null, synthetic: true },
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
