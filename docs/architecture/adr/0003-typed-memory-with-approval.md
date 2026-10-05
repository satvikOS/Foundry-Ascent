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
