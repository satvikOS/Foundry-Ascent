import { col, type RawRow } from '../columns.js';
import { type SqlExecutor } from '../executor.js';
import { p } from '../params.js';
import { clampLimit, queryFirst, queryRows } from './common.js';

/*
 * Reading a knowledge source in the document viewer: its passages (knowledge chunks) in order, under RLS
 * (venture passages only for those who can read the venture). Passage content is document text: never log it.
 */

/** One passage of a source as stored (chunks of a section overlap; core removes the repeated part). */
export interface StoredPassage {
  readonly id: string;
  readonly ordinal: number;
  readonly heading: string | null;
  readonly content: string;
}

/**
 * A page size that keeps every statement's result far below the RDS Data API's 1 MB limit: a chunk is
 * ~800 tokens (≈ 3,200 characters) plus its overlap.
 */
export const PASSAGE_PAGE = 100;

function decodePassage(r: RawRow): StoredPassage {
  return {
    id: col.uuid.decode(r.id, 'id'),
    ordinal: col.int.decode(r.ordinal, 'ordinal'),
    heading: col.text.nullable.decode(r.heading, 'heading'),
    content: col.text.decode(r.content, 'content'),
  };
}

/** Passages of a source after `afterOrdinal`, in reading order, at most `limit` (default {@link PASSAGE_PAGE}). */
export function listSourcePassages(
  ex: SqlExecutor,
  sourceId: string,
  options: { readonly afterOrdinal?: number; readonly limit?: number } = {},
): Promise<StoredPassage[]> {
  return queryRows(
    ex,
    `SELECT id, ordinal, heading, content FROM knowledge_chunks
     WHERE source_id = :sourceId AND ordinal > :after
     ORDER BY ordinal
     LIMIT :limit`,
    {
      sourceId: p.uuid(sourceId),
      after: p.int(Math.max(0, Math.trunc(options.afterOrdinal ?? 0))),
      limit: p.int(clampLimit(options.limit, PASSAGE_PAGE, PASSAGE_PAGE)),
    },
    decodePassage,
  );
}

/**
 * One passage of a source and the passage right before it (to remove the part they share), in order.
 * Empty when the passage is not part of the source or not visible.
 */
export function getSourcePassageWithPrevious(
  ex: SqlExecutor,
  sourceId: string,
  passageId: string,
): Promise<StoredPassage[]> {
  return queryRows(
    ex,
    `SELECT c.id, c.ordinal, c.heading, c.content
     FROM knowledge_chunks c
     JOIN knowledge_chunks t ON t.source_id = c.source_id AND t.id = :passageId
     WHERE c.source_id = :sourceId AND c.ordinal IN (t.ordinal - 1, t.ordinal)
     ORDER BY c.ordinal`,
    { sourceId: p.uuid(sourceId), passageId: p.uuid(passageId) },
    decodePassage,
  );
}

/** The (not deleted) venture document whose passages a knowledge source holds, or null. */
export function documentIdForSource(ex: SqlExecutor, sourceId: string): Promise<string | null> {
  return queryFirst(
    ex,
    `SELECT id FROM documents WHERE source_id = :sourceId AND status <> 'deleted' ORDER BY created_at DESC LIMIT 1`,
    { sourceId: p.uuid(sourceId) },
    (r) => col.uuid.decode(r.id, 'id'),
  );
}
