/**
 * Call recordings through the core services (ADR-0023): a founder records their own call in a remembered
 * conversation; the files go to the store with presigned PUTs and are checked on completion; only the recorder lists,
 * replays or deletes it; a private call, someone else's call, a call too short for the recording and a missing store
 * are refused; deleting the recording or its conversation removes its files (the maintenance retries any it missed);
 * and every step is audited with ids and counts, never content.
 */
import {
  CreateRecordingResponse,
  RecordingListResponse,
  RecordingPlaybackResponse,
  type CreateRecordingRequest,
} from '@foundry/contracts';
import { auditRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { DomainError } from '../errors.js';
import { type CoreHarness, createCoreHarness } from '../testing/harness.js';
import { playbackSeconds, recordingKeys } from './recordings.js';

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
      expect(await bare.core.recordings.list(who, {})).toEqual({ items: [], available: false });
    } finally {
      await bare.cleanup();
    }
  }, 180_000);
});
