# Foundry Ascent — V1 System Design

Status: **Accepted for V1 build** · Owner: Satvik Sathish Adyanthaya · Source blueprints: [`docs/blueprints/`](../blueprints/)

This document is the single source of truth for the V1 implementation. Where it deviates from the
blueprints, the deviation is recorded as an ADR in [`adr/`](adr/) with its rationale.

---

## 1. Scope

**V1 = text-first core** (blueprint 05 §24 "Recommended first build"; blueprint 03 sprints 1–3 + 6):

| In V1                                                                                                                                                                                    | Deferred (adapter interfaces exist)                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Partner-separated (multi-tenant) venture workspaces, Ain as the first tenant                                                                                                             | Realtime voice (ASR/TTS, barge-in) — Rust/WebRTC gateway per blueprint 05           |
| Neutral **Foundry Guide** coach (no real EIR identity) with six modes: diagnose, challenge, coach, teach, rehearse, route                                                                | Avatar embodiment (HeyGen LiveAvatar / Azure) — needs vendor + consent              |
| Typed, source-linked venture memory with founder approval, correction, supersession, pin, delete                                                                                         | Real EIR personas (persona studio supports drafts; release requires consent record) |
| Evidence pack + citations for every substantive answer; fact / inference / hypothesis / recommendation labels                                                                            | SSO (UR / Cognito) — identity provider interface exists                             |
| Session contract: diagnosis, evidence, challenge, next actions, escalation                                                                                                               | Offline kit, async review queue                                                     |
| Escalation packets (P0–P3) with founder sharing consent, EIR/program inbox                                                                                                               | Pattern publication workflow (table + read path only)                               |
| Document upload → ingestion → hybrid (vector + full-text) retrieval                                                                                                                      | Localization                                                                        |
| EIR studio (persona releases, suspend/resume, calibration reviews), program portfolio (k-anonymous aggregates), admin (access codes, kill switch, daily AI spend caps, audit log, usage) |                                                                                     |
| Synthetic seed data only (ADR-006)                                                                                                                                                       | Real venture data (needs University approval)                                       |

Non-negotiables carried from the blueprints: amplify never impersonate (persistent synthetic
disclosure), venture-private by default, human authority (suspend without engineering), evidence before
eloquence, memory visible and correctable, escalation is a feature.

---

## 2. Architecture

```
Browser (SPA, Vite + React)                         GitHub Actions (CI/CD, OIDC)
        │ HTTPS                                                │
        ▼                                                      ▼
CloudFront ──/*──► S3 site bucket (OAC)              CDK → CloudFormation (boundary-capped roles)
    │
    └──/api/*──► Lambda Function URL (OAC, IAM auth, response streaming)
                     │  apps/api (Hono) ─ packages/core ─ packages/ai ─ packages/db
                     │
                     ├── RDS Data API ──► Aurora Serverless v2 PostgreSQL 16.13 (pgvector, FTS, RLS)
                     │                      min 0 ACU (auto-pause) · max 2 ACU · isolated subnets
                     ├── Bedrock Runtime ──► us.amazon.nova-2-lite-v1:0     (primary reasoning)
                     │                   ├─► global.amazon.nova-2-lite-v1:0 (fallback reasoning)
                     │                   └─► amazon.titan-embed-text-v2:0   (embeddings, 1024-d)
                     ├╌╌ Bedrock Mantle  ╌╌► openai.gpt-6-luna  (gated by AWS for this account;
                     │                       disabled: models.luna.enabled = false, see §7)
                     ├── S3 documents bucket (presigned PUT, venture-scoped keys)
                     └── SQS jobs queue ──► worker Lambda (ingestion, recap, consolidation) ──► DLQ
```

- **Region:** `us-east-1` (Luna on Mantle is offered only there; Nova 2 Lite and Titan run there too).
- **No VPC for Lambdas, no NAT, no customer KMS keys** — Data API reaches Aurora; the Aurora cluster
  lives in a VPC with isolated subnets only (zero hourly cost). Encryption at rest uses AWS-managed keys.
- **Idle cost target:** ≈ $1–3/month (Aurora storage, one Secrets Manager secret, S3, logs). Aurora
  compute is $0 while paused (auto-pause after 10 idle minutes). The first database request after a pause
  waits ~15 s while Aurora resumes: the API waits up to 40 s, then answers `503 database_resuming` with
  `Retry-After`, and the SPA retries for about 45 s behind a "Waking up your workspace…" banner. The
  public `GET /health` never queries the database, so uptime checks cannot keep Aurora awake.
- **Cost guardrails** (ADR-0015): the `FoundryAscent-Boundary` permissions boundary denies cost hazards
  (NAT, EC2, customer KMS keys, provisioned capacity, …) for every platform role; daily AI spend caps
  (global and per person) and turn rate limits are enforced in the database before every model call;
  Aurora max 2 ACU; CloudWatch alarms to SNS. An account-level AWS Budget with email alerts is
  recommended (outside CDK). Lambda reserved concurrency is optional and off in production
  (`api.reservedConcurrency: null`): a reservation fails the deploy on accounts whose Lambda concurrency
  quota is only 10, and the spend caps do not depend on it.

