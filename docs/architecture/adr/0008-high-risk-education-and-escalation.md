# ADR-0008: High-risk topics get educational framing and structured human escalation

- **Status:** Accepted (product boundary)
- **Date:** 2026-10-05
- **Deciders:** Platform owner
- **Blueprint basis:** 01 §7 "Risk, safety, and escalation" (trigger → response → human destination),
  §9 escalation gate (≥ 95 % recall); 03 §1 "High-risk advice", §14 "Over-reliance", §26 ADR-008; 02 §7
  "Human-AI operating model"

## Context and problem statement

Founders ask about IP ownership and licensing, contracts, securities and valuation, clinical/FDA pathways,
and sometimes about conflict, harassment or personal crisis. An AI coach must not act as counsel, a
regulator, an investor or a crisis service, and must not appear to carry an EIR's approval. Blueprint 01
§7 maps each trigger to a limited response and a human destination.

## Decision drivers

- Escalation recall ≥ 95 % on the labelled high-risk set (01 §9), independent of model behaviour.
- Crisis language must reach human support without waiting on (or trusting) a model call.
- Escalation packets share only what the founder consents to (minimum necessary, 03 §25 sprint 6).

## Considered options

1. **Deterministic pre-classifier + forced escalation + educational framing; founder-consented packets**
   (chosen).
2. Refuse high-risk topics outright.
3. Let the model decide when to escalate.

## Decision outcome

Chosen option: **1**.

- `packages/ai/src/risk` classifies every turn before retrieval (`ip_licensing`, `legal`,
  `securities_investment`, `medical_regulatory`, `safety_wellbeing`, `conflict_harassment`, plus
  `prompt_injection` and `cross_venture_request`).
- High-risk input forces `escalation.required` in the validated response regardless of the model output;
  the answer is reframed as general education with limits stated.
- Crisis language short-circuits: an immediate human-support response with no model call and a P1
  escalation draft.
- Escalations (`P0`–`P3`) start as drafts or `awaiting_consent`; the founder reviews and approves sharing
  before a packet is routed to an EIR or program lead. A consented escalation without an assigned EIR
  waits as `awaiting_assignment` until a program lead routes it (`routed → acknowledged → resolved |
declined`, or `withdrawn`); the full state machine is in system design §6.2. Program leads see queue
  metadata only.

### Consequences

- Good: the escalation gate is testable with the labelled set; it does not regress when prompts change.
- Good: founders keep control of what leaves their workspace.
- Bad: keyword/pattern classifiers produce false positives (over-escalation); acceptable for a safety
  boundary, tuned against the evals benchmark.
- Bad: human destinations must exist and be staffed; the inbox is only as good as its response times.

### Confirmation

- `packages/ai/src/risk/classifier.test.ts`; validator tests for forced escalation.
- Evals: labelled high-risk scenarios (≥ 95 % recall gate) and red-team prompts.
- Runbook: [incident response](../../runbooks/incident-response.md) (harmful response).

## Revisit trigger

- Escalation precision so low that EIRs report packet fatigue (02 §12 human-leverage metric), or a
  University policy defines specific destinations (UR Ventures, counsel, clinical contacts) to wire in.
