import {
  CompleteDocumentResponse,
  CreateDocumentRequest,
  CreateDocumentResponse,
  DocumentContentType,
  DocumentListResponse,
  MAX_DOCUMENT_BYTES,
} from '@foundry/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

import { encodeBody } from '../body';
import { api, createIdempotencyKey, path } from '../client';
import { ApiError } from '../errors';
import { queryKeys } from '../query-keys';

export type DocumentUploadTicket = z.infer<typeof CreateDocumentResponse>;
export type AllowedDocumentType = z.infer<typeof DocumentContentType>;

/** File-picker `accept` attribute for the allowed document types. */
export const DOCUMENT_ACCEPT = '.pdf,.docx,.txt,.md,' + DocumentContentType.options.join(',');

const EXTENSION_TYPES: Record<string, AllowedDocumentType> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Resolve a supported content type from the browser-reported type or the file extension. */
export function documentContentType(file: Pick<File, 'name' | 'type'>): AllowedDocumentType | null {
  const reported = DocumentContentType.safeParse(file.type);
  if (reported.success) return reported.data;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TYPES[extension] ?? null;
}

const PROCESSING_STATUSES = new Set(['pending_upload', 'processing']);

/** GET /ventures/:id/documents — polls every 3 s while any document is still processing. */
export const documentsQueryOptions = (ventureId: string) =>
  queryOptions({
    queryKey: queryKeys.venture.documents(ventureId),
    queryFn: ({ signal }) =>
      api.get(path`/ventures/${ventureId}/documents`, DocumentListResponse, { signal }),
    refetchInterval: (query) =>
      query.state.data?.items.some((doc) => PROCESSING_STATUSES.has(doc.status)) ? 3000 : false,
  });

export function useDocuments(ventureId: string) {
  return useQuery({ ...documentsQueryOptions(ventureId), select: (data) => data.items });
}

export type CreateDocumentInput = z.input<typeof CreateDocumentRequest>;

/** POST /ventures/:id/documents → document row + presigned PUT. Prefer `useUploadDocument`. */
export function useCreateDocument(ventureId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDocumentInput) =>
      api.post(
        path`/ventures/${ventureId}/documents`,
        CreateDocumentResponse,
        encodeBody(CreateDocumentRequest, input),
        {
          idempotencyKey: createIdempotencyKey(),
        },
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.venture.documents(ventureId) }),
  });
}

/**
 * POST /documents/:id/complete → `DocumentView`: 202 while ingestion runs (`status: processing`), 200 when
 * it already finished (or failed). Calling it again for a failed document restarts processing.
 */
export function useCompleteDocument(ventureId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) =>
      api.post(path`/documents/${documentId}/complete`, CompleteDocumentResponse, undefined, {
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.venture.documents(ventureId) }),
  });
}

/** DELETE /documents/:id → 204 */
export function useDeleteDocument(ventureId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) =>
      api.delete(path`/documents/${documentId}`, { idempotencyKey: createIdempotencyKey() }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.venture.documents(ventureId) });
      void client.invalidateQueries({ queryKey: queryKeys.venture.overview(ventureId) });
    },
  });
}

export interface UploadProgress {
  loaded: number;
  total: number;
  /** 0–100 */
  percent: number;
}

/**
 * PUT a file to an S3 presigned URL with progress. Cross-origin: no cookies, no CSRF or SHA-256
 * headers — only the headers the API signed into the URL.
 */
export function uploadToPresignedUrl(
  upload: DocumentUploadTicket['upload'],
  file: Blob,
  options: { onProgress?: (progress: UploadProgress) => void; signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(upload.method, upload.url);
    xhr.withCredentials = false;
    for (const [name, value] of Object.entries(upload.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      options.onProgress?.({
        loaded: event.loaded,
        total: event.total,
        percent: Math.round((event.loaded / event.total) * 100),
      });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else
        reject(
          new ApiError({
            status: xhr.status,
            code: xhr.status === 413 ? 'upload_too_large' : 'bad_request',
            title: 'Upload failed',
          }),
        );
    };
    xhr.onerror = () => {
      reject(new ApiError({ status: 0, code: 'network_error', title: 'Upload failed' }));
    };
    xhr.onabort = () => {
      reject(new DOMException('Upload cancelled', 'AbortError'));
    };
    if (options.signal) {
      if (options.signal.aborted) {
        reject(new DOMException('Upload cancelled', 'AbortError'));
        return;
      }
      options.signal.addEventListener(
        'abort',
        () => {
          xhr.abort();
        },
        { once: true },
      );
    }
    xhr.send(file);
  });
}

export interface UploadDocumentVariables {
  file: File;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

/**
 * Full upload flow: validate type/size locally → request a presigned PUT → upload with progress →
 * mark complete (starts ingestion). The documents list then polls until the document is ready.
 */
export function useUploadDocument(ventureId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, onProgress, signal }: UploadDocumentVariables) => {
      const contentType = documentContentType(file);
      if (!contentType) {
        throw new ApiError({ status: 415, code: 'unsupported_media_type', title: 'Unsupported file type' });
      }
      if (file.size > MAX_DOCUMENT_BYTES) {
        throw new ApiError({ status: 413, code: 'upload_too_large', title: 'File too large' });
      }
      const ticket = await api.post(
        path`/ventures/${ventureId}/documents`,
        CreateDocumentResponse,
        encodeBody(CreateDocumentRequest, { filename: file.name, contentType, sizeBytes: file.size }),
        { idempotencyKey: createIdempotencyKey(), signal },
      );
      void client.invalidateQueries({ queryKey: queryKeys.venture.documents(ventureId) });
      await uploadToPresignedUrl(ticket.upload, file, { onProgress, signal });
      // 202 (processing) and 200 both carry the DocumentView; the list polls until it settles.
      return api.post(path`/documents/${ticket.document.id}/complete`, CompleteDocumentResponse, undefined, {
        idempotencyKey: createIdempotencyKey(),
        signal,
      });
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.venture.documents(ventureId) }),
  });
}
