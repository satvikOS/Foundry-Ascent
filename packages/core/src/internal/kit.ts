import { type ModelAttempt, type ModelPurpose } from '@foundry/ai';
import { auditRepo, isUuid, usageRepo, type AppExecutor, type SystemExecutor } from '@foundry/db';

import { toDbContext, type RequestContext } from '../context.js';
import { type ResolvedDeps } from '../deps.js';
import { fail, toDomainError } from '../errors.js';

export type AuditEvent = auditRepo.AuditEventInput;

/** What a service sees inside one request transaction. */
export interface RequestScope {
  readonly ctx: RequestContext;
  /** RLS-scoped executor (role app_rls with the request's principal and tenant). */
  readonly tx: AppExecutor;
  /**
   * Records an audit event that must survive a rollback (authorization denials). It is appended after
   * the transaction ends, on the owner connection, with the request's tenant/actor/request id.
   */
  deferAudit(event: AuditEvent): void;
  /** Best-effort work after a successful commit (embeddings, object deletion). Failures are logged. */
  afterCommit(task: () => Promise<void>): void;
}

/**
 * Shared plumbing for services: request transactions with deferred denial audits, system work,
 * audit/usage helpers and error mapping. Never nests transactions (a request transaction holding the
 * audit-chain lock must not wait on a second connection).
 */
export class Kit {
  constructor(readonly deps: ResolvedDeps) {}

  get config(): ResolvedDeps['config'] {
    return this.deps.config;
  }

  now(): Date {
    return this.deps.clock.now();
  }

  /** Runs `fn` in one RLS transaction for the request. Errors are mapped to DomainErrors. */
  async inRequest<T>(ctx: RequestContext, fn: (scope: RequestScope) => Promise<T>): Promise<T> {
    const deferred: AuditEvent[] = [];
    const after: (() => Promise<void>)[] = [];
    let result: T;
    try {
      result = await this.deps.db.withContext(toDbContext(ctx), (tx) =>
        fn({
          ctx,
          tx,
          deferAudit: (event) => deferred.push(event),
          afterCommit: (task) => after.push(task),
        }),
      );
    } catch (err) {
      await this.flushDeferred(ctx, deferred);
      throw toDomainError(err);
    }
    await this.flushDeferred(ctx, deferred);
    for (const task of after) {
      try {
        await task();
      } catch (err) {
        this.deps.logger.warn('core.after_commit_failed', {
          requestId: ctx.requestId,
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
    }
    return result;
  }

  /**
   * Owner-role work (credentials, ledgers, audit reads, tenant directory). Every caller must have
   * authorized the request first or be processing a server-generated job.
   */
  async system<T>(fn: (sx: SystemExecutor) => Promise<T>, options?: { transaction?: boolean }): Promise<T> {
    try {
      return await this.deps.db.system(fn, options);
    } catch (err) {
      throw toDomainError(err);
    }
  }

  /** Appends deferred audit events after the request transaction (never throws). */
  async flushDeferred(ctx: RequestContext, events: readonly AuditEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.deps.db.system(
        async (sx) => {
          for (const event of events) {
            await auditRepo.appendAudit(sx, {
              ...event,
              tenantId: ctx.tenantId,
              actorId: ctx.principalId,
              requestId: ctx.requestId,
            });
          }
        },
        { transaction: false },
      );
    } catch (err) {
      this.deps.logger.error('core.audit_flush_failed', {
        requestId: ctx.requestId,
        events: events.length,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  /** Records one usage-ledger row per billable model attempt (system, autocommit, never throws). */
  async recordUsage(args: {
    readonly ctx: Pick<RequestContext, 'tenantId' | 'requestId'> & { readonly principalId: string | null };
    readonly ventureId: string | null;
    readonly purpose: ModelPurpose;
    readonly attempts: readonly Pick<ModelAttempt, 'modelId' | 'usage' | 'costUsd'>[];
  }): Promise<void> {
    if (args.attempts.length === 0) return;
    try {
      await this.deps.db.system(
        async (sx) => {
          for (const attempt of args.attempts) {
            await usageRepo.recordUsage(sx, {
              tenantId: args.ctx.tenantId,
              ventureId: args.ventureId,
              principalId: args.ctx.principalId,
              purpose: args.purpose,
              modelId: attempt.modelId,
              inputTokens: attempt.usage.inputTokens,
              outputTokens: attempt.usage.outputTokens,
              costUsd: attempt.costUsd,
              requestId: args.ctx.requestId,
            });
          }
        },
        { transaction: false },
      );
    } catch (err) {
      this.deps.logger.error('core.usage_record_failed', {
        requestId: args.ctx.requestId,
        purpose: args.purpose,
        attempts: args.attempts.length,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }
}

/** Appends an audit event inside the request transaction (atomic with the change it describes). */
export async function audit(scope: Pick<RequestScope, 'tx'>, event: AuditEvent): Promise<void> {
  await auditRepo.appendAudit(scope.tx, event);
}

/** Validates an identifier from a URL path; malformed ids are reported as not found. */
export function requireId(value: string, what: string): string {
  if (!isUuid(value)) throw fail.notFound(what, 'malformed_id');
  return value.toLowerCase();
}
