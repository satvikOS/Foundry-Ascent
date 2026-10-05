# Foundry Ascent — V1 System Design

Status: **Accepted for V1 build** · Owner: Satvik Sathish Adyanthaya · Source blueprints: [`docs/blueprints/`](../blueprints/)

This document is the single source of truth for the V1 implementation. Where it deviates from the
blueprints, the deviation is recorded as an ADR in [`adr/`](adr/) with its rationale.

---

## 1. Scope

**V1 = text-first core** (blueprint 05 §24 "Recommended first build"; blueprint 03 sprints 1–3 + 6):

| In V1 | Deferred (adapter interfaces exist) |
| --- | --- |
| Partner-separated (multi-tenant) venture workspaces, Ain as the first tenant | Realtime voice (ASR/TTS, barge-in) — Rust/WebRTC gateway per blueprint 05 |
| Neutral **Foundry Guide** coach (no real EIR identity) with six modes: diagnose, challenge, coach, teach, rehearse, route | Avatar embodiment (HeyGen LiveAvatar / Azure) — needs vendor + consent |
| Typed, source-linked venture memory with founder approval, correction, supersession, pin, delete | Real EIR personas (persona studio supports drafts; release requires consent record) |
| Evidence pack + citations for every substantive answer; fact / inference / hypothesis / recommendation labels | SSO (UR / Cognito) — identity provider interface exists |
| Session contract: diagnosis, evidence, challenge, next actions, escalation | Offline kit, async review queue |
| Escalation packets (P0–P3) with founder sharing consent, EIR/program inbox | Pattern publication workflow (table + read path only) |
| Document upload → ingestion → hybrid (vector + full-text) retrieval | Localization |
| EIR studio (persona releases, suspend/resume, calibration reviews), program portfolio (k-anonymous aggregates), admin (access codes, kill switch, daily AI spend caps, audit log, usage) | |
| Synthetic seed data only (ADR-006) | Real venture data (needs University approval) |

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
                     ├── RDS Data API ──► Aurora Serverless v2 PostgreSQL 16 (pgvector, FTS, RLS)
                     │                      min 0 ACU (auto-pause) · max 2 ACU · isolated subnets
                     ├── Bedrock Mantle  ──► openai.gpt-6-luna      (primary reasoning)
                     ├── Bedrock Runtime ──► amazon.nova-2-lite-v1:0 (fallback reasoning)
                     │                   └─► amazon.titan-embed-text-v2:0 (embeddings, 1024-d)
                     ├── S3 documents bucket (presigned PUT, venture-scoped keys)
                     └── SQS jobs queue ──► worker Lambda (ingestion, recap, consolidation) ──► DLQ
```

* **Region:** `us-east-1` (Luna on Mantle is us-east-1 only).
* **No VPC for Lambdas, no NAT, no customer KMS keys** — Data API reaches Aurora; the Aurora cluster
  lives in a VPC with isolated subnets only (zero hourly cost). Encryption at rest uses AWS-managed keys.
* **Idle cost target:** ≈ $1–3/month (Aurora storage, one Secrets Manager secret, S3, logs). Aurora
  compute is $0 while paused; first request after idle waits ~15 s (UI shows "Waking your workspace").
* **Cost guardrails:** permissions boundary denies cost hazards; per-day AI spend caps in the database;
  Lambda reserved concurrency; CloudWatch alarms.

---

## 3. Repository layout and engineering standards

```
apps/
  api/            Hono app, Lambda handlers (api, worker, migrate), local dev server
  web/            Vite + React 19 SPA
packages/
  contracts/      Zod schemas: domain, API DTOs, AI response contract, error codes (single source of types)
  db/             SQL migrations, SqlExecutor (Data API + node-postgres), request context, repositories
  ai/             Model gateway (Luna, Nova, Titan, mock), prompts, risk classifier, validators
  core/           Domain services: authz, sessions/orchestrator, memory, retrieval, escalation, usage, audit
infra/
  cdk/            AWS CDK v2 app (TypeScript)
  iam/            Stage-0 policies and permissions boundary
evals/            Python 3.12: scenario benchmark, red-team suite, report
ops/aws/          Python ops tooling (inventory, verify access, cleanup, policy upsert)
docs/             Architecture, ADRs, runbooks, blueprints
```

* **Package manager:** pnpm 10 workspaces. **Node** 24 (Lambda `nodejs24.x`, ARM64); local ≥ 22.
* **TypeScript 5.9**, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes: false`,
  ESM everywhere (`"type": "module"`), `moduleResolution: "Bundler"`. Internal packages are consumed as
  TypeScript source (`"exports": { ".": "./src/index.ts" }`); esbuild/Vite/Vitest compile them.
