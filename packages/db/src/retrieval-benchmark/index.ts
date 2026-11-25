// The retrieval benchmark (docs/runbooks/conversation-lab.md): its own entry point, so no Lambda bundles it.
export { benchmarkPassages, type BenchmarkPassage, type BenchmarkPlay } from './corpus.js';
export { LexicalIndex, contentWords, lexicalOverlap, stem, type Scored } from './lexical.js';
export { BenchmarkQuery, benchmarkQueries } from './queries.js';
export {
  RANKING_DEPTH,
  fuse,
  quality,
  rankByVector,
  sampleQueries,
  selection,
  type RetrievalQuality,
  type SelectionQuality,
} from './ranking.js';
export {
  BENCHMARK_TENANT_SLUG,
  embedStored,
  productionPassages,
  storableVector,
  storeBenchmark,
  type ProductionPassages,
  type StoredBenchmark,
} from './store.js';
