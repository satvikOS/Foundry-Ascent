# @foundry/core — domain services, authorization, coaching orchestrator

Everything apps/api needs between HTTP and the database: access-code sign-in and session verification,
authorization (service layer on top of RLS), the domain services behind every `/api/v1` endpoint, the
coaching orchestrator (system design §7) and the document-ingestion job processor. Core never reads
`process.env` (except `loadConfig`), never imports AWS SDKs (infrastructure comes in through **ports**)
and never logs content.

```ts
import { createCore, loadConfig, type Core } from '@foundry/core';
import { createDbFromEnv } from '@foundry/db';
import { createModelGateway, modelGatewayConfigFromEnv } from '@foundry/ai';

// Once per container (module scope of the Lambda handler):
const core: Core = createCore({
  db: createDbFromEnv(process.env),
  gateway: createModelGateway(modelGatewayConfigFromEnv(process.env, { logger })),
  config: loadConfig(process.env),
  objectStore: s3ObjectStore, // api implements (S3 documents bucket)
  jobQueue: sqsJobQueue, // api implements (SQS jobs queue)
  textExtractor: extractor, // worker only (unpdf / mammoth / UTF-8)
  logger, // optional; CoreLogger, identifiers only
});
```

---

## 1. Request context, errors, conventions

```ts
interface RequestContext {
  principalId: string;
  tenantId: string;
  roles: readonly PlatformRole[];
  requestId: string;
}
interface SessionContext extends RequestContext {
  sessionId: string;
  sessionExpiresAt: string;
} // from verifySession
```

- Build the context **only** with `core.auth.verifySession(cookie, { requestId })` (or `createRequestContext`
  in tests). `roles` is a hint for the UI; every decision re-derives roles, memberships and assignments
  from the database inside the request's RLS transaction.
- Every service method takes the context first, validates its own input with the contract schema
  (`z.input<…>` accepted, so the API may pass the parsed body or the raw JSON), authorizes, writes audit
  events, and always returns a **rejected promise** on failure (never throws synchronously).
- Failures are `DomainError { code: ErrorCode, status, message, retryAfterSeconds?, errors?, reason? }`.
  `message` is safe to show and log; map to problem+json with `status` (= `ERROR_STATUS[code]`),
  `Retry-After` from `retryAfterSeconds`, and `errors` (paths + messages, never values). `reason` is a
  machine code for logs. Infrastructure errors are already mapped (`toDomainError`):

| Source                                          | DomainError code                                                |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `DatabaseResumingError`                         | `database_resuming` (503, retryAfterSeconds)                    |
| SQLSTATE 23505 / 40001 / 40P01 / 55000          | `conflict`                                                      |
| SQLSTATE 42501 (RLS / SECURITY DEFINER refusal) | `forbidden`                                                     |
| SQLSTATE 23503 / 23514 / 23502 / 22P02          | `validation_failed`                                             |
| `NoRowsError`                                   | `not_found`                                                     |
| model gateway errors                            | `model_unavailable`                                             |
| anything else                                   | rethrown unchanged → map to 500 `internal`, log `err.name` only |

- Malformed path ids → `not_found`. Resources the caller has no relationship to → `not_found` (no
  existence leak); visible but insufficient → `forbidden`. Denials are audited after the transaction
  rolls back (`venture.access`, `authz.denied`, `turn.rejected`, …).
- Never nest calls to core inside another core call's transaction; each method manages its own.

## 2. Authentication (`core.auth`)

