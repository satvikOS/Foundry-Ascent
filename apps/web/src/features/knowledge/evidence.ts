import type { DocumentView, EvidenceItem, MemoryObjectView, TurnView } from '@foundry/contracts';

/*
 * Evidence on the Knowledge page: everything the vEIR can cite for the venture (its documents and kept
 * memory) plus the program-side sources it actually cited in recent conversations, each with how many
 * answers cited it. Pure, so the counting rules are unit tested.
 */

export type EvidenceSourceKind = 'document' | 'memory' | 'program';

/** Program-side sources, named for the person reading them. */
export type ProgramSourceKind = 'guidance' | 'library' | 'resource' | 'lesson';

export interface EvidenceSource {
  /** Stable row key. */
  key: string;
  kind: EvidenceSourceKind;
  /** For program-side sources: what kind of source it is. */
  programKind: ProgramSourceKind | null;
  title: string;
  /** Excerpt from the last citation (program sources) or the item's own text (memory). */
  excerpt: string;
  freshnessAt: string | null;
  /** Answers in the scanned conversations that cited this source. */
  citations: number;
  document: DocumentView | null;
  memory: MemoryObjectView | null;
}

const PROGRAM_KIND: Partial<Record<EvidenceItem['kind'], ProgramSourceKind>> = {
  chunk: 'guidance',
  doctrine: 'library',
  resource: 'resource',
  pattern: 'lesson',
};

/** A chunk is titled "<source title> — <heading>"; the source is what a person recognises. */
function sourceTitle(title: string): string {
  const cut = title.indexOf(' — ');
  return cut === -1 ? title : title.slice(0, cut);
}

/** The venture document a cited chunk belongs to (chunks carry their document's filename as title). */
function documentFor(item: EvidenceItem, documents: readonly DocumentView[]): DocumentView | null {
  if (item.kind !== 'chunk') return null;
  const source = sourceTitle(item.title);
  return documents.find((doc) => doc.filename === source) ?? null;
}

export function buildEvidenceSources(input: {
  documents: readonly DocumentView[];
  /** Kept memory the vEIR may cite. */
  memory: readonly MemoryObjectView[];
  /** Turns of the recent conversations that were scanned for citations. */
  turns: readonly Pick<TurnView, 'evidence'>[];
}): EvidenceSource[] {
  const documents = input.documents.filter((doc) => doc.status !== 'deleted');
  const citations = new Map<string, number>();
  const program = new Map<string, EvidenceSource>();

  for (const turn of input.turns) {
    // One answer citing two passages of the same source counts once for that source.
    const cited = new Set<string>();
    for (const item of turn.evidence) {
      // Deleted documents are matched too, so their passages are not mistaken for program guidance.
      const document = documentFor(item, input.documents);
      if (document) {
        if (document.status !== 'deleted') cited.add(`document:${document.id}`);
        continue;
      }
      if (item.kind === 'memory') {
        cited.add(`memory:${item.refId}`);
        continue;
      }
      const programKind = PROGRAM_KIND[item.kind];
      if (!programKind) continue;
      // Passages of one handbook or library entry are one source; resources and lessons are their own.
      const id =
        programKind === 'guidance' || programKind === 'library' ? sourceTitle(item.title) : item.refId;
      const key = `program:${programKind}:${id}`;
      cited.add(key);
      const previous = program.get(key);
      const fresher =
        previous?.freshnessAt && item.freshnessAt && previous.freshnessAt > item.freshnessAt
          ? previous.freshnessAt
          : (item.freshnessAt ?? previous?.freshnessAt ?? null);
      program.set(key, {
        key,
        kind: 'program',
        programKind,
        title: programKind === 'guidance' || programKind === 'library' ? sourceTitle(item.title) : item.title,
        excerpt: item.excerpt,
        freshnessAt: fresher,
        citations: 0,
        document: null,
        memory: null,
      });
    }
    for (const key of cited) citations.set(key, (citations.get(key) ?? 0) + 1);
  }

  const rows: EvidenceSource[] = [
    ...documents.map((document): EvidenceSource => ({
      key: `document:${document.id}`,
      kind: 'document',
      programKind: null,
      title: document.filename,
      excerpt: '',
      freshnessAt: document.createdAt,
      citations: 0,
      document,
      memory: null,
    })),
    ...input.memory
      .filter((memory) => memory.status === 'confirmed')
      .map((memory): EvidenceSource => ({
        key: `memory:${memory.id}`,
        kind: 'memory',
        programKind: null,
        title: memory.title,
        excerpt: memory.content,
        freshnessAt: memory.updatedAt,
        citations: 0,
        document: null,
        memory,
      })),
    ...program.values(),
  ].map((row) => ({ ...row, citations: citations.get(row.key) ?? 0 }));

  // Most cited first, then the freshest.
  return rows.sort(
    (a, b) =>
      b.citations - a.citations || Date.parse(b.freshnessAt ?? '0') - Date.parse(a.freshnessAt ?? '0'),
  );
}
