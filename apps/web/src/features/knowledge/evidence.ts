import type { DocumentView, EvidenceItem, MemoryObjectView, TurnView } from '@foundry/contracts';

/*
 * Evidence on the Knowledge page: everything the vEIR can cite for the venture (its documents and kept
 * memory) plus the program-side sources it actually cited in recent conversations, each with how many
 * answers cited it. A cited passage names its knowledge source by id, so it is credited to exactly that
 * document or library source, whatever the sources are called. Pure, so the counting rules are unit tested.
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
  /** The knowledge source behind a document or a guidance / library row (links and highlights use it). */
  sourceId: string | null;
  title: string;
  /** Excerpt from the last citation (program sources) or the item's own text (memory). */
  excerpt: string;
  freshnessAt: string | null;
  /** Answers in the scanned conversations that cited this source. */
  citations: number;
  document: DocumentView | null;
  memory: MemoryObjectView | null;
}

/** A passage is titled "<source title> — <heading>"; the source is what a person recognises. */
function sourceTitle(title: string): string {
  const cut = title.indexOf(' — ');
  return cut === -1 ? title : title.slice(0, cut);
}

/**
 * Where a cited item is counted: a venture document or a library source (by the knowledge source the
 * passage names), a kept memory item, a resource or a lesson. Null when it is counted nowhere: a passage of a
 * document that is no longer here (deleted), or one whose source is unknown (an answer from before sources
 * were recorded, whose passage has since been removed).
 */
function citedAs(
  item: EvidenceItem,
  documentsBySource: ReadonlyMap<string, DocumentView>,
): { key: string; programKind: ProgramSourceKind | null; sourceId: string | null } | null {
  switch (item.kind) {
    case 'memory':
      return { key: `memory:${item.refId}`, programKind: null, sourceId: null };
    case 'resource':
      return { key: `program:resource:${item.refId}`, programKind: 'resource', sourceId: null };
    case 'pattern':
      return { key: `program:lesson:${item.refId}`, programKind: 'lesson', sourceId: null };
    case 'chunk':
    case 'doctrine': {
      const source = item.source;
      if (!source) return null;
      if (source.scope === 'venture') {
        const document = documentsBySource.get(source.id);
        return document ? { key: `document:${document.id}`, programKind: null, sourceId: source.id } : null;
      }
      const programKind = source.scope === 'persona' ? 'library' : 'guidance';
      return { key: `program:${programKind}:${source.id}`, programKind, sourceId: source.id };
    }
  }
}

export function buildEvidenceSources(input: {
  documents: readonly DocumentView[];
  /** Kept memory the vEIR may cite. */
  memory: readonly MemoryObjectView[];
  /** Turns of the recent conversations that were scanned for citations. */
  turns: readonly Pick<TurnView, 'evidence'>[];
}): EvidenceSource[] {
  const documents = input.documents.filter((doc) => doc.status !== 'deleted');
  const documentsBySource = new Map<string, DocumentView>();
  for (const doc of documents) if (doc.sourceId) documentsBySource.set(doc.sourceId, doc);
  const citations = new Map<string, number>();
  const program = new Map<string, EvidenceSource>();

  for (const turn of input.turns) {
    // One answer citing two passages of the same source counts once for that source.
    const cited = new Set<string>();
    for (const item of turn.evidence) {
      const target = citedAs(item, documentsBySource);
      if (!target) continue;
      cited.add(target.key);
      if (target.programKind === null) continue;
      const previous = program.get(target.key);
      const fresher =
        previous?.freshnessAt && item.freshnessAt && previous.freshnessAt > item.freshnessAt
          ? previous.freshnessAt
          : (item.freshnessAt ?? previous?.freshnessAt ?? null);
      program.set(target.key, {
        key: target.key,
        kind: 'program',
        programKind: target.programKind,
        sourceId: target.sourceId,
        // Passages of one handbook or library entry are one source, shown by the source's own title.
        title: target.sourceId === null ? item.title : sourceTitle(item.title),
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
      sourceId: document.sourceId ?? null,
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
        sourceId: null,
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
