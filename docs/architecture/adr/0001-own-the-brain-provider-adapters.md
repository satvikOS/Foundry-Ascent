# ADR-0001: Own the coaching brain; integrate providers through adapters

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Platform owner (Satvik Sathish Adyanthaya)
- **Blueprint basis:** 03 §1 "Architecture decisions at a glance", §10 "Avatar and speech provider
  abstraction", §24 "Provider adapter contract", §26 ADR-001

## Context and problem statement

Foundry Ascent's durable assets are the venture memory, the evidence trail, the coaching doctrine and the
safety policy. Blueprint 03 §1 places identity mapping, orchestration, retrieval, memory, policy,
evaluation and audit inside the platform and treats the avatar/voice vendor as a replaceable "body"
layer. Model vendors change quickly too: on 2026-10-05 the intended primary model (GPT-6 Luna on Bedrock)
is listed but gated for this account (ADR-0014). Which parts must we own, and how do vendors plug in?

## Decision drivers

- Confidentiality and traceability cannot depend on a vendor's conversation stack (03 §1 quality attributes).
- Portability: change model, voice or avatar vendors without rebuilding venture workspaces.
- Testability: the whole coaching loop must run offline and deterministically in CI.
- Graceful degradation: a provider outage must never remove text, evidence or escalation (03 §24).

## Considered options

1. **Own the brain, adapters for vendors** — orchestration, retrieval, memory, policy and validators in our
   code; models and (later) media behind narrow interfaces.
2. **Vendor-hosted agent** (e.g. an avatar platform's built-in LLM + knowledge base).
3. **Single-vendor SDK coupling** (call one model SDK directly from domain code).

## Decision outcome

Chosen option: **1**. `packages/core` owns the orchestrator, authorization, memory and escalation;
`packages/ai` exposes a `ModelGateway` with a `StructuredProvider` contract (`luna`, `nova`, `titan`,
`mock` implementations, `createModelGateway`/`modelGatewayConfigFromEnv`). Domain code never imports a
vendor SDK. Provider selection is runtime configuration (`MODEL_PROVIDER`, `MODEL_PRIMARY_ID`,
`MODEL_FALLBACK_ID`, `MODEL_EMBEDDINGS_ID`). The realtime/avatar contract from 03 §24 is reserved for
ADR-0010 and will follow the same rule.

### Consequences

- Good: vendors receive only the bounded, already-authorized context for one turn (data minimization, 03 §8).
- Good: the deterministic `mock` provider makes orchestrator, API and Playwright tests hermetic.
- Good: when AWS gated GPT-6 Luna, Nova 2 Lite became primary through configuration alone; enabling
  Luna later is the config flag `models.luna.enabled` in `infra/cdk/config/production.json` (ADR-0014).
- Bad: we maintain prompt assembly, JSON-schema enforcement, retries, timeouts and repair logic ourselves.
- Bad: vendor-specific features (hosted memory, native tools) are used only if they fit the adapter contract.

### Confirmation

- Only `packages/ai/package.json` declares `openai` and `@aws-sdk/client-bedrock-runtime`; pnpm's strict
  `node_modules` layout makes an import from `packages/core` or `apps/*` fail to resolve.
- Gateway unit tests per provider (`packages/ai/src/gateway/*.test.ts`) and router fallback tests.
- Every turn records `model_id`, tokens, cost and latency (`turns`, `usage_ledger`), so a vendor change
  is visible per response.

## Revisit trigger

- Two vendor spikes (03 §26) show a provider-hosted capability we cannot reproduce behind the adapter
  without unacceptable latency or cost, **and** it passes the same isolation and evaluation gates.
