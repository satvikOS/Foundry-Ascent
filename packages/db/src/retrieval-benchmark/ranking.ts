import { byScore, type Scored } from './lexical.js';
import type { BenchmarkQuery } from './queries.js';

/** How deep a ranking counts. */
export const RANKING_DEPTH = 20;
/** Reciprocal rank fusion's constant (Cormack et al.: 60), over each ranking's first 50. */
const RRF_K = 60;
const RRF_DEPTH = 50;

/** Every passage by cosine similarity, best first (the vectors need not be unit length). */
export function rankByVector(
  query: readonly number[],
  passages: readonly { readonly id: string; readonly vector: readonly number[] }[],
): Scored[] {
  const norm = (v: readonly number[]): number => Math.sqrt(v.reduce((acc, x) => acc + x * x, 0)) || 1;
  const q = norm(query);
  return passages
    .map(({ id, vector }) => ({
      id,
      score: vector.reduce((acc, x, i) => acc + x * (query[i] ?? 0), 0) / (q * norm(vector)),
    }))
    .sort(byScore);
}

/** Reciprocal rank fusion: each ranking adds 1 / (60 + rank). */
export function fuse(rankings: readonly (readonly Scored[])[]): Scored[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.slice(0, RRF_DEPTH).forEach(({ id }, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
    });
  }
  return [...scores].map(([id, score]) => ({ id, score })).sort(byScore);
}

export interface RetrievalQuality {
  /** Answerable questions measured, and those nothing answers. */
  readonly answerable: number;
  readonly noAnswer: number;
  readonly recallAt1: number;
  readonly recallAt3: number;
  readonly recallAt5: number;
  readonly recallAt20: number;
  /** Mean reciprocal rank of the first passage that answers, over the first 20. */
  readonly mrr: number;
  /** Answerable questions with a hard negative ranked above every passage that answers. */
  readonly hardNegativeFirst: number;
  /**
   * How well the best score alone tells a question nothing answers from one that has an answer: the chance that a
   * random answerable question scores higher than a random unanswerable one (0.5 is a coin toss). null when the
   * scores are no measure of relevance (rank fusion) or one kind is missing.
   */
  readonly noAnswerAuc: number | null;
  /** Unanswerable questions below the score that keeps 95 % of the answerable ones. */
  readonly noAnswerCaught: number | null;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Measures rankings (by question id) against the benchmark. A question without a ranking counts as found nothing. */
export function quality(
  queries: readonly BenchmarkQuery[],
  rankings: ReadonlyMap<string, readonly Scored[]>,
  options: { readonly scoresMeanRelevance: boolean },
): RetrievalQuality {
  const answerable = queries.filter((q) => q.kind === 'answerable');
  const unanswerable = queries.filter((q) => q.kind === 'no_answer');
  const top = (q: BenchmarkQuery): readonly Scored[] => (rankings.get(q.id) ?? []).slice(0, RANKING_DEPTH);
  const rankOf = (q: BenchmarkQuery, ids: readonly string[]): number =>
    top(q).findIndex((s) => ids.includes(s.id)) + 1 || Number.POSITIVE_INFINITY;
  const ranks = answerable.map((q) => rankOf(q, q.expected));
  const share = (hit: (rank: number, i: number) => boolean): number =>
    ranks.length === 0 ? 0 : round(ranks.filter(hit).length / ranks.length);
  const best = (q: BenchmarkQuery): number => top(q)[0]?.score ?? 0;
  const kept = answerable.map(best).sort((a, b) => a - b);
  const refused = unanswerable.map(best);
  const measurable = options.scoresMeanRelevance && kept.length > 0 && refused.length > 0;
  let wins = 0;
  for (const a of kept) for (const b of refused) wins += a > b ? 1 : a === b ? 0.5 : 0;
  const threshold = kept[Math.floor(kept.length * 0.05)] ?? 0;
  return {
    answerable: answerable.length,
    noAnswer: unanswerable.length,
    recallAt1: share((r) => r <= 1),
    recallAt3: share((r) => r <= 3),
    recallAt5: share((r) => r <= 5),
    recallAt20: share((r) => r <= RANKING_DEPTH),
    mrr:
      ranks.length === 0
        ? 0
        : round(ranks.reduce((acc, r) => acc + (Number.isFinite(r) ? 1 / r : 0), 0) / ranks.length),
    hardNegativeFirst: share((r, i) => {
      const q = answerable[i];
      return q !== undefined && rankOf(q, q.hardNegatives) < r;
    }),
    noAnswerAuc: measurable ? round(wins / (kept.length * refused.length)) : null,
    noAnswerCaught: measurable ? round(refused.filter((s) => s < threshold).length / refused.length) : null,
  };
}

export interface SelectionQuality {
  /** Answerable questions with a passage that answers among the first ones returned (`shown`). */
  readonly recall: number;
  /** Passages that answer, of those returned for answerable questions (a lower bound: labels are not complete). */
  readonly precision: number;
  readonly perQuery: number;
  /** Answerable questions that got nothing at all. */
  readonly answerableEmpty: number;
  /** Questions nothing answers that got nothing at all. */
  readonly noAnswerEmpty: number;
  /** Passages returned for a question nothing answers, on average. */
  readonly perNoAnswer: number;
}

/** What a search that decides how much to return gave: its first `shown` passages of each question, by question id. */
export function selection(
  queries: readonly BenchmarkQuery[],
  returned: ReadonlyMap<string, readonly { readonly id: string }[]>,
  shown: number,
): SelectionQuality {
  const of = (q: BenchmarkQuery): readonly { readonly id: string }[] =>
    (returned.get(q.id) ?? []).slice(0, shown);
  const answerable = queries.filter((q) => q.kind === 'answerable');
  const unanswerable = queries.filter((q) => q.kind === 'no_answer');
  const good = (q: BenchmarkQuery): number => of(q).filter((s) => q.expected.includes(s.id)).length;
  const total = (list: readonly BenchmarkQuery[], count: (q: BenchmarkQuery) => number): number =>
    list.reduce((acc, q) => acc + count(q), 0);
  const per = (n: number, d: number): number => (d === 0 ? 0 : round(n / d));
  const out = total(answerable, (q) => of(q).length);
  return {
    recall: per(
      total(answerable, (q) => Math.min(1, good(q))),
      answerable.length,
    ),
    precision: per(total(answerable, good), out),
    perQuery: per(out, answerable.length),
    answerableEmpty: per(
      total(answerable, (q) => Number(of(q).length === 0)),
      answerable.length,
    ),
    noAnswerEmpty: per(
      total(unanswerable, (q) => Number(of(q).length === 0)),
      unanswerable.length,
    ),
    perNoAnswer: per(
      total(unanswerable, (q) => of(q).length),
      unanswerable.length,
    ),
  };
}

/** A fixed, even sample of `count` questions, both kinds in proportion: the same one every run. */
export function sampleQueries(queries: readonly BenchmarkQuery[], count: number): BenchmarkQuery[] {
  const size = Math.max(0, Math.min(queries.length, Math.floor(count)));
  return Array.from({ length: size }, (_, i) => queries[Math.floor((i * queries.length) / size)]).filter(
    (q) => q !== undefined,
  );
}
