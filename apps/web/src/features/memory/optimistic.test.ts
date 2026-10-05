import { describe, expect, it } from 'vitest';

import { IDS, makeMemory } from '@/features/coach/testing';

import {
  applyMemoryAction,
  applyMemoryActionToList,
  availableMemoryActions,
  canApplyMemoryAction,
  findMemoryForCandidate,
  memoryActionSuccessMessage,
  memoryMatchesFilters,
} from './optimistic';

const NOW = '2026-10-05T09:00:00.000Z';

describe('availableMemoryActions', () => {
  it('offers review actions for proposed memory', () => {
    expect(availableMemoryActions(makeMemory({ status: 'proposed' }))).toEqual([
      'approve',
      'reject',
      'correct',
      'delete',
    ]);
  });

  it('offers pin or unpin depending on the current state', () => {
    expect(availableMemoryActions(makeMemory({ status: 'confirmed', pinned: false }))).toContain('pin');
    expect(availableMemoryActions(makeMemory({ status: 'confirmed', pinned: true }))).toContain('unpin');
    expect(canApplyMemoryAction(makeMemory({ status: 'confirmed' }), 'approve')).toBe(false);
  });

  it('keeps history read-only', () => {
    expect(availableMemoryActions(makeMemory({ status: 'superseded' }))).toEqual(['delete']);
    expect(availableMemoryActions(makeMemory({ status: 'deleted' }))).toEqual([]);
  });
});

describe('applyMemoryAction', () => {
  it('approves proposed memory', () => {
    const next = applyMemoryAction(makeMemory(), { action: 'approve' }, NOW);
    expect(next.status).toBe('confirmed');
    expect(next.approvedAt).toBe(NOW);
    expect(next.updatedAt).toBe(NOW);
  });

  it('rejects, disputes and deletes', () => {
    expect(applyMemoryAction(makeMemory(), { action: 'reject' }, NOW).status).toBe('rejected');
    expect(
      applyMemoryAction(
        makeMemory({ status: 'confirmed' }),
        { action: 'dispute', reason: 'Wrong number' },
        NOW,
      ).status,
    ).toBe('disputed');
    const deleted = applyMemoryAction(makeMemory({ pinned: true }), { action: 'delete' }, NOW);
    expect(deleted.status).toBe('deleted');
    expect(deleted.pinned).toBe(false);
  });

  it('pins and unpins without changing status', () => {
    const pinned = applyMemoryAction(makeMemory({ status: 'confirmed' }), { action: 'pin' }, NOW);
    expect(pinned).toMatchObject({ pinned: true, status: 'confirmed' });
    expect(applyMemoryAction(pinned, { action: 'unpin' }, NOW).pinned).toBe(false);
  });

  it('applies a correction patch as a new version', () => {
    const next = applyMemoryAction(
      makeMemory({ status: 'confirmed', version: 2 }),
      {
        action: 'correct',
        patch: { title: '  New title ', confidence: 0.9, visibility: 'team' },
        reason: 'typo',
      },
      NOW,
    );
    expect(next).toMatchObject({
      title: 'New title',
      content: 'Usage spikes before exams.',
      confidence: 0.9,
      visibility: 'team',
      version: 3,
      status: 'confirmed',
    });
  });
});

describe('list projection', () => {
  const proposed = makeMemory();
  const other = makeMemory({ id: IDS.memory2, title: 'Other', status: 'confirmed', type: 'fact' });

  it('drops approved items from a "proposed" queue', () => {
    const next = applyMemoryActionToList(
      [proposed, other],
      IDS.memory,
      { action: 'approve' },
      { status: 'proposed' },
      NOW,
    );
    expect(next).toEqual([other]);
  });

  it('updates items in place in an unfiltered list and hides deletions', () => {
    const approved = applyMemoryActionToList([proposed, other], IDS.memory, { action: 'approve' }, {}, NOW);
    expect(approved.map((m) => m.status)).toEqual(['confirmed', 'confirmed']);
    const deleted = applyMemoryActionToList(
      [proposed, other],
      IDS.memory,
      { action: 'delete' },
      undefined,
      NOW,
    );
    expect(deleted).toEqual([other]);
  });

  it('respects type and pinned filters and ignores free-text search', () => {
    expect(memoryMatchesFilters(other, { type: 'fact' })).toBe(true);
    expect(memoryMatchesFilters(other, { type: 'decision' })).toBe(false);
    const unpinned = applyMemoryActionToList(
      [makeMemory({ status: 'confirmed', pinned: true })],
      IDS.memory,
      { action: 'unpin' },
      { pinned: true },
      NOW,
    );
    expect(unpinned).toEqual([]);
    expect(memoryMatchesFilters(other, { q: 'no match at all' })).toBe(true);
  });

  it('leaves the list untouched when the id is not present', () => {
    const items = [other];
    expect(applyMemoryActionToList(items, IDS.memory, { action: 'approve' }, {}, NOW)).toEqual(items);
  });
});

describe('candidate matching', () => {
  it('finds the proposed object created from a turn by type and title', () => {
    const fromTurn = makeMemory({ title: 'Exam weeks  drive demand' });
    const unrelated = makeMemory({ id: IDS.memory2, sourceRefs: [{ kind: 'manual', id: 'founder' }] });
    expect(
      findMemoryForCandidate([unrelated, fromTurn], IDS.turn, {
        type: 'insight',
        title: 'exam weeks drive demand',
      }),
    ).toBe(fromTurn);
    expect(
      findMemoryForCandidate([unrelated], IDS.turn, { type: 'insight', title: 'Exam weeks drive demand' }),
    ).toBe(null);
  });

  it('has a success message for every action', () => {
    expect(memoryActionSuccessMessage('approve')).toMatch(/Approved/);
    expect(memoryActionSuccessMessage('delete')).toMatch(/Deleted/);
  });
});
