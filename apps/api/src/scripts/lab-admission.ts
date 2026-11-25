/**
 * The models benchmark's measure of semantic admission (docs/runbooks/conversation-lab.md, "Models benchmark";
 * `retrievalRepo.SEMANTIC_ADMISSION`) with one embedding model's vectors, in a turn's own search: which shared notes a
 * founder's message is shown at each floor, closeness to the best and limit, what a reranker that chooses among the top
 * eight would show instead, and what the turn could cite in all (its play, its notes).
 *
 * Each question is searched twice for each way its play is chosen (the gates alone; every candidate, at the model's `weak`
 * floor) and every set of constants is applied to the same candidates by production's own rule (`packEvidence`), so one
 * run measures them all. Numbers and fixed names; each question's items at the code's constants go to the private report.
 */
import { packEvidence, rerankScores, type RetrievalArgs } from '@foundry/core';
import { retrievalRepo } from '@foundry/db';
import { sampleQueries, selection, type BenchmarkQuery } from '@foundry/db/retrieval-benchmark';

import { type ChooseTurn } from './lab-plays.js';
import {
  askable,
  byFamily,
  packIds,
  pooled,
  storedIds,
  turnSearch,
  type EmbeddedCorpus,
  type Family,
  type Rankings,
  type RetrievalStore,
  type Returned,
} from './lab-retrieval.js';

export const ADMISSION_FLOORS = [0.22, 0.25, 0.28, 0.31, 0.34] as const;
export const ADMISSION_RELATIVES = [0.6, 0.75, 0.85] as const;
export const ADMISSION_LIMITS = [1, 2, 3] as const;
/** How the turn's play is chosen: by the playbook's phrases and rules alone, or as production does (meaning behind them). */
export const PLAY_CHOICES = ['phrase', 'meaning'] as const;
export type PlayChoice = (typeof PLAY_CHOICES)[number];
/**
 * Thresholds of the reranked variant, by the share of the sample's answerable questions (whose candidates hold an answer)
 * that keep their answer at it.
 */
export const RERANK_KEEPS = { keep_95: 0.05, keep_90: 0.1, keep_75: 0.25 } as const;
export type RerankKeep = keyof typeof RERANK_KEEPS;
export const RERANK_KEEP_NAMES = Object.keys(RERANK_KEEPS) as RerankKeep[];
/** Rerank requests at once. */
const RERANK_CONCURRENCY = 3;

/** What is shown: of the notes alone, or of the turn's whole evidence (its play first). */
export interface Shown {
  /** Answerable questions with an item that answers. */
  readonly answerShown: number;
  /** Items that answer, of those shown for answerable questions (a lower bound: labels are not complete). */
  readonly precision: number;
  readonly perQuestion: number;
  readonly answerableEmpty: number;
  /** Questions nothing answers that were shown nothing. */
  readonly noAnswerEmpty: number;
  readonly perNoAnswer: number;
  /** Of the questions a family answers, the share shown a passage of it that does. */
  readonly families: Readonly<Record<Family, number>>;
}

export interface AdmissionRow {
  /** Without the play itself. */
  readonly notes: Shown;
  /** The play and the notes: what the answer can cite. */
  readonly evidence: Shown;
}

export interface GridRow extends AdmissionRow {
  readonly floor: number;
  readonly relative: number;
  readonly limit: number;
}

export interface RerankedRow extends AdmissionRow {
  readonly threshold: number;
}

export interface AdmissionResult {
  readonly id: string;
  readonly dimensions: number;
  readonly questions: number;
  /** Of the questions with an answer and without: those whose turn reads notes by meaning, plainly and guardedly. */
  readonly asks: {
    readonly answerable: { readonly ask: number; readonly guarded: number };
    readonly noAnswer: { readonly ask: number; readonly guarded: number };
  };
  /** The code's constants, as `current` uses them for a plain ask. */
  readonly current: { readonly floor: number; readonly relative: number; readonly limit: number };
  readonly plays: Readonly<
    Record<
      PlayChoice,
      {
        /** The gates alone (the corpus's own vector rule, as before semantic admission). */
        readonly off: AdmissionRow;
        readonly current: AdmissionRow;
        readonly grid: readonly GridRow[];
      }
    >
  >;
  /** A reranker that reads the top eight, on a sample, with the play chosen by meaning; null: none could be called. */
  readonly rerank: {
    readonly id: string;
    readonly code: string | null;
    readonly sample: number;
    /** Questions it was asked about (the others had no candidate). */
    readonly requests: number;
    readonly ms: { readonly p50: number | null; readonly p95: number | null };
    /** The best score of an answer, and the best of a question nothing answers: p10, p50, p90. */
    readonly related: readonly number[];
    readonly unrelated: readonly number[];
    /** The same sample without it: the gates alone, and the code's constants. */
    readonly off: AdmissionRow;
    readonly current: AdmissionRow;
    readonly rows: Readonly<Record<RerankKeep, RerankedRow>>;
  } | null;
}

