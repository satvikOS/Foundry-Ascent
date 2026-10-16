import type { MemoryObjectView } from '@foundry/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryQueryOptions } from '@/lib/api/hooks/memory';

import { ReviewQueue } from './review-queue';
import { bodyOf, json, renderWithRouter, stubFetch, testQueryClient, urlOf } from './test-utils';
import { IDS, makeMemory } from './testing';

let fetchMock: ReturnType<typeof stubFetch>;

const first = makeMemory({ id: IDS.memory, title: 'Exam weeks drive demand' });
const second = makeMemory({ id: IDS.memory2, title: 'Group chats are the workaround', type: 'risk' });
const third = makeMemory({ id: IDS.memory3, title: 'Libraries count doors', type: 'fact' });

function seed(items: MemoryObjectView[]) {
  const client = testQueryClient();
  const proposedKey = memoryQueryOptions(IDS.venture, { status: 'proposed' }).queryKey;
  const allKey = memoryQueryOptions(IDS.venture).queryKey;
  client.setQueryData(proposedKey, { items, nextCursor: null });
  client.setQueryData(allKey, { items, nextCursor: null });
  return { client, proposedKey, allKey };
}

/** The batch endpoint answers with the reviewed items; list refetches answer with `remaining`. */
function respond(status: MemoryObjectView['status'], remaining: MemoryObjectView[]) {
  fetchMock.mockImplementation((input, init) => {
    if (init?.method === 'POST') {
      const { ids } = bodyOf(init) as { ids: string[] };
      return Promise.resolve(json({ items: ids.map((id) => makeMemory({ id, status })), skippedIds: [] }));
    }
    return Promise.resolve(
      urlOf(input).includes('/memory') ? json({ items: remaining, nextCursor: null }) : json({}),
    );
  });
}

function batchCalls() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
}

async function renderQueue(items: MemoryObjectView[], canEdit = true) {
  const ctx = seed(items);
  const onOpenDetail = vi.fn<(id: string) => void>();
  await renderWithRouter(
    <ReviewQueue
      ventureId={IDS.venture}
      tenant="ain"
      canEdit={canEdit}
      veirName="Corin"
      onOpenDetail={onOpenDetail}
    />,
    ctx.client,
  );
  return { ...ctx, onOpenDetail, user: userEvent.setup() };
}

function rows(): HTMLElement[] {
  return within(screen.getByRole('list', { name: 'Suggestions to review' })).getAllByRole('listitem');
}

beforeEach(() => {
  fetchMock = stubFetch();
});

describe('ReviewQueue', () => {
  it('approves two selected suggestions in one batch and drops them from the queue', async () => {
    respond('confirmed', [third]);
    const { user, client, proposedKey } = await renderQueue([first, second, third]);
    expect(screen.getByText('3 suggestions to review')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Exam weeks drive demand' }));
    await user.click(screen.getByRole('checkbox', { name: 'Group chats are the workaround' }));
    expect(screen.getByText('2 of 3 suggestions selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve 2' }));

    await waitFor(() => {
      expect(batchCalls()).toHaveLength(1);
    });
    const [input, init] = batchCalls()[0] ?? [];
    expect(urlOf(input)).toContain(`/ventures/${IDS.venture}/memory/batch`);
    expect(bodyOf(init)).toEqual({ ids: [IDS.memory, IDS.memory2], action: 'approve' });
    await waitFor(() => {
      expect(rows()).toHaveLength(1);
    });
    expect(client.getQueryData<{ items: MemoryObjectView[] }>(proposedKey)?.items.map((m) => m.id)).toEqual([
      IDS.memory3,
    ]);
  });

  it('asks before rejecting a selection', async () => {
    respond('rejected', [second]);
    const { user } = await renderQueue([first, second]);
    await user.click(screen.getByRole('checkbox', { name: 'Exam weeks drive demand' }));
    await user.click(screen.getByRole('button', { name: 'Reject 1' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Reject 1 suggestion?' });
    expect(batchCalls()).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(batchCalls()).toHaveLength(1);
    });
    expect(bodyOf(batchCalls()[0]?.[1])).toEqual({ ids: [IDS.memory], action: 'reject' });
  });

  it('moves with J/K and approves the focused suggestion with A, ignoring a "g" sequence', async () => {
    respond('confirmed', [first]);
    const { user } = await renderQueue([first, second]);
    const [one, two] = rows();
    if (!one || !two) throw new Error('no rows');
    one.focus();
    await user.keyboard('j');
    await waitFor(() => {
      expect(two).toHaveFocus();
    });
    expect(two).toHaveAttribute('aria-current', 'true');
    await user.keyboard('ga');
    expect(fetchMock).not.toHaveBeenCalled();
    await user.keyboard('a');
    await waitFor(() => {
      expect(batchCalls()).toHaveLength(1);
    });
    expect(bodyOf(batchCalls()[0]?.[1])).toEqual({ ids: [IDS.memory2], action: 'approve' });
  });

  it('shows read-only viewers the queue without decisions; Enter opens the detail', async () => {
    const { user, onOpenDetail } = await renderQueue([first], false);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    const [row] = rows();
    if (!row) throw new Error('no rows');
    row.focus();
    await user.keyboard('a');
    expect(fetchMock).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onOpenDetail).toHaveBeenCalledWith(IDS.memory);
  });

  it('says when nothing is waiting', async () => {
    await renderQueue([]);
    expect(screen.getByRole('heading', { name: 'Nothing to review' })).toBeInTheDocument();
  });
});
