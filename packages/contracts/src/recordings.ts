import { z } from 'zod';

import { Id, Timestamp } from './domain.js';

/**
 * Call recordings (ADR-0023, docs/architecture/calls.md §7).
 *
 * A founder records their own call from the call screen and watches it again later without calling the vEIR. The
 * browser records the call itself (the vEIR's face on a video call or the call's presence, both voices mixed, and the
 * captions as a WebVTT transcript) and uploads both files straight to the private recordings store with presigned
 * PUTs the API issues for the caller's own call; replay reads them back with short-lived presigned GETs. Nothing of a
 * recording passes through the API, and replay never calls the vEIR or any model. A private (temporary) call is never
 * recorded; deleting the conversation deletes its recordings.
 */

/** The containers a recording may be: webm (Chromium, Firefox) or mp4 (Safari); audio only where video is not possible. */
export const RECORDING_MIME_TYPES = ['video/webm', 'video/mp4', 'audio/webm', 'audio/mp4'] as const;
export const RecordingMimeType = z.enum(RECORDING_MIME_TYPES);
export type RecordingMimeType = z.infer<typeof RecordingMimeType>;

/** The captions file beside a recording. */
export const RECORDING_CAPTIONS_TYPE = 'text/vtt';

export const RECORDING_LIMITS = {
  /** Largest recording file (about 70 minutes at the bit rate the call screen records with). */
  maxBytes: 512 * 1024 * 1024,
  /** Largest captions file. */
  maxCaptionsBytes: 2 * 1024 * 1024,
  /** Most caption cues in one transcript. */
  maxCues: 20_000,
  /** A recording may run this much past its call's own time limit (the upload is measured by the browser). */
  durationSlackMs: 60_000,
  /** Recordings one person may start per UTC day. */
  dailyRecordingsPerPrincipal: 40,
  /** How long a recording is kept; then it is deleted (infra RECORDINGS_RETENTION_DAYS matches it, tested there). */
  retentionDays: 365,
} as const;

export const RecordingStatus = z.enum(['pending', 'ready']);
export type RecordingStatus = z.infer<typeof RecordingStatus>;

export const RecordingView = z.object({
  id: Id,
  callId: Id,
  sessionId: Id,
  ventureId: Id,
  /** The conversation's title when it has one (null: untitled). */
  conversationTitle: z.string().nullable(),
  mimeType: RecordingMimeType,
  /** `video` (the face or the presence, with sound) or `audio` (sound only). */
  kind: z.enum(['video', 'audio']),
  bytes: z.number().int().min(1),
  durationMs: z.number().int().min(1),
  /** Whether a captions transcript was saved with it. */
  hasCaptions: z.boolean(),
  status: RecordingStatus,
  createdAt: Timestamp,
  completedAt: Timestamp.nullable(),
});
export type RecordingView = z.infer<typeof RecordingView>;

/** A presigned PUT the browser sends one file with (exactly this type and size, before `expiresAt`). */
export const RecordingUpload = z.object({
  url: z.url(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  expiresAt: Timestamp,
});
export type RecordingUpload = z.infer<typeof RecordingUpload>;

/** `POST /calls/:id/recordings` — the caller's own call, in a remembered conversation. */
export const CreateRecordingRequest = z.object({
  mimeType: RecordingMimeType,
  bytes: z.number().int().min(1).max(RECORDING_LIMITS.maxBytes),
  durationMs: z.number().int().min(1),
  /** The WebVTT transcript beside it; null when nobody said anything while it recorded. */
  captions: z
    .object({
      bytes: z.number().int().min(1).max(RECORDING_LIMITS.maxCaptionsBytes),
      cues: z.number().int().min(1).max(RECORDING_LIMITS.maxCues),
    })
    .nullable(),
});
export type CreateRecordingRequest = z.infer<typeof CreateRecordingRequest>;

export const CreateRecordingResponse = z.object({
  recording: RecordingView,
  upload: z.object({ media: RecordingUpload, captions: RecordingUpload.nullable() }),
});
export type CreateRecordingResponse = z.infer<typeof CreateRecordingResponse>;

/** `GET /recordings` — the caller's own recordings, latest first: one conversation's, one venture's, or all. */
export const RecordingListQuery = z.object({
  sessionId: Id.optional(),
  ventureId: Id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type RecordingListQuery = z.infer<typeof RecordingListQuery>;

export const RecordingListResponse = z.object({
  items: z.array(RecordingView),
  /** Whether recordings can be saved in this environment (the recordings store is wired). */
  available: z.boolean(),
});
export type RecordingListResponse = z.infer<typeof RecordingListResponse>;

/** A presigned GET of one file of a recording (it is the authorization: short-lived, issued to its owner only). */
export const RecordingFile = z.object({ url: z.url(), expiresAt: Timestamp });

/** `GET /recordings/:id/playback` — what the player plays; it reads the files directly, never through the API. */
export const RecordingPlaybackResponse = z.object({
  recording: RecordingView,
  media: RecordingFile,
  captions: RecordingFile.nullable(),
});
export type RecordingPlaybackResponse = z.infer<typeof RecordingPlaybackResponse>;