/** A reranker's scores, one per text; null: the budget does not allow the call. */
export interface AdmissionReranker {
  readonly id: string;
  readonly score: (query: string, texts: readonly string[]) => Promise<readonly number[] | null>;
  /** What a failed call is called (an AWS error code). */
  readonly failed: (error: unknown) => string;
}

const round = (x: number): number => Math.round(x * 1000) / 1000;
const quantiles = (values: readonly number[]): number[] => {
  const sorted = [...values].sort((x, y) => x - y);
  return [0.1, 0.5, 0.9].map((q) => round(sorted[Math.floor(q * (sorted.length - 1))] ?? 0));
};

function shownOf(queries: readonly BenchmarkQuery[], ranked: Rankings): Shown {
  const s = selection(queries, ranked, Number.POSITIVE_INFINITY);
  const families = byFamily(queries, ranked);
  return {
    answerShown: s.recall,
    precision: s.precision,
    perQuestion: s.perQuery,
    answerableEmpty: s.answerableEmpty,
    noAnswerEmpty: s.noAnswerEmpty,
    perNoAnswer: s.perNoAnswer,
    families: {
      knowledge_base: families.knowledge_base.found,
      corpus: families.corpus.found,
      programme: families.programme.found,
      coach: families.coach.found,
      play: families.play.found,
    },
  };
}

/** One question's search: its arguments and everything a set of constants may choose from. */
interface Found {
  readonly q: BenchmarkQuery;
  /** Which search it is of. */
  readonly choice: string;
  readonly args: RetrievalArgs;
  readonly all: retrievalRepo.EvidenceResults;
}

type Pick = (f: Found) => readonly Returned[];
/** A reranker's scores by question id. */
type Scores = ReadonlyMap<string, ReadonlyMap<string, number>>;

export async function benchAdmission(
  store: RetrievalStore,
  embedded: EmbeddedCorpus,
  choices: Readonly<Record<PlayChoice, ChooseTurn>>,
  reranker: (AdmissionReranker & { readonly sample: number }) | null,
): Promise<{ readonly result: AdmissionResult; readonly kept: Record<string, unknown> }> {
  const asked = askable(store);
  const turn = turnSearch(store, embedded);
  const ids = packIds(store);
  const search = (choice: PlayChoice, semantic: 'off' | 'reranked'): Promise<Found[]> =>
    pooled(asked, async (q) => {
      // As many candidates as any set of constants shows, or a reranker reads.
      const { args, search: run } = turn(q, choices[choice](q.query), { semantic });
      return { q, choice: `${choice}/${semantic}`, args, all: await run() };
    });
  // Most constants admit the same few notes: a question's evidence is put together once for each set of them.
  const packs = new Map<string, readonly Returned[]>();
  const by =
    (tuning: retrievalRepo.RetrievalTuning, scores?: Scores): Pick =>
    (f) => {
      const of = scores?.get(f.q.id) ?? null;
      const { semantic } = f.args;
      const admitted =
        semantic == null
          ? f.all.shared
          : retrievalRepo.admitSemantic(
              f.all.shared,
              retrievalRepo.semanticRule({ ...semantic, channel: 'text' }, tuning),
              of,
            );
      const key = `${f.q.id}/${f.choice}/${admitted.map((i) => i.refId).join()}`;
      const known = packs.get(key) ?? ids(packEvidence(f.all, { ...f.args, tuning }, of));
      packs.set(key, known);
      return known;
    };
  const rowOf = (found: readonly Found[], pick: Pick): AdmissionRow => {
    const ranked = new Map(found.map((f) => [f.q.id, pick(f)] as const));
    const notes = new Map(
      [...ranked].map(([id, items]) => [id, items.filter((i) => !i.id.startsWith('play/'))] as const),
    );
    const queries = found.map((f) => f.q);
    return { notes: shownOf(queries, notes), evidence: shownOf(queries, ranked) };
  };

  const grid = ADMISSION_FLOORS.flatMap((floor) =>
    ADMISSION_RELATIVES.flatMap((relative) => ADMISSION_LIMITS.map((limit) => ({ floor, relative, limit }))),
  );
  const off: Partial<Record<PlayChoice, Found[]>> = {};
  const wide: Partial<Record<PlayChoice, Found[]>> = {};
  for (const choice of PLAY_CHOICES) {
    off[choice] = await search(choice, 'off');
    wide[choice] = await search(choice, 'reranked');
  }
  const measured = (choice: PlayChoice) => ({
    off: rowOf(off[choice] ?? [], by({})),
    current: rowOf(wide[choice] ?? [], by({})),
    grid: grid.map((point) => ({ ...point, ...rowOf(wide[choice] ?? [], by({ semantic: point })) })),
  });
  const meaning = wide.meaning ?? [];
  const countAsks = (kind: BenchmarkQuery['kind'], asks: 'ask' | 'guarded'): number =>
    meaning.filter((f) => f.q.kind === kind && f.args.semantic?.asks === asks).length;
  const rule = retrievalRepo.semanticRule({
    asks: 'ask',
    channel: 'text',
    embedding: meaning[0]?.args.semantic?.embedding ?? null,
  });
  return {
    result: {
      id: embedded.modelId,
      dimensions: embedded.dimensions,
      questions: asked.length,
      asks: {
        answerable: { ask: countAsks('answerable', 'ask'), guarded: countAsks('answerable', 'guarded') },
        noAnswer: { ask: countAsks('no_answer', 'ask'), guarded: countAsks('no_answer', 'guarded') },
      },
      current: { floor: rule.floor, relative: rule.relative, limit: rule.limit },
      plays: { phrase: measured('phrase'), meaning: measured('meaning') },
      rerank:
        reranker === null ? null : await reranked(reranker, meaning, off.meaning ?? [], store, rowOf, by),
    },
    kept: Object.fromEntries(meaning.map((f) => [f.q.id, by({})(f).map((i) => i.id)])),
  };
}

