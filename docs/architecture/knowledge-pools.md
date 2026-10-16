# vEIR knowledge pools, conversations and calls

How a founder's vEIR knows what it knows, how that knowledge grows, who can see and change it, and how
calls speak it. This describes what is built (migration `0004_veir_knowledge`, `packages/db`,
`packages/core/src/services`, `apps/api/src/routes`). The turn pipeline's use of digests and notebooks and
the distillation job that writes them come next (§8).

## 1. Vocabulary

- **vEIR**: an AI coach built from one EIR's approved doctrine and style, with that EIR's consent
  (`personas.kind = 'eir_persona'`). It speaks in the first person and in the EIR's style, but it is not the
  EIR, is never "live", and never claims the EIR's endorsement. Foundry Guide (`neutral_guide`) stays the
  program's neutral coach for ventures without a vEIR.
- **Common pool**: what a vEIR brings to every venture it coaches — its approved release (doctrine and
  style), its knowledge library and its published lessons.
- **Specific pool**: what a vEIR knows about one venture and its founders — venture memory and documents
  (approval-gated, unchanged), conversation digests and the vEIR notebook.
- **AI notes**: digests and notebook lines. They are visible, correctable and unverified. They are never
  cited as facts and never become durable memory without a person approving them (the `memory_objects`
  CHECK is unchanged).

## 2. Who the founder talks to

| Piece      | Where                                                    | Rule                                                                                                                                                                                |
| ---------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persona    | `personas` (+ `tagline`, `embodiment`)                   | Created as a draft by a program lead (`POST /personas`), with a draft release v1.                                                                                                   |
| Consent    | `consents`, linked by `personas.consent_id`              | The EIR records their own (`POST /personas/:id/consents`); a program lead may record it only for a synthetic EIR who cannot sign in. Revoking suspends every persona relying on it. |
| Release    | `persona_releases`                                       | Approval needs a consent covering `doctrine`; approving the first release activates a draft persona. An active EIR persona without consent is impossible (CHECK).                   |
| Embodiment | `personas.embodiment` `{provider, voiceId, portraitKey}` | `builtin` provider only for now; a voice needs consent covering `voice`, a portrait `likeness` (trigger `personas_embodiment_consent`, re-checked at every use).                    |
| Assignment | `assignments` (one active per venture)                   | `POST /ventures/:id/assignment` (program lead) ends the previous one. A vEIR is assigned with the EIR it is built from, who then reviews its sampled turns.                         |

The seed builds **Corin's vEIR** (direct, customer-discovery-first; voice Matthew) and **Ruth's vEIR**
(warm, deep-tech commercialization and IP pathway; voice Ruth) from the two synthetic EIR profiles, each
with a synthetic consent (doctrine, style, voice, cases), an approved v1 and a common pool. QuietQuad and
SoleSignal are coached by Corin's vEIR, BenchTally and EmberLoop by Ruth's. On a database seeded before
vEIRs existed, the seed ends the original Foundry Guide assignment of each demo venture and creates the
vEIR assignment exactly once, and only while that original assignment is still the active one: a venture a
program lead re-assigned is left alone (`migrate-0004.db.test.ts`).

`GET /ventures/:id/veir` returns the identity the UI shows (`VeirIdentity`: name, short name "Corin",
tagline, disclosure, embodiment with consent flags).

## 3. Common pool

### 3.1 Knowledge library

`knowledge_sources` with `scope = 'persona'` and `persona_id`, kinds `note`, `case`, `faq`, `transcript`
(authored text in `body`, a derived `summary`) and `document` (uploaded PDF, DOCX, Markdown or text).

- **Curators** are the program leads of the tenant and the EIR the persona is built from
  (`app.can_curate_persona`). RLS lets only them insert, update or delete persona sources and chunks; the
  program corpus is program leads only. (Before 0004 any EIR could write any persona's or the program's
  corpus.) Every EIR-studio role may read a library.
- **Authored text** is chunked on save with the same heading-aware chunker as documents, so lexical
  retrieval works at once, and embedded after commit within the daily spend caps (skipped when AI is off;
  the backfill embeds later). An edit replaces the chunks; a withdrawal removes them.
- **Uploads** use a presigned PUT under `tenants/{t}/personas/{p}/sources/{id}/{file}` and count against the
  uploader's daily upload quota. `.../complete` queues `ingest_knowledge_source`; the worker re-validates
  the job against the row (tenant, persona), extracts, chunks, embeds within the uploader's spend caps and
  marks the source `active` or `failed` with a reason.
- **Retrieval**: `searchSharedChunks` returns persona chunks only for the venture's assigned persona, as
  `doctrine` evidence, and only from `active` or `stale` sources.

### 3.2 Lessons

