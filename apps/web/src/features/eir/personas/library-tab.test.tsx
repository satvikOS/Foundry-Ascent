import type { PersonaKnowledgeSourceView } from '@foundry/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { jsonResponse, renderWithProviders, sentJson, stubFetch } from '@/features/admin/shared/test-utils';

import { LibraryTab } from './library-tab';
import { IDS, persona } from './test-fixtures';

function source(overrides: Partial<PersonaKnowledgeSourceView>): PersonaKnowledgeSourceView {
  return {
    id: '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d',
    personaId: IDS.corin,
    kind: 'note',
    title: 'Running a last-time interview',
    summary: 'A 25-minute script anchored on a recent episode.',
    body: 'Ask about the last time it happened, then what it cost.',
    status: 'active',
    failureReason: null,
    chunkCount: 3,
    createdBy: null,
    createdAt: '2026-10-16T09:00:00.000Z',
    updatedAt: '2026-10-16T09:00:00.000Z',
    ...overrides,
  };
}

const FAILED = source({
  id: '1b2c3d4e-5f6a-4b7c-8d8e-9f0a1b2c3d4e',
  kind: 'document',
  title: 'pricing-notes.pdf',
  summary: null,
  body: null,
  status: 'failed',
  failureReason: 'empty_text',
  chunkCount: 0,
});

describe('LibraryTab (common pool)', () => {
  it('lists sources with their state, and filters by kind', async () => {
    stubFetch().mockResolvedValue(jsonResponse({ items: [source({}), FAILED] }));
    const user = userEvent.setup();
    renderWithProviders(<LibraryTab persona={persona()} displayName="Corin’s vEIR" />);
    const list = await screen.findByRole('list', { name: 'Library sources' });
    expect(within(list).getByText('Running a last-time interview')).toBeVisible();
    expect(within(list).getByText('This file contains no readable text.')).toBeVisible();
    expect(within(list).getByText('Failed')).toBeVisible();

    await user.click(screen.getByRole('button', { name: /^Documents/ }));
    expect(within(list).queryByText('Running a last-time interview')).toBeNull();
    expect(screen.getByRole('button', { name: /^Documents/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('writes a note into the library', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((_url, init) =>
      Promise.resolve(
        init?.method === 'POST'
          ? jsonResponse(source({ title: 'Price from the workaround' }), 201)
          : jsonResponse({ items: [source({})] }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<LibraryTab persona={persona()} displayName="Corin’s vEIR" />);
    await user.click(await screen.findByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('menuitem', { name: 'Note' }));
    const form = screen.getByRole('form', { name: 'New note' });
    await user.type(within(form).getByRole('textbox', { name: /Title/ }), 'Price from the workaround');
    await user.type(within(form).getByRole('textbox', { name: /Text/ }), 'Too short');
    await user.click(within(form).getByRole('button', { name: 'Add to library' }));
    expect(await within(form).findByText('Write at least 20 characters.')).toBeVisible();

    await user.type(
      within(form).getByRole('textbox', { name: /Text/ }),
      ': anchor on what the current workaround costs.',
    );
    await user.click(within(form).getByRole('button', { name: 'Add to library' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
    });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe(`/api/v1/personas/${IDS.corin}/knowledge`);
    expect(sentJson(post?.[1])).toEqual({
      kind: 'note',
      title: 'Price from the workaround',
      body: 'Too short: anchor on what the current workaround costs.',
    });
  });

  it('retries a failed upload and offers no editing to people who don’t curate', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((_url, init) =>
      Promise.resolve(
        init?.method === 'POST'
          ? jsonResponse({ ...FAILED, status: 'processing', failureReason: null }, 202)
          : jsonResponse({ items: [FAILED] }),
      ),
    );
    const user = userEvent.setup();
    const first = renderWithProviders(<LibraryTab persona={persona()} displayName="Corin’s vEIR" />);
    await user.click(await screen.findByRole('button', { name: 'Actions for pricing-notes.pdf' }));
    await user.click(screen.getByRole('menuitem', { name: 'Retry processing' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
    });
    expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[0]).toBe(
      `/api/v1/personas/${IDS.corin}/knowledge/${FAILED.id}/complete`,
    );
    first.unmount();

    renderWithProviders(<LibraryTab persona={persona({ canCurate: false })} displayName="Corin’s vEIR" />);
    expect(await screen.findByText('pricing-notes.pdf')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
  });
});
