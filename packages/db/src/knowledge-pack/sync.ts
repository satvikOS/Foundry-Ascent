/**
 * Ingests the startup knowledge base into a tenant's common pool, idempotently. The seed runs it for every active
 * tenant on every deploy ({@link syncKnowledgePackToTenants}: production gets it with the code that reads it, and a
 * partner tenant gets its own copy), and `pnpm --filter @foundry/db knowledge-pack sync` does the same by hand.
 *
 * Where it lives: `knowledge_sources` of scope `public` (shared material the program did not write; the program's
 * own curriculum is scope `program`, the vEIR's library scope `persona`), kind `document`, classification
 * `public`, with no venture: it is never part of a venture's specific pool (memory, documents) and every venture
 * of the tenant may cite it. Each item's `uri` is {@link PACK_URI_PREFIX} + its key, `checksum` the hash of its
 * rendering, `body` the Markdown the document viewer shows (with every reference's URL), and its passages are
 * `knowledge_chunks` without embeddings: the deploy's embedding backfill embeds them like any seeded chunk.
 *
 * Re-running is safe and converges on the JSON:
 * - an item that is absent is inserted with its passages;
 * - an item whose checksum changed gets its new text and passages (the old passages are removed; the new ones are
 *   embedded by the backfill), unless someone withdrew it: a person's withdrawal is never undone;
 * - an item no longer in the JSON is withdrawn and its passages removed (its checksum cleared, which marks the
 *   withdrawal as the pack's own), and comes back if a later JSON has it again;
 * - an unchanged item is not touched.
 */
