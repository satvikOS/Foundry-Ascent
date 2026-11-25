/**
 * The benchmark in a database, so that what is measured is production's own search (`searchSharedChunks`,
 * `retrieveEvidence`) and not a copy of it. Only for the conversation lab's and the tests' own databases.
 *
 * - `storeBenchmark`: every passage (also those production keeps elsewhere: plays, lessons, releases) as a passage of a
 *   tenant of the benchmark's own. Searching it measures the ranking and the floors over the whole corpus, nothing gated.
 * - `productionPassages`: the home tenant's stored shared passages, each matched to the benchmark's by the text it is
 *   embedded by. Searching them measures what a founder's turn finds: lanes, gates, limits and all.
 */
import { embeddingModelOf, tagEmbedding } from '../embedding-model.js';
import { type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { setChunkEmbeddings } from '../repositories/knowledge.js';
import { uuidV5 } from '../seed/ids.js';
import { type BenchmarkPassage } from './corpus.js';

/** Dimensions of the stored vectors (`knowledge_chunks.embedding`). */
const STORED_DIMENSIONS = 1024;
export const BENCHMARK_TENANT_SLUG = 'retrieval-benchmark';
const BATCH = 100;

export interface StoredBenchmark {
  readonly tenantId: string;
  /** Chunk id → passage id. */
  readonly passageOf: ReadonlyMap<string, string>;
}

/** The source of a passage, as production groups them (at most a few passages of one source are returned). */
function sourceOf(passage: BenchmarkPassage): string {
  // A play and a framework are one passage each; the handbook's and an item's are several of one source.
  return passage.id.split('#', 1)[0] ?? passage.id;
}

/** Puts the benchmark's passages in their own tenant, afresh. Call inside a transaction. */
export async function storeBenchmark(
  sx: SystemExecutor,
  passages: readonly BenchmarkPassage[],
): Promise<StoredBenchmark> {
  const tenantId = uuidV5('retrieval-benchmark/tenant');
  await sx.query(
    `INSERT INTO tenants (id, slug, name, kind, status) VALUES (:id, :slug, 'Retrieval benchmark', 'partner', 'archived')
     ON CONFLICT (id) DO NOTHING`,
    { id: p.uuid(tenantId), slug: p.text(BENCHMARK_TENANT_SLUG) },
  );
  await sx.query(`DELETE FROM knowledge_sources WHERE tenant_id = :id`, { id: p.uuid(tenantId) });
  const sources = new Map<string, { id: string; title: string; passages: BenchmarkPassage[] }>();
  for (const passage of passages) {
    const key = sourceOf(passage);
    const known = sources.get(key);
    if (known === undefined) {
      sources.set(key, {
        id: uuidV5(`retrieval-benchmark/source/${key}`),
        title: passage.source ?? passage.heading ?? key,
        passages: [passage],
      });
    } else known.passages.push(passage);
  }
  const passageOf = new Map<string, string>();
  const chunks: Record<string, unknown>[] = [];
  for (const source of sources.values()) {
    source.passages.forEach((passage, i) => {
      const id = uuidV5(`retrieval-benchmark/passage/${passage.id}`);
      passageOf.set(id, passage.id);
      chunks.push({
        id,
        source_id: source.id,
        ordinal: i + 1,
        heading: passage.heading,
        content: passage.text,
        token_count: Math.ceil(passage.text.length / 4),
      });
    });
  }
  const rows = [...sources.values()].map(({ id, title }) => ({ id, title }));
  for (let i = 0; i < rows.length; i += BATCH) {
    await sx.query(
      `INSERT INTO knowledge_sources (id, tenant_id, scope, title, classification)
       SELECT x.id, :tenantId, 'program', x.title, 'synthetic'
       FROM jsonb_to_recordset(:rows) AS x (id uuid, title text)`,
      { tenantId: p.uuid(tenantId), rows: p.json(rows.slice(i, i + BATCH)) },
    );
  }
  for (let i = 0; i < chunks.length; i += BATCH) {
    await sx.query(
      `INSERT INTO knowledge_chunks (id, source_id, tenant_id, scope, ordinal, heading, content, token_count)
       SELECT x.id, x.source_id, :tenantId, 'program', x.ordinal, x.heading, x.content, x.token_count
       FROM jsonb_to_recordset(:rows)
         AS x (id uuid, source_id uuid, ordinal integer, heading text, content text, token_count integer)`,
      { tenantId: p.uuid(tenantId), rows: p.json(chunks.slice(i, i + BATCH)) },
    );
  }
  return { tenantId, passageOf };
}

/** A text or uuid column. */
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export interface ProductionPassages {
  readonly tenantId: string;
  /** Any founder of the tenant: the searches run under their row-level security. */
  readonly principalId: string;
  readonly rows: readonly {
    readonly id: string;
    readonly text: string;
    readonly personaId: string | null;
    /** The benchmark's id; null for a passage it does not have. */
    readonly passageId: string | null;
  }[];
  /** Published lesson id → passage id. */
  readonly lessonOf: ReadonlyMap<string, string>;
  /** The persona most of the tenant's ventures are coached by. */
  readonly coachPersonaId: string | null;
}

/** The home tenant's shared passages as they are stored. */
export async function productionPassages(
  sx: SystemExecutor,
  tenantSlug: string,
  passages: readonly BenchmarkPassage[],
): Promise<ProductionPassages> {
  const byText = new Map(passages.filter((x) => x.store === 'chunk').map((x) => [x.embedText, x.id]));
  const tenants = await sx.query(`SELECT id FROM tenants WHERE slug = :slug`, { slug: p.text(tenantSlug) });
  const tenant = tenants.rows[0];
  if (tenant === undefined) throw new Error('no such tenant');
  const tenantId = text(tenant.id);
  const params = { tenantId: p.uuid(tenantId) };
  const founders = await sx.query(
    `SELECT m.principal_id AS id FROM venture_memberships m JOIN ventures v ON v.id = m.venture_id
     WHERE v.tenant_id = :tenantId AND m.revoked_at IS NULL AND m.role = 'founder' ORDER BY m.granted_at, m.id LIMIT 1`,
    params,
  );
  // The text a chunk is embedded by is `listChunksMissingEmbeddings`'.
  const chunks = await sx.query(
    `SELECT id, persona_id, coalesce(heading || E'\\n\\n', '') || content AS text FROM knowledge_chunks
     WHERE tenant_id = :tenantId AND venture_id IS NULL ORDER BY id`,
    params,
  );
  const lessons = await sx.query(
    `SELECT id, title FROM patterns WHERE tenant_id = :tenantId AND status = 'published'`,
    params,
  );
  const coach = await sx.query(
    `SELECT a.persona_id AS id FROM assignments a JOIN ventures v ON v.id = a.venture_id
     WHERE v.tenant_id = :tenantId AND a.status = 'active' GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`,
    params,
  );
  const lessonIds = new Map(passages.filter((x) => x.store === 'lesson').map((x) => [x.title, x.id]));
  return {
    tenantId,
    principalId: founders.rows[0] === undefined ? '' : text(founders.rows[0].id),
    rows: chunks.rows.map((r) => ({
      id: text(r.id),
      text: text(r.text),
      personaId: r.persona_id === null ? null : text(r.persona_id),
      passageId: byText.get(text(r.text)) ?? null,
    })),
    lessonOf: new Map(
      lessons.rows.flatMap((r) => {
        const id = lessonIds.get(text(r.title));
        return id === undefined ? [] : [[text(r.id), id] as const];
      }),
    ),
    coachPersonaId: coach.rows[0] === undefined ? null : text(coach.rows[0].id),
  };
}

/** `vector` as the 1024-dimension column holds it: a smaller model's is padded with zeros (its cosines are the same). */
export function storableVector(vector: readonly number[], modelId: string): number[] {
  if (vector.length > STORED_DIMENSIONS) throw new Error('a stored vector has at most 1024 dimensions');
  return tagEmbedding(
    [...vector, ...new Array<number>(STORED_DIMENSIONS - vector.length).fill(0)],
    embeddingModelOf(vector) ?? modelId,
  );
}

/** Stores the vectors of `chunks` (id → vector), replacing what they had. */
export async function embedStored(
  sx: SystemExecutor,
  chunks: readonly { readonly id: string; readonly vector: readonly number[] }[],
  modelId: string,
): Promise<void> {
  for (let i = 0; i < chunks.length; i += BATCH) {
    await setChunkEmbeddings(
      sx,
      chunks
        .slice(i, i + BATCH)
        .map(({ id, vector }) => ({ id, embedding: storableVector(vector, modelId) })),
    );
  }
}
