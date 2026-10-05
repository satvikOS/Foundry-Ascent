import { MAX_DOCUMENT_BYTES } from '@foundry/contracts';

import { documentContentType, type AllowedDocumentType } from '@/lib/api/hooks/documents';
import { formatBytes } from '@/lib/format';

/*
 * Client-side checks before anything is uploaded. They mirror the server's rules (system-design §8:
 * ≤ 10 MB; PDF, DOCX, TXT, MD; filename ≤ 200 chars without path separators) so people get immediate,
 * specific feedback; the API re-validates everything.
 */

export const MAX_FILES_PER_BATCH = 10;
export const MAX_FILENAME_LENGTH = 200;
export const SUPPORTED_FORMATS_LABEL = 'PDF, DOCX, TXT or Markdown';

export type UploadRejectionCode =
  'unsupported_type' | 'too_large' | 'empty' | 'invalid_name' | 'duplicate' | 'too_many';

export interface UploadCandidate {
  file: File;
  contentType: AllowedDocumentType;
}

export interface UploadRejection {
  name: string;
  code: UploadRejectionCode;
  message: string;
}

export interface UploadValidationResult {
  accepted: UploadCandidate[];
  rejected: UploadRejection[];
}

export interface UploadValidationOptions {
  /** Filenames already in the venture (processing or ready) or queued for upload. */
  existingNames?: Iterable<string>;
  maxFiles?: number;
  maxBytes?: number;
}

/** Sizes just over the limit must not read as "10 MB" — round up to one decimal. */
function megabytesRoundedUp(bytes: number): string {
  return `${(Math.ceil(bytes / ((1024 * 1024) / 10)) / 10).toFixed(1)} MB`;
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Why a single file can't be uploaded, or null when it can. */
export function fileRejection(
  file: Pick<File, 'name' | 'size' | 'type'>,
  maxBytes: number = MAX_DOCUMENT_BYTES,
): UploadRejection | null {
  const name = file.name;
  if (name.trim().length === 0 || /[/\\]/.test(name) || name.trim().length > MAX_FILENAME_LENGTH) {
    return {
      name,
      code: 'invalid_name',
      message: `Rename the file: names must be 1–${MAX_FILENAME_LENGTH} characters without slashes.`,
    };
  }
  if (!documentContentType(file)) {
    return {
      name,
      code: 'unsupported_type',
      message: `Unsupported file type. Upload a ${SUPPORTED_FORMATS_LABEL} file.`,
    };
  }
  if (file.size === 0) {
    return { name, code: 'empty', message: 'This file is empty.' };
  }
  if (file.size > maxBytes) {
    return {
      name,
      code: 'too_large',
      message: `This file is ${megabytesRoundedUp(file.size)}. The limit is ${formatBytes(maxBytes)}.`,
    };
  }
  return null;
}

/** Split a drop or picker selection into files to upload and files to explain. */
export function validateUploadFiles(
  files: readonly File[],
  options: UploadValidationOptions = {},
): UploadValidationResult {
  const maxFiles = options.maxFiles ?? MAX_FILES_PER_BATCH;
  const seen = new Set<string>();
  for (const name of options.existingNames ?? []) seen.add(nameKey(name));

  const accepted: UploadCandidate[] = [];
  const rejected: UploadRejection[] = [];
  for (const file of files) {
    const problem = fileRejection(file, options.maxBytes);
    if (problem) {
      rejected.push(problem);
      continue;
    }
    if (seen.has(nameKey(file.name))) {
      rejected.push({
        name: file.name,
        code: 'duplicate',
        message: 'A document with this name is already in the venture or the upload queue.',
      });
      continue;
    }
    if (accepted.length >= maxFiles) {
      rejected.push({
        name: file.name,
        code: 'too_many',
        message: `Upload up to ${maxFiles} files at a time.`,
      });
      continue;
    }
    seen.add(nameKey(file.name));
    const contentType = documentContentType(file);
    if (contentType) accepted.push({ file, contentType });
  }
  return { accepted, rejected };
}
