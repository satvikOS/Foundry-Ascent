# @foundry/api — HTTP API, Lambda handlers, local dev server

The `/api/v1` HTTP API (Hono) on top of `@foundry/core`, the three Lambda handlers CDK deploys, the
infrastructure adapters behind core's ports (S3, SQS, text extraction) and a local development server.
Contracts come from `@foundry/contracts`; every response body is a contract view, every error is RFC 9457
`application/problem+json`.

```
src/
  app.ts                 createApp(deps) → Hono app mounted at /api/v1 (+ routeTable)
  config.ts              loadApiConfig(env, role), loadCoreConfig(env) (zod; names variables, never values)
  logging.ts             JSON-lines logger (ids, counts, codes, timings only)
  http/                  middleware, problem+json, idempotency, input parsing, router, SSE turn stream
  routes/                system (health, auth, me), ventures (+memory/escalations/team), sessions (+turns,
                         documents), studio (EIR, program, admin), local-uploads (development only)
  adapters/              S3ObjectStore, SqsJobQueue, DocumentTextExtractor, LocalObjectStore, InlineJobQueue
  jobs/                  worker batch processing, embedding backfill, migrations custom resource
  runtime/               per-process wiring (api / worker / schema), InflightTracker
  handlers/              api.ts, worker.ts, migrate.ts (Lambda entry points)
  dev-server.ts          local server on :8787
  scripts/               bundle check (esbuild like CDK + import check)
  testing/               API harness (real Postgres + mock model), fakes, SSE parser, PDF/DOCX fixtures
```

## Endpoints

All paths are relative to `/api/v1`. **Auth** `session` = `fa_session` cookie verified by
`core.auth.verifySession`. Every non-GET request needs `X-Requested-With: foundry-ascent`. **Idem.**
`std` = `Idempotency-Key` honoured (24 h replay), `secret` = one-time secret in the response (a retry gets
`409 idempotency_conflict`, the secret is never stored), `turn` = key bound to the accepted turn.

