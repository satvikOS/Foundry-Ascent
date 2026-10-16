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
  /** A founder_private memory item (only ever present when the pack allowed private memory). */
  readonly founderPrivate: boolean;
}

export interface EvidencePack {
  readonly items: readonly KeyedEvidence[];
  /** Candidates removed by the isolation guard (must be 0; anything else is audited as retrieval.denied). */
  readonly dropped: number;
  /** Items left out because a higher-ranked item says the same thing ({@link nearDuplicate}). */
  readonly repeated: number;
  /** True when a founder_private item is in the pack: memory candidates then default to founder_private. */
  readonly usesPrivateMemory: boolean;
  readonly counts: { memory: number; chunks: number; shared: number; resources: number; patterns: number };
}

export interface EvidencePackOptions {
  /**
   * Most items each store contributes, counted after the isolation filter and the duplicate checks (the
   * stores may return more, so a repeated item's slot goes to the next distinct one). Default: no limit.
   */
  readonly limits?: Readonly<Partial<Record<keyof EvidencePack['counts'], number>>>;
  /**
   * Keep founder_private memory items. Only for retrieval that was restricted to the principal's own
   * private items in a session readable by that principal alone; default false: any founder_private item
   * that reaches the pack is dropped (and audited) like a cross-venture row.
   */
  readonly allowPrivateMemory?: boolean;
}

/** Words that carry no content for comparing two items. */
const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a an and are as at be been but by for from has have he her his i if in into is it its of on or our she ' +
    'so that the their them they this to was we were will with you your not no do does did can could should ' +
    'would may might about after before than then there these those which who what when where how'
  ).split(' '),
);

/** An item's content words (lower case, letters and digits) and the numbers among them. */
function wordsOf(item: retrievalRepo.RetrievedItem): { words: Set<string>; numbers: string } {
  const words = new Set(
    `${item.title} ${item.excerpt}`
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w !== '' && !STOPWORDS.has(w)),
  );
  const numbers = [...words]
    .filter((w) => /\d/.test(w))
    .sort()
    .join(' ');
  return { words, numbers };
}

/**
 * Whether two items say the same thing: the same kind, status and privacy, the same numbers, and nearly the
 * same content words (at least 70 % of the smaller item's words, and 60 % of both together). Production's
 * venture memory held the same advisor meeting four times and the same open question four times; each copy
 * took an evidence slot of every turn and fed the same advice back.
 */
export function nearDuplicate(a: retrievalRepo.RetrievedItem, b: retrievalRepo.RetrievedItem): boolean {
  if (a.kind !== b.kind || a.status !== b.status || a.visibility !== b.visibility) return false;
  const x = wordsOf(a);
  const y = wordsOf(b);
  if (x.numbers !== y.numbers || x.words.size === 0 || y.words.size === 0) return false;
  let shared = 0;
  for (const w of x.words) if (y.words.has(w)) shared += 1;
  const union = x.words.size + y.words.size - shared;
  return shared / Math.min(x.words.size, y.words.size) >= 0.7 && shared / union >= 0.6;
}

/**
 * Defence-in-depth isolation filter and stable keys. Venture-scoped stores may only return rows of
 * `ventureId` (none at all when it is null); shared stores only rows without a venture; founder_private memory only with
 * `allowPrivateMemory`. Duplicates (same kind + ref) are dropped, and so is an item that says the same thing as
 * a higher-ranked one ({@link nearDuplicate}): it would only repeat it in the prompt. Keys are assigned E1…En in
 * store order (memory, venture documents, doctrine/program corpus, resources, patterns), each store already
 * sorted by hybrid score.
 */
export function buildEvidencePack(
  groups: RetrievedGroups,
  ventureId: string | null,
  options: EvidencePackOptions = {},
): EvidencePack {
  const items: KeyedEvidence[] = [];
  const seen = new Set<string>();
  const kept: retrievalRepo.RetrievedItem[] = [];
  let dropped = 0;
  let repeated = 0;
  const counts = { memory: 0, chunks: 0, shared: 0, resources: 0, patterns: 0 };
  const add = (
    store: keyof typeof counts,
    list: readonly retrievalRepo.RetrievedItem[],
    ventureScoped: boolean,
  ): void => {
    for (const r of list) {
      const founderPrivate = r.kind === 'memory' && r.visibility === 'founder_private';
      // Without a venture (a test conversation) nothing venture-scoped is allowed at all.
      const allowed =
        (ventureScoped ? ventureId !== null && r.ventureId === ventureId : r.ventureId === null) &&
        (!founderPrivate || options.allowPrivateMemory === true);
      if (!allowed) {
        dropped += 1;
        continue;
      }
      if (counts[store] >= (options.limits?.[store] ?? Number.POSITIVE_INFINITY)) continue;
      const id = `${r.kind}:${r.refId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (kept.some((k) => nearDuplicate(k, r))) {
        repeated += 1;
        continue;
      }
      kept.push(r);
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
          // A passage names its knowledge source by id (its document, or its library source).
          source:
            (r.kind === 'chunk' || r.kind === 'doctrine') && r.sourceId !== null && r.sourceScope !== null
              ? { id: r.sourceId, scope: r.sourceScope }
              : null,
        },
        ventureId: ventureScoped ? ventureId : null,
        founderPrivate,
      });
    }
  };
  add('memory', groups.memory, true);
  add('chunks', groups.chunks, true);
  add('shared', groups.shared, false);
  add('resources', groups.resources, false);
  add('patterns', groups.patterns, false);
  return { items, dropped, repeated, counts, usesPrivateMemory: items.some((k) => k.founderPrivate) };
}

/**
 * Visibility of AI memory candidates produced from an evidence pack: founder_private when the pack used a
 * founder_private item (the candidate may restate it), otherwise team (until a founder reviews it).
 */
export function candidateVisibility(
  pack: Pick<EvidencePack, 'usesPrivateMemory'>,
): 'founder_private' | 'team' {
  return pack.usesPrivateMemory ? 'founder_private' : 'team';
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