De-identified, generalised lessons live in `patterns` with a nullable `persona_id` (null: program-wide) and
an `origin` (`distilled` or `authored`). A lesson is a draft until a curator publishes it; curators can edit
or withdraw it (`POST /lessons/:id/actions`). Drafts are visible to curators only (RLS). Retrieval
(`searchPatterns`) returns published, unexpired lessons that are program-wide or belong to the assigned
persona; another persona's lessons are never candidates.

### 3.3 How the common pool grows

Only through people: curators authoring and uploading, curators publishing lessons, and approved releases.
Never through raw venture text. Distilled lesson candidates (§8) arrive as drafts, already de-identified,
and still need a curator to publish them.

## 4. Specific pool

### 4.1 Conversation digests

`coaching_sessions.digest` (`ConversationDigest`: summary, topics, commitments, open questions,
generated time), with `distilled_at` and `distill_version` (the number of completed turns it covers).

- Temporary (ephemeral) conversations never have one (CHECK `coaching_sessions_digest_check`).
- `DELETE /sessions/:id/digest` (founder/team) deletes it and sets `digest_deleted_at`: distillation never
  writes one for that conversation again (`setSessionDigest` refuses).
- `listRecentDigests(ventureId, personaId)` gives the latest digests for the prompt ("Previous
  conversations"); `listDistillationCandidates` finds standard conversations that ended or have been idle,
  whose digest is missing or older than their turns.

### 4.2 The vEIR notebook

`veir_notebooks`, one row per venture × persona: "What Corin knows about you and QuietQuad".

| Field            | Content                                                                                |
| ---------------- | -------------------------------------------------------------------------------------- |
| `summary`        | ≤ 1200 characters                                                                      |
| `founderProfile` | preferences and communication style the founder showed                                 |
| `commitments`    | text, due date, status (`open`, `done`, `dropped`), source conversation                |
| `openQuestions`  | questions still open                                                                   |
| `lastAdvice`     | the latest advice given                                                                |
| `nextOpener`     | one sentence the vEIR may open the next conversation with                              |
| `version`        | bumped by every write; edits and distillation both write against the version they read |
| `suppressed`     | fingerprints (SHA-256 of the normalised words) of lines a person removed or corrected  |

- **Visibility** mirrors the conversations it is distilled from: the founder/team and the assigned EIR read
  it; advisors and program leads do not. Only the founder/team edit it (`PATCH /ventures/:id/notebook`
  with `expectedVersion`; 409 on a stale edit). The database validates the document's shape.
- **Corrections stick.** Editing or removing a line, or clearing the notebook, records the old line's
  fingerprint (never its text) in `suppressed`. Distillation must skip any line whose fingerprint is
  suppressed (`isSuppressed`) and writes with the version it read (`saveNotebook` returns null on a
  conflict), so a founder's correction is never silently overwritten.
- Deleting a conversation removes the notebook lines sourced from it.

## 5. Conversations

- `title` comes from the first non-crisis message (trigger `turns_touch_session`), can be renamed
  (`PATCH /sessions/:id`), and is never kept for temporary chats. The same trigger maintains
  `last_activity_at` and `has_calls` (any turn spoken during a call; `turns.channel = 'voice'`).
- `GET /sessions?scope=mine|all&ventureId&cursor&limit` lists the caller's conversations across every
  venture they work on, latest activity first, in keyset pages (cursor keeps microsecond precision).
- `DELETE /sessions/:id` (founder/team) erases the content like an ended temporary chat: founder text and
  responses of every turn, title, goal, recap, digest, feedback comments, pending AI memory proposals drawn
  from it, notebook lines sourced from it, stored idempotent responses that mention it. Pending turns are
  failed so a late answer is never stored. The row stays for security records; RLS hides it from
  everyone.

## 6. Calls

- **Configuration**: `GET /ventures/:id/call-config` returns the vEIR identity, the provider, the per-call
  cap (`max_call_minutes`, 30) and the minutes left today (`daily_call_minutes_per_principal`, 60). Both are
  platform settings (`PATCH /admin/settings`).
- **Minutes** are measured from spoken turns: a call is a run of a person's spoken turns in one
  conversation with no gap over 10 minutes; it lasts from its first to its last spoken turn plus one minute,
  or until now while it is going (`measureCalls`). `app.voice_turns_today()` exposes only the times.
- **Speech** (`POST /speech`, `audio/mpeg`, streamed): calls speak only validated text. The request names
  the conversation and the turn, and the text must be a passage of that completed turn's stored `spoken`
  form or of its answer read as plain text (citation keys, Markdown and link targets removed); anything else
  is 422. It requires founder/team access, AI enabled (503), the coach active (423), minutes left (429
  `rate_limited`, reasons `daily_call_minutes`, `call_minutes`) and the daily spend caps (429). Each
  synthesis is metered in `usage_ledger` with purpose `speech` (characters as input tokens, Polly prices:
  generative $30, neural $16 per million characters) and audited with counts only.
- **Voices**: Amazon Polly, generative engine first and neural as fallback, adult US-English voices
  (`SPEECH_VOICES`). A persona speaks with its own voice when its consent covers `voice` (the neutral guide
  needs none), else with the platform voice (Danielle).
- **Local development** runs the mock model and has no speech service: `/speech` answers 501
  `speech_unavailable` (after authorization and validation) and the web reads validated replies aloud with
  the browser's speech synthesis. Deployed stacks (`MODEL_PROVIDER=bedrock`) use Polly and need
  `polly:SynthesizeSpeech` on the API role.
- **Avatar seam**: `POST /calls/avatar-session` is reserved for vendor session tokens (HeyGen, Tavus,
  Simli); it never stores or replays a response. Today it returns the built-in provider and its voice after
  the same checks as a call (AI enabled, coach active, minutes left). Only `builtin` can be configured
  until a vendor adapter exists.

## 7. Data model (migration 0004)

| Object                              | Change                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coaching_sessions`                 | `title`, `last_activity_at`, `has_calls`, `digest`, `digest_deleted_at`, `distilled_at`, `distill_version`, `deleted_at`                                                                                                                                                                                                                                                         |
| `turns`                             | `channel` (`text` \| `voice`); trigger `turns_touch_session`                                                                                                                                                                                                                                                                                                                     |
| `veir_notebooks`                    | new; RLS read: writer or assigned EIR; insert/update: writer (persona must have been assigned to the venture)                                                                                                                                                                                                                                                                    |
| `knowledge_sources`                 | `kind`, `summary`, `body`, `updated_at`, `failure_reason`, upload fields; statuses `pending_upload`, `processing`, `failed`                                                                                                                                                                                                                                                      |
| `knowledge_sources` / `_chunks` RLS | persona scope: curators; program/public: program leads; chunk DELETE for curators (venture chunks only via document delete)                                                                                                                                                                                                                                                      |
| `patterns`                          | `persona_id`, `origin`, `updated_at`; RLS: drafts readable and writable by curators only                                                                                                                                                                                                                                                                                         |
| `personas`                          | `embodiment`, `tagline`; trigger `personas_embodiment_consent`                                                                                                                                                                                                                                                                                                                   |
| `consents` RLS                      | the subject, or a program lead for a synthetic EIR                                                                                                                                                                                                                                                                                                                               |
| `usage_ledger.purpose`              | adds `distill`, `speech`                                                                                                                                                                                                                                                                                                                                                         |
| `platform_settings`                 | `max_call_minutes` 30, `daily_call_minutes_per_principal` 60                                                                                                                                                                                                                                                                                                                     |
| Functions                           | `app.can_curate_persona`, `app.is_persona_eir`, `app.soft_delete_session`, `app.voice_turns_today`, `app.persona_consent_assets`, `app.conversation_title`, notebook validators; `app.can_write_venture` now answers false (not NULL) for non-members, which closes an assigned-EIR path through the 0002 soft-delete functions; `app.upload_usage_today` counts persona uploads |

The migration is expand-only: code from before 0004 keeps working against the new schema (defaults for
every new column), which `migrate-0004.db.test.ts` checks together with re-runnability and the backfills
(titles, last activity, the seeded doctrine corpus becoming an authored note).

## 8. Next: the turn pipeline and distillation

What the orchestrator and the distillation job need is in place:

- **Turns**: pass `channel` to `turnsRepo.createTurn`; check the call caps before a spoken turn
  (`callUsageToday`, `currentCallMinutes`); pass `personaId` to `retrievalRepo.searchPatterns` so the
  assigned persona's lessons become candidates (without it only program-wide lessons are).
- **Prompt continuity**: the notebook (`notebooksRepo.getNotebook`) as "Your notes on this founder
  (unverified; confirm before relying on them)" and the last three digests (`listRecentDigests`).
- **Distillation** (purpose `distill`, spend caps and kill switch): find candidates
  (`listDistillationCandidates`), write the digest (`setSessionDigest`, never for temporary or
  digest-deleted conversations), merge the notebook delta skipping suppressed lines and write it with the
  version read (`saveNotebook`, retry on null), store memory candidates as proposals and de-identified lesson
  candidates as `distilled` drafts (`resourcesRepo.createPattern`, status `draft`).

## 9. Tests

- RLS for every new table and path: `packages/db/src/rls.db.test.ts` (notebooks, persona corpora, lessons,
  deleted conversations, consents, the soft-delete NULL fix).
- Repositories: `packages/db/src/repositories/veir.db.test.ts`; migration and seed upgrade:
  `migrate-0004.db.test.ts`, `seed/seed.db.test.ts`.
- Services: `packages/core/src/services/veir-pools.db.test.ts` (and the authorization matrix), pure rules in
  `veir-pools.test.ts`.
- HTTP: `apps/api/src/veir.db.test.ts`, denial matrices in `authz.db.test.ts`, the Polly adapter in
  `adapters/polly-speech.test.ts`.
