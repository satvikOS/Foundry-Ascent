# vEIR knowledge pools, conversations and calls

How a founder's vEIR knows what it knows, how that knowledge grows, who can see and change it, and how
calls speak it. This describes what is built (migrations `0004_veir_knowledge` and `0005_wave1_fixes`,
`packages/db`, `packages/core/src/services`, `apps/api/src/routes`). The turn pipeline's use of digests and
notebooks and the distillation job that writes them come next (§8).

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

| Piece      | Where                                                    | Rule                                                                                                                                                                                                        |
| ---------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persona    | `personas` (+ `tagline`, `embodiment`)                   | Created as a draft by a program lead (`POST /personas`), with a draft release v1.                                                                                                                           |
| Consent    | `consents`, linked by `personas.consent_id`              | The EIR records their own (`POST /personas/:id/consents`); a program lead may record it only for a synthetic (fictional) EIR, whether or not it can sign in. Revoking suspends every persona relying on it. |
| Release    | `persona_releases`                                       | Approval needs a consent covering `doctrine`; approving the first release activates a draft persona. An active EIR persona without consent is impossible (CHECK).                                           |
| Embodiment | `personas.embodiment` `{provider, voiceId, portraitKey}` | `builtin` provider only for now; a voice needs consent covering `voice`, a portrait `likeness` (trigger `personas_embodiment_consent`, re-checked at every use).                                            |
| Assignment | `assignments` (one active per venture)                   | `POST /ventures/:id/assignment` (program lead) ends the previous one. A vEIR is assigned with the EIR it is built from: that EIR is the human who reviews the venture.                                      |

The seed builds **Corin's vEIR** (direct, customer-discovery-first; voice Matthew) and **Ruth's vEIR**
(warm, deep-tech commercialization and IP pathway; voice Ruth) from the two synthetic EIR profiles, each
with a synthetic consent (doctrine, style, voice, cases), an approved v1 and a common pool. QuietQuad and
SoleSignal are coached by Corin's vEIR, BenchTally and EmberLoop by Ruth's. On a database seeded before
vEIRs existed, the seed ends the original Foundry Guide assignment of each demo venture and creates the
vEIR assignment exactly once, and only while that original assignment is still the active one: a venture a
program lead re-assigned is left alone (`migrate-0004.db.test.ts`).

**The coaching vEIR's EIR is the venture's reviewer (decision).** Each vEIR assignment carries the EIR the
vEIR is built from, so the human who reviews a venture is always the EIR whose doctrine coaches it. The
re-pointing therefore moved two reviewers from the first seed:

| Venture    | Reviewer before vEIRs | Reviewer now | What moved                                                                                           |
| ---------- | --------------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| BenchTally | Corin                 | Ruth         | Ruth now reads BenchTally's shared memory, notebook, digests and sampled turns; Corin no longer does |
| SoleSignal | Ruth                  | Corin        | Corin now reads the same for SoleSignal; Ruth no longer does                                         |

QuietQuad (Corin) and EmberLoop (Ruth) keep their reviewer. BenchTally's pending EIR proposal ("Department-level
purchasing could shorten sales cycles") was made by Corin while he reviewed it; it stays for the founders to
keep or dismiss and is shown as "Added by an EIR". The evals fake API (`evals/tests/fake_api.py`) mirrors
this mapping.

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
- **Seed re-runs** (every deploy) insert a seeded source's chunks only in the statement that newly inserts
  the source, so a curator's edit or withdrawal, and a founder's deleted document, are never undone.
  Migration 0005 removed the chunks earlier re-runs had brought back. The Foundry Guide doctrine and the
  program method corpus are authored notes on every database (fresh ones are seeded that way; 0004 and 0005
  converted existing ones).

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

### 3.4 Test bench