import { SqlUsageError } from '../errors.js';
import { type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { uuidV5 } from '../seed/ids.js';
import { loadKnowledgePack } from './pack.js';
import { PACK_URI_PREFIX, packItems, type PackItem } from './render.js';
import { type KnowledgePack } from './types.js';

export const PACK_OWNER = 'Startup knowledge base (academic and university sources)';

export interface KnowledgePackSyncReport {
  readonly inserted: number;
  readonly updated: number;
  readonly withdrawn: number;
  readonly unchanged: number;
  /** Items someone withdrew, left withdrawn although the JSON still has them. */
  readonly keptWithdrawn: number;
  /** Passages written by this run. */
  readonly passages: number;
}

/** The knowledge source id of an item in a tenant (deterministic, so re-runs find it). */
export function packSourceId(tenantId: string, key: string): string {
  return uuidV5(`${tenantId}/startup-knowledge-base/${key}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sourceRow(tenantId: string, item: PackItem): Record<string, unknown> {
  return {
    id: packSourceId(tenantId, item.key),
    tenant_id: tenantId,
    title: item.title,
    uri: item.uri,
    body: item.body,
    checksum: item.checksum,
    freshness_at: `${item.freshnessAt}T00:00:00Z`,
  };
}

function chunkRows(tenantId: string, item: PackItem): Record<string, unknown>[] {
  const sourceId = packSourceId(tenantId, item.key);
  return item.passages.map((passage, i) => ({
    source_id: sourceId,
    tenant_id: tenantId,
    ordinal: i + 1,
    heading: passage.heading,
    content: passage.content,
    token_count: Math.ceil(passage.content.length / 4),
  }));
}

/**
 * Items per statement: an item's text and passages are a few kilobytes, and on the RDS Data API every statement and
 * its parameters travel in one HTTPS request; ten items keep it well under a hundred kilobytes.
 */
const BATCH_ITEMS = 10;

function batches<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += BATCH_ITEMS) out.push(list.slice(i, i + BATCH_ITEMS));
  return out;
}

const CHUNK_INSERT = `INSERT INTO knowledge_chunks (source_id, tenant_id, scope, ordinal, heading, content, token_count)
  SELECT c.source_id, c.tenant_id, 'public', c.ordinal, c.heading, c.content, c.token_count
  FROM jsonb_to_recordset(:chunks) AS c (source_id uuid, tenant_id uuid, ordinal integer, heading text, content text,
                                          token_count integer)`;

/**
 * Brings the tenant's copy of the pack in line with `pack` (default: the shipped, validated JSON). Call inside a
 * transaction (the seed's, or `db.system`).
 */
export async function syncKnowledgePack(
  sx: SystemExecutor,
  args: { readonly tenantId: string; readonly pack?: KnowledgePack },
): Promise<KnowledgePackSyncReport> {
  if (!UUID.test(args.tenantId)) throw new SqlUsageError('syncKnowledgePack needs a tenant id');
  const items = packItems(args.pack ?? loadKnowledgePack());
  const tenantId = args.tenantId;
  const existing = await sx.query(
    `SELECT id, checksum, status FROM knowledge_sources
     WHERE tenant_id = :tenantId AND scope = 'public' AND starts_with(uri, :prefix)`,
    { tenantId: p.uuid(tenantId), prefix: p.text(PACK_URI_PREFIX) },
  );
  const stored = new Map(
    existing.rows.map((r) => [
      String(r.id),
      { checksum: r.checksum as string | null, status: String(r.status) },
    ]),
  );
  const fresh: PackItem[] = [];
  const changed: PackItem[] = [];
  let unchanged = 0;
  let keptWithdrawn = 0;
  for (const item of items) {
    const row = stored.get(packSourceId(tenantId, item.key));
    if (row === undefined) fresh.push(item);
    // A withdrawal by the pack itself clears the checksum: the item comes back when the JSON has it again.
    else if (row.status === 'withdrawn' && row.checksum !== null) keptWithdrawn += 1;
    else if (row.checksum !== item.checksum) changed.push(item);
    else unchanged += 1;
  }
  let passages = 0;

  for (const batch of batches(fresh)) {
    // Sources and passages in one statement; a source that appeared meanwhile keeps exactly what it has.
    const result = await sx.query(
      `WITH src AS (
         INSERT INTO knowledge_sources (id, tenant_id, scope, kind, title, uri, owner, classification, checksum,
                                        status, freshness_at, body)
         SELECT x.id, x.tenant_id, 'public', 'document', x.title, x.uri, :owner, 'public', x.checksum, 'active',
                x.freshness_at, x.body
         FROM jsonb_to_recordset(:sources) AS x (id uuid, tenant_id uuid, title text, uri text, body text,
                                                 checksum text, freshness_at timestamptz)
         ON CONFLICT DO NOTHING
         RETURNING id)
       ${CHUNK_INSERT}
       WHERE c.source_id IN (SELECT id FROM src)`,
      {
        owner: p.text(PACK_OWNER),
        sources: p.json(batch.map((item) => sourceRow(tenantId, item))),
        chunks: p.json(batch.flatMap((item) => chunkRows(tenantId, item))),
      },
    );
    passages += result.rowCount;
  }

  let updated = 0;
  for (const batch of batches(changed)) {
    // New text first (only while not withdrawn and still different), removing the old passages in the same
    // statement; then the new passages of exactly the sources that statement changed.
    const result = await sx.query(
      `WITH upd AS (
         UPDATE knowledge_sources s
            SET title = x.title, body = x.body, checksum = x.checksum, freshness_at = x.freshness_at,
                owner = :owner, classification = 'public', updated_at = now(),
                status = CASE WHEN s.status = 'withdrawn' THEN 'active' ELSE s.status END
           FROM jsonb_to_recordset(:sources) AS x (id uuid, tenant_id uuid, title text, uri text, body text,
                                                   checksum text, freshness_at timestamptz)
          WHERE s.id = x.id AND s.tenant_id = x.tenant_id AND s.scope = 'public'
            AND (s.status <> 'withdrawn' OR s.checksum IS NULL) AND s.checksum IS DISTINCT FROM x.checksum
         RETURNING s.id)
       , del AS (DELETE FROM knowledge_chunks c USING upd WHERE c.source_id = upd.id)
       SELECT id FROM upd`,
      { owner: p.text(PACK_OWNER), sources: p.json(batch.map((item) => sourceRow(tenantId, item))) },
    );
    const ids = new Set(result.rows.map((r) => String(r.id)));
    updated += ids.size;
    const rows = batch.filter((item) => ids.has(packSourceId(tenantId, item.key)));
    if (rows.length > 0) {
      const inserted = await sx.query(CHUNK_INSERT, {
        chunks: p.json(rows.flatMap((item) => chunkRows(tenantId, item))),
      });
      passages += inserted.rowCount;
    }
  }

  // Items the JSON no longer has are withdrawn and their passages removed. The cleared checksum says the pack
  // withdrew them (a person's withdrawal keeps it), so they return if the JSON has them again.
  const current = items.map((item) => packSourceId(tenantId, item.key));
  const gone = await sx.query(
    `WITH w AS (
       UPDATE knowledge_sources SET status = 'withdrawn', checksum = NULL, updated_at = now()
        WHERE tenant_id = :tenantId AND scope = 'public' AND starts_with(uri, :prefix)
          AND status <> 'withdrawn' AND NOT (id = ANY (:current))
       RETURNING id)
     , del AS (DELETE FROM knowledge_chunks c USING w WHERE c.source_id = w.id)
     SELECT count(*)::int AS n FROM w`,
    { tenantId: p.uuid(tenantId), prefix: p.text(PACK_URI_PREFIX), current: p.uuidArray(current) },
  );
  const withdrawn = Number(gone.rows[0]?.n ?? 0);

  return { inserted: fresh.length, updated, withdrawn, unchanged, keptWithdrawn, passages };
}

/**
 * Syncs every active tenant (or the one named by `slug`), each idempotently: what the seed runs on every deploy. A
 * suspended or archived tenant is skipped; its copy catches up on the first deploy after it is active again.
 */
export async function syncKnowledgePackToTenants(
  sx: SystemExecutor,
  args: { readonly slug?: string | null; readonly pack?: KnowledgePack } = {},
): Promise<{ readonly slug: string; readonly report: KnowledgePackSyncReport }[]> {
  const pack = args.pack ?? loadKnowledgePack();
  const tenants = await sx.query(
    `SELECT id, slug FROM tenants WHERE status = 'active' AND (:slug IS NULL OR slug = :slug) ORDER BY slug`,
    { slug: p.nullable.text(args.slug ?? null) },
  );
  const out: { slug: string; report: KnowledgePackSyncReport }[] = [];
  for (const row of tenants.rows) {
    out.push({
      slug: String(row.slug),
      report: await syncKnowledgePack(sx, { tenantId: String(row.id), pack }),
    });
  }
  return out;
}
