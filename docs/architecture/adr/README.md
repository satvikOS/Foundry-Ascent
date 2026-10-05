# Architecture decision records

Decisions that shape Foundry Ascent V1, in [MADR](https://adr.github.io/madr/) form: context (with the
blueprint section it comes from), the options weighed, the decision, its consequences, how compliance is
confirmed, and the trigger that reopens it. The [system design](../system-design.md) is the build
specification; where it deviates from the blueprints in [`docs/blueprints/`](../../blueprints/), the
deviation and its reason live here. The system design cites these as `ADR-001` … `ADR-017`.

Blueprints: **01** Capstone proposal and scope · **02** Product and operating blueprint · **03** Technical
architecture specification · **04** Executive proposal · **05** Global university partnership and platform
blueprint.

| ADR                                                           | Decision                                                                                                                                                        | Status                         | Blueprint          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------ |
| [0001](0001-own-the-brain-provider-adapters.md)               | Own orchestration, memory, evidence and policy; every model or media vendor sits behind an adapter                                                              | Accepted                       | 03 ADR-001         |
| [0002](0002-single-orchestrator-deterministic-validators.md)  | One testable orchestrator with deterministic pre-classification and output validators                                                                           | Accepted                       | 03 ADR-002         |
| [0003](0003-typed-memory-with-approval.md)                    | Typed, source-linked venture memory; AI proposes, people approve                                                                                                | Accepted                       | 03 ADR-003         |
| [0004](0004-isolation-in-service-and-database.md)             | Venture isolation in the service layer and in PostgreSQL RLS (`app_rls`, SECURITY DEFINER helpers)                                                              | Accepted                       | 03 ADR-004         |
| [0005](0005-separable-persona-layers.md)                      | Persona doctrine, style, disclosure and likeness are separate, versioned, revocable layers                                                                      | Accepted                       | 03 ADR-005         |
| [0006](0006-synthetic-and-authorized-data-only.md)            | Synthetic, public or expressly authorized data only                                                                                                             | Accepted                       | 03 ADR-006         |
| [0007](0007-text-mode-complete-path.md)                       | Text mode is the complete V1 product path                                                                                                                       | Accepted                       | 03 ADR-007         |
| [0008](0008-high-risk-education-and-escalation.md)            | High-risk topics get educational framing plus structured human escalation                                                                                       | Accepted                       | 03 ADR-008         |
| [0009](0009-typescript-product-python-evals-rust-deferred.md) | TypeScript product, Python evals/ops; Rust deferred to a future realtime gateway                                                                                | Accepted (reconciles 03 vs 05) | 03 ADR-009, 05 §12 |
| [0010](0010-realtime-webrtc-deferred.md)                      | Realtime voice/WebRTC and avatars deferred behind adapter interfaces                                                                                            | Accepted                       | 03 ADR-010         |
| [0011](0011-aurora-serverless-postgres-data-api.md)           | Aurora Serverless v2 PostgreSQL (pgvector, FTS, RLS) via Data API, scale to zero; SQS + Lambda instead of Temporal                                              | Accepted (deviation)           | 03 ADR-011, §24    |
| [0012](0012-vite-tanstack-router-spa.md)                      | Vite + TanStack Router SPA instead of Next.js                                                                                                                   | Accepted (deviation)           | 03 ADR-012, 05 §18 |
| [0013](0013-access-codes-instead-of-cognito.md)               | Access codes instead of Cognito/SSO for V1                                                                                                                      | Accepted (deviation)           | 03 §8              |
| [0014](0014-bedrock-models-luna-nova-titan.md)                | Nova 2 Lite primary (`us.` profile) with the `global.` profile as fallback, Titan embeddings; GPT-6 Luna gated by AWS and disabled behind `models.luna.enabled` | Accepted (amended)             | 03 §24             |
| [0015](0015-cost-guardrails.md)                               | Cost guardrails: permissions boundary, daily AI spend caps, capacity ceilings, alarms, AWS Budget                                                               | Accepted                       | 03 §14             |
| [0016](0016-staged-iam-github-oidc.md)                        | Staged IAM: bootstrap user, then GitHub OIDC; permissions boundary on every role                                                                                | Accepted                       | 03 §8, §15         |
| [0017](0017-cloudfront-oac-lambda-function-url-streaming.md)  | CloudFront with OAC in front of a streaming Lambda Function URL                                                                                                 | Accepted                       | 03 §11, §24        |

## Writing a new ADR

1. Copy the structure of an existing record; number it with the next free four-digit id.
2. Cite the blueprint section or incident that forces the decision, and list the options you rejected.
3. State a concrete **revisit trigger** (a measurement, an approval, a vendor change), not "later".
4. Superseding a decision: set the old record's status to `Superseded by ADR-NNNN` and link both ways.
5. Update the system design in the same pull request when the decision changes what is built.
