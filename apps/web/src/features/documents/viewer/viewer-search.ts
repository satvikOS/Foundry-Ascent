/*
 * The document viewer lives in the URL, so an open document is a link: `?doc=<document id>` (a venture
 * document) or `?src=<knowledge source id>` (a source a vEIR cited: a venture document's source or program
 * material), each with an optional `&passage=<passage id>` (the cited passage, highlighted). Back closes it.
 */

declare module '@tanstack/react-router' {
  interface HistoryState {
    /** The viewer was opened in the app (Back, Escape and Close return to the page under it). */
    documentViewer?: boolean;
  }
}

export interface DocumentViewerSearch {
  doc?: string | undefined;
  src?: string | undefined;
  passage?: string | undefined;
}

/** What the viewer shows. */
export type ViewerTarget =
  | { readonly kind: 'document'; readonly documentId: string; readonly passageId: string | null }
  | { readonly kind: 'source'; readonly sourceId: string; readonly passageId: string | null };

/** An RFC 9562 UUID (what every document, source and passage id is). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const uuid = (value: unknown): string | undefined =>
  typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : undefined;

/** Parses the viewer's search params (anything malformed is dropped, so a bad link opens nothing). */
export function validateDocumentViewerSearch(search: Record<string, unknown>): DocumentViewerSearch {
  const doc = uuid(search.doc);
  const src = doc === undefined ? uuid(search.src) : undefined;
  const passage = doc !== undefined || src !== undefined ? uuid(search.passage) : undefined;
  return { doc, src, passage };
}

/** The viewer's target from (already validated) search params, or null when it is closed. */
export function viewerTarget(search: DocumentViewerSearch): ViewerTarget | null {
  if (search.doc !== undefined) {
    return { kind: 'document', documentId: search.doc, passageId: search.passage ?? null };
  }
  if (search.src !== undefined) {
    return { kind: 'source', sourceId: search.src, passageId: search.passage ?? null };
  }
  return null;
}

/** What to open: a document by id, or a cited source (with the passage to show). */
export type OpenDocumentInput =
  | { readonly documentId: string; readonly passageId?: string | null }
  | { readonly sourceId: string; readonly passageId?: string | null };

/** The search params that open `input` (keeping the page's own). */
export function viewerSearchFor<T extends object>(
  previous: T,
  input: OpenDocumentInput | null,
): T & DocumentViewerSearch {
  if (input === null) return { ...previous, doc: undefined, src: undefined, passage: undefined };
  return {
    ...previous,
    doc: 'documentId' in input ? input.documentId : undefined,
    src: 'sourceId' in input ? input.sourceId : undefined,
    passage: input.passageId ?? undefined,
  };
}
