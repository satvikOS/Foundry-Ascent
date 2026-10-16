import type { MemoryObjectView } from '@foundry/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toast } from '@/components/ui/toast';
import { memoryQueryOptions } from '@/lib/api/hooks/memory';
import {
  bodyOf,
  json,
  problem,
  renderWithRouter,
  stubFetch,
  testQueryClient,
  urlOf,
} from '@/features/knowledge/test-utils';
import { IDS, makeMemory } from '@/features/knowledge/testing';

import { MemoryActionBar } from './memory-action-bar';

let fetchMock: ReturnType<typeof stubFetch>;

beforeEach(() => {
  fetchMock = stubFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderBar(memory: MemoryObjectView) {
  const client = testQueryClient();
  client.setQueryData(memoryQueryOptions(IDS.venture).queryKey, { items: [memory], nextCursor: null });
  await renderWithRouter(<MemoryActionBar ventureId={IDS.venture} memory={memory} />, client);
  return { client, user: userEvent.setup() };
}

function writes() {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST' || init?.method === 'PATCH')
    .map(([input, init]) => ({ url: urlOf(input), method: init?.method, body: bodyOf(init) }));
}

describe('MemoryActionBar', () => {
  it('approves a disputed item through PATCH /memory/:id and says the dispute is resolved', async () => {
    const item = makeMemory({ id: IDS.memory, status: 'disputed', title: 'Exam weeks drive demand' });
    fetchMock.mockImplementation((_input, init) =>
      Promise.resolve(
        init?.method === 'PATCH'
          ? json({ ...item, status: 'confirmed', approvedAt: '2026-10-05T09:00:00.000Z' })
          : // The batch endpoint only decides proposals: a disputed item would be skipped.
            init?.method === 'POST'
            ? json({ items: [], skippedIds: [IDS.memory] })
            : json({ items: [], nextCursor: null }),
      ),
    );
    const success = vi.spyOn(toast, 'success');
    const { user } = await renderBar(item);

    await user.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(writes()).toHaveLength(1);
    });
    expect(writes()[0]).toMatchObject({
      method: 'PATCH',
      body: { action: 'approve' },
    });
    expect(writes()[0]?.url).toContain(`/api/v1/memory/${IDS.memory}`);
    await waitFor(() => {
      expect(success).toHaveBeenCalled();
    });
    const message = success.mock.calls[0]?.[0];
    expect(message).not.toMatch(/Nothing changed|already handled/);
    expect(message).toBe('Dispute resolved: kept as venture memory');
  });

  it('tells the person when another teammate already resolved the dispute (409)', async () => {
    const item = makeMemory({ id: IDS.memory, status: 'disputed' });
    fetchMock.mockImplementation((_input, init) =>
      Promise.resolve(
        init?.method === 'PATCH' ? problem(409, 'conflict') : json({ items: [], nextCursor: null }),
      ),
    );
    const failure = vi.spyOn(toast, 'error');
    const { user } = await renderBar(item);

    await user.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(failure).toHaveBeenCalled();
    });
    expect(failure.mock.calls[0]?.[0]).toBe('Couldn’t update memory');
    expect(writes().map((w) => w.method)).toEqual(['PATCH']);
  });

  it('still approves a proposal through the review path', async () => {
    const proposal = makeMemory({ id: IDS.memory });
    fetchMock.mockImplementation((_input, init) =>
      Promise.resolve(
        init?.method === 'POST'
          ? json({ items: [{ ...proposal, status: 'confirmed' }], skippedIds: [] })
          : json({ items: [], nextCursor: null }),
      ),
    );
    const { user } = await renderBar(proposal);

    await user.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(writes()).toHaveLength(1);
    });
    expect(writes()[0]).toMatchObject({ method: 'POST', body: { ids: [IDS.memory], action: 'approve' } });
    expect(writes()[0]?.url).toContain(`/api/v1/ventures/${IDS.venture}/memory/batch`);
  });
});
