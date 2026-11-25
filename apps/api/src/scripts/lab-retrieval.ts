/**
 * The models benchmark's measure of production's own search (docs/runbooks/conversation-lab.md, "Models benchmark";
 * docs/runbooks/embedding-model.md, "How retrieval is tuned"), in the lab's own local PostgreSQL, with one embedding
 * model's vectors:
 *
 * - **ranking**: `searchSharedChunks` over the benchmark's whole corpus (its own tenant, nothing gated), floors off, for
 *   each candidate set of fusion weights: which order puts the answer first;
 * - **floors**: the same search with the code's floors and with the floors these vectors suggest: what is returned for a
 *   question, and whether nothing is returned for a question nothing answers;
 * - **production**: `retrieveEvidence` in the home tenant as a founder's turn calls it (row-level security, lanes, gates,
 *   budgets), with the play the path's rules choose for the message, and without it.
 *
 * Everything returned is numbers and fixed names; each question's passages go to the private report.
 */
import { lexicalIntent, phraseIntent, playRefId, PLAYBOOK, retrieveEvidence } from '@foundry/core';
import { retrievalRepo, type Db } from '@foundry/db';
import {
  embedStored,
  productionPassages,
  quality,
  selection,
  storableVector,
  storeBenchmark,
  type BenchmarkPassage,
  type BenchmarkQuery,
  type ProductionPassages,
  type RetrievalQuality,
  type SelectionQuality,
  type StoredBenchmark,
} from '@foundry/db/retrieval-benchmark';

/** Candidate fusion weights by name; `default` is what the code ships. */
export const FUSION_VARIANTS = {
  words: null,
  vector: { vector: 1, lexical: 0, rescue: 0 },
  rrf_1: { vector: 1, lexical: 1, rescue: 1 },
  rrf_2: { vector: 2, lexical: 1, rescue: 1 },
  rrf_3: { vector: 3, lexical: 1, rescue: 1 },
  rrf_4: { vector: 4, lexical: 1, rescue: 1 },
  tie_break: { vector: 3, lexical: 0.25, rescue: 0.25 },
  rescue_only: { vector: 3, lexical: 0, rescue: 3 },
  default: {},
} as const satisfies Record<string, retrievalRepo.RetrievalTuning['fusion'] | null>;
export type FusionVariant = keyof typeof FUSION_VARIANTS;
export const FUSION_NAMES = Object.keys(FUSION_VARIANTS) as FusionVariant[];

/** Every row is about the message: the ranking alone. */
const NO_FLOORS: retrievalRepo.RetrievalTuning = {
  floors: { relative: -10, coverage: -1, manyTerms: 0 },
  profile: { floor: -1, weak: -1 },
};
/** How deep a ranking is read. */
const DEPTH = 20;
/** Passages a founder's turn is shown of the shared corpora, about. */
export const SHOWN = 3;
/** Searches at once. */
const CONCURRENCY = 6;

/** A question's vectors and the corpus's, of one model at one size. */
export interface EmbeddedCorpus {
  readonly modelId: string;
  readonly dimensions: number;
  /** Passage id → vector. */
  readonly passages: ReadonlyMap<string, readonly number[]>;
  /** Question id → vector. */
  readonly queries: ReadonlyMap<string, readonly number[]>;
}

export interface RetrievalStore {
  readonly db: Db;
  readonly passages: readonly BenchmarkPassage[];
  readonly queries: readonly BenchmarkQuery[];
  readonly benchmark: StoredBenchmark;
  readonly production: ProductionPassages;
}

/** Puts the benchmark in the lab's database and reads what production's tenant stores. */
export async function openRetrievalStore(
  db: Db,
  corpus: { readonly passages: readonly BenchmarkPassage[]; readonly queries: readonly BenchmarkQuery[] },
  tenantSlug: string,
): Promise<RetrievalStore> {
  const benchmark = await db.system((sx) => storeBenchmark(sx, corpus.passages));
  const production = await db.system((sx) => productionPassages(sx, tenantSlug, corpus.passages));
  return { db, ...corpus, benchmark, production };
}

