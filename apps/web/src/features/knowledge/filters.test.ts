import { describe, expect, it } from 'vitest';

import { memoryListRows, typeChips } from './memory-filters';
import { validateKnowledgeSearch } from './search';
import { IDS, makeMemory } from './testing';

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

  it('opens the memory list for old review-queue links: nothing waits for review any more', () => {
    expect(validateKnowledgeSearch({ view: 'proposed' }).view).toBeUndefined();
    expect(validateKnowledgeSearch({ status: 'proposed' })).toMatchObject({
      view: undefined,
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

  const forgotten = makeMemory({ id: IDS.session2, status: 'deleted', type: 'risk' });
  const replaced = makeMemory({ id: IDS.chunk, status: 'superseded', type: 'risk' });

  it('lists everything the vEIR knows, older suggestions included, pinned items first', () => {
    expect(memoryListRows([kept, proposal, pinned, forgotten, replaced], undefined).map((m) => m.id)).toEqual(
      [IDS.memory2, IDS.memory3, IDS.memory],
    );
    expect(memoryListRows([kept, proposal, pinned], 'disputed').map((m) => m.id)).toEqual([IDS.memory2]);
  });

  it('offers a chip per type the vEIR knows with its count, and keeps the selected chip visible', () => {
    expect(typeChips([kept, pinned, proposal, forgotten], undefined)).toEqual([
      { type: 'decision', count: 1 },
      { type: 'risk', count: 1 },
      { type: 'insight', count: 1 },
    ]);
    expect(typeChips([kept], 'milestone')).toEqual([
      { type: 'decision', count: 1 },
      { type: 'milestone', count: 0 },
    ]);
  });
});
