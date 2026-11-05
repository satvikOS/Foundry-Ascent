import type { MemoryObjectView } from '@foundry/contracts';
import { screen, waitFor, within } from '@testing-library/react';
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
  it('offers Edit, Pin and Forget, and never Approve, Reject or Dispute', async () => {
    for (const status of ['proposed', 'confirmed', 'disputed'] as const) {
      const { unmount } = await (async () => {
        const client = testQueryClient();
        const item = makeMemory({ id: IDS.memory, status });
        client.setQueryData(memoryQueryOptions(IDS.venture).queryKey, { items: [item], nextCursor: null });
        return renderWithRouter(<MemoryActionBar ventureId={IDS.venture} memory={item} />, client);
      })();
      expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Forget' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Approve|Reject|Keep|Not now|Dispute/ })).toBeNull();
      unmount();
    }
  });

  it('pins in place, through PATCH /memory/:id', async () => {
    const item = makeMemory({ id: IDS.memory, status: 'confirmed', pinned: false });
    fetchMock.mockImplementation((_input, init) =>
      Promise.resolve(
        init?.method === 'PATCH' ? json({ ...item, pinned: true }) : json({ items: [], nextCursor: null }),
      ),
    );
    const success = vi.spyOn(toast, 'success');
    const { user } = await renderBar(item);
    await user.click(screen.getByRole('button', { name: 'Pin' }));
    await waitFor(() => {
      expect(writes()).toHaveLength(1);
    });
    expect(writes()[0]).toMatchObject({ method: 'PATCH', body: { action: 'pin' } });
    await waitFor(() => {
      expect(success).toHaveBeenCalledWith('Pinned');
    });
  });

  it('forgets only after the person confirms, and says so', async () => {
    const item = makeMemory({ id: IDS.memory, status: 'confirmed' });
    fetchMock.mockImplementation((_input, init) =>
      Promise.resolve(
        init?.method === 'PATCH'
          ? new Response(null, { status: 204 })
          : json({ items: [], nextCursor: null }),
      ),
    );
    const success = vi.spyOn(toast, 'success');
    const { user } = await renderBar(item);
    await user.click(screen.getByRole('button', { name: 'Forget' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Forget this?' });
    expect(writes()).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Forget' }));
    await waitFor(() => {
      expect(writes()).toHaveLength(1);
    });
    expect(writes()[0]).toMatchObject({ method: 'PATCH', body: { action: 'delete' } });
    await waitFor(() => {
      expect(success).toHaveBeenCalledWith('Forgotten');
    });
  });

  it('tells the person when forgetting failed', async () => {
    const item = makeMemory({ id: IDS.memory, status: 'confirmed' });
    fetchMock.mockImplementation((_input, init) =>
      Promise.resolve(
        init?.method === 'PATCH' ? problem(409, 'conflict') : json({ items: [], nextCursor: null }),
      ),
    );
    const failure = vi.spyOn(toast, 'error');
    const { user } = await renderBar(item);
    await user.click(screen.getByRole('button', { name: 'Forget' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Forget' }));
    await waitFor(() => {
      expect(failure).toHaveBeenCalled();
    });
    expect(failure.mock.calls[0]?.[0]).toBe('Couldn’t update memory');
  });
});
