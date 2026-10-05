# ADR-0002: One orchestrator with deterministic validators

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Platform owner
- **Blueprint basis:** 03 §1 "Agent design", §5 "Conversation orchestrator", §13 "Observability, quality,
  and evaluation", §26 ADR-002; 01 §7 safety gates

## Context and problem statement

A coaching turn must be authorized, risk-classified, grounded in scoped evidence, labelled
(fact / inference / hypothesis / recommendation) and checked before the founder sees it. Multi-agent
designs (planner, critic, retriever agents talking to each other) are popular but hard to test and audit.
Blueprint 03 §1 asks for "one orchestrator plus deterministic policy, authorization, retrieval, and
response validators", which is easier to test and audit than a swarm.

## Decision drivers

- Every safety property in 01 §7 must be provable by a repeatable test, not by sampling model behaviour.
- Auditability: one place that records what was retrieved, what the model returned and what was changed.
- Cost and latency: one structured model call per turn (plus at most one repair retry).

## Considered options

1. **Single orchestrator + deterministic pre-classifier and validators** (chosen).
2. Multi-agent pipeline with LLM critics/judges in the loop.
3. Model-only safety (system prompt instructions, provider guardrails).

## Decision outcome

Chosen option: **1**. `packages/core/src/orchestrator/run-turn.ts` runs a fixed sequence (system design §7):
authorize → deterministic risk pre-classification (`packages/ai/src/risk`) → scoped hybrid retrieval →
bounded context assembly → one JSON-schema-constrained `CoachResponse` generation → deterministic
validation (`packages/ai/src/validators`: unknown evidence ids stripped, unsupported `fact` claims
downgraded, grounding-coverage narrowing, forced escalation for high-risk input, identity and
cross-venture canary checks, length bounds) → persistence and audit. LLM-as-judge is used only offline
in `evals/`, never as a gate in the request path.

### Consequences

- Good: each validator is a pure function with unit tests; regressions are caught in CI, not production.
- Good: the turn state machine (`turn.status` SSE events) maps one-to-one onto the UI progress steps.
- Bad: rule-based classifiers have recall limits; they are tuned against the labelled red-team set and
  backed by escalation (ADR-0008) rather than trusted alone.
- Bad: richer agentic behaviours (tool use, multi-step research) need an explicit design change.

### Confirmation

- Unit tests: `packages/ai/src/validators/*.test.ts`, `packages/ai/src/risk/classifier.test.ts`,
  `packages/core/src/orchestrator/orchestrator.test.ts` (mock model) and `orchestrator.db.test.ts`.
- `turns.validator_results` stores which validators fired, so the evals harness and EIR calibration
  reviews can measure them.

## Revisit trigger

- A bounded multi-agent task (e.g. research across shared corpora) materially outperforms the single
  orchestrator on the blueprint 01 §9 gates in the evals harness, at acceptable cost and latency.
