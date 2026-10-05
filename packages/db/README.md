# @foundry/db — data access layer

PostgreSQL 16 + pgvector schema, migrations, row level security, the two SQL drivers (node-postgres for
local/CI, RDS Data API for Aurora), the request-context facade, typed repositories, the deterministic
synthetic seed and test helpers. Everything else (`packages/core`, `apps/api`) talks to the database only
through this package.

```ts
import { createDbFromEnv, memoryRepo, p } from '@foundry/db';
import { createTestDatabase, makeContext } from '@foundry/db/testing'; // tests only
```

Authoritative schema: [`migrations/0001_init.sql`](migrations/0001_init.sql) (tables, RLS policies,
SECURITY DEFINER helpers), [`migrations/0002_rls_helpers.sql`](migrations/0002_rls_helpers.sql)
(soft deletes, escalation routing, audit determinism + verification, idempotency request hash) and
[`migrations/0003_security_hardening.sql`](migrations/0003_security_hardening.sql) (security review
2026-10-05: no `founder_private` turn evidence and clean-up of existing data, ephemeral sessions out of EIR
review, tenant-checked chunk / EIR review / role grant / membership policies, tenant-unique venture names
and `app.rename_venture`, consent by the escalation's creator only, `app.spend_cap_state`,
`app.upload_usage_today` and the upload quota settings). 0001 and 0002 are applied in production and never
edited; every later change is a new migration.

---

## 1. The `Db` facade and the two executors

