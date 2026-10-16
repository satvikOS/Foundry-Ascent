import { type DocumentView, type SourceTextResponse } from '@foundry/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { isApiError } from '@/lib/api/errors';
import { useDocuments } from '@/lib/api/hooks/documents';
import { documentBodyQueryOptions, sourceTextQueryOptions } from '@/lib/api/hooks/document-viewer';

import type { ViewerTarget } from './viewer-search';

/*
 * What the viewer shows for a target: a venture document (its file, or its extracted text) or a cited
 * source's text, the cited passage's text, and how to render it.
 */

/** Failure reasons that mean the file never arrived (nothing to show or download). */
const FILE_NEVER_ARRIVED = new Set(['upload_incomplete', 'object_missing']);

/** Whether a document's original file is in storage (the server signs GETs only then). */
export function hasStoredFile(doc: Pick<DocumentView, 'status' | 'failureReason'>): boolean {
  if (doc.status === 'processing' || doc.status === 'ready') return true;
  return doc.status === 'failed' && !FILE_NEVER_ARRIVED.has(doc.failureReason ?? '');
}

export type DocumentKind = 'pdf' | 'markdown' | 'plain' | 'word';

export function documentKind(contentType: DocumentView['contentType']): DocumentKind {
  switch (contentType) {
    case 'application/pdf':
      return 'pdf';
    case 'text/markdown':
      return 'markdown';
    case 'text/plain':
      return 'plain';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'word';
  }
}

export type ViewerSubject =
  | { readonly state: 'loading' }
  /** Not here (deleted, never existed) or not readable by this person: both look the same. */
  | { readonly state: 'missing' }
  | { readonly state: 'error'; readonly error: unknown; readonly retry: () => void }
  | { readonly state: 'document'; readonly document: DocumentView }
  | { readonly state: 'source'; readonly text: SourceTextResponse };

const isNotFound = (error: unknown): boolean =>
  isApiError(error) && (error.status === 404 || error.status === 403);

/** Resolves the target: a document from the venture's list (a cited venture source too), or a source. */
export function useViewerSubject(ventureId: string, target: ViewerTarget): ViewerSubject {
  const documents = useDocuments(ventureId);
  const documentFromList = useMemo(() => {
    const items = (documents.data ?? []).filter((d) => d.status !== 'deleted');
    return target.kind === 'document'
      ? (items.find((d) => d.id === target.documentId) ?? null)
      : (items.find((d) => d.sourceId === target.sourceId) ?? null);
  }, [documents.data, target]);
  // A source that is not one of the venture's documents is read as text (program or public material).
  const sourceId =
    target.kind === 'source' && documents.isSuccess && documentFromList === null ? target.sourceId : null;
  const source = useQuery({
    ...sourceTextQueryOptions(ventureId, sourceId ?? '', null),
    enabled: sourceId !== null,
  });

  if (documentFromList) return { state: 'document', document: documentFromList };
  if (documents.isPending) return { state: 'loading' };
  if (documents.isError) {
    return { state: 'error', error: documents.error, retry: () => void documents.refetch() };
  }
  if (target.kind === 'document') return { state: 'missing' };
  if (source.isPending) return { state: 'loading' };
  if (source.isError) {
    return isNotFound(source.error)
      ? { state: 'missing' }
      : { state: 'error', error: source.error, retry: () => void source.refetch() };
  }
  return { state: 'source', text: source.data };
}

/** The original file of a document as bytes (when it is stored and shown in its own layout). */
export function useDocumentBody(document: DocumentView, enabled: boolean) {
  const client = useQueryClient();
  return useQuery({ ...documentBodyQueryOptions(client, document.id), enabled });
}

/** The text of the cited passage (for a document shown in its own layout). */
export function useCitedPassage(ventureId: string, sourceId: string | null, passageId: string | null) {
  const query = useQuery({
    ...sourceTextQueryOptions(ventureId, sourceId ?? '', passageId),
    enabled: sourceId !== null && passageId !== null,
  });
  return {
    text: query.data?.passages[0]?.text ?? null,
    pending: sourceId !== null && passageId !== null && query.isPending,
  };
}

/** A document's extracted text (Word files, and any document whose file cannot be shown). */
export function useExtractedText(ventureId: string, sourceId: string | null, enabled: boolean) {
  return useQuery({
    ...sourceTextQueryOptions(ventureId, sourceId ?? '', null),
    enabled: enabled && sourceId !== null,
  });
}