| Method      | Path                                             | Auth         | Idem.  | Success                                        | Notes                                                                         |
| ----------- | ------------------------------------------------ | ------------ | ------ | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| GET         | `/health`                                        | public       |        | 200 (`ok`/`degraded`)                          | liveness + `version`; never queries the DB; `db` = state recent requests saw  |
| GET         | `/admin/health`                                  | admin        |        | 200, 503 db unavailable                        | probes the DB once (`awake/resuming/unavailable`); platform admin only        |
| POST        | `/auth/sign-in`                                  | public       |        | 200 `Me` + Set-Cookie                          | 401 `invalid_access_code`, 429 `locked_out`/`rate_limited`                    |
| POST        | `/auth/sign-out`                                 | public       |        | 204 + cleared cookie                           | revokes the session when valid                                                |
| GET         | `/me`                                            | session      |        | 200 `Me`                                       |                                                                               |
| GET         | `/ventures`                                      | session      |        | 200 `{items}`                                  | own memberships + EIR assignments                                             |
| GET         | `/ventures/:id`                                  | session      |        | 200 `VentureDetail`                            |                                                                               |
| PATCH       | `/ventures/:id`                                  | session      | std    | 200 `VentureDetail`                            | founder/team                                                                  |
| GET         | `/ventures/:id/overview`                         | session      |        | 200 `VentureOverview`                          |                                                                               |
| GET         | `/ventures/:id/memory?type&status&q&pinned`      | session      |        | 200 `{items}`                                  | `pinned=true/false/1/0`                                                       |
| POST        | `/ventures/:id/memory`                           | session      | std    | 201 `MemoryObjectView`                         |                                                                               |
| PATCH       | `/memory/:id`                                    | session      | std    | 200 `MemoryObjectView`, **204 after `delete`** | `correct` returns the new version                                             |
| GET         | `/memory/:id/history`                            | session      |        | 200 `{items}`                                  |                                                                               |
| GET         | `/ventures/:id/escalations`                      | session      |        | 200 `{items}`                                  |                                                                               |
| POST        | `/ventures/:id/escalations`                      | session      | std    | 201 `EscalationView`                           |                                                                               |
| PATCH       | `/escalations/:id`                               | session      | std    | 200 `EscalationView`                           | founder: approve_sharing/edit/withdraw; assignee: acknowledge/resolve/decline |
| GET         | `/inbox/escalations`                             | session      |        | 200 `{items}`                                  |                                                                               |
| GET         | `/ventures/:id/team`                             | session      |        | 200 `{items}`                                  |                                                                               |
| POST        | `/ventures/:id/team/invitations`                 | session      | secret | 201 `AccessCodeIssued`                         | program lead                                                                  |
| POST        | `/ventures/:id/sessions`                         | session      | std    | 201 `SessionView`                              | kill switch 503, persona 423, spend cap 429                                   |
| GET         | `/ventures/:id/sessions`                         | session      |        | 200 `{items}`                                  |                                                                               |
| GET         | `/sessions/:id`                                  | session      |        | 200 `{session, turns}`                         |                                                                               |
| POST        | `/sessions/:id/turns`                            | session      | turn   | 200 `text/event-stream`                        | refusals before acceptance are problem+json (404/409/422/423/429/503)         |
| POST        | `/sessions/:id/end`                              | session      | std    | 200 `{session, recap}`                         |                                                                               |
| POST        | `/turns/:id/feedback`                            | session      | std    | 201 `{feedbackId}`                             |                                                                               |
| GET         | `/turns/:id/evidence`                            | session      |        | 200 `{items}`                                  |                                                                               |
| POST        | `/ventures/:id/documents`                        | session      | std    | 201 `{document, upload}`                       | presigned PUT, 5 min                                                          |
| POST        | `/documents/:id/complete`                        | session      | std    | 202 (processing) / 200 `DocumentView`          | enqueues ingestion                                                            |
| GET         | `/ventures/:id/documents`                        | session      |        | 200 `{items}`                                  |                                                                               |
| DELETE      | `/documents/:id`                                 | session      | std    | 204                                            |                                                                               |
| GET         | `/personas` · `/personas/:id` · `/eir/profiles`  | session      |        | 200                                            | EIR / program lead / admin                                                    |
| POST        | `/personas/:id/releases`                         | session      | std    | 201 `PersonaReleaseView`                       |                                                                               |
| GET         | `/persona-releases/:id`                          | session      |        | 200 `PersonaReleaseView`                       | drafts: program lead, platform admin or linked EIR                            |
| POST        | `/persona-releases/:id/approve`                  | session      | std    | 200 `PersonaReleaseView`                       |                                                                               |
| POST        | `/personas/:id/suspend` · `/personas/:id/resume` | session      | std    | 200 `PersonaView`                              | kill switch per persona                                                       |
| GET         | `/eir/reviews`                                   | session      |        | 200 `{items}`                                  | assigned EIR                                                                  |
| POST        | `/eir/reviews/:turnId`                           | session      | std    | 201 `{reviewId, turnId}`                       |                                                                               |
| GET         | `/program/portfolio`                             | session      |        | 200 `PortfolioSummary`                         | k-anonymous                                                                   |
| GET / POST  | `/program/ventures`                              | session      | std    | 200 `{items}` / 201 `ProgramVentureRow`        |                                                                               |
| GET / POST  | `/program/resources?kind&stage&tag&q`            | session      | std    | 200 `{items}` / 201 `ResourceView`             |                                                                               |
| PATCH       | `/program/resources/:id`                         | session      | std    | 200 `ResourceView`                             | `status: retired` hides it                                                    |
| GET         | `/program/escalations`                           | session      |        | 200 `{items}`                                  | metadata only                                                                 |
| GET         | `/program/assignees`                             | session      |        | 200 `{items}` (`EscalationAssignee`)           | program lead / admin; active EIRs and program leads of the tenant             |
| POST        | `/program/escalations/:id/route`                 | session      | std    | 200 `EscalationQueueItem`                      | consented and open only; assignee must be an EIR or program lead              |
| GET / POST  | `/admin/principals`                              | session      | std    | 200 `{items}` / 201 `AdminPrincipalRow`        | platform admin                                                                |
| POST        | `/admin/principals/:id/access-codes`             | session      | secret | 201 `AccessCodeIssued`                         |                                                                               |
| DELETE      | `/admin/access-codes/:id`                        | session      | std    | 200 `{accessCodeId, revokedAt}`                |                                                                               |
| GET / PATCH | `/admin/settings`                                | session      | std    | 200 `PlatformSettingsView`                     |                                                                               |
| GET         | `/admin/audit?action&outcome&cursor&limit`       | session      |        | 200 `{items, nextCursor}`                      |                                                                               |
| GET         | `/admin/usage`                                   | session      |        | 200 `UsageSummary`                             |                                                                               |
| PUT         | `/_local/uploads/:token`                         | signed token |        | 200                                            | **development only** (LocalObjectStore)                                       |

