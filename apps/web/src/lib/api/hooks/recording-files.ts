import { RecordingDownloadResponse, type RecordingDownloadFile } from '@foundry/contracts/recording-files';

import { api, path } from '../client';

/*
 * Saving a call recording's files (ADR-0023), only in the Recordings pages' own code: its contracts are at a subpath
 * of their own, kept off the first page load.
 */

export interface RecordingDownloadRequest {
  readonly file: RecordingDownloadFile;
  /** The vEIR's name as the person sees it (the file is named after it). */
  readonly name: string;
}

/**
 * `GET /recordings/:id/download`: a short-lived presigned GET that saves the recording (or its transcript) under a
 * readable name in the person's time zone, signed (and audited as a download) only when they ask for it.
 */
export function fetchRecordingDownload(
  recordingId: string,
  request: RecordingDownloadRequest,
): Promise<RecordingDownloadResponse> {
  return api.get(path`/recordings/${recordingId}/download`, RecordingDownloadResponse, {
    query: {
      file: request.file,
      name: request.name,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
}
