# ADR-0011: Aurora Serverless v2 PostgreSQL via the Data API; SQS + Lambda for durable jobs

- **Status:** Accepted (deviation: Temporal and Redis deferred)
- **Date:** 2026-10-05
- **Deciders:** Platform owner
- **Blueprint basis:** 03 §6 "Knowledge and memory architecture", §18 "Services, layers, and
  orchestration" (workflow workers), §24 "State" and "Durable jobs", §26 ADR-011; 05 §12 "Durable state"

## Context and problem statement

Blueprint 03 §26 ADR-011 selects PostgreSQL hybrid retrieval (pgvector + full-text) with RLS before
ranking as the isolation and audit foundation; §24 adds Redis for ephemeral coordination and a Temporal
namespace for durable work (ingestion, reviews, exports, deletion). V1 runs in a personal AWS account with
an idle-cost target of about $1–3/month and must stay within a permissions boundary that denies NAT
gateways, VPC endpoints, customer KMS keys and non-serverless databases (ADR-0015).

## Decision drivers

- One transactional authority for identity, assignments, memory, evidence and retrieval (03 §17 table).
- RLS, pgvector and FTS in the same engine, so authorization filters run inside the retrieval query.
- Near-zero idle cost; no always-on compute; no NAT for Lambdas.
- Durable, retryable background work (document ingestion, recaps, embedding backfill) with a dead-letter
  path, without operating a workflow cluster.

## Considered options

1. **Aurora Serverless v2 PostgreSQL 16 (0–2 ACU, auto-pause) through the RDS Data API; SQS + worker
   Lambda + DLQ for jobs** (chosen).
2. Provisioned RDS PostgreSQL (or Aurora with min 0.5 ACU) in a VPC, Lambdas in the VPC, Temporal Cloud.
3. A separate vector database (OpenSearch Serverless) next to a relational store.

## Decision outcome

Chosen option: **1**. Aurora Serverless v2 PostgreSQL 16.13 with `serverlessV2MinCapacity: 0`,
max 2 ACU, auto-pause after 10 idle minutes, Data API enabled, deletion protection, 7-day backups, in an
isolated-subnet VPC with no internet path. Lambdas run outside any VPC and use the Data API (IAM + Secrets
Manager), so no NAT or VPC endpoint exists. `packages/db` hides the driver behind `SqlExecutor`: the Data
API driver in AWS, node-postgres locally and in CI, with identical parameter typing. While Aurora resumes
from auto-pause (~15 s), the API retries `DatabaseResumingException` within a 40 s budget
(`DB_RESUME_BUDGET_MS`), then answers `503 database_resuming` with `Retry-After`; the web client retries
for about 45 s and shows "Waking up your workspace…". The public `/health` never queries the database (it
reports only what the instance last observed), so polling it cannot keep the cluster awake; the platform
admin's `/admin/health` probes it. Durable jobs use an SQS queue (SSE-SQS, visibility 720 s) with a
worker Lambda (batch 5, partial batch failures, at most 2 concurrent pollers) and a DLQ after 3 receives.
Temporal and Redis are deferred.

### Consequences

- Good: compute costs $0 while paused; one engine for relational data, vectors, FTS and RLS.
- Good: migrations, RLS and retrieval are tested against real PostgreSQL 16 + pgvector in CI.
- Bad: the first request after idle waits ~15 s for Aurora to resume; the API, the SPA's "waking up"
  banner, the smoke test and the evals harness all wait for it.
- Bad: Data API limits — one statement per call, no `vector`/`tsvector` in result sets, 1 MB responses —
  shape the SQL (`packages/db/README.md`).
- Bad: SQS gives at-least-once delivery, not orchestration; handlers are idempotent and multi-step
  workflows (human approval signals, long exports) need a later design.
- Neutral: the HNSW index serves shared corpora; venture-scoped searches use exact scans after filtering.

### Confirmation

- DB integration tests in CI (`pgvector/pgvector:pg16`, migrations as a non-superuser like Aurora's master).
- CDK assertions: `db.serverless` writer, min capacity 0, Data API on, no NAT/EIP/endpoints.
- Alarm `FoundryAscent-Jobs-DLQ-NotEmpty`.

## Revisit trigger

- Sustained load where resume latency or 2 ACU limits hurt founders (raise max ACU or min capacity first).
- A workflow needs durable timers, human-approval signals or multi-day state (e.g. deletion certificates,
  partner exports): introduce Temporal (03 §24) for that workload.
- A partner requires regional data residency: one cluster per regional data plane (05 §13).