* **Lint/format:** ESLint 9 flat config + typescript-eslint (strict-type-checked where practical),
  Prettier 3. **Tests:** Vitest; DB integration tests against real PostgreSQL 16 + pgvector
  (`DATABASE_URL`); Playwright + axe for web e2e/a11y.
* **Validation at every boundary** with Zod (`packages/contracts`). No `any` in public APIs.
* **Logging:** structured JSON, one line per event, request ID on every line, **never raw prompts,
  answers, documents, or memory content** in general logs (blueprint 03 §8). Content lives only in the
  database under RLS.
* **Errors:** RFC 9457 problem+json (`type`, `title`, `status`, `detail`, `code`, `requestId`).
* **Idempotency:** every write endpoint honours `Idempotency-Key` (stored with a 24 h window).
* **Commits:** imperative subject, why-focused body; main is protected by CI.

---

## 4. Identity, authentication, authorization

### 4.1 Identity (ADR-013 — no Cognito in V1)

* **Principals** are people (founders, EIRs, program staff, admins). Each belongs to one tenant.
* **Access codes** are the V1 credential: 100-bit random codes (`FA-XXXXX-XXXXX-XXXXX-XXXXX`,
  Crockford base32), stored only as `scrypt` hashes (`N=2^15, r=8, p=1`, 16-byte salt). Issued by an
  admin/program lead to a principal, shown **once**, revocable, optional expiry, `last_used_at`.
* The **owner code** hash is passed at deploy (`OWNER_ACCESS_CODE_HASH`); the seed binds it to the
  owner principal (`platform_admin` + `program_lead` in the home tenant). The plaintext code is given to
  the owner privately, never committed.
* **Sign-in** `POST /api/v1/auth/sign-in {accessCode}` → constant-time verify → creates an
  `auth_sessions` row → sets cookie `fa_session` (JWT HS256, 12 h, claims `sub`, `sid`, `tid`, `iat`,
  `exp`; `HttpOnly; Secure; SameSite=Strict; Path=/api`). Signing key: 32 random bytes generated by
  migration into `platform_keys` (rotatable). Sessions are revocable (checked with a 60 s cache).
* **Brute-force protection:** per viewer-IP (hashed) and global sliding windows in `auth_attempts`;
  10 failures / 15 min / IP → 15 min lockout; uniform error message and timing.
* **CSRF:** SameSite=Strict + mandatory `X-Requested-With: foundry-ascent` on non-GET requests.
* **CloudFront → Lambda OAC:** browsers must send `x-amz-content-sha256` (hex SHA-256 of the body) on
  POST/PUT/PATCH/DELETE; the web API client computes it with WebCrypto.
* `IdentityProvider` interface (`accessCode` now; `oidc` later) keeps authorization code untouched when
  SSO arrives.

### 4.2 Roles

| Role | Scope | Can | Cannot |
| --- | --- | --- | --- |
| `platform_admin` | platform | principals, access codes, settings, kill switch, usage, audit metadata | read venture content unless also a member |
| `program_lead` | tenant | enrol ventures, invite principals, resources, portfolio aggregates (k ≥ 3), escalation queue (category/priority/status), suspend personas | raw transcripts/memory unless member or packet shared |
| `eir` | tenant | persona studio for linked personas, calibration reviews of **assigned** ventures' sampled turns, escalations assigned to them (shared packet fields) | ventures without an active assignment |
| venture `founder` / `team` | venture | full workspace incl. `founder_private` items they authored | other ventures |
| venture `advisor` | venture | items with visibility `venture`/`advisors` | `founder_private`, `team` items |

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

