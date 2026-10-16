# ADR-0018: vEIR knowledge pools — a common pool per persona, a specific pool per venture, grown by approval-gated distillation

- **Status:** Accepted
- **Date:** 2026-10-16
- **Deciders:** Platform owner
- **Blueprint basis:** 02 §5 "five-tier memory model" (Fig 5) and the memory quality rules, 02 §6 "four
  fidelity layers" (expertise, judgment, style, embodiment), 02 §9 "portfolio learning without portfolio
  leakage" (Fig 8), 01 §6 data classes, 01 §9 gates (0 critical cross-venture leakage; approved-fact
  recall with source links); 05 §9 "The persistent-memory promise", §10 "Memory growth, correction, and
  consolidation"

## Context and problem statement

The owner's acceptance bar asks for knowledge pools per vEIR: a **common pool** with the EIR's expertise,
doctrine, frameworks, cases and lessons, and a **specific pool** per founder and startup with what that
vEIR knows about them. Both should grow naturally from conversations, so a founder feels they are talking
to someone who remembers them.

What existed on 2026-10-15:

- Persona doctrine and style live in the approved release and go into the system prompt (ADR-0005).
- `knowledge_sources` / `knowledge_chunks` support `scope = 'persona'`, but only the seed fills them, and
  only for Foundry Guide.
- `patterns` (de-identified lessons with context, signal, intervention, outcome, limits) has no workflow.
- Venture memory is typed and approval-gated (ADR-0003), but AI proposals pile up without dedupe or
  expiry.
- Nothing carries a conversation forward: each session starts from memory and documents only, and recaps
  are per session.

Three invariants frame the design: no cross-venture raw retrieval (ADR-0004; G1 = 0 critical), no
durable memory from model inference alone (ADR-0003; the `memory_objects` CHECK), and no impersonation of
the EIR (ADR-0005).

## Decision drivers

- Continuity a founder can feel: the vEIR picks up last week's commitments and open questions.
- Everything the vEIR keeps about a founder is visible to them and correctable, and never presented as
  fact.
- The common pool learns from many conversations only through de-identified lessons a person publishes
  (02 §9). Venture text never flows into another venture's answers.
- Bounded cost: one extra model call per conversation, under the daily caps; nothing that keeps Aurora
  awake for no reason (ADR-0015).

## Considered options

1. **Two pools; approved knowledge kept apart from AI notes; growth through one distillation job per
   conversation with human gates** (chosen).
2. Retrieve over raw past transcripts (retrieval-augmented generation over every earlier turn). It is
   simple, but it puts unverified model output back into prompts as if it were knowledge, cannot be
   corrected line by line, and grows prompt cost with every conversation.
3. Fine-tune a model per EIR on conversations. Forbidden: no training on confidential venture
   conversations (01 §3, §6), and it cannot forget or isolate a venture.
4. Promote venture memory into the common pool automatically. That is the leakage path 02 §9 forbids,
   and the G1 cross-venture grader would catch it.
5. Vendor-managed memory (Bedrock Knowledge Bases or agent memory). It loses PostgreSQL RLS and the
   approval model, and its default vector store (OpenSearch Serverless) is denied by the permissions
   boundary.

## Decision outcome

Chosen option: **1**.

### The two pools

| Pool                                     | Contents                                                                                                                                                                                                                                                                                                                                                    | Grows only through                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Common** (one per persona)             | Doctrine and style of the approved release (system prompt). Knowledge library: `knowledge_sources` with `scope = 'persona'`, kinds `note`, `document`, `case`, `faq`, `transcript` (consented excerpt), chunked and embedded by the ingestion pipeline. Lessons: `patterns` with `persona_id` (NULL = program-wide); only `published` lessons are retrieved | EIR or program-lead authoring and uploads; lessons a person publishes; approved releases |
| **Specific** (one per venture × persona) | Venture memory (approval-gated, ADR-0003) and venture documents. Conversation digests: per conversation, a summary, topics, commitments and open questions. The vEIR notebook: summary, founder profile, commitments, open questions, last advice and a next opener ("Last time you planned five library-staff interviews. How did they go?")               | Distillation (AI notes) and the venture team (memory approvals, notebook edits)          |

Knowledge comes in three trust levels, and the prompt labels each one:

1. **Approved knowledge**: memory a person approved, documents, the persona library, published lessons,
   the release. Retrievable as evidence and citable (`[E1]`).
2. **AI notes**: digests and the notebook. Visible to the venture team, editable line by line, deletable
   (a digest) or clearable (the whole notebook). They enter the prompt as "Your notes on this founder
   (unverified; confirm before relying on them)" and "Previous conversations" (the three latest
   digests), and they are **never** cited as evidence or used as claim sources.
3. **This conversation**: recent turns.

### How the pools grow: distillation

- A job `{type: 'distill_session', sessionId}` runs once per conversation version. It is enqueued:
  - when a conversation ends;
  - by a sweep: EventBridge Scheduler sends `{"type":"distill_sweep"}` to the jobs queue every 15 minutes
    (`DistillSweep`, `infra/cdk/config/production.json` → `distillation`), and the worker enqueues
    conversations with no turn for at least 20 minutes and no digest yet;
  - lazily when the next conversation starts and the previous digest is still missing.
