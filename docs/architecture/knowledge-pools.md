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
- **Specific pool**: what a vEIR knows about one venture and its founders — venture memory and documents,
  conversation digests and the vEIR notebook. What a conversation teaches goes to memory by itself (kept
  automatically, [ADR-0003](adr/0003-typed-memory-with-approval.md) amendment of 2026-10-16); the founder
  and team edit or forget it.
- **AI notes**: digests and notebook lines. They are visible, correctable and unverified, and never cited as
  facts.

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

### 3.5 Reference library: the startup knowledge base

General entrepreneurship knowledge beyond the program's own curriculum: the owner's startup knowledge base
(schema 3.0.0, `packages/db/knowledge/startup-knowledge-base/startup_knowledge_base.json`, kept byte for byte as
supplied): 9 frameworks, 25 documented real startup cases, 6 lifecycle stages and 39 academic and university
sources with their audit. The program's curriculum (scope `program`) and the vEIR's library (`persona`) stay
separate; this is the common pool's `public` scope.

- **Storage.** One knowledge source per framework, case and stage (`scope = 'public'`, kind `document`,
  classification `public`, no venture or persona, `uri` `urn:foundry:startup-knowledge-base:<kind>/<id>`,
  `checksum` `skb@3.0.0:sha256:…`), with its Markdown as `body` (the document viewer shows it, every reference
  linked) and its passages as chunks. A case is a dated **documented account** (what the cited report says, what it
  does not establish) and separate **editorial** passages (analysis, proposed experiment, metric, decision rule,
  options, framework mapping), each headed as such; frameworks are method summaries; stages are editorial
  recommendations. A passage's heading names the publisher of its references and, for an account, the date its
  evidence is as of, so the evidence title carries the citation (title + publisher); the References section lists
  title, authors, publisher, year, URL, review date and the audit's limitation. The coach reads a passage's first
  600 characters, so a framework summary puts its **limitations** right after its evidence-type line and a
  documented account opens with its **evidence limits**; the viewer's text has the same order (it marks a cited
  passage by finding its text). The pack's five RAG documents are exactly the rendering of five items
  (`ragTemplate`, SHA-256 checked), so they are ingested once, not as near-duplicates.
- **Validation.** `validateKnowledgePack` has the semantics of the pack's `validate_kb.py` (fields, types, dates,
  URLs, source eligibility, references, case/method separation and unions, coverage, RAG hashes, counts) and its
  seventeen self-test corruptions; `pnpm --filter @foundry/db knowledge-pack validate` prints the report.
- **How production gets it.** The seed runs on every deploy (migrate custom resource) and syncs **every active
  tenant** (`syncKnowledgePackToTenants`: each tenant has its own copy in its own common pool; a suspended or
  archived tenant is skipped and catches up on the first deploy after it is active again), and the deploy's
  embedding backfill embeds new passages. The sync is idempotent: absent items are inserted, an item whose text
  changed is re-ingested (only its passages are replaced), an item the JSON drops is withdrawn (and returns if a
  later JSON has it), a person's withdrawal is never undone. No migration: `knowledge-pack sync [--tenant <slug>]`
  does the same by hand.