Curators try a release before approving it (`POST /personas/:id/test-turns`, the studio's Test bench tab):
one message to the persona's active release or a draft, answered by the founder pipeline's answer stage
(`answerTurn`: the release's doctrine and style, this common pool, the sentence gate, identity guard and
validators) and the same crisis path, with an empty specific pool (no venture, memory, notebook, digests or
documents). Nothing is stored: no conversation, turn, memory proposal, notebook line, escalation or review
sample; the browser keeps the transcript and sends the last few exchanges back. Admission matches a
founder's message (message and in-flight limits from the bench's own audit events, migration 0012; the daily
caps; the kill switch; suspension; a consent covering doctrine), crisis support answers regardless, and every
model call is metered once under purpose `test_bench`. The checks come back with the answer, without anything
that says which names the cross-venture guard knows.

## 4. Specific pool

### 4.1 Conversation digests

`coaching_sessions.digest` (`ConversationDigest`: summary, topics, commitments, open questions,
generated time), with `distilled_at` and `distill_version` (the number of completed turns it covers).

- Temporary (ephemeral) conversations never have one (CHECK `coaching_sessions_digest_check`).
- **Visibility**: the founder/team and the venture's assigned EIR, like recaps. A digest is an AI summary
  for the human who reviews the venture; the conversation's title and goal, which are the founder's own
  words, are not shared with the EIR (§5).
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
- **Sources.** Every line records the conversation it came from; a line a later distillation changed (an
  entry reworded, a commitment reworded, re-dated or closed) records that conversation and keeps the earlier
  ones (`sourceSessionIds`, at most 20): its words may carry theirs. The summary records the conversations it
  was drawn from (`summarySources`) and the opener the one it was drawn from (`nextOpenerSource`); a missing
  key means unknown. `saveNotebook` owns these fields and ignores what callers send. For distillation it
  keeps unchanged text's sources and adds `sourceSessionId` to rewritten text, which is of unknown origin
  without it (`withDistilledSources`). Text a person writes where there was none is drawn from no
  conversation (`[]`, null); corrected text keeps where it was drawn from (`withPersonSources`). These
  fields stay in the stored document; the contract view does not show them.
- **Deleting a conversation** removes the lines drawn from it (as their source or an earlier one), and clears
  the summary and the opener when they were drawn from it. A summary of unknown origin is cleared when the
  deleted conversation was distilled or a line cites it: a summary is never kept on the chance it did not use
  the conversation. An opener of unknown origin is cleared whichever conversation of the venture is deleted,
  in every notebook of the venture and in every conversation that opened with it
  (`coaching_sessions.opener_by_person` tells a copy a person wrote from one of unknown origin): over-erasing
  it is harmless, the next distillation writes a new one. Text a person wrote stays.
- **Integrity.** The database checks the document against the contract (conversation ids, ISO timestamps).
  Should a stored notebook still not match a later contract, reads keep the readable lines and mark the
  record not intact; the notebook API fails loudly (500, logged with ids only) and `saveNotebook` refuses to
  write at that version (`NotebookIntegrityError`), so an edit or distillation never overwrites content it
  could not read.

## 5. Conversations

- **Titles** come from the first message the classifier found ordinary (`risk_label` `none`: never a crisis,
  high-risk, injection or cross-venture one; trigger `turns_touch_session`), and a title taken from a turn
  whose answer is then held back is withdrawn (`turns_untitle_blocked`); until then the client shows its
  default "Conversation · date, time". Titles can be renamed (`PATCH /sessions/:id`). `title_source` records who set them: `auto` (first message, distillation) or
  `person` (a rename, or a title given at the start). Distillation (`setSessionDigest`) replaces only
  `auto` titles.
- **Temporary chats never carry a title** (CHECK `coaching_sessions_title_privacy_check`); renaming one is 409.
- **Temporary chats keep nothing.** They neither read nor write the vEIR notebook: a resolution of help asked
  from one (or from a deleted conversation) is never written there. A crisis message still drafts its support
  request, and the founder may share any request while the chat is open; when it ends (or daily maintenance
  ends it after 24 h idle) the requests never shared are withdrawn and their packet erased, as a delete does.
- **Titles and goals are the founder's own words.** Only the venture's founder/team read them: every read
  path that returns them (session views, recents, `listRecentDigests`) gives null to anyone else, such as
  the assigned EIR, who may read the conversation row itself (RLS) and its digest. System jobs read them as
  stored.
