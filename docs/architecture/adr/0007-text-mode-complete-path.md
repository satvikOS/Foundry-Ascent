# ADR-0007: Text mode is the complete product path

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Platform owner
- **Blueprint basis:** 03 §1 "Graceful degradation" and "Accessibility" quality attributes, §25
  "Definition of a pilot-candidate release", §26 ADR-007; 05 §15 "Low-bandwidth and resilient delivery",
  §24 "Recommended first build"

## Context and problem statement

The blueprints describe voice and an embodied avatar, but also require that text and evidence remain
available when video, voice or a provider fails, and that captions, transcript, keyboard operation and
text-only mode are first-class (03 §1). Blueprint 05 §24 recommends shipping the tenant-isolated
workspace and reviewed memory first. What is the V1 interaction surface?

## Decision drivers

- Every safety and trust property (evidence, labels, escalation, disclosure) must be fully expressible.
- WCAG 2.2 AA, keyboard-only and screen-reader use; low-bandwidth founders.
- Cost and vendor approval: no speech or avatar vendor is approved yet (01 §10 decision 3).

## Considered options

1. **Text-first V1; text is the complete path, media are optional layers later** (chosen).
2. Voice-first with text transcript as fallback.
3. Avatar video first.

## Decision outcome

Chosen option: **1**. V1 ships the full coaching loop in text: streamed turns over SSE (`turn.accepted`,
`turn.status`, `turn.completed`/`turn.blocked`/`turn.error`) rendered with progress steps announced through
`aria-live="polite"`; claims labelled fact / inference / hypothesis / recommendation with evidence ids;
uncertainty, challenge, next actions and escalation as structured sections; the persistent synthetic
disclosure on every session view and export. Voice and avatar (ADR-0010) will consume the same validated
`CoachResponse`, so they can never say something the text path did not approve.

### Consequences

- Good: one validated response contract serves all future modalities; accessibility is built in, not
  retrofitted.
- Good: the cheapest and most robust path to the 01 §9 grounding, escalation and isolation gates.
- Bad: the 01 §9 "warm-path first audible response" latency gate is not measured in V1.
- Neutral: rehearse mode (pitch practice) works in text; spoken rehearsal waits for ADR-0010.

### Confirmation

- Playwright founder journey with axe accessibility checks (CI `e2e` job).
- Keyboard-only and screen-reader walkthrough in the pull request checklist for UI changes.

## Revisit trigger

- When ADR-0010 is reopened: voice/avatar must render from the same `CoachResponse` and the text path must
  remain complete and default. A drill shows text and evidence still work with media providers disabled.
