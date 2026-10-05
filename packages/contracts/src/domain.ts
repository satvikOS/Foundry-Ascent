import { z } from 'zod';

/** Identifiers are UUIDs; timestamps are ISO-8601 strings with offset. */
export const Id = z.uuid();
export type Id = z.infer<typeof Id>;
export const Timestamp = z.iso.datetime({ offset: true });

// --------------------------------------------------------------------------------------------------
// Enumerations — mirror the CHECK constraints in packages/db/migrations/0001_init.sql
// --------------------------------------------------------------------------------------------------

export const TenantKind = z.enum(['home', 'partner']);
export const PlatformRole = z.enum(['platform_admin', 'program_lead', 'eir']);
export type PlatformRole = z.infer<typeof PlatformRole>;
export const MembershipRole = z.enum(['founder', 'team', 'advisor']);
export type MembershipRole = z.infer<typeof MembershipRole>;

export const VentureStage = z.enum([
  'idea',
  'discovery',
  'validation',
  'business_model',
  'commercialization',
  'growth',
  'transition',
]);
export type VentureStage = z.infer<typeof VentureStage>;
export const VentureDomain = z.enum([
  'consumer',
  'software',
  'hardware',
  'biomedical',
  'clinical',
  'energy',
  'social',
  'general',
]);
export const VentureStatus = z.enum(['active', 'paused', 'graduated', 'archived']);
export const DataClassification = z.enum(['synthetic', 'public', 'program_internal', 'venture_private']);

export const CoachMode = z.enum(['diagnose', 'challenge', 'coach', 'teach', 'rehearse', 'route']);
export type CoachMode = z.infer<typeof CoachMode>;

export const MemoryType = z.enum([
  'fact',
  'hypothesis',
  'decision',
  'experiment',
  'evidence',
  'action',
  'milestone',
  'risk',
  'preference',
  'relationship',
  'insight',
]);
export type MemoryType = z.infer<typeof MemoryType>;
export const MemoryStatus = z.enum([
  'proposed',
  'confirmed',
  'disputed',
  'superseded',
  'expired',
  'rejected',
  'deleted',
]);
export type MemoryStatus = z.infer<typeof MemoryStatus>;
export const Visibility = z.enum(['founder_private', 'team', 'venture', 'advisors']);
export type Visibility = z.infer<typeof Visibility>;
export const MemoryOrigin = z.enum(['founder', 'ai', 'eir', 'import']);
export const MemoryEventAction = z.enum([
  'proposed',
  'created',
  'approved',
  'rejected',
  'corrected',
  'superseded',
  'disputed',
  'pinned',
  'unpinned',
  'deleted',
  'expired',
]);

export const EscalationCategory = z.enum([
  'security_identity',
  'ip_licensing',
  'legal',
  'securities_investment',
  'medical_regulatory',
  'safety_wellbeing',
  'conflict_harassment',
  'expert_judgment',
  'low_grounding',
  'other',
]);
export type EscalationCategory = z.infer<typeof EscalationCategory>;
export const EscalationPriority = z.enum(['P0', 'P1', 'P2', 'P3']);
export type EscalationPriority = z.infer<typeof EscalationPriority>;
export const EscalationStatus = z.enum([
  'draft',
  'awaiting_consent',
  'routed',
  'acknowledged',
  'resolved',
  'declined',
  'withdrawn',
]);
export const RequestedRole = z.enum(['eir', 'program_lead', 'specialist', 'university_support']);
export type RequestedRole = z.infer<typeof RequestedRole>;

