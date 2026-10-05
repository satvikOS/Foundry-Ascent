import { type EvidenceItem } from '@foundry/contracts';
import { type retrievalRepo } from '@foundry/db';

export interface RetrievedGroups {
  readonly memory: readonly retrievalRepo.RetrievedItem[];
  readonly chunks: readonly retrievalRepo.RetrievedItem[];
  readonly shared: readonly retrievalRepo.RetrievedItem[];
  readonly resources: readonly retrievalRepo.RetrievedItem[];
  readonly patterns: readonly retrievalRepo.RetrievedItem[];
}

/** An evidence item plus the bookkeeping needed to persist it (`turn_evidence.venture_id`). */
export interface KeyedEvidence {
  readonly item: EvidenceItem;
  /** Venture of venture-scoped evidence (memory, venture chunks); null for shared corpora. */
  readonly ventureId: string | null;
}

export interface EvidencePack {
  readonly items: readonly KeyedEvidence[];
  /** Candidates removed by the isolation guard (must be 0; anything else is audited as retrieval.denied). */
  readonly dropped: number;
  readonly counts: { memory: number; chunks: number; shared: number; resources: number; patterns: number };
}

/**
 * Defence-in-depth isolation filter and stable keys. Venture-scoped stores may only return rows of
 * `ventureId`; shared stores only rows without a venture. Duplicates (same kind + ref) are dropped.
 * Keys are assigned E1…En in store order (memory, venture documents, doctrine/program corpus,
 * resources, patterns), each store already sorted by hybrid score.
 */
export function buildEvidencePack(groups: RetrievedGroups, ventureId: string): EvidencePack {
  const items: KeyedEvidence[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  const counts = { memory: 0, chunks: 0, shared: 0, resources: 0, patterns: 0 };
  const add = (
    store: keyof typeof counts,
    list: readonly retrievalRepo.RetrievedItem[],
    ventureScoped: boolean,
  ): void => {
    for (const r of list) {
      const allowed = ventureScoped ? r.ventureId === ventureId : r.ventureId === null;
      if (!allowed) {
        dropped += 1;
        continue;
      }
      const id = `${r.kind}:${r.refId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      counts[store] += 1;
      items.push({
        item: {
          key: `E${items.length + 1}`,
          kind: r.kind,
          refId: r.refId,
          title: r.title,
          excerpt: r.excerpt,
          score: Number.isFinite(r.score) ? Math.round(r.score * 10_000) / 10_000 : 0,
          freshnessAt: r.freshnessAt,
          status: r.status,
        },
        ventureId: ventureScoped ? ventureId : null,
      });
    }
  };
  add('memory', groups.memory, true);
  add('chunks', groups.chunks, true);
  add('shared', groups.shared, false);
  add('resources', groups.resources, false);
  add('patterns', groups.patterns, false);
  return { items, dropped, counts };
}

/** Data-class ceiling of an assignment → shared-corpus source classifications it may see (null = all). */
export function classificationsFor(
  ceiling: 'public' | 'program_internal' | 'venture_private',
): ('synthetic' | 'public' | 'program_internal' | 'venture_private')[] | null {
  switch (ceiling) {
    case 'public':
      return ['synthetic', 'public'];
    case 'program_internal':
      return ['synthetic', 'public', 'program_internal'];
    case 'venture_private':
      return null;
  }
}