---

## 3. Repository layout and engineering standards

```
apps/
  api/            Hono app, Lambda handlers (api, worker, migrate), local dev server
  web/            Vite + React 19 SPA
packages/
  contracts/      Zod schemas: domain, API DTOs, AI response contract, error codes (single source of types)
  db/             SQL migrations, SqlExecutor (Data API + node-postgres), request context, repositories
  ai/             Model gateway (Nova, Titan, Luna, mock), prompts, risk classifier, validators
  core/           Domain services: authz, sessions/orchestrator, memory, retrieval, escalation, usage, audit
infra/
  cdk/            AWS CDK v2 app (TypeScript)
  iam/            Stage-0 policies and permissions boundary
evals/            Python 3.12: scenario benchmark, red-team suite, report
ops/aws/          Python ops tooling (inventory, verify access, cleanup, policy upsert)
docs/             Architecture, ADRs, runbooks, blueprints
```

- **Package manager:** pnpm 10 workspaces. **Node** 24 (Lambda `nodejs24.x`, ARM64); local ≥ 22.
- **TypeScript 5.9**, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes: false`,
  ESM everywhere (`"type": "module"`), `moduleResolution: "Bundler"`. Internal packages are consumed as
  TypeScript source (`"exports": { ".": "./src/index.ts" }`); esbuild/Vite/Vitest compile them.
- **Lint/format:** ESLint 10 flat config + typescript-eslint (strict-type-checked where practical),
  Prettier 3. **Tests:** Vitest; DB integration tests against real PostgreSQL 16 + pgvector
  (`DATABASE_URL`); Playwright + axe for web e2e/a11y.
- **Validation at every boundary** with Zod (`packages/contracts`). No `any` in public APIs.
- **Logging:** structured JSON, one line per event, request ID on every line, **never raw prompts,
  answers, documents, or memory content** in general logs (blueprint 03 §8). Content lives only in the
  database under RLS.
- **Errors:** RFC 9457 problem+json (`type`, `title`, `status`, `detail`, `code`, `requestId`).
- **Idempotency:** every write endpoint honours `Idempotency-Key` (stored with a 24 h window). Deleting
  memory or a document also purges stored responses that mention it, so a replay never returns deleted
  content.
- **Commits:** imperative subject, why-focused body; main is protected by CI.

---

## 4. Identity, authentication, authorization

### 4.1 Identity (ADR-013 — no Cognito in V1)

- **Principals** are people (founders, EIRs, program staff, admins). Each belongs to one tenant.
- **Access codes** are the V1 credential: 100-bit random codes (`FA-XXXXX-XXXXX-XXXXX-XXXXX`,
  Crockford base32), stored only as `scrypt` hashes (`N=2^15, r=8, p=1`, 16-byte salt). Issued by an
  admin/program lead to a principal, shown **once**, revocable, optional expiry, `last_used_at`.
- **No Cognito, no passwords, no SSO in V1.** Access codes are the only sign-in method.
- The **owner code** is deployment configuration, never a secret in git: only its public lookup prefix
  and its scrypt hash are committed (`infra/cdk/config/production.json` → `owner.accessCodePrefix`,
  `owner.accessCodeHash`). The deploy passes them to the migrate Lambda (`OWNER_ACCESS_CODE_PREFIX`,
  `OWNER_ACCESS_CODE_HASH`) and the seed binds them to the owner principal (`platform_admin` +
  `program_lead` in the home tenant). The plaintext code is generated on a trusted machine, kept in the
  owner's password manager and never committed, logged or passed as a workflow input; its only copy
  outside the password manager may be the encrypted secret `FA_OWNER_ACCESS_CODE` of the `evals` environment, used by the
  manual evals workflow ([access codes runbook](../runbooks/access-codes.md)).
- **Sign-in** `POST /api/v1/auth/sign-in {accessCode}` → constant-time verify → creates an
  `auth_sessions` row → sets cookie `fa_session` (JWT HS256, 12 h, claims `sub`, `sid`, `tid`, `iat`,
  `exp`; `HttpOnly; Secure; SameSite=Strict; Path=/api`). Signing key: 32 random bytes generated by
  migration into `platform_keys` (rotatable). Sessions are revocable (checked with a 60 s cache).
- **Brute-force protection:** per viewer-IP (hashed) and global sliding windows in `auth_attempts`;
  10 failures / 15 min / IP → 15 min lockout (`429 locked_out` with `Retry-After`); uniform error message
  and timing. IPv6 viewers are counted per /64 prefix; attempts from one viewer are serialised under an
  advisory lock and recorded as failures before verification, so parallel guesses cannot pass the limit.
  The viewer IP comes from `x-fa-viewer-ip`, which the CloudFront viewer-request function
  sets (overwriting any client value).
- **CSRF:** SameSite=Strict + mandatory `X-Requested-With: foundry-ascent` on non-GET requests.
- **CloudFront → Lambda OAC:** browsers must send `x-amz-content-sha256` (hex SHA-256 of the body) on
  POST/PUT/PATCH/DELETE; the web API client computes it with WebCrypto.
- `IdentityProvider` interface (`accessCode` now; `oidc` later) keeps authorization code untouched when
  SSO arrives.

### 4.2 Roles

| Role                       | Scope    | Can                                                                                                                                                  | Cannot                                                |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `platform_admin`           | platform | principals, access codes, settings, kill switch, usage, audit metadata                                                                               | read venture content unless also a member             |
| `program_lead`             | tenant   | enrol ventures, invite principals, resources, portfolio aggregates (k ≥ 3), escalation queue (category/priority/status), suspend personas            | raw transcripts/memory unless member or packet shared |
| `eir`                      | tenant   | persona studio for linked personas, calibration reviews of **assigned** ventures' sampled turns, escalations assigned to them (shared packet fields) | ventures without an active assignment                 |
| venture `founder` / `team` | venture  | full workspace incl. `founder_private` items they authored                                                                                           | other ventures                                        |
| venture `advisor`          | venture  | items with visibility `venture`/`advisors`                                                                                                           | `founder_private`, `team` items                       |

### 4.3 Authorization (ADR-004: service **and** database)

1. **Service layer** (`packages/core/authz`): every request resolves `RequestContext {principalId,
tenantId, roles, requestId}` server-side; every venture-scoped operation calls
   `authz.requireVentureAccess(ctx, ventureId, action)` which re-derives membership/assignment from the
   database. Browser-supplied IDs are never trusted as authority. Decisions are audited
   (`retrieval.authorized` / `retrieval.denied`).
2. **Database** (RLS): every request runs inside a transaction that executes
   `SELECT set_config('role','app_rls',true), set_config('app.principal_id',$1,true),
