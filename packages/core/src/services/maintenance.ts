import { auditRepo, callsRepo, documentsRepo, sessionsRepo, twinRepo } from '@foundry/db';

import { type Kit } from '../internal/kit.js';
import { CALL_LIMITS } from './call-usage.js';
import { type DistillBackstopReport, type DistillService } from './distill.js';
import { meterFace } from './face.js';
import { settlePendingAiProposals, type PendingSettleResult } from './memory.js';

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
  /**
   * AI memory proposals left from before automatic memory, settled through the checks new memory goes through
   * (`settlePendingAiProposals`): kept, or retired as a restatement or as not the founder's.
   */
  readonly pendingProposals: PendingSettleResult;
  /** The distillation backstop: idle conversations that no trigger distilled yet. */
  readonly distillation: DistillBackstopReport;
}

export interface MaintenanceService {
  /**
   * Daily housekeeping (the worker runs it for the scheduled `maintenance` message; the schedule already wakes
   * the database once a day): ends ephemeral sessions idle for 24 h and erases the content of every ended
   * ephemeral session's turns, closes calls whose client went away and distils their conversations, fails
   * document uploads nobody finished, settles the AI memory proposals left from before automatic memory (kept
   * or retired with the checks new memory goes through: none waits for a person any more), then runs the bounded
   * distillation backstop while `deadline` (epoch ms) leaves time. Each step commits on its own, the privacy
   * erasure first, so a later step failing never undoes it. One audit event per step, with counts. Idempotent.
   */
  runDaily(options: { readonly requestId: string; readonly deadline?: number }): Promise<MaintenanceReport>;
}

/** Faces billed per maintenance run at most (each in its own transaction). */
const FACE_BILLING_BATCH = 500;

/** Bills every ended face whose seconds are not all in the usage ledger yet; audited with counts. */
async function billEndedFaces(kit: Kit, requestId: string): Promise<void> {
  const callIds = await kit.system((sx) => twinRepo.unbilledEndedFaces(sx, { limit: FACE_BILLING_BATCH }), {
    transaction: false,
  });
  let seconds = 0;
  let failed = 0;
  for (const callId of callIds) {
    try {
      seconds += await meterFace(kit, callId, requestId);
    } catch (err) {
      failed += 1;
      kit.deps.logger.error('maintenance.face_billing_failed', {
        requestId,
        callId,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }
  await kit.system((sx) =>
    auditRepo.appendAudit(sx, {
      action: 'maintenance.call_faces',
      outcome: failed === 0 ? 'succeeded' : 'failed',
      requestId,
      objectType: 'call',
      metadata: { billed: callIds.length - failed, seconds, failed },
    }),
  );
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
      // The faces of those calls (and any face whose end was not billed) go into the usage ledger now, each
      // second once: the platform's daily cap reads the ledger. Their vendor sessions ended long ago at the
      // vendor's idle timeout (no keep-alive comes after the last heartbeat).
      await billEndedFaces(kit, requestId);
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
      const pendingProposals = await settlePendingAiProposals(kit);
      await kit.system((sx) =>
        auditRepo.appendAudit(sx, {
          action: 'maintenance.memory_proposals',
          outcome: 'succeeded',
          requestId,
          objectType: 'memory',
          metadata: { ...pendingProposals },
        }),
      );
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
        proposalsKept: pendingProposals.kept,
        proposalsRetired: pendingProposals.duplicates + pendingProposals.notTheFounders,
        distilled: distillation.distilled,
        distillDeferred: distillation.deferred,
      });
      return {
        ephemeralSessionsEnded: cleanup.sessionsEnded,
        ephemeralTurnsRedacted: cleanup.turnsRedacted,
        staleCallsEnded: staleCalls,
        endedCallsDistilled: endedCalls.distilled,
        staleUploadsFailed: staleUploads,
        pendingProposals,
        distillation,
      };
    },
  };
}
