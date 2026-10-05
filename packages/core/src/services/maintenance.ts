import { auditRepo, sessionsRepo } from '@foundry/db';

import { type Kit } from '../internal/kit.js';

export interface MaintenanceReport {
  /** Ephemeral sessions ended because they were idle for `maintenance.ephemeralIdleSeconds` (24 h). */
  readonly ephemeralSessionsEnded: number;
  /** Turns of ended ephemeral sessions whose content was erased by this run. */
  readonly ephemeralTurnsRedacted: number;
}

export interface MaintenanceService {
  /**
   * Daily housekeeping on server-side data only (the worker runs it for the scheduled `maintenance`
   * message): ends ephemeral sessions idle for 24 h and erases the content of every ended ephemeral
   * session's turns, then records one audit event with the counts. Idempotent.
   */
  runDaily(options: { readonly requestId: string }): Promise<MaintenanceReport>;
}

export function createMaintenanceService(kit: Kit): MaintenanceService {
  return {
    runDaily: async ({ requestId }) => {
      const result = await kit.system(async (sx) => {
        const cleanup = await sessionsRepo.expireStaleEphemeralSessions(sx, {
          idleSeconds: kit.config.maintenance.ephemeralIdleSeconds,
        });
        await auditRepo.appendAudit(sx, {
          action: 'maintenance.ephemeral_sessions',
          outcome: 'succeeded',
          requestId,
          objectType: 'coaching_session',
          metadata: { ended: cleanup.sessionsEnded, redactedTurns: cleanup.turnsRedacted },
        });
        return cleanup;
      });
      kit.deps.logger.info('maintenance.daily_done', {
        requestId,
        ephemeralSessionsEnded: result.sessionsEnded,
        ephemeralTurnsRedacted: result.turnsRedacted,
      });
      return { ephemeralSessionsEnded: result.sessionsEnded, ephemeralTurnsRedacted: result.turnsRedacted };
    },
  };
}