| Function                                                                                                                                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signIn({ accessCode, viewerIp, userAgent?, requestId }) → SignInResult { token, sessionId, principalId, tenantId, expiresAt, maxAgeSeconds }` | Normalises the code (trim/uppercase), per-IP sliding window (10 failures / 15 min → `locked_out` 429 + `retryAfterSeconds`), global soft limit (`rate_limited` for viewers that already failed while platform-wide failures are high), one scrypt evaluation per attempt (uniform timing), uniform `invalid_access_code` 401 for unknown / wrong / revoked / expired / disabled. IPs and user agents are stored only as salted SHA-256 (`platform_keys.ip_hash_salt`). |
| `verifySession(token, { requestId }) → SessionContext`                                                                                         | HS256 JWT (`sub`, `sid`, `tid`, `iat`, `exp`; key = `platform_keys.session_signing`, `kid` header, retired keys accepted for 12 h), then revocation state (session revoked/expired, code revoked, principal disabled) cached ≤ 60 s per container. Throws `unauthenticated` 401.                                                                                                                                                                                       |
| `signOut(ctx: SessionContext)`                                                                                                                 | Revokes the auth session (immediate in this container).                                                                                                                                                                                                                                                                                                                                                                                                                |
| `invalidatePrincipal(principalId)`                                                                                                             | Drops cached sessions (core calls it after code revocation / invites).                                                                                                                                                                                                                                                                                                                                                                                                 |

Cookie (API): `fa_session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=<maxAgeSeconds>`.
`viewerIp`: the API passes the CloudFront-set `x-fa-viewer-ip` (never a client-controlled header in production). Attempts are counted per IPv4 address and per IPv6 /64 (`viewerNetwork`), and admitted under a per-viewer advisory lock (`authRepo.reserveAuthAttempt`), so concurrent attempts cannot exceed 10 verified failures per window.
The seeded owner signs in with the deploy-time code (`OWNER_ACCESS_CODE_PREFIX/HASH`). Access-code
helpers (`generateAccessCode`, `hashAccessCode`, `verifyAccessCode`, `accessCodePrefix`,
`isAccessCodeHash`) are re-exported from `@foundry/db` (single implementation of the runtime contract).

## 3. Endpoint → service map

All methods: `(ctx, …) => Promise<…>`; return types are the `@foundry/contracts` views.

| Endpoint                                        | Call                                                                                                          | Who                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `POST /auth/sign-in`                            | `auth.signIn(input)`                                                                                          | public                                                                                                 |
| `POST /auth/sign-out`                           | `auth.signOut(ctx)`                                                                                           | session                                                                                                |
| `GET /me`                                       | `me.get(ctx) → Me`                                                                                            | session                                                                                                |
| `GET /ventures`                                 | `ventures.list(ctx) → VentureSummary[]`                                                                       | own memberships + EIR assignments                                                                      |
| `GET /ventures/:id`                             | `ventures.get(ctx, id) → VentureDetail`                                                                       | read                                                                                                   |
| `PATCH /ventures/:id`                           | `ventures.update(ctx, id, UpdateVentureRequest) → VentureDetail`                                              | write                                                                                                  |
| `GET /ventures/:id/overview`                    | `ventures.overview(ctx, id) → VentureOverview`                                                                | read                                                                                                   |
| `POST /ventures/:id/sessions`                   | `sessions.create(ctx, id, CreateSessionRequest) → SessionView`                                                | write; kill switch, persona/assignment, mode, spend caps                                               |
| `GET /ventures/:id/sessions`                    | `sessions.list(ctx, id) → SessionView[]`                                                                      | write                                                                                                  |
| `GET /sessions/:id`                             | `sessions.get(ctx, id) → { session, turns: TurnView[] }`                                                      | write                                                                                                  |
| `POST /sessions/:id/turns` (SSE)                | `orchestrator.runTurn(ctx, id, RunTurnInput, emit, { signal })`                                               | write (§4)                                                                                             |
| `POST /sessions/:id/end`                        | `sessions.end(ctx, id) → { session, recap }`                                                                  | write                                                                                                  |
| `POST /turns/:id/feedback`                      | `sessions.submitFeedback(ctx, id, TurnFeedbackRequest) → { feedbackId }`                                      | write                                                                                                  |
| `GET /turns/:id/evidence`                       | `sessions.getTurnEvidence(ctx, id) → EvidenceItem[]`                                                          | write, or assigned EIR for sampled turns                                                               |
| `GET /ventures/:id/memory?type&status&q&pinned` | `memory.list(ctx, id, MemoryQuery) → MemoryObjectView[]`                                                      | read (RLS visibility per item)                                                                         |
| `POST /ventures/:id/memory`                     | `memory.create(ctx, id, CreateMemoryRequest) → MemoryObjectView`                                              | write → confirmed/founder; assigned EIR → proposed/eir                                                 |
| `PATCH /memory/:id`                             | `memory.act(ctx, id, MemoryAction) → MemoryObjectView \| null` (null after delete; new version after correct) | write                                                                                                  |
| `GET /memory/:id/history`                       | `memory.history(ctx, id) → MemoryEventView[]`                                                                 | read                                                                                                   |
| `POST /ventures/:id/documents`                  | `documents.createUpload(ctx, id, CreateDocumentRequest) → CreateDocumentResponse`                             | write                                                                                                  |
| `POST /documents/:id/complete`                  | `documents.complete(ctx, id) → DocumentView` (enqueues ingestion; retry after `failed`)                       | write                                                                                                  |
| `GET /ventures/:id/documents`                   | `documents.list(ctx, id) → DocumentView[]`                                                                    | read                                                                                                   |
| `DELETE /documents/:id`                         | `documents.remove(ctx, id) → void`                                                                            | write                                                                                                  |
| `GET /ventures/:id/escalations`                 | `escalations.list(ctx, id) → EscalationView[]`                                                                | write                                                                                                  |
| `POST /ventures/:id/escalations`                | `escalations.create(ctx, id, CreateEscalationRequest) → EscalationView`                                       | write                                                                                                  |
| `PATCH /escalations/:id`                        | `escalations.act(ctx, id, EscalationAction) → EscalationView`                                                 | founder/team: approve_sharing, edit, withdraw; assignee (after consent): acknowledge, resolve, decline |
| `GET /inbox/escalations`                        | `escalations.inbox(ctx) → EscalationView[]`                                                                   | assignee                                                                                               |
| `GET /ventures/:id/team`                        | `team.list(ctx, id) → TeamMemberView[]`                                                                       | read or program lead                                                                                   |
| `POST /ventures/:id/team/invitations`           | `team.invite(ctx, id, InviteMemberRequest) → AccessCodeIssued` (code shown once)                              | program lead                                                                                           |
| `GET /personas`                                 | `eir.listPersonas(ctx) → PersonaView[]`                                                                       | eir / program lead / admin                                                                             |
| `GET /personas/:id`                             | `eir.getPersona(ctx, id) → PersonaView`                                                                       | eir / program lead / admin                                                                             |
| `GET /eir/profiles` (optional)                  | `eir.listEirProfiles(ctx) → EirProfileView[]`                                                                 | eir / program lead / admin                                                                             |
| `POST /personas/:id/releases`                   | `eir.createRelease(ctx, id, CreatePersonaReleaseRequest) → PersonaReleaseView`                                | program lead or linked EIR                                                                             |
| `POST /persona-releases/:id/approve`            | `eir.approveRelease(ctx, id) → PersonaReleaseView`                                                            | program lead or linked EIR; EIR persona needs consent                                                  |
| `POST /personas/:id/suspend`                    | `eir.suspendPersona(ctx, id, SuspendPersonaRequest) → PersonaView`                                            | program lead or linked EIR                                                                             |
| `POST /personas/:id/resume`                     | `eir.resumePersona(ctx, id) → PersonaView`                                                                    | program lead or linked EIR                                                                             |
| `GET /eir/reviews`                              | `eir.reviewQueue(ctx) → ReviewSample[]`                                                                       | eir                                                                                                    |
| `POST /eir/reviews/:turnId`                     | `eir.submitReview(ctx, turnId, SubmitReviewRequest) → { reviewId, turnId }`                                   | assigned EIR                                                                                           |
| `GET /program/portfolio`                        | `program.portfolio(ctx) → PortfolioSummary` (k-anonymous)                                                     | program lead / admin                                                                                   |
| `GET /program/ventures`                         | `program.listVentures(ctx) → ProgramVentureRow[]`                                                             | program lead                                                                                           |
| `POST /program/ventures`                        | `program.createVenture(ctx, CreateVentureRequest) → ProgramVentureRow` (assigns the active Foundry Guide)     | program lead                                                                                           |
| `GET /program/resources?kind&stage&tag&q`       | `program.listResources(ctx, ResourceFilter) → ResourceView[]`                                                 | any session                                                                                            |
| `POST /program/resources`                       | `program.createResource(ctx, UpsertResourceRequest) → ResourceView`                                           | program lead                                                                                           |
| `PATCH /program/resources/:id`                  | `program.updateResource(ctx, id, UpdateResourceRequest) → ResourceView` (status `retired` hides it)           | program lead                                                                                           |
| `GET /program/escalations`                      | `program.escalationQueue(ctx) → EscalationQueueItem[]` (metadata only)                                        | program lead / admin                                                                                   |
| `POST /program/escalations/:id/route`           | `program.routeEscalation(ctx, id, RouteEscalationRequest) → EscalationQueueItem`                              | program lead / admin                                                                                   |
| `GET /admin/principals`                         | `admin.listPrincipals(ctx) → AdminPrincipalRow[]`                                                             | platform admin                                                                                         |
| `POST /admin/principals`                        | `admin.createPrincipal(ctx, CreatePrincipalRequest) → AdminPrincipalRow`                                      | platform admin                                                                                         |
| `POST /admin/principals/:id/access-codes`       | `admin.issueAccessCode(ctx, id, IssueAccessCodeRequest) → AccessCodeIssued`                                   | admin; program lead for non-privileged principals                                                      |
| `DELETE /admin/access-codes/:id`                | `admin.revokeAccessCode(ctx, id) → { accessCodeId, revokedAt }`                                               | same as issue                                                                                          |
| `GET /admin/settings`                           | `admin.getSettings(ctx) → PlatformSettingsView`                                                               | platform admin                                                                                         |
| `PATCH /admin/settings`                         | `admin.updateSettings(ctx, UpdateSettingsRequest) → PlatformSettingsView` (kill switch audited)               | platform admin                                                                                         |
| `GET /admin/audit?action&outcome&cursor&limit`  | `admin.listAudit(ctx, AuditQuery) → { items, nextCursor }`                                                    | platform admin                                                                                         |
| `GET /admin/usage`                              | `admin.usageSummary(ctx) → UsageSummary`                                                                      | platform admin                                                                                         |

`UpdateResourceRequest` and `ResourceFilter` are exported by core (not yet in contracts).

Idempotency (`Idempotency-Key`) for non-SSE writes is the API's job (`idempotencyRepo`, system
executor); turns use `expectedOrdinal` (below).

## 4. Turns (SSE): `orchestrator.runTurn`

```ts
runTurn(ctx, sessionId, input: { text, mode?, rehearsalCounterpart?, expectedOrdinal? }, emit, { signal? })
  → Promise<RunTurnOutcome { status: 'completed' | 'blocked' | 'failed' | 'rejected'; turnId; replayed; error }>
