import { auditRepo, callsRepo, memoryRepo, sessionsRepo } from '@foundry/db';

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
  /** AI memory proposals nobody acted on for `distillation.proposalTtlDays` (30), now expired. */
  readonly proposalsExpired: number;
  /** The distillation backstop: idle conversations that no trigger distilled yet. */
  readonly distillation: DistillBackstopReport;
}

export interface MaintenanceService {
  /**
   * Daily housekeeping (the worker runs it for the scheduled `maintenance` message; the schedule already wakes
   * the database once a day): ends ephemeral sessions idle for 24 h and erases the content of every ended
   * ephemeral session's turns, closes calls whose client went away, expires stale AI memory proposals, then
   * runs the bounded distillation
   * backstop while `deadline` (epoch ms) leaves time. Each step commits on its own, the privacy erasure
   * first, so a later step failing never undoes it. One audit event per step, with counts. Idempotent.
   */
  runDaily(options: { readonly requestId: string; readonly deadline?: number }): Promise<MaintenanceReport>;
}

export function createMaintenanceService(
  kit: Kit,
  distill: Pick<DistillService, 'backstop'>,
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
      const staleCalls = await kit.system(async (sx) => {
        const count = await callsRepo.reapStaleCalls(sx, {
          staleSeconds: CALL_LIMITS.staleSeconds,
          graceSeconds: CALL_LIMITS.staleSeconds,
        });
        await auditRepo.appendAudit(sx, {
          action: 'maintenance.stale_calls',
          outcome: 'succeeded',
          requestId,
          objectType: 'call',
          metadata: { ended: count },
        });
        return count;
      });
      const ttlDays = kit.config.distillation.proposalTtlDays;
      const expired = await kit.system(async (sx) => {
        const count = await memoryRepo.expireStaleAiProposals(sx, { olderThanDays: ttlDays });
        await auditRepo.appendAudit(sx, {
          action: 'maintenance.memory_proposals',
          outcome: 'succeeded',
          requestId,
          objectType: 'memory',
          metadata: { expired: count, ttlDays },
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
        proposalsExpired: expired,
        distilled: distillation.distilled,
        distillDeferred: distillation.deferred,
      });
      return {
        ephemeralSessionsEnded: cleanup.sessionsEnded,
        ephemeralTurnsRedacted: cleanup.turnsRedacted,
        staleCallsEnded: staleCalls,
        proposalsExpired: expired,
        distillation,
      };
    },
  };
}
