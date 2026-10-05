import { EMBEDDING_DIMENSIONS } from './types.js';

/** 32-bit FNV-1a over UTF-16 code units, with a seed so we can derive independent hashes. */
export function fnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function features(text: string): [string, number][] {
  const tokens =
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: [string, number][] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    out.push([`t:${token}`, 1]);
    // Crude stemming so "price" / "pricing" / "prices" share a feature.
    if (token.length > 4) out.push([`p:${token.slice(0, 4)}`, 0.5]);
    const next = tokens[i + 1];
    if (next !== undefined) out.push([`b:${token} ${next}`, 0.5]);
  }
  return out;
}

/**
 * Deterministic pseudo-embedding (signed feature hashing of tokens, 4-char stems and bigrams),
 * L2-normalized. Texts sharing vocabulary get high cosine similarity, so retrieval tests are stable
 * and meaningful without a model.
 */
export function hashEmbedding(text: string, dimensions = EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const [feature, weight] of features(text)) {
    const index = fnv1a(feature) % dimensions;
    const sign = (fnv1a(feature, 0x9747b28c) & 1) === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign * weight;
  }
  let norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0));
  if (norm === 0) {
    vector[fnv1a(text) % dimensions] = 1;
    norm = 1;
  }
  return vector.map((v) => v / norm);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
