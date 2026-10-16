# ADR-0003: Typed, source-linked venture memory with founder approval

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Platform owner
- **Blueprint basis:** 03 §6 "Knowledge and memory architecture", §26 ADR-003; 05 §9 "The
  persistent-memory promise", §10 "Memory growth, correction, and consolidation"; 02 §5

## Context and problem statement

The product promise is a coach that remembers the venture across sessions. Opaque chat history or
model-side "memory" silently turns inferences into venture fact, cannot be corrected precisely, and cannot
show where a remembered claim came from. Blueprint 05 §10 requires showing the founder what the system
remembers and what changed, inviting correction, and writing new memories as proposals. Blueprint 01 §9
sets a gate of ≥ 90 % approved-fact recall with 100 % source links.

## Decision drivers

- No silent fact creation (03 §18 memory service: "no silent fact creation").
- Every memory item is attributable to a source (turn, document, person) and correctable with history.
- Memory is retrievable per venture with visibility rules, never across ventures.
- Deletion must be real (erase content of all versions), not a hidden flag.

## Considered options

1. **Explicit typed memory objects with a proposal → approval lifecycle** (chosen).
2. Summarised chat history injected into each prompt.
3. Vector store of raw transcript chunks ("remember everything").

## Decision outcome

Chosen option: **1**. `memory_objects` holds typed items (`fact`, `hypothesis`, `decision`, `experiment`,
`evidence`, `action`, `milestone`, `risk`, `preference`, `relationship`, `insight`) with `status`
(`proposed → confirmed | disputed | superseded | expired | deleted`), `visibility` (`founder_private`,
`team`, `venture`, `advisors`), `confidence`, `source_refs`, `supersedes_id`, `pinned`, embeddings and a
full-text vector. `memory_events` is the append-only correction history. The orchestrator turns model
`memory_candidates` into **proposed** items only; a database check constraint makes it impossible to
confirm an AI-origin item without `approved_by`. Corrections create a new version that supersedes the
old one; delete erases every version and redacts history (`app.soft_delete_memory`).

### Consequences

- Good: the memory inspector can show provenance, history and pending proposals; recall is measurable.
- Good: retrieval ranks confirmed and pinned items above proposals and surfaces disputed items as
  contradiction signals (system design §7).
- Bad: founders must review proposals; unreviewed items carry less authority in retrieval.
- Bad: consolidation of near-duplicates is a later workflow (recap proposes, people decide).

### Confirmation

- `packages/db/src/repositories/memory.db.test.ts` (lifecycle, supersession, delete), the check
  constraint in `packages/db/migrations/0001_init.sql`, and RLS visibility tests in `rls.db.test.ts`.
- Evals: seeded multi-session recall benchmark (01 §9 continuity gate).

## Revisit trigger

- Never replaced by opaque chat history (03 §26 marks this foundational). Revisit the _approval rule_
  (e.g. auto-confirming founder-authored low-risk items) only with founder research evidence that review
  load harms continuity, and with the change recorded here.

## Amendment 2026-10-16: memory the vEIR keeps by itself (owner decision)

The revisit trigger fired: the platform owner found that review load harmed continuity ("the knowledge bucket
is not filling up on every conversation") and decided that there is no "add to memory" step. What the vEIR
learns from a standard conversation (a turn's memory candidates, a recap's, a distillation's) is **kept
automatically**: `confirmed`, origin `ai`, no approver, with `auto_kept_at` recording that nobody approved it
(migration 0013). The typed, source-linked model stays; only the approval gate moves:

- The approval CHECK admits an AI item without an approver only when it records that it was kept
  automatically; a model inference is still never durable without either a person or that record.
- Every kept item names the conversation it was learned from first (`session` source ref, "Learned from the
  conversation"), then its turn. The founder and team see it in Knowledge at once and correct, dispute or
  delete it like any item; a correction is the corrector's (it has an approver), so it survives the
  conversation's deletion.
- Deleting a conversation erases what was kept from it alone (nobody approved or corrected it since); an item
  other conversations also taught loses that conversation's sources and stays.
- A temporary (private) conversation keeps nothing, as before.
- An EIR's suggestions stay proposals for the founder to accept, and lessons for a vEIR's common pool keep
  their curators' review: those are other people's words entering the venture's memory or a shared pool.
- Only what the founder said or explicitly took up is kept: each candidate carries the model's `source` label
  (`founder_stated`, `founder_agreed`, `coach_advice`), checked against the conversation (a bare "sure" or "ok"
  agrees to nothing); the coach's own advice is never kept as a fact, citing a record or not.
- Forgetting is durable: deleting an item the vEIR learned (or correcting what it kept) leaves a fingerprint per
  conversation it came from (`memory_forgotten`: hashes and a 256-bit meaning signature, never text), so the next
  distillation of that transcript never keeps it again; it goes with its conversation.
- Pending AI proposals that existed are not kept blindly: the daily maintenance runs each through the checks new
  memory goes through and keeps it (an `approved` event marked `system`) or retires it as a restatement or as the
  coach's advice. The 30-day expiry of AI proposals is gone.
