import {
  AbandonDocumentUploadResponse,
  CompleteDocumentResponse,
  CreateDocumentRequest,
  CreateDocumentResponse,
  DocumentContentType,
  DocumentListResponse,
  MAX_DOCUMENT_BYTES,
  RenewDocumentUploadResponse,
  type DocumentView,
} from '@foundry/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

import { encodeBody } from '../body';
import { api, createIdempotencyKey, path } from '../client';
import { ApiError, isApiError } from '../errors';
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

/**
 * How long a registered upload can still be under way. Its presigned URL lives 5 minutes, so a document
 * still `pending_upload` 15 minutes after it was registered was left (a closed tab, a lost connection):
 * the list stops waiting for it and says so. Daily maintenance later marks it `failed` (`upload_incomplete`).
 */
export const STALE_UPLOAD_MS = 15 * 60 * 1000;

/** A document whose upload was left unfinished (see {@link STALE_UPLOAD_MS}). */
export function isStaleUpload(doc: Pick<DocumentView, 'status' | 'createdAt'>, now = Date.now()): boolean {
  return doc.status === 'pending_upload' && now - Date.parse(doc.createdAt) > STALE_UPLOAD_MS;
}

/** A document that is still moving on by itself: being processed, or an upload still under way. */
export function isInFlight(doc: Pick<DocumentView, 'status' | 'createdAt'>, now = Date.now()): boolean {
  return doc.status === 'processing' || (doc.status === 'pending_upload' && !isStaleUpload(doc, now));
}

/**
 * GET /ventures/:id/documents — polls every 3 s while a document is still in flight; never for settled
 * (ready, failed) documents or uploads that were left unfinished.
 */
export const documentsQueryOptions = (ventureId: string) =>
  queryOptions({
    queryKey: queryKeys.venture.documents(ventureId),
    queryFn: ({ signal }) =>
      api.get(path`/ventures/${ventureId}/documents`, DocumentListResponse, { signal }),
    refetchInterval: (query) => (query.state.data?.items.some((doc) => isInFlight(doc)) ? 3000 : false),
  });

export function useDocuments(ventureId: string) {
  return useQuery({ ...documentsQueryOptions(ventureId), select: (data) => data.items });
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

/** DELETE /documents/:id → 204, then the venture's documents and overview are read again. */
export async function deleteDocument(
  client: QueryClient,
  ventureId: string,
  documentId: string,
): Promise<void> {
  await api.delete(path`/documents/${documentId}`, { idempotencyKey: createIdempotencyKey() });
  void client.invalidateQueries({ queryKey: queryKeys.venture.documents(ventureId) });
  void client.invalidateQueries({ queryKey: queryKeys.venture.overview(ventureId) });
}

/** DELETE /documents/:id → 204 */
export function useDeleteDocument(ventureId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => deleteDocument(client, ventureId, documentId),
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

/**
 * Where an upload attempt got to: the document it registered, and whether the file reached storage. A retry
 * passes it back so it reuses that document (and skips the PUT when the file already arrived).
 */
export interface UploadResume {
  documentId: string;
  uploaded: boolean;
}

/**
 * The abort reason for an upload the person cancelled: its document is deleted. Any other abort (the page
 * was left) or failure keeps the document, marked unfinished, for a retry.
 */
export const UPLOAD_CANCELLED = 'upload_cancelled';

export interface UploadDocumentVariables {
  file: File;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  /** Continue an earlier attempt's document instead of registering another (Retry). */
  resume?: UploadResume | null;
  /** Told the document this attempt uses, and when its file is stored. */
  onResume?: (resume: UploadResume) => void;
}

/** DELETE /documents/:id (the person cancelled) or POST /documents/:id/abandon (anything else); best effort. */
async function settleStoppedUpload(documentId: string, cancelled: boolean): Promise<void> {
  try {
    if (cancelled) {
      await api.delete(path`/documents/${documentId}`, { idempotencyKey: createIdempotencyKey() });
    } else {
      await api.post(path`/documents/${documentId}/abandon`, AbandonDocumentUploadResponse, undefined, {
        idempotencyKey: createIdempotencyKey(),
      });
    }
  } catch {
    // Daily maintenance marks an upload left pending as unfinished; nothing else depends on this call.
  }
}

/**
 * Full upload flow: validate type/size locally → register the document and get a presigned PUT (or, on a
 * retry, a fresh PUT for the same document) → upload with progress → mark complete (starts ingestion). The
 * documents list then polls until the document is ready. When the upload stops, its document never stays
 * "Uploading": a cancelled one is deleted, any other is marked unfinished (`upload_incomplete`) for a retry.
 * A plain function (not only a mutation) so a venture's upload queue can run it outside any one page.
 */
export async function uploadDocument(
  client: QueryClient,
  ventureId: string,
  { file, onProgress, signal, resume, onResume }: UploadDocumentVariables,
): Promise<DocumentView> {
  const contentType = documentContentType(file);
  if (!contentType) {
    throw new ApiError({ status: 415, code: 'unsupported_media_type', title: 'Unsupported file type' });
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new ApiError({ status: 413, code: 'upload_too_large', title: 'File too large' });
  }
  let documentId = resume?.documentId ?? null;
  let uploaded = resume?.uploaded ?? false;
  const report = () => {
    if (documentId !== null) onResume?.({ documentId, uploaded });
  };
  try {
    if (!uploaded) {
      let ticket: DocumentUploadTicket | null = null;
      if (documentId !== null) {
        try {
          ticket = await api.post(
            path`/documents/${documentId}/upload`,
            RenewDocumentUploadResponse,
            undefined,
            {
              idempotencyKey: createIdempotencyKey(),
              signal,
            },
          );
        } catch (error) {
          // 404: the document is gone (deleted meanwhile), so the file is registered again. 409: its
          // file already arrived, so only completing is left.
          if (isApiError(error) && error.status === 404) documentId = null;
          else if (isApiError(error) && error.status === 409) uploaded = true;
          else throw error;
        }
      }
      if (documentId === null) {
        ticket = await api.post(
          path`/ventures/${ventureId}/documents`,
          CreateDocumentResponse,
          encodeBody(CreateDocumentRequest, { filename: file.name, contentType, sizeBytes: file.size }),
          { idempotencyKey: createIdempotencyKey(), signal },
        );
      }
      if (ticket) {
        documentId = ticket.document.id;
        report();
        void client.invalidateQueries({ queryKey: queryKeys.venture.documents(ventureId) });
        await uploadToPresignedUrl(ticket.upload, file, { onProgress, signal });
        uploaded = true;
      }
      report();
    }
    if (documentId === null) throw new Error('upload has no document');
    // 202 (processing) and 200 both carry the DocumentView; the list polls until it settles.
    return await api.post(path`/documents/${documentId}/complete`, CompleteDocumentResponse, undefined, {
      idempotencyKey: createIdempotencyKey(),
      signal,
    });
  } catch (error) {
    if (documentId !== null) {
      await settleStoppedUpload(documentId, signal?.reason === UPLOAD_CANCELLED);
    }
    throw error;
  } finally {
    void client.invalidateQueries({ queryKey: queryKeys.venture.documents(ventureId) });
  }
}
