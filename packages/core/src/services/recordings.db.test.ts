/**
 * Call recordings through the core services (ADR-0023): a founder records their own call in a remembered
 * conversation; the files go to the store with presigned PUTs and are checked on completion; only the recorder lists,
 * replays or deletes it; a private call, someone else's call, a call too short for the recording and a missing store
 * are refused; deleting the recording or its conversation removes its files (the maintenance retries any it missed);
 * and every step is audited with ids and counts, never content.
 */
import {
  CreateRecordingResponse,
  RECORDING_LIMITS,
  RecordingListResponse,
  RecordingPlaybackResponse,
  type CreateRecordingRequest,
} from '@foundry/contracts';
import { RecordingDownloadResponse } from '@foundry/contracts/recording-files';
import { auditRepo, p, recordingsRepo, venturesRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { DomainError } from '../errors.js';
import { type CoreHarness, createCoreHarness } from '../testing/harness.js';
import { DOWNLOAD_URL_SECONDS, playbackSeconds, recordingKeys } from './recordings.js';

let h: CoreHarness;
let maya: RequestContext;
let devin: RequestContext;
let owner: RequestContext;

const ventureId = (): string => h.ventures.quietquad.id;

async function call(who: RequestContext, privacy: 'standard' | 'ephemeral' = 'standard') {
  const session = await h.core.sessions.create(who, ventureId(), { privacy });
  const started = await h.core.calls.start(who, session.id, { inputMode: 'typed' });
  await h.core.calls.end(who, started.call.id, { reason: 'user' });
  return { sessionId: session.id, callId: started.call.id };
}

const request = (overrides: Partial<CreateRecordingRequest> = {}): CreateRecordingRequest => ({
  mimeType: 'video/webm',
  bytes: 48_000,
  durationMs: 20_000,
  captions: { bytes: 420, cues: 4 },
  ...overrides,
});

async function refusal(promise: Promise<unknown>): Promise<{ code: string; reason: string | undefined }> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof DomainError) return { code: err.code, reason: err.reason };
    throw err;
  }
  throw new Error('expected a refusal');
}

/** Audit events of one action about one object, newest first. */
async function audits(action: string, objectId: string) {
  const page = await h.t.db.system((sx) => auditRepo.listAuditEvents(sx, { action, limit: 200 }));
  return page.items.filter((e) => e.objectId === objectId);
}

/** Registers a recording and "uploads" its files (the browser's PUTs). */
async function recorded(
  who: RequestContext,
  callId: string,
  overrides: Partial<CreateRecordingRequest> = {},
) {
  const input = request(overrides);
  const created = CreateRecordingResponse.parse(await h.core.recordings.create(who, callId, input));
  const media = h.recordingStore.puts.find(
    (put) => put.contentLength === input.bytes && put.key.includes(created.recording.id),
  );
  if (!media) throw new Error('no presigned PUT for the recording');
  h.recordingStore.put(media.key, input.bytes);
  if (input.captions) {
    const captions = h.recordingStore.puts.find(
      (put) => put.contentType === 'text/vtt' && put.key.includes(created.recording.id),
    );
    if (!captions) throw new Error('no presigned PUT for the captions');
    h.recordingStore.put(captions.key, input.captions.bytes);
  }
  return created;
}

