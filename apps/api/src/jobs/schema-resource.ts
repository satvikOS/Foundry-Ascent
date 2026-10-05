import { type Db, DbError, migrate, type SeedConfig, seedDatabase } from '@foundry/db';
import type { CdkCustomResourceEvent, CdkCustomResourceResponse } from 'aws-lambda';

import { errorFields, type Logger } from '../logging.js';
import { type BackfillOptions, type BackfillReport } from './embedding-backfill.js';

/** Stable physical id: updates never look like replacements, so CloudFormation never sends a Delete. */
export const SCHEMA_PHYSICAL_RESOURCE_ID = 'foundry-ascent-schema';

export interface SchemaResourceDeps {
  readonly db: Db;
  readonly seedConfig: SeedConfig;
  /** Best-effort seed embeddings; null skips them. */
  readonly backfill: ((options: Omit<BackfillOptions, 'purpose'>) => Promise<BackfillReport>) | null;
  readonly logger: Logger;
  readonly now?: () => number;
  /** Backoff sleep (tests inject a fake). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SchemaInvocation {
  /** Lambda `context.getRemainingTimeInMillis`. */
  readonly remainingMs: () => number;
  readonly requestId: string;
}

/**
 * Aurora (min 0 ACU, auto-pause) is usually paused at deploy time; resuming takes ~15 s and occasionally
 * much longer. The resume wait gets up to 5 minutes, but always leaves {@link MIGRATE_RESERVE_MS} of the
 * 10-minute Lambda for migrations, seed and the response.
 */
export const MAX_WAKE_BUDGET_MS = 5 * 60_000;
export const MIGRATE_RESERVE_MS = 4 * 60_000;
/** Never wait less than this for the resume, even when invoked with little time left. */
const MIN_WAKE_BUDGET_MS = 30_000;
/**
 * Time kept for the response and the provider framework after the backfill. One in-flight embedding batch
 * (16 texts, concurrency 4, 15 s per call) can outlive the backfill deadline by up to a minute unless it
 * is aborted, so the backfill also aborts the gateway call at its deadline (embedding-backfill.ts).
 */
export const RESPONSE_MARGIN_MS = 120_000;
/**
 * A freshly created or updated Lambda role can be refused by the Data API or Secrets Manager for a short
 * while (IAM propagation). During the wake-up only, AccessDeniedException / ForbiddenException are retried
 * for about this long before the deployment fails.
 */
export const IAM_PROPAGATION_RETRY_MS = 60_000;
const IAM_RETRY_DELAY_MS = 5_000;
const IAM_PROPAGATION_ERRORS = new Set(['AccessDeniedException', 'ForbiddenException']);

/** True when `err` (or the driver error it wraps) is an IAM authorization refusal from AWS. */
export function isIamPropagationError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const name = (current as { name?: unknown }).name;
    if (typeof name === 'string' && IAM_PROPAGATION_ERRORS.has(name)) return true;
    if (current instanceof DbError && current.sqlState !== null) return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
/** The embedding backfill is bounded by items and time; whatever remains is left to a later run. */
export const BACKFILL_MAX_ITEMS = 5_000;
const BACKFILL_MAX_MS = 5 * 60_000;

/** How long the handler waits for Aurora to resume, given the remaining Lambda time. */
export function wakeBudgetMs(remainingMs: number): number {
  return Math.max(MIN_WAKE_BUDGET_MS, Math.min(MAX_WAKE_BUDGET_MS, remainingMs - MIGRATE_RESERVE_MS));
}

export type SchemaResponse = CdkCustomResourceResponse<Record<string, string>>;

/**
 * `onEvent` of the migrations custom resource (CDK Provider framework):
 * - Create / Update: wake the database, apply pending migrations (advisory-locked, checksummed), run the
 *   idempotent synthetic seed with the deploy owner from the environment, then backfill embeddings for
 *   seed chunks/memory (best effort, bounded by item count and the Lambda deadline).
 * - Delete: no-op (the schema outlives the stack resource; the Data stack is termination-protected).
 * Failures of migrations or seed fail the deployment (the App stack rolls back before new code serves
 * traffic); embedding failures never do.
 */
