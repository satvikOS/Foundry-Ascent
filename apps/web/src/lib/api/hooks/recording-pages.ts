import { RecordingListResponse } from '@foundry/contracts';
import { infiniteQueryOptions, useInfiniteQuery } from '@tanstack/react-query';

import { api } from '../client';
import { queryKeys } from '../query-keys';

/*
 * The Recordings section's pages of recordings (ADR-0023), only in that page's own code, kept off the first page load.
 */

/** Recordings a page of the Recordings section holds before "Show older recordings". */
export const RECORDING_PAGE_SIZE = 50;

/** GET /recordings — one venture's ready recordings, latest first, a page at a time. */
export const recordingPagesQueryOptions = (ventureId: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.recordings.pages(ventureId),
    queryFn: ({ signal, pageParam }) =>
      api.get('/recordings', RecordingListResponse, {
        signal,
        query: { ventureId, limit: RECORDING_PAGE_SIZE, cursor: pageParam ?? undefined },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page: RecordingListResponse) => page.nextCursor,
  });

export function useRecordingPages(ventureId: string) {
  return useInfiniteQuery(recordingPagesQueryOptions(ventureId));
}
