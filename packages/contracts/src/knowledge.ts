import { z } from 'zod';

import { CoachMode, Doctrine, Id, PersonaStatus, PrincipalView, Style, Timestamp } from './domain.js';

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

/** Most earlier conversations a notebook line records besides its own (the oldest are dropped first). */
export const MAX_LINE_SOURCES = 20;

/**
 * Earlier conversations a notebook line was also drawn from: a line a later conversation's distillation
 * reworded (or re-dated, or closed) carries the earlier ones' words too, so deleting any of them removes it.
 */
const EarlierSources = z.array(Id).max(MAX_LINE_SOURCES).optional();

export const NotebookEntry = z.object({
  /** Stable key within the notebook (not a database id). */
  id: z.string().min(1).max(64),
  text: z.string().max(400),
  /** The conversation the line's current text was drawn from; null when a person wrote it. */
  sourceSessionId: Id.nullable(),
  sourceSessionIds: EarlierSources,
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
  /** The conversation the commitment as it stands was drawn from; null when a person wrote it. */
  sourceSessionId: Id.nullable(),
  sourceSessionIds: EarlierSources,
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
  /**
   * The thread to come back to next time, as a short phrase ("the five library-staff interviews you planned"):
   * the vEIR phrases its greeting around it afresh for each conversation instead of repeating one sentence. It
   * goes with the opener (removing or rewriting the opener clears it). Additive and optional: older payloads
   * omit it.
   */
  nextTopic: z.string().max(120).nullable().optional(),
  /**
   * `nextOpener` as the vEIR may say it, after the checks applied when a conversation starts (plain, one line,
   * no EIR name, no other venture): what New chat shows as the vEIR's greeting. Null when there is none or it
   * fails a check. Additive: older payloads parse as null.
   */
  greeting: z.string().max(300).nullable().default(null),
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

/**
 * Who draws the face of a call, as the call screen sees it: the persona's provider, or `fake`, the development
 * stand-in (a canvas face, no one's likeness) that the local API serves with `EMBODIMENT_PROVIDER=fake` and
 * nothing else does. Never stored on a persona (`AvatarProviderId` is).
 */
export const EmbodimentProviderId = z.enum([...AvatarProviderId.options, 'fake']);
export type EmbodimentProviderId = z.infer<typeof EmbodimentProviderId>;

/**
 * How the vEIR is heard when a provider draws its face (docs/architecture/calls.md §4):
 * - `engine`: the call plays its own synthesized audio and the face follows its loudness (the presence);
 * - `audio`: the face renders the call's own validated audio itself, lip-synced (a vendor's speech-to-video, LITE);
 * - `text`: the vendor voices validated text with its own stock voice (FULL): each unit is admitted by the server
 *   first (`POST /calls/:id/face/say`), and only then sent to the vendor.
 */
export const AvatarVoicing = z.enum(['engine', 'audio', 'text']);
export type AvatarVoicing = z.infer<typeof AvatarVoicing>;

/**
 * Voices a persona may speak with on calls (Amazon Polly, adult US English), in the order of
 * `packages/core/speech-voices.json` (the catalog core and infra/cdk read). The speech service refuses any
 * other; a core test keeps this list and the catalog naming exactly the same voices.
 */
export const SPEECH_VOICE_IDS = [
  'Danielle',
  'Joanna',
  'Matthew',
  'Ruth',
  'Salli',
  'Stephen',
  'Gregory',
  'Joey',
  'Kendra',
  'Kimberly',
  'Tiffany',
] as const;
/** The platform voice, for personas without a consented voice of their own. */
export const DEFAULT_SPEECH_VOICE_ID = 'Danielle' satisfies (typeof SPEECH_VOICE_IDS)[number];

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
  /**
   * The EIR's first name ("Corin"), or the guide's name. It names the person, so it is never the AI's label:
   * the AI is always called by `name` ("Corin's vEIR") wherever it acts or is addressed.
   */
  shortName: z.string(),
  kind: z.enum(['neutral_guide', 'eir_persona']),
  eirDisplayName: z.string().nullable(),
  tagline: z.string().nullable(),
  disclosure: z.string(),
  embodiment: PersonaEmbodiment,
  /**
   * The EIR's consent covers `first_person`: the vEIR is shown as "Corin · vEIR" and speaks as their digital
   * twin. Additive: absent means no ("Corin's vEIR").
   */
  firstPerson: z.boolean().optional(),
  /**
   * The persona's EIR is the venture's assigned EIR, who can see the venture's work: the vEIR may say so.
   * Additive: absent means no.
   */
  eirSeesWork: z.boolean().optional(),
});
export type VeirIdentity = z.infer<typeof VeirIdentity>;

