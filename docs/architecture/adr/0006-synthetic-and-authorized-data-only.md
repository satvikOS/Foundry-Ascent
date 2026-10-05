# ADR-0006: Synthetic, public or expressly authorized data only

- **Status:** Accepted (required until the applicable University approval expands scope)
- **Date:** 2026-10-05
- **Deciders:** Platform owner
- **Blueprint basis:** 03 §8 "University data rule", §15 environments, §26 ADR-006; 01 §6 "Data classes
  and capstone treatment"; 05 §24

## Context and problem statement

Venture-private material (decks, customer lists, lab IP, financials) and anything FERPA-related, clinical
or export-controlled requires classification and University approval before it may enter a GenAI service
(01 §6, 03 §8). V1 runs on a personal AWS account with Amazon Bedrock and has no such approval. The
platform must still be demonstrable end to end.

## Decision drivers

- No real founder, venture, EIR or student data before approval; no biometric assets.
- Demonstrations, tests and red-team runs need realistic, varied content.
- The repository is public: fixtures must be safe to publish.

## Considered options

1. **Synthetic data only, with a classification column that makes the data class explicit** (chosen).
2. Real but "anonymized" venture data from past cohorts.
3. Public data scraped from program websites.

## Decision outcome

Chosen option: **1**. The seed creates invented ventures (QuietQuad, BenchTally, SoleSignal, EmberLoop),
invented EIRs and program staff, synthetic documents, resources and patterns, all marked `synthetic`
(`principals.synthetic`, `ventures.classification = 'synthetic'`). Each venture carries a canary string
used by the red-team suite. The only real person in the system is the platform owner, whose access code
hash is deployment configuration. The UI labels synthetic workspaces. Public program information may be
used with provenance and freshness dates (01 §6 "Public" class).

### Consequences

- Good: CI, local development and the production demo use the same data class; nothing sensitive can
  leak through logs, traces, Playwright reports or the public repository.
- Bad: benchmark results on synthetic ventures are a proxy; real-cohort validation is a later gate.
- Bad: "real venture data" in production requires a policy change, not just a config change.

### Confirmation

- Seed tests (`packages/db/src/seed/seed.test.ts`, `seed.db.test.ts`) assert synthetic markers and canaries.
- Pull request checklist item; CODEOWNERS review on seed and fixtures.
- Model invocation logging and vendor training opt-outs are reviewed before any data-class change.

## Revisit trigger

- Written University approval of the system, vendors and workflow for a specific data class (01 §10
  decision 5). Then: add the class to `classification`, update retention/deletion runbooks and the
  incident runbook, and supersede this ADR for that class only.
