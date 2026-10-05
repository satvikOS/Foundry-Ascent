# ADR-0009: TypeScript product, Python for evals and ops; Rust deferred to the realtime gateway

- **Status:** Accepted (reconciles blueprint 03 and 05)
- **Date:** 2026-10-05
- **Deciders:** Platform owner
- **Blueprint basis:** 03 §17 "Language standard and repository blueprint", §26 ADR-009; 05 §12 "Rust-first
  technical architecture", §24 (days 31–60 "Rust realtime gateway")

## Context and problem statement

The blueprints disagree. Blueprint 03 §17 makes TypeScript the product language (web, BFF, realtime
gateway, orchestration, adapters, contracts), Python the AI/data language, and allows Rust "only after
profiling identifies a media or parsing hot spot". Blueprint 05 §12 proposes a Rust-first core (Rust/Tokio
realtime core and session state, Rust/WASM client media) with TypeScript for the web shell and Python for AI
operations. V1 is text-first (ADR-0007) and deploys to AWS Lambda.

## Decision drivers

- One typed contract (`@foundry/contracts`, Zod) shared by browser, API and orchestrator.
- A small team: one language across web, API, domain and infrastructure (CDK is TypeScript).
- Rust's advantages (predictable latency, memory safety under high concurrency, media framing) matter
  for realtime audio, which V1 does not ship.
- Python's ecosystem is strongest for evaluation harnesses and ops scripting (boto3).

## Considered options

1. **TypeScript for product and orchestration; Python for evals and ops; Rust only for a future realtime
   gateway after measurement** (chosen).
2. Rust-first per blueprint 05 §12 (Rust services, TypeScript web).
3. Python services (FastAPI) for retrieval and memory per blueprint 03 §17 table, TypeScript elsewhere.

## Decision outcome

Chosen option: **1**. `apps/*`, `packages/*` and `infra/cdk` are TypeScript 5.9 (strict ESM). Retrieval and
memory stay in TypeScript over PostgreSQL rather than separate Python services: at V1 scale they are SQL
(pgvector + FTS + RLS) and a second runtime would add a network hop and a duplicate contract. Python 3.12
owns `evals/` (scenario benchmark, red team, reports against a running API) and `ops/aws/` (inventory,
verification, cleanup, policy upsert). Rust is reserved for the realtime media gateway when ADR-0010 is
reopened, which is where blueprint 05 §12 locates its benefit, and only with measured need as 03 §17
requires.

### Consequences

- Good: types flow end to end; one toolchain for lint, test and build in CI.
- Good: evaluation stays independent of product code (black-box against the API), which keeps it honest.
- Bad: Lambda + Node is not suited to long-lived media sessions; that is exactly the trigger below.
- Neutral: blueprint 05's Rust/WASM client media is out of scope until voice exists.

### Confirmation

- Repository layout (system design §3) and CI jobs: Node jobs for `apps`/`packages`/`infra`, a Python job
  (ruff + pytest) for `ops/aws` and `evals`.

## Revisit trigger

- Realtime voice is approved and a prototype shows Node cannot meet the interruption/latency budget
  (03 §12, ≤ 200 ms barge-in; 01 §9 P50 ≤ 800 ms first audible response), or profiling finds a CPU-bound
  parsing hot spot (ingestion) that native libraries cannot fix.