/** `GET /ventures/:id/call-config` — everything the call screen needs before the first word. */
export const CallConfigResponse = z.object({
  veir: VeirIdentity,
  /** Who draws the call's face (the persona's provider, or the development stand-in). */
  provider: EmbodimentProviderId,
  /** Hard cap per call in minutes. */
  maxMinutes: z.number().int().min(1),
  /** Minutes this person may still use today. */
  remainingMinutesToday: z.number().min(0),
  aiEnabled: z.boolean(),
  /** The calls switch (`calls_enabled`); always sent by the server. Calls also need `aiEnabled`. */
  callsEnabled: z.boolean().optional(),
  /**
   * When this person acknowledged the first-call privacy notice (`POST /calls/notice/acknowledge`); null until
   * then, and the call screen shows the notice. Additive: older payloads parse as null.
   */
  callNoticeAcknowledgedAt: Timestamp.nullable().default(null),
  /**
   * Video minutes this person may still use this month with the vEIR's face (sent only while a vendor face is
   * on for this vEIR). Additive.
   */
  faceMinutesLeft: z.number().min(0).optional(),
});
export type CallConfigResponse = z.infer<typeof CallConfigResponse>;

/**
 * `POST /calls/:id/face/say` — admits one signed unit of the caller's live call (its `turn.speech` unit, or the
 * call intro with `turnId` null) to the call's FULL face: 204, then the browser sends the vendor exactly `text`;
 * 422 for words that are not that call's validated, signed speech (never the crisis line), or a unit already
 * admitted or out of order. `sessionId`, when sent, must be the call's conversation. A unit the server already
 * admitted as it signed it (`turn.speech` with `face: true`) needs no request; asked anyway, it is 204 again,
 * with nothing more reserved.
 */
export const FaceSayRequest = z.object({
  sessionId: Id.optional(),
  turnId: Id.nullable(),
  seq: z.number().int().min(0).max(99_999),
  text: z.string().trim().min(1).max(1500),
  sig: z.string().min(16).max(200),
});
export type FaceSayRequest = z.infer<typeof FaceSayRequest>;

/**
 * Why the browser stopped showing a call's face (`POST /calls/:id/face/end`), recorded in the face's
 * `call.face_ended` audit: the vendor's video track ended (`video_ended`) or was unpublished (`video_unsubscribed`),
 * the vendor's room dropped (`room_disconnected`), the vendor stopped the session (`vendor_stopped`, with its
 * `end_reason` as `vendorReason`), the face showed no first frame (`no_video`) or did not join in time
 * (`connect_timeout`) or failed to join (`connect_failed`), the page has no adapter for it (`no_adapter`), a crisis
 * turn (`crisis`), or the call stayed on hold too long (`on_hold`).
 */
export const FaceEndReason = z.enum([
  'video_ended',
  'video_unsubscribed',
  'room_disconnected',
  'vendor_stopped',
  'no_video',
  'connect_timeout',
  'connect_failed',
  'no_adapter',
  'crisis',
  'on_hold',
]);
export type FaceEndReason = z.infer<typeof FaceEndReason>;

/** `POST /calls/:id/face/end` — the browser stopped showing the face. Both fields optional (an empty body is fine). */
export const FaceEndRequest = z.object({
  reason: FaceEndReason.optional(),
  /** The vendor's own `end_reason` of a stopped session, a short plain token. */
  vendorReason: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,64}$/)
    .optional(),
});
export type FaceEndRequest = z.infer<typeof FaceEndRequest>;

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
export const LessonListResponse = z.object({
  items: z.array(LessonView),
  /**
   * `GET /lessons` only: how many lessons match, which can exceed the {@link LESSON_QUEUE_MAX} listed. Additive:
   * absent elsewhere.
   */
  total: z.number().int().optional(),
});
/** Most lessons `GET /lessons` lists (the most recently changed ones). */
export const LESSON_QUEUE_MAX = 100;
/**
 * `GET /lessons` query: lessons of the vEIRs the caller curates (every vEIR for a program lead, the vEIRs built
 * from an EIR for that EIR; retired vEIRs and program-wide lessons left out), in one or more states,
 * comma-separated (`draft`, `draft,in_review`); every state when absent. 200 body: `LessonListResponse`, the
 * most recently changed first, with `total`.
 */
