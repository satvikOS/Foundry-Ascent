# ADR-0004: Venture isolation in the service layer and the database

- **Status:** Accepted (deployment blocker)
- **Date:** 2026-10-05
- **Deciders:** Platform owner
- **Blueprint basis:** 03 §1 "Isolation", §6 retrieval rules 1–2, §8 "Isolation, security, and privacy
  controls", §14 "Cross-venture exfiltration", §26 ADR-004 (required); 01 §9 privacy gate (0 events)

## Context and problem statement

Founders trust the platform with decks, customers, finances and conversations. A single cross-venture
disclosure is a kill criterion (01 §9). Blueprint 03 §1 forbids relying on prompts to enforce
confidentiality, and §6 requires authorization filters **before** semantic ranking with no unscoped
global vector search. How do we make isolation hold even when one layer has a bug?

## Decision drivers

- Defence in depth: an application bug must not be enough to leak another venture's rows.
- Browser-supplied ids are never authority; membership and assignment are re-derived per request.
- The Aurora master user is not a superuser, so the design must work without `BYPASSRLS` tricks.
- Credentials, ledgers and audit must be unreachable from request-scoped code.

## Considered options

1. **Service authorization + PostgreSQL row level security under a dedicated role** (chosen).
2. Service-layer checks only (ORM scopes, repository filters).
3. Database per venture / schema per tenant.

## Decision outcome

Chosen option: **1**.

- **Service:** every request resolves `RequestContext {principalId, tenantId, roles, requestId}` server
  side; venture operations call `authz.requireVentureAccess(ctx, ventureId, action)`, which reads
  membership and assignment from the database and audits allow/deny decisions.
- **Database:** request work runs in `db.withContext()`, a transaction whose first statement switches to
  role `app_rls` (`NOLOGIN NOBYPASSRLS`, owns nothing) and sets `app.principal_id`, `app.tenant_id`,
  `app.request_id`. Every table has RLS enabled; policies call `SECURITY DEFINER` helpers in schema `app`
  (`current_principal`, `has_role`, `venture_role`, `is_assigned_eir`, `can_read_venture`,
  `can_write_venture`, `can_see_item`, …) with a pinned `search_path`, so policies never recurse and
  cannot be hijacked. Credential, usage, audit and idempotency tables grant nothing to `app_rls`; only the
  explicitly named `db.system()` executor (owner role) touches them.
- **Retrieval:** every query filters tenant + venture + visibility first; shared corpora have
  `venture_id IS NULL`; per-venture canaries are planted by the seed for red-team tests.

### Consequences

- Good: a missing service check still returns zero rows; a missing policy fails closed for `app_rls`.
- Good: one shared schema keeps operations and migrations simple at V1 scale.
- Bad: every query pays the context-setting statement and policy evaluation (acceptable at V1 volume).
- Bad: `db.system()` is a deliberate escape hatch; each use needs review (`grep "db.system("`).

### Confirmation

- `packages/db/src/rls.db.test.ts`: wrong principal → 0 rows for every table; `app_rls` has no access to
  credential/ledger/audit tables; the `role` GUC switch is verified.
- `packages/core/src/authz/authz-matrix.db.test.ts`: role × venture × visibility × revoked/expired matrix.
- Red-team suite in `evals/` (≥ 100 cross-venture and injection cases with canaries); gate 0 disclosures.

## Revisit trigger

- A partner university requires physical data separation or regional residency (05 §13): move that
  tenant to its own cluster ("regional data plane") while keeping both layers. Never drop either layer.
