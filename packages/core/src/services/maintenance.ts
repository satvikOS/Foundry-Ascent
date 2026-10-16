import { auditRepo, callsRepo, documentsRepo, sessionsRepo } from '@foundry/db';

import { type Kit } from '../internal/kit.js';
import { CALL_LIMITS } from './call-usage.js';
import { type DistillBackstopReport, type DistillService } from './distill.js';

export interface MaintenanceReport {
  /** Ephemeral sessions ended because they were idle for `maintenance.ephemeralIdleSeconds` (24 h). */
  readonly ephemeralSessionsEnded: number;
  /** Turns of ended ephemeral sessions whose content was erased by this run. */
  readonly ephemeralTurnsRedacted: number;
  /** Calls still live whose client stopped sending heartbeats (ended at their last heartbeat + grace). */
  readonly staleCallsEnded: number;
  /** Conversations of those calls distilled right after (a call that ends is distilled, however it ends). */
  readonly endedCallsDistilled: number;
  /** Document uploads left unfinished ({@link staleUploadSeconds}), now `failed` with `upload_incomplete`. */
  readonly staleUploadsFailed: number;
  /** The distillation backstop: idle conversations that no trigger distilled yet. */
  readonly distillation: DistillBackstopReport;
}

export interface MaintenanceService {
  /**
   * Daily housekeeping (the worker runs it for the scheduled `maintenance` message; the schedule already wakes
   * the database once a day): ends ephemeral sessions idle for 24 h and erases the content of every ended
   * ephemeral session's turns, closes calls whose client went away and distils their conversations, fails
   * document uploads nobody finished, then runs the bounded distillation backstop while `deadline` (epoch ms)
   * leaves time. Each step commits on its own, the privacy erasure first, so a later step failing never undoes
   * it. One audit event per step, with counts. Idempotent. (AI memory is kept automatically, so no proposal
   * waits for a person and nothing expires.)
   */
  runDaily(options: { readonly requestId: string; readonly deadline?: number }): Promise<MaintenanceReport>;
}

/**
 * A document still `pending_upload` this long after its last presigned URL was issued is abandoned: the URL
 * expired long ago (`uploads.presignTtlSeconds`) and an hour more covers any PUT that started before it did.
 */
export function staleUploadSeconds(presignTtlSeconds: number): number {
  return presignTtlSeconds + 3_600;
}

export function createMaintenanceService(
  kit: Kit,
  distill: Pick<DistillService, 'backstop' | 'distillSettled'>,
): MaintenanceService {
  return {
    runDaily: async ({ requestId, deadline }) => {
      const cleanup = await kit.system(async (sx) => {
        const ended = await sessionsRepo.expireStaleEphemeralSessions(sx, {
          idleSeconds: kit.config.maintenance.ephemeralIdleSeconds,
        });
        await auditRepo.appendAudit(sx, {
          action: 'maintenance.ephemeral_sessions',
          outcome: 'succeeded',
          requestId,
          objectType: 'coaching_session',
          metadata: {
            ended: ended.sessionsEnded,
            redactedTurns: ended.turnsRedacted,
            escalationsErased: ended.escalationsErased,
          },
        });
        return ended;
      });
      // Abandoned calls already count only to their last heartbeat + the stale window (as long as they were
      // usable) and never block a new call; this only closes them (the same window, so minutes do not move).
      const reaped = await kit.system(async (sx) => {
        const calls = await callsRepo.reapStaleCalls(sx, {
          staleSeconds: CALL_LIMITS.staleSeconds,
          graceSeconds: CALL_LIMITS.staleSeconds,
        });
        await auditRepo.appendAudit(sx, {
          action: 'maintenance.stale_calls',
          outcome: 'succeeded',
          requestId,
          objectType: 'call',
          metadata: { ended: calls.length },
        });
        return calls;
      });
      const staleCalls = reaped.length;
      // A call that ends is distilled however it ends, the ones closed here too (inline: the worker never
      // enqueues), before the backstop takes the rest.
      const endedCalls = await distill.distillSettled(
        reaped.map((c) => c.sessionId),
        { requestId, ...(deadline === undefined ? {} : { deadline }) },
      );
      const staleUploads = await kit.system(async (sx) => {
        const olderThanSeconds = staleUploadSeconds(kit.config.uploads.presignTtlSeconds);
        const count = await documentsRepo.failStaleUploads(sx, { olderThanSeconds });
        await auditRepo.appendAudit(sx, {
          action: 'maintenance.stale_uploads',
          outcome: 'succeeded',
          requestId,
          objectType: 'document',
          metadata: { failed: count, olderThanSeconds },
        });
        return count;
      });
      const distillation = await distill.backstop({
        requestId,
        ...(deadline === undefined ? {} : { deadline }),
      });
      kit.deps.logger.info('maintenance.daily_done', {
        requestId,
        ephemeralSessionsEnded: cleanup.sessionsEnded,
        ephemeralTurnsRedacted: cleanup.turnsRedacted,
        staleCallsEnded: staleCalls,
        endedCallsDistilled: endedCalls.distilled,
        staleUploadsFailed: staleUploads,
        distilled: distillation.distilled,
        distillDeferred: distillation.deferred,
      });
      return {
        ephemeralSessionsEnded: cleanup.sessionsEnded,
        ephemeralTurnsRedacted: cleanup.turnsRedacted,
        staleCallsEnded: staleCalls,
        endedCallsDistilled: endedCalls.distilled,
        staleUploadsFailed: staleUploads,
        distillation,
      };
    },
  };
}
