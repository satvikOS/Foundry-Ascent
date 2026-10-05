/**
 * Typed repositories. Every function takes an executor as its first argument:
 *  - `SqlExecutor` — either `db.withContext(ctx, tx => …)` (RLS as app_rls) or `db.system(sx => …)`.
 *  - `SystemExecutor` — owner-only tables (credentials, ledgers, audit reads, idempotency keys).
 * Writes that RLS checks against the request principal (created_by, author_id, …) must pass that principal.
 */
export * as tenantsRepo from './tenants.js';
export * as principalsRepo from './principals.js';
export * as authRepo from './auth.js';
export * as venturesRepo from './ventures.js';
export * as eirRepo from './eir.js';
export * as personasRepo from './personas.js';
export * as assignmentsRepo from './assignments.js';
export * as knowledgeRepo from './knowledge.js';
export * as documentsRepo from './documents.js';
export * as memoryRepo from './memory.js';
export * as retrievalRepo from './retrieval.js';
export * as sessionsRepo from './sessions.js';
export * as turnsRepo from './turns.js';
export * as escalationsRepo from './escalations.js';
export * as resourcesRepo from './resources.js';
export * as usageRepo from './usage.js';
export * as auditRepo from './audit.js';
export * as settingsRepo from './settings.js';
export * as idempotencyRepo from './idempotency.js';
export * as portfolioRepo from './portfolio.js';
export { EXCERPT_CHARS } from './common.js';
