import {
  CreateRecordingResponse,
  RecordingListResponse,
  RecordingPlaybackResponse,
  RecordingView,
  type CreateRecordingRequest,
  type RecordingMimeType,
} from '@foundry/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api, createIdempotencyKey, path } from '../client';
import { queryKeys } from '../query-keys';
import { uploadToPresignedUrl, type UploadProgress } from './documents';

/*
 * Call recordings (ADR-0023): the person's own recordings, saved from the call screen and replayed without the vEIR.
 * Files go straight to the recordings store with presigned URLs; the API only signs them and keeps the record.
 */

export interface RecordingFilters {
  readonly sessionId?: string;
  readonly ventureId?: string;
}

/** GET /recordings — the caller's ready recordings, latest first. */
export const recordingsQueryOptions = (filters: RecordingFilters) =>
  queryOptions({
    queryKey: queryKeys.recordings.list({ ...filters }),
    queryFn: ({ signal }) => {
      const query = new URLSearchParams();
      if (filters.sessionId) query.set('sessionId', filters.sessionId);
      if (filters.ventureId) query.set('ventureId', filters.ventureId);
      const search = query.toString();
      return api.get(`/recordings${search ? `?${search}` : ''}`, RecordingListResponse, { signal });
    },
  });

export function useRecordings(filters: RecordingFilters, options: { readonly enabled?: boolean } = {}) {
  return useQuery({ ...recordingsQueryOptions(filters), enabled: options.enabled ?? true });
}

/**
 * GET /recordings/:id/playback — fresh presigned GETs for one replay (never cached: they are credentials that expire,
 * and each replay is audited).
 */
export function fetchPlayback(recordingId: string, signal?: AbortSignal) {
  return api.get(
    path`/recordings/${recordingId}/playback`,
    RecordingPlaybackResponse,
    signal ? { signal } : {},
  );
}

/** DELETE /recordings/:id → 204; every list of recordings is read again. */
export async function deleteRecording(client: QueryClient, recordingId: string): Promise<void> {
  await api.delete(path`/recordings/${recordingId}`, { idempotencyKey: createIdempotencyKey() });
  void client.invalidateQueries({ queryKey: queryKeys.recordings.all() });
}

export function useDeleteRecording() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (recordingId: string) => deleteRecording(client, recordingId) });
}

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
 * Saves a recording: registers it for the call (POST /calls/:id/recordings), uploads the recording and its captions to
 * their presigned URLs, then completes it (POST /recordings/:id/complete). Resolves with the ready recording.
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
  await uploadToPresignedUrl(ticket.upload.media, recording.media, {
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (ticket.upload.captions !== null && captions !== null) {
    await uploadToPresignedUrl(
      ticket.upload.captions,
      captions,
      options.signal ? { signal: options.signal } : {},
    );
  }
  return api.post(path`/recordings/${ticket.recording.id}/complete`, RecordingView, undefined, {
    idempotencyKey: createIdempotencyKey(),
  });
}