set_config('app.tenant_id',$2,true), set_config('app.request_id',$3,true)` (one statement — the
   `role` GUC switch is verified by the DB test suite); every table has row level security enabled with
   policies using `app.current_principal()`, `app.can_read_venture(venture_id)` (SECURITY DEFINER), and
   visibility rules. `app_rls` is `NOBYPASSRLS` and owns nothing, so policies always apply to application
   traffic; the owner role is reserved for migrations and trusted system jobs (credential checks, audit
   chaining, workers on server-generated jobs) through a separate, explicitly named `SystemExecutor`.
   Credential, ledger and audit tables grant nothing to `app_rls`. Retrieval queries **always** filter
   by `venture_id` first (no unscoped vector search).
3. **Kill switches:** global (`platform_settings.ai_enabled`), per persona (`personas.status =
'suspended'`), per assignment. Checked on session create **and** every turn.

---

## 5. Data model

Authoritative DDL: [`packages/db/migrations/`](../../packages/db/migrations/). Summary:

| Table                                                             | Purpose                                                                                                                             | Key columns                                                                                                                                                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenants`                                                         | Ain (home) and partner universities                                                                                                 | `slug`, `kind`, `status`                                                                                                                                                    |
| `principals`                                                      | people                                                                                                                              | `tenant_id`, `display_name`, `email?`, `title`, `synthetic`                                                                                                                 |
| `role_grants`                                                     | tenant/platform roles                                                                                                               | `principal_id`, `tenant_id?`, `role`, `revoked_at`                                                                                                                          |
| `access_codes`, `auth_sessions`, `auth_attempts`, `platform_keys` | credentials and sessions                                                                                                            | hashes only                                                                                                                                                                 |
| `ventures`                                                        | venture workspace                                                                                                                   | `tenant_id`, `name`, `one_liner`, `stage`, `domain`, `cohort`, `classification`, `status`                                                                                   |
| `venture_memberships`                                             | founders/team/advisors                                                                                                              | `role`, `expires_at`, `revoked_at`                                                                                                                                          |
| `eir_profiles`                                                    | expertise registry (candidate metadata, not authority)                                                                              | `display_name`, `expertise_tags`, `synthetic`, `principal_id?`                                                                                                              |
| `personas`, `persona_releases`                                    | Foundry Guide + future EIR personas; versioned doctrine/style/disclosure                                                            | `status` (`draft/active/suspended/retired`), `doctrine`, `style`, `allowed_modes`                                                                                           |
| `consents`                                                        | likeness/voice/doctrine consent records                                                                                             | `asset_types`, `approved_uses`, `revoked_at`                                                                                                                                |
| `assignments`                                                     | venture ↔ persona release ↔ EIR (server-resolved every session)                                                                     | `allowed_modes`, `data_class_ceiling`, `status`, `expires_at`                                                                                                               |
| `knowledge_sources`, `knowledge_chunks`                           | program/public/persona/venture corpus; chunks with `embedding vector(1024)` + `tsv`                                                 | `scope`, `classification`, `freshness_at`                                                                                                                                   |
| `documents`                                                       | uploaded venture files → ingestion                                                                                                  | `s3_key`, `status`, `source_id`                                                                                                                                             |
| `memory_objects`                                                  | typed venture memory (fact, hypothesis, decision, experiment, evidence, action, milestone, risk, preference, relationship, insight) | `status` (`proposed/confirmed/disputed/superseded/expired/deleted`), `visibility`, `confidence`, `source_refs`, `attributes`, `supersedes_id`, `pinned`, `embedding`, `tsv` |
| `memory_events`                                                   | correction history (append-only)                                                                                                    | `action`, `diff`, `actor`                                                                                                                                                   |
| `coaching_sessions`, `turns`, `turn_evidence`                     | sessions, structured responses, evidence links                                                                                      | `mode`, `privacy`, `response`, `risk_label`, `validator_results`, `model_id`, tokens, `cost_usd`, `latency_ms`                                                              |
| `escalations`                                                     | human handoff packets                                                                                                               | `category`, `priority` P0–P3, `status`, `packet`, `sharing_consent_at`, `assignee_principal_id`                                                                             |
| `feedback`                                                        | founder ratings; `eir_reviews` — blind rubric scores                                                                                |                                                                                                                                                                             |
| `resources`                                                       | Ain program resource graph for **route** mode                                                                                       | `kind`, `tags`, `eligibility`, `url`, `freshness_at`                                                                                                                        |
| `patterns`                                                        | reviewed, de-identified lessons (read path only in V1)                                                                              | `status`, `expires_at`                                                                                                                                                      |
| `usage_ledger`                                                    | per-call model usage and cost (day, model, principal, venture)                                                                      |                                                                                                                                                                             |
| `audit_events`                                                    | append-only, hash-chained (`prev_hash`, `hash`) security/policy/admin/content events                                                | metadata only                                                                                                                                                               |
| `platform_settings`                                               | kill switch, spend caps, thresholds                                                                                                 |                                                                                                                                                                             |
| `idempotency_keys`                                                | write de-duplication                                                                                                                |                                                                                                                                                                             |