type TurnEmitter = (event: TurnStreamEvent) => void | Promise<void>;
```

- Emits, in order: `turn.accepted` → `turn.status` `classifying` → `retrieving` (twice: start, then with
  `evidenceCount`) → `reasoning` → `validating` → exactly one terminal event: `turn.completed { turn }`,
  `turn.blocked { reason, escalationId, supportMessage }` (`crisis_support`, `cross_venture`, `identity`)
  or `turn.error { turnId, code, message, retryable }`. Domain failures are **emitted, never thrown**.
- Failures before acceptance (not found, forbidden, `session_ended`, `ai_disabled`, `persona_suspended`,
  `assignment_inactive`, `spend_cap_reached`, `rate_limited`, `session_turn_limit`, validation) produce a
  single `turn.error` with `turnId: null` and `outcome.status === 'rejected'` with `outcome.error`. The API
  can await the first event (or the outcome) before committing to `text/event-stream`, and answer
  rejections with plain problem+json + `outcome.error.status`.
- `expectedOrdinal` (recommended: `session.turnCount + 1` from the client, e.g. `Idempotency-Key` header
  or body field) makes retries idempotent: an existing turn with the same ordinal, author and text is
  replayed from storage (no model call); a different text → `idempotency_conflict`; a gap → `conflict`.
- Pipeline: authorize (membership, session, kill switch, assignment + approved release, mode, turn limit,
  20 turns / 10 min per principal, daily spend caps) → deterministic risk pre-classifier → crisis path
  (fixed support message, **no model call**, P1 `safety_wellbeing` escalation draft; it bypasses the AI
  gates: kill switch, spend caps, persona status) → query embedding (`gateway.embed`) → scoped hybrid
  retrieval (memory 8, venture chunks 6, doctrine/program 4, resources 4, patterns 2; isolation
  re-filtered; `retrieval.authorized` audit) → context ≤ 12k tokens → `generateStructured(CoachResponse)`
  → `validateCoachResponse` (evidence ids, facts, grounding, identity, cross-venture names/canaries/member names,
  forced escalation) → persist turn + evidence + usage ledger (one row per attempt) + audit; memory
  candidates become `proposed` items (origin `ai`, visibility `team`); forced or P0/P1 escalations become
  `draft` escalations; all high-risk turns and 30 % of others are sampled for EIR review.
- `signal` (client disconnect / deadline) cancels the model call; the turn is marked `failed`.

## 5. Ingestion worker: `ingestion.process`

```ts
process(job: unknown, { requestId, attempt?, maxAttempts? }) → Promise<IngestionResult { status: 'ready'|'failed'|'skipped', documentId, chunks, reason }>
```

- `job` is the SQS message body (`JobMessage` / `IngestDocumentJob`: `{ type: 'ingest_document', documentId,
tenantId, ventureId, requestId }`, enqueued by `documents.complete`). Invalid jobs are skipped.
- Runs with the owner role but re-validates the job against the `documents` row and its venture; every
  write uses the row's tenant/venture ids (`scope_mismatch` → skipped + `ingestion.rejected` audit).
- Reads the object (`ObjectStore.getObject`, ≤ 10 MB) → `TextExtractor.extract` → heading-aware chunks
  (~800 tokens, 15 % overlap) → Titan embeddings (batched; on failure chunks are stored without vectors
  for the backfill) → `knowledge_chunks` (scope `venture`) → document `ready`.
- Permanent failures mark the document `failed` with a reason (`object_missing`, `too_large`,
  `extract_failed`, `empty_text`, `extractor_unavailable`) and resolve. Transient failures throw
  `RetryableIngestionError` → report the record in `batchItemFailures`; pass
  `attempt = ApproximateReceiveCount` and `maxAttempts` (the queue's `maxReceiveCount`) so the last
  attempt marks the document `failed` (`retries_exhausted`) instead of leaving it `processing`.

## 6. Ports the API implements (`@foundry/core` exports the types)

```ts
interface ObjectStore {
  presignPut(input: { key; contentType; contentLength; expiresInSeconds }): Promise<{ url; headers; expiresAt }>;
  getObject(key: string, options: { maxBytes: number }): Promise<Uint8Array>; // throw ObjectNotFoundError / ObjectTooLargeError
  delete(key: string): Promise<void>;                                         // missing key is not an error
}
interface JobQueue { enqueue(job: JobMessage, options?: { deduplicationId? }): Promise<void> }
interface TextExtractor { extract(data: Uint8Array, contentType: DocumentContentType): Promise<{ text: string }> } // throw ExtractionFailedError
interface Clock { now(): Date }              // optional (systemClock)
interface IdGenerator { uuid(): string }     // optional (randomUUID)
interface CoreLogger { info/warn/error(event: string, fields: CoreLogFields): void } // optional; ids/counts/codes only
```

- `presignPut`: S3 `PutObjectCommand` with `ContentType` and `ContentLength` signed (bucket CORS for
  `SITE_ORIGIN`); return the headers the browser must send. Keys are built by core:
  `tenants/{tenantId}/ventures/{ventureId}/documents/{documentId}/{safe filename}`.
- `TextExtractor`: `unpdf` for PDF, `mammoth.convertToMarkdown` for DOCX (headings become `#` lines),
  UTF-8 for text/markdown.