```ts
const db = createDbFromEnv(process.env); // DB_DRIVER=dataapi|pg (default: dataapi in production, else pg)

// Request work — role app_rls, RLS applies to every statement:
const items = await db.withContext({ principalId, tenantId, requestId }, (tx) =>
  memoryRepo.listMemory(tx, { ventureId }),
);

// Trusted server-side work — the OWNER role, RLS bypassed (grep `db.system(` to review every use):
await db.system((sx) => usageRepo.recordUsage(sx, entry));
await db.system((sx) => sx.query('…'), { transaction: false }); // autocommit
```

| API                                               | Signature                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createDb(config)`                                | `(DbConfig) => Db` — `{ driver: 'pg', connectionString, max?, statementTimeoutMs? }` or `{ driver: 'dataapi', resourceArn, secretArn, database, region?, client?, retry?, onRetry? }`                                                                                                                                                                                                                        |
| `createDbFromEnv(env?)` / `dbConfigFromEnv(env?)` | reads `DB_DRIVER`, `DATABASE_URL` (pg) or `DB_CLUSTER_ARN`, `DB_SECRET_ARN`, `DB_NAME` (default `foundry`) and the optional `DB_RESUME_BUDGET_MS` (per-call Aurora resume wait, default 45 000; the API sets 40 000)                                                                                                                                                                                         |
| `createDbFromDriver(driver)`                      | facade over an existing `SqlDriver`                                                                                                                                                                                                                                                                                                                                                                          |
| `db.withContext(ctx, fn)`                         | `<T>(DbContext, (tx: AppExecutor) => Promise<T>) => Promise<T>` — one transaction whose **first statement** is `SET_CONTEXT_SQL`: `SELECT set_config('role','app_rls',true), set_config('app.principal_id',:principalId,true), set_config('app.tenant_id',:tenantId,true), set_config('app.request_id',:requestId,true)`. Non-UUID ids are rejected before any I/O. Commits on success, rolls back on throw. |
| `db.system(fn, { transaction? })`                 | `<T>((sx: SystemExecutor) => Promise<T>, SystemOptions?) => Promise<T>` — owner role. Reserved for credential checks, auth sessions, ledgers, audit reads, idempotency keys, migrations/seed and workers on server-generated jobs. Never pass browser-supplied ids here without an authorization check first.                                                                                                |
| `db.ping({ maxWaitMs? })`                         | `SELECT 1`; `maxWaitMs: 0` = single attempt (for `/health`: catch `DatabaseResumingError` → `db: "resuming"`)                                                                                                                                                                                                                                                                                                |
| `db.close()`                                      | closes the pool (no-op for Data API)                                                                                                                                                                                                                                                                                                                                                                         |

`AppExecutor` (`privilege: 'app'`) and `SystemExecutor` (`privilege: 'system'`) both implement
`SqlExecutor`. Repositories that touch credential/ledger/audit tables require `SystemExecutor` at the type
level, so an RLS transaction cannot be passed by mistake (and app_rls has no privileges on those tables
anyway — the DB tests prove both).

## 2. SQL, parameters and row decoding

```ts
interface SqlExecutor {
  readonly driver: 'pg' | 'dataapi';
  readonly privilege: 'app' | 'system';
  query(sql: string, params?: SqlParams): Promise<{ rows: readonly RawRow[]; rowCount: number }>;
}
```

- **Named parameters** `:name` (`[A-Za-z_][A-Za-z0-9_]*`). `::` casts, `:=`, and anything inside strings,
  quoted identifiers, comments and `$$` bodies are ignored. Every placeholder needs a value built with `p.*`;
  unused params are dropped; a missing one throws `SqlUsageError`.
- The executor renders each placeholder as **`CAST(<placeholder> AS <type>)`** — `$n` for node-postgres,
  `:name` (+ Data API `typeHint`) for the Data API — so both drivers type parameters identically. Writing
  `:v::vector` is harmless but unnecessary.

| Builder                                           | SQL type             | Wire value                                                                      | Data API                                                                                          |
| ------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `p.uuid(s)`                                       | `uuid`               | lower-cased UUID                                                                | `stringValue` + `UUID`                                                                            |
| `p.text(s)`                                       | `text`               | string                                                                          | `stringValue`                                                                                     |
| `p.int(n)` / `p.bigint(n)`                        | `integer` / `bigint` | integer (validated range)                                                       | `longValue`                                                                                       |
| `p.num(n)`                                        | `numeric`            | finite number                                                                   | `stringValue` + `DECIMAL`                                                                         |
| `p.bool(b)`                                       | `boolean`            | boolean                                                                         | `booleanValue`                                                                                    |
| `p.ts(date \| iso)`                               | `timestamptz`        | ISO-8601 UTC (`…Z`); strings must carry an offset                               | `stringValue` (no `TIMESTAMP` hint: it would drop the offset and depend on the session time zone) |
| `p.json(v)`                                       | `jsonb`              | `JSON.stringify(v)`                                                             | `stringValue` + `JSON`                                                                            |
| `p.vector(number[])`                              | `vector`             | pgvector text `[0.1,…]`                                                         | `stringValue`                                                                                     |
| `p.textArray(string[])` / `p.uuidArray(string[])` | `text[]` / `uuid[]`  | PostgreSQL array literal `{"a","b \"c\""}` (migration-free; use `= ANY (:ids)`) | `stringValue`                                                                                     |
| `p.nullable.<kind>(v \| null \| undefined)`       | same                 | SQL NULL of that type                                                           | `isNull`                                                                                          |

Bulk inserts use one JSON parameter: `INSERT … SELECT … FROM jsonb_to_recordset(:rows) AS x (col type, …)`
(`p.json(rows)`); `text[]`/`jsonb` columns accept JSON arrays/objects there.

**Decoding.** Raw rows differ by driver; decode with column codecs:

| `col.*`         | JS                                                             | Accepts                                                                    |
| --------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `uuid`, `text`  | `string`                                                       |                                                                            |
| `int`           | `number` (safe integer; int8/count(*) arrive as strings on pg) | number, bigint, numeric string                                             |
| `num`           | `number`                                                       | number, numeric string                                                     |
| `bool`          | `boolean`                                                      | boolean, `t`/`f`                                                           |
| `ts`            | ISO-8601 UTC with ms (`2026-10-05T12:00:00.000Z`)              | pg text output with offset, Data API `YYYY-MM-DD HH:MM:SS[.f]` (UTC), Date |
| `date`          | `YYYY-MM-DD`                                                   |                                                                            |
| `json(schema?)` | parsed value (validated when a Zod schema is given)            | JSON text or parsed value                                                  |
| `textArray`     | `string[]`                                                     | JS array, JSON array text, PostgreSQL array literal                        |
| `enum(values)`  | literal union                                                  |                                                                            |

Every codec has `.nullable`. Build row codecs with `row(shape)` (snake_case keys) or **`camelRow(shape)`**
(opt-in `created_at → createdAt`); a column missing from the result is a `DbDecodeError` (schema drift).
`camelizeKeys(raw)` converts keys without decoding. Helpers: `all(ex, sql, params, codec)`,
`one(…)` (throws `NoRowsError`), `maybeOne(…)`, `exec(ex, sql, params) → rowCount`.
**Never select `vector`/`tsvector` columns** (the Data API cannot return them) — select
`embedding IS NOT NULL` instead; `bytea` is selected as `encode(…, 'base64')`.

## 3. Errors

All errors extend `DbError { sqlState, constraint, isUniqueViolation, isPermissionDenied, isCheckViolation,
isForeignKeyViolation }`. Messages never contain row values, parameters or driver detail text (the
original error is `cause` — do not log it verbatim).

| Error / SQLSTATE                                                             | Suggested API mapping                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------- |
| `DatabaseResumingError` (`code: 'database_resuming'`, `retryAfterSeconds`)   | 503 `database_resuming`                           |
| `23505` unique                                                               | 409 `conflict`                                    |
| `42501` RLS / privilege (also `RAISE … 42501` from SECURITY DEFINER helpers) | 403 `forbidden` (or 404 to avoid existence leaks) |
| `23503`, `23514`, `22P02`                                                    | 400/422                                           |
| `55000` (escalation not routable)                                            | 409 `conflict`                                    |
| `NoRowsError`                                                                | 404 `not_found`                                   |
| `SqlUsageError`, `DbDecodeError`, `MigrationChecksumError`                   | 500 `internal` (programming/deploy error)         |

## 4. Drivers

- **`createPgDriver(config)`** — `pg.Pool`, one pooled client per transaction (`BEGIN`/`COMMIT`/`ROLLBACK`;
  a client whose rollback failed is destroyed). Timestamps, json, numeric and int8 are returned as text so
  the codecs see the same primitives as with the Data API.
- **`createDataApiDriver(config)`** — `ExecuteStatement` with `formatRecordsAs: 'JSON'` (SELECTs) and
  `includeResultMetadata` (RETURNING statements come back as typed records; both are decoded to the same
  rows), `BeginTransaction`/`CommitTransaction`/`RollbackTransaction`. Retries with exponential backoff
  (500 ms doubling to 8 s, ±25 % jitter) within a **45 s budget** on `DatabaseResumingException` (and the
  older `BadRequestException: Communications link failure`), throttling, and — outside transactions —
  `DatabaseUnavailableException`; `begin`/`rollback` also retry ambiguous network errors; `commit` never
  retries an ambiguous failure. After the budget a resuming/unavailable cluster raises
  `DatabaseResumingError`. `onRetry({ operation, errorName, attempt, delayMs })` is the only observability
  hook (no SQL text). `DEFAULT_RETRY_POLICY`, `dataApiClientFromSdk(RDSDataClient)` are exported for tests.

## 5. Migrations

- SQL files in `migrations/NNNN_name.sql` are bundled into `src/migrations/bundle.generated.ts`
  (Lambda bundles carry no filesystem): `pnpm --filter @foundry/db gen:migrations`; CI runs
  `pnpm --filter @foundry/db check:migrations` (and a unit test compares the bundle with the files).
- `migrate(db, { migrations?, onEvent? }) → { applied, alreadyApplied, unknown }` — runs as the owner,
  one transaction per migration holding `pg_advisory_xact_lock(7012025)` (concurrent runners serialise),
  creates `schema_migrations(version, checksum, applied_at)`, verifies the checksum of every applied
  migration on every run (`MigrationChecksumError`, never auto-repaired), applies pending ones in version
  order. Statements are split with the lexer (`splitStatements`: `$$`/`$tag$` bodies, nested comments,
  `E''` strings, quoted identifiers) and executed one per call — required by the Data API, used by both
  drivers. Idempotent; `unknown` lists versions the database has but the build does not.
- Migrations must run as a role like Aurora's master user (LOGIN CREATEROLE CREATEDB, **not** superuser)
  after `vector` and `pgcrypto` exist. `0001` creates `app_rls` (NOLOGIN NOBYPASSRLS) and grants it to the
  migrating role.
- Every statement of a migration after 0002 is re-runnable (`CREATE OR REPLACE`, `DROP … IF EXISTS` before
  `CREATE`, `ON CONFLICT DO NOTHING`, idempotent `UPDATE`/`DELETE`); `migrate-0003.db.test.ts` applies 0003
  on top of 0001 + 0002 with existing data, checks the clean-up, re-runs every statement one per call and
  compares the policies, functions, triggers and settings. New functions revoke `EXECUTE` from `PUBLIC`
  and grant it to `app_rls` only where requests need them. Statements selected through the Data API must
  not return a `void` column (wrap `pg_advisory_xact_lock` in `SELECT count(*) … FROM (SELECT …)`).

## 6. Repositories

All are namespaces exported from the package root: `import { memoryRepo } from '@foundry/db'`. The first
argument is the executor. **(S)** = requires `SystemExecutor`. Writes that RLS checks against the request
principal (`createdBy`, `authorId`, `startedBy`, `uploadedBy`, `actorId`, `reviewerId`, …) must pass that
principal. Return types reuse `@foundry/contracts` views wherever one exists (`VentureSummary`,
`MemoryObjectView`, `DocumentView`, `SessionView`, `TurnView`, `EvidenceItem`, `EscalationView`,
`EscalationQueueItem`, `PersonaView`, `PersonaReleaseView`, `ResourceView`, `TeamMemberView`,
`ProgramVentureRow`, `PlatformSettingsView`, `PortfolioSummary`, `AuditEventView`, `TenantView`,
`PrincipalView`).

| Namespace             | Functions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tenantsRepo`         | `getTenant`, `getTenantBySlug`, `listTenants` (S), `upsertTenant` (S), `toTenantView`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `principalsRepo`      | `getPrincipal`, `listPrincipals({tenantId,status?,ids?})`, `createPrincipal`, `updatePrincipal`, `listActiveRoles({principalId,tenantId}) → PlatformRole[]`, `listEscalationAssignees(tenantId)` (active EIRs and program leads with expertise tags; RLS), `listRoleGrants`, `grantRole` (platform_admin stored tenant-less), `revokeRole`, `listMembershipsForPrincipals(ids)`, `listAssignedVentureIds(principalId)`, `countPrincipals`, `toPrincipalView`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `authRepo` (S)        | `findAccessCodeByPrefix(prefix) → {id, principalId, tenantId, codeHash, expiresAt, revokedAt, principalStatus, tenantStatus}`, `accessCodePrefixExists`, `createAccessCode`, `markAccessCodeUsed`, `revokeAccessCode` (also revokes its sessions), `getAccessCode`, `listActiveAccessCodes(principalIds)`, `createAuthSession`, `getAuthSession` (with principal status + code revocation, for the 60 s cache), `revokeAuthSession`, `revokeAuthSessionsForPrincipal`, `recordAuthAttempt → id`, `reserveAuthAttempt({subjectHash, windowSeconds, failureLimit}) → {attemptId \| null, failures, lastFailureAt}` (per-subject advisory lock; records the attempt as failed before verification; call inside a transaction), `markAuthAttemptSucceeded`, `deleteAuthAttempt`, `authFailureWindow({subjectHash, windowSeconds}) → {failures, lastFailureAt}`, `pruneAuthAttempts`, `getActivePlatformKey(purpose) → {keyBase64,…}`, `listVerificationKeys({purpose, graceSeconds})`, `rotatePlatformKey` |
| `venturesRepo`        | `getVenture`, `listVentureSummaries({principalId, tenantId, scope: 'member' \| 'tenant', includeArchived?}) → VentureSummary[]` (open actions, pending memory, open escalations, last session — counts respect RLS), `getVentureSummary`, `getVentureAccess({ventureId, principalId}) → {membershipRole, isAssignedEir, tenantId, ventureStatus} \| null` (authz input), `createVenture`, `updateVenture`, `listProgramVentures(tenantId)`, `listVentureMemberNames(tenantId)` (S; member display names per venture of one tenant, guard input only, never returned to callers), `listTeam(ventureId)`, `addMembership` (updates role/expiry of an active membership), `revokeMembership`                                                                                                                                                                                                                                                                                                              |
| `eirRepo`             | `listEirProfiles`, `getEirProfile`, `getEirProfileByPrincipal`, `createEirProfile`, `updateEirProfile`, `toEirProfileView`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `personasRepo`        | `getPersona`, `createPersona`, `setPersonaStatus({personaId, status, reason?})` (kill switch), `getRelease`, `listReleases`, `getActiveRelease` (newest approved, unexpired), `createRelease` (next version, draft), `approveRelease` (supersedes previous approved), `withdrawRelease`, `listPersonaViews(tenantId)`, `getPersonaView`, `createConsent`, `getConsent`, `listConsents`, `revokeConsent` (suspends personas relying on it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `assignmentsRepo`     | `resolveActiveAssignment(ventureId) → {assignment, persona{status…}, release \| null, eir \| null} \| null` (run on every session create and turn), `getAssignment`, `listAssignments`, `createAssignment` (ends the previous active one), `setAssignmentStatus`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `knowledgeRepo`       | `createKnowledgeSource`, `getKnowledgeSource`, `listKnowledgeSources`, `setKnowledgeSourceStatus`, `insertChunks({sourceId, tenantId, scope, ventureId?, personaId?, chunks:[{ordinal, heading?, content, tokenCount?, embedding?}]})` (batched, 1024-d check), `countChunks`, `deleteChunksForSource` (S), `listChunksMissingEmbeddings` (S), `setChunkEmbeddings` (S), `listMemoryMissingEmbeddings` (S), `setMemoryEmbeddings` (either executor; status-guarded: only `proposed`/`confirmed`/`disputed` items, so a deleted item never regains a vector), `EMBEDDING_DIMENSIONS`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `documentsRepo`       | `createDocument` (pass `id` when it is part of the S3 key), `getDocument`, `setDocumentStatus({documentId, status, failureReason?, sourceId?, fromStatuses?})`, `softDeleteDocument → s3Key \| null` (chunks removed, source withdrawn, evidence titles redacted), `listDocuments(ventureId) → DocumentView[]`, `getDocumentView`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `memoryRepo`          | `getMemory`, `getMemoryByIds`, `listMemory({ventureId, type?/types?, status?/statuses?, q?, pinned?, visibility?, createdSince?, updatedSince?, openOnly?, dueBefore?, dueOnOrAfter?, orderBy?, limit?})`, `countPendingMemory`, `createMemory` (+ `proposed`/`created` event), `approveMemory`, `rejectMemory`, `disputeMemory`, `setMemoryPinned`, `correctMemory({memoryId, actorId, patch, reason?})` (supersedes: new version + `superseded`/`corrected` events), `supersedeMemory({memoryId, replacementId, actorId})`, `deleteMemory → versions` (`app.soft_delete_memory`: all versions erased, history redacted), `listMemoryHistory → MemoryEventView[]` (whole version chain), `appendMemoryEvent`, `ACTIVE_MEMORY_STATUSES`, `CLOSED_ITEM_STATUSES`                                                                                                                                                                                                                                        |
| `retrievalRepo`       | `searchVentureMemory`, `searchVentureChunks`, `searchSharedChunks`, `searchResources`, `searchPatterns` → `RetrievedItem[]` (see §7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `sessionsRepo`        | `createSession`, `getSession`, `getSessionView`, `listSessionViews({ventureId, limit?, status?})`, `endSession({sessionId, recap})`, `setSessionStatus`, `setSessionMode`, `lastSessionAt({ventureId, exceptSessionId?})`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `turnsRepo`           | `createTurn` (next ordinal; concurrent creates → unique violation), `finishTurn({turnId, status, response, validatorResults, modelId, tokens, costUsd, latencyMs, sampledForReview, …})`, `getTurn`, `listTurns`, `listRecentTurns({sessionId, limit=8})`, `countSessionTurns`, `countRecentTurnsByAuthor({authorId, windowSeconds})`, `insertTurnEvidence(turnId, items)`, `listTurnEvidence(turnIds) → Map<turnId, EvidenceItem[]>`, `blockedReason(turn)`, `toTurnView(turn, evidence, blocked)`, `listTurnViews(sessionId, supportMessageFor)` (blocked turns carry reason, support message and drafted escalation), `upsertFeedback`, `listReviewQueue({reviewerId})`, `upsertEirReview`, `redactSessionTurns(sessionId)` (ephemeral session end, under RLS)                                                                                                                                                                                                                                      |
| `escalationsRepo`     | `createEscalation` (`draft` or `awaiting_consent`), `getEscalation`, `listVentureEscalations`, `listInboxEscalations({assigneeId})`, `countOpenEscalations`, `updateEscalationPacket`, `escalationIdsByTurn(turnIds)`, `recordSharingConsent({escalationId, consentBy, assigneeId?, dueAt?, packet?})` (→ `routed` with an assignee, else `awaiting_assignment`), `transitionEscalation({escalationId, action: 'acknowledge' \| 'resolve' \| 'decline' \| 'withdraw', actorId, resolution?})`, `routeEscalation` (program lead, via `app.route_escalation`: consented and open, to an active EIR or program lead of the tenant), `escalationQueue()` (metadata only, via `app.escalation_queue()`)                                                                                                                                                                                                                                                                                                     |
| `resourcesRepo`       | `listResources({tenantId, kind?, stage?, tag?, q?, statuses?})`, `getResource`, `createResource`, `updateResource`, `listPatterns`, `createPattern`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `usageRepo` (S)       | `recordUsage`, `spendToday({principalId?})` (current **UTC** day), `spendLastDays`, `usageByDay(days)` (zero-filled), `usageByModel(days)`, `getUsageSummary(days)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `auditRepo`           | `appendAudit(ex, event) → id` (app executor → `app.audit`, tenant/actor/request from context; system → `app.append_audit`), `listAuditEvents` (S, keyset cursor, `{items, nextCursor}`), `verifyAuditChain` (S, resumable), `assertAuditMetadata` (identifiers/counts/flags only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `settingsRepo`        | `getPlatformSettings(ex) → PlatformSettingsView` (fail-closed defaults), `updatePlatformSettings` (S)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `idempotencyRepo` (S) | `getIdempotencyRecord` (24 h window), `saveIdempotencyRecord` (false when a live record exists), `reserveIdempotencyKey → reserved \| replay \| in_progress \| mismatch` (stale in-progress reservations, default 120 s, are taken over), `completeIdempotencyKey` (2xx only), `releaseIdempotencyKey`, `pruneIdempotencyKeys`. Deleting memory or a document purges stored responses that mention it (migration 0002).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `portfolioRepo`       | `getPortfolioSummary(ex) → PortfolioSummary` (k-anonymous via `app.portfolio_summary()`; 42501 unless program lead/admin)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Role visibility enforced by RLS (verified by `rls.db.test.ts`)

| Principal                 | Memory                                                     | Sessions/turns                                       | Documents/chunks           | Escalations                            |
| ------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- | -------------------------- | -------------------------------------- |
| founder / team            | all of own venture except other members' `founder_private` | own venture                                          | own venture                | own venture                            |
| advisor                   | `venture` + `advisors` visibility                          | none                                                 | read                       | none                                   |
| assigned EIR              | `venture` + `advisors` of assigned ventures                | sampled turns of standard (never ephemeral) sessions | read                       | when assignee **and** consented        |
| program lead (non-member) | none                                                       | none                                                 | none (shared corpora only) | queue metadata via `escalationQueue()` |
| no context                | nothing (every table returns 0 rows or permission denied)  |                                                      |                            |                                        |

Credential, ledger and audit tables (`access_codes`, `auth_sessions`, `auth_attempts`, `platform_keys`,
`usage_ledger`, `audit_events`, `idempotency_keys`, `schema_migrations`) are closed to `app_rls`.

`founder_private` items are readable by their author only, and nothing other people read may carry them:
turn evidence cannot cite them (insert policy), retrieval for coaching never returns them (see §7),
escalation packets reject them, and recaps and AI memory candidates are built from evidence without them
(`security-0003.db.test.ts`, `apps/api/src/security-review.db.test.ts`).

## 7. Hybrid retrieval

`score = 0.55·max(0, 1 − cosine_distance) + 0.25·ts_rank_cd(tsv, q, 32) + 0.10·recency + 0.10·authority`
(`RETRIEVAL_WEIGHTS`), recency = 0.5^(age_days / 90). The lexical query ORs the stemmed words of the text
(`websearch_to_tsquery` with `&` → `|`). NULL embeddings (or `embedding: null` queries) score lexically
only. Results carry `{kind, refId, title, excerpt (≤ 600 chars), score, freshnessAt, status, ventureId,
sourceId, memoryType, components}`; core assigns `E1…En`.

- `searchVentureMemory({tenantId, ventureId, query, embedding, statuses?, types?, privateOwnerId?, limit=8})`
  — filters tenant + venture first, exact scan; statuses default proposed/confirmed/disputed (disputed =
  contradiction signal); authority = 1 if pinned else status weight (confirmed 1, disputed .5, proposed .4)
  × (0.5 + 0.5·confidence). `founder_private` items are excluded unless `privateOwnerId` is their author;
  core never passes it (`privateRetrievalOwner` returns null: turns, their evidence and their derived
  memory are read by the team and sampled for EIR review, so private items stay out of coaching).
- Lists stay well under the Data API's 1 MB response limit: memory lists return a 400-character excerpt
  plus `content_length` (`GET /memory/:id` returns the full item) with `LIMIT`/`OFFSET` paging; turns,
  sessions and escalations select ids first and load rows in small batches (`fetchByIdsInBatches`).
- `searchVentureChunks({…, limit=6})` — the venture's own document chunks; withdrawn sources excluded.
- `searchSharedChunks({tenantId, query, embedding, personaId?, scopes?, classifications?, candidates=40, limit=4})`
  — program/public/persona corpora (`venture_id IS NULL`): ANN candidates from the partial **HNSW** index
  ∪ lexical candidates, then rescored; persona chunks (kind `doctrine`) only for `personaId`.
- `searchResources({tenantId, query, stage?, limit=4})` — 0.55 lexical + 0.25 stage fit + 0.10 recency + 0.10 authority.
- `searchPatterns({tenantId, query, limit=2})` — published, unexpired.

## 8. Memory attribute conventions

`memory_objects.attributes` is free-form JSON; the seed, list filters and portfolio use these keys:

| Type         | Attributes                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `action`     | `owner`, `due` (YYYY-MM-DD), `status`: open \| in_progress \| done \| dropped                                                           |
| `milestone`  | `owner`, `target_date` (YYYY-MM-DD), `status`: planned \| in_progress \| done \| missed                                                 |
| `experiment` | `prediction`, `method`, `sample_size`, `success_criteria`, `result`, `status`: planned \| running \| completed \| abandoned, `decision` |
| `decision`   | `rationale`, `alternatives[]`, `reversal_condition`, `decided_on`                                                                       |
| `hypothesis` | `assumption_type` (desirability \| viability \| feasibility), `riskiness`                                                               |
| `evidence`   | `source`, `collected_on`, `n`, `strength` (behaviour \| commitment \| statement \| secondary)                                           |
| `risk`       | `likelihood`, `impact`, `mitigation`                                                                                                    |

`openOnly` excludes `attributes.status` in `CLOSED_ITEM_STATUSES`; `dueBefore`/`dueOnOrAfter` use `due` or
`target_date`. Lifecycle: `proposed → confirmed` (approve) / `rejected`; `confirmed → disputed`;
any active → `superseded` by a correction (new version, `supersedes_id`); delete erases all versions.
AI-origin items can never be confirmed without `approved_by` (DB check constraint).

## 9. Seed (synthetic only)

- `seedDatabase(db, config) → SeedResult` / `seed(sx, config)`; `seedConfigFromEnv(env)` reads
  `HOME_TENANT_SLUG`, `HOME_TENANT_NAME`, `OWNER_DISPLAY_NAME`, `OWNER_ACCESS_CODE_PREFIX`,
  `OWNER_ACCESS_CODE_HASH` (required when `APP_ENV=production`).
- Idempotent and safe on every deploy: deterministic UUIDv5 ids (`seedId(tenantSlug, …parts)`),
  `ON CONFLICT DO NOTHING` — product changes (suspended persona, deleted memory, revoked demo roles) are
  never overwritten. The owner principal always holds `platform_admin` + `program_lead` and is bound to the
  configured code (hash follows config; a code revoked in the product stays revoked; old deploy codes are
  revoked when the prefix changes). Demo principals get **no** access codes.
- Content: Foundry Guide (neutral, `active`) with approved release v1 (`GUIDE_DOCTRINE`, `GUIDE_STYLE`,
  `DEFAULT_DISCLOSURE`), a persona doctrine corpus and a program-method corpus (shared chunks), 2 synthetic
  EIRs + 1 program lead (invented names), 4 ventures (QuietQuad — campus consumer app / discovery;
  BenchTally — B2B lab software / validation; SoleSignal — medical-device concept / business model, with an
  advisor; EmberLoop — climate hardware / commercialization), each with members, an active assignment,
  12–13 memory items, 1–2 documents (chunks without embeddings) and a canary
  `ventureCanary(slug)` = `CANARY::<slug>::<8 chars>` in one memory item and one chunk; 16 program
  resources; 3 published patterns; one consented escalation. `SeedResult` returns all ids and canaries.
- Embeddings are backfilled by the migrate handler: `knowledgeRepo.listChunksMissingEmbeddings` →
  embed → `setChunkEmbeddings` (same for memory).
- Access-code utilities (runtime-contract format): `generateAccessCode()`, `accessCodePrefix(code)`,
  `hashAccessCode(code)` (`scrypt$N=32768,r=8,p=1$salt$key`, maxmem 64 MiB), `verifyAccessCode(code, hash)`
  (timingSafeEqual), `isAccessCodeHash(hash)`, `normalizeAccessCode`.

## 10. Testing

```ts
import { createTestDatabase, makeContext } from '@foundry/db/testing';

const t = await createTestDatabase({ seed: true }); // fresh database per test file
const founder = t.seed!.ventures[0]!.members[0]!.principalId;
await t.db.withContext(makeContext(founder, t.seed!.tenantId), (tx) => …);
await t.cleanup(); // closes the pool, drops the database
```

- The superuser (`TEST_DATABASE_ADMIN_URL`, default
  `postgresql://postgres@localhost/postgres?host=/var/tmp&port=54329`) creates the database and the
  `vector`/`pgcrypto` extensions; migrations and the app run as the non-superuser `fa_master`
  (LOGIN CREATEROLE CREATEDB), mirroring Aurora. CI: a `pgvector/pgvector:pg16` service container with
  `TEST_DATABASE_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres`.
- `TestDatabase { db, url, adminUrl, name, migrations, seed, ownerAccessCode, cleanup() }`; options
  `{ migrate?, seed?: boolean | Partial<SeedConfig>, adminUrl? }`. Stale `fa_t_*` databases (> 6 h) are
  dropped automatically.
- Scripts: `pnpm --filter @foundry/db test` (unit), `test:db` (`*.db.test.ts`), `typecheck`,
  `gen:migrations`, `check:migrations`, `db:reset` (local only: recreates database `foundry`
  (`LOCAL_DB_NAME`), migrates as `fa_master`, seeds and prints `DATABASE_URL` and a fresh DEV owner code),
  `owner-code` (trusted machine only, refuses CI: a new production owner code, printed once, plus the
  prefix and hash for `infra/cdk/config/production.json`; see the access-codes runbook).

## 11. Logging and content

This package never logs. Callers must not log SQL text, parameters, row values or `DbError.cause`
(driver messages can echo content); log identifiers, counts, `sqlState` and timings only.
