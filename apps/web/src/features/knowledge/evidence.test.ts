import { describe, expect, it } from 'vitest';

import { buildEvidenceSources } from './evidence';
import { IDS, makeDocument, makeEvidence, makeMemory, makeTurnWithEvidence } from './testing';

/** Knowledge sources: the document's, the program handbook's, a vEIR library note's. */
const SOURCE = {
  document: '11111111-1111-4111-8111-111111111111',
  other: '22222222-2222-4222-8222-222222222222',
  handbook: '33333333-3333-4333-8333-333333333333',
  library: '44444444-4444-4444-8444-444444444444',
  removed: '55555555-5555-4555-8555-555555555555',
} as const;

describe('buildEvidenceSources', () => {
  const doc = makeDocument({ sourceId: SOURCE.document });
  const memory = makeMemory({ status: 'confirmed' });

  it('counts the answers that cited each source, including documents through their passages', () => {
    const turns = [
      makeTurnWithEvidence([
        makeEvidence({
          key: 'E1',
          kind: 'chunk',
          refId: IDS.chunk,
          title: `${doc.filename} — Findings`,
          source: { id: SOURCE.document, scope: 'venture' },
        }),
        makeEvidence({
          key: 'E2',
          kind: 'chunk',
          refId: IDS.resource,
          title: `${doc.filename} — Method`,
          source: { id: SOURCE.document, scope: 'venture' },
        }),
        makeEvidence({ key: 'E3', kind: 'memory', refId: memory.id }),
      ]),
      makeTurnWithEvidence([
        makeEvidence({
          key: 'E1',
          kind: 'chunk',
          refId: IDS.chunk,
          title: doc.filename,
          source: { id: SOURCE.document, scope: 'venture' },
        }),
      ]),
    ];
    const sources = buildEvidenceSources({ documents: [doc], memory: [memory], turns });
    const byKey = new Map(sources.map((s) => [s.key, s]));
    // Two passages of one document in one answer count once for that answer.
    expect(byKey.get(`document:${doc.id}`)).toMatchObject({ citations: 2, sourceId: SOURCE.document });
    expect(byKey.get(`memory:${memory.id}`)?.citations).toBe(1);
    expect(sources[0]?.key).toBe(`document:${doc.id}`);
  });

  it('never counts a program or library source as a venture document of the same name', () => {
    // The handbook and a library note are both called exactly like the venture's file.
    const turns = [
      makeTurnWithEvidence([
        makeEvidence({
          key: 'E1',
          kind: 'chunk',
          refId: IDS.chunk,
          title: `${doc.filename} — Pricing`,
          source: { id: SOURCE.handbook, scope: 'program' },
        }),
        makeEvidence({
          key: 'E2',
          kind: 'doctrine',
          refId: IDS.resource,
          title: doc.filename,
          source: { id: SOURCE.library, scope: 'persona' },
        }),
      ]),
    ];
    const sources = buildEvidenceSources({ documents: [doc], memory: [], turns });
    expect(sources.map((s) => [s.key, s.kind, s.programKind, s.title, s.citations])).toEqual(
      expect.arrayContaining([
        [`document:${doc.id}`, 'document', null, doc.filename, 0],
        [`program:guidance:${SOURCE.handbook}`, 'program', 'guidance', doc.filename, 1],
        [`program:library:${SOURCE.library}`, 'program', 'library', doc.filename, 1],
      ]),
    );
    expect(sources).toHaveLength(3);
  });

  it('credits each of two documents with the same name by its own source', () => {
    const one = makeDocument({ id: IDS.document, sourceId: SOURCE.document });
    const two = makeDocument({ id: IDS.resource, sourceId: SOURCE.other });
    const turns = [
      makeTurnWithEvidence([
        makeEvidence({
          key: 'E1',
          kind: 'chunk',
          refId: IDS.chunk,
          title: `${one.filename} — Findings`,
          source: { id: SOURCE.other, scope: 'venture' },
        }),
      ]),
    ];
    const sources = buildEvidenceSources({ documents: [one, two], memory: [], turns });
    expect(sources.map((s) => [s.key, s.citations])).toEqual([
      [`document:${two.id}`, 1],
      [`document:${one.id}`, 0],
    ]);
  });

  it('keeps program sources of the same title apart, and resources and lessons by their own id', () => {
    const turns = [
      makeTurnWithEvidence([
        makeEvidence({
          key: 'E1',
          kind: 'chunk',
          refId: IDS.chunk,
          title: 'Program handbook — Pilots',
          source: { id: SOURCE.handbook, scope: 'program' },
        }),
        makeEvidence({
          key: 'E2',
          kind: 'chunk',
          refId: IDS.memory2,
          title: 'Program handbook — Data',
          source: { id: SOURCE.other, scope: 'public' },
        }),
        makeEvidence({ key: 'E3', kind: 'resource', refId: IDS.resource, title: 'Library data office' }),
        makeEvidence({ key: 'E4', kind: 'pattern', refId: IDS.memory3, title: 'Free pilots teach nothing' }),
      ]),
    ];
    const sources = buildEvidenceSources({ documents: [], memory: [], turns });
    expect(sources.map((s) => [s.programKind, s.title, s.sourceId, s.citations])).toEqual(
      expect.arrayContaining([
        ['guidance', 'Program handbook', SOURCE.handbook, 1],
        ['guidance', 'Program handbook', SOURCE.other, 1],
        ['resource', 'Library data office', null, 1],
        ['lesson', 'Free pilots teach nothing', null, 1],
      ]),
    );
    expect(sources).toHaveLength(4);
  });

  it('counts nothing for a deleted document’s passage or a passage of unknown source, and skips unkept memory', () => {
    const turns = [
      makeTurnWithEvidence([
        // A document that has since been deleted (no longer listed), even with a live name twin.
        makeEvidence({
          key: 'E1',
          kind: 'chunk',
          refId: IDS.chunk,
          title: '[deleted]',
          source: { id: SOURCE.removed, scope: 'venture' },
        }),
        // An answer from before sources were recorded, whose passage is gone.
        makeEvidence({ key: 'E2', kind: 'chunk', refId: IDS.memory2, title: `${doc.filename} — Intro` }),
        makeEvidence({
          key: 'E3',
          kind: 'doctrine',
          refId: IDS.memory3,
          title: 'Customer discovery',
          source: null,
        }),
      ]),
    ];
    const sources = buildEvidenceSources({
      documents: [doc, makeDocument({ id: IDS.resource, status: 'deleted', sourceId: SOURCE.removed })],
      memory: [makeMemory({ status: 'proposed' })],
      turns,
    });
    expect(sources.map((s) => [s.key, s.citations])).toEqual([[`document:${doc.id}`, 0]]);
  });
});
