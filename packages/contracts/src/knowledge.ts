import { z } from 'zod';

import { CoachMode, Doctrine, Id, PrincipalView, Style, Timestamp } from './domain.js';

/**
 * vEIR knowledge pools (docs/architecture/knowledge-pools.md).
 *
 * - Common pool (one per vEIR persona): the approved release (doctrine, style), the persona knowledge
 *   library (`knowledge_sources` scope `persona`) and published lessons (`patterns` with `persona_id`).
 * - Specific pool (one per venture × vEIR): venture memory and documents, conversation digests and the
 *   vEIR notebook.
 *
 * Notebook entries and digests are AI notes: visible to the venture team, correctable, never cited as
 * facts and never promoted to durable memory without a person approving them.
 */

// Conversations -------------------------------------------------------------------------------------

/** How a turn reached the vEIR: typed in chat, or spoken during a call. */
export const TurnChannel = z.enum(['text', 'voice']);
export type TurnChannel = z.infer<typeof TurnChannel>;

export const DigestCommitment = z.object({
  text: z.string().max(300),
  /** ISO date (YYYY-MM-DD) or null. */
  due: z.string().nullable(),
});
export type DigestCommitment = z.infer<typeof DigestCommitment>;

/** Short summary of one conversation, written when it ends or goes idle. Never for temporary chats. */
export const ConversationDigest = z.object({
  summary: z.string().max(1200),
  topics: z.array(z.string().max(80)).max(8),
  commitments: z.array(DigestCommitment).max(8),
  openQuestions: z.array(z.string().max(300)).max(6),
  generatedAt: Timestamp,
});
export type ConversationDigest = z.infer<typeof ConversationDigest>;

// The vEIR notebook ---------------------------------------------------------------------------------

export const NotebookSection = z.enum(['founderProfile', 'openQuestions', 'lastAdvice']);
export type NotebookSection = z.infer<typeof NotebookSection>;

export const NotebookEntry = z.object({
  /** Stable key within the notebook (not a database id). */
  id: z.string().min(1).max(64),
  text: z.string().max(400),
  sourceSessionId: Id.nullable(),
  createdAt: Timestamp,
});
export type NotebookEntry = z.infer<typeof NotebookEntry>;

export const CommitmentStatus = z.enum(['open', 'done', 'dropped']);
export type CommitmentStatus = z.infer<typeof CommitmentStatus>;

export const NotebookCommitment = z.object({
  id: z.string().min(1).max(64),
  text: z.string().max(300),
  /** ISO date (YYYY-MM-DD) or null. */
  due: z.string().nullable(),
  status: CommitmentStatus,
  sourceSessionId: Id.nullable(),
  createdAt: Timestamp,
});
export type NotebookCommitment = z.infer<typeof NotebookCommitment>;

/** "What <vEIR> knows about you and <venture>": one per (venture, persona). */
export const VeirNotebook = z.object({
  ventureId: Id,
  personaId: Id,
  personaName: z.string(),
  summary: z.string().max(1200),
  founderProfile: z.array(NotebookEntry),
  commitments: z.array(NotebookCommitment),
  openQuestions: z.array(NotebookEntry),
  lastAdvice: z.array(NotebookEntry),
  /** One sentence the vEIR may open the next conversation with; null when there is nothing to pick up. */
  nextOpener: z.string().max(300).nullable(),
  version: z.number().int().min(0),
  updatedAt: Timestamp.nullable(),
  /** Who changed it last: the distillation job, or a person on the venture team. */
  lastEditedBy: z.enum(['veir', 'person']).nullable(),
});
export type VeirNotebook = z.infer<typeof VeirNotebook>;

/** `PATCH /ventures/:id/notebook` — every edit carries the version it was made against. */
export const NotebookEdit = z.discriminatedUnion('action', [
  z.object({ action: z.literal('edit_summary'), summary: z.string().trim().max(1200) }),
  z.object({
    action: z.literal('edit_entry'),
    section: NotebookSection,
    id: z.string().min(1).max(64),
    text: z.string().trim().min(1).max(400),
  }),
  z.object({ action: z.literal('remove_entry'), section: NotebookSection, id: z.string().min(1).max(64) }),
  z.object({
    action: z.literal('edit_commitment'),
    id: z.string().min(1).max(64),
    text: z.string().trim().min(1).max(300).optional(),
    due: z.string().nullable().optional(),
    status: CommitmentStatus.optional(),
  }),
  z.object({ action: z.literal('remove_commitment'), id: z.string().min(1).max(64) }),
  z.object({ action: z.literal('edit_opener'), text: z.string().trim().min(1).max(300) }),
  z.object({ action: z.literal('remove_opener') }),
  z.object({ action: z.literal('clear') }),
]);
export type NotebookEdit = z.infer<typeof NotebookEdit>;
export const UpdateNotebookRequest = z.object({
  expectedVersion: z.number().int().min(0),
  edit: NotebookEdit,
});
export type UpdateNotebookRequest = z.infer<typeof UpdateNotebookRequest>;
export const NotebookResponse = VeirNotebook;

