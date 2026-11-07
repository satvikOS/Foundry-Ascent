import {
  CreateRecordingRequest,
  RECORDING_CAPTIONS_TYPE,
  RECORDING_LIMITS,
  RecordingListQuery,
  type CreateRecordingResponse,
  type RecordingListResponse,
  type RecordingMimeType,
  type RecordingPlaybackResponse,
  type RecordingView,
} from '@foundry/contracts';
import {
  RecordingDownloadQuery,
  type RecordingDownloadFile,
  type RecordingDownloadResponse,
} from '@foundry/contracts/recording-files';
import { auditRepo, callsRepo, recordingsRepo, sessionsRepo, venturesRepo } from '@foundry/db';
import { type z } from 'zod';

import { decideVentureAccess, requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { DomainError, fail, parseInput } from '../errors.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { secondsUntilUtcMidnight } from '../orchestrator/sampling.js';
import { type RecordingStore } from '../ports.js';

/**
 * Call recordings (ADR-0023, docs/architecture/calls.md §7): a founder's recordings of their own calls, to watch again
 * without calling the vEIR. The browser records and uploads both files (the recording and its WebVTT captions)
 * straight to the recordings store with presigned PUTs issued here, after this checked the call is the caller's own
 * and its conversation is remembered (a private call is never recorded); `complete` checks the sizes that arrived.
 * Replay and download get presigned GETs, never a model. Only the person who recorded it lists, plays, downloads or
 * deletes it (RLS), and lists, plays or downloads it only while they still have its venture (a revoked or expired membership loses it at once, though
 * they may still delete it). Deleting it or its conversation deletes its files (at once, and the daily maintenance
 * retries any it missed or any that arrived later). Every step is audited with identifiers and counts, never content.
 */
export interface RecordingsService {
  /** Registers a recording of the caller's own call and returns the presigned PUTs for its files. */
  create(
    ctx: RequestContext,
    callId: string,
    input: z.input<typeof CreateRecordingRequest>,
  ): Promise<CreateRecordingResponse>;
  /** The files arrived (exactly the declared sizes): the recording is ready. Idempotent. */
  complete(ctx: RequestContext, recordingId: string): Promise<RecordingView>;
  /** The caller's ready recordings, latest first, a page at a time (one conversation's, one venture's, or all). */
  list(ctx: RequestContext, query: z.input<typeof RecordingListQuery>): Promise<RecordingListResponse>;
  /** Presigned GETs of a ready recording and its captions, long enough to watch it to its end. Audited. */
  playback(ctx: RequestContext, recordingId: string): Promise<RecordingPlaybackResponse>;
  /** A presigned GET that saves the recording or its transcript under a readable name. Audited. */
  download(
    ctx: RequestContext,
    recordingId: string,
    query: z.input<typeof RecordingDownloadQuery>,
  ): Promise<RecordingDownloadResponse>;
  /** Deletes the caller's recording and then its files. */
  remove(ctx: RequestContext, recordingId: string): Promise<void>;
}

/** Shortest lifetime of a replay's presigned GETs (the longest is `RECORDING_LIMITS.maxPlaybackUrlSeconds`). */
const PLAYBACK_MIN_SECONDS = 15 * 60;

/** How long a download's presigned GET lasts: long enough to start saving it (the save itself may take longer). */
export const DOWNLOAD_URL_SECONDS = 5 * 60;

/**
 * A pending recording whose upload has not completed after this long is abandoned (its files purged). It is also how
 * long an upload of a pending recording may still be arriving: one deleted before then is purged again by the daily
 * maintenance until it has passed, so a file that lands after the first purge is removed too.
 */
export const STALE_RECORDING_SECONDS = 24 * 3_600;

/** Files of deleted recordings removed per purge at most. */
const PURGE_BATCH = 200;

const EXTENSIONS: Readonly<Record<RecordingMimeType, string>> = {
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
};

/** The keys of a recording's files: under its tenant, venture and conversation (bucket policy and IAM scope them). */
export function recordingKeys(args: {
  readonly tenantId: string;
  readonly ventureId: string;
  readonly sessionId: string;
  readonly recordingId: string;
  readonly mimeType: RecordingMimeType;
}): { readonly media: string; readonly captions: string } {
  const prefix = `tenants/${args.tenantId}/ventures/${args.ventureId}/sessions/${args.sessionId}/recordings/${args.recordingId}`;
  return { media: `${prefix}/call.${EXTENSIONS[args.mimeType]}`, captions: `${prefix}/captions.vtt` };
}

/** A time zone the platform knows by this IANA name, else UTC. */
function knownTimeZone(timeZone: string | undefined): string {
  if (timeZone === undefined || timeZone === '') return 'UTC';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

/**
 * The name a downloaded file is saved under, as the person would name it: whose call it was and when it began, in their
 * time zone ("Thomas call 2026-11-07 14-22.webm", its transcript "… transcript.vtt"). Characters a file system refuses,
 * and invisible formatting characters (a right-to-left override that would disguise the extension, zero-width
 * spaces), never reach it; the header encodes the rest (content-disposition in the stores).
 */
export function recordingFilename(args: {
  readonly name: string | undefined;
  readonly startedAt: string;
  readonly timeZone: string | undefined;
  readonly mimeType: RecordingMimeType;
  readonly file: RecordingDownloadFile;
}): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: knownTimeZone(args.timeZone),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(args.startedAt))
      .map((part) => [part.type, part.value]),
  );
  const when = `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''} ${parts.hour ?? ''}-${parts.minute ?? ''}`;
  const name = (args.name ?? '')
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    // Formatting characters, and a lone half of a surrogate pair (the header could not encode it).
    .replace(/[\p{Cf}\p{Cs}]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Cut by characters, never inside one (an emoji is two UTF-16 units).
  const short = Array.from(name).slice(0, 60).join('').trim();
  const stem = short === '' ? `Call ${when}` : `${short} call ${when}`;
  return args.file === 'transcript' ? `${stem} transcript.vtt` : `${stem}.${EXTENSIONS[args.mimeType]}`;
}

