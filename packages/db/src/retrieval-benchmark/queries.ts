import { z } from 'zod';

import rawQueries from '../../knowledge/retrieval-benchmark/queries.json' with { type: 'json' };

/** One question of the benchmark (knowledge/retrieval-benchmark/queries.json; synthetic, nobody's words). */
export const BenchmarkQuery = z
  .object({
    id: z.string().regex(/^RB-\d{3}$/),
    kind: z.enum(['answerable', 'no_answer']),
    query: z.string().min(12).max(240),
    /** Passages that answer it, any of them; empty when nothing in the corpus does. */
    expected: z.array(z.string()).max(8),
    /** Passages on the same subject that do not answer it. */
    hardNegatives: z.array(z.string()).max(8),
  })
  .refine((q) => (q.kind === 'answerable') === q.expected.length > 0, 'expected passages and kind disagree');
export type BenchmarkQuery = z.infer<typeof BenchmarkQuery>;

const File = z.object({ version: z.literal(1), about: z.string(), queries: z.array(BenchmarkQuery) });

/** The committed questions, validated. */
export function benchmarkQueries(): BenchmarkQuery[] {
  return File.parse(rawQueries).queries;
}