export const DocumentContentType = z.enum([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
export const DocumentStatus = z.enum(['pending_upload', 'processing', 'ready', 'failed', 'deleted']);
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const ResourceKind = z.enum([
  'program',
  'mentor_network',
  'competition',
  'funding',
  'lab',
  'commercialization',
  'regulatory',
  'legal_clinic',
  'workshop',
  'incubator',
  'template',
  'other',
]);
export const PersonaKind = z.enum(['neutral_guide', 'eir_persona']);
export const PersonaStatus = z.enum(['draft', 'active', 'suspended', 'retired']);
export const PersonaReleaseStatus = z.enum(['draft', 'approved', 'superseded', 'withdrawn']);
export const SessionPrivacy = z.enum(['standard', 'ephemeral']);
export const SessionStatus = z.enum(['active', 'ended', 'suspended']);
export const TurnStatus = z.enum(['pending', 'completed', 'blocked', 'failed']);
export const EvidenceKind = z.enum(['memory', 'chunk', 'doctrine', 'resource', 'pattern']);

/** Deterministic pre-classifier categories (packages/ai/risk). */
export const RiskCategory = z.enum([
  'ip_licensing',
  'legal',
  'securities_investment',
  'medical_regulatory',
  'safety_wellbeing',
  'conflict_harassment',
  'prompt_injection',
  'cross_venture_request',
]);
export type RiskCategory = z.infer<typeof RiskCategory>;

// --------------------------------------------------------------------------------------------------
// Entity views returned by the API
// --------------------------------------------------------------------------------------------------

export const TenantView = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  kind: TenantKind,
});
export type TenantView = z.infer<typeof TenantView>;

export const PrincipalView = z.object({
  id: Id,
  displayName: z.string(),
  title: z.string().nullable(),
  synthetic: z.boolean(),
});
export type PrincipalView = z.infer<typeof PrincipalView>;

export const MembershipView = z.object({
  ventureId: Id,
  ventureName: z.string(),
  role: MembershipRole,
});

export const Me = z.object({
  principal: PrincipalView,
  tenant: TenantView,
  roles: z.array(PlatformRole),
  memberships: z.array(MembershipView),
  assignedVentureIds: z.array(Id),
  disclosure: z.string(),
  aiEnabled: z.boolean(),
});
export type Me = z.infer<typeof Me>;

export const PersonaSummary = z.object({
  personaId: Id,
  releaseId: Id,
  name: z.string(),
  kind: PersonaKind,
  version: z.number().int(),
  status: PersonaStatus,
  disclosure: z.string(),
  allowedModes: z.array(CoachMode),
});
export type PersonaSummary = z.infer<typeof PersonaSummary>;

export const VentureSummary = z.object({
  id: Id,
  name: z.string(),
  oneLiner: z.string(),
  stage: VentureStage,
  domain: VentureDomain,
  status: VentureStatus,
  myRole: MembershipRole.nullable(),
  lastSessionAt: Timestamp.nullable(),
  openActions: z.number().int(),
  pendingMemory: z.number().int(),
  openEscalations: z.number().int(),
});
export type VentureSummary = z.infer<typeof VentureSummary>;

export const VentureDetail = VentureSummary.extend({
  cohort: z.string().nullable(),
  classification: DataClassification,
  currentGoal: z.string().nullable(),
  persona: PersonaSummary.nullable(),
  assignedEir: z.object({ id: Id, displayName: z.string(), synthetic: z.boolean() }).nullable(),
  createdAt: Timestamp,
});
export type VentureDetail = z.infer<typeof VentureDetail>;