beforeAll(async () => {
  h = await createCoreHarness();
  maya = await h.ctxFor(h.people.maya);
  devin = await h.ctxFor(h.people.devin);
  owner = await h.ctxFor(h.people.owner);
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

describe('recording a call', () => {
  it('registers the caller’s own call and signs one PUT per file, exactly typed and sized', async () => {
    const { sessionId, callId } = await call(maya);
    const created = await recorded(maya, callId);
    expect(created.recording).toMatchObject({
      callId,
      sessionId,
      ventureId: ventureId(),
      mimeType: 'video/webm',
      kind: 'video',
      bytes: 48_000,
      durationMs: 20_000,
      hasCaptions: true,
      status: 'pending',
    });
    const keys = recordingKeys({
      tenantId: maya.tenantId,
      ventureId: ventureId(),
      sessionId,
      recordingId: created.recording.id,
      mimeType: 'video/webm',
    });
    expect(keys.media).toMatch(/\/sessions\/[0-9a-f-]{36}\/recordings\/[0-9a-f-]{36}\/call\.webm$/);
    expect(h.recordingStore.puts.filter((put) => put.key.includes(created.recording.id))).toEqual([
      {
        key: keys.media,
        contentType: 'video/webm',
        contentLength: 48_000,
        expiresInSeconds: h.config.uploads.presignTtlSeconds,
      },
      {
        key: keys.captions,
        contentType: 'text/vtt',
        contentLength: 420,
        expiresInSeconds: h.config.uploads.presignTtlSeconds,
      },
    ]);
    expect(created.upload.media).toMatchObject({ method: 'PUT', headers: { 'content-type': 'video/webm' } });

    // Not listed until its files arrived and it was completed.
    expect(RecordingListResponse.parse(await h.core.recordings.list(maya, { sessionId })).items).toEqual([]);
    const ready = await h.core.recordings.complete(maya, created.recording.id);
    expect(ready.status).toBe('ready');
    // Idempotent.
    expect((await h.core.recordings.complete(maya, created.recording.id)).status).toBe('ready');
    const listed = RecordingListResponse.parse(await h.core.recordings.list(maya, { sessionId }));
    expect(listed).toMatchObject({ available: true, items: [{ id: created.recording.id, status: 'ready' }] });
    expect((await h.core.recordings.list(maya, {})).items.map((r) => r.id)).toContain(created.recording.id);

    expect(await audits('recording.requested', created.recording.id)).toHaveLength(1);
    expect(await audits('recording.saved', created.recording.id)).toHaveLength(1);
  });

  it('refuses a private call, someone else’s call and a recording longer than its call', async () => {
    const temporary = await call(maya, 'ephemeral');
    expect(await refusal(h.core.recordings.create(maya, temporary.callId, request()))).toEqual({
      code: 'conflict',
      reason: 'recording_private_call',
    });
    const mine = await call(maya);
    // Devin works on the venture: the call is still Maya's.
    expect((await refusal(h.core.recordings.create(devin, mine.callId, request()))).code).toBe('not_found');
    expect((await refusal(h.core.recordings.create(owner, mine.callId, request()))).code).toBe('not_found');
    expect(
      (await refusal(h.core.recordings.create(maya, mine.callId, request({ durationMs: 4 * 3_600_000 }))))
        .code,
    ).toBe('validation_failed');
    expect(
      (
        await refusal(
          h.core.recordings.create(maya, mine.callId, request({ mimeType: 'video/ogg' as 'video/webm' })),
        )
      ).code,
    ).toBe('validation_failed');
    expect((await audits('recording.requested', temporary.callId))[0]).toMatchObject({
      outcome: 'blocked',
      policyReason: 'private_call',
    });
  });

  it('completes only when the declared sizes arrived', async () => {
    const { callId } = await call(maya);
    const created = CreateRecordingResponse.parse(await h.core.recordings.create(maya, callId, request()));
    expect(await refusal(h.core.recordings.complete(maya, created.recording.id))).toEqual({
      code: 'conflict',
      reason: 'recording_upload_incomplete',
    });
    const [media, captions] = h.recordingStore.puts.filter((put) => put.key.includes(created.recording.id));
    h.recordingStore.put(media?.key ?? '', 47_999);
    h.recordingStore.put(captions?.key ?? '', 420);
    expect((await refusal(h.core.recordings.complete(maya, created.recording.id))).reason).toBe(
      'recording_upload_incomplete',
    );
    h.recordingStore.put(media?.key ?? '', 48_000);
    expect((await h.core.recordings.complete(maya, created.recording.id)).status).toBe('ready');
  });

  it('a recording without captions needs only its own file', async () => {
    const { callId } = await call(maya);
    const created = await recorded(maya, callId, { captions: null, mimeType: 'audio/mp4' });
    expect(created.upload.captions).toBeNull();
    expect(created.recording).toMatchObject({ kind: 'audio', hasCaptions: false });
    expect((await h.core.recordings.complete(maya, created.recording.id)).status).toBe('ready');
  });
});

describe('the daily limit', () => {
  it('counts the recordings kept today, not deleted ones, and says when it is reached', async () => {
    // Devin's own recordings, all of one call.
    const { callId } = await call(devin);
    const ids: string[] = [];
    for (let i = 0; i < RECORDING_LIMITS.dailyRecordingsPerPrincipal; i += 1) {
      ids.push((await h.core.recordings.create(devin, callId, request())).recording.id);
    }
    const limited = await refusal(h.core.recordings.create(devin, callId, request()));
    expect(limited).toEqual({ code: 'rate_limited', reason: 'daily_recordings' });
    // A take recorded and deleted (a rehearsal) gives its place back.
    await h.core.recordings.remove(devin, ids[0] ?? '');
    const again = await h.core.recordings.create(devin, callId, request());
    expect(again.recording.status).toBe('pending');
    expect((await refusal(h.core.recordings.create(devin, callId, request()))).reason).toBe(
      'daily_recordings',
    );
    // All deleted again: the day is Devin's again (later tests record as Devin).
    for (const id of [...ids.slice(1), again.recording.id]) await h.core.recordings.remove(devin, id);
    expect((await h.core.recordings.create(devin, callId, request())).recording.status).toBe('pending');
  });
});

describe('replaying and deleting', () => {
  it('replays with presigned GETs long enough to watch it, to its owner only, and audits each replay', async () => {
    const { callId } = await call(maya);
    const created = await recorded(maya, callId);
    expect((await refusal(h.core.recordings.playback(maya, created.recording.id))).reason).toBe(
      'recording_pending',
    );
    await h.core.recordings.complete(maya, created.recording.id);
    const replay = RecordingPlaybackResponse.parse(
      await h.core.recordings.playback(maya, created.recording.id),
    );
    expect(replay.media.url).toContain('call.webm');
    expect(replay.captions?.url).toContain('captions.vtt');
    expect(h.recordingStore.gets.slice(-2).map((get) => [get.contentType, get.expiresInSeconds])).toEqual([
      ['video/webm', playbackSeconds(20_000)],
      ['text/vtt', playbackSeconds(20_000)],
    ]);
    expect(playbackSeconds(20_000)).toBeGreaterThanOrEqual(15 * 60);
    expect(playbackSeconds(30 * 60_000)).toBeGreaterThan(30 * 60);

    for (const other of [devin, owner]) {
      expect((await refusal(h.core.recordings.playback(other, created.recording.id))).code).toBe('not_found');
      expect((await refusal(h.core.recordings.remove(other, created.recording.id))).code).toBe('not_found');
      expect((await h.core.recordings.list(other, {})).items).toEqual([]);
    }
    expect(await audits('recording.played', created.recording.id)).toHaveLength(1);
    const denied = await audits('recording.access', created.recording.id);
    expect(denied.length).toBeGreaterThanOrEqual(4);
    expect(denied.every((e) => e.outcome === 'denied')).toBe(true);
  });

  it('downloads the recording or its transcript under a readable name, to its owner only, audited', async () => {
    const { callId } = await call(maya);
    const created = await recorded(maya, callId);
    expect(
      (await refusal(h.core.recordings.download(maya, created.recording.id, { file: 'recording' }))).reason,
    ).toBe('recording_pending');
    const ready = await h.core.recordings.complete(maya, created.recording.id);
    const keys = recordingKeys({
      tenantId: maya.tenantId,
      ventureId: ventureId(),
      sessionId: ready.sessionId,
      recordingId: ready.id,
      mimeType: 'video/webm',
    });

    const saved = RecordingDownloadResponse.parse(
      await h.core.recordings.download(maya, ready.id, { name: 'Thomas', timeZone: 'UTC' }),
    );
    // Named after when it began: its registration less its length.
    expect(Date.parse(ready.createdAt) - Date.parse(ready.startedAt)).toBe(20_000);
    const begun = ready.startedAt.slice(0, 16).replace('T', ' ').replace(':', '-');
    expect(saved.filename).toBe(`Thomas call ${begun}.webm`);
    expect(h.recordingStore.gets.at(-1)).toEqual({
      key: keys.media,
      contentType: 'video/webm',
      expiresInSeconds: DOWNLOAD_URL_SECONDS,
      downloadAs: saved.filename,
    });
    const transcript = await h.core.recordings.download(maya, ready.id, {
      file: 'transcript',
      name: 'Thomas',
    });
    expect(transcript.filename).toMatch(/^Thomas call .+ transcript\.vtt$/);
    expect(h.recordingStore.gets.at(-1)).toMatchObject({ key: keys.captions, contentType: 'text/vtt' });

    // Nobody else, not even the venture's team or the platform owner, and nothing for a transcript never saved.
    for (const other of [devin, owner]) {
      expect((await refusal(h.core.recordings.download(other, ready.id, {}))).code).toBe('not_found');
    }
    const silent = await recorded(maya, callId, { captions: null });
    await h.core.recordings.complete(maya, silent.recording.id);
    expect(
      (await refusal(h.core.recordings.download(maya, silent.recording.id, { file: 'transcript' }))).code,
    ).toBe('not_found');
    expect(
      (await refusal(h.core.recordings.download(maya, ready.id, { file: 'video' as 'recording' }))).code,
    ).toBe('validation_failed');
    // A file no longer stored is refused before the browser is sent to it; a URL that cannot be signed is not issued.
    // Neither is recorded as a download, nor a replay that cannot be signed as played.
    h.recordingStore.objects.delete(keys.media);
    expect((await refusal(h.core.recordings.download(maya, ready.id, {}))).code).toBe('not_found');
    h.recordingStore.put(keys.media, 48_000);
    h.recordingStore.failGets = true;
    try {
      await expect(h.core.recordings.download(maya, ready.id, {})).rejects.toThrow('cannot sign');
      await expect(h.core.recordings.playback(maya, ready.id)).rejects.toThrow('cannot sign');
    } finally {
      h.recordingStore.failGets = false;
    }
    expect(await audits('recording.played', ready.id)).toEqual([]);

    const downloads = await h.t.db.system((sx) =>
      sx.query(
        `SELECT outcome, metadata::text AS metadata FROM audit_events
          WHERE action = 'recording.downloaded' AND object_id = :id ORDER BY id`,
        { id: p.text(ready.id) },
      ),
    );
    expect(downloads.rows.map((row) => [row.outcome, JSON.parse(String(row.metadata)) as unknown])).toEqual([
      ['succeeded', { callId, file: 'recording' }],
      ['succeeded', { callId, file: 'transcript' }],
    ]);
    // Ids and the file's kind only: never a URL or the name it was saved under.
    expect(JSON.stringify(downloads.rows)).not.toMatch(/Thomas|https?:/);
  });

  it('lists a page at a time, latest first, and refuses a cursor it did not issue', async () => {
    const { sessionId, callId } = await call(maya);
    const older = await recorded(maya, callId);
    await h.core.recordings.complete(maya, older.recording.id);
    const newer = await recorded(maya, callId);
    await h.core.recordings.complete(maya, newer.recording.id);
    const first = RecordingListResponse.parse(await h.core.recordings.list(maya, { sessionId, limit: 1 }));
    expect(first.items.map((r) => r.id)).toEqual([newer.recording.id]);
    expect(first.nextCursor).not.toBeNull();
    const second = RecordingListResponse.parse(
      await h.core.recordings.list(maya, { sessionId, limit: 1, cursor: first.nextCursor ?? '' }),
    );
    expect(second).toMatchObject({ items: [{ id: older.recording.id }], nextCursor: null });
    expect((await refusal(h.core.recordings.list(maya, { cursor: 'not-a-cursor' }))).code).toBe(
      'validation_failed',
    );
  });

  it('deleting a recording removes its files at once', async () => {
    const { sessionId, callId } = await call(maya);
    const created = await recorded(maya, callId);
    await h.core.recordings.complete(maya, created.recording.id);
    await h.core.recordings.remove(maya, created.recording.id);
    expect(h.recordingStore.deleted.filter((key) => key.includes(created.recording.id))).toHaveLength(2);
    expect((await h.core.recordings.list(maya, { sessionId })).items).toEqual([]);
    expect((await refusal(h.core.recordings.playback(maya, created.recording.id))).code).toBe('not_found');
    expect((await refusal(h.core.recordings.remove(maya, created.recording.id))).code).toBe('not_found');
  });

  it('deleting the conversation deletes its recordings and their files, whoever deletes it', async () => {
    const { sessionId, callId } = await call(maya);
    const first = await recorded(maya, callId);
    await h.core.recordings.complete(maya, first.recording.id);
    const second = await recorded(maya, callId, { captions: null });
    await h.core.sessions.remove(devin, sessionId);
    for (const id of [first.recording.id, second.recording.id]) {
      expect(h.recordingStore.deleted.some((key) => key.includes(id))).toBe(true);
    }
    expect((await h.core.recordings.list(maya, {})).items.map((r) => r.id)).not.toContain(first.recording.id);
  });

  it('the daily maintenance removes files a failed deletion left behind', async () => {
    const { callId } = await call(maya);
    const created = await recorded(maya, callId);
    await h.core.recordings.complete(maya, created.recording.id);
    h.recordingStore.failDeletes = true;
    try {
      await h.core.recordings.remove(maya, created.recording.id);
    } finally {
      h.recordingStore.failDeletes = false;
    }
    expect(h.recordingStore.deleted.some((key) => key.includes(created.recording.id))).toBe(false);
    const report = await h.core.maintenance.runDaily({ requestId: 'maintenance-recordings' });
    expect(report.recordings.purged).toBeGreaterThanOrEqual(1);
    expect(report.recordings.failed).toBe(0);
    expect(h.recordingStore.deleted.filter((key) => key.includes(created.recording.id))).toHaveLength(2);
    const audit = await h.t.db.system((sx) =>
      auditRepo.listAuditEvents(sx, { action: 'maintenance.recordings' }),
    );
    expect(audit.items[0]).toMatchObject({ outcome: 'succeeded', objectType: 'call_recording' });
  });
});

describe('an upload still arriving when its recording is deleted', () => {
  /** The keys a recording's presigned PUTs name, with the sizes the browser declared. */
  function signed(recordingId: string) {
    return h.recordingStore.puts
      .filter((put) => put.key.includes(recordingId))
      .map((put) => ({ key: put.key, bytes: put.contentLength }));
  }

  it('a file that lands after its conversation or the recording was deleted is removed too, never left a year', async () => {
    // The conversation is deleted while the browser is still uploading: the purge finds nothing yet.
    const { sessionId, callId } = await call(maya);
    const first = CreateRecordingResponse.parse(await h.core.recordings.create(maya, callId, request()));
    await h.core.sessions.remove(maya, sessionId);
    // The pending recording itself is deleted mid-upload.
    const other = await call(maya);
    const second = CreateRecordingResponse.parse(
      await h.core.recordings.create(maya, other.callId, request()),
    );
    await h.core.recordings.remove(maya, second.recording.id);

    // The in-flight PUTs land afterwards.
    const late = [...signed(first.recording.id), ...signed(second.recording.id)];
    expect(late).toHaveLength(4);
    for (const file of late) h.recordingStore.put(file.key, file.bytes);

    // Neither is marked purged while an upload may still arrive, so the daily maintenance removes the late files.
    const ids = [first.recording.id, second.recording.id];
    const purgeable = async () =>
      (await h.t.db.system((sx) => recordingsRepo.listPurgeable(sx, { limit: 1000 })))
        .map((r) => r.id)
        .filter((id) => ids.includes(id));
    expect((await purgeable()).sort()).toEqual([...ids].sort());
    await h.core.maintenance.runDaily({ requestId: 'maintenance-late-upload' });
    for (const file of late) expect(h.recordingStore.objects.has(file.key)).toBe(false);

    // Once no upload can arrive any more (the window of a pending recording has passed), they are marked purged.
    await h.t.db.system((sx) =>
      sx.query(
        "UPDATE call_recordings SET created_at = created_at - interval '25 hours' WHERE id = ANY (:ids)",
        { ids: p.uuidArray(ids) },
      ),
    );
    await h.core.maintenance.runDaily({ requestId: 'maintenance-late-upload-settled' });
    expect(await purgeable()).toEqual([]);
  });
});

describe('after the venture is gone', () => {
  it('a revoked membership loses its recordings of the venture at once, and may still delete them', async () => {
    const { sessionId, callId } = await call(devin);
    const kept = await recorded(devin, callId);
    await h.core.recordings.complete(devin, kept.recording.id);
    const pending = await recorded(devin, callId);
    expect((await h.core.recordings.list(devin, { sessionId })).items.map((r) => r.id)).toEqual([
      kept.recording.id,
    ]);

    await h.t.db.system((sx) =>
      venturesRepo.revokeMembership(sx, { ventureId: ventureId(), principalId: h.people.devin }),
    );
    try {
      expect((await h.core.recordings.list(devin, {})).items).toEqual([]);
      expect((await h.core.recordings.list(devin, { ventureId: ventureId() })).items).toEqual([]);
      expect((await refusal(h.core.recordings.playback(devin, kept.recording.id))).code).toBe('not_found');
      expect((await refusal(h.core.recordings.download(devin, kept.recording.id, {}))).code).toBe(
        'not_found',
      );
      expect((await refusal(h.core.recordings.complete(devin, pending.recording.id))).code).toBe('not_found');
      const denied = await audits('recording.access', kept.recording.id);
      expect(denied[0]).toMatchObject({
        outcome: 'denied',
        policyReason: 'venture_access:venture_not_visible',
      });
      // Their own recording is still theirs to delete (and its files go).
      await h.core.recordings.remove(devin, kept.recording.id);
      expect(h.recordingStore.deleted.filter((key) => key.includes(kept.recording.id))).toHaveLength(2);
    } finally {
      await h.t.db.system((sx) =>
        venturesRepo.addMembership(sx, { ventureId: ventureId(), principalId: h.people.devin, role: 'team' }),
      );
    }
    // With the venture back, the pending one completes as before.
    expect((await h.core.recordings.complete(devin, pending.recording.id)).status).toBe('ready');
  });
});

describe('without a recordings store', () => {
  it('refuses to record, and says recordings are not available', async () => {
    const bare = await createCoreHarness({ withoutRecordings: true });
    try {
      const who = await bare.ctxFor(bare.people.maya);
      const session = await bare.core.sessions.create(who, bare.ventures.quietquad.id, {});
      const started = await bare.core.calls.start(who, session.id, { inputMode: 'typed' });
      expect(await refusal(bare.core.recordings.create(who, started.call.id, request()))).toEqual({
        code: 'recording_unavailable',
        reason: 'recording_store_missing',
      });
      expect(await bare.core.recordings.list(who, {})).toEqual({
        items: [],
        nextCursor: null,
        available: false,
      });
    } finally {
      await bare.cleanup();
    }
  }, 180_000);
});