/** The stored texts of the home tenant that the benchmark does not have (embedded besides its passages). */
export function extraTexts(store: RetrievalStore): { readonly id: string; readonly text: string }[] {
  return store.production.rows.filter((r) => r.passageId === null).map(({ id, text }) => ({ id, text }));
}

export interface FloorPoint {
  readonly floor: number;
  /** Answerable questions whose best answering passage is at the floor or above. */
  readonly answered: number;
  /** Questions nothing answers whose closest passage is below it. */
  readonly caught: number;
}

export interface Calibration {
  /** What `suggestEmbeddingProfile` makes of these vectors. */
  readonly suggested: retrievalRepo.EmbeddingProfile;
  /** The 90th and 50th percentile of `unrelated` as `floor` and `weak`. */
  readonly strict: retrievalRepo.EmbeddingProfile;
  readonly current: retrievalRepo.EmbeddingProfile;
  readonly curve: readonly FloorPoint[];
  /** Cosine of an answerable question with its closest answering passage: 10th, 50th and 90th percentile. */
  readonly related: readonly number[];
  /** Cosine of a question nothing answers with its closest passage: 10th, 50th and 90th percentile. */
  readonly unrelated: readonly number[];
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa === 0 || bb === 0 ? 0 : dot / Math.sqrt(aa * bb);
}

const percentiles = (values: readonly number[]): number[] => {
  const sorted = [...values].sort((x, y) => x - y);
  return [0.1, 0.5, 0.9].map((q) => round(sorted[Math.floor(q * (sorted.length - 1))] ?? 0));
};

/** What a floor of these vectors would keep and catch. */
export function calibrate(queries: readonly BenchmarkQuery[], embedded: EmbeddedCorpus): Calibration {
  const related: number[] = [];
  const unrelated: number[] = [];
  for (const q of queries) {
    const vector = embedded.queries.get(q.id) ?? [];
    const candidates =
      q.kind === 'answerable'
        ? q.expected.map((id) => embedded.passages.get(id) ?? [])
        : [...embedded.passages.values()];
    const best = Math.max(...candidates.map((c) => cosine(vector, c)));
    (q.kind === 'answerable' ? related : unrelated).push(best);
  }
  const share = (values: readonly number[], hit: (v: number) => boolean): number =>
    values.length === 0 ? 0 : round(values.filter(hit).length / values.length);
  const [, median = 0, high = 0] = percentiles(unrelated);
  return {
    strict: { floor: high, weak: median },
    suggested: retrievalRepo.suggestEmbeddingProfile(related, unrelated),
    current: retrievalRepo.embeddingProfile(embedded.modelId),
    curve: Array.from({ length: 13 }, (_, i) => round(0.1 + i * 0.05)).map((floor) => ({
      floor,
      answered: share(related, (v) => v >= floor),
      caught: share(unrelated, (v) => v < floor),
    })),
    related: percentiles(related),
    unrelated: percentiles(unrelated),
  };
}

async function pooled<T, R>(items: readonly T[], job: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item === undefined) return;
        results[index] = await job(item);
      }
    }),
  );
  return results;
}

/** A returned passage: its benchmark id and its cosine. */
export interface Returned {
  readonly id: string;
  readonly score: number;
  readonly vector: number;
}
type Rankings = ReadonlyMap<string, readonly Returned[]>;

