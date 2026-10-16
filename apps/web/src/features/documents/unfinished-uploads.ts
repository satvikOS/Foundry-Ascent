import type { DocumentView } from '@foundry/contracts';

import { isStaleUpload, type UploadResume } from '@/lib/api/hooks/documents';

import type { UploadCandidate } from './upload-validation';

/** Failure reasons that mean the file never arrived, so the same file can be uploaded into the document. */
const FILE_NEVER_ARRIVED: ReadonlySet<string> = new Set(['upload_incomplete', 'object_missing']);

/**
 * A document whose file never arrived: an upload left unfinished (still `pending_upload` long after it
 * began), or one that failed because its file never reached storage.
 */
export function isUnfinishedUpload(
  doc: Pick<DocumentView, 'status' | 'createdAt' | 'failureReason'>,
  now = Date.now(),
): boolean {
  if (doc.status === 'failed') return doc.failureReason !== null && FILE_NEVER_ARRIVED.has(doc.failureReason);
  return isStaleUpload(doc, now);
}

/**
 * The unfinished document a picked file goes into instead of a new one: same name (ignoring case), size and
 * type, so the server's presigned PUT (which signs both) accepts it. Null when there is none.
 */
export function resumableUpload(
  candidate: UploadCandidate,
  documents: readonly DocumentView[],
  now = Date.now(),
): UploadResume | null {
  const name = candidate.file.name.trim().toLowerCase();
  const match = documents.find(
    (doc) =>
      isUnfinishedUpload(doc, now) &&
      doc.filename.trim().toLowerCase() === name &&
      doc.sizeBytes === candidate.file.size &&
      doc.contentType === candidate.contentType,
  );
  return match ? { documentId: match.id, uploaded: false } : null;
}
