import { describe, expect, it } from 'vitest';

import { buildEvidenceSources } from './evidence';
import { memoryListRows, pendingCount, typeChips } from './memory-filters';
import { validateKnowledgeSearch } from './search';
import { IDS, makeDocument, makeEvidence, makeMemory, makeTurnWithEvidence } from './testing';

describe('validateKnowledgeSearch', () => {
  it('keeps valid filters and drops the rest', () => {
    expect(
      validateKnowledgeSearch({
        type: 'decision',
        status: 'disputed',
        q: '  seats ',
        m: IDS.memory,
        pinned: 'true',
      }),
    ).toEqual({
      view: undefined,
      type: 'decision',
      status: 'disputed',
      q: 'seats',
      m: IDS.memory,
      pinned: true,
    });
    expect(validateKnowledgeSearch({ type: 'nope', status: 'nope', m: 'not-a-uuid', view: 'nope' })).toEqual({
      view: undefined,
      type: undefined,
      status: undefined,
      q: undefined,
      m: undefined,
      pinned: undefined,
    });
  });

  it('opens the review queue for old proposed-memory links', () => {
    expect(validateKnowledgeSearch({ view: 'proposed' }).view).toBe('proposed');
    expect(validateKnowledgeSearch({ status: 'proposed' })).toMatchObject({
      view: 'proposed',
      status: undefined,
    });
    expect(validateKnowledgeSearch({ view: 'all' }).view).toBeUndefined();
    expect(validateKnowledgeSearch({ view: 'notebook' }).view).toBe('notebook');
  });
});

describe('memory list filters', () => {
  const kept = makeMemory({
    id: IDS.memory,
    status: 'confirmed',
    type: 'decision',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });
  const pinned = makeMemory({
    id: IDS.memory2,
    status: 'disputed',
    type: 'insight',
    pinned: true,
    updatedAt: '2026-09-01T00:00:00.000Z',
  });
  const proposal = makeMemory({ id: IDS.memory3, status: 'proposed', type: 'risk' });

  it('leaves proposals to the review queue and puts pinned items first', () => {
    expect(memoryListRows([kept, proposal, pinned], undefined).map((m) => m.id)).toEqual([
      IDS.memory2,
      IDS.memory,
    ]);
    expect(memoryListRows([kept, proposal, pinned], 'disputed').map((m) => m.id)).toEqual([IDS.memory2]);
    expect(pendingCount([kept, proposal, pinned])).toBe(1);
  });

  it('offers a chip per kept type with its count, and keeps the selected chip visible', () => {
    expect(typeChips([kept, pinned, proposal], undefined)).toEqual([
      { type: 'decision', count: 1 },
      { type: 'insight', count: 1 },
    ]);
    expect(typeChips([kept], 'milestone')).toEqual([
      { type: 'decision', count: 1 },
      { type: 'milestone', count: 0 },
    ]);
  });
});

describe('buildEvidenceSources', () => {
  const doc = makeDocument();
  const memory = makeMemory({ status: 'confirmed' });

  it('counts the answers that cited each source, including documents through their passages', () => {
    const turns = [
      makeTurnWithEvidence([
        makeEvidence({ key: 'E1', kind: 'chunk', refId: IDS.chunk, title: `${doc.filename} — Findings` }),
        makeEvidence({ key: 'E2', kind: 'chunk', refId: IDS.resource, title: `${doc.filename} — Method` }),
        makeEvidence({ key: 'E3', kind: 'memory', refId: memory.id }),
      ]),
      makeTurnWithEvidence([
        makeEvidence({ key: 'E1', kind: 'chunk', refId: IDS.chunk, title: doc.filename }),
      ]),
    ];
    const sources = buildEvidenceSources({ documents: [doc], memory: [memory], turns });
    const byKey = new Map(sources.map((s) => [s.key, s]));
    // Two passages of one document in one answer count once for that answer.
    expect(byKey.get(`document:${doc.id}`)?.citations).toBe(2);
    expect(byKey.get(`memory:${memory.id}`)?.citations).toBe(1);
    expect(sources[0]?.key).toBe(`document:${doc.id}`);
  });

  it('groups program sources, never mistakes a deleted document for program guidance, and skips unkept memory', () => {
    const deleted = makeDocument({ id: IDS.document, filename: 'old-notes.md', status: 'deleted' });
    const turns = [
      makeTurnWithEvidence([
        makeEvidence({ key: 'E1', kind: 'chunk', refId: IDS.chunk, title: 'Program handbook — Pilots' }),
        makeEvidence({ key: 'E2', kind: 'chunk', refId: IDS.resource, title: 'Program handbook — Data' }),
        makeEvidence({ key: 'E3', kind: 'chunk', refId: IDS.memory3, title: 'old-notes.md — Intro' }),
        makeEvidence({ key: 'E4', kind: 'resource', refId: IDS.resource, title: 'Library data office' }),
        makeEvidence({
          key: 'E5',
          kind: 'doctrine',
          refId: IDS.memory2,
          title: 'Customer discovery — Kill criteria',
        }),
      ]),
    ];
    const sources = buildEvidenceSources({
      documents: [deleted],
      memory: [makeMemory({ status: 'proposed' })],
      turns,
    });
    expect(sources.map((s) => [s.kind, s.programKind, s.title, s.citations])).toEqual(
      expect.arrayContaining([
        ['program', 'guidance', 'Program handbook', 1],
        ['program', 'resource', 'Library data office', 1],
        ['program', 'library', 'Customer discovery', 1],
      ]),
    );
    expect(sources).toHaveLength(3);
  });
});