export async function handleSchemaEvent(
  deps: SchemaResourceDeps,
  event: CdkCustomResourceEvent,
  invocation: SchemaInvocation,
): Promise<SchemaResponse> {
  const now = deps.now ?? Date.now;
  const log = deps.logger.child({
    requestId: invocation.requestId,
    requestType: event.RequestType,
    logicalResourceId: event.LogicalResourceId,
  });
  if (event.RequestType === 'Delete') {
    log.info('schema.delete_ignored');
    return { PhysicalResourceId: SCHEMA_PHYSICAL_RESOURCE_ID };
  }

  const started = now();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // DatabaseResumingException is retried with backoff inside the Data API driver until the budget; after
  // it a DatabaseResumingError fails the deployment (nothing has been changed yet). IAM refusals right
  // after the role was created or changed are retried here for IAM_PROPAGATION_RETRY_MS.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await deps.db.ping({ maxWaitMs: wakeBudgetMs(invocation.remainingMs()) });
      break;
    } catch (err) {
      if (!isIamPropagationError(err) || now() - started + IAM_RETRY_DELAY_MS > IAM_PROPAGATION_RETRY_MS) {
        throw err;
      }
      log.warn('schema.iam_propagation_retry', { attempt, waitedMs: Math.round(now() - started) });
      await sleep(IAM_RETRY_DELAY_MS);
    }
  }
  log.info('schema.database_awake', { waitedMs: Math.round(now() - started) });
  const report = await migrate(deps.db, {
    onEvent: (e) => {
      if (e.type === 'applied') {
        log.info('schema.migration_applied', {
          version: e.version,
          statements: e.statements,
          durationMs: e.durationMs,
        });
      }
    },
  });
  if (report.unknown.length > 0) {
    // A rollback deploy: the database already has newer migrations. They are kept (never auto-reverted).
    log.warn('schema.unknown_migrations', { versions: report.unknown.join(',') });
  }
  // Idempotent (deterministic ids, ON CONFLICT DO NOTHING); binds the deploy owner's access code hash.
  const seed = await seedDatabase(deps.db, deps.seedConfig);
  log.info('schema.seeded', { ventures: seed.ventures.length, owner: seed.ownerId !== null });

  let backfill: BackfillReport | null = null;
  if (deps.backfill !== null) {
    const budget = Math.min(BACKFILL_MAX_MS, invocation.remainingMs() - RESPONSE_MARGIN_MS);
    if (budget > 0) {
      try {
        backfill = await deps.backfill({
          requestId: invocation.requestId,
          maxItems: BACKFILL_MAX_ITEMS,
          deadline: now() + budget,
        });
        // Counts only. Items left over (budget, deadline, Bedrock throttling) keep a NULL embedding: lexical
        // retrieval still finds them, and the next deploy or a worker `backfill_embeddings` job embeds them.
        log.info('schema.embeddings_backfilled', { ...backfill });
      } catch (err) {
        // Never fails the deployment: the schema and seed are already committed.
        log.warn('schema.embeddings_backfill_failed', errorFields(err));
      }
    } else {
      log.warn('schema.embeddings_backfill_skipped', { remainingMs: invocation.remainingMs() });
    }
  }

  log.info('schema.done', {
    applied: report.applied.length,
    alreadyApplied: report.alreadyApplied.length,
    durationMs: Math.round(now() - started),
  });
  return {
    PhysicalResourceId: SCHEMA_PHYSICAL_RESOURCE_ID,
    Data: {
      MigrationsApplied: report.applied.join(',') || 'none',
      MigrationsTotal: String(report.applied.length + report.alreadyApplied.length),
      ChunksEmbedded: String(backfill?.chunks ?? 0),
      MemoryEmbedded: String(backfill?.memory ?? 0),
      EmbeddingsComplete: String(backfill?.remaining === false),
    },
  };
}