- One structured model call (usage purpose `distill`, under the daily caps and the kill switch) returns
  the digest, a notebook delta, at most 3 memory candidates and at most 2 lesson candidates.
- Everything is sanitized like recaps: the identity rewrite (no claim to be the EIR), cross-venture name
  and canary checks, length limits.
- **Memory candidates** become `proposed` memory (ADR-0003). They are deduplicated against existing
  memory (lexical similarity, plus cosine when embeddings exist) and merged into an open proposal instead
  of adding another; proposals nobody acts on expire after 30 days.
- **Lesson candidates** become `draft` lessons only if they pass a de-identification check: no venture,
  founder, customer, lab or sponsor names and no identifying numbers. When in doubt the lesson is dropped.
  An EIR or program lead edits, publishes or withdraws it in the studio.
- **The notebook respects people.** It is versioned, and every edit carries the version it was made
  against. A line a person edited or removed goes on a `suppressed` list that later distillations honour,
  so a correction is never silently overwritten.
- Temporary (ephemeral) conversations are never distilled.
- The job is idempotent per conversation version and safe to retry. Its audit entries hold ids and counts
  only, never content.

### Isolation

- New tables and columns (the notebook, digests, library kinds, lesson `persona_id`) are covered by RLS
  policies with tests in `packages/db/src/rls.db.test.ts`; venture-scoped reads filter by venture first.
- Digests and notebooks belong to one venture and one persona and are never retrieved for another
  venture. `founder_private` memory is never a coaching or distillation candidate.
- The only path from a conversation into the common pool is a de-identified lesson a person published.

### Cost

- One `distill` model call per conversation that went idle or ended, priced into `usage_ledger` and
  checked against the daily caps. The kill switch stops distillation with every other AI path.
- The sweep schedule costs nothing (about 2,900 Scheduler invocations a month, inside the free tier),
  but **the sweep handler must not wake a paused Aurora when there is nothing to distill.** A database
  query every 15 minutes against a 10-minute auto-pause keeps the cluster awake about two thirds of the
  time: at 0.5 ACU and $0.12 per ACU-hour that is about $29 a month, against an idle target of $1–3.
  Acceptable implementations:
  1. **Probe before querying.** Read the cluster's `ServerlessDatabaseCapacity` (`AWS/RDS`, dimension
     `DBClusterIdentifier`) from CloudWatch, which does not touch the database, and skip the sweep while
     it is 0. Conversations that went idle while the cluster slept are distilled when the next one starts
     or ends. This needs `cloudwatch:GetMetricData` on the worker role (no resource-level permissions; an
     infrastructure change with a cdk-nag acknowledgment).
  2. **Per-conversation delayed messages instead of polling.** After each turn the API sends
     `distill_session` with an SQS delay (at most 15 minutes); the worker distills if the conversation is
     still idle and drops the message if a newer turn queued its own. Nothing runs when nobody talks; the
     sweep can then be disabled (`distillation.sweepEnabled: false`).

  A handler that queries Aurora unconditionally on every sweep is not acceptable.

### Consequences

- Good: the vEIR opens with what matters ("Last time you said…"), commitments carry over, and every line
  of what it keeps is visible and correctable.
- Good: the common pool grows only by governed publishing, so the cross-venture gate keeps holding.
- Bad: one more model call per conversation, and longer prompts (notebook plus three digests) raise the
  cost per turn; both stay under the daily caps.
- Bad: AI notes can be wrong. They are labelled unverified, never cited, and founders can fix them.
- Bad: lessons need an EIR's or program lead's review time; an unreviewed draft helps nobody.
- Neutral: new prompt sections must be added to the evals' system-prompt leak markers (G6), and identity
  rules stay aligned across the prompt, `validators/identity.ts` and the identity grader.

### Confirmation

- RLS tests for every new table; DB tests for distillation (idempotency, dedupe, expiry, suppressed
  lines, ephemeral sessions skipped), notebook edits and versions, and knowledge-library CRUD.
- Evals: G1 cross-venture (0 critical), G4 identity, G5 disclosure, G6 system-prompt leaks.
- Infrastructure: `infra/cdk/test/app.test.ts` pins the `DistillSweep` schedule (rate, message, retry
  policy, shared send-only role); `lambda-contract.json` → `worker.distillSweepMessage` is validated at
  synth.
- Operations: [cost controls](../../runbooks/cost-controls.md) "When Aurora does not pause" checks that the
  sweep does not keep the cluster awake.

## Revisit trigger

- A G1 finding, or founders correcting or clearing notebooks often (the notebook misleads more than it
  helps).
- Distillation cost per active venture above the per-person daily cap, or Aurora no longer pausing because
  of distillation.
- A real (non-synthetic) cohort: University data review of AI notes (retention, export, deletion) before
  any are kept.
