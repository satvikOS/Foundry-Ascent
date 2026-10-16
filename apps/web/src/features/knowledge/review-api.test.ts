import { BatchMemoryActionRequest } from '@foundry/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { errorMessage } from '@/lib/api/errors';

import {
  decisionMessage,
  PartialReviewError,
  REVIEW_BATCH_MAX,
  reviewFailure,
  reviewMemory,
  reviewMessage,
} from './review-api';
import { bodyOf, json, problem, stubFetch, urlOf } from './test-utils';
import { IDS, makeMemory, manyIds } from './testing';

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

  it('sends a selection larger than one request takes in parts and merges the answers', async () => {
    const ids = manyIds(REVIEW_BATCH_MAX + 1);
    fetchMock.mockImplementation((_input, init) => {
      const body = bodyOf(init) as { ids: string[] };
      return Promise.resolve(
        json({ items: body.ids.map((id) => makeMemory({ id, status: 'confirmed' })), skippedIds: [] }),
      );
    });

    const result = await reviewMemory(IDS.venture, ids, 'approve');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sent = fetchMock.mock.calls.map(([, init]) => (bodyOf(init) as { ids: string[] }).ids);
    expect(sent.map((part) => part.length)).toEqual([REVIEW_BATCH_MAX, 1]);
    expect(sent.flat()).toEqual(ids);
    expect(result.items).toHaveLength(ids.length);
  });

  it('keeps what earlier parts decided when a later part fails', async () => {
    const ids = manyIds(REVIEW_BATCH_MAX + 1);
    fetchMock
      .mockImplementationOnce((_input, init) => {
        const body = bodyOf(init) as { ids: string[] };
        return Promise.resolve(
          json({ items: body.ids.map((id) => makeMemory({ id, status: 'rejected' })), skippedIds: [] }),
        );
      })
      .mockResolvedValueOnce(problem(503, 'unavailable', 'Try again'));

    const error = await reviewMemory(IDS.venture, ids, 'reject').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PartialReviewError);
    const partial = error as PartialReviewError;
    expect(partial.done.items).toHaveLength(REVIEW_BATCH_MAX);
    expect(partial.cause).toMatchObject({ status: 503 });
    expect(reviewFailure('reject', ids, partial)).toEqual({
      title: `Rejected ${REVIEW_BATCH_MAX}. 1 item couldn’t be updated.`,
      description: errorMessage(partial.cause),
    });
  });

  it('matches the batch contract’s limit', () => {
    expect(
      BatchMemoryActionRequest.safeParse({ ids: manyIds(REVIEW_BATCH_MAX), action: 'approve' }).success,
    ).toBe(true);
    expect(
      BatchMemoryActionRequest.safeParse({ ids: manyIds(REVIEW_BATCH_MAX + 1), action: 'approve' }).success,
    ).toBe(false);
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

describe('decisionMessage (Keep / Not now in a conversation)', () => {
  it('speaks in the words of the buttons', () => {
    const one = { items: [makeMemory()], skippedIds: [] };
    expect(decisionMessage('approve', one)).toBe('Kept');
    expect(decisionMessage('reject', one)).toBe('Not kept');
    expect(decisionMessage('approve', { items: [makeMemory(), makeMemory()], skippedIds: [] })).toBe(
      'Kept 2',
    );
    expect(decisionMessage('approve', { items: [], skippedIds: [IDS.memory] })).toBe('Already handled.');
  });
});
