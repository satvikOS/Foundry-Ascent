/**
 * Idempotent multi-row inserts for the seed: rows are inserted only when absent (ON CONFLICT DO NOTHING), so a
 * re-run never duplicates data and never overwrites what the product changed.
 */
import { SqlUsageError } from '../errors.js';
import { type SystemExecutor } from '../executor.js';
import { p } from '../params.js';

export type ColumnType = 'uuid' | 'text' | 'text[]' | 'jsonb' | 'integer' | 'numeric' | 'boolean' | 'timestamptz';
export type Columns = Readonly<Record<string, ColumnType>>;
export type Row = Readonly<Record<string, unknown>>;

const NAME = /^[a-z_][a-z0-9_]*$/;
const BATCH = 100;

/** `a, b, c` and `a uuid, b text, …` for a column map (names are code constants, checked anyway). */
function columnLists(columns: Columns): { names: string[]; typed: string } {
  const names = Object.keys(columns);
  for (const n of names) if (!NAME.test(n)) throw new SqlUsageError('invalid column name');
  return { names, typed: names.map((n) => `${n} ${columns[n] ?? 'text'}`).join(', ') };
}

/**
 * Multi-row insert through `jsonb_to_recordset` (one round trip per batch for both drivers). Returns the
 * number of rows inserted.
 */
export async function insertRows(
  sx: SystemExecutor,
  table: string,
  columns: Columns,
  rows: readonly Row[],
): Promise<number> {
  if (rows.length === 0) return 0;
  if (!NAME.test(table)) throw new SqlUsageError('invalid table name');
  const { names, typed } = columnLists(columns);
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const result = await sx.query(
      `INSERT INTO ${table} (${names.join(', ')})
       SELECT ${names.join(', ')} FROM jsonb_to_recordset(:rows) AS x (${typed})
       ON CONFLICT DO NOTHING`,
      { rows: p.json(rows.slice(i, i + BATCH)) },
    );
    inserted += result.rowCount;
  }
  return inserted;
}

/**
 * Inserts one knowledge source and its chunks in a single statement, the chunks only when the source itself
 * is new. A source that already exists keeps exactly the chunks it has: one a curator edited (re-chunked to
 * fewer sections) or withdrew (no chunks), or a document a founder deleted, is never given its seeded
 * chunks back. Returns the number of chunks inserted.
 */
export async function insertSourceWithChunks(
  sx: SystemExecutor,
  args: {
    readonly sourceColumns: Columns;
    readonly source: Row;
    readonly chunkColumns: Columns;
    readonly chunks: readonly Row[];
  },
): Promise<number> {
  const source = columnLists(args.sourceColumns);
  const chunk = columnLists(args.chunkColumns);
  if (!source.names.includes('id') || !chunk.names.includes('source_id')) {
    throw new SqlUsageError('a seeded source needs an id and its chunks a source_id');
  }
  const result = await sx.query(
    `WITH src AS (
       INSERT INTO knowledge_sources (${source.names.join(', ')})
       SELECT ${source.names.join(', ')} FROM jsonb_to_recordset(:source) AS x (${source.typed})
       ON CONFLICT DO NOTHING
       RETURNING id)
     INSERT INTO knowledge_chunks (${chunk.names.join(', ')})
     SELECT ${chunk.names.map((n) => `c.${n}`).join(', ')} FROM jsonb_to_recordset(:chunks) AS c (${chunk.typed})
     WHERE c.source_id IN (SELECT id FROM src)
     ON CONFLICT DO NOTHING`,
    { source: p.json([args.source]), chunks: p.json(args.chunks) },
  );
  return result.rowCount;
}

/**
 * The authored text of a seeded corpus from its sections, exactly as migrations 0004 and 0005 rebuild it
 * from chunks for databases seeded before corpora were authored notes.
 */
export function bodyFromSections(sections: readonly { heading: string | null; content: string }[]): string {
  return sections
    .map((s) => (s.heading === null || s.heading === '' ? s.content : `## ${s.heading}\n\n${s.content}`))
    .join('\n\n');
}