## 7. Configuration (`CoreConfig`)

`loadConfig(env)` reads `APP_ENV`, `APP_VERSION`, `HOME_TENANT_SLUG`, `SITE_ORIGIN` and optional
`CORE_TURN_RATE_LIMIT`, `CORE_REVIEW_SAMPLE_RATE_PCT`, `CORE_SESSION_CACHE_SECONDS`. Defaults match the
system design: session 12 h / 60 s cache; sign-in 10 failures / 15 min; turns 20 / 10 min, 30 %
sampling, 12k input tokens, 8 history turns, 25 s model budget; retrieval budgets 8/6/4/4/2; chunks
800 tokens / 15 % overlap; presigned uploads 5 min; P1 business days in `America/New_York`.
`coreConfig(overrides)` builds a validated config for tests. Daily spend caps, the kill switch, the
turn limit per session, the grounding threshold and k for the portfolio live in `platform_settings`.

## 8. Authorization model (defence in depth over RLS)

- `requireVentureAccess(scope, ventureId, 'read' | 'write' | 'review')` re-derives the relationship in the
  request transaction: read = any member or the assigned EIR; write = founder/team of a non-archived
  venture; review = assigned EIR. Program leads and admins get **no** venture content by role.
- `requireRole(scope, roles)` re-reads `role_grants`; `requireAssignmentActive(scope, ventureId)` checks
  assignment, persona status (`persona_suspended`) and approved release on every session and turn.