- **Retrieval** (`searchSharedChunks` with `reference`, `REFERENCE_GATE`; the gate is
  `packages/db/src/knowledge-pack/gate.ts`). The coaching diagnosis (C1) traced fixation to library notes on almost
  every turn. An earlier gate called a word distinctive when few of the library's ~99 passages had it, so everyday
  words ("could", "work") qualified and a replay of a pilot's real student turns retrieved a passage on 22 % of them.
  Now:
  - the gate reads **the founder's own message only** (`RetrievalArgs.founderText`), never the composed retrieval
    query with the vEIR's last question or the venture goal;
  - an item is named only by its **curated vocabulary** (`vocabulary.ts`: framework, stage and case terms, e.g.
    "lean canvas", "unit economics", "CAC", "TAM", "customer discovery", "MVP stage", companies by full name). No
    single word among the 10,000 most frequent English words (`packages/db/knowledge/common-english`, from wordfreq,
    CC BY-SA 4.0, licence alongside) names anything; a common word counts only inside a phrase or paired with a cue
    in the same sentence ("scaling" with "mentor");
  - a framework or stage term counts only in a sentence that **asks** something ("Our CAC went up to $40." retrieves
    nothing; "…is that bad?" does); a case by its company's **full name** (or a short form that is not everyday
    English), case-insensitive, as whole words, in an entrepreneurship context; a company whose name is everyday
    English or an everyday product (Grove, Embrace, Station A, Dropbox, Duolingo…) needs a word that shows the company
    is meant within six words of the name in the same sentence, or a case frame in its own clause ("Grove Street has
    cheaper rent", "the deck is on Dropbox" retrieve nothing); a short one-word name (NONA, Locu, r2c) needs a business
    word beside it or a case frame, not just any question; a case's subject ("home try-on") only within ten words of
    a genuine ask for an example, a case study or a company's story ("any examples of startups that…", "which
    companies have…"), never on an idiom ("in that case", "for example", "companies like ours", "use cases"); a
    one-word stage term ("repeatability") only beside a startup word;
  - a question about the program itself (its stage gates, cohort, curriculum, EIRs) draws on the program's guidance
    only;
  - **one item per turn**, unless the founder asks for several (examples, cases, frameworks, a comparison; "in some
    cases" is not asking) or names several themselves (a subject asked for as an example is not naming one); then at
    most two on a typed turn, never more than one on a call;
  - with a query embedding, a passage less similar than 0.2 is vetoed; similarity never admits one;
  - an item **already cited in the conversation** (`turn_evidence` with source scope `public`) is never shown again;
  - one passage per item (a documented account before editorial guidance), in slots of their own beside the shared
    budget; authority 0.7 keeps them below the program's guidance (0.9) and the vEIR's library (1.0).
  - **in context, unasked** (coaching v3, owner round 3: the vEIR may cite the library when it is relevant to what is
    being discussed): when the message asks for nothing, `selectContextualReference` offers one item that the new
    message names by the same curated vocabulary (or a case's subject as a phrase, or a word that is not everyday
    English) **and** one of the founder's last three messages or the venture's own words (its one-liner and goal) name
    too, never in a message about the program or of fewer than six words; the database shows it only when no
    reference passage was shown in the conversation's last four turns (`REFERENCE_GATE.contextGapTurns`), and never
    an item already shown in it. The evidence block tells the coach a reference is optional background, to use only
    where it genuinely helps. `pnpm --filter @foundry/db exec tsx src/scripts/reference-replay.ts <opened-dir>…`
    prints the rates (no text): on live pilot 42124259353's 583 student turns, 10 turns (1.7 %) get a reference, 9 of
    them in context, in 5 of 60 runs (the busiest run 17.6 %, about one turn in six).
- **Citing.** The evidence block marks them `source="reference"` and tells the coach they are optional background, to
  prefer the program's guidance, name whose account it is, keep a documented account to its date and limits, never present editorial
  guidance as fact, and say when something is not reported instead of estimating it. The app labels them
  "Reference library" and opens them in the viewer.
- **Never venture memory.** A memory candidate resting only on reference passages is dropped unless the founder said
  it, and no memory item links a reference passage.
- **Isolation.** A founder reads no reference row of another tenant (by query or by retrieval) and cannot insert,
  update or delete scope `public` (RLS: only a program lead writes the common pool); a venture's own document
  search never returns a reference passage; a memory candidate resting only on a reference passage is dropped.
- **Evaluation.** `gate.replay.test.ts` replays 129 everyday student lines and 68 genuine framework, case and stage
  questions written in the style of the pilot's turns (no transcript text): at most 5 % of everyday lines may
  retrieve anything (2 of 129 do: 1.6 %), at least 90 % of genuine questions must retrieve the item asked about
  (68 of 68, each first). `knowledge-pack.db.test.ts` runs the pack's `rag_eval_questions.json` through the real
  retrieval: every expected document for Q01–Q04, and Q05 (an interview-to-sale conversion rate the source does not
  report) retrieves no figure and the account whose excerpt opens with that gap.

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

| Field            | Content                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------- |
| `summary`        | ≤ 1200 characters                                                                       |
| `founderProfile` | preferences and communication style the founder showed                                  |
| `commitments`    | text, due date, status (`open`, `done`, `dropped`), source conversation                 |
| `openQuestions`  | questions still open                                                                    |
| `lastAdvice`     | the latest advice given                                                                 |
| `nextOpener`     | one sentence the vEIR may open the next conversation with (and `nextTopic`, its thread) |
| `version`        | bumped by every write; edits and distillation both write against the version they read  |
| `suppressed`     | fingerprints (SHA-256 of the normalised words) of lines a person removed or corrected   |

- **Visibility** mirrors the conversations it is distilled from: the founder/team and the assigned EIR read
  it; advisors and program leads do not. Only the founder/team edit it (`PATCH /ventures/:id/notebook`
  with `expectedVersion`; 409 on a stale edit). The database validates the document's shape.
- **Threads the founder took up.** The distillation sees what the conversation opened with (`<opened_with>`)
  and closes a commitment the founder reports done in any words ("I met the advisor last week" closes "book the
  advisor session…"; a past due date alone closes nothing), or rewrites one they re-plan. `sanitizeDistill` drops
  the next opener with its thread when it is about a thread the founder did not take up when it was raised (the
  conversation's opener, a question the vEIR asked) or one an earlier conversation left that this one never took
  up, unless the founder spoke of it themselves (`@foundry/ai` `distill/threads.ts`: two shared content words, or
  a short yes right after the opener). Lab run 39780304879: an advisor session the founder ignored was the opener
  three times, and a chat's distillation copied the previous opener word for word.
- **Corrections stick.** Editing or removing a line, or clearing the notebook, records the old line's
  fingerprint (never its text) in `suppressed`. Distillation skips any line whose fingerprint is suppressed
  (`dropSuppressed`, `core/services/distill-rules.ts`) and writes with the version it read (`saveNotebook`
  returns null on a conflict), so a founder's correction is never silently overwritten.
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
  commitments. Every turn of a standard conversation also starts its final user message with
  **"## Where you left off"** (`orchestrator/continuity-prompt.ts`, data from `continuity.ts`): the person's
  latest earlier conversation of the venture with any of its vEIRs, read on its own so a teammate's newer ones never
  hide it (and the newest teammate's when more recent; one with a previous coach is carried over as the founder's
  history, never as this vEIR's own), when it was
  ("about 20 minutes ago", "yesterday"), on a call or not, ended or left open, its digest when distilled and
  otherwise its last six exchanges as they were said (a reply the founder spoke over as they heard it), plus the
  notebook's open threads, held to the notes' own rule: once the conversation is under way, a message with a subject
  of the founder's own carries none of them, and one already raised in this conversation is marked so (production,
  2026-11-07: the notes left their agenda out of every turn of a call while this section still listed it, and the
  third reply asked the first one's question again; `leftOffThreads`); escaped, untrusted
  data within 4 000 characters. It is read in two indexed statements in a transaction of its own, alongside
  retrieval, so it never waits for the distillation worker: a second call a minute after the first knows
  what was said in it. Temporary and deleted conversations and other ventures are never read; a temporary
  conversation reads nothing. The notes' earlier digests leave out the conversations this section shows (each is
  sent once) and mark one with a previous coach as that coach's. A new standard conversation opens with the
  notebook's next opener when a person wrote or rewrote it; else with the line the model wrote at distillation when
  it is current (drawn from the person's latest conversation, or nothing was said since it was written; one kept
  from an older conversation only when the founder spoke of its thread in the latest), said as written (never when
  it only repeats the question that conversation ended on, opens the way it opened, comes back to a thread it opened
  on that the founder took up in none of their messages there, or already opened a conversation since). What an
  opener is about is always the model's choice: the distillation prompt has it pick up the most important thread of
  that conversation, or, when nothing about the venture was said (small talk, a one-word reply, a test), the most
  important open thread of the notebook; never small talk, a question about the vEIR itself or anything personal,
  every word in its own spelling; the sanitizer drops a line on anyone's personal life, health or family, small talk,
  the vEIR answering a question about itself or the scripted "Want to carry on with…?" frame (typos included:
  `isPersonalOpener`), and a line that names nothing the founder said, the digest or the notebook holds
  (`namesAThread`: "How have you been?"); the opener checks both again, and a call never says a stored line that
  fails the first. A previous line the conversation never said is no thread the founder left aside: only one it
  opened on and they let go is dropped. **A notebook with open threads always gets a line** (production, 2026-11-07:
  a notebook distilled from a small-talk call before the next-opener rule held kept none, and the next call opened
  "Nice to see you. What feels most pressing right now?" to a founder with an open commitment and three open
  questions): when the notebook leaves a thread open (an open commitment, an open question, advice) but has no
  sound, current line of the model's, `chooseOpener` says so (`missing`) and the model writes one from the notebook,
  and from the person's latest conversation when it is not distilled yet (its exchanges go to the model with it, so
  the line takes it in and never opens on a thread an older conversation left: LAB-R6c; review of 2026-11-07: a chat
  left open distils after nine idle minutes, and a New chat a few minutes later named nothing)
  (`DistillService.writeOpener`, purpose `distill`, the caps and the kill switch; `buildOpenerPrompt`,
  `sanitizeOpener`): the live thread named specifically, with an offer of concrete help (to walk them through it,
  prepare it with them), never a bare question (`offersHelp`: a line that only asks about the thread is dropped, here
  and at distillation), never a thread the founder left aside (`leftAside`: what the latest conversation opened on
  unanswered, and a stale line's thread), never written over a teammate's sound line. It is written into the notebook
  against the version read (`notebook.opener_written`), drawn from the person's latest conversation, never over a
  person's line or edits still waiting for a distillation. **One attempt per version of the notebook and state of
  that conversation** (`notebooksRepo.claimOpenerAttempt`, audited `notebook.opener_attempted` under a per-notebook
  advisory lock): a line the model dropped, failed or could not write is never paid for again until the notebook or
  the conversation changes, and two starts at once make one attempt. `GET /ventures/:id/opener` writes nothing and
  calls no model (New chat fetches it on a link's hover); it says `missing`, and New chat, once open, sends
  `POST /ventures/:id/opener` (`SessionsService.prepareOpener`), which has the line written and waits for it up to
  `OPENER_WAIT_MS` (2 s; New chat waits up to 2.5 s for that answer, then greets with the preview's line). A call
  never waits for the writer: its first words come with the start (a call from New chat finds the line New chat had
  written), and a call that starts with a line missing has it written after the response, for the next start
  (`Kit.later`). Notebooks distilled before this rule are given their line once by
  daily maintenance and the `distill_sweep` message (`backfillOpeners`: up to 20 a run, idempotent, audited
  `maintenance.notebook_openers`; a notebook whose attempt was made is not listed again until it changes, so one that
  can never be written does not hold the queue). While the line is missing and being written (a call that starts
  before it exists, a New chat whose wait ran out), the conversation opens with a greeting that offers help with the
  notebook's newest open commitment, else its first open question, in the notebook's own words ("Welcome back. I can
  help you prepare the next step on this: follow up with the advisor on the device class."; `threadOffer`,
  `threadOpeners`), once the notebook holds the latest conversation (before its distillation a notebook thread may be
  one that conversation settled: LAB-R6c): never a thread from a teammate's conversation, one the founder left aside,
  or one still about them in the third person. Otherwise (no thread anywhere, or the latest conversation not
  distilled yet) the conversation opens with a short, warm greeting that
  names nothing and offers help ("Welcome back. What can I help
  you prepare for?"; `plainOpeners`), phrased for that conversation and never with a greeting or invitation the person's last conversations opened with, and never "since we last spoke" (it may be said seconds
  after a call); nothing the founder said is ever read by rule for what to open on (production 2026-11-06: "hows
  your perosnal life going on.." became "Hi, want to carry on with your perosnal life?"). Every distilled line is
  said to the founder: where it calls them by name the name goes (a call says it back within the name budget), and
  elsewhere their name or "the founder" becomes "you",
  team names keep their real case, and a line still in the third person is left out. The line is validated like any
  opener and stored with the conversation it came from (`coaching_sessions.opener`). A call says it; a call that
  starts a conversation nobody has said anything in chooses the line again at call start and keeps it as the
  conversation's first message. `GET /ventures/:id/opener` previews it for New chat, which greets with it (the
  opener's own greeting as the heading, with the founder's name; the time of day only with nothing to pick up, or
  for a private chat) and creates the conversation with `openerShownAt` (the preview's `at`); `null` (no opener
  shown) opens the conversation without one. A hello
  right after the opener is answered with a hello, never the recall again (`<conversation_state>` reads the
  founder's first message as the reply to the replayed opener).
- **Teach and prepare, never a loop** (production, 2026-11-07; policy `fa-coach-policy/2026-11-07.7`). The call that
  prompted it: a returning founder named a goal and got "walk me through where you are…", a vague answer got a
  question, a short answer got the first question again in other words, and a founder with no answer was asked again.
  Prompt rules saying "follow the founder" had lost to context that was mostly one topic, so each turn now carries:
  - `<conversation_state>` reads two more moves (`founderMoves`): `goal` (a goal or a step ahead of them, or their
    first reply to the opener's invitation naming what they want to work on: "teach and prepare", the usual path,
    what the terms mean, the prep itself, at most one question after it; never on a goodbye that names a next step,
    "Thanks, I'll go prepare for the pitch now, bye!") and `unknown` ("I don't know", "I didn't do that", "not yet",
    "they never told me", "I forgot to ask", "it didn't come up", "I didn't get a chance", "beats me", "we didnt look
    into it", "didnt get to it", "nope havent", "i dont know who pays", "not a clue", "i dont have that info", "not
    something i looked at", typed with or without apostrophes, "i ddint do that" and "i dint" included: contractions
    are put back before any cue reads the message, the subject is optional and the verb takes its particles; read
    clause by clause: never asked again in any words; acknowledged without judgement, then what the answer most likely
    is, the fastest way to find out and the next step). Phrase lists did not converge (each review round found new
    casual wordings), so after a question of the vEIR's a no-answer is also read by its shape (`noAnswerFlags`), as
    the union of two readings, recall first (review, round 6: five rounds alternated between a grammar that missed
    casual wordings and a shape that misread answers). The precise reading (`said`) is a clause of at most 14 words
    that says who did not do what (`NO_ANSWER_PREDICATE`): the founder did not know, ask,
    talk to, reach, follow up, look into, get to, hear or have the time or the meeting ("i didnt talk to the advisor",
    "werent able to meet", "i honestly dont remember"); they lack the information ("i dont have the class info"); someone
    else did not reply or say, or is unavailable ("he hasnt gotten back to me", "nobody got back to me", "the advisor
    ghosted me", "he said hed get back to me"); the meeting did not happen or was cancelled; a bare doubt ("idk", "not
    sure", "zero idea", "no word from him yet", "still waiting on him"); they forgot or dropped the ball; it is still on
    their list, the meeting was rescheduled or fell through, the person dodged it, was vague or left them on read. To a
    question that is not a yes/no one ("what did the advisor tell you?") a bare "no", "nope" or "nah" is a no-answer
    too; to "Is it Class II?" or "Want me to draft it?" it is the answer. The broad reading (`shape`) is any such short
    clause with a negation or a doubt (`NEGATION`, "an n't" however typed) or an intention that did not come off ("my
    cofounder was supposed to ask but didnt", "we were supposed to meet but he cancelled", "i meant to text him but i
    got busy", "i was gonna but life happened": such a "but" is no contrast), a word that says it was not done without
    a negation (`NOT_DONE_MARKER`: "forgot", "skipped", "swamped", "pending", "crickets", "vague", "short on time") or
    only something else covered ("he only talked about the tech"); never a clause about the founder's own state
    (`SELF_STATE`: how they feel, cope, sleep or keep going). Review, round 7: rules vetoed fresh casual no-answers
    ("cant tell you" read as a question, "Honestly? No idea." vetoed by its "?", "only" and a tagged "i think" taken
    for an answer), and the grammar also hears "we ran outta time", "i was too busy", "skipped it", "i put it off",
    "back burner", "i chickened out", "he brushed it off", "kinda fuzzy on that", "im in the dark on that", "your guess
    is as good as mine", "a non answer", "zip, nada", "it slipped through", "still in my drafts"; a bare "no" beside a
    clause read only by its shape ("no, clinics wont pay monthly") is read by shape too. It hears a casual wording no grammar lists, and may misread an answer said as a negation ("insurance
    doesnt cover it", "we dont have a predicate device"); a misread costs only the hedged line below and at most a
    trailing unquoted question of the coach's own (`noAnswerReadingOf`). The prompt line on any no-answer is hedged:
    "Their last message reads like they could not answer your question ("…"). If so: … do not ask it again in any
    words; say what the answer most likely is …, and the fastest way to find out; then move forward. If they did
    answer, build on what they said. If they are telling you how they are rather than answering, respond to that first
    and leave the question." A message in distress (`inDistress`: an "anymore" clause, "i dont know what im
    doing", "i cant do this", "i dont feel safe", "im not ok", the founder's own state said casually, `DISTRESS_STATE`,
    review round 7: "not sure i can keep going tbh", "im not in a good place", "i dont see the point", "i dont think im
    cut out for this", "i dont feel anything", "i havent been ok", "nothing is working", or what the stress cue, the wellbeing cue, the risk rules
    or the ideation prefilter flag) is never a no-answer nor stuck on a question: it keeps the reply and the safety
    path it had before (ac41aec). Review, round 8: near variants of distress ("not sure i want to keep going", "i dont
    know why im still here", "not sure im gonna make it", "i dont think im good enough", "honestly i dont even care",
    "i dont know who to talk to", "its too much", "whats the point", "thinking of giving up") were read as no-answers,
    and the prompt then asked for the answer about the device class. Distress is now read around the founder's own
    ability, will, worth and going on (keep going, keep doing this, make it, still here, good enough, caring, who to
    talk to, coping, too much, the point, giving up), never a task of the venture ("make it to the meeting", "who to
    talk to at the clinic"), and it vetoes everything the no-answer work added: such a message is read (its moves,
    by main's own normalisation and cues) and rendered exactly as ac41aec did, the same `<conversation_state>`, the
    same notes' agenda and open threads, never stuck. Review, round 9: lines about the founder's worth, reserves and
    endurance ("i dont know why i even try", "no clue, i'm barely holding it together", "i dont think im worth
    anything", "i have nothing left to give", "everything feels pointless lately", "what am i even doing with my
    life") were still read as no-answers or as a goal; distress now also reads frames (`SELF_STATE_FRAMES`): why or
    how they still go on, holding it together, their worth, what is left in them, getting through a stretch of time,
    their life, hopelessness, never what is left of a budget, a review to get through or the reason a task was left
    undone ("no idea why i didnt ask"), and a clause of the founder's own state vetoes the whole message, a no-answer
    of the lexicon before it included. A first reply to the opener counts as the work they want to do only when it
    names some (a goal, a subject, a thing of the venture, its people at work), never by its word count alone. Pinned
    against ac41aec's renders of 170 messages on eight conversations: prompts/distress-render.test.ts. The risk
    classifier is unchanged: on main as here it does not flag passive ideation such as "i dont know why im still here",
    "im not sure i should be alive" or "not sure im gonna make it" (inDistress does).
    Only the precise reading (`said`: the lexicon or the predicate grammar) makes the founder stuck (`stuckOn`) and
    takes the notes' agenda out, and the prompt line and `stuckOn` always agree on it. A time, a reason or a hedge
    beside it never vetoes it ("havent spoken to him since tuesday", "i didnt ask cause i ran out of time", "havent
    talked to him in 2 weeks", "i didnt get to it, maybe next week", "nah i didnt, its been crazy", "nobodys gotten
    back to me": typed `'s` forms are put back too); only content that answers the question does: what someone said
    ("he said class II"), "it's" with what it is ("its class 2"), a class named, a figure that is no stretch of time
    ("clinics bill it under 99457"), or a clause beside it that states what was asked about ("clinics pay per scan").
    The broad reading (`shape`) only adds the hedged line: it is never stuck, never leaves a question out and never
    changes the notes or the open threads; to be read by its shape the message must also carry no question, no answer
    of any kind (a figure, content reported, "probably", "because", a class named, a contrast, a day or a time), no
    worry of its own ("I don't know if clinics will pay for it") and none of their own moves (help, clarify, a change
    of topic, a goal, news, a social turn, their wellbeing), and nothing else said beside it: "he said its not class
    III", "no, its class II" and "i didnt get that" are not no-answers. A request for help ("you tell me") is answered
    in the prompt and is never stuck. A message that is only a no-answer by the precise reading
    leaves the notes' agenda out of that turn, open threads and questions included (`leavesAgendaOut`): the question
    they could not answer is in the conversation, and the notes would only offer it up again in other words. One read
    by its shape alone keeps the notes, the question it left open marked as already raised. A no-answer with a subject of its
    own after it ("Not yet, but can we work on the pitch deck", with or without a question mark, as a voice transcript
    has none) moves on: the reply follows them there, the notes leave their agenda out (`bringsOwnSubject` reads what
    the message brings besides the no-answer), and the old question is neither asked nor answered unasked. "I'm not
    sure what you mean" is `clarify`: the question said again more plainly, never answered for them. No answer to a
    check-in on the founder themselves ("Is there someone close to you you can talk to today?": `SUPPORT_CHECK_IN`, or
    a reply that escalated for wellbeing) is never taught into or answered for them, and asking after them again is
    never left out as a re-ask. Two replies in a row that ended in a question make the next one give substance and ask
    nothing.
  - Conversation craft says the same for every turn (help, stuck or no answer: do the work; teach how such things
    generally work, hedged: device classes, reimbursement codes, approval committees), rule 5 makes general education
    on high-risk topics explicit (never their own class, cost or timeline), DIAGNOSE gives its read before any
    question, `founder_profile` preferences ("prefers direct answers") are how the reply is shaped, open questions are
    unknowns to help settle, never a quiz, and a spoken reply starts with a short sentence that says something.
  - A question asked again in other words is left out where it is said (the sentence gate, the whole-reply validator
    and the whole reply's rewrite: `reasksQuestion`): besides the shared-words test, a longer question sharing three
    content words, two of them said together ("device class"), with any earlier question of the conversation. Words
    that name one subject count as one ("classification" and "class"; "billing", "payment" and "reimbursement" as how
    they pay, with "code", "CPT", "coverage" and "insurance"; "regulatory", "FDA", "pathway" and "path" as the
    regulatory route). After a founder who says explicitly they have no answer (`stuckOn`), any question that names a subject
    of one already asked is asked again ("So what did your advisor actually say?" after a question about the advisor),
    unless it offers the vEIR's own work ("Want me to draft the questions for your advisor?"); else three shared words,
    or two said together, or 40% of them. A customer or a price alone is too broad to make a question the same one, and
    "tier", "compensated", "expert" and "consultant" name the class, how they pay and the advisor; "approve", "sign
    off" and "decision" name who approves. Only questions put to
    the founder are read so (`putToFounder`): a question in a quoted draft, a list item under a lead-in ending in ":",
    or a question after "Ask your advisor:" or "questions to send:" is prep for someone else, a re-ask only when it
    comes back whole (three shared words), so a drafted email after "i dont know" keeps its body and its closing quote.
    The model marks the lines it drafts: conversation craft puts any line written for the founder to say, send or ask
    someone else, and any line said in character in a role-play, in double quotes, on a call too (the voice is handed
    the words without the marks: core `withoutQuoteMarks`, at synthesis only, so the caption and the signed unit keep
    them). A question asked again only by subject (the strict or settled reading: `reaskOf` `subject`) is left out
    only from the reply's trailing hand-back (`handBackStart`, `handBackCandidate`): the run of questions that ends it,
    each put to the founder, none with a quotation mark, in a blockquote or a list, under a lead-in ending in ":" or
    after a prep cue, wherever its line or paragraph starts (review, round 6: a re-ask in its own paragraph was never
    left out); never one on a line with a salutation ("Hi Dr Lee,") or opening on a titled name, or after a statement
    that does ("Hi Dr Lee, quick question on the insole." then the question in its own paragraph); and never the line
    the statement before it sets up (`setUp`): one that mentions asking, a question, messaging, texting, emailing,
    telling or saying it to them, a script or a line, the call, practising or playing a role ("The fastest way to know
    is one question to your advisor.", "Send him one line.", "I'll be the advisor.") or announces what follows ("Try
    this.", "Here's what I'd want to know.", "One thing would unblock this."), points at the line (an opener, copy and
    paste, "fire this off", "here goes", "try this one", "something you could adapt", "when you get him on the
    phone"), takes a role with any name ("I'll be Sarah, the practice manager.", "Picture me as the clinic director."),
    or is a heading on its own line ("**For your advisor**"); a short statement right after such a set-up goes with it
    ("Let's practise. I'm Sarah from the clinic.", "Send this tonight." then "Quick one on the insole."). Review, round
    7: these unquoted drafted and role-play lines lost their question once the line/paragraph restriction was gone. The prep cues ("Here is a draft",
    "something like", "ask him", "questions to send", "you could write") are an extra exemption. A question followed
    by anything but another question is never left out, and the sentence gate holds such a question until the next
    unit shows what follows, so a draft, a list or a quotation can never lose a question from its middle. A question
    that comes back whole is left out from the trailing hand-back too, or from the coach's own prose going on on the
    same line (`proseHandBackCandidate`, `goesOnFromProse`, the line it set up excepted) when the sentence after it
    does not lean on it ("Those two answers shape the plan.", "Knowing that decides…"), never from a draft, a
    quotation, a list or a blockquote (review, round 5: a note to the advisor, which naturally restates the question,
    lost it from its middle). The gate and `withoutRepeats` leave out exactly the same. A question asked before the previous reply (`askedBefore`: the founder has
    had their turn) comes back whole, or as two of its terms (said together, or two subjects) with little else, so a
    vague or short answer is never met with the first question again, while a new follow-up on the same subject ("Would
    that customer pay more for the version with alerts?") is kept. Notes threads already raised in the conversation
    are marked by subject too (`raisedIn`: "how clinics would pay" raised the open question on billing), and a raised
    commitment's passed date is no cue to ask how it went. A reply that only asks
    where the founder brought something is counted (validator note `question_only`; an acknowledgement that only
    restates the answer, "Okay, so department heads need to approve it.", is no substance; the lab reads the same).
- **Distillation** (purpose `distill`, the daily caps and the kill switch) runs from jobs only the API
  enqueues (the worker has no `sqs:SendMessage`):
  - after each completed turn, delayed 540 s (the backstop of a conversation left open); the worker skips
    while the conversation is active (a turn in the last 480 s), and a job whose conversation has more turns
    since is `superseded`;
  - what it writes of the founder is how they like to work, never a verdict on them: a founder-profile note that judges
    them (a deficit word, a failure in the coaching exchange such as not reporting, preparing or following up, "even
    when pressed", "needs repeated prompting") is never written (`isJudgmentalNote`, `distill/judgment.ts`) nor shown
    to the model from an older notebook, while a boundary or preference they stated ("Does not want to share revenue
    figures yet", "Won't commit to dates until the board meets") is kept; threads are said plainly, never as pressure
    said of the thread ("cannot wait", "is urgent", "(urgent)", "blocks the go-to-market", "is a blocker for launch":
    `withoutPressure` cuts such clauses from summaries and open questions, keeps what a sentence says besides them,
    and leaves facts that only use such a word alone, "Critical care units are a second market"; a turn's notes and
    "Where you left off" show what the model stored before without them, and a line a person wrote as they wrote it);
    a question the vEIR asked that the founder could not answer is never kept as an open question (production,
    2026-11-07, policy `fa-coach-policy/2026-11-07.3`);
  - when a conversation ends, and when a call in it ends however it ends (hang-up, a server stop, a
    replacement from another conversation; calls the daily maintenance closes are distilled inline),
    immediately and `settled`: never skipped as active;
  - for the person's previous conversation when they start the next one, if it is undistilled and its last
    turn is older than 60 s (`settleGraceSeconds`), also `settled`;
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
  it out; a `NotebookIntegrityError` leaves the notebook untouched), memory candidates kept automatically and
  de-identified lesson candidates as `distilled` drafts that record their conversation.

- **Memory hygiene**: a candidate that restates AI memory nobody approved or corrected (same key, Jaccard ≥
  0.9, cosine ≥ 0.92 with the same numbers once embedded, or all its content words in an item from the same
  conversation) adds its sources to that item instead of a duplicate; one that restates what a person made,
  approved, rejected or corrected away from (superseded versions included) is dropped. A turn keeps its
  candidates checked by their words and never waits for vectors: after `turn.completed` it embeds them and settles
  them by meaning (`settleKeptMemory`: a restatement or something forgotten is taken back with
  `app.discard_kept_memory`); the venture's AI memory still without a vector is embedded before a distillation
  compares.
- **Provenance**: the model labels each candidate `founder_stated`, `founder_agreed` or `coach_advice`. Advice is
  dropped; "agreed" needs an answer the founder explicitly took up ("sounds good, let's do that"; never a bare
  "sure", "ok" or "right, but…"); a stated note phrased as advice with almost none of the founder's words (read by
  stems, so "libraries must pay" counts for "a paid commitment from each library") is the coach's. Without a label,
  a note is the founder's when a third of its words are theirs and it is not advice, or when it says what the
  founder wants, prefers or cannot do. Citations never make a note the founder's.
- **Stated in the founder's words**: a turn also keeps a decision, goal or constraint the founder states in a plain
  first-person sentence ("We've decided to…", "Our goal is…", "We can't…"; never a question or a hedge) when the
  model's candidates do not say it, as a `founder_stated` candidate through the same checks, without a model call.
  A chat is distilled only nine minutes after its last turn; this keeps what was decided with the turn.
- **Forgetting**: deleting an item learned from a conversation, or correcting one the vEIR kept, records per
  conversation a fingerprint (`memory_forgotten`, closed to app_rls; `app.record_forgotten_memory`,
  `app.forgotten_memory`): hashes of its words and numbers and a SimHash of its embedding. A candidate from the same
  conversation with the same words, title or meaning (cosine ≥ 0.85) is never kept again; from another
  conversation, the same words or meaning (≥ 0.92) unless the founder said it again there. The rows go with their
  conversation.
- **Proposals from before**: the daily maintenance settles pending AI proposals (oldest first, 200 a run) with the
  same checks against their conversations, keeping or retiring each.
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
