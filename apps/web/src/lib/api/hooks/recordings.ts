import { RecordingListResponse, RecordingPlaybackResponse } from '@foundry/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api, createIdempotencyKey, path } from '../client';
import { queryKeys } from '../query-keys';

/*
 * Call recordings (ADR-0023): the person's own recordings, saved from the call screen and replayed without the vEIR.
 * Saving one is in recording-upload.ts, which only the call screen loads.
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
