import { beforeEach, describe, expect, it } from 'vitest';

import { reviewMemory, reviewMessage } from './review-api';
import { bodyOf, json, problem, stubFetch, urlOf } from './test-utils';
import { IDS, makeMemory } from './testing';

let fetchMock: ReturnType<typeof stubFetch>;

beforeEach(() => {
  fetchMock = stubFetch();
});

describe('reviewMemory', () => {
  it('approves several proposals in one batch request', async () => {
    const approved = [
      makeMemory({ id: IDS.memory, status: 'confirmed' }),
      makeMemory({ id: IDS.memory2, status: 'confirmed' }),
    ];
    fetchMock.mockResolvedValue(json({ items: approved, skippedIds: [] }));

    const result = await reviewMemory(IDS.venture, [IDS.memory, IDS.memory2], 'approve');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(urlOf(input)).toContain(`/api/v1/ventures/${IDS.venture}/memory/batch`);
    expect(init?.method).toBe('POST');
    expect(bodyOf(init)).toEqual({ ids: [IDS.memory, IDS.memory2], action: 'approve' });
    expect(result.items.map((item) => item.id)).toEqual([IDS.memory, IDS.memory2]);
    expect(result.skippedIds).toEqual([]);
  });

  it('falls back to one PATCH per item when the API has no batch endpoint, skipping handled items', async () => {
    fetchMock
      .mockResolvedValueOnce(problem(404, 'not_found', 'No such endpoint'))
      .mockResolvedValueOnce(json(makeMemory({ id: IDS.memory, status: 'rejected' })))
      .mockResolvedValueOnce(problem(409, 'conflict'));

    const result = await reviewMemory(IDS.venture, [IDS.memory, IDS.memory2], 'reject');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const patches = fetchMock.mock.calls.slice(1);
    expect(patches.map(([input]) => urlOf(input))).toEqual([
      expect.stringContaining(`/api/v1/memory/${IDS.memory}`),
      expect.stringContaining(`/api/v1/memory/${IDS.memory2}`),
    ]);
    expect(patches.every(([, init]) => init?.method === 'PATCH')).toBe(true);
    expect(bodyOf(patches[0]?.[1])).toEqual({ action: 'reject' });
    expect(result.items.map((item) => item.id)).toEqual([IDS.memory]);
    expect(result.skippedIds).toEqual([IDS.memory2]);
  });

  it('fails without falling back when the batch request is refused for another reason', async () => {
    fetchMock.mockResolvedValue(problem(403, 'forbidden'));
    await expect(reviewMemory(IDS.venture, [IDS.memory], 'approve')).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty selection before sending anything', async () => {
    await expect(reviewMemory(IDS.venture, [], 'approve')).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('reviewMessage', () => {
  const item = makeMemory();
  it('counts what changed and what someone else already handled, never the content', () => {
    expect(reviewMessage('approve', { items: [item], skippedIds: [] })).toBe('Approved');
    expect(reviewMessage('approve', { items: [item, item], skippedIds: [] })).toBe('Approved 2');
    expect(reviewMessage('reject', { items: [item, item], skippedIds: [IDS.memory3] })).toBe(
      'Rejected 2. 1 item had already been handled.',
    );
    expect(reviewMessage('approve', { items: [], skippedIds: [IDS.memory] })).toBe(
      'Nothing changed: these were already handled.',
    );
  });
});
