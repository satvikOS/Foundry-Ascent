import {
  DocumentFileQuery,
  type DocumentFileResponse,
  type SourcePassage,
  SourceTextQuery,
  type SourceTextResponse,
} from '@foundry/contracts/viewer';
import { assignmentsRepo, documentsRepo, knowledgeRepo, readerRepo } from '@foundry/db';
import { type z } from 'zod';

import { hasAnyRole, loadPrincipalRoles } from '../authz/roles.js';
import { requireVentureAccess } from '../authz/venture-access.js';
import { type RequestContext } from '../context.js';
import { fail, parseInput } from '../errors.js';
import { audit, requireId, type Kit, type RequestScope } from '../internal/kit.js';
import { classificationsFor } from '../orchestrator/evidence.js';

/**
 * The document viewer: a venture document's original file (short-lived presigned GETs, never the bytes
 * through the API) and the text of any source the venture's vEIR can cite to the reader. Both are read
 * under RLS after the venture check, and each opening is audited with identifiers only: a signed URL is the
 * authorization to read the file, so one is signed only for what the reader asked for (to show it, or to
 * save it), and each one is audited as that.
 */
export interface DocumentReaderService {
  /**
   * A presigned GET of a venture document's file (venture readers: members of any role and the assigned
   * EIR): shown inline (`document.file_opened`), or saved under the file's own name with `disposition:
   * 'attachment'` (`document.file_downloaded`). 404 for a document the caller cannot read; 409 while its
   * file has not arrived (upload unfinished, or the object went missing).
   */
  documentFile(
    ctx: RequestContext,
    documentId: string,
    query?: z.input<typeof DocumentFileQuery>,
  ): Promise<DocumentFileResponse>;
  /**
   * The text of a source the venture's vEIR can cite: one of the venture's own documents, or a program or
   * public source within the venture's data class (as retrieval sees them). A vEIR's own library is read by
   * EIR-studio roles only. With `passage`, only that passage. 404 for anything else.
   */
  sourceText(
    ctx: RequestContext,
    ventureId: string,
    sourceId: string,
    query?: z.input<typeof SourceTextQuery>,
  ): Promise<SourceTextResponse>;
}

/** Lifetime of the viewer's presigned GETs: it fetches at once, and Download signs its own at the click. */
export const FILE_URL_TTL_SECONDS = 120;

/**
 * Most characters of passage text one response carries. Extraction keeps at most 2,000,000 characters, so
 * only a source written before that cap could reach it; the response stays far below the API's limits.
 */
export const SOURCE_TEXT_MAX_CHARS = 2_000_000;

/** Sources that are still citable (withdrawn, failed and unfinished ones are not shown). */
const READABLE_SOURCE_STATUSES: ReadonlySet<string> = new Set(['active', 'stale']);

const STUDIO_ROLES = ['eir', 'program_lead', 'platform_admin'] as const;

/** Whether a document's file is in storage: anything past the upload, unless the object never arrived. */
/**
 * Where the seed puts its demo documents: their text is seeded, their file never is (production, 2026-10-17: opening
 * one asked S3 to sign a key outside the documents prefix, a TypeError and a 500, four times with the client's retries,
 * before the viewer fell back to the text).
 */
export const SEEDED_KEY_PREFIX = 'seed/';