async function searchBenchmark(
  store: RetrievalStore,
  embedded: EmbeddedCorpus,
  tuning: retrievalRepo.RetrievalTuning,
  options: { readonly words?: boolean; readonly ms?: number[] } = {},
): Promise<Rankings> {
  const found = await pooled(store.queries, async (q) => {
    const vector = embedded.queries.get(q.id) ?? [];
    const items = await store.db.system(async (sx) => {
      // The benchmark shares its index with the home tenant's copies of the same passages: search all of it.
      await sx.query(`SELECT set_config('hnsw.ef_search', '800', true)`);
      const started = performance.now();
      const result = await retrievalRepo.searchSharedChunks(sx, {
        tenantId: store.benchmark.tenantId,
        query: q.query,
        embedding: options.words === true ? null : storableVector(vector, embedded.modelId),
        limit: DEPTH,
        candidates: 400,
        tuning,
      });
      options.ms?.push(performance.now() - started);
      return result;
    });
    return items.flatMap((item) => {
      const id = store.benchmark.passageOf.get(item.refId);
      return id === undefined ? [] : [{ id, score: item.score, vector: item.components.vector }];
    });
  });
  return new Map(store.queries.map((q, i) => [q.id, found[i] ?? []]));
}

/** The play the path's rules choose for a message alone (a first message: no venture, no step yet). */
function playFor(message: string): (typeof PLAYBOOK.plays)[number] | null {
  const intent = (phraseIntent(PLAYBOOK, message) ?? lexicalIntent(PLAYBOOK, message))?.intent;
  return PLAYBOOK.plays.find((play) => play.id === intent?.playId) ?? null;
}

async function searchProduction(
  store: RetrievalStore,
  embedded: EmbeddedCorpus,
  tuning: retrievalRepo.RetrievalTuning | undefined,
  withPlay: boolean,
): Promise<Rankings> {
  const { production } = store;
  const passageOf = new Map(production.rows.map((r) => [r.id, r.passageId] as const));
  const personaOf = new Map(
    production.rows.flatMap((r) => (r.passageId === null ? [] : [[r.passageId, r.personaId] as const])),
  );
  const playOf = new Map(PLAYBOOK.plays.map((play) => [playRefId(play.id), `play/${play.id}`]));
  const found = await pooled(store.queries, async (q) => {
    // Whose library answers: the passage's own persona, else the coach most ventures have.
    const persona =
      q.expected.map((id) => personaOf.get(id) ?? null).find((id) => id !== null) ??
      production.coachPersonaId ??
      '';
    const play = withPlay ? playFor(q.query) : null;
    const pack = await store.db.withContext(
      { principalId: production.principalId, tenantId: production.tenantId, requestId: 'lab-retrieval' },
      (tx) =>
        retrieveEvidence(tx, {
          tenantId: production.tenantId,
          ventureId: null,
          personaId: persona,
          stage: null,
          query: q.query,
          founderText: q.query,
          embedding: storableVector(embedded.queries.get(q.id) ?? [], embedded.modelId),
          dataClassCeiling: 'venture_private',
          budgets: { memory: 0, chunks: 0, doctrine: 2, resources: 1, patterns: 1 },
          privateOwnerId: null,
          play: play === null ? null : { play, sources: PLAYBOOK.sources },
          ...(tuning === undefined ? {} : { tuning }),
        }),
    );
    return pack.items.map(({ item }) => ({
      id:
        playOf.get(item.refId) ??
        passageOf.get(item.refId) ??
        production.lessonOf.get(item.refId) ??
        `other/${item.kind}`,
      score: item.score,
      vector: 0,
    }));
  });
  return new Map(store.queries.map((q, i) => [q.id, found[i] ?? []]));
}

/** Questions production could answer: a passage that does is stored, or is a play. */
export function askable(store: RetrievalStore): BenchmarkQuery[] {
  const held = new Set([
    ...store.production.rows.flatMap((r) => (r.passageId === null ? [] : [r.passageId])),
    ...store.production.lessonOf.values(),
    ...store.passages.filter((x) => x.store === 'play').map((x) => x.id),
  ]);
  return store.queries.filter((q) => q.kind === 'no_answer' || q.expected.some((id) => held.has(id)));
}

