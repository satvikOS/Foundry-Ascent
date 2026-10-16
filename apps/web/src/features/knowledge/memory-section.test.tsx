import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { memoryQueryOptions } from '@/lib/api/hooks/memory';

import { MemorySection, typedSummary } from './memory-section';
import type { KnowledgeSearch } from './search';
import { renderWithRouter, testQueryClient } from './test-utils';
import { IDS, makeMemory } from './testing';

const decision = makeMemory({
  id: IDS.memory,
  type: 'decision',
  status: 'confirmed',
  title: 'Focus on exam weeks',
  attributes: { decided_on: '2026-10-06' },
});
const insight = makeMemory({
  id: IDS.memory2,
  type: 'insight',
  status: 'confirmed',
  title: 'Group chats compete',
  pinned: true,
});
const proposal = makeMemory({
  id: IDS.memory3,
  type: 'risk',
  status: 'proposed',
  title: 'Data approval may be slow',
});

async function renderSection(search: KnowledgeSearch = {}) {
  const client = testQueryClient();
  const items = [decision, insight, proposal];
  client.setQueryData(memoryQueryOptions(IDS.venture).queryKey, { items, nextCursor: null });
  client.setQueryData(memoryQueryOptions(IDS.venture, { type: search.type }).queryKey, {
    items: items.filter((item) => !search.type || item.type === search.type),
    nextCursor: null,
  });
  const setSearch = vi.fn<(patch: Partial<KnowledgeSearch>, replace?: boolean) => void>();
  const onSelect = vi.fn<(id: string) => void>();
  await renderWithRouter(
    <MemorySection
      ventureId={IDS.venture}
      search={search}
      setSearch={setSearch}
      onSelect={onSelect}
      canEdit
      onCreate={vi.fn()}
      createLabel="Add memory"
    />,
    client,
  );
  return { setSearch, onSelect };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MemorySection', () => {
  it('lists kept memory (proposals wait in the review queue) with pinned items first', async () => {
    await renderSection();
    const list = screen.getByRole('list', { name: 'Memory' });
    const items = within(list).getAllByRole('button');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Group chats compete'),
      expect.stringContaining('Focus on exam weeks'),
    ]);
    expect(items[1]).toHaveTextContent('Confirmed');
    expect(screen.getByText('2 items')).toBeInTheDocument();
  });

  it('filters by type with chips that show counts', async () => {
    const { setSearch } = await renderSection();
    const chips = screen.getByRole('group', { name: 'Type' });
    expect(within(chips).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    // Proposals are not counted: there is no "Risk" chip.
    expect(within(chips).queryByRole('button', { name: /Risk/ })).toBeNull();
    await userEvent.click(within(chips).getByRole('button', { name: 'Decision 1' }));
    expect(setSearch).toHaveBeenCalledWith({ type: 'decision' });
    await userEvent.click(within(chips).getByRole('button', { name: 'Pinned 1' }));
    expect(setSearch).toHaveBeenCalledWith({ pinned: true });
  });

  it('marks the selected type and clears it from the chip', async () => {
    const { setSearch } = await renderSection({ type: 'decision' });
    const chip = screen.getByRole('button', { name: 'Decision 1' });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(chip);
    expect(setSearch).toHaveBeenCalledWith({ type: undefined });
  });

  it('pushes the search into the URL after typing pauses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { setSearch } = await renderSection();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'seats');
    expect(setSearch).not.toHaveBeenCalledWith({ q: 'seats' });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(setSearch).toHaveBeenCalledWith({ q: 'seats' });
  });

  it('opens an item', async () => {
    const { onSelect } = await renderSection();
    await userEvent.click(screen.getByRole('button', { name: /Focus on exam weeks/ }));
    expect(onSelect).toHaveBeenCalledWith(IDS.memory);
  });
});

describe('typedSummary', () => {
  it('shows the one typed detail worth a glance', () => {
    expect(typedSummary(decision)).toMatch(/^Decided /);
    expect(typedSummary(makeMemory({ type: 'experiment', attributes: { status: 'running' } }))).toBe(
      'Running',
    );
    expect(
      typedSummary(makeMemory({ type: 'action', attributes: { status: 'done', due: '2020-01-01' } })),
    ).toMatch(/^Done · Due /);
    expect(
      typedSummary(makeMemory({ type: 'action', attributes: { status: 'open', due: '2020-01-01' } })),
    ).toMatch(/Overdue since/);
    expect(typedSummary(insight)).toBeNull();
  });
});