// Embodiment and calls ------------------------------------------------------------------------------

/** Who renders the vEIR's face and voice during a call. `builtin` needs no vendor contract. */
export const AvatarProviderId = z.enum(['builtin', 'heygen', 'tavus', 'simli']);
export type AvatarProviderId = z.infer<typeof AvatarProviderId>;

export const PersonaEmbodiment = z.object({
  provider: AvatarProviderId,
  /** Text-to-speech voice id (Amazon Polly) or null for the platform default. */
  voiceId: z.string().max(64).nullable(),
  /** Served portrait for the persona's face, only when likeness consent exists. */
  portraitUrl: z.string().nullable(),
  voiceConsented: z.boolean(),
  likenessConsented: z.boolean(),
});
export type PersonaEmbodiment = z.infer<typeof PersonaEmbodiment>;

/** The vEIR a founder talks to, as shown in chat and calls. */
export const VeirIdentity = z.object({
  personaId: Id,
  name: z.string(),
  /** Short name used in greetings and buttons ("Corin"). */
  shortName: z.string(),
  kind: z.enum(['neutral_guide', 'eir_persona']),
  eirDisplayName: z.string().nullable(),
  tagline: z.string().nullable(),
  disclosure: z.string(),
  embodiment: PersonaEmbodiment,
});
export type VeirIdentity = z.infer<typeof VeirIdentity>;

/** `GET /ventures/:id/call-config` — everything the call screen needs before the first word. */
export const CallConfigResponse = z.object({
  veir: VeirIdentity,
  provider: AvatarProviderId,
  /** Hard cap per call in minutes. */
  maxMinutes: z.number().int().min(1),
  /** Minutes this person may still use today. */
  remainingMinutesToday: z.number().min(0),
  aiEnabled: z.boolean(),
  /** The calls switch (`calls_enabled`); always sent by the server. Calls also need `aiEnabled`. */
  callsEnabled: z.boolean().optional(),
});
export type CallConfigResponse = z.infer<typeof CallConfigResponse>;

/** `POST /speech` — synthesize validated vEIR text; responds with `audio/mpeg`. */
export const SpeechRequest = z.object({
  sessionId: Id,
  /** Null only for a call's signed intro. */
  turnId: Id.nullable(),
  text: z.string().trim().min(1).max(1500),
  /**
   * Streaming units carry the `seq` and `sig` of their `turn.speech` event (or the call intro); without
   * them the text must be the stored, validated `spoken` form of a completed turn of the session.
   */
  seq: z.number().int().min(0).optional(),
  sig: z.string().min(16).max(200).optional(),
});
export type SpeechRequest = z.infer<typeof SpeechRequest>;

// Common pool: knowledge library --------------------------------------------------------------------

export const KnowledgeSourceKind = z.enum(['note', 'document', 'case', 'faq', 'transcript']);
export type KnowledgeSourceKind = z.infer<typeof KnowledgeSourceKind>;

export const KnowledgeSourceStatus = z.enum(['processing', 'active', 'stale', 'failed', 'withdrawn']);

export const PersonaKnowledgeSourceView = z.object({
  id: Id,
  personaId: Id,
  kind: KnowledgeSourceKind,
  title: z.string(),
  summary: z.string().nullable(),
  /** Authored text for notes, cases, FAQs and transcripts; null for uploaded documents. */
  body: z.string().nullable(),
  status: KnowledgeSourceStatus,
  failureReason: z.string().nullable(),
  chunkCount: z.number().int(),
  createdBy: PrincipalView.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type PersonaKnowledgeSourceView = z.infer<typeof PersonaKnowledgeSourceView>;
export const PersonaKnowledgeListResponse = z.object({ items: z.array(PersonaKnowledgeSourceView) });

export const CreatePersonaKnowledgeRequest = z.object({
  kind: z.enum(['note', 'case', 'faq', 'transcript']),
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(20).max(50_000),
});
export type CreatePersonaKnowledgeRequest = z.infer<typeof CreatePersonaKnowledgeRequest>;
export const UpdatePersonaKnowledgeRequest = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    body: z.string().trim().min(20).max(50_000).optional(),
  })
  .refine((value) => value.title !== undefined || value.body !== undefined, 'Nothing to update');
export type UpdatePersonaKnowledgeRequest = z.infer<typeof UpdatePersonaKnowledgeRequest>;

// Common pool: lessons ------------------------------------------------------------------------------

