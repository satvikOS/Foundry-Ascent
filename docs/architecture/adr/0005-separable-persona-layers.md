# ADR-0005: Separable, versioned persona layers

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Platform owner
- **Blueprint basis:** 03 §1 "Persona", §9 "EIR persona and likeness pipeline" (release criteria), §14
  "Persona poisoning", "Likeness misuse", §26 ADR-005; 02 §6 "EIR persona and synthetic identity
  lifecycle"; 01 §6 consent controls

## Context and problem statement

The long-term vision includes virtual personas of consenting Entrepreneurs-in-Residence. An EIR must be
able to approve, correct, suspend or retire any part of their persona — doctrine, style, voice, likeness —
without corrupting venture data, and the product must never imply that the human is present
("amplify, never impersonate"). V1 ships only the neutral **Foundry Guide**, but the data model must not
paint us into a corner.

## Decision drivers

- Consent is per asset and per use (01 §6); revoking one asset must not require deleting the others.
- Persona content is governed and versioned in our store, never only in a vendor's UI (03 §9).
- Sessions are reproducible: each turn pins the persona release it used (03 §15).
- Suspension without engineering (01 §7 safety gate).

## Considered options

1. **Separate persona, release, consent and assignment records; each layer independently controllable**
   (chosen).
2. A single prompt template per EIR.
3. Vendor-hosted persona (avatar platform knowledge base + voice clone).

## Decision outcome

Chosen option: **1**. `personas` (`kind`: `neutral_guide` | `eir_persona`; `status`: `draft`, `active`,
`suspended`, `retired`) own versioned `persona_releases` (doctrine, style card, red lines, disclosure,
allowed modes; `draft → approved → superseded | withdrawn`). `consents` record asset types, approved uses
and revocation; revoking a consent suspends the personas that rely on it. `assignments` bind a venture to
a persona release (and optional EIR) with allowed modes, a data-class ceiling and expiry, and are
re-resolved on every session start and turn. Voice and visual likeness are future asset layers with their
own consent and kill switch (ADR-0010). V1 seeds only the neutral Foundry Guide (no real EIR identity).

### Consequences

- Good: suspending a persona or one release stops new turns immediately without touching memory.
- Good: doctrine changes go through draft → approval with a version number visible in every turn record.
- Bad: more tables and an approval workflow before any persona change takes effect.
- Neutral: the persistent disclosure text is part of the release, so it is versioned and reviewable.

### Confirmation

- Session creation and every turn refuse suspended personas, withdrawn releases and inactive assignments
  (`persona_suspended`, `assignment_inactive`; `packages/core/src/services/sessions.ts`,
  `packages/core/src/orchestrator/run-turn.ts`, covered by `orchestrator.db.test.ts`).
- Persona studio actions (`POST /personas/:id/suspend|resume`, release approval) are audited.
- Runbook: [kill switch and persona suspension](../../runbooks/kill-switch-and-persona-suspension.md).

## Revisit trigger

- Before the first real EIR persona: the consent schema and release criteria are re-validated against the
  chosen voice/avatar vendor's terms and University approval (03 §9), and this ADR is updated.

## Amendment (2026-10-16)

Two **fictional** EIR personas, built from the synthetic EIR profiles Corin Halvorsen and Ruth
Abernathy-Song, now ship next to Foundry Guide, each with a synthetic consent record (doctrine, style,
voice, cases), an approved release, a voice configuration and a common knowledge pool
([ADR-0018](0018-veir-knowledge-pools.md)). They are not real people, so the revisit trigger above still
applies to the first real EIR. Voice is now a live layer: calls speak with a stock Amazon Polly voice,
and a persona-specific voice or portrait is used only with that persona's `voice` or `likeness` consent
([ADR-0010](0010-realtime-webrtc-deferred.md)). Program leads get product actions to create EIR
personas, record consent, assign them to ventures, and suspend or retire them; revoking a consent
suspends the persona automatically.