---

## 6. API (`/api/v1`, JSON, problem+json errors)

Schemas live in `packages/contracts/src/api.ts`; the web client and the server import the same types.
Every response carries `x-request-id`. `503 database_resuming`, `429 locked_out` and `429 rate_limited`
carry `Retry-After` (and `retryAfterSeconds` in the problem document).

| Area        | Endpoints                                                                                                                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health      | `GET /health` (public liveness: `status`, `version` = deployed commit, optional `db` = the state this instance last observed on real requests; **never queries the database**, so polling it cannot keep Aurora awake) · `GET /admin/health` (platform admin: probes the database)                                              |
| Auth        | `POST /auth/sign-in`, `POST /auth/sign-out`, `GET /me`                                                                                                                                                                                                                                                                          |
| Ventures    | `GET /ventures`, `GET /ventures/:id`, `PATCH /ventures/:id`, `GET /ventures/:id/overview` (since-last-session brief)                                                                                                                                                                                                            |
| Sessions    | `POST /ventures/:id/sessions`, `GET /ventures/:id/sessions`, `GET /sessions/:id` (blocked turns carry `blocked`: reason, support message, drafted escalation), `POST /sessions/:id/turns` (**SSE**), `POST /sessions/:id/end` (recap + memory candidates), `POST /turns/:id/feedback`, `GET /turns/:id/evidence`                |
| Memory      | `GET /ventures/:id/memory?type&status&q`, `POST /ventures/:id/memory`, `PATCH /memory/:id` (`approve/reject/correct/pin/unpin/delete`), `GET /memory/:id/history`                                                                                                                                                               |
| Documents   | `POST /ventures/:id/documents` (presigned upload), `POST /documents/:id/complete`, `GET /ventures/:id/documents`, `DELETE /documents/:id`                                                                                                                                                                                       |
| Escalations | `GET /ventures/:id/escalations`, `POST /ventures/:id/escalations`, `PATCH /escalations/:id` (founder: `approve_sharing/edit/withdraw`; assignee: `acknowledge/resolve/decline`), `GET /inbox/escalations`                                                                                                                       |
| Team        | `GET /ventures/:id/team`, `POST /ventures/:id/team/invitations` (program lead/admin → returns one-time access code)                                                                                                                                                                                                             |
| EIR studio  | `GET /personas`, `GET /personas/:id`, `POST /personas/:id/releases`, `GET /persona-releases/:id` (full release; drafts for program leads, platform admins and the linked EIR), `POST /persona-releases/:id/approve`, `POST /personas/:id/suspend`, `POST /personas/:id/resume`, `GET /eir/reviews`, `POST /eir/reviews/:turnId` |
| Program     | `GET /program/portfolio`, `GET/POST/PATCH /program/resources`, `GET /program/ventures`, `POST /program/ventures`, `GET /program/escalations` (metadata queue), `GET /program/assignees` (active EIRs and program leads of the tenant), `POST /program/escalations/:id/route`                                                    |
| Admin       | `GET/POST /admin/principals`, `POST /admin/principals/:id/access-codes`, `DELETE /admin/access-codes/:id`, `GET/PATCH /admin/settings`, `GET /admin/audit`, `GET /admin/usage`                                                                                                                                                  |