/** Families of passages, by the ids they start with. */
export const FAMILIES = {
  knowledge_base: ['skb'],
  corpus: ['notes', 'open'],
  programme: ['curriculum', 'method'],
  coach: ['doctrine', 'library', 'lesson'],
  play: ['play'],
} as const;
export type Family = keyof typeof FAMILIES;
export const FAMILY_NAMES = Object.keys(FAMILIES) as Family[];

/** Of the questions a family answers, how many got a passage of it that does. */
export interface FamilyRecall {
  readonly questions: number;
  readonly found: number;
}

function byFamily(queries: readonly BenchmarkQuery[], ranked: Rankings): Record<Family, FamilyRecall> {
  const of = (family: Family): FamilyRecall => {
    const prefixes: readonly string[] = FAMILIES[family];
    const within = (id: string): boolean => prefixes.includes(id.split('/', 1)[0] ?? '');
    const asked = queries.filter((q) => q.expected.some(within));
    const found = asked.filter((q) =>
      (ranked.get(q.id) ?? []).some(({ id }) => within(id) && q.expected.includes(id)),
    );
    return {
      questions: asked.length,
      found: asked.length === 0 ? 0 : round(found.length / asked.length),
    };
  };
  return {
    knowledge_base: of('knowledge_base'),
    corpus: of('corpus'),
    programme: of('programme'),
    coach: of('coach'),
    play: of('play'),
  };
}

/** What a search that decides how much to return gave, with how its order ranks. */
export type Measured = SelectionQuality & { readonly quality: RetrievalQuality };

/**
 * Floors by name: the code's; what these vectors suggest; that, and only passages close to the closest; and strict ones
 * (the vector alone lets a tenth of the questions nothing answers find something, with words half of them).
 */
export const FLOOR_NAMES = ['current', 'suggested', 'suggested_tight', 'strict'] as const;
export type FloorVariant = (typeof FLOOR_NAMES)[number];

export interface SearchResult {
  readonly id: string;
  readonly dimensions: number;
  readonly calibration: Calibration;
  readonly ranking: Readonly<Record<FusionVariant, RetrievalQuality>>;
  readonly floors: Readonly<Record<FloorVariant, Measured>>;
  readonly production: {
    /** Questions measured (production holds an answer, or nothing answers). */
    readonly questions: number;
    /** Share of the answerable ones whose play, as the path's rules choose it from the message alone, answers. */
    readonly playAnswers: number;
    /** The retrieved items alone, for each floors, and with the old equal weights. */
    readonly retrieval: Readonly<Record<FloorVariant | 'equal_weights', Measured>>;
    /** With the play, as a founder's turn has them. */
    readonly pack: Measured;
    readonly families: Readonly<Record<Family, FamilyRecall>>;
  };
  readonly searchMs: { readonly p50: number | null; readonly p95: number | null };
}

/** Candidates of a question for a reranker: the code's own ranking, floors off, best first. */
export type Candidates = ReadonlyMap<string, readonly Returned[]>;

/**
 * Whether the ranking is worth a reranker's time: the closest passage is barely about the question, or two passages are
 * about equally close. A confident ranking is left as it is.
 */
export function isAmbiguous(ranked: readonly Returned[], profile: retrievalRepo.EmbeddingProfile): boolean {
  const cosines = ranked.map((r) => r.vector).sort((a, b) => b - a);
  const [first = 0, second = 0] = cosines;
  return first < profile.floor + 0.1 || first - second < 0.02;
}