| Table | Purpose | Key columns |
| --- | --- | --- |
| `tenants` | Ain (home) and partner universities | `slug`, `kind`, `status` |
| `principals` | people | `tenant_id`, `display_name`, `email?`, `title`, `synthetic` |
| `role_grants` | tenant/platform roles | `principal_id`, `tenant_id?`, `role`, `revoked_at` |
| `access_codes`, `auth_sessions`, `auth_attempts`, `platform_keys` | credentials and sessions | hashes only |
| `ventures` | venture workspace | `tenant_id`, `name`, `one_liner`, `stage`, `domain`, `cohort`, `classification`, `status` |
| `venture_memberships` | founders/team/advisors | `role`, `expires_at`, `revoked_at` |
| `eir_profiles` | expertise registry (candidate metadata, not authority) | `display_name`, `expertise_tags`, `synthetic`, `principal_id?` |
| `personas`, `persona_releases` | Foundry Guide + future EIR personas; versioned doctrine/style/disclosure | `status` (`draft/active/suspended/retired`), `doctrine`, `style`, `allowed_modes` |
| `consents` | likeness/voice/doctrine consent records | `asset_types`, `approved_uses`, `revoked_at` |
| `assignments` | venture ↔ persona release ↔ EIR (server-resolved every session) | `allowed_modes`, `data_class_ceiling`, `status`, `expires_at` |
| `knowledge_sources`, `knowledge_chunks` | program/public/persona/venture corpus; chunks with `embedding vector(1024)` + `tsv` | `scope`, `classification`, `freshness_at` |
| `documents` | uploaded venture files → ingestion | `s3_key`, `status`, `source_id` |
| `memory_objects` | typed venture memory (fact, hypothesis, decision, experiment, evidence, action, milestone, risk, preference, relationship, insight) | `status` (`proposed/confirmed/disputed/superseded/expired/deleted`), `visibility`, `confidence`, `source_refs`, `attributes`, `supersedes_id`, `pinned`, `embedding`, `tsv` |
| `memory_events` | correction history (append-only) | `action`, `diff`, `actor` |
| `coaching_sessions`, `turns`, `turn_evidence` | sessions, structured responses, evidence links | `mode`, `privacy`, `response`, `risk_label`, `validator_results`, `model_id`, tokens, `cost_usd`, `latency_ms` |
| `escalations` | human handoff packets | `category`, `priority` P0–P3, `status`, `packet`, `sharing_consent_at`, `assignee_principal_id` |
| `feedback` | founder ratings; `eir_reviews` — blind rubric scores | |
| `resources` | Ain program resource graph for **route** mode | `kind`, `tags`, `eligibility`, `url`, `freshness_at` |
| `patterns` | reviewed, de-identified lessons (read path only in V1) | `status`, `expires_at` |
| `usage_ledger` | per-call model usage and cost (day, model, principal, venture) | |
| `audit_events` | append-only, hash-chained (`prev_hash`, `hash`) security/policy/admin/content events | metadata only |
| `platform_settings` | kill switch, spend caps, thresholds | |
| `idempotency_keys` | write de-duplication | |

---

## 6. API (`/api/v1`, JSON, problem+json errors)

Schemas live in `packages/contracts/src/api.ts`; the web client and the server import the same types.

| Area | Endpoints |
| --- | --- |
| Health | `GET /health` (public: status, version, `db: awake/resuming`) |
| Auth | `POST /auth/sign-in`, `POST /auth/sign-out`, `GET /me` |
| Ventures | `GET /ventures`, `GET /ventures/:id`, `PATCH /ventures/:id`, `GET /ventures/:id/overview` (since-last-session brief) |
| Sessions | `POST /ventures/:id/sessions`, `GET /ventures/:id/sessions`, `GET /sessions/:id`, `POST /sessions/:id/turns` (**SSE**), `POST /sessions/:id/end` (recap + memory candidates), `POST /turns/:id/feedback`, `GET /turns/:id/evidence` |
| Memory | `GET /ventures/:id/memory?type&status&q`, `POST /ventures/:id/memory`, `PATCH /memory/:id` (`approve/reject/correct/pin/unpin/delete`), `GET /memory/:id/history` |
| Documents | `POST /ventures/:id/documents` (presigned upload), `POST /documents/:id/complete`, `GET /ventures/:id/documents`, `DELETE /documents/:id` |
| Escalations | `GET /ventures/:id/escalations`, `POST /ventures/:id/escalations`, `PATCH /escalations/:id` (founder: `approve_sharing/edit/withdraw`; assignee: `acknowledge/resolve/decline`), `GET /inbox/escalations` |
| Team | `GET /ventures/:id/team`, `POST /ventures/:id/team/invitations` (program lead/admin → returns one-time access code) |
| EIR studio | `GET /personas`, `GET /personas/:id`, `POST /personas/:id/releases`, `POST /persona-releases/:id/approve`, `POST /personas/:id/suspend`, `POST /personas/:id/resume`, `GET /eir/reviews`, `POST /eir/reviews/:turnId` |
| Program | `GET /program/portfolio`, `GET/POST/PATCH /program/resources`, `GET /program/ventures`, `POST /program/ventures` |
| Admin | `GET/POST /admin/principals`, `POST /admin/principals/:id/access-codes`, `DELETE /admin/access-codes/:id`, `GET/PATCH /admin/settings`, `GET /admin/audit`, `GET /admin/usage` |

### 6.1 Turn streaming (SSE)

