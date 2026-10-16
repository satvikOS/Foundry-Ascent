import { foldDiacritics } from '../risk/normalize.js';

/**
 * Lexical similarity for short notes (notebook lines, memory candidates): enough to recognise "Prefers
 * short answers" and "prefers short, direct answers" as the same note without embeddings. Core can use
 * it before the cosine check when deduplicating memory proposals.
 */

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'have',
  'i',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'so',
  'that',
  'the',
  'their',
  'they',
  'this',
  'to',
  'was',
  'were',
  'with',
]);

/** Case-, accent-, punctuation- and whitespace-insensitive key. */
export function textKey(text: string): string {
  return foldDiacritics(text.normalize('NFKC').toLowerCase())
    .replace(/['’]s\b/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Content words of `text`: stopwords removed, numbers and single letters kept ("Plan B", "5 interviews"),
 * and a crude plural fold so "answers" meets "answer".
 */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of textKey(text).split(' ')) {
    if (word === '' || STOPWORDS.has(word)) continue;
    out.add(word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);
  }
  return out;
}

/**
 * Whether `text` repeats a removed note: a near-duplicate, the whole note inside it, or every content
 * word of the note in it ("Has ADHD" is repeated by "She has ADHD and works late"). A one-word note only
 * counts when the word is distinctive (4+ letters, not a common word).
 */
export function repeatsNote(text: string, note: string, isCommonWord: (word: string) => boolean): boolean {
  if (isNearDuplicate(text, note, 0.6)) return true;
  const noteTokens = contentTokens(note);
  if (noteTokens.size === 0) return false;
  const tokens = contentTokens(text);
  if (noteTokens.size === 1) {
    const [only = ''] = noteTokens;
    return only.length >= 4 && !isCommonWord(only) && tokens.has(only);
  }
  for (const t of noteTokens) if (!tokens.has(t)) return false;
  return true;
}

/** Jaccard similarity of the content words of two texts (1 for two empty texts). */
export function jaccardSimilarity(a: string, b: string): number {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Whether two notes say the same thing: equal keys, one containing the other (both at least 12
 * characters), or content-word Jaccard ≥ `threshold`.
 */
export function isNearDuplicate(a: string, b: string, threshold = 0.8): boolean {
  const ka = textKey(a);
  const kb = textKey(b);
  if (ka === '' || kb === '') return false;
  if (ka === kb) return true;
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (short.length >= 12 && ` ${long} `.includes(` ${short} `)) return true;
  return jaccardSimilarity(a, b) >= threshold;
}
