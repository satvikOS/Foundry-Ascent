# Foundry Ascent — V1 System Design

Status: **Accepted for V1 build** · Owner: Satvik Sathish Adyanthaya · Source blueprints: [`docs/blueprints/`](../blueprints/)

This document is the single source of truth for the V1 implementation. Where it deviates from the
blueprints, the deviation is recorded as an ADR in [`adr/`](adr/) with its rationale.

---

## 1. Scope

**V1 = a conversation-first coaching product with voice calls** (blueprint 05 §24 "Recommended first
build"; blueprint 03 sprints 1–3 + 6; the owner's acceptance bar of 2026-10-16):

| In V1                                                                                                                                                                                                                                                            | Deferred (seams exist)                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Partner-separated (multi-tenant) venture workspaces, Ain as the first tenant                                                                                                                                                                                     | Avatar vendors (HeyGen LiveAvatar, Anam, Tavus): need an approved vendor and the EIR's `likeness` consent (ADR-0010) |
| vEIR coaches built with consent from fictional EIRs (Corin's vEIR, Ruth's vEIR), plus the neutral **Foundry Guide**; modes auto, diagnose, challenge, coach, teach, rehearse, route                                                                              | A real EIR's likeness or cloned voice: needs signed consent records (ADR-0005)                                       |
| **Knowledge pools** (ADR-0018): a common pool per persona (doctrine and style, knowledge library, published lessons) and a specific pool per venture (approved memory, documents, conversation digests, the vEIR notebook), grown by approval-gated distillation | Full-duplex realtime media (WebRTC or speech-to-speech on long-running compute)                                      |
| Typed, source-linked venture memory with founder approval, correction, supersession, pin, delete                                                                                                                                                                 | SSO (UR / Cognito): the identity provider interface exists                                                           |
| Evidence pack + citations for every substantive answer; fact / inference / hypothesis / recommendation labels                                                                                                                                                    | Offline kit, async review queue                                                                                      |
| Streamed, validated replies (`turn.delta`) and the session contract: diagnosis, evidence, challenge, next actions, escalation                                                                                                                                    | Localization                                                                                                         |
| **Voice calls** (ADR-0010): browser-direct Amazon Transcribe, validated and signed speech units, Amazon Polly, a built-in presence avatar                                                                                                                        | Real venture data (needs University approval, ADR-0006)                                                              |
| Escalation packets (P0–P3) with founder sharing consent, EIR/program inbox                                                                                                                                                                                       |                                                                                                                      |
| Document upload → ingestion → hybrid (vector + full-text) retrieval                                                                                                                                                                                              |                                                                                                                      |
| EIR studio (personas, consent, knowledge library, lessons, releases, calibration reviews), program (portfolio with k-anonymous aggregates, vEIR assignments), admin (access codes, kill switches, daily AI spend caps, audit log, usage)                         |                                                                                                                      |
| Synthetic seed data only (ADR-006)                                                                                                                                                                                                                               |                                                                                                                      |

Non-negotiables carried from the blueprints: amplify never impersonate (persistent synthetic
disclosure), venture-private by default, human authority (suspend without engineering), evidence before
eloquence, memory visible and correctable, escalation is a feature.

---

## 2. Architecture

```
Browser (SPA, Vite + React)                         GitHub Actions (CI/CD, OIDC)
        │ HTTPS                                                │
        ├──wss (presigned)──► Amazon Transcribe streaming      │
        │                     (call speech-to-text)            │
        ▼                                                      ▼
CloudFront ──/*──► S3 site bucket (OAC)              CDK → CloudFormation (boundary-capped roles)
    │
    └──/api/*──► Lambda Function URL (OAC, IAM auth, response streaming)
                     │  apps/api (Hono) ─ packages/core ─ packages/ai ─ packages/db
                     │
                     ├── RDS Data API ──► Aurora Serverless v2 PostgreSQL 16.13 (pgvector, FTS, RLS)
                     │                      min 0.5 ACU (kept awake) · max 2 ACU · isolated subnets
                     ├── Bedrock Runtime ──► us.amazon.nova-2-lite-v1:0     (primary reasoning)
                     │                   ├─► global.amazon.nova-2-lite-v1:0 (fallback reasoning)
                     │                   └─► amazon.titan-embed-text-v2:0   (embeddings, 1024-d)
                     ├╌╌ Bedrock Mantle  ╌╌► openai.gpt-6-luna  (gated by AWS for this account;
                     │                       disabled: models.luna.enabled = false, see §7)
                     ├── Amazon Polly ──► call speech (neural voices, validated text only)
                     ├── S3 documents bucket (presigned PUT, venture-scoped keys)
                     └── SQS jobs queue ──► worker Lambda (ingestion, embeddings, distillation,
                                            daily maintenance) ──► DLQ
```

- **Region:** `us-east-1` (Luna on Mantle is offered only there; Nova 2 Lite and Titan run there too).
- **No VPC for Lambdas, no NAT, no customer KMS keys** — Data API reaches Aurora; the Aurora cluster
  lives in a VPC with isolated subnets only (zero hourly cost). Encryption at rest uses AWS-managed keys.
- **Idle cost target:** ≈ $45–47/month: Aurora kept awake at 0.5 ACU (≈ $44, so no request waits for a
  resume; see the [latency runbook](../runbooks/latency.md)), plus Aurora storage, one Secrets Manager
  secret, S3 and logs (≈ $1–3). With `aurora.minCapacityAcu: 0` Aurora compute is $0 while paused (auto-pause
  after 10 idle minutes), and the first database request after a pause waits ~15 s while Aurora resumes: the API waits up to 40 s, then answers `503 database_resuming` with
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
- **Commits:** imperative subject, why-focused body; `main` deploys only after CI passes on it.

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
'suspended'`), per assignment, checked on session create **and** every turn; `calls_enabled` (new calls
   refused, live calls end at the next heartbeat) and `streaming_enabled` (whole replies instead of
   streamed sentences).

---

## 5. Data model

Authoritative DDL: [`packages/db/migrations/`](../../packages/db/migrations/). Summary:

| Table                                                             | Purpose                                                                                                                             | Key columns                                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenants`                                                         | Ain (home) and partner universities                                                                                                 | `slug`, `kind`, `status`                                                                                                                                                                                                          |
| `principals`                                                      | people                                                                                                                              | `tenant_id`, `display_name`, `email?`, `title`, `synthetic`                                                                                                                                                                       |
| `role_grants`                                                     | tenant/platform roles                                                                                                               | `principal_id`, `tenant_id?`, `role`, `revoked_at`                                                                                                                                                                                |
| `access_codes`, `auth_sessions`, `auth_attempts`, `platform_keys` | credentials and sessions                                                                                                            | hashes only                                                                                                                                                                                                                       |
| `ventures`                                                        | venture workspace                                                                                                                   | `tenant_id`, `name`, `one_liner`, `stage`, `domain`, `cohort`, `classification`, `status`                                                                                                                                         |
| `venture_memberships`                                             | founders/team/advisors                                                                                                              | `role`, `expires_at`, `revoked_at`                                                                                                                                                                                                |
| `eir_profiles`                                                    | expertise registry (candidate metadata, not authority)                                                                              | `display_name`, `title`, `expertise_tags`, `bio`, `synthetic`, `principal_id?` (one profile per person; program leads and platform admins add and edit them)                                                                      |
| `personas`, `persona_releases`                                    | Foundry Guide and the vEIRs built from EIR profiles; versioned doctrine/style/disclosure; embodiment (voice, portrait)              | `status` (`draft/active/suspended/retired`), `doctrine`, `style`, `allowed_modes`, `embodiment`                                                                                                                                   |
| `consents`                                                        | likeness/voice/doctrine consent records                                                                                             | `asset_types`, `approved_uses`, `revoked_at`                                                                                                                                                                                      |
| `assignments`                                                     | venture ↔ persona release ↔ EIR (server-resolved every session)                                                                     | `allowed_modes`, `data_class_ceiling`, `status`, `expires_at`                                                                                                                                                                     |
| `knowledge_sources`, `knowledge_chunks`                           | program/public/persona/venture corpus (the persona library is the common pool); chunks with `embedding vector(1024)` + `tsv`        | `scope`, `kind`, `classification`, `freshness_at`                                                                                                                                                                                 |
| `documents`                                                       | uploaded venture files → ingestion                                                                                                  | `s3_key`, `status`, `source_id`                                                                                                                                                                                                   |
| `memory_objects`                                                  | typed venture memory (fact, hypothesis, decision, experiment, evidence, action, milestone, risk, preference, relationship, insight) | `status` (`proposed/confirmed/disputed/superseded/expired/deleted`), `visibility`, `confidence`, `source_refs`, `attributes`, `supersedes_id`, `pinned`, `embedding`, `tsv`                                                       |
| `memory_events`                                                   | correction history (append-only)                                                                                                    | `action`, `diff`, `actor`                                                                                                                                                                                                         |
| `coaching_sessions`, `turns`, `turn_evidence`                     | conversations (title, digest), structured responses, evidence links                                                                 | `mode`, `privacy`, `digest`, `distill_version`, `response`, `channel` (`text`/`voice`), `risk_label`, `validator_results`, `model_id`, tokens, `cost_usd`, `latency_ms`; evidence: `source_id`, `source_scope` of a cited passage |
| `veir_notebooks`                                                  | what a vEIR keeps about one venture (AI notes: visible, correctable, never cited)                                                   | `content` (`summary`, `founderProfile`, `commitments`, `openQuestions`, `lastAdvice`, `nextOpener`), `suppressed`, `version`                                                                                                      |
| `calls`                                                           | voice calls of a conversation (ADR-0010; no audio)                                                                                  | `status`, `input_mode`, `max_seconds`, `end_reason`                                                                                                                                                                               |
| `escalations`                                                     | human handoff packets                                                                                                               | `category`, `priority` P0–P3, `status`, `packet`, `sharing_consent_at`, `assignee_principal_id`                                                                                                                                   |
| `feedback`                                                        | founder ratings; `eir_reviews` — blind rubric scores                                                                                |                                                                                                                                                                                                                                   |
| `resources`                                                       | Ain program resource graph for **route** mode                                                                                       | `kind`, `tags`, `eligibility`, `url`, `freshness_at`                                                                                                                                                                              |
| `patterns`                                                        | de-identified lessons; drafts from distillation, published by a curator                                                             | `persona_id` (null = program-wide), `origin`, `status`, `expires_at`                                                                                                                                                              |
| `usage_ledger`                                                    | per-call model usage and cost (day, model, principal, venture)                                                                      |                                                                                                                                                                                                                                   |
| `audit_events`                                                    | append-only, hash-chained (`prev_hash`, `hash`) security/policy/admin/content events                                                | metadata only                                                                                                                                                                                                                     |
| `platform_settings`                                               | kill switch, spend caps, thresholds                                                                                                 |                                                                                                                                                                                                                                   |
| `idempotency_keys`                                                | write de-duplication                                                                                                                |                                                                                                                                                                                                                                   |

---

## 6. API (`/api/v1`, JSON, problem+json errors)

Schemas live in `packages/contracts/src/api.ts`; the web client and the server import the same types.
Every response carries `x-request-id`. `503 database_resuming`, `429 locked_out` and `429 rate_limited`
carry `Retry-After` (and `retryAfterSeconds` in the problem document).

| Area                         | Endpoints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health                       | `GET /health` (public liveness: `status`, `version` = deployed commit, optional `db` = the state this instance last observed on real requests; **never queries the database**, so polling it cannot keep Aurora awake) · `GET /admin/health` (platform admin: probes the database)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Auth                         | `POST /auth/sign-in`, `POST /auth/sign-out`, `GET /me`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Ventures                     | `GET /ventures`, `GET /ventures/:id`, `PATCH /ventures/:id`, `GET /ventures/:id/overview` (since-last-session brief)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Conversations                | `POST /ventures/:id/sessions` (stores the notebook opener), `GET /ventures/:id/sessions`, `GET /sessions` (recents across ventures), `GET/PATCH/DELETE /sessions/:id`, `DELETE /sessions/:id/digest`, `POST /sessions/:id/turns` (**SSE**), `POST /sessions/:id/end` (recap + memory candidates), `POST /turns/:id/feedback`, `GET /turns/:id/evidence`                                                                                                                                                                                                                                                                                                                                                         |
| vEIR                         | `GET /ventures/:id/veir`, `GET/PATCH /ventures/:id/notebook` (versioned edits), `GET /ventures/:id/call-config`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Calls ([calls.md](calls.md)) | `POST /sessions/:id/calls`, `GET /calls/:id`, `POST /calls/:id/stt-grant`, `POST /calls/:id/heartbeat`, `POST /calls/:id/end`, `POST /turns/:id/interrupt`, `POST /speech` (signed units or the stored validated reply → `audio/mpeg`), `POST /calls/avatar-session` (reserved for vendor tokens)                                                                                                                                                                                                                                                                                                                                                                                                               |
| Memory                       | `GET /ventures/:id/memory?type&status&q&pinned`, `POST /ventures/:id/memory`, `POST /ventures/:id/memory/batch` (approve/reject), `GET /memory/:id`, `PATCH /memory/:id` (`approve/reject/correct/dispute/pin/unpin/delete`), `GET /memory/:id/history`                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Documents                    | `POST /ventures/:id/documents` (presigned upload), `POST /documents/:id/complete`, `POST /documents/:id/upload` (retry), `POST /documents/:id/abandon`, `GET /ventures/:id/documents`, `DELETE /documents/:id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Escalations                  | `GET /ventures/:id/escalations`, `POST /ventures/:id/escalations`, `PATCH /escalations/:id` (founder: `approve_sharing/edit/withdraw`; assignee: `acknowledge/resolve/decline`), `GET /inbox/escalations`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Team                         | `GET /ventures/:id/team`, `POST /ventures/:id/team/invitations` (program lead → returns one-time access code)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| EIR studio                   | `GET/POST /personas`, `GET /personas/:id`, `POST /personas/:id/releases`, `GET /persona-releases/:id` (drafts for program leads, platform admins and the linked EIR), `POST /persona-releases/:id/approve`, `POST /personas/:id/suspend`, `POST /personas/:id/resume`, `GET/POST /personas/:id/consents`, `POST /consents/:id/revoke`, `GET/PATCH /personas/:id/embodiment`, `GET/POST /personas/:id/knowledge` (+ `uploads`, `:sourceId/complete`, `PATCH/DELETE :sourceId`), `GET/POST /personas/:id/lessons`, `POST /lessons/:id/actions`, `GET /lessons` (the curator's queue), `GET/POST /eir/profiles`, `PATCH /eir/profiles/:id`, `GET /eir/candidates`, `GET /eir/reviews`, `POST /eir/reviews/:turnId` |
| Program                      | `GET /program/portfolio`, `GET/POST/PATCH /program/resources`, `GET/POST /program/ventures`, `PATCH /program/ventures/:id`, `POST /ventures/:id/assignment` (assign a vEIR), `GET /program/escalations` (metadata queue), `GET /program/assignees` (active EIRs and program leads of the tenant), `POST /program/escalations/:id/route`                                                                                                                                                                                                                                                                                                                                                                         |
| Admin                        | `GET/POST /admin/principals`, `POST /admin/principals/:id/access-codes`, `DELETE /admin/access-codes/:id`, `GET/PATCH /admin/settings`, `GET /admin/audit`, `GET /admin/usage`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### 6.1 Turn streaming (SSE)

`POST /sessions/:id/turns {text, mode?, channel?, callId?}` responds `text/event-stream` with events:
`turn.accepted` → `turn.status` (`classifying`, `retrieving` + counts, `reasoning`, `validating`) →
`turn.delta` (each validated sentence of the answer, while `streaming_enabled`) and, on the voice
channel, `turn.speech` (signed units to speak) → `turn.completed` (full `CoachResponse` + evidence
summaries + usage; authoritative) or `turn.blocked` / `turn.error` (problem+json). Each event is one
`event: <name>` line plus one JSON `data:` line.
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
   immediate human-support response (no model call) + P1 escalation draft, whatever the rate, in-flight,
   session-turn and spend limits (crisis turns still count towards the per-principal rate limit).
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

**Enabling Luna later** is a reviewed config change, not code: (1) probe GPT-6 Luna with
`apps/api/src/scripts/bedrock-probe.ts` and credentials allowed to invoke it (ADR-0014); (2) run the evals workflow to record a
Nova baseline; (3) open a PR that sets `models.luna.enabled` to `true` (CDK then grants
`bedrock-mantle:CreateInference` and maps the model ids as above); (4) merge, let **Deploy** ship it, and
re-run the evals. Flipping the flag back is the rollback.

**Session end**: recap = the five session-contract objects (diagnosis, evidence, challenge, next
actions, escalation) + memory candidates; ephemeral sessions keep no memory beyond security records.
**Distillation** (ADR-0018, [knowledge pools](knowledge-pools.md)) then writes the conversation's digest,
the notebook delta and deduplicated memory and lesson candidates, from a job the API enqueues after each
turn (delayed 9 minutes) and at session end.

---

## 8. Ingestion and retrieval

Upload: client requests a presigned PUT (≤ 10 MB; PDF, DOCX, TXT, MD) → `tenants/{t}/ventures/{v}/documents/{id}/{filename}` →
`/complete` enqueues an SQS job → worker extracts text (`unpdf` for PDF, `mammoth` for DOCX), chunks
(~800 tokens, 15 % overlap, heading-aware), embeds (Titan, batched), stores `knowledge_chunks` with
`scope='venture'`, updates status. Failures go to the DLQ and the document shows `failed` with a
retry action. An upload that never completes does not stay "Uploading": a cancelled one is deleted, a failed
or left one is marked `failed` with `upload_incomplete` (`POST /documents/:id/abandon`, or daily maintenance
an hour after its presigned URL expired), and a retry asks `POST /documents/:id/upload` for a fresh URL to the
same document instead of registering another. Persona library uploads take the same path into `scope='persona'` (job
`ingest_knowledge_source`); authored notes, cases, FAQs and transcripts are chunked on save. Retrieval and
the knowledge pools are specified in [knowledge pools](knowledge-pools.md).

---

## 9. Web application

**Stack:** Vite 8, React 19, TypeScript, TanStack Router (file-based, type-safe params/search),
TanStack Query, Tailwind CSS 4, shadcn/ui (Radix primitives), lucide-react, cmdk (⌘K), sonner,
react-hook-form + zod, motion (respecting `prefers-reduced-motion`). Portfolio and usage charts are plain
HTML/CSS (labelled bars, a table view, k-anonymous counts shown as "Fewer than k"), not a chart library.

**Routes** (blueprint 05 convention `/[partner]/app/…`; layout per ADR-0019):

```
/                                  public landing (product promise, disclosure, sign in)
/sign-in
/$tenant/app                       → the person's last venture (new chat) or their staff workspace
/$tenant/app/v/$ventureId          new chat: the vEIR's face, a greeting from the notebook opener, suggestions
    c/$sessionId                   a conversation
                                   (?call=1 on either opens the call screen over the page)
    knowledge                      memory, decisions, experiments, milestones, evidence, notebook, digests
    documents | help | team | settings
/$tenant/app/eir/                  personas | personas/$personaId | reviews | inbox
/$tenant/app/program/              portfolio | ventures | resources | escalations
/$tenant/app/admin/                principals (people and access codes) | settings | usage | audit
```

Routes from before ADR-0019 redirect: `/$tenant/app/ventures/$ventureId/<section>` to the section's new
home, and `/admin/<section>` to `/$tenant/app/admin/<section>`.

**Shell** (ADR-0019; blueprint 02 §4A): one layout for every role. A collapsible left sidebar (a sheet on
mobile) holds the workspace or venture switcher, **New chat** and **Call {vEIR}**, search (⌘K), recent
conversations (calls marked), the venture destinations (Knowledge, Documents, Human help, Team) and the
account menu (theme, shortcuts, workspaces by role, the tenant's synthetic-data notice, sign out). Staff
workspaces (EIR studio, Program, Admin) swap the sidebar sections. The conversation is one centred column
with the composer at the bottom; a context panel (Sources, Notebook, To review, Human help) is closed by
default. Calls open a full-viewport call screen from the sidebar, the conversation header, the composer
and the new-chat home. There is no global top bar or venture tab strip; the database-waking banner shows
only while the database wakes.

**Visual system:** the colour tokens in `apps/web/src/styles/globals.css` (dark-first, muted black and grey
with a matching light theme); self-hosted fonts: Geist for the interface, Newsreader for display headings
and vEIR prose, Geist Mono for labels and data; 4-pt spacing grid; one motion grammar honouring reduced
motion; status = label + icon + shape (never colour alone); WCAG 2.2 AA; full keyboard path, visible
focus, skip links, landmarks.

**Persistent disclosure:** one line (`role="note"`, accessible name "AI disclosure") in every conversation
view, every call and every export, from the persona release, for example: "You are talking with Corin's
vEIR, an AI coach built from Corin Halvorsen's approved frameworks and coaching style. It is not a person,
and no human EIR, including Corin, wrote or approved these responses."

---

## 10. Infrastructure (CDK, `infra/cdk`)

Stacks (all `FoundryAscent-*`, termination protection on Foundation and Data, tags
`project=foundry-ascent`). Details and every number: [`infra/cdk/README.md`](../../infra/cdk/README.md).

1. **Foundation** — GitHub OIDC provider for `token.actions.githubusercontent.com`
   (`iam.OidcProviderNative`, CloudFormation type `AWS::IAM::OIDCProvider`; an account holds one per URL,
   so context `githubOidcProviderArn` imports an existing provider instead) and the
   `FoundryAscent-GitHubDeploy` role (trust: exactly `repo:satvikOS@228056784/Foundry-Ascent@1356439229:environment:production`
   and `aud sts.amazonaws.com`; 1 h sessions; can assume the four CDK CLI bootstrap roles and read
   CloudFormation/Logs/Cost Explorer). `deploy.yml` decides create / keep / import on every run (§12).
2. **Data** — VPC (2 AZ, isolated subnets only, no IGW/NAT), Aurora Serverless v2 PostgreSQL 16.13
   (cluster `foundry-ascent`, `serverlessV2MinCapacity: 0.5`, `serverlessV2MaxCapacity: 2`, auto-pause
   10 min only at a minimum of 0, Data API on, deletion protection, storage encrypted with the AWS-managed key, 7-day backups,
   log export to `/aws/rds/cluster/foundry-ascent/postgresql`), generated admin secret
   `foundry-ascent/aurora-admin`, documents bucket (private, SSE-S3, enforce SSL, CORS `PUT` from
   `https://*.cloudfront.net` plus the custom domain when set — the presigned URL is the authorization,
   lifecycle for incomplete uploads), SQS jobs queue + DLQ (SSE-SQS).
