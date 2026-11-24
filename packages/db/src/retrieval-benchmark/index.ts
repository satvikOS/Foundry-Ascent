// The retrieval benchmark (docs/runbooks/conversation-lab.md): its own entry point, so no Lambda bundles it.
export { benchmarkPassages, type BenchmarkPassage } from './corpus.js';
export { LexicalIndex, contentWords, lexicalOverlap, stem, type Scored } from './lexical.js';
export { BenchmarkQuery, benchmarkQueries } from './queries.js';
export {
  RANKING_DEPTH,
  fuse,
  quality,
  rankByVector,
  sampleQueries,
  type RetrievalQuality,
} from './ranking.js';
