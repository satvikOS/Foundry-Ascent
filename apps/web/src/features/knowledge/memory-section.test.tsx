import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { memoryQueryOptions } from '@/lib/api/hooks/memory';
import { sessionsQueryOptions } from '@/lib/api/hooks/sessions';

import { MemorySection, typedSummary } from './memory-section';
import type { KnowledgeSearch } from './search';
import { json, renderWithRouter, stubFetch, testQueryClient, urlOf } from './test-utils';
import { IDS, makeMemory, makeSession } from './testing';

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

async function renderSection(
  search: KnowledgeSearch = {},
  {
    withActions = false,
    items = [decision, insight, proposal],
    calls = [],
  }: { withActions?: boolean; items?: ReturnType<typeof makeMemory>[]; calls?: string[] } = {},
) {
  const client = testQueryClient();
  // The venture's conversations: those listed in `calls` had a call.
  client.setQueryData(sessionsQueryOptions(IDS.venture).queryKey, {
    items: calls.map((id) => makeSession({ id, hasCalls: true })),
  });
  client.setQueryData(memoryQueryOptions(IDS.venture).queryKey, { items, nextCursor: null });
  client.setQueryData(memoryQueryOptions(IDS.venture, { type: search.type }).queryKey, {
    items: items.filter((item) => !search.type || item.type === search.type),
    nextCursor: null,
  });
  const setSearch = vi.fn<(patch: Partial<KnowledgeSearch>, replace?: boolean) => void>();
  const onSelect = vi.fn<(id: string) => void>();
  const onEdit = vi.fn();
  const onForget = vi.fn();
  await renderWithRouter(
    <MemorySection
      ventureId={IDS.venture}
      search={search}
      setSearch={setSearch}
      onSelect={onSelect}
      canEdit
      onCreate={vi.fn()}
      createLabel="Add memory"
      {...(withActions ? { onEdit, onForget } : {})}
    />,
    client,
  );
  return { setSearch, onSelect, onEdit, onForget };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MemorySection', () => {
  it('lists everything the vEIR knows, saying where each came from, pinned first and nothing to review', async () => {
    await renderSection();
    const list = screen.getByRole('list', { name: 'Memory' });
    const items = within(list).getAllByRole('button');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Group chats compete'),
      expect.stringContaining('Focus on exam weeks'),
      expect.stringContaining('Data approval may be slow'),
    ]);
    // An older suggestion is listed like any other: no "Proposed", no Approve or Reject.
    expect(items[2]).toHaveTextContent(/Learned from the conversation on /);
    expect(items[2]).not.toHaveTextContent(/Proposed|Confirmed/);
    expect(screen.getByText('3 items')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve|Reject|Keep/ })).toBeNull();
    // Filters stay minimal: search and type chips, no status picker.
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('says an item was learned on a call when its conversation had one', async () => {
    await renderSection({}, { calls: [IDS.session] });
    const list = screen.getByRole('list', { name: 'Memory' });
    const learned = within(list).getByRole('button', { name: /Data approval may be slow/ });
    expect(learned).toHaveTextContent(/Learned from the call on /);
  });

  it('asks for the venture’s conversations only when an item names the one it was learned from', async () => {
    const fetchMock = stubFetch().mockResolvedValue(json({ items: [] }));
    const fromAnswer = makeMemory({
      id: IDS.memory3,
      status: 'proposed',
      title: 'Data approval may be slow',
      sourceRefs: [{ kind: 'turn', id: IDS.turn, label: 'AI proposal' }],
    });
    const client = testQueryClient();
    client.setQueryData(memoryQueryOptions(IDS.venture).queryKey, { items: [fromAnswer], nextCursor: null });
    client.setQueryData(memoryQueryOptions(IDS.venture, {}).queryKey, {
      items: [fromAnswer],
      nextCursor: null,
    });
    await renderWithRouter(
      <MemorySection
        ventureId={IDS.venture}
        search={{}}
        setSearch={vi.fn()}
        onSelect={vi.fn()}
        canEdit
        onCreate={vi.fn()}
        createLabel="Add memory"
      />,
      client,
    );
    expect(screen.getByRole('button', { name: /Data approval may be slow/ })).toHaveTextContent(
      /Learned from a conversation on /,
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(
      fetchMock.mock.calls.map(([input]) => urlOf(input)).filter((url) => url.includes('/sessions')),
    ).toEqual([]);
  });

  it('offers Edit and Forget for each item', async () => {
    const { onEdit, onForget } = await renderSection({}, { withActions: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Actions for Focus on exam weeks' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: IDS.memory }));
    await user.click(screen.getByRole('button', { name: 'Actions for Data approval may be slow' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Forget…' }));
    expect(onForget).toHaveBeenCalledWith(expect.objectContaining({ id: IDS.memory3 }));
  });

  it('filters by type with chips that show counts', async () => {
    const { setSearch } = await renderSection();
    const chips = screen.getByRole('group', { name: 'Type' });
    expect(within(chips).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    // An older suggestion counts like anything else the vEIR knows.
    expect(within(chips).getByRole('button', { name: 'Risk 1' })).toBeInTheDocument();
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