export const LessonQuery = z.object({
  /** Comma-separated in a query string; a list when the query is built in code. */
  status: z
    .union([
      z.array(LessonStatus).min(1),
      z
        .string()
        .trim()
        .transform((value) => [
          ...new Set(
            value
              .split(',')
              .map((part) => part.trim())
              .filter((part) => part !== ''),
          ),
        ])
        .pipe(z.array(LessonStatus).min(1)),
    ])
    .optional(),
});

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

/**
 * What an EIR's consent covers. `first_person`: founders meet the vEIR under the EIR's first name with a vEIR
 * badge ("Corin · vEIR"), speaking in the first person as their digital twin; without it the vEIR is "Corin's
 * vEIR" and refers to the EIR in the third person.
 */
export const ConsentAssetType = z.enum(['doctrine', 'style', 'voice', 'likeness', 'cases', 'first_person']);
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
  /**
   * Personas linked to this consent: revoking it suspends the active ones. Sent by
   * `GET /personas/:id/consents`; additive.
   */
  personas: z.array(z.object({ id: Id, name: z.string(), status: PersonaStatus })).optional(),
});
export type ConsentView = z.infer<typeof ConsentView>;
export const ConsentListResponse = z.object({ items: z.array(ConsentView) });

/**
 * `POST /personas/:id/consents` — records the consent of the EIR the persona is built from and links it to
 * the persona. The EIR records their own consent; a program lead may record it only for a synthetic EIR.
 * `doctrine` is required before a release can be approved; `voice` / `likeness` before a voice or portrait.
 */
export const CreateConsentRequest = z.object({
  assetTypes: z.array(ConsentAssetType).min(1).max(ConsentAssetType.options.length),
  approvedUses: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  audiences: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  /** Where the signed consent lives (form id, document reference). */
  evidenceRef: z.string().trim().max(500).nullable().default(null),
  expiresAt: Timestamp.nullable().default(null),
});
export type CreateConsentRequest = z.infer<typeof CreateConsentRequest>;

/**
 * `POST /consents/:id/withdraw-scope` — withdraws one scope of a consent in force (the EIR's own act, or a program
 * lead's for a synthetic EIR) without revoking the rest: the record is replaced by a copy without that scope,
 * which the personas that relied on it use from then on (none is suspended). Withdrawing `likeness` ends the
 * vEIR's face, `voice` its cloned voice (calls fall back to the platform voice), `first_person` its first-name
 * presence; each at once, on the server.
 */
export const WithdrawableScope = z.enum(['likeness', 'voice', 'first_person']);
export type WithdrawableScope = z.infer<typeof WithdrawableScope>;
export const WithdrawConsentScopeRequest = z.object({ assetType: WithdrawableScope });
export type WithdrawConsentScopeRequest = z.infer<typeof WithdrawConsentScopeRequest>;
export const WithdrawConsentScopeResponse = z.object({
  /** The record now in force (the copy without the scope). */
  consent: ConsentView,
  /** The record it replaced, now revoked. */
  previousConsentId: Id,
});
export type WithdrawConsentScopeResponse = z.infer<typeof WithdrawConsentScopeResponse>;

// Digital twin ---------------------------------------------------------------------------------------

/**
 * A persona's media at a vendor: its realtime face (`face`: a HeyGen LiveAvatar avatar id, LITE mode, which
 * renders audio we synthesized) or its cloned voice (`voice`: an ElevenLabs voice id, synthesized only on the
 * server from validated words). Identifiers, never credentials.
 */
