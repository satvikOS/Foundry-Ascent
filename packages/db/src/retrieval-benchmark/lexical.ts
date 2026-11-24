/**
 * Lexical ranking for the retrieval benchmark: BM25 over stemmed words, in memory. The app's own lexical score is
 * PostgreSQL's `ts_rank_cd` over an English tsvector (packages/db README section 7); the benchmark runs without a
 * database, so its "lexical" column is the stronger textbook ranking, not the app's exact one.
 */

const STOPWORDS = new Set(
  (
    'a about after all also an and any are as at be been before but by can could did do does for from get got had has ' +
    'have he her him his how i if in into is it its just like may me more most my no not now of on once one or our out ' +
    'over own please she should so some than that the their them then there these they this those to too up us very ' +
    'was we were what when where which while who whom whose why will with would you your'
  ).split(' '),
);

/** A light English stemmer (plurals and the commonest endings): the same word in two forms counts once. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(?:ss|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = undouble(w.slice(0, -3));
  else if (w.length > 4 && w.endsWith('ed')) w = undouble(w.slice(0, -2));
  else if (w.length > 5 && w.endsWith('ly')) w = w.slice(0, -2);
  return w.length > 3 && w.endsWith('e') ? w.slice(0, -1) : w;
}

function undouble(w: string): string {
  return /([bdgmnprt])\1$/.test(w) ? w.slice(0, -1) : w;
}

/** Stemmed content words, in order (a reference's URL is no content). */
export function contentWords(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/['’]/g, '')
      .match(/[a-z0-9]+/g) ?? []
  )
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

export interface Scored {
  readonly id: string;
  readonly score: number;
}

const K1 = 1.2;
const B = 0.75;

/** BM25 over a fixed corpus. */
export class LexicalIndex {
  readonly #docs: readonly { id: string; length: number; counts: ReadonlyMap<string, number> }[];
  readonly #documentFrequency = new Map<string, number>();
  readonly #meanLength: number;

  constructor(passages: readonly { readonly id: string; readonly title: string; readonly text: string }[]) {
    this.#docs = passages.map((p) => {
      const words = contentWords(`${p.title} ${p.text}`);
      const counts = new Map<string, number>();
      for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
      return { id: p.id, length: words.length, counts };
    });
    for (const doc of this.#docs) {
      for (const w of doc.counts.keys()) {
        this.#documentFrequency.set(w, (this.#documentFrequency.get(w) ?? 0) + 1);
      }
    }
    this.#meanLength = this.#docs.reduce((acc, d) => acc + d.length, 0) / Math.max(1, this.#docs.length);
  }

  /** Every passage sharing a word with `query`, best first. */
  search(query: string): Scored[] {
    const words = [...new Set(contentWords(query))];
    const total = this.#docs.length;
    return this.#docs
      .map((doc) => {
        let score = 0;
        for (const w of words) {
          const tf = doc.counts.get(w) ?? 0;
          if (tf === 0) continue;
          const df = this.#documentFrequency.get(w) ?? 0;
          const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
          score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / this.#meanLength));
        }
        return { id: doc.id, score };
      })
      .filter((s) => s.score > 0)
      .sort(byScore);
  }
}

/** Best first; a tie keeps the same order every time. */
export function byScore(a: Scored, b: Scored): number {
  return b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The shared part of `query`'s content words that `text` holds (how much a word search could find it by). */
export function lexicalOverlap(query: string, text: string): number {
  const words = new Set(contentWords(query));
  if (words.size === 0) return 0;
  const held = new Set(contentWords(text));
  return [...words].filter((w) => held.has(w)).length / words.size;
}
