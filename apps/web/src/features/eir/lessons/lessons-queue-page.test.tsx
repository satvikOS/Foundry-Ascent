import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { jsonResponse, renderWithProviders, stubFetch } from '@/features/admin/shared/test-utils';
import { GUIDE, IDS, lesson, persona, RUTH } from '@/features/eir/personas/test-fixtures';

import { LessonsQueuePage } from './lessons-queue-page';

function renderPage() {
  const rootRoute = createRootRoute({ component: () => <LessonsQueuePage tenant="ain" /> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  renderWithProviders(<RouterProvider router={router} />);
}

describe('LessonsQueuePage (EIR studio → Lessons to review)', () => {
  it('lists drafts of the vEIRs the person curates, linking each to its review', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((input) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === '/api/v1/personas') {
        return Promise.resolve(jsonResponse({ items: [GUIDE, persona(), { ...RUTH, canCurate: false }] }));
      }
      if (url === `/api/v1/personas/${IDS.corin}/lessons`) {
        return Promise.resolve(
          jsonResponse({
            items: [
              lesson(),
              lesson({
                id: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
                title: 'Already live',
                status: 'published',
              }),
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse({ items: [] }));
    });
    renderPage();

    const group = await screen.findByRole('region', { name: /Corin's vEIR/ });
    const link = within(group).getByRole('link', { name: 'Polite interest is not demand' });
    expect(link).toHaveAttribute(
      'href',
      `/ain/app/eir/personas/${IDS.corin}?tab=lessons&lesson=${IDS.lesson}`,
    );
    expect(within(group).getByText('Distilled')).toBeVisible();
    expect(screen.queryByText('Already live')).toBeNull();
    expect(screen.getByText('1 lesson waiting for you.')).toBeVisible();
    // Lessons of a vEIR the person doesn't curate are never requested.
    const urls = fetchMock.mock.calls.map(([input]) =>
      input instanceof Request ? input.url : input.toString(),
    );
    expect(urls).not.toContain(`/api/v1/personas/${IDS.ruth}/lessons`);
  });

  it('says so when nothing waits', async () => {
    stubFetch().mockImplementation((input) => {
      const url = input instanceof Request ? input.url : input.toString();
      return Promise.resolve(jsonResponse({ items: url === '/api/v1/personas' ? [persona()] : [] }));
    });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Nothing to review' })).toBeVisible();
  });
});
