# ADR-0014: Bedrock models — Nova 2 Lite primary with a global fallback, GPT-6 Luna gated behind a flag, Titan embeddings

- **Status:** Accepted (amended 2026-10-05: AWS gates GPT-6 Luna for this account, so production runs
  Nova 2 Lite as primary and keeps Luna disabled behind `models.luna.enabled`)
- **Date:** 2026-10-05
- **Deciders:** Platform owner
- **Blueprint basis:** 03 §8 "Data minimization" and "Vendor", §14 "Model memorization / retention",
  §24 "Reasoning / speech" (timeout and circuit breaker per model/region); 01 §10 decision 3

## Context and problem statement

The orchestrator needs one structured-output reasoning model with reliable JSON-schema adherence, a
fallback that fails independently, and an embedding model for hybrid retrieval. Data must stay in an AWS
account we control, with no training on prompts, at a cost compatible with a near-zero budget (ADR-0015).

The intended primary was GPT-6 Luna on Bedrock's OpenAI-compatible Mantle endpoint (cheapest per turn).
On 2026-10-05 Luna is listed for the account, but every invocation returns 401 "not available for this
account": AWS gates it per account. The platform must ship without it and adopt it later without a code
change.

## Decision drivers

- Strict structured output (`CoachResponse` JSON schema) and function calling.
- Independent failure domains for primary and fallback where available.
- One cloud boundary for data residency, IAM, billing and audit; no third-party API keys.
- Cost per turn: inputs are evidence-heavy (≤ 12 k tokens), outputs are short structured documents.
- No IAM permission for a model the platform does not call.

## Considered options

1. **Bedrock only: Amazon Nova 2 Lite as primary (`us.` inference profile) with the `global.` profile as
   fallback, Titan Text Embeddings V2, and GPT-6 Luna wired in but disabled behind a config flag until AWS
   enables it** (chosen).
2. Wait for Luna before shipping.
3. Direct vendor APIs (OpenAI, Anthropic) with API keys stored in Secrets Manager.

## Decision outcome

Chosen option: **1**, region `us-east-1` (Luna on Mantle is offered only there).

| Role            | Model id (production today)      | Endpoint / API                                                                                                          | Price per 1M tokens                            |
| --------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Primary         | `us.amazon.nova-2-lite-v1:0`     | `bedrock-runtime` Converse with one forced tool whose input schema is the response schema                               | $0.30 in / $2.50 out                           |
| Fallback        | `global.amazon.nova-2-lite-v1:0` | same; global cross-region routing (different capacity pool, same model family)                                          | $0.30 in / $2.50 out                           |
| Embeddings      | `amazon.titan-embed-text-v2:0`   | `bedrock-runtime` InvokeModel `{inputText, dimensions: 1024, normalize: true}`                                          | ~$0.02 in                                      |
| Gated, disabled | `openai.gpt-6-luna`              | `bedrock-mantle` `/openai/v1` Chat Completions, SigV4 service `bedrock-mantle`, `response_format: json_schema` (strict) | $0.10 in / $0.50 out (+10 % in-region premium) |

The gateway chooses the adapter by model id (`openai.*` → Mantle, anything else → Converse) and passes
inference-profile ids through unchanged. Each attempt has a 25 s timeout and one repair retry on invalid
JSON; then the router falls back. Prices are configuration (`packages/ai/src/pricing.ts`) and every
billable attempt writes `usage_ledger`.

`infra/cdk/config/production.json` holds the switch; `infra/cdk/src/lib/models.ts` maps it to the runtime
contract and the IAM grants:

| `models.luna.enabled` | `MODEL_PRIMARY_ID`           | `MODEL_FALLBACK_ID`              | IAM                                                                |
| --------------------- | ---------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| `false` (production)  | `us.amazon.nova-2-lite-v1:0` | `global.amazon.nova-2-lite-v1:0` | `bedrock:InvokeModel*` on Nova and Titan only; no `bedrock-mantle` |
| `true`                | `openai.gpt-6-luna`          | `us.amazon.nova-2-lite-v1:0`     | adds `bedrock-mantle:CreateInference`                              |

### Enabling Luna later

1. Request or confirm Luna access for the account in the Bedrock console.
2. Run **Ops - verify AWS access**. Its two GPT-6 Luna probes (models list, one 16-token chat completion)
   only warn while the flag is `false`; both must report PASS.
3. Run the **Evals** workflow against production to record the Nova baseline.
4. Open a pull request that sets `models.luna.enabled` to `true` (nothing else). CI's CDK tests
   (`models.test.ts`) assert the model mapping and the Mantle grant.
5. Merge; **Deploy** ships it. Run the evals again and compare gates, cost per turn and latency.
6. Rollback: set the flag back to `false` and deploy.

### Consequences

- Good: no API keys; IAM scopes each Lambda to exactly the models it uses; under Bedrock's data policy
  prompts and outputs are not used for model training or shared with model providers (re-verify per
  model before any data-class change, ADR-0006); usage appears on the AWS bill and in Cost Explorer.
- Good: adopting Luna is a reviewed one-line config change plus a normal deploy.
- Bad: while Luna is gated, primary and fallback share a model family (correlated failures and biases);
  the fallback only adds routing and capacity independence.
- Bad: Nova 2 Lite costs about 3–4× more per turn than Luna would (≈ $0.007 vs ≈ $0.002 at 12 k in /
  1.5 k out); the daily spend caps (ADR-0015) bound it.
- Bad: Mantle is a newer endpoint with its own SigV4 service name; the adapter signs requests itself.

### Confirmation

- Gateway tests (`luna.test.ts`, `nova.test.ts`, `titan.test.ts`, `router.test.ts`) with stubbed
  transports: request signing, schema enforcement, repair, fallback, adapter choice by model id.
- CDK `models.test.ts`: model ids and IAM grants follow `models.luna.enabled`.
- The **Ops - verify AWS access** workflow probes Nova (base id and both profiles) and Titan as required,
  and Luna as required only while the flag is `true`.

## Revisit trigger

- AWS enables Luna for the account (follow [Enabling Luna later](#enabling-luna-later)).
- Evals show a quality, grounding or escalation gap (01 §9) that a different Bedrock model closes at
  acceptable cost, or prices change materially.