3. **App** — API Lambda (Node 24, ARM64, 1024 MB, 60 s, no reserved concurrency in production — see §2,
   Function URL `AWS_IAM` + `RESPONSE_STREAM`), worker Lambda (SQS, batch 5, at most 2 concurrent pollers), migrate custom resource
   (applies `packages/db/migrations` via Data API with an advisory lock, then seeds synthetic data and the
   owner principal, then backfills embeddings; API, worker and site wait for it), site bucket + two
   `BucketDeployment`s (immutable `assets/*`, revalidated `index.html`), CloudFront (OAC to S3 and to the
   Function URL, `/api/*` uncached with `ALL_VIEWER_EXCEPT_HOST_HEADER` and a viewer-request function that
   sets `x-fa-viewer-ip` and `x-fa-viewer-host`, SPA rewrite CloudFront Function, security headers policy
   with CSP, HSTS, frame-ancestors none, `Permissions-Policy` with the microphone for this origin only),
   the API role's Polly and Transcribe-streaming grants for calls, EventBridge Scheduler schedules (daily
   maintenance; a distillation sweep shipped disabled), log retention 30 days, alarms (API
   errors/throttles, worker errors, DLQ depth, CloudFront 5xx rate, Polly characters per hour and per
   day) to the SNS topic `FoundryAscent-Alarms`.

