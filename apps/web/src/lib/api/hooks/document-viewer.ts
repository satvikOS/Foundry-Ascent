import { DocumentFileResponse, SourceTextResponse } from '@foundry/contracts';
import { type QueryClient, queryOptions } from '@tanstack/react-query';

import { api, path } from '../client';
import { ApiError, isApiError } from '../errors';
import { queryKeys } from '../query-keys';

/**
 * The viewer's query keys, under the factory's own prefixes (a venture's scope, the app root) so the usual
 * invalidations reach them. They live here, with the viewer's code (loaded on first use), rather than in
 * the factory, which ships in the entry bundle.
 */
export const viewerKeys = {
  /** `GET /ventures/:id/sources/:sourceId/text` (`passage`: only that one). */
  sourceText: (ventureId: string, sourceId: string, passage: string | null = null) =>
    [...queryKeys.venture.scope(ventureId), 'source-text', sourceId, passage ?? 'all'] as const,
  /** `GET /documents/:id/file`: short-lived presigned GETs of the document's original file. */
  file: (documentId: string) => [...queryKeys.all, 'document', documentId, 'file'] as const,
  /** The original file's bytes, read through its presigned GET. */
  body: (documentId: string) => [...queryKeys.all, 'document', documentId, 'body'] as const,
};

/** The server signs the file's URLs for two minutes: fresh for one, then asked for again. */
const FILE_URLS_FRESH_MS = 60_000;

/** Client errors (no access, not uploaded yet) are answers, not blips: never retried. */
function retryServerErrors(failures: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failures < 1;
}

/** `GET /documents/:id/file`: presigned GETs of the original file (shown inline, or saved). */
export const documentFileQueryOptions = (documentId: string) =>
  queryOptions({
    queryKey: viewerKeys.file(documentId),
    queryFn: ({ signal }) => api.get(path`/documents/${documentId}/file`, DocumentFileResponse, { signal }),
    staleTime: FILE_URLS_FRESH_MS,
    gcTime: FILE_URLS_FRESH_MS,
    retry: retryServerErrors,
  });

/**
 * `GET /ventures/:id/sources/:sourceId/text`: a cited source's passages in reading order, or (with a
 * passage id) only that passage.
 */
export const sourceTextQueryOptions = (ventureId: string, sourceId: string, passage: string | null = null) =>
  queryOptions({
    queryKey: viewerKeys.sourceText(ventureId, sourceId, passage),
    queryFn: ({ signal }) =>
      api.get(path`/ventures/${ventureId}/sources/${sourceId}/text`, SourceTextResponse, {
        signal,
        ...(passage === null ? {} : { query: { passage } }),
      }),
    staleTime: 5 * 60_000,
    retry: retryServerErrors,
  });

/**
 * Reads a stored file through its presigned GET: cross-origin to the documents bucket (its CORS allows
 * GET from the app), so no cookies and no referrer are sent.
 */
export async function fetchStoredFile(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new ApiError({
      status: response.status,
      code: response.status === 404 ? 'not_found' : 'bad_request',
      title: 'The file could not be read',
    });
  }
  return response.arrayBuffer();
}

/**
 * The original file's bytes (fresh URLs first, then the file itself). Kept briefly so reopening the same
 * document is instant; never stored anywhere else.
 */
export const documentBodyQueryOptions = (client: QueryClient, documentId: string) =>
  queryOptions({
    queryKey: viewerKeys.body(documentId),
    queryFn: async ({ signal }) => {
      const file = await client.query(documentFileQueryOptions(documentId));
      return fetchStoredFile(file.url, signal);
    },
    staleTime: Infinity,
    gcTime: 2 * 60_000,
    retry: retryServerErrors,
  });
