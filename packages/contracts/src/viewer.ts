import { z } from 'zod';

import { EvidenceSourceScope, Id, Timestamp } from './domain.js';
import { KnowledgeSourceKind } from './knowledge.js';

/*
 * The document viewer's contracts, at a subpath of their own (`@foundry/contracts/viewer`) rather than the
 * package's main entry: the web app's first screen imports the main entry, and these schemas belong only in
 * the viewer's lazily loaded code (and the server).
 */

/** How a document's file is asked for: shown in the app (`inline`) or saved under its own name. */
export const DocumentFileDisposition = z.enum(['inline', 'attachment']);
export type DocumentFileDisposition = z.infer<typeof DocumentFileDisposition>;

/** `GET /documents/:id/file` query: `disposition` (default `inline`). */
export const DocumentFileQuery = z.object({
  disposition: DocumentFileDisposition.default('inline'),
});
export type DocumentFileQuery = z.infer<typeof DocumentFileQuery>;

/**
 * `GET /documents/:id/file` 200 body: one short-lived presigned GET of a venture document's original file
 * (the venture's members and its assigned EIR). `inline` is what the viewer reads (the documents bucket
 * allows GET from the app's origins) and is audited as the file being opened; `attachment` saves the file
 * under its own name and is audited as a download. 409 while the file has not finished uploading (or never
 * arrived).
 */
export const DocumentFileResponse = z.object({
  url: z.url(),
  expiresAt: Timestamp,
});
export type DocumentFileResponse = z.infer<typeof DocumentFileResponse>;

/** One passage of a source's extracted text, in reading order. */
export const SourcePassage = z.object({
  /** The passage's knowledge chunk: what a cited passage's `EvidenceItem.refId` names. */
  id: Id,
  ordinal: z.number().int(),
  heading: z.string().nullable(),
  /** The passage's text, without the lines it repeats from the passage before it (passages overlap). */
  text: z.string(),
});
export type SourcePassage = z.infer<typeof SourcePassage>;

/** `GET /ventures/:id/sources/:sourceId/text` query: `passage` (a chunk id) returns only that passage. */
export const SourceTextQuery = z.object({ passage: Id.optional() });
export type SourceTextQuery = z.infer<typeof SourceTextQuery>;

/**
 * `GET /ventures/:id/sources/:sourceId/text` 200 body: the text of a source the venture's vEIR can cite to
 * the caller: one of the venture's own documents, or a program or public source within the venture's data
 * class. A vEIR's own library (scope `persona`) is read by EIR-studio roles only. 404 for anything else
 * (unknown, withdrawn, another venture's, or outside the data class).
 */
export const SourceTextResponse = z.object({
  source: z.object({
    id: Id,
    scope: EvidenceSourceScope,
    kind: KnowledgeSourceKind,
    title: z.string(),
    /** The venture document behind a `venture` source; null for every other scope. */
    documentId: Id.nullable(),
    freshnessAt: Timestamp,
  }),
  /** Text written in the app (notes, cases, FAQs) as Markdown; null for uploaded files. */
  body: z.string().nullable(),
  /** The extracted text in reading order (only the asked-for passage with `?passage=`). */
  passages: z.array(SourcePassage),
  /** The passages stop at the reading limit; the rest of the source is not shown. */
  truncated: z.boolean(),
});
export type SourceTextResponse = z.infer<typeof SourceTextResponse>;