### 6.1 Turn streaming (SSE)

`POST /sessions/:id/turns {text, mode?}` responds `text/event-stream` with events:
`turn.accepted` → `turn.status` (`classifying`, `retrieving` + counts, `reasoning`, `validating`) →
`turn.completed` (full `CoachResponse` + evidence summaries + usage) or `turn.blocked` /
`turn.error` (problem+json). Each event is one `event: <name>` line plus one JSON `data:` line.
Refusals known before the stream starts (for example `423 persona_suspended`) are plain problem+json
responses. Clients render progress steps; text-only, keyboard-only, and screen-reader paths are
first-class (`aria-live="polite"`).

- `turn.error` always carries `requestId` (the response's `x-request-id`) and, when the server knows how
  long to wait, `retryAfterSeconds`. A retry with the same `Idempotency-Key` whose original turn is still
  being answered gets `turn.error` `conflict` with `retryAfterSeconds: 5`; the client replays it with the
  same key after the wait (no second model call).
- `turn.blocked` carries `reason` (`crisis_support`, `cross_venture`, `identity`, `invalid_schema`),
  `supportMessage` (the human-support message with crisis lines on the crisis path) and the drafted
  `escalationId`. `GET /sessions/:id` returns the same three fields as `TurnView.blocked`, so a reloaded
  session shows the same support; they never repeat the founder's text or blocked model output.

### 6.2 Escalation lifecycle

`escalations.status` is a state machine, enforced by the repository transitions, the CHECK constraints
in `0001_init.sql` (consent and assignee per state) and `app.route_escalation`:

```
draft (AI-drafted) ──┐                             ┌──► awaiting_assignment ──(program lead routes)──┐
                     ├──(founder approves sharing)─┤                                                 ▼
awaiting_consent ────┘     consent recorded        └──(venture's assigned EIR, requested role eir)──► routed
(founder-initiated)                                                                                   │
                                                  acknowledged ◄──(assignee)──────────────────────────┤
                                                       │                                              │
                                                       └──► resolved | declined (assignee) ◄──────────┘
any open state ──(founder)──► withdrawn
```

| Status                              | Meaning                                                                      | Who acts next                         |
| ----------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------- |
| `draft`                             | AI-drafted packet (crisis path, forced high-risk escalation); nothing shared | founder: edit, approve, withdraw      |
| `awaiting_consent`                  | founder-initiated request; nothing shared                                    | founder: edit, approve, withdraw      |
| `awaiting_assignment`               | consented, nobody assigned: in the program team's routing queue              | program lead: route                   |
| `routed`                            | assigned to an EIR or program lead, who can read the shared packet           | assignee: acknowledge/resolve/decline |
| `acknowledged`                      | the assignee picked it up                                                    | assignee: resolve/decline             |
| `resolved`, `declined`, `withdrawn` | final                                                                        | —                                     |

Approving sharing is allowed once, from `draft` or `awaiting_consent`; it routes directly to the
venture's active assigned EIR when the packet asks for an EIR, otherwise it waits for assignment. Program
leads route (or re-route) only consented, open escalations (`awaiting_assignment`, `routed`,
`acknowledged`), and only to an active EIR or program lead of the tenant (`GET /program/assignees` lists
exactly those people). The packet is editable only before consent.

---

## 7. Coaching orchestrator (`packages/core/orchestrator`)

One testable orchestrator with deterministic validators (ADR-002). State machine from blueprint 03 §5
(`NEW → AUTHENTICATED → … → RESPONDING → SUMMARIZING → MEMORY_REVIEW`, any → `SUSPENDED`).

**Per turn:**

1. **Authorize**: principal is an active member; session active; assignment + persona release active;
   global kill switch off; daily spend caps not exceeded; per-principal rate limit (20 turns / 10 min).
2. **Pre-classify (deterministic)** with `packages/ai/risk`: high-risk categories (IP/licensing,
   legal/contracts, securities/valuation/investment, medical/clinical/FDA/human-subjects, safety/crisis/
   wellbeing, harassment/conflict) and prompt-injection/exfiltration heuristics. Crisis language →
   immediate human-support response (no model call) + P1 escalation draft.
3. **Retrieve (authorized, scoped)**: per store, filtered by tenant + venture + visibility first, then
   hybrid score = `0.55·cosine + 0.25·ts_rank + 0.10·recency + 0.10·authority` with contradiction
   flags. Budgets: memory 8, venture chunks 6, doctrine 4, resources 4, patterns 2. Evidence items get
   stable IDs (`E1…En`) and are returned to the client.
4. **Assemble context** (≤ 12k input tokens): persona release (doctrine, style, red lines, disclosure),
   mode instructions, policy rules, evidence pack (content wrapped as _data_, never instructions),
   last 8 turns.
5. **Generate** `CoachResponse` via the model gateway with JSON-schema structured output:
   `{ mode, answer (markdown), claims[{text, kind: fact|inference|hypothesis|recommendation,
evidence_ids[]}], uncertainty[{item, level}], challenge, next_actions[{owner, action, target_date}],
escalation{required, category, priority, reason, requested_role}, memory_candidates[{type, title,
content, evidence_ids, confidence}], follow_up_questions[], rehearsal{counterpart, line, scores[],
critique} | null }`.
6. **Validate (deterministic)**: unknown evidence IDs stripped; `fact` claims without evidence are
   downgraded to `inference` and flagged; grounding coverage < 0.6 with ≥ 2 facts → answer narrowed
   (explicit uncertainty banner); pre-classifier high-risk ⇒ escalation forced; identity validator blocks
   first-person claims of being the human EIR or of personal endorsement; cross-venture validator blocks
   names/canaries of other ventures in the tenant; output length bounds.
7. **Persist** turn, evidence links, usage ledger, audit; memory candidates become `proposed`
   memory objects (never auto-confirmed).

**Model routing (packages/ai, ADR-0014):** the gateway picks the adapter by model id: `openai.*` →
Bedrock Mantle Chat Completions (SigV4, `response_format: json_schema` strict); anything else → Bedrock
Runtime Converse with a single forced tool whose input schema is the response schema. Inference-profile
ids (`us.`, `global.`) are passed through unchanged. Each attempt has a 25 s timeout and one repair retry
on invalid JSON, then the fallback runs. Embeddings: `amazon.titan-embed-text-v2:0` (1024-d, normalized).
`MODEL_PROVIDER=mock` gives a deterministic provider for tests and offline dev. Per-model prices are
configuration (`packages/ai/src/pricing.ts`); every billable attempt writes `usage_ledger`.

| `models.luna.enabled` (`infra/cdk/config/production.json`)                                            | `MODEL_PRIMARY_ID`           | `MODEL_FALLBACK_ID`              | Mantle permission                |
| ----------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------- | -------------------------------- |
| `false` — **production today**: AWS lists GPT-6 Luna but answers 401 "not available for this account" | `us.amazon.nova-2-lite-v1:0` | `global.amazon.nova-2-lite-v1:0` | none                             |
| `true` — after AWS grants Luna access                                                                 | `openai.gpt-6-luna`          | `us.amazon.nova-2-lite-v1:0`     | `bedrock-mantle:CreateInference` |

**Enabling Luna later** is a reviewed config change, not code: (1) run **Ops - verify AWS access**: both
GPT-6 Luna probes must PASS (they only warn while the flag is off); (2) run the evals workflow to record a
Nova baseline; (3) open a PR that sets `models.luna.enabled` to `true` (CDK then grants
`bedrock-mantle:CreateInference` and maps the model ids as above); (4) merge, let **Deploy** ship it, and
re-run the evals. Flipping the flag back is the rollback.

**Session end**: recap = the five session-contract objects (diagnosis, evidence, challenge, next
actions, escalation) + memory candidates; ephemeral sessions keep no memory beyond security records.

---

## 8. Ingestion and retrieval

Upload: client requests a presigned PUT (≤ 10 MB; PDF, DOCX, TXT, MD) → `tenants/{t}/ventures/{v}/documents/{id}/{filename}` →
`/complete` enqueues an SQS job → worker extracts text (`unpdf` for PDF, `mammoth` for DOCX), chunks
(~800 tokens, 15 % overlap, heading-aware), embeds (Titan, batched), stores `knowledge_chunks` with
`scope='venture'`, updates status. Failures go to the DLQ and the document shows `failed` with a
retry action.

---

## 9. Web application

**Stack:** Vite 8, React 19, TypeScript, TanStack Router (file-based, type-safe params/search),
TanStack Query, Tailwind CSS 4, shadcn/ui (Radix primitives), lucide-react, cmdk (⌘K), sonner,
react-hook-form + zod, motion (respecting `prefers-reduced-motion`). Portfolio and usage charts are plain
HTML/CSS (labelled bars, a table view, k-anonymous counts shown as "Fewer than k"), not a chart library.

**Routes** (blueprint 05 convention `/[partner]/app/…`):

```
/                                  public landing (product promise, disclosure, sign in)
/sign-in
/$tenant/app                       → role-aware home
/$tenant/app/ventures              my ventures
/$tenant/app/ventures/$ventureId/  VentureLayout (rail · context bar · canvas · inspector · dock)
    overview | coach | coach/$sessionId | memory | evidence | decisions | experiments |
    milestones | documents | team | escalations
/$tenant/app/eir/                  personas | personas/$personaId | reviews | inbox
/$tenant/app/program/              portfolio | ventures | resources | escalations
/admin/                            principals | access-codes | settings | usage | audit
```

**Shell** (blueprint 02 §4A, 03 §22): left rail (collapses to icon rail/drawer), top context bar
(venture, stage, assigned guide/persona release, synthetic label, session + DB health), central canvas,
right inspector (sources, known facts, assumptions, contradictions, proposed memory, handoff) as a
tabbed sheet on small screens, sticky control dock (send, mode, upload, escalate, end session).

**Visual system:** dark-first, muted black and grey (canvas `#0B0B0B`, raised `#151515`, border
`#303030`, text `#F4F4F2`, secondary `#A6A6A3`, focus `#FFFFFF`) with a matching light theme; Inter
Variable for UI, system serif for exported documents; 4-pt spacing grid; restrained motion; status =
label + icon + shape (never colour alone); WCAG 2.2 AA; full keyboard path, visible focus, skip links,
landmarks; text-only mode is the default in V1.

**Persistent disclosure** in every session view and every export: "You are working with Foundry
Guide, an AI coach. It is not a person, and no human EIR authored or approved these responses."

---

## 10. Infrastructure (CDK, `infra/cdk`)

Stacks (all `FoundryAscent-*`, termination protection on Foundation and Data, tags
`project=foundry-ascent`). Details and every number: [`infra/cdk/README.md`](../../infra/cdk/README.md).

1. **Foundation** — GitHub OIDC provider for `token.actions.githubusercontent.com`
   (`iam.OidcProviderNative`, CloudFormation type `AWS::IAM::OIDCProvider`; an account holds one per URL,
   so context `githubOidcProviderArn` imports an existing provider instead) and the
   `FoundryAscent-GitHubDeploy` role (trust: exactly `repo:satvikOS/Foundry-Ascent:environment:production`
   and `aud sts.amazonaws.com`; 1 h sessions; can assume the four CDK CLI bootstrap roles and read
   CloudFormation/Logs/Cost Explorer). `deploy.yml` decides create / keep / import on every run (§12).
2. **Data** — VPC (2 AZ, isolated subnets only, no IGW/NAT), Aurora Serverless v2 PostgreSQL 16.13
   (cluster `foundry-ascent`, `serverlessV2MinCapacity: 0`, `serverlessV2MaxCapacity: 2`, auto-pause
   10 min, Data API on, deletion protection, storage encrypted with the AWS-managed key, 7-day backups,
   log export to `/aws/rds/cluster/foundry-ascent/postgresql`), generated admin secret
   `foundry-ascent/aurora-admin`, documents bucket (private, SSE-S3, enforce SSL, CORS `PUT` from
   `https://*.cloudfront.net` plus the custom domain when set — the presigned URL is the authorization,
   lifecycle for incomplete uploads), SQS jobs queue + DLQ (SSE-SQS). **Already deployed:** the Data stack
   went out first, on its own, through **Platform - deploy data stack** with the stage-0 key, because
   Aurora takes longest to create; the first full deploy updates it in place.
3. **App** — API Lambda (Node 24, ARM64, 1024 MB, 60 s, no reserved concurrency in production — see §2,
   Function URL `AWS_IAM` + `RESPONSE_STREAM`), worker Lambda (SQS, batch 5, at most 2 concurrent pollers), migrate custom resource
   (applies `packages/db/migrations` via Data API with an advisory lock, then seeds synthetic data and the
   owner principal, then backfills embeddings; API, worker and site wait for it), site bucket + two
   `BucketDeployment`s (immutable `assets/*`, revalidated `index.html`), CloudFront (OAC to S3 and to the
   Function URL, `/api/*` uncached with `ALL_VIEWER_EXCEPT_HOST_HEADER` and a viewer-request function that
   sets `x-fa-viewer-ip` and `x-fa-viewer-host`, SPA rewrite CloudFront Function, security headers policy
   with CSP, HSTS, frame-ancestors none), log retention 30 days, alarms (API errors/throttles, worker
   errors, DLQ depth, CloudFront 5xx rate) to the SNS topic `FoundryAscent-Alarms`.

The API has no `SITE_ORIGIN` unless a custom domain is configured (the distribution domain would create a
stack cycle); it builds the origin from `x-fa-viewer-host`. TLS 1.2 as the minimum viewer protocol needs a
custom domain and ACM certificate (`siteDomainName` + `siteCertificateArn` context); the default
`*.cloudfront.net` certificate fixes the policy at TLSv1. All roles get `FoundryAscent-Boundary` via
`@aws-cdk/core:permissionsBoundary`. cdk-nag `AwsSolutionsChecks` runs in CI; every acknowledgment is
narrow and carries a written reason.

**AWS access is staged** (ADR-0016, [`infra/iam/README.md`](../../infra/iam/README.md)):

| Stage            | Principal                                                                                                                                                         | Status                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — bootstrap    | IAM user `Foundry-Ascent`, access key in GitHub secrets, post-bootstrap policy `FoundryAscent-BootstrapOperator` (read-only, assume the CDK roles; no IAM writes) | **current**: boundary published, `CDKToolkit` bootstrapped, Data stack deployed (IAM changes are account-owner actions in CloudShell)             |
| 1 — steady state | role `FoundryAscent-GitHubDeploy` via GitHub OIDC (repository secret `AWS_DEPLOY_ROLE_ARN`)                                                                       | after the first full deploy creates Foundation: set the variable, run **Deploy** once, then delete the access key and detach the stage-0 policies |

---

## 11. Quality, security, and evaluation

| Suite                                                                                                                                                                      | Where                                                                                                                                      | Gate                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (contracts, ai validators, risk classifier, authz, orchestrator with mock model)                                                                                      | Vitest (`ci.yml` `quality`)                                                                                                                | CI blocking                                                                                                                                                   |
| DB integration: migrations, RLS (wrong principal → 0 rows for every table), authorization matrix (role × venture × visibility × revoked/expired), memory lifecycle         | Vitest + PostgreSQL 16 + pgvector service (`database`)                                                                                     | CI blocking                                                                                                                                                   |
| Web: component tests; Playwright e2e of the founder journey against API with mock model; axe a11y                                                                          | Vitest/Playwright (`quality`, `e2e`)                                                                                                       | CI blocking                                                                                                                                                   |
| Infra: Lambda bundle checks, `cdk synth` + cdk-nag + snapshot                                                                                                              | CI (`infra`)                                                                                                                               | CI blocking                                                                                                                                                   |
| Python ops tooling and evals harness: `ruff` + offline `pytest` with the toolchain pinned in each project's `requirements-dev.txt`                                         | CI (`python`)                                                                                                                              | CI blocking                                                                                                                                                   |
| Scenario benchmark (40 labelled prompts) and red team (118 cross-venture / injection / identity / policy attacks with per-venture canaries, plus API authorization probes) | `evals/` (Python) against a deployed site (`evals.yml`, manual; `evals` environment secret `FA_OWNER_ACCESS_CODE`, variable `FA_SITE_URL`) | manual workflow; gates from blueprint 01 §9                                                                                                                   |
| Secret scanning (gitleaks 8.30.1, default rules + access-code rule in `.gitleaks.toml`)                                                                                    | `security.yml` on every push and pull request                                                                                              | **blocking** (any finding fails the job)                                                                                                                      |
| Dependency audits (`pnpm audit --prod --audit-level high`, `pip-audit` for `ops/aws` and `evals`)                                                                          | `security.yml` on every push, pull request and weekly                                                                                      | **non-blocking**: high/critical advisories raise a warning annotation and a job summary; triaged weekly                                                       |
| CodeQL (`security-extended`, JavaScript/TypeScript and Python)                                                                                                             | `codeql.yml` on pushes and pull requests to `main`, weekly                                                                                 | **non-blocking** in the workflow: alerts appear under Security → Code scanning; they block merges only if the owner adds a code-scanning merge rule to `main` |

Acceptance gates (blueprint 01 §9): 0 critical cross-venture disclosures; ≥ 90 % memory recall with
100 % source links; ≥ 90 % grounded material claims; ≥ 95 % high-risk escalation recall; no unsupported
high-confidence statements; persona suspension without engineering.

---

## 12. Delivery

- `ci.yml` on every push and pull request; `deploy.yml` on `main` after CI passes (or manually, with an
  optional older main `sha` for a rollback). Deploy uses the stage-0 key until the repository variable
  `AWS_DEPLOY_ROLE_ARN` is set, then GitHub OIDC (stage 1).
- Before `cdk deploy --all`, `deploy.yml` resolves the GitHub OIDC provider: it lists the account's
  providers (`iam:ListOpenIDConnectProviders`; under OIDC, where the deploy role may not list them, it
  uses the provider's fixed ARN, which must exist because STS just accepted a token through it) and
  checks whether `FoundryAscent-Foundation` exists and itself contains an `AWS::IAM::OIDCProvider`. It
  passes `--context githubOidcProviderArn=<arn>` only when a provider exists **and** Foundation does not
  manage it, so first deploys create it, re-deploys keep whichever mode they had, and CloudFormation is
  never asked to delete a provider it manages.
- `deploy.yml`, `platform-deploy-data.yml` and `ops-aws-retire-stage0.yml` share the concurrency group
  `deploy-production`: two CloudFormation deployments never overlap, and the stage-0 key is never retired
  during a deploy that uses it.
- Post-deploy smoke test (`scripts/smoke.mjs`): security headers and SPA on `/`, an immutable asset,
  `/api/v1/health` reporting the deployed commit, a signed `POST /api/v1/auth/sign-in` with an invalid
  code → `401 invalid_access_code` (the first request that touches Aurora: it waits for a resume), the SPA
  deep link, and API errors that stay problem+json.
- Runbooks: [`docs/runbooks/`](../runbooks/) — deploy/rollback, kill switch, incident, access codes,
  cost controls, evals, legacy cleanup, local development.