async function reranked(
  reranker: AdmissionReranker & { readonly sample: number },
  wide: readonly Found[],
  off: readonly Found[],
  store: RetrievalStore,
  rowOf: (found: readonly Found[], pick: Pick) => AdmissionRow,
  by: (tuning: retrievalRepo.RetrievalTuning, scores?: Scores) => Pick,
): Promise<AdmissionResult['rerank']> {
  const idOf = storedIds(store);
  const inSample = new Set(
    sampleQueries(
      wide.map((f) => f.q),
      reranker.sample,
    ).map((q) => q.id),
  );
  const sample = wide.filter((f) => inSample.has(f.q.id));
  const ms: number[] = [];
  const state: { code: string | null; stopped: boolean } = { code: null, stopped: false };
  const scores = new Map<string, ReadonlyMap<string, number>>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!state.stopped) {
      const f = sample[next];
      next += 1;
      if (f === undefined) return;
      const found = await rerankScores(
        {
          id: reranker.id,
          timeoutMs: 30_000,
          rerank: async (query, texts) => {
            const started = performance.now();
            try {
              const answer = await reranker.score(query, texts);
              if (answer === null) throw new Error('BudgetReached');
              ms.push(Math.round(performance.now() - started));
              return answer;
            } catch (error) {
              state.stopped = true;
              state.code ??=
                error instanceof Error && error.message === 'BudgetReached'
                  ? 'BudgetReached'
                  : reranker.failed(error);
              throw error;
            }
          },
        },
        f.q.query,
        f.all,
      );
      if (found !== null) scores.set(f.q.id, found);
    }
  };
  await Promise.all(Array.from({ length: RERANK_CONCURRENCY }, worker));
  // What the score of a question's answer is, and the best of one without.
  const bestOf = (f: Found, wanted: ReadonlySet<string> | null): number | null => {
    const of = scores.get(f.q.id);
    if (of === undefined) return null;
    const values = f.all.shared.flatMap((item) => {
      const score = of.get(item.refId);
      if (score === undefined) return [];
      return wanted === null || wanted.has(idOf(item.refId, item.kind)) ? [score] : [];
    });
    return values.length === 0 ? null : Math.max(...values);
  };
  const numbers = (values: readonly (number | null)[]): number[] => values.filter((v) => v !== null);
  const related = numbers(
    sample.filter((f) => f.q.kind === 'answerable').map((f) => bestOf(f, new Set(f.q.expected))),
  ).sort((a, b) => a - b);
  const unrelated = numbers(sample.filter((f) => f.q.kind === 'no_answer').map((f) => bestOf(f, null)));
  const row = (keep: RerankKeep): RerankedRow => {
    const threshold = related[Math.floor(RERANK_KEEPS[keep] * related.length)] ?? 1;
    return {
      threshold: Math.round(threshold * 10_000) / 10_000,
      ...rowOf(sample, by({ semantic: { rerankScore: threshold } }, scores)),
    };
  };
  const sortedMs = [...ms].sort((a, b) => a - b);
  const at = (q: number): number | null => sortedMs[Math.floor(q * (sortedMs.length - 1))] ?? null;
  return {
    id: reranker.id,
    code: state.code,
    sample: sample.length,
    requests: ms.length,
    ms: { p50: at(0.5), p95: at(0.95) },
    related: quantiles(related),
    unrelated: quantiles(unrelated),
    off: rowOf(
      off.filter((f) => inSample.has(f.q.id)),
      by({}),
    ),
    current: rowOf(sample, by({})),
    rows: { keep_95: row('keep_95'), keep_90: row('keep_90'), keep_75: row('keep_75') },
  };
}