`POST /sessions/:id/turns {text, mode?}` responds `text/event-stream` with events:
`turn.accepted` → `turn.status` (`classifying`, `retrieving` + counts, `reasoning`, `validating`) →
`turn.completed` (full `CoachResponse` + evidence summaries + usage) or `turn.blocked` /
`turn.error` (problem+json). Clients render progress steps; text-only, keyboard-only, and
screen-reader paths are first-class (`aria-live="polite"`).

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
   mode instructions, policy rules, evidence pack (content wrapped as *data*, never instructions),
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

**Model routing (packages/ai):** primary `openai.gpt-6-luna` (Mantle Chat Completions, SigV4,
`response_format: json_schema strict`), 25 s timeout, one repair retry on invalid JSON; fallback
`amazon.nova-2-lite-v1:0` (Converse with a single forced tool whose input schema is the response
schema); embeddings `amazon.titan-embed-text-v2:0` (1024-d, normalized). `MODEL_PROVIDER=mock` gives a
deterministic provider for tests and offline dev. Per-model prices are configuration; every call writes
`usage_ledger`.

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
react-hook-form + zod, motion (respecting `prefers-reduced-motion`), Recharts for portfolio charts.

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

Stacks (all `FoundryAscent-*`, termination protection on stateful ones, tags `project=foundry-ascent`):

1. **Foundation** — GitHub OIDC provider (`OidcProviderNative`) and `FoundryAscent-GitHubDeploy` role
   (trust: `repo:satvikOS/Foundry-Ascent:ref:refs/heads/main` and `:environment:production`; can assume
   `cdk-hnb659fds-*` roles and read CloudFormation/Logs/Cost Explorer).
2. **Data** — VPC (2 AZ, isolated subnets only, no IGW/NAT), Aurora Serverless v2 PostgreSQL 16.13
   (`serverlessV2MinCapacity: 0`, `serverlessV2MaxCapacity: 2`, auto-pause 10 min, Data API on,
   deletion protection, storage encrypted with the AWS-managed key, 7-day backups), generated admin
   secret `foundry-ascent/aurora-admin`, documents bucket (private, SSE-S3, enforce SSL, CORS for the
   site origin, lifecycle for incomplete uploads), SQS jobs queue + DLQ (SSE-SQS).
3. **App** — API Lambda (Node 24, ARM64, 1024 MB, 60 s, reserved concurrency 10, Function URL
   `AWS_IAM` + `RESPONSE_STREAM`), worker Lambda (SQS, batch 5), migrate custom resource (applies
   `packages/db/migrations` via Data API with an advisory lock, then seeds synthetic data), site bucket +
   `BucketDeployment`, CloudFront (OAC to S3 and to the Function URL, `/api/*` uncached with
   `ALL_VIEWER_EXCEPT_HOST_HEADER`, SPA rewrite CloudFront Function, security headers policy with CSP,
   HSTS, frame-ancestors none), log retention 30 days, alarms (API 5xx, Lambda errors/throttles, DLQ
   depth) to an SNS topic.

All roles get `FoundryAscent-Boundary` via `@aws-cdk/core:permissionsBoundary`. cdk-nag
`AwsSolutionsChecks` runs in CI; suppressions are justified inline.

---

## 11. Quality, security, and evaluation

| Suite | Where | Gate |
| --- | --- | --- |
| Unit (contracts, ai validators, risk classifier, authz, orchestrator with mock model) | Vitest | CI blocking |
| DB integration: migrations, RLS (wrong principal → 0 rows for every table), authorization matrix (role × venture × visibility × revoked/expired), memory lifecycle | Vitest + PostgreSQL 16 + pgvector service | CI blocking |
| Web: component tests; Playwright e2e of the founder journey against API with mock model; axe a11y | Vitest/Playwright | CI blocking |
| Infra: `cdk synth` + cdk-nag + snapshot | CI | blocking |
| Scenario benchmark (30–50 labelled prompts) and red team (≥ 100 cross-venture / injection cases with per-venture canaries) | `evals/` (Python) against a running API | manual workflow; gates from blueprint 01 §9 |
| Secret scanning (gitleaks), dependency audit, CodeQL | CI | blocking on high |

Acceptance gates (blueprint 01 §9): 0 critical cross-venture disclosures; ≥ 90 % memory recall with
100 % source links; ≥ 90 % grounded material claims; ≥ 95 % high-risk escalation recall; no unsupported
high-confidence statements; persona suspension without engineering.

---

## 12. Delivery

* `ci.yml` on every push; `deploy.yml` on `main` after CI passes (stage 0: access keys; stage 1:
  OIDC); post-deploy smoke test (health, sign-in rejection, static assets, security headers).
* Runbooks: [`docs/runbooks/`](../runbooks/) — deploy/rollback, kill switch, incident, access codes,
  cost controls, legacy cleanup.
