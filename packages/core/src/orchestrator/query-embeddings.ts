import { createHash } from 'node:crypto';

/**
 * Query embeddings already made in this process. Founders repeat themselves (suggested replies, one-tap check-ins, "what
 * should I do next?"), and the call to the embedding model is most of a turn's retrieval wait. Bounded and in memory
 * only; a key is a digest, so no message text is kept, and a vector is the same whoever asks, so nothing is shared that
 * the text itself does not say. One cache per gateway object: another model's vectors are never mixed in.
 */
export class QueryEmbeddingCache {
  private readonly entries = new Map<string, number[]>();

  constructor(private readonly max = 500) {}

  private key(text: string): string {
    return createHash('sha256')
      .update(text.trim().replace(/\s+/g, ' ').toLowerCase(), 'utf8')
      .digest('base64');
  }

  get(text: string): number[] | null {
    const key = this.key(text);
    const found = this.entries.get(key);
    if (found === undefined) return null;
    // Least recently used goes first.
    this.entries.delete(key);
    this.entries.set(key, found);
    return found;
  }

  set(text: string, vector: number[]): void {
    const key = this.key(text);
    this.entries.delete(key);
    this.entries.set(key, vector);
    if (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done !== true) this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Longest text cached: longer ones are told once. */
export const MAX_CACHED_QUERY_CHARS = 400;

const CACHES = new WeakMap<object, QueryEmbeddingCache>();

/** The cache of query embeddings made by `gateway`. */
export function queryEmbeddingCache(gateway: object): QueryEmbeddingCache {
  const found = CACHES.get(gateway);
  if (found !== undefined) return found;
  const cache = new QueryEmbeddingCache();
  CACHES.set(gateway, cache);
  return cache;
}

/** Words of a message that is only courtesy: a greeting, thanks, a goodbye. */
const COURTESY = new Set(
  (
    'hi hello hey hiya yo howdy good morning afternoon evening night thanks thank you thx ty so much a lot cheers ' +
    'appreciate it that bye goodbye see ya later soon tomorrow talk to take care have great nice day weekend one ' +
    'great awesome perfect cool nice ok okay thomas again very for the your help today all and there well welcome'
  ).split(' '),
);
const GREETING =
  /^(?:hi|hello|hey|hiya|yo|howdy|good (?:morning|afternoon|evening|night)|thanks|thank you|thx|ty|cheers|bye|goodbye|see (?:you|ya)|talk (?:soon|to you)|take care|i appreciate|appreciate it|have a (?:great|good|nice))\b/;

/**
 * Whether a founder's message is only courtesy ("Hi Thomas!", "Thanks so much, bye"), so nothing is looked up for it. A
 * bare "ok", "yes" or "sure" is an answer, never courtesy; so is anything with a question, a number or a word beyond
 * the few courtesies use.
 */
export function isSocialMessage(text: string): boolean {
  const said = text.trim().toLowerCase().replace(/[’‘]/g, "'");
  if (said === '' || said.length > 80 || /[?\d]/.test(said) || !GREETING.test(said)) return false;
  return (said.match(/[\p{L}']+/gu) ?? []).every((word) => COURTESY.has(word));
}
