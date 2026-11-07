import {
  CreateRecordingResponse,
  RecordingView,
  type CreateRecordingRequest,
  type RecordingMimeType,
} from '@foundry/contracts';

import { api, createIdempotencyKey, path } from '../client';
import { uploadToPresignedUrl, type UploadProgress } from './documents';

/*
 * Saving a call recording (ADR-0023). Files go straight to the recordings store with presigned URLs; the API only
 * signs them and keeps the record. A module of its own so the first page load (which reads the recordings list for
 * its route) never carries it: only the call screen, a lazy chunk, imports it.
 */

/** A finished recording of a call, as the call screen hands it over to be saved. */
export interface RecordedCall {
  readonly callId: string;
  readonly media: Blob;
  readonly mimeType: RecordingMimeType;
  readonly durationMs: number;
  /** The WebVTT transcript, or null when nobody said anything while it recorded. */
  readonly captions: { readonly vtt: string; readonly cues: number } | null;
}

/**
 * Saves a recording: registers it for the call (POST /calls/:id/recordings), uploads its captions and then the
 * recording to their presigned URLs, then completes it (POST /recordings/:id/complete). Resolves with the ready
 * recording. Both URLs are signed together and must be used within minutes, while the recording of a long call can
 * take longer than that to upload: the small captions file goes first, so neither upload starts after its URL expired.
 */
export async function saveRecording(
  recording: RecordedCall,
  options: { readonly onProgress?: (progress: UploadProgress) => void; readonly signal?: AbortSignal } = {},
): Promise<RecordingView> {
  const captions =
    recording.captions === null ? null : new Blob([recording.captions.vtt], { type: 'text/vtt' });
  const body: CreateRecordingRequest = {
    mimeType: recording.mimeType,
    bytes: recording.media.size,
    durationMs: Math.max(1, Math.round(recording.durationMs)),
    captions:
      captions === null || recording.captions === null
        ? null
        : { bytes: captions.size, cues: recording.captions.cues },
  };
  const ticket = await api.post(path`/calls/${recording.callId}/recordings`, CreateRecordingResponse, body, {
    idempotencyKey: createIdempotencyKey(),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (ticket.upload.captions !== null && captions !== null) {
    await uploadToPresignedUrl(
      ticket.upload.captions,
      captions,
      options.signal ? { signal: options.signal } : {},
    );
  }
  await uploadToPresignedUrl(ticket.upload.media, recording.media, {
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return api.post(path`/recordings/${ticket.recording.id}/complete`, RecordingView, undefined, {
    idempotencyKey: createIdempotencyKey(),
  });
}