export function fileIsStored(
  doc: Pick<documentsRepo.DocumentRecord, 'status' | 'failureReason'> &
    Partial<Pick<documentsRepo.DocumentRecord, 's3Key'>>,
): boolean {
  if (doc.s3Key?.startsWith(SEEDED_KEY_PREFIX) === true) return false;
  if (doc.status === 'processing' || doc.status === 'ready') return true;
  if (doc.status !== 'failed') return false;
  return !(documentsRepo.REUPLOADABLE_FAILURES as readonly (string | null)[]).includes(doc.failureReason);
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * A passage without the text it repeats from the passage before it. The chunker carries a section's last
 * paragraphs (or, for one long paragraph, its last sentences) into the next chunk, joined by blank lines:
 * the longest run of leading paragraphs of `next` that ends `previous` (whitespace aside) is the repeat.
 * Returns `next` unchanged when nothing is repeated, and never returns an empty passage.
 */
export function withoutOverlap(previous: string, next: string): string {
  const tail = collapse(previous);
  if (tail === '') return next;
  const breaks: number[] = [];
  for (const match of next.matchAll(/\n[ \t]*\n/g)) breaks.push(match.index);
  for (let i = breaks.length - 1; i >= 0; i -= 1) {
    const cut = breaks[i] ?? 0;
    const head = collapse(next.slice(0, cut));
    if (head === '' || !tail.endsWith(head)) continue;
    // The repeat must start at a word boundary of the previous passage, not in the middle of a word.
    const before = tail.charAt(tail.length - head.length - 1);
    if (before !== '' && before !== ' ') continue;
    const rest = next.slice(cut).replace(/^\s+/, '');
    if (rest !== '') return rest;
  }
  return next;
}

/** Stored passages → contract passages with the repeated text removed (only within one section). */
export function readablePassages(
  stored: readonly readerRepo.StoredPassage[],
  previous: readerRepo.StoredPassage | null,
): SourcePassage[] {
  let before = previous;
  return stored.map((passage) => {
    const text =
      before !== null && before.heading === passage.heading && before.ordinal === passage.ordinal - 1
        ? withoutOverlap(before.content, passage.content)
        : passage.content;
    before = passage;
    return { id: passage.id, ordinal: passage.ordinal, heading: passage.heading, text };
  });
}

/** Every passage of a source in order, a page at a time (Data API 1 MB), up to the reading limit. */
async function readAllPassages(
  scope: RequestScope,
  sourceId: string,
): Promise<{ passages: SourcePassage[]; truncated: boolean }> {
  const passages: SourcePassage[] = [];
  let chars = 0;
  let last: readerRepo.StoredPassage | null = null;
  for (;;) {
    const page = await readerRepo.listSourcePassages(scope.tx, sourceId, {
      afterOrdinal: last?.ordinal ?? 0,
    });
    for (const passage of readablePassages(page, last)) {
      if (chars + passage.text.length > SOURCE_TEXT_MAX_CHARS) return { passages, truncated: true };
      chars += passage.text.length;
      passages.push(passage);
    }
    last = page.at(-1) ?? last;
    if (page.length < readerRepo.PASSAGE_PAGE) return { passages, truncated: false };
  }
}

export function createDocumentReaderService(kit: Kit): DocumentReaderService {
  const { objectStore } = kit.deps;

  /** Whether the venture's vEIR may cite this source to the caller (see `sourceText`). */
  async function citableHere(
    scope: RequestScope,
    source: knowledgeRepo.KnowledgeSourceRecord,
    ventureId: string,
  ): Promise<boolean> {
    if (!READABLE_SOURCE_STATUSES.has(source.status)) return false;
    switch (source.scope) {
      case 'venture':
        return source.ventureId === ventureId;
      case 'program':
      case 'public': {
        // The data class retrieval uses for this venture; without an active assignment, public material only.
        const active = await assignmentsRepo.resolveActiveAssignment(scope.tx, ventureId);
        const allowed = classificationsFor(active?.assignment.dataClassCeiling ?? 'public');
        return allowed === null || allowed.includes(source.classification);
      }
      case 'persona':
        return hasAnyRole(await loadPrincipalRoles(scope.tx, scope.ctx), STUDIO_ROLES);
    }
  }

  return {
    documentFile: async (ctx, rawDocumentId, rawQuery = {}) => {
      const documentId = requireId(rawDocumentId, 'Document');
      const { disposition } = parseInput(DocumentFileQuery, rawQuery);
      const doc = await kit.inRequest(ctx, async (scope) => {
        const current = await documentsRepo.getDocument(scope.tx, documentId);
        if (current === null || current.status === 'deleted') throw fail.notFound('Document');
        await requireVentureAccess(scope, current.ventureId, 'read', {
          objectType: 'document',
          objectId: documentId,
        });
        if (!fileIsStored(current)) {
          throw fail.conflict('The file of this document has not been uploaded', 'file_not_stored');
        }
        await audit(scope, {
          action: disposition === 'inline' ? 'document.file_opened' : 'document.file_downloaded',
          outcome: 'succeeded',
          ventureId: current.ventureId,
          objectType: 'document',
          objectId: documentId,
        });
        return current;
      });
      const signed = await objectStore.presignGet({
        key: doc.s3Key,
        filename: doc.filename,
        contentType: doc.contentType,
        disposition,
        expiresInSeconds: FILE_URL_TTL_SECONDS,
      });
      return { url: signed.url, expiresAt: signed.expiresAt };
    },

    sourceText: async (ctx, rawVentureId, rawSourceId, rawQuery = {}) => {
      const ventureId = requireId(rawVentureId, 'Venture');
      const sourceId = requireId(rawSourceId, 'Source');
      const query = parseInput(SourceTextQuery, rawQuery);
      return kit.inRequest(ctx, async (scope) => {
        await requireVentureAccess(scope, ventureId, 'read', {
          objectType: 'knowledge_source',
          objectId: sourceId,
        });
        const source = await knowledgeRepo.getKnowledgeSource(scope.tx, sourceId);
        if (source === null || !(await citableHere(scope, source, ventureId))) throw fail.notFound('Source');

        let text: { passages: SourcePassage[]; truncated: boolean };
        if (query.passage === undefined) {
          text = await readAllPassages(scope, sourceId);
        } else {
          const rows = await readerRepo.getSourcePassageWithPrevious(scope.tx, sourceId, query.passage);
          const cited = rows.find((row) => row.id === query.passage);
          if (cited === undefined) throw fail.notFound('Passage');
          const previous = rows.find((row) => row.ordinal === cited.ordinal - 1) ?? null;
          text = { passages: readablePassages([cited], previous), truncated: false };
        }
        const documentId =
          source.scope === 'venture' ? await readerRepo.documentIdForSource(scope.tx, sourceId) : null;
        await audit(scope, {
          action: 'knowledge_source.text_opened',
          outcome: 'succeeded',
          ventureId,
          objectType: 'knowledge_source',
          objectId: sourceId,
          metadata: { scope: source.scope, passages: text.passages.length },
        });
        return {
          source: {
            id: source.id,
            scope: source.scope,
            kind: source.kind,
            title: source.title,
            documentId,
            freshnessAt: source.freshnessAt,
          },
          body: source.body,
          passages: text.passages,
          truncated: text.truncated,
        };
      });
    },
  };
}