- Owner-role (`db.system`) use in core: sign-in/session checks, usage ledger, spend caps, audit appends
  after rollbacks, admin credential metadata, the tenant directory for the cross-venture guard, best-effort
  embeddings of ids from committed writes, and the ingestion worker. Grep `kit.system(` to review.

## 9. Testing

- `pnpm --filter @foundry/core test` — unit tests (no database).
- `pnpm --filter @foundry/core test:db` — `*.db.test.ts` against PostgreSQL 16 + pgvector
  (`TEST_DATABASE_ADMIN_URL`, see @foundry/db), each file on a fresh migrated + seeded database, the app
  running as `app_rls` under the non-superuser owner.
- `@foundry/core/testing` (tests only): `createCoreHarness()` (database + `MockModelGateway` + in-memory
  ports + `ctxFor(principalId)` + seed people/ventures), `MemoryObjectStore`, `MemoryJobQueue`,
  `Utf8TextExtractor`, `ManualClock`, `RecordingLogger`.

## 10. Known limits (V1)

- Cross-venture guard matches other venture **names** as whole phrases: a venture named with a common
  word would over-block; keep venture names distinctive.
- Ephemeral sessions keep turn content until `sessions.end`, which erases it; abandoned ephemeral sessions
  keep it (a cleanup job can end stale sessions).
- Revocation in another container takes effect within the cache TTL (60 s), by design.
