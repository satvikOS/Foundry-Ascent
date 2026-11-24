/**
 * Request and response bodies (`InvokeModel`) of the embedding models and rerankers Bedrock offers, so they can be
 * compared on one corpus (the lab's models benchmark, docs/runbooks/conversation-lab.md). Production embeds with Titan
 * alone (titan.ts): nothing here is called by the app. Bodies from the Bedrock model-parameter pages (checked
 * 2026-11-24): Cohere Embed v4, Amazon Nova embeddings (synchronous schema); rerankers take `query`, `documents` and
 * `top_n` (Cohere also `api_version`: 2).
 */
import { ModelOutputInvalidError } from './errors.js';

/** A passage to index, or a founder's question: the models that tell them apart embed each for its side. */
export type EmbeddingInput = 'query' | 'document';

export type EmbeddingFamily = 'titan' | 'cohere' | 'nova';

const FAMILIES: readonly (readonly [RegExp, EmbeddingFamily])[] = [
  [/^amazon\.titan-embed-text-v2:/, 'titan'],
  [/^(?:(?:us|eu|global)\.)?cohere\.embed-v4:/, 'cohere'],
  [/^amazon\.nova-2-multimodal-embeddings-v1:/, 'nova'],
];

/** The family an embedding model id belongs to; null for a model these bodies were not written for. */
export function embeddingFamily(modelId: string): EmbeddingFamily | null {
  return FAMILIES.find(([pattern]) => pattern.test(modelId))?.[1] ?? null;
}

/** Vector sizes each family offers (smaller ones are cheaper to store and faster to search). */
export const EMBEDDING_SIZES: Readonly<Record<EmbeddingFamily, readonly number[]>> = {
  titan: [256, 512, 1024],
  cohere: [256, 512, 1024, 1536],
  nova: [256, 384, 1024, 3072],
};

/** Texts one request takes (Cohere embeds up to 96 at once; the others one). */
export const EMBEDDING_BATCH: Readonly<Record<EmbeddingFamily, number>> = { titan: 1, cohere: 96, nova: 1 };

function familyOf(modelId: string): EmbeddingFamily {
  const family = embeddingFamily(modelId);
  if (family === null) throw new TypeError('Not an embedding model these requests were written for');
  return family;
}

/** The `InvokeModel` body embedding `texts` (at most {@link EMBEDDING_BATCH} of the family). */
export function embeddingBody(
  modelId: string,
  texts: readonly string[],
  options: { readonly input: EmbeddingInput; readonly dimensions: number },
): string {
  const family = familyOf(modelId);
  const { input, dimensions } = options;
  if (!EMBEDDING_SIZES[family].includes(dimensions)) {
    throw new RangeError(`Embedding size ${String(dimensions)} is not offered by this model`);
  }
  if (texts.length === 0 || texts.length > EMBEDDING_BATCH[family] || texts.some((t) => t.trim() === '')) {
    throw new RangeError('Embedding input must be non-empty texts, at most one batch');
  }
  if (family === 'cohere') {
    return JSON.stringify({
      input_type: input === 'query' ? 'search_query' : 'search_document',
      texts,
      embedding_types: ['float'],
      output_dimension: dimensions,
      truncate: 'RIGHT',
    });
  }
  const text = texts[0] ?? '';
  if (family === 'titan') return JSON.stringify({ inputText: text, dimensions, normalize: true });
  return JSON.stringify({
    schemaVersion: 'nova-multimodal-embed-v1',
    taskType: 'SINGLE_EMBEDDING',
    singleEmbeddingParams: {
      embeddingPurpose: input === 'query' ? 'TEXT_RETRIEVAL' : 'GENERIC_INDEX',
      embeddingDimension: dimensions,
      text: { truncationMode: 'END', value: text },
    },
  });
}

function vectorsIn(family: EmbeddingFamily, body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  if (family === 'titan') return [record.embedding];
  const embeddings = record.embeddings;
  if (family === 'nova') {
    return Array.isArray(embeddings)
      ? embeddings.map((e) =>
          typeof e === 'object' && e !== null ? (e as { embedding?: unknown }).embedding : null,
        )
      : null;
  }
  // Cohere: a list of vectors for one embedding type, or the lists by type.
  return Array.isArray(embeddings) ? embeddings : (embeddings as { float?: unknown } | undefined)?.float;
}

/** The vectors of an embedding response, checked: one per text, each of `dimensions` finite numbers. */
export function parseEmbeddings(
  modelId: string,
  raw: string,
  expected: { readonly count: number; readonly dimensions: number },
): { readonly vectors: readonly (readonly number[])[]; readonly inputTokens: number | null } {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const vectors = vectorsIn(familyOf(modelId), body);
  const ok =
    Array.isArray(vectors) &&
    vectors.length === expected.count &&
    vectors.every(
      (v) =>
        Array.isArray(v) &&
        v.length === expected.dimensions &&
        v.every((x) => typeof x === 'number' && Number.isFinite(x)),
    );
  if (!ok) throw new ModelOutputInvalidError(modelId, ['embedding: invalid_vector']);
  const tokens = (body as { inputTextTokenCount?: unknown }).inputTextTokenCount;
  return { vectors: vectors as number[][], inputTokens: typeof tokens === 'number' ? tokens : null };
}

/** The `InvokeModel` body that orders `documents` by how well each answers `query`. */
export function rerankBody(modelId: string, query: string, documents: readonly string[]): string {
  return JSON.stringify({
    query,
    documents,
    top_n: documents.length,
    ...(modelId.includes('cohere.') ? { api_version: 2 } : {}),
  });
}

/** A reranker's answer, best first: each document's index in the request, with its relevance score. */
export function parseRerank(
  modelId: string,
  raw: string,
  count: number,
): readonly { readonly index: number; readonly score: number }[] {
  let results: unknown;
  try {
    results = (JSON.parse(raw) as { results?: unknown } | null)?.results;
  } catch {
    results = null;
  }
  const ranked = (Array.isArray(results) ? results : []).map((r: unknown) => {
    const item = r as { index?: unknown; relevance_score?: unknown; relevanceScore?: unknown } | null;
    return { index: item?.index, score: item?.relevance_score ?? item?.relevanceScore };
  });
  const seen = new Set(ranked.map((r) => r.index));
  const ok =
    ranked.length > 0 &&
    seen.size === ranked.length &&
    ranked.every(
      (r) =>
        Number.isInteger(r.index) &&
        (r.index as number) >= 0 &&
        (r.index as number) < count &&
        typeof r.score === 'number' &&
        Number.isFinite(r.score),
    );
  if (!ok) throw new ModelOutputInvalidError(modelId, ['rerank: invalid_results']);
  return (ranked as { index: number; score: number }[]).sort((a, b) => b.score - a.score);
}
