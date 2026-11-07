import { z } from 'zod';

import { Timestamp } from './domain.js';

/*
 * Saving a call recording's files (ADR-0023 §4), at a subpath of their own (`@foundry/contracts/recording-files`)
 * rather than the package's main entry: the web app's first screen imports the main entry, and these schemas belong
 * only in the Recordings pages' lazily loaded code (and the server).
 */

/** Which file of a recording is saved: the recording itself, or its WebVTT transcript. */
export const RecordingDownloadFile = z.enum(['recording', 'transcript']);
export type RecordingDownloadFile = z.infer<typeof RecordingDownloadFile>;

/**
 * `GET /recordings/:id/download` query. `name` is the vEIR's name as the person sees it and `timeZone` theirs (an IANA
 * name), so the file is named as they would name it ("Thomas call 2026-11-07 14-22.webm"); without them the name
 * is "Call …" in UTC.
 */
export const RecordingDownloadQuery = z.object({
  file: RecordingDownloadFile.default('recording'),
  name: z.string().trim().max(80).optional(),
  timeZone: z.string().max(64).optional(),
});
export type RecordingDownloadQuery = z.infer<typeof RecordingDownloadQuery>;

/**
 * `GET /recordings/:id/download` 200 body: one short-lived presigned GET that saves the file under `filename`
 * (`Content-Disposition: attachment`), issued to the recording's owner only and audited as a download. The browser
 * follows it as a link (a navigation, never a fetch), so the recordings bucket needs no CORS for it.
 */
export const RecordingDownloadResponse = z.object({
  url: z.url(),
  expiresAt: Timestamp,
  filename: z.string().min(1),
});
export type RecordingDownloadResponse = z.infer<typeof RecordingDownloadResponse>;
