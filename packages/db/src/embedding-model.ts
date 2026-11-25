/**
 * Which model made an embedding. Vectors of two models cannot be compared, and a vector travels far from the call that
 * made it (a turn's query, an item embedded before its transaction), so the model is remembered with the vector itself:
 * whoever calls an embedding model tags what it returns, and whatever stores or searches the vector reads the tag.
 * An untagged vector is stored with no model and compared with every row (migration 0034, docs/runbooks/embedding-model.md).
 */
const MODELS = new WeakMap<readonly number[], string>();

export interface AlternateEmbedding {
  readonly embedding: readonly number[];
  readonly modelId: string;
}
const ALTERNATES = new WeakMap<readonly number[], AlternateEmbedding>();

/** Remembers that `modelId` made `vector`. */
export function tagEmbedding<T extends readonly number[]>(vector: T, modelId: string): T {
  MODELS.set(vector, modelId);
  return vector;
}

/** The model that made `vector`, when it is known. */
export function embeddingModelOf(vector: readonly number[] | null | undefined): string | null {
  return vector == null ? null : (MODELS.get(vector) ?? null);
}

/**
 * While the platform changes its embedding model: the same query embedded by the model being replaced, for the rows
 * that still carry its vectors.
 */
export function tagAlternate<T extends readonly number[]>(vector: T, alternate: AlternateEmbedding): T {
  ALTERNATES.set(vector, alternate);
  return vector;
}

export function alternateOf(vector: readonly number[] | null | undefined): AlternateEmbedding | null {
  return vector == null ? null : (ALTERNATES.get(vector) ?? null);
}
