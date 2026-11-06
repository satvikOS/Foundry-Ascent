/**
 * The landing page's synthetic session as the app's own types (`@foundry/contracts`), so the device ad and the
 * session cards render the real components with data shaped exactly as the API sends it. The words live in
 * session.json (content, not interface copy); this module only gives them their shapes.
 */
import type {
  CallConfigResponse,
  CoachResponse,
  EvidenceItem,
  Me,
  MemoryObjectView,
  MemoryType,
  SessionView,
  TurnView,
  VentureDetail,
} from '@foundry/contracts';

import session from './session.json';

export const AD_SESSION = session;

/** Fixed ids and times: the ad is the same on every visit. */
export const AD_IDS = {
  tenant: '6d1f0c8e-2b4a-4c3e-9a71-0f5e2d8c4b10',
  principal: '6d1f0c8e-2b4a-4c3e-9a71-0f5e2d8c4b11',
  venture: '6d1f0c8e-2b4a-4c3e-9a71-0f5e2d8c4b12',
  persona: '6d1f0c8e-2b4a-4c3e-9a71-0f5e2d8c4b13',
  release: '6d1f0c8e-2b4a-4c3e-9a71-0f5e2d8c4b14',
  eir: '6d1f0c8e-2b4a-4c3e-9a71-0f5e2d8c4b15',
  session: '6d1f0c8e-2b4a-4c3e-9a71-0f5e2d8c4b16',
  turn: '6d1f0c8e-2b4a-4c3e-9a71-0f5e2d8c4b17',
  ref1: '6d1f0c8e-2b4a-4c3e-9a71-0f5e2d8c4b18',
  ref2: '6d1f0c8e-2b4a-4c3e-9a71-0f5e2d8c4b19',
} as const;

/** Never a real tenant: the ad's links lead nowhere (its subtree is inert). */
export const AD_TENANT = 'example';
const AT = '2026-11-05T15:42:00.000Z';
const person = { id: AD_IDS.principal, displayName: session.founder, title: null, synthetic: true };
/** The persona's display name, as the product shows it: just the name. */
const veirName = session.eir.firstName;

export const AD_ME: Me = {
  principal: person,
  tenant: { id: AD_IDS.tenant, slug: AD_TENANT, name: 'Example', kind: 'home' },
  roles: [],
  memberships: [{ ventureId: AD_IDS.venture, ventureName: session.venture.name, role: 'founder' }],
  assignedVentureIds: [],
  disclosure: 'AI',
  aiEnabled: true,
  notices: [],
  veirWelcomeAcknowledgedAt: AT,
};

export const AD_VENTURE: VentureDetail = {
  id: AD_IDS.venture,
  name: session.venture.name,
  oneLiner: session.venture.oneLiner,
  stage: 'validation',
  domain: 'hardware',
  status: 'active',
  myRole: 'founder',
  lastSessionAt: AT,
  openActions: 1,
  pendingMemory: 0,
  openEscalations: 0,
  cohort: null,
  classification: 'synthetic',
  currentGoal: null,
  persona: {
    personaId: AD_IDS.persona,
    releaseId: AD_IDS.release,
    name: veirName,
    kind: 'eir_persona',
    version: 1,
    status: 'active',
    disclosure: `${veirName} is an AI.`,
    allowedModes: ['diagnose', 'coach'],
    eirFirstName: session.eir.firstName,
    firstPerson: true,
    eirSeesWork: true,
  },
  assignedEir: { id: AD_IDS.eir, displayName: session.eir.fullName, synthetic: true },
  createdAt: AT,
};

export const AD_CALL_CONFIG: CallConfigResponse = {
  veir: {
    personaId: AD_IDS.persona,
    name: veirName,
    shortName: session.eir.firstName,
    kind: 'eir_persona',
    eirDisplayName: session.eir.fullName,
    tagline: null,
    disclosure: `${veirName} is an AI.`,
    embodiment: {
      provider: 'builtin',
      voiceId: null,
      portraitUrl: null,
      voiceConsented: false,
      likenessConsented: false,
    },
    firstPerson: true,
    eirSeesWork: true,
  },
  provider: 'builtin',
  maxMinutes: 30,
  remainingMinutesToday: 30,
  aiEnabled: true,
  callsEnabled: true,
  callNoticeAcknowledgedAt: AT,
};