/** How long a replay's presigned GETs last: the recording's length and a margin, within bounds. */
export function playbackSeconds(durationMs: number): number {
  return Math.min(
    RECORDING_LIMITS.maxPlaybackUrlSeconds,
    Math.max(PLAYBACK_MIN_SECONDS, Math.ceil(durationMs / 1000) * 2 + 600),
  );
}

function unavailable(): DomainError {
  return new DomainError('recording_unavailable', 'Recording isn’t available here.', {
    reason: 'recording_store_missing',
  });
}

export interface PurgeResult {
  readonly purged: number;
  readonly failed: number;
}

/**
 * Removes the files of deleted recordings from the store and marks them purged (owner role): one recording, one
 * conversation's, or the oldest {@link PURGE_BATCH}. A file that cannot be deleted now stays for the next purge, and
 * so does a recording deleted while its upload may still be arriving (pending, younger than
 * {@link STALE_RECORDING_SECONDS}): its files are deleted now and again by each purge until no upload can land.
 * Never throws for a store failure (counted in `failed`).
 */
export async function purgeRecordings(
  kit: Kit,
  options: { readonly requestId: string; readonly sessionId?: string; readonly id?: string },
): Promise<PurgeResult> {
  const store = kit.deps.recordingStore;
  if (store === undefined) return { purged: 0, failed: 0 };
  const rows = await kit.system(
    (sx) =>
      recordingsRepo.listPurgeable(sx, {
        limit: PURGE_BATCH,
        sessionId: options.sessionId ?? null,
        id: options.id ?? null,
      }),
    { transaction: false },
  );
  const done: string[] = [];
  let failed = 0;
  for (const row of rows) {
    try {
      await store.delete(row.storageKey);
      if (row.captionsKey !== null) await store.delete(row.captionsKey);
      done.push(row.id);
    } catch (err) {
      failed += 1;
      kit.deps.logger.warn('recordings.purge_failed', {
        requestId: options.requestId,
        recordingId: row.id,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }
  const purged = await kit.system(
    (sx) => recordingsRepo.markPurged(sx, done, { uploadWindowSeconds: STALE_RECORDING_SECONDS }),
    { transaction: false },
  );
  return { purged, failed };
}

/**
 * The daily maintenance step (owner role): uploads nobody finished are abandoned and recordings past their retention
 * expire, then the files of every deleted recording still in the store are removed. One audit event with counts.
 */
export async function maintainRecordings(
  kit: Kit,
  requestId: string,
): Promise<{ readonly abandoned: number; readonly expired: number } & PurgeResult> {
  const abandoned = await kit.system(
    (sx) => recordingsRepo.abandonStalePending(sx, { olderThanSeconds: STALE_RECORDING_SECONDS }),
    { transaction: false },
  );
  const expired = await kit.system(
    (sx) => recordingsRepo.expireOldRecordings(sx, { olderThanDays: RECORDING_LIMITS.retentionDays }),
    { transaction: false },
  );
  const result = await purgeRecordings(kit, { requestId });
  await kit.system((sx) =>
    auditRepo.appendAudit(sx, {
      action: 'maintenance.recordings',
      outcome: result.failed === 0 ? 'succeeded' : 'failed',
      requestId,
      objectType: 'call_recording',
      metadata: {
        abandoned,
        expired,
        purged: result.purged,
        failed: result.failed,
        store: kit.deps.recordingStore !== undefined,
      },
    }),
  );
  return { abandoned, expired, ...result };
}

export function createRecordingsService(kit: Kit): RecordingsService {
  function store(): RecordingStore {
    const configured = kit.deps.recordingStore;
    if (configured === undefined) throw unavailable();
    return configured;
  }

  /**
   * The caller's own recording, not deleted; anyone else's (or none) is not found. `venture: 'read'` also needs the
   * caller to still have the venture (a membership revoked or expired loses its recordings at once, as it loses the
   * rest of the venture: they carry the vEIR's advice about it); deleting one's own recording does not.
   */
  async function ownRecording(
    scope: RequestScope,
    recordingId: string,
    venture: 'read' | 'none',
  ): Promise<recordingsRepo.RecordingRecord> {
    const recording = await recordingsRepo.getRecording(scope.tx, recordingId);
    const deny = (policyReason: string, ventureId: string | null): never => {
      scope.deferAudit({
        action: 'recording.access',
        outcome: 'denied',
        ventureId,
        objectType: 'call_recording',
        objectId: recordingId,
        policyReason,
      });
      throw fail.notFound('Recording');
    };
    if (recording === null) return deny('recording_not_visible', null);
    if (recording.deletedAt !== null) return deny('recording_deleted', recording.ventureId);
    if (venture === 'read') {
      const access = await venturesRepo.getVentureAccess(scope.tx, {
        ventureId: recording.ventureId,
        principalId: scope.ctx.principalId,
      });
      const decision = decideVentureAccess(access, scope.ctx, 'read');
      if (!decision.allowed) return deny(`venture_access:${decision.reason}`, null);
    }
    return recording;
  }

  return {
    create: async (ctx, rawCallId, rawInput) => {
      const callId = requireId(rawCallId, 'Call');
      const input = parseInput(CreateRecordingRequest, rawInput);
      const files = store();
      const recordingId = kit.deps.ids.uuid();
      const created = await kit.inRequest(ctx, async (scope) => {
        const call = await callsRepo.getCall(scope.tx, callId);
        if (call?.startedBy !== ctx.principalId) {
          scope.deferAudit({
            action: 'recording.requested',
            outcome: 'denied',
            ventureId: call?.ventureId ?? null,
            objectType: 'call',
            objectId: callId,
            policyReason: call === null ? 'call_not_visible' : 'not_call_owner',
          });
          throw fail.notFound('Call');
        }
        await requireVentureAccess(scope, call.ventureId, 'write', { objectType: 'call', objectId: callId });
        const session = await sessionsRepo.getSession(scope.tx, call.sessionId);
        if (session === null) throw fail.notFound('Session');
        if (session.privacy !== 'standard') {
          scope.deferAudit({
            action: 'recording.requested',
            outcome: 'blocked',
            ventureId: call.ventureId,
            objectType: 'call',
            objectId: callId,
            policyReason: 'private_call',
          });
          throw fail.conflict('Private calls aren’t recorded.', 'recording_private_call');
        }
        const maxMs = call.maxSeconds * 1000 + RECORDING_LIMITS.durationSlackMs;
        if (input.durationMs > maxMs) {
          throw fail.validation('The request is not valid', [
            { path: 'durationMs', message: 'Longer than the call' },
          ]);
        }
        if (
          (await recordingsRepo.recordingsToday(scope.tx, ctx.principalId)) >=
          RECORDING_LIMITS.dailyRecordingsPerPrincipal
        ) {
          scope.deferAudit({
            action: 'recording.requested',
            outcome: 'blocked',
            ventureId: call.ventureId,
            objectType: 'call',
            objectId: callId,
            policyReason: 'daily_recordings',
          });
          throw new DomainError('rate_limited', 'You’ve saved as many recordings as you can today.', {
            reason: 'daily_recordings',
            retryAfterSeconds: secondsUntilUtcMidnight(kit.now()),
          });
        }
        const keys = recordingKeys({
          tenantId: ctx.tenantId,
          ventureId: call.ventureId,
          sessionId: call.sessionId,
          recordingId,
          mimeType: input.mimeType,
        });
        const recording = await recordingsRepo.createRecording(scope.tx, {
          id: recordingId,
          tenantId: ctx.tenantId,
          ventureId: call.ventureId,
          sessionId: call.sessionId,
          callId,
          recordedBy: ctx.principalId,
          mimeType: input.mimeType,
          bytes: input.bytes,
          durationMs: input.durationMs,
          storageKey: keys.media,
          captions: input.captions === null ? null : { key: keys.captions, ...input.captions },
        });
        await audit(scope, {
          action: 'recording.requested',
          outcome: 'succeeded',
          ventureId: call.ventureId,
          objectType: 'call_recording',
          objectId: recordingId,
          metadata: {
            callId,
            sessionId: call.sessionId,
            mimeType: input.mimeType,
            bytes: input.bytes,
            durationMs: input.durationMs,
            cues: input.captions?.cues ?? 0,
          },
        });
        return recording;
      });
      const expiresInSeconds = kit.config.uploads.presignTtlSeconds;
      const put = async (
        key: string,
        contentType: RecordingMimeType | typeof RECORDING_CAPTIONS_TYPE,
        bytes: number,
      ) => {
        const presigned = await files.presignPut({
          key,
          contentType,
          contentLength: bytes,
          expiresInSeconds,
        });
        return {
          url: presigned.url,
          method: 'PUT' as const,
          headers: { ...presigned.headers },
          expiresAt: presigned.expiresAt,
        };
      };
      return {
        recording: recordingsRepo.toRecordingView(created),
        upload: {
          media: await put(created.storageKey, created.mimeType, created.bytes),
          captions:
            created.captionsKey === null || created.captionsBytes === null
              ? null
              : await put(created.captionsKey, RECORDING_CAPTIONS_TYPE, created.captionsBytes),
        },
      };
    },

    complete: async (ctx, rawRecordingId) => {
      const recordingId = requireId(rawRecordingId, 'Recording');
      const files = store();
      const current = await kit.inRequest(ctx, (scope) => ownRecording(scope, recordingId, 'read'));
      if (current.status === 'ready') return recordingsRepo.toRecordingView(current);
      const [media, captions] = await Promise.all([
        files.size(current.storageKey),
        current.captionsKey === null ? Promise.resolve(null) : files.size(current.captionsKey),
      ]);
      const arrived =
        media === current.bytes && (current.captionsKey === null || captions === current.captionsBytes);
      return kit.inRequest(ctx, async (scope) => {
        if (!arrived) {
          scope.deferAudit({
            action: 'recording.saved',
            outcome: 'failed',
            ventureId: current.ventureId,
            objectType: 'call_recording',
            objectId: recordingId,
            policyReason: media === null ? 'upload_missing' : 'upload_size_mismatch',
          });
          throw fail.conflict('The recording didn’t finish uploading.', 'recording_upload_incomplete');
        }
        const ready = await recordingsRepo.markReady(scope.tx, recordingId);
        if (ready === null) {
          const again = await ownRecording(scope, recordingId, 'read');
          return recordingsRepo.toRecordingView(again);
        }
        await audit(scope, {
          action: 'recording.saved',
          outcome: 'succeeded',
          ventureId: ready.ventureId,
          objectType: 'call_recording',
          objectId: recordingId,
          metadata: {
            callId: ready.callId,
            bytes: ready.bytes,
            durationMs: ready.durationMs,
            cues: ready.cues,
          },
        });
        return recordingsRepo.toRecordingView(ready);
      });
    },

    list: async (ctx, rawQuery) => {
      const query = parseInput(RecordingListQuery, rawQuery);
      if (query.cursor !== undefined && recordingsRepo.decodeRecordingCursor(query.cursor) === null) {
        throw fail.validation('The page cursor is not valid', [
          { path: 'cursor', message: 'Invalid cursor' },
        ]);
      }
      const page = await kit.inRequest(ctx, (scope) =>
        recordingsRepo.listRecordings(scope.tx, {
          sessionId: query.sessionId ?? null,
          ventureId: query.ventureId ?? null,
          cursor: query.cursor ?? null,
          limit: query.limit,
        }),
      );
      return {
        items: page.items.map(recordingsRepo.toRecordingView),
        nextCursor: page.nextCursor,
        available: kit.deps.recordingStore !== undefined,
      };
    },

    playback: async (ctx, rawRecordingId) => {
      const recordingId = requireId(rawRecordingId, 'Recording');
      const files = store();
      return kit.inRequest(ctx, async (scope) => {
        const own = await ownRecording(scope, recordingId, 'read');
        if (own.status !== 'ready')
          throw fail.conflict('This recording is still being saved.', 'recording_pending');
        const expiresInSeconds = playbackSeconds(own.durationMs);
        const [media, captions] = await Promise.all([
          files.presignGet({ key: own.storageKey, contentType: own.mimeType, expiresInSeconds }),
          own.captionsKey === null
            ? Promise.resolve(null)
            : files.presignGet({
                key: own.captionsKey,
                contentType: RECORDING_CAPTIONS_TYPE,
                expiresInSeconds,
              }),
        ]);
        // Audited once its URLs exist: a replay that could not be signed is not recorded as played.
        await audit(scope, {
          action: 'recording.played',
          outcome: 'succeeded',
          ventureId: own.ventureId,
          objectType: 'call_recording',
          objectId: recordingId,
          metadata: { callId: own.callId },
        });
        return { recording: recordingsRepo.toRecordingView(own), media, captions };
      });
    },

    download: async (ctx, rawRecordingId, rawQuery) => {
      const recordingId = requireId(rawRecordingId, 'Recording');
      const query = parseInput(RecordingDownloadQuery, rawQuery);
      const files = store();
      return kit.inRequest(ctx, async (scope) => {
        const own = await ownRecording(scope, recordingId, 'read');
        if (own.status !== 'ready')
          throw fail.conflict('This recording is still being saved.', 'recording_pending');
        const key = query.file === 'transcript' ? own.captionsKey : own.storageKey;
        if (key === null) throw fail.notFound('Transcript');
        // The browser follows the URL as a link: a file no longer stored would answer with an error page in place of
        // the app, so it is checked first.
        if ((await files.size(key)) === null)
          throw fail.notFound(query.file === 'transcript' ? 'Transcript' : 'Recording');
        const filename = recordingFilename({
          name: query.name,
          startedAt: recordingsRepo.toRecordingView(own).startedAt,
          timeZone: query.timeZone,
          mimeType: own.mimeType,
          file: query.file,
        });
        const presigned = await files.presignGet({
          key,
          contentType: query.file === 'transcript' ? RECORDING_CAPTIONS_TYPE : own.mimeType,
          expiresInSeconds: DOWNLOAD_URL_SECONDS,
          downloadAs: filename,
        });
        // Audited once its URL exists: a download that could not be signed is not recorded as one.
        await audit(scope, {
          action: 'recording.downloaded',
          outcome: 'succeeded',
          ventureId: own.ventureId,
          objectType: 'call_recording',
          objectId: recordingId,
          metadata: { callId: own.callId, file: query.file },
        });
        return { ...presigned, filename };
      });
    },

    remove: async (ctx, rawRecordingId) => {
      const recordingId = requireId(rawRecordingId, 'Recording');
      await kit.inRequest(ctx, async (scope) => {
        await ownRecording(scope, recordingId, 'none');
        const deleted = await recordingsRepo.softDeleteRecording(scope.tx, recordingId, 'founder');
        if (deleted === null) throw fail.notFound('Recording');
        await audit(scope, {
          action: 'recording.deleted',
          outcome: 'succeeded',
          ventureId: deleted.ventureId,
          objectType: 'call_recording',
          objectId: recordingId,
          metadata: { callId: deleted.callId, status: deleted.status },
        });
        scope.afterCommit(async () => {
          await purgeRecordings(kit, { requestId: ctx.requestId, id: recordingId });
        });
      });
    },
  };
}
