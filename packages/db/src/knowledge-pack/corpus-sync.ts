/**
 * Stores the cited corpus (./corpus.ts): the open library in every active tenant (scope `public`), the programme's
 * course notes in the programme's own tenant only (scope `program`). The seed runs it on every deploy; new notes get
 * their embeddings from the deploy's backfill, like any seeded passage.
 *
 * Re-running converges on the code, as the knowledge pack's sync does (./sync.ts): an absent source is inserted with
 * its notes, one whose checksum changed is re-ingested, one the code dropped is withdrawn with its notes removed (its
 * cleared checksum marks the withdrawal as the corpus's own, so it returns if the code has it again), an unchanged one
 * is not touched, and a person's withdrawal is never undone.
 */
import { SqlUsageError } from '../errors.js';
import { type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { uuidV5 } from '../seed/ids.js';
import { PROGRAMME_NOTES } from '../seed/programme-notes.js';
import {
  corpusBody,
  corpusChecksum,
  LIBRARY_URI_PREFIX,
  OPEN_LIBRARY,
  PROGRAMME_NOTES_URI_PREFIX,
  type CorpusSource,
} from './corpus.js';

export interface CorpusSyncReport {
  readonly inserted: number;
  readonly updated: number;
  readonly withdrawn: number;
  readonly unchanged: number;
  /** Sources someone withdrew, left withdrawn. */
  readonly keptWithdrawn: number;
}

interface Store {
  readonly scope: 'program' | 'public';
  readonly prefix: string;
  readonly classification: 'program_internal' | 'public';
  readonly sources: readonly CorpusSource[];
}

/** The open library's part of the corpus. */
export const LIBRARY_STORE: Store = {
  scope: 'public',
  prefix: LIBRARY_URI_PREFIX,
  classification: 'public',
  sources: OPEN_LIBRARY,
};
/** The programme's course notes. */
export const PROGRAMME_STORE: Store = {
  scope: 'program',
  prefix: PROGRAMME_NOTES_URI_PREFIX,
  classification: 'program_internal',
  sources: PROGRAMME_NOTES,
};

/** The knowledge source id of a corpus source in a tenant (deterministic, so re-runs find it). */
export function corpusSourceId(tenantId: string, uri: string): string {
  return uuidV5(`${tenantId}/corpus/${uri}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Sources per statement: a source and its notes are a few kilobytes (one HTTPS request on the Data API). */
const BATCH = 10;

/** True when the schema has the citation columns (migration 0034). */
export async function hasCitationSchema(sx: SystemExecutor): Promise<boolean> {
  const result = await sx.query(
    `SELECT count(*) = 2 AS ready FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (table_name, column_name) IN (('knowledge_sources', 'accessed_on'), ('knowledge_chunks', 'locator'))`,
  );
  return result.rows[0]?.ready === true;
}

/** Brings the tenant's copy of one part of the corpus in line with the code. Call inside a transaction. */
export async function syncCorpus(
  sx: SystemExecutor,
  args: { readonly tenantId: string; readonly store: Store },
): Promise<CorpusSyncReport> {
  const { tenantId, store } = args;
  if (!UUID.test(tenantId)) throw new SqlUsageError('syncCorpus needs a tenant id');
  const existing = await sx.query(
    `SELECT id, checksum, status FROM knowledge_sources
     WHERE tenant_id = :tenantId AND scope = :scope AND starts_with(uri, :prefix)`,
    { tenantId: p.uuid(tenantId), scope: p.text(store.scope), prefix: p.text(store.prefix) },
  );
  const stored = new Map(
    existing.rows.map((r) => [
      String(r.id),
      { checksum: r.checksum as string | null, status: String(r.status) },
    ]),
  );
  const write: CorpusSource[] = [];
  let inserted = 0;
  let unchanged = 0;
  let keptWithdrawn = 0;
  for (const source of store.sources) {
    const row = stored.get(corpusSourceId(tenantId, source.uri));
    if (row === undefined) {
      inserted += 1;
      write.push(source);
    } else if (row.status === 'withdrawn' && row.checksum !== null) keptWithdrawn += 1;
    else if (row.checksum !== corpusChecksum(source)) write.push(source);
    else unchanged += 1;
  }
  let written = 0;
  for (let i = 0; i < write.length; i += BATCH) {
    const batch = write.slice(i, i + BATCH);
    const rows = batch.map((s) => ({
      id: corpusSourceId(tenantId, s.uri),
      title: s.title,
      uri: s.uri,
      owner: s.attribution,
      license: s.licence,
      attribution: s.attribution,
      url: s.url,
      accessed_on: s.accessedOn,
      checksum: corpusChecksum(s),
      kind: s.kind,
      body: corpusBody(s),
    }));
    // The old notes go in the same statement as the new text; the new notes follow for exactly the sources it wrote.
    const result = await sx.query(
      `WITH src AS (
         INSERT INTO knowledge_sources AS k
                (id, tenant_id, scope, kind, title, uri, owner, license, attribution, url, accessed_on, classification,
                 checksum, status, freshness_at, body)
         SELECT x.id, :tenantId, :scope, x.kind, x.title, x.uri, x.owner, x.license, x.attribution, x.url,
                x.accessed_on, :classification, x.checksum, 'active', x.accessed_on, x.body
         FROM jsonb_to_recordset(:sources)
           AS x (id uuid, title text, uri text, owner text, license text, attribution text, url text, accessed_on date,
                 checksum text, kind text, body text)
         ON CONFLICT (id) DO UPDATE
            SET title = excluded.title, owner = excluded.owner, license = excluded.license,
                attribution = excluded.attribution, url = excluded.url, accessed_on = excluded.accessed_on,
                checksum = excluded.checksum, body = excluded.body, freshness_at = excluded.freshness_at,
                updated_at = now(), status = CASE WHEN k.status = 'withdrawn' THEN 'active' ELSE k.status END
          WHERE k.tenant_id = :tenantId AND k.scope = :scope
            AND (k.status <> 'withdrawn' OR k.checksum IS NULL) AND k.checksum IS DISTINCT FROM excluded.checksum
         RETURNING id)
       , del AS (DELETE FROM knowledge_chunks c USING src WHERE c.source_id = src.id)
       SELECT id FROM src`,
      {
        tenantId: p.uuid(tenantId),
        scope: p.text(store.scope),
        classification: p.text(store.classification),
        sources: p.json(rows),
      },
    );
    const ids = new Set(result.rows.map((r) => String(r.id)));
    written += ids.size;
    const chunks = batch
      .filter((s) => ids.has(corpusSourceId(tenantId, s.uri)))
      .flatMap((s) =>
        s.notes.map((n, j) => ({
          source_id: corpusSourceId(tenantId, s.uri),
          ordinal: j + 1,
          heading: n.heading,
          content: n.content,
          locator: n.locator,
          token_count: Math.ceil(n.content.length / 4),
        })),
      );
    if (chunks.length > 0) {
      await sx.query(
        `INSERT INTO knowledge_chunks (source_id, tenant_id, scope, ordinal, heading, content, locator, token_count)
         SELECT c.source_id, :tenantId, :scope, c.ordinal, c.heading, c.content, c.locator, c.token_count
         FROM jsonb_to_recordset(:chunks)
           AS c (source_id uuid, ordinal integer, heading text, content text, locator text, token_count integer)`,
        { tenantId: p.uuid(tenantId), scope: p.text(store.scope), chunks: p.json(chunks) },
      );
    }
  }
  const gone = await sx.query(
    `WITH w AS (
       UPDATE knowledge_sources SET status = 'withdrawn', checksum = NULL, updated_at = now()
        WHERE tenant_id = :tenantId AND scope = :scope AND starts_with(uri, :prefix)
          AND status <> 'withdrawn' AND NOT (id = ANY (:current))
       RETURNING id)
     , del AS (DELETE FROM knowledge_chunks c USING w WHERE c.source_id = w.id)
     SELECT count(*)::int AS n FROM w`,
    {
      tenantId: p.uuid(tenantId),
      scope: p.text(store.scope),
      prefix: p.text(store.prefix),
      current: p.uuidArray(store.sources.map((s) => corpusSourceId(tenantId, s.uri))),
    },
  );
  return {
    inserted,
    updated: written - inserted,
    withdrawn: Number(gone.rows[0]?.n ?? 0),
    unchanged,
    keptWithdrawn,
  };
}

/** The open library in every active tenant, and the programme's notes in the tenant `programmeSlug`. */
export async function syncCorpusToTenants(
  sx: SystemExecutor,
  programmeSlug: string,
): Promise<{ readonly slug: string; readonly report: CorpusSyncReport }[]> {
  const tenants = await sx.query(`SELECT id, slug FROM tenants WHERE status = 'active' ORDER BY slug`);
  const out: { slug: string; report: CorpusSyncReport }[] = [];
  for (const row of tenants.rows) {
    const tenantId = String(row.id);
    const slug = String(row.slug);
    out.push({ slug, report: await syncCorpus(sx, { tenantId, store: LIBRARY_STORE }) });
    if (slug === programmeSlug)
      out.push({ slug, report: await syncCorpus(sx, { tenantId, store: PROGRAMME_STORE }) });
  }
  return out;
}
