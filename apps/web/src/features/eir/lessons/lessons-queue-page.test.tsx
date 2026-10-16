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

const urlOf = (input: RequestInfo | URL) => (input instanceof Request ? input.url : input.toString());
const RUTH_DRAFT = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';

describe('LessonsQueuePage (EIR studio → Lessons to review)', () => {
  it('fetches the drafts of every curated vEIR in one request and groups them by vEIR', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((input) => {
      const url = urlOf(input);
      if (url === '/api/v1/personas') {
        return Promise.resolve(jsonResponse({ items: [GUIDE, persona(), RUTH] }));
      }
      if (url.startsWith('/api/v1/lessons?')) {
        return Promise.resolve(
          jsonResponse({
            items: [
              lesson(),
              lesson({ id: RUTH_DRAFT, personaId: IDS.ruth, title: 'Price the pilot', origin: 'authored' }),
            ],
            total: 2,
          }),
        );
      }
      return Promise.resolve(jsonResponse({ items: [] }));
    });
    renderPage();

    const corin = await screen.findByRole('region', { name: /Corin's vEIR/ });
    const link = within(corin).getByRole('link', { name: 'Polite interest is not demand' });
    expect(link).toHaveAttribute(
      'href',
      `/ain/app/eir/personas/${IDS.corin}?tab=lessons&lesson=${IDS.lesson}`,
    );
    expect(within(corin).getByText('Distilled')).toBeVisible();
    const ruth = screen.getByRole('region', { name: /Ruth's vEIR/ });
    expect(within(ruth).getByRole('link', { name: 'Price the pilot' })).toBeVisible();
    expect(screen.getByText('2 lessons waiting for you.')).toBeVisible();

    // One request for the personas and one for the lessons, however many vEIRs: never one per vEIR.
    const urls = fetchMock.mock.calls.map(([input]) => urlOf(input));
    expect(urls.filter((url) => url.includes('/lessons'))).toEqual([
      '/api/v1/lessons?status=draft%2Cin_review',
    ]);
    expect(urls.some((url) => /\/personas\/[^/]+\/lessons/.test(url))).toBe(false);
  });

  it('says how many wait when more are waiting than are listed', async () => {
    stubFetch().mockImplementation((input) => {
      const url = urlOf(input);
      if (url === '/api/v1/personas') return Promise.resolve(jsonResponse({ items: [persona()] }));
      return Promise.resolve(jsonResponse({ items: [lesson()], total: 140 }));
    });
    renderPage();
    expect(
      await screen.findByText('140 lessons waiting for you. The 1 most recent are shown.'),
    ).toBeVisible();
  });

  it('says so when nothing waits', async () => {
    stubFetch().mockImplementation((input) => {
      const url = urlOf(input);
      return Promise.resolve(
        jsonResponse(url === '/api/v1/personas' ? { items: [persona()] } : { items: [], total: 0 }),
      );
    });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Nothing to review' })).toBeVisible();
  });

  it('says so when the person curates no vEIR', async () => {
    stubFetch().mockImplementation((input) => {
      const url = urlOf(input);
      return Promise.resolve(
        jsonResponse(
          url === '/api/v1/personas' ? { items: [{ ...RUTH, canCurate: false }] } : { items: [], total: 0 },
        ),
      );
    });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'No vEIRs to curate' })).toBeVisible();
  });
});
