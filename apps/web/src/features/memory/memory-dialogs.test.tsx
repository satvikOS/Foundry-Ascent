import type { MemoryObjectView } from '@foundry/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

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

import { CorrectMemoryDialog } from './memory-dialogs';

let fetchMock: ReturnType<typeof stubFetch>;

beforeEach(() => {
  fetchMock = stubFetch();
});

// The fixture carries its full text (not a list excerpt), so the form can be saved at once.
const proposal = makeMemory({ id: IDS.memory, title: 'Exam weeks drive demand' });

async function renderDialog(memory: MemoryObjectView) {
  const client = testQueryClient();
  client.setQueryData(memoryQueryOptions(IDS.venture, { status: 'proposed' }).queryKey, {
    items: [memory],
    nextCursor: null,
  });
  await renderWithRouter(
    <CorrectMemoryDialog ventureId={IDS.venture} memory={memory} open onOpenChange={() => undefined} />,
    client,
  );
  return userEvent.setup();
}

function sent() {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST' || init?.method === 'PATCH')
    .map(([input, init]) => ({ url: urlOf(input), method: init?.method, body: bodyOf(init) }));
}

describe('CorrectMemoryDialog', () => {
  it('saving nothing changes nothing: no hidden approve of an older suggestion', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ items: [], nextCursor: null })));
    const user = await renderDialog(proposal);
    const dialog = screen.getByRole('dialog', { name: 'Edit memory' });
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).queryByText(/Approve|Confidence/)).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Nothing changed. Edit a field, or cancel.',
    );
    expect(sent()).toHaveLength(0);
  });

  it('keeps an older suggestion before saving the edit as a new version (the server corrects only kept AI memory)', async () => {
    const kept = { ...proposal, status: 'confirmed' as const };
    const corrected = makeMemory({
      id: IDS.memory2,
      title: 'Exam weeks double demand',
      status: 'confirmed',
      version: 2,
    });
    fetchMock.mockImplementation((_input, init) => {
      if (init?.method === 'POST') return Promise.resolve(json({ items: [kept], skippedIds: [] }));
      if (init?.method === 'PATCH') return Promise.resolve(json(corrected));
      return Promise.resolve(json({ items: [], nextCursor: null }));
    });
    const user = await renderDialog(proposal);
    const dialog = screen.getByRole('dialog', { name: 'Edit memory' });
    const title = within(dialog).getByRole('textbox', { name: /Title/ });
    await user.clear(title);
    await user.type(title, 'Exam weeks double demand');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(sent()).toHaveLength(2);
    });
    expect(sent()[0]?.url).toContain(`/api/v1/ventures/${IDS.venture}/memory/batch`);
    expect(sent()[0]).toMatchObject({ method: 'POST', body: { ids: [IDS.memory], action: 'approve' } });
    expect(sent()[1]?.url).toContain(`/api/v1/memory/${IDS.memory}`);
    expect(sent()[1]).toMatchObject({
      method: 'PATCH',
      body: { action: 'correct', patch: { title: 'Exam weeks double demand' } },
    });
  });

  it('saves no edit when keeping the older suggestion failed, and says why', async () => {
    fetchMock.mockImplementation((_input, init) =>
      Promise.resolve(
        init?.method === 'POST' ? problem(503, 'unavailable') : json({ items: [], nextCursor: null }),
      ),
    );
    const user = await renderDialog(proposal);
    const dialog = screen.getByRole('dialog', { name: 'Edit memory' });
    const title = within(dialog).getByRole('textbox', { name: /Title/ });
    await user.clear(title);
    await user.type(title, 'Exam weeks double demand');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Couldn’t update memory/);
    expect(sent().some((request) => request.method === 'PATCH')).toBe(false);
  });

  it('saves an edit of kept memory as a new version only', async () => {
    const kept = makeMemory({ id: IDS.memory, status: 'confirmed', title: 'Exam weeks drive demand' });
    fetchMock.mockImplementation((_input, init) =>
      Promise.resolve(
        init?.method === 'PATCH'
          ? json({ ...kept, id: IDS.memory2, title: 'Exam weeks double demand', version: 2 })
          : json({ items: [], nextCursor: null }),
      ),
    );
    const user = await renderDialog(kept);
    const dialog = screen.getByRole('dialog', { name: 'Edit memory' });
    const title = within(dialog).getByRole('textbox', { name: /Title/ });
    await user.clear(title);
    await user.type(title, 'Exam weeks double demand');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent()).toHaveLength(1);
    });
    expect(sent()[0]).toMatchObject({
      method: 'PATCH',
      body: { action: 'correct', patch: { title: 'Exam weeks double demand' } },
    });
  });
});