function conversation(index: number, title: string, minutesAgo: number): SessionView {
  const at = new Date(Date.parse(AT) - minutesAgo * 60_000).toISOString();
  return {
    id: `6d1f0c8e-2b4a-4c3e-9a71-0f5e2d8c4c${String(index).padStart(2, '0')}`,
    ventureId: AD_IDS.venture,
    mode: 'coach',
    privacy: 'standard',
    goal: null,
    status: 'ended',
    personaName: veirName,
    personaVersion: 1,
    disclosure: `${veirName} is an AI.`,
    startedBy: { id: AD_IDS.principal, displayName: session.founder },
    startedAt: at,
    endedAt: at,
    turnCount: 4,
    recap: null,
    title,
    personaId: AD_IDS.persona,
    personaKind: 'eir_persona',
    lastActivityAt: at,
    hasCalls: index === 1,
    digestDeleted: false,
    digest: null,
    opener: null,
  };
}

/** The sidebar's recent conversations (the ad's own conversation joins them once it has a message). */
export const AD_RECENT: SessionView[] = session.recent.map((title, index) =>
  conversation(index + 1, title, (index + 1) * 60 * 24),
);

export const AD_CURRENT: SessionView = {
  ...conversation(0, session.question, 0),
  id: AD_IDS.session,
  status: 'active',
  endedAt: null,
  turnCount: 1,
  hasCalls: true,
  opener: session.opener,
};

export const AD_EVIDENCE: EvidenceItem[] = session.evidence.map((item, index) => ({
  key: item.key,
  kind: item.kind === 'memory' ? 'memory' : 'chunk',
  refId: index === 0 ? AD_IDS.ref1 : AD_IDS.ref2,
  title: item.title,
  excerpt: item.excerpt,
  score: 0.8,
  freshnessAt: AT,
  status: item.kind === 'memory' ? 'confirmed' : null,
}));

const decision = session.record[0];

export const AD_RESPONSE: CoachResponse = {
  mode: 'coach',
  answer: session.answer,
  claims: [
    { text: session.evidence[0]?.excerpt ?? '', kind: 'fact', evidence_ids: ['E1'] },
    { text: session.evidence[1]?.excerpt ?? '', kind: 'fact', evidence_ids: ['E2'] },
  ],
  uncertainty: [],
  challenge: null,
  next_actions: [
    {
      owner: session.founder.split(' ')[0] ?? '',
      action: session.nextStep.action,
      target_date: session.nextStep.due,
    },
  ],
  escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
  memory_candidates: decision
    ? [
        {
          type: 'decision',
          title: decision.title,
          content: decision.content,
          evidence_ids: ['E1'],
          confidence: 0.8,
        },
      ]
    : [],
  follow_up_questions: [],
  rehearsal: null,
};

export const AD_TURN: TurnView = {
  id: AD_IDS.turn,
  sessionId: AD_IDS.session,
  ordinal: 1,
  mode: 'coach',
  founderText: session.question,
  status: 'completed',
  response: AD_RESPONSE,
  evidence: AD_EVIDENCE,
  validator: {
    unknownEvidenceIdsRemoved: 0,
    factsDowngraded: 0,
    groundingCoverage: 1,
    narrowed: false,
    escalationForced: false,
    identityViolation: false,
    crossVentureViolation: false,
    riskCategories: [],
    notes: [],
  },
  usage: null,
  createdAt: AT,
  completedAt: AT,
  blocked: null,
  channel: 'text',
  author: null,
  myFeedback: null,
};

const ATTRIBUTES: Record<string, (item: (typeof session.record)[number]) => Record<string, unknown>> = {
  decision: (item) => ('decided' in item ? { decided_on: item.decided } : {}),
  experiment: (item) => ('status' in item ? { status: item.status } : {}),
  action: (item) => ('due' in item ? { due: item.due, status: 'open' } : {}),
};

/** What the venture keeps in Knowledge: a decision, an experiment and an action with its due date. */
export const AD_MEMORY: MemoryObjectView[] = session.record.map((item, index) => ({
  id: `6d1f0c8e-2b4a-4c3e-9a71-0f5e2d8c4d${String(index).padStart(2, '0')}`,
  ventureId: AD_IDS.venture,
  type: item.type as MemoryType,
  title: item.title,
  content: item.content,
  contentLength: item.content.length,
  attributes: ATTRIBUTES[item.type]?.(item) ?? {},
  status: 'confirmed',
  visibility: 'venture',
  confidence: 0.8,
  sourceRefs: [{ kind: 'turn', id: AD_IDS.turn }],
  origin: 'ai',
  createdBy: person,
  approvedBy: null,
  approvedAt: null,
  version: 1,
  supersedesId: null,
  pinned: false,
  expiresAt: null,
  createdAt: AT,
  updatedAt: AT,
}));

/** The decision the call settles, as the answer's "Saved to Knowledge" line links it. */
export const AD_SAVED: MemoryObjectView[] = AD_MEMORY.slice(0, 1);