Common errors on every authenticated route: 401 `unauthenticated` (also clears the cookie), 403
`forbidden` (CSRF header, role, write access), 404 `not_found` (unknown or unrelated resource, malformed
id), 409 `conflict`/`idempotency_conflict`, 413 body > 1 MiB, 415 non-JSON body, 422 `validation_failed`
with `errors[{path, message}]`, 500 `internal` (generic message), 503 `database_resuming` with `Retry-After`.

## Request pipeline

1. **Request context** — `x-request-id` accepted when well-formed (8–128 log-safe characters) else a UUID;
   echoed on the response. Security headers on every response (`Cache-Control: no-store`, `nosniff`,
   `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, CORP, `CSP default-src 'none'`). One access-log
   line per request: method, route template, status, latency, principal id hash, request id, error code.
2. **CSRF** — non-GET without `X-Requested-With: foundry-ascent` → 403.
3. **Body** — read once (≤ 1 MiB). `x-amz-content-sha256` is not required (CloudFront OAC enforces it at the
   edge), but when present it must match the body (400).
4. **Session** — `fa_session` → `core.auth.verifySession` → `SessionContext`.
5. **Idempotency** (writes) — the key is reserved atomically (`idempotency_keys`, status 0) before the
   handler runs, so concurrent duplicates cannot both execute; 2xx responses are stored and replayed with
   `Idempotency-Replayed: true`; non-2xx releases the reservation; a different request with the same key is
   `409 idempotency_conflict`; an in-flight key is `409 conflict` + `Retry-After: 2`; reservations older than
   120 s (crashed requests) are taken over.
6. **Errors** — `DomainError` → problem+json with `ERROR_STATUS[code]` and `Retry-After`;
   `DatabaseResumingError` → 503 `database_resuming`; anything else → 500 with a generic message (the log
   gets the error class and stack frames, never the message). `database_resuming`, `locked_out`,
   `rate_limited` and `spend_cap_reached` always carry `Retry-After` and `retryAfterSeconds` (fallbacks
   10 s / 15 min / 60 s / 1 h when the error did not set one). Every response, including 204s, errors and
   streams, carries `x-request-id`.

Database resume: an API database call waits at most 40 s (`DB_RESUME_BUDGET_MS`, default from
`lambda-contract.json`) for Aurora to resume, then answers 503 `database_resuming` — inside the 60 s
CloudFront origin read timeout and the 60 s Lambda timeout (infra README "Timeouts and Aurora resume").

Sign-in viewer IP: `x-fa-viewer-ip`, set by the `/api/*` CloudFront viewer-request function from
`event.viewer.ip` (any client value is overwritten). `x-forwarded-for` (first hop, client-controlled) is used
only when `APP_ENV=development`; without the trusted header the attempt is counted in one shared bucket (fails
closed). Core counts IPv6 viewers per /64 and serialises concurrent attempts per viewer, so at most 10
failures per 15 minutes are ever verified. The session cookie is `fa_session=…; Max-Age=43200; Expires=…; Path=/api; HttpOnly;
Secure; SameSite=Strict` (browsers accept `Secure` on `http://localhost`).

### Turn streaming (`POST /sessions/:id/turns`)

Body: `CreateTurnRequest` plus optional `expectedOrdinal` (core `RunTurnInput`). The API waits for the first
orchestrator event: a refusal before acceptance (`turn.error` with `turnId: null`) becomes a plain
problem+json response; otherwise it streams SSE frames `event: <name>\ndata: <TurnStreamEvent JSON>\n\n`
(`turn.accepted` → `turn.status` × 5 → `turn.completed` | `turn.blocked` | `turn.error`), with `: keep-alive`
comments every 15 s. The orchestrator never blocks on the client (events go through an unbounded channel);
a client disconnect, a write stalled for 10 s, or the deadline (Lambda remaining time − 4 s) aborts the
turn's `signal`, and core records the turn as failed. In Lambda the handler drains in-flight turns before
returning so nothing is frozen mid-write. With `Idempotency-Key`, the key stores `{turnId, ordinal}` at
acceptance; a retry is run with `expectedOrdinal` and core replays the stored turn without a model call.

## Lambda handlers (bundled by CDK `NodejsFunction`, Node 24 ARM64, ESM)

| Handler               | Trigger                                             | Behaviour                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handlers/api.ts`     | Function URL, `RESPONSE_STREAM`                     | `hono/aws-lambda` `streamHandle`; cold-start wiring at module scope (no I/O); drains in-flight turns                                                                                                                                                                                                                                                                               |
| `handlers/worker.ts`  | SQS (batch 5, ReportBatchItemFailures)              | `ingest_document` → `core.ingestion.process` (`attempt = ApproximateReceiveCount`, `maxAttempts = JOBS_MAX_RECEIVE_COUNT`); transient failures → `batchItemFailures`; malformed messages dropped; `backfill_embeddings` jobs; a bounded embedding backfill after batches that ingested documents; records that cannot start with 30 s left are deferred                            |
| `handlers/migrate.ts` | CloudFormation custom resource (Provider `onEvent`) | Create/Update: wake Aurora (≤ 5 min, always leaving 4 min of the 10-min Lambda), `migrate`, idempotent `seedDatabase` with the deploy owner, embedding backfill for seed chunks/memory (≤ 5 000 items, ≤ 5 min, best effort, respects the AI kill switch; a failure such as Bedrock throttling only logs counts). Delete: no-op. PhysicalResourceId always `foundry-ascent-schema` |

Environment (runtime contract): the per-function variable names live in
[`lambda-contract.json`](lambda-contract.json) (shared with infra/cdk, which sets exactly those): common
`APP_ENV`, `APP_VERSION`, `LOG_LEVEL`, `DB_DRIVER`, `DB_CLUSTER_ARN`, `DB_SECRET_ARN`, `DB_NAME`,
`MODEL_PROVIDER`, `MODEL_PRIMARY_ID`, `MODEL_FALLBACK_ID`, `MODEL_EMBEDDINGS_ID`, `BEDROCK_REGION`,
`HOME_TENANT_SLUG`; api `DOCUMENTS_BUCKET`, `JOBS_QUEUE_URL`, `DB_RESUME_BUDGET_MS` (+ `SITE_ORIGIN` with a
custom domain); worker `DOCUMENTS_BUCKET`, `JOBS_MAX_RECEIVE_COUNT` (the queue's redrive `maxReceiveCount`);
migrate `OWNER_ACCESS_CODE_PREFIX`, `OWNER_ACCESS_CODE_HASH`, `OWNER_DISPLAY_NAME`, `HOME_TENANT_NAME`.
Locally `DATABASE_URL` (pg) and core's optional `CORE_*` knobs. A missing or invalid variable fails the cold
start with its name (never its value).

**Bundling.** CommonJS dependencies (mammoth, pg, parts of the AWS SDK) need the `createRequire` banner
(`ESM_REQUIRE_SHIM`); without it every bundle fails at import with "Dynamic require of … is not supported".
The banner, externals (`pg-native`), target and main fields come from `lambda-contract.json`, which CDK's
`PlatformFunction` reads too. `check:bundles` imports each handler with exactly its role's variables:

```bash
pnpm --filter @foundry/api check:bundles     # esbuild like CDK → import each handler in a fresh Node process
```

(api ≈ 1.8 MiB, worker ≈ 3.6 MiB with unpdf/mammoth, migrate ≈ 1.5 MiB minified). `src/bundle.test.ts`
runs the same check in the unit suite and also exercises unpdf + mammoth inside a bundle.

## Adapters

- **S3ObjectStore** — presigned `PUT` signing `content-type` and `content-length` (the browser must upload
  exactly the declared type and size), ≤ 5 min, keys under `tenants/` only, client with flexible checksums
  `WHEN_REQUIRED` (otherwise the SDK signs a CRC32 of the empty body into the URL); `getObject` rejects by
  `ContentLength` before reading; `delete` is idempotent.
- **SqsJobQueue** — JSON body (ids only), `jobType` attribute; FIFO fields only on `.fifo` queues.
- **DocumentTextExtractor** — PDF via unpdf `extractText` (copy of the bytes, ≤ 500 pages, `verbosity: 0`),
  DOCX via mammoth `convertToHtml` → Markdown headings (`extractRawText` as fallback;
  `externalFileAccess: false`, images skipped), UTF-8 for text/markdown; ≤ 10 MB in, ≤ 2 M characters out,
  60 s budget; failures are `ExtractionFailedError` (permanent).

## Local development

```bash
pnpm --filter @foundry/db db:reset     # local database "foundry" + seed; prints DATABASE_URL and a DEV owner code
pnpm --filter @foundry/api dev         # → Foundry Ascent API (development) listening on http://localhost:8787/api/v1
pnpm --filter @foundry/web dev         # the SPA proxies /api to :8787
```

Defaults: `APP_ENV=development`, `DB_DRIVER=pg`, `DATABASE_URL` = the `db:reset` database,
`MODEL_PROVIDER=mock` (deterministic, offline). Migrations are applied at start. Documents are stored under
`apps/api/.local/uploads` (`LOCAL_UPLOAD_DIR`) through signed local upload URLs on
`SITE_ORIGIN` (default `http://localhost:8787`; set it to the web dev server origin so uploads go through its
proxy), and ingestion jobs run in-process right after `POST /documents/:id/complete`. `PORT` changes the
port. The dev server refuses `APP_ENV=production`; the local upload route is never mounted outside
development.

## Tests

```bash
pnpm --filter @foundry/api typecheck
pnpm --filter @foundry/api test       # unit: SSE semantics, adapters, extractor, config, worker, bundles
pnpm --filter @foundry/api test:db    # route-level tests against PostgreSQL 16 + pgvector (TEST_DATABASE_ADMIN_URL)
pnpm exec eslint apps/api --max-warnings 0
```

DB tests use `createApiHarness()` (`src/testing/api-harness.ts`): a fresh migrated + seeded database per
file (non-superuser owner, RLS active), `MockModelGateway`, in-memory object store / job queue, the real app,
and helpers that sign in through `POST /auth/sign-in`. `handlers/handlers.db.test.ts` runs the deployed
handler modules end to end (environment → module init → streamHandle with a Lambda-runtime stand-in).