export const TwinMediaKind = z.enum(['face', 'voice']);
export type TwinMediaKind = z.infer<typeof TwinMediaKind>;
export const TwinMediaVendor = z.enum(['heygen', 'elevenlabs']);
export type TwinMediaVendor = z.infer<typeof TwinMediaVendor>;
/** `pending`: recorded at the vendor, not usable yet; `ready`: in use (under its consent scope); `withdrawn`. */
export const TwinMediaStatus = z.enum(['pending', 'ready', 'withdrawn']);
export type TwinMediaStatus = z.infer<typeof TwinMediaStatus>;
/** The vendor of each kind. */
export const TWIN_MEDIA_VENDOR = { face: 'heygen', voice: 'elevenlabs' } as const satisfies Record<
  TwinMediaKind,
  TwinMediaVendor
>;
/** A vendor id: letters, digits, `-` and `_` (HeyGen avatar ids are UUIDs, ElevenLabs voice ids 20 characters). */
export const TwinVendorRef = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/, 'Use the id exactly as the vendor shows it');

export const TwinMediaView = z.object({
  kind: TwinMediaKind,
  vendor: TwinMediaVendor,
  vendorRef: z.string(),
  status: TwinMediaStatus,
  updatedAt: Timestamp,
});
export type TwinMediaView = z.infer<typeof TwinMediaView>;

/**
 * `GET /personas/:id/twin` — the persona's digital twin for its curators: the scopes its consent in force covers,
 * the vendor face and cloned voice, and whether the platform has faces and cloned voices on.
 */
export const DigitalTwinView = z.object({
  personaId: Id,
  /** The consent the persona relies on while it is in force; null otherwise. */
  consentId: Id.nullable(),
  scopes: z.object({ likeness: z.boolean(), voice: z.boolean(), firstPerson: z.boolean() }),
  face: TwinMediaView.nullable(),
  voice: TwinMediaView.nullable(),
  facesEnabled: z.boolean(),
  clonedVoiceEnabled: z.boolean(),
});
export type DigitalTwinView = z.infer<typeof DigitalTwinView>;

/**
 * `PATCH /personas/:id/twin/:kind` — records the vendor id of the persona's face or voice (program lead or the
 * persona's EIR). `ready` needs the consent in force to cover the scope (`likeness`, `voice`); null withdraws it.
 */
export const UpdateTwinMediaRequest = z.object({
  vendorRef: TwinVendorRef.nullable(),
  status: z.enum(['pending', 'ready']).default('ready'),
});
export type UpdateTwinMediaRequest = z.infer<typeof UpdateTwinMediaRequest>;

/** `POST /consents/:id/revoke` 200 body: every persona that relied on the consent is suspended. */
export const RevokeConsentResponse = z.object({
  consent: ConsentView,
  suspendedPersonaIds: z.array(Id),
});
export type RevokeConsentResponse = z.infer<typeof RevokeConsentResponse>;

/**
 * `POST /calls/avatar-session` — the face of a live call. A vendor face (or the development stand-in) gets a
 * single-use session token for the browser SDK, bound to the caller's live call `callId` and ending with its
 * time limit; the built-in presence needs none, and so does a call whose face is unavailable (no likeness
 * consent, the vendor down): it keeps the presence.
 */
export const AvatarSessionRequest = z.object({
  ventureId: Id,
  /** The caller's live call in that venture; a vendor session is only minted for one. */
  callId: Id.optional(),
});
export type AvatarSessionRequest = z.infer<typeof AvatarSessionRequest>;
export const AvatarSessionResponse = z.object({
  provider: EmbodimentProviderId,
  /**
   * Short-lived token the browser joins the face's video with (a vendor's room token, which can only watch:
   * the face's speak channel stays on the server). Never stored or replayed. Null for `builtin`.
   */
  token: z.string().nullable(),
  expiresAt: Timestamp.nullable(),
  voiceId: z.string().nullable(),
  /** How the vEIR is heard with this face. Additive: older payloads parse as `engine`. */
  voicing: AvatarVoicing.default('engine'),
  /** The vendor room the token joins (a LiveKit `wss://` URL); null for `builtin` and the stand-in. Additive. */
  url: z.string().max(500).nullable().default(null),
  /**
   * The face is a vendor's stock avatar (no one's likeness): the call shows it labelled "AI avatar", never as the
   * EIR. Additive: absent means no.
   */
  stockFace: z.boolean().default(false),
});
export type AvatarSessionResponse = z.infer<typeof AvatarSessionResponse>;