The API has no `SITE_ORIGIN` unless a custom domain is configured (the distribution domain would create a
stack cycle); it builds the origin from `x-fa-viewer-host`. TLS 1.2 as the minimum viewer protocol needs a
custom domain and ACM certificate (`siteDomainName` + `siteCertificateArn` context); the default
`*.cloudfront.net` certificate fixes the policy at TLSv1. All roles get `FoundryAscent-Boundary` via
`@aws-cdk/core:permissionsBoundary`. cdk-nag `AwsSolutionsChecks` runs in CI; every acknowledgment is
narrow and carries a written reason.

**AWS access is staged** (ADR-0016, [`infra/iam/README.md`](../../infra/iam/README.md)). Stage 1 is
current: every deploy assumes `FoundryAscent-GitHubDeploy` through GitHub OIDC (trust limited to the
`production` environment; repository secret `AWS_DEPLOY_ROLE_ARN`). The stage-0 IAM user `Foundry-Ascent`
has no access key since 2026-10-06, so the workflows that used it no longer run.

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
  optional older main `sha` for a rollback), through GitHub OIDC (stage 1).
- Before `cdk deploy --all`, `deploy.yml` resolves the GitHub OIDC provider: it lists the account's
  providers (`iam:ListOpenIDConnectProviders`; under OIDC, where the deploy role may not list them, it
  uses the provider's fixed ARN, which must exist because STS just accepted a token through it) and
  checks whether `FoundryAscent-Foundation` exists and itself contains an `AWS::IAM::OIDCProvider`. It
  passes `--context githubOidcProviderArn=<arn>` only when a provider exists **and** Foundation does not
  manage it, so first deploys create it, re-deploys keep whichever mode they had, and CloudFormation is
  never asked to delete a provider it manages.
- `deploy.yml` runs in the concurrency group `deploy-production`, so two deployments never overlap. The
  stage-0 workflows are retired: each stops at its first step with an explanation.
- Post-deploy smoke test (`scripts/smoke.mjs`): security headers (including the voice-call
  Permissions-Policy, `media-src` and `connect-src`) and SPA on `/`, an immutable asset,
  `/api/v1/health` reporting the deployed commit, a signed `POST /api/v1/auth/sign-in` with an invalid
  code → `401 invalid_access_code` (the first request that touches Aurora: it waits for a resume), the SPA
  deep link, and API errors that stay problem+json.
- Runbooks: [`docs/runbooks/`](../runbooks/): deploy and rollback, kill switch, incident response,
  access codes, cost controls, evals, owner actions, local development.