export const SourceRef = z.object({
  kind: z.enum(['session', 'turn', 'document', 'chunk', 'manual', 'memory']),
  id: z.string(),
  label: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const MemoryObjectView = z.object({
  id: Id,
  ventureId: Id,
  type: MemoryType,
  title: z.string(),
  content: z.string(),
  attributes: z.record(z.string(), z.unknown()),
  status: MemoryStatus,
  visibility: Visibility,
  confidence: z.number().min(0).max(1),
  sourceRefs: z.array(SourceRef),
  origin: MemoryOrigin,
  createdBy: PrincipalView,
  approvedBy: PrincipalView.nullable(),
  approvedAt: Timestamp.nullable(),
  version: z.number().int(),
  supersedesId: Id.nullable(),
  pinned: z.boolean(),
  expiresAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type MemoryObjectView = z.infer<typeof MemoryObjectView>;

export const MemoryEventView = z.object({
  id: z.number().int(),
  memoryId: Id,
  actor: PrincipalView,
  action: MemoryEventAction,
  diff: z.record(z.string(), z.unknown()),
  at: Timestamp,
});

export const DocumentView = z.object({
  id: Id,
  ventureId: Id,
  filename: z.string(),
  contentType: DocumentContentType,
  sizeBytes: z.number().int(),
  status: DocumentStatus,
  failureReason: z.string().nullable(),
  uploadedBy: PrincipalView,
  createdAt: Timestamp,
  chunkCount: z.number().int(),
});
export type DocumentView = z.infer<typeof DocumentView>;

export const EvidenceItem = z.object({
  key: z.string().regex(/^E\d+$/),
  kind: EvidenceKind,
  refId: Id,
  title: z.string(),
  excerpt: z.string(),
  score: z.number(),
  freshnessAt: Timestamp.nullable(),
  status: z.string().nullable(), // e.g. memory status: confirmed / proposed / disputed
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

export const ResourceView = z.object({
  id: Id,
  name: z.string(),
  kind: ResourceKind,
  description: z.string(),
  url: z.string().nullable(),
  tags: z.array(z.string()),
  stages: z.array(VentureStage),
  eligibility: z.string().nullable(),
  owner: z.string().nullable(),
  freshnessAt: Timestamp,
  status: z.enum(['active', 'stale', 'retired']),
});
export type ResourceView = z.infer<typeof ResourceView>;

export const Doctrine = z.object({
  summary: z.string(),
  frameworks: z.array(
    z.object({ name: z.string(), whenToUse: z.string(), keyQuestions: z.array(z.string()) }),
  ),
  evidenceStandard: z.string(),
  typicalQuestions: z.array(z.string()),
  redLines: z.array(z.string()),
  escalationTopics: z.array(z.string()),
  referralDestinations: z.array(z.string()),
  teachingPrinciples: z.array(z.string()),
});
export type Doctrine = z.infer<typeof Doctrine>;

export const Style = z.object({
  directness: z.enum(['gentle', 'balanced', 'direct']),
  warmth: z.enum(['reserved', 'warm']),
  pace: z.enum(['measured', 'brisk']),
  vocabulary: z.array(z.string()),
  feedbackStructure: z.string(),
  avoid: z.array(z.string()),
});
export type Style = z.infer<typeof Style>;

export const PersonaReleaseView = z.object({
  id: Id,
  personaId: Id,
  version: z.number().int(),
  doctrine: Doctrine,
  style: Style,
  disclosureText: z.string(),
  allowedModes: z.array(CoachMode),
  status: PersonaReleaseStatus,
  createdBy: PrincipalView.nullable(),
  approvedBy: PrincipalView.nullable(),
  approvedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type PersonaReleaseView = z.infer<typeof PersonaReleaseView>;

export const PersonaView = z.object({
  id: Id,
  name: z.string(),
  kind: PersonaKind,
  status: PersonaStatus,
  suspendedReason: z.string().nullable(),
  eirProfile: z
    .object({ id: Id, displayName: z.string(), synthetic: z.boolean(), expertiseTags: z.array(z.string()) })
    .nullable(),
  hasConsent: z.boolean(),
  activeRelease: PersonaReleaseView.nullable(),
  releases: z.array(
    PersonaReleaseView.pick({ id: true, version: true, status: true, approvedAt: true, createdAt: true }),
  ),
  assignedVentureCount: z.number().int(),
});
export type PersonaView = z.infer<typeof PersonaView>;

export const EirProfileView = z.object({
  id: Id,
  displayName: z.string(),
  title: z.string().nullable(),
  expertiseTags: z.array(z.string()),
  routingIntents: z.array(z.string()),
  synthetic: z.boolean(),
  status: z.enum(['active', 'unavailable', 'retired']),
});