export const LessonStatus = z.enum(['draft', 'in_review', 'published', 'withdrawn']);
export const LessonView = z.object({
  id: Id,
  /** Null for program-wide lessons. */
  personaId: Id.nullable(),
  title: z.string(),
  context: z.string(),
  signal: z.string(),
  intervention: z.string(),
  outcome: z.string(),
  limits: z.string(),
  sourceClass: z.string(),
  status: LessonStatus,
  origin: z.enum(['distilled', 'authored']),
  createdAt: Timestamp,
});
export type LessonView = z.infer<typeof LessonView>;
export const LessonListResponse = z.object({ items: z.array(LessonView) });

const LessonFields = {
  title: z.string().trim().min(3).max(200),
  context: z.string().trim().min(3).max(2000),
  signal: z.string().trim().min(3).max(2000),
  intervention: z.string().trim().min(3).max(2000),
  outcome: z.string().trim().min(3).max(2000),
  limits: z.string().trim().min(3).max(2000),
};
export const CreateLessonRequest = z.object(LessonFields);
export const LessonAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('publish') }),
  z.object({ action: z.literal('withdraw') }),
  z.object({
    action: z.literal('edit'),
    title: LessonFields.title.optional(),
    context: LessonFields.context.optional(),
    signal: LessonFields.signal.optional(),
    intervention: LessonFields.intervention.optional(),
    outcome: LessonFields.outcome.optional(),
    limits: LessonFields.limits.optional(),
  }),
]);
export type LessonAction = z.infer<typeof LessonAction>;

// Persona management --------------------------------------------------------------------------------

export const ConsentAssetType = z.enum(['doctrine', 'style', 'voice', 'likeness', 'cases']);
export type ConsentAssetType = z.infer<typeof ConsentAssetType>;

export const CreateEirPersonaRequest = z.object({
  eirProfileId: Id,
  name: z.string().trim().min(3).max(80),
  doctrine: Doctrine,
  style: Style,
  disclosureText: z.string().trim().min(20).max(500),
  allowedModes: z.array(CoachMode).min(1).optional(),
});
export type CreateEirPersonaRequest = z.infer<typeof CreateEirPersonaRequest>;

export const AssignPersonaRequest = z.object({
  personaId: Id,
  eirProfileId: Id.nullable(),
  allowedModes: z.array(CoachMode).min(1).optional(),
});
export type AssignPersonaRequest = z.infer<typeof AssignPersonaRequest>;

export const UpdateEmbodimentRequest = z.object({
  provider: AvatarProviderId.optional(),
  voiceId: z.string().trim().max(64).nullable().optional(),
});
export type UpdateEmbodimentRequest = z.infer<typeof UpdateEmbodimentRequest>;

/** `GET /personas/:id/consents` item and `POST /personas/:id/consents` 201 body. */
export const ConsentView = z.object({
  id: Id,
  subjectPrincipalId: Id,
  assetTypes: z.array(ConsentAssetType),
  approvedUses: z.array(z.string()),
  audiences: z.array(z.string()),
  evidenceRef: z.string().nullable(),
  grantedAt: Timestamp,
  expiresAt: Timestamp.nullable(),
  revokedAt: Timestamp.nullable(),
});
export type ConsentView = z.infer<typeof ConsentView>;
export const ConsentListResponse = z.object({ items: z.array(ConsentView) });

/**
 * `POST /personas/:id/consents` — records the consent of the EIR the persona is built from and links it to
 * the persona. The EIR records their own consent; a program lead may record it only for a synthetic EIR.
 * `doctrine` is required before a release can be approved; `voice` / `likeness` before a voice or portrait.
 */
export const CreateConsentRequest = z.object({
  assetTypes: z.array(ConsentAssetType).min(1).max(5),
  approvedUses: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  audiences: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  /** Where the signed consent lives (form id, document reference). */
  evidenceRef: z.string().trim().max(500).nullable().default(null),
  expiresAt: Timestamp.nullable().default(null),
});
export type CreateConsentRequest = z.infer<typeof CreateConsentRequest>;

/** `POST /consents/:id/revoke` 200 body: every persona that relied on the consent is suspended. */
export const RevokeConsentResponse = z.object({
  consent: ConsentView,
  suspendedPersonaIds: z.array(Id),
});
export type RevokeConsentResponse = z.infer<typeof RevokeConsentResponse>;

/**
 * `POST /calls/avatar-session` — reserved for vendor avatar session tokens (HeyGen, Tavus, Simli). The
 * built-in provider needs no token, so today the response carries the provider and voice only.
 */
export const AvatarSessionRequest = z.object({ ventureId: Id });
export type AvatarSessionRequest = z.infer<typeof AvatarSessionRequest>;
export const AvatarSessionResponse = z.object({
  provider: AvatarProviderId,
  /** Single-use vendor session token; never stored or replayed. Null for `builtin`. */
  token: z.string().nullable(),
  expiresAt: Timestamp.nullable(),
  voiceId: z.string().nullable(),
});
export type AvatarSessionResponse = z.infer<typeof AvatarSessionResponse>;