export async function benchSearch(
  store: RetrievalStore,
  embedded: EmbeddedCorpus,
  extras: ReadonlyMap<string, readonly number[]>,
): Promise<{ result: SearchResult; candidates: Candidates; kept: Record<string, unknown> }> {
  const calibration = calibrate(store.queries, embedded);
  await store.db.system(async (sx) => {
    await embedStored(
      sx,
      [...store.benchmark.passageOf].map(([id, passageId]) => ({
        id,
        vector: embedded.passages.get(passageId) ?? [],
      })),
      embedded.modelId,
    );
    await embedStored(
      sx,
      store.production.rows.flatMap((r) => {
        const vector = r.passageId === null ? extras.get(r.id) : embedded.passages.get(r.passageId);
        return vector === undefined ? [] : [{ id: r.id, vector }];
      }),
      embedded.modelId,
    );
  });
  const ms: number[] = [];
  const ranking: Partial<Record<FusionVariant, RetrievalQuality>> = {};
  let candidates: Candidates = new Map();
  for (const name of FUSION_NAMES) {
    const fusion = FUSION_VARIANTS[name];
    const ranked = await searchBenchmark(
      store,
      embedded,
      { ...NO_FLOORS, ...(fusion === null ? {} : { fusion }) },
      { words: fusion === null, ...(name === 'default' ? { ms } : {}) },
    );
    if (name === 'default') candidates = ranked;
    ranking[name] = quality(store.queries, ranked, { scoresMeanRelevance: false });
  }
  const measured = (queries: readonly BenchmarkQuery[], ranked: Rankings, shown = SHOWN): Measured => ({
    ...selection(queries, ranked, shown),
    quality: quality(queries, ranked, { scoresMeanRelevance: false }),
  });
  const { suggested } = calibration;
  const tunings: Record<FloorVariant, retrievalRepo.RetrievalTuning> = {
    current: {},
    suggested: { profile: suggested },
    suggested_tight: { profile: suggested, floors: { relative: 0.85 } },
    strict: { profile: calibration.strict },
  };
  const current = await searchBenchmark(store, embedded, tunings.current);
  const floorsOf = async (name: FloorVariant): Promise<Measured> =>
    measured(store.queries, await searchBenchmark(store, embedded, tunings[name]));
  const floors = {
    current: measured(store.queries, current),
    suggested: await floorsOf('suggested'),
    suggested_tight: await floorsOf('suggested_tight'),
    strict: await floorsOf('strict'),
  };
  const asked = askable(store);
  const answerable = asked.filter((q) => q.kind === 'answerable');
  const pack = await searchProduction(store, embedded, undefined, true);
  const bare = await searchProduction(store, embedded, undefined, false);
  const playAnswers = answerable.filter((q) => {
    const play = playFor(q.query);
    return play !== null && q.expected.includes(`play/${play.id}`);
  }).length;
  const retrievalOf = async (tuning: retrievalRepo.RetrievalTuning): Promise<Measured> =>
    measured(asked, await searchProduction(store, embedded, tuning, false), DEPTH);
  const production = {
    questions: asked.length,
    playAnswers: answerable.length === 0 ? 0 : round(playAnswers / answerable.length),
    retrieval: {
      current: measured(asked, bare, DEPTH),
      equal_weights: await retrievalOf({ fusion: FUSION_VARIANTS.rrf_1 }),
      suggested: await retrievalOf(tunings.suggested),
      suggested_tight: await retrievalOf(tunings.suggested_tight),
      strict: await retrievalOf(tunings.strict),
    },
    pack: measured(asked, pack, DEPTH),
    families: byFamily(asked, pack),
  };
  const sortedMs = [...ms].sort((a, b) => a - b);
  const at = (q: number): number | null =>
    sortedMs.length === 0 ? null : Math.round(sortedMs[Math.floor(q * (sortedMs.length - 1))] ?? 0);
  const ids = (ranked: Rankings): Record<string, readonly string[]> =>
    Object.fromEntries([...ranked].map(([id, r]) => [id, r.slice(0, 5).map((x) => x.id)]));
  return {
    candidates,
    kept: { ranking: ids(candidates), floors: ids(current), pack: ids(pack), production: ids(bare) },
    result: {
      id: embedded.modelId,
      dimensions: embedded.dimensions,
      calibration,
      ranking: ranking as Record<FusionVariant, RetrievalQuality>,
      floors,
      production,
      searchMs: { p50: at(0.5), p95: at(0.95) },
    },
  };
}
