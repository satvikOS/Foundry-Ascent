import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  bodyOf,
  json,
  renderWithRouter,
  stubFetch,
  testQueryClient,
  urlOf,
} from '@/features/knowledge/test-utils';
import { IDS, makeMemory } from '@/features/knowledge/testing';

import { TypedMemoryDialog } from './typed-memory-dialog';

let fetchMock: ReturnType<typeof stubFetch>;

beforeEach(() => {
  fetchMock = stubFetch();
});

function sent() {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST' || init?.method === 'PATCH')
    .map(([input, init]) => ({ url: urlOf(input), method: init?.method, body: bodyOf(init) }));
}

const decision = (status: 'proposed' | 'confirmed') =>
  makeMemory({
    id: IDS.memory,
    type: 'decision',
    status,
    origin: 'ai',
    title: 'Charge libraries, not students',
    attributes: { decided_on: '2026-10-06' },
  });

async function editTitle(status: 'proposed' | 'confirmed') {
  fetchMock.mockImplementation((_input, init) => {
    if (init?.method === 'POST') {
      return Promise.resolve(json({ items: [decision('confirmed')], skippedIds: [] }));
    }
    if (init?.method === 'PATCH') {
      return Promise.resolve(
        json({
          ...decision('confirmed'),
          id: IDS.memory2,
          title: 'Charge libraries per building',
          version: 2,
        }),
      );
    }
    return Promise.resolve(json({ items: [], nextCursor: null }));
  });
  await renderWithRouter(
    <TypedMemoryDialog
      ventureId={IDS.venture}
      kind="decision"
      open
      onOpenChange={() => undefined}
      memory={decision(status)}
    />,
    testQueryClient(),
  );
  const dialog = await screen.findByRole('dialog', { name: 'Edit decision' });
  const title = within(dialog).getByRole('textbox', { name: /Title|Decision/ });
  const user = userEvent.setup();
  await user.clear(title);
  await user.type(title, 'Charge libraries per building');
  await user.click(within(dialog).getByRole('button', { name: /^Save/ }));
}

describe('TypedMemoryDialog', () => {
  it('keeps an older suggestion first, then saves the edit as a new version', async () => {
    await editTitle('proposed');
    await waitFor(() => {
      expect(sent()).toHaveLength(2);
    });
    expect(sent()[0]?.url).toContain(`/api/v1/ventures/${IDS.venture}/memory/batch`);
    expect(sent()[0]).toMatchObject({ method: 'POST', body: { ids: [IDS.memory], action: 'approve' } });
    expect(sent()[1]?.url).toContain(`/api/v1/memory/${IDS.memory}`);
    expect(sent()[1]).toMatchObject({ method: 'PATCH', body: { action: 'correct' } });
  });

  it('saves an edit of kept memory as a new version only', async () => {
    await editTitle('confirmed');
    await waitFor(() => {
      expect(sent()).toHaveLength(1);
    });
    expect(sent()[0]).toMatchObject({ method: 'PATCH', body: { action: 'correct' } });
  });
});