- The same trigger maintains `last_activity_at` and `has_calls` (any turn spoken during a call;
  `turns.channel = 'voice'`). A turn is stamped when it is inserted, not when its transaction began, so
  recents order conversations by when each message was sent however requests interleave, and a later
  ordinal never carries an earlier time.
- `GET /sessions?scope=mine|all&ventureId&cursor&limit` lists the caller's conversations across every
  venture they work on (founder/team), each with its own `ventureId`, latest activity first, in keyset
  pages. The cursor is the activity in microseconds since the epoch, computed without a time-format literal
  (a `:MI` inside SQL text could be read as a parameter by the RDS Data API; the executors refuse any
  `:name` that is not a placeholder, in comments and function bodies too). Cursors in the earlier ISO form
  still decode to the same position.
- `DELETE /sessions/:id` (founder/team) erases the content like an ended temporary chat: founder text and
  responses of every turn, title, goal, recap, digest, feedback comments, the AI memory proposals drawn from
  it that no person kept (pending, rejected or expired), the notebook lines, summary and opener drawn from
  it (§4.2), and stored idempotent responses that mention it or carry what it erases (its AI proposals,
  later conversations' copies of its opener). Pending turns are failed so a late answer is never stored, and
  a turn admitted while it is being deleted is refused. AI suggestions a person approved stay: they are the venture's memory now. Escalations the
  founder never shared (draft, awaiting consent, or withdrawn before sharing) are withdrawn and their packet
  erased: it held the founder's question verbatim. Escalations the founder shared stay: they went to a
  person with consent. The row stays for security records; RLS hides it from everyone.

## 6. Calls

- **Configuration**: `GET /ventures/:id/call-config` returns the vEIR identity, the provider, the per-call
  cap (`max_call_minutes`, 30) and the minutes left today (`daily_call_minutes_per_principal`, 60). Both are
  platform settings (`PATCH /admin/settings`).
- **Minutes, admission, speech and barge-in** are the calls backend's ([calls](calls.md) §2): minutes are
  measured from the `calls` table (per call and per person per UTC day), spoken turns pass voice-turn
  admission, and `POST /speech` speaks only signed units of the turn engine, the signed intro, whole
  sentences of a completed turn's stored `spoken` form or the fixed crisis support message. Speech is
  metered in `usage_ledger` (purpose `speech`) and counted by the platform's daily cap and the call-minute
  caps, not by a person's own AI cap.
- **Voices**: Amazon Polly with the deployment's `SPEECH_ENGINE` (neural by default) tried first, adult
  US-English voices (`packages/core/speech-voices.json`). A persona speaks with its own voice when its
  consent covers `voice` (the neutral guide needs none), else with the platform voice (Danielle).
- **Local development** runs the mock model and has no speech service: `/speech` answers 501
  `speech_unavailable` (after authorization and validation) and the web reads validated replies aloud with
  the browser's speech synthesis. Deployed stacks (`MODEL_PROVIDER=bedrock`, `SPEECH_ENABLED` not `false`)
  use Polly and Transcribe.
- **Avatar seam**: `POST /calls/avatar-session` is reserved for vendor session tokens (HeyGen, Tavus,
  Simli); it never stores or replays a response. Today it returns the built-in provider and its voice after
  the same checks as a call (AI enabled, coach active, minutes left). Only `builtin` can be configured
  until a vendor adapter exists.

## 7. Data model (migrations 0004, 0005 and 0009)

| Object                              | Change                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coaching_sessions`                 | `title`, `last_activity_at`, `has_calls`, `digest`, `digest_deleted_at`, `distilled_at`, `distill_version`, `deleted_at`                                                                                                                                                                                                                                                         |
| `turns`                             | `channel` (`text` \| `voice`); trigger `turns_touch_session`                                                                                                                                                                                                                                                                                                                     |
| `veir_notebooks`                    | new; RLS read: writer or assigned EIR; insert/update: writer (persona must have been assigned to the venture)                                                                                                                                                                                                                                                                    |
| `knowledge_sources`                 | `kind`, `summary`, `body`, `updated_at`, `failure_reason`, upload fields; statuses `pending_upload`, `processing`, `failed`                                                                                                                                                                                                                                                      |
| `knowledge_sources` / `_chunks` RLS | persona scope: curators; program/public: program leads; chunk DELETE for curators (venture chunks only via document delete)                                                                                                                                                                                                                                                      |
| `patterns`                          | `persona_id`, `origin`, `updated_at`; RLS: drafts readable and writable by curators only                                                                                                                                                                                                                                                                                         |
| `personas`                          | `embodiment`, `tagline`; trigger `personas_embodiment_consent`                                                                                                                                                                                                                                                                                                                   |
| `consents` RLS                      | the subject, or a program lead for a synthetic EIR (whether or not it can sign in)                                                                                                                                                                                                                                                                                               |
| `usage_ledger.purpose`              | adds `distill`, `speech`                                                                                                                                                                                                                                                                                                                                                         |
| `platform_settings`                 | `max_call_minutes` 30, `daily_call_minutes_per_principal` 60                                                                                                                                                                                                                                                                                                                     |
| Functions                           | `app.can_curate_persona`, `app.is_persona_eir`, `app.soft_delete_session`, `app.voice_turns_today`, `app.persona_consent_assets`, `app.conversation_title`, notebook validators; `app.can_write_venture` now answers false (not NULL) for non-members, which closes an assigned-EIR path through the 0002 soft-delete functions; `app.upload_usage_today` counts persona uploads |

The migration is expand-only: code from before 0004 keeps working against the new schema (defaults for
every new column), which `migrate-0004.db.test.ts` checks together with re-runnability and the backfills
(titles, last activity, the seeded doctrine corpus becoming an authored note).

Migration 0005 (`0005_wave1_fixes`, expand-only and re-runnable, `migrate-0005.db.test.ts`):

| Object                    | Change                                                                                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coaching_sessions`       | `title_source` (`auto` \| `person`, backfilled from rename audits and titles given at the start); CHECK `privacy = 'standard' OR title IS NULL` (temporary titles cleared)                                                                               |
| notebook CHECK            | sources are conversation ids, times ISO timestamps (`app.is_contract_uuid`, `app.is_contract_timestamp`); optional `summarySources`, `nextOpenerSource`; old rows repaired                                                                               |
| `app.soft_delete_session` | also clears the notebook summary and opener drawn from the conversation, erases its rejected or expired AI proposals and its unshared escalations (`app.erase_drawn_from_session`, internal); conversations deleted under 0004 get the same erasure once |
| `knowledge_chunks`        | chunks of withdrawn sources, and chunks of authored sources newer than their last save, removed; seeded doctrine and program corpora still stored as bodiless documents become authored notes                                                            |
| `venture_memberships` RLS | platform admins may add members (team invitations) and read the memberships of their tenant's ventures (the Team list)                                                                                                                                   |
| `app.is_synthetic_eir`    | comment: the consent exception covers synthetic EIRs whether or not they can sign in                                                                                                                                                                     |

Migration 0009 (`0009_review_privacy`, expand-only and re-runnable, `migrate-0009.db.test.ts`; behaviour in
`repositories/review-privacy.db.test.ts`):

| Object                             | Change                                                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turns_require_live_session`       | BEFORE INSERT on `turns`: locks the conversation like a delete does and refuses a turn on a deleted one (55000)                                                            |
| `app.turns_touch_session`          | skips deleted conversations; titles only from a message labelled `none`; `turns_untitle_blocked` withdraws a title whose turn is held back; such titles cleared once       |
| `app.soft_delete_session`          | also clears `heard_text` explicitly                                                                                                                                        |
| `app.erase_drawn_from_session`     | purges stored responses of erased AI proposals; removes lines listing the conversation in `sourceSessionIds`; clears a notebook opener of unknown origin in every notebook |
| `app.sessions_erase_opener_copies` | also clears copies of unknown origin on the venture's conversations, and purges stored responses of the conversations it clears                                            |
| notebook CHECK                     | optional `sourceSessionIds` per line (at most 20 conversation ids)                                                                                                         |
| `coaching_sessions`                | `opener_by_person` (a copy a person wrote), `distill_unusable_answers` (invalid or refused distillation answers for the uncovered turns); checks added NOT VALID           |

## 8. The turn pipeline and distillation (as built)

- **Turns** write their `channel`; spoken turns pass voice-turn admission ([calls](calls.md) §2). The
  assigned persona's lessons are retrieval candidates (`searchPatterns` with `personaId`).
- **Prompt continuity**: the founder's first name, the notebook as "Your notes on this founder (unverified;
  confirm before relying on them)", the last three digests of other conversations and the open
  commitments. A new standard conversation stores the notebook's next opener, validated, as its first vEIR
  message (`coaching_sessions.opener`, with the conversation it came from).
- **Distillation** (purpose `distill`, the daily caps and the kill switch) runs from jobs only the API
  enqueues (the worker has no `sqs:SendMessage`):
  - after each completed turn, delayed 540 s; the worker skips while the conversation is active (a turn in
    the last 480 s), and a job whose conversation has more turns since is `superseded`;
  - when a conversation ends, immediately;
  - for the person's previous conversation when they start the next one, if it is idle and undistilled;
  - in daily maintenance, the backstop: up to 50 idle, undistilled conversations, three ventures at a time
    (one conversation per venture, which shares its notebook), while the run's time allows. When time runs
    out with conversations left, the maintenance message comes back after the queue's visibility timeout (up
    to its last receive), so a backlog (after a kill-switch or spend-cap day) drains the same day. The
    15-minute `DistillSweep` schedule ships **disabled** ([ADR-0018](adr/0018-veir-knowledge-pools.md)).

  One run claims the conversation, checks the persona and its consent, and distils it in parts of at most 16
  turns, oldest first: each part's prompt carries the digest of the turns before it, and the digest written
  covers exactly the turns the model saw (`distill_version`), so a long conversation is never cut to its last
  turns. Each part is one model call, written in one transaction: the digest and title (`setSessionDigest`,
  never for temporary or digest-deleted conversations; it keeps a person's title), the notebook delta merged
  against the version read
  (`saveNotebook` with `sourceSessionId`; suppressed lines skipped; lines a person edited since the last
  distillation pinned for one run; human-help advice kept until a person removes it or newer advice pushes
  it out; a `NotebookIntegrityError` leaves the notebook untouched), memory candidates as proposals and
  de-identified lesson candidates as `distilled` drafts that record their conversation.

- **Memory hygiene**: a candidate that restates a pending AI proposal (same key, Jaccard ≥ 0.9, cosine ≥
  0.92 once embedded, or all its content words in a proposal from the same conversation) raises that
  proposal again instead of adding one; pending proposals of the venture are embedded before the comparison.
  AI proposals nobody acts on expire after 30 days.
- **Deletion**: deleting a conversation also withdraws its lesson drafts still in `draft` and erases the
  copies of an opener drawn from it, or of unknown origin, on the venture's other conversations.

## 9. Tests

- RLS for every new table and path: `packages/db/src/rls.db.test.ts` (notebooks, persona corpora, lessons,
  deleted conversations, consents, the soft-delete NULL fix).
- Repositories: `packages/db/src/repositories/veir.db.test.ts`, `conversations.db.test.ts` (title privacy as
  the assigned EIR, title sources, temporary chats, recents under concurrent turns, deletion and what a
  person wrote, notebook integrity); pure rules in `notebooks.test.ts` and `sessions.test.ts` (cursors);
  Data API safety of every migration statement, comments and function bodies included, in
  `sql-lexer.test.ts`. Migration and seed upgrade: `migrate-0004.db.test.ts`, `migrate-0005.db.test.ts`
  (conversations deleted under 0004, a database first seeded after 0004), `seed/seed.db.test.ts` (re-runs
  after edits, withdrawals and deleted documents).
- Services: `packages/core/src/services/veir-pools.db.test.ts`, `wave1-fixes.db.test.ts` (and the
  authorization matrix), pure rules in `veir-pools.test.ts`.
- HTTP: `apps/api/src/veir.db.test.ts`, `conversations.db.test.ts` (recents across ventures, opener edits,
  temporary chats), denial matrices in `authz.db.test.ts`, the Polly adapter in `adapters/polly-speech.test.ts`.
