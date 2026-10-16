import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { renderWithRouter, testQueryClient } from '@/features/knowledge/test-utils';
import { IDS, makeEvidence } from '@/features/knowledge/testing';

import { EvidenceItemCard, evidenceKindLabel } from './evidence-item';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const PASSAGE = '22222222-2222-4222-8222-222222222222';
const venture = { tenant: 'ain', ventureId: IDS.venture };

/** Renders `ui` on a page of the venture; returns the router to read where a click went. */
async function renderOnPage(ui: ReactElement) {
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: '$tenant/app/v/$ventureId/c/$sessionId',
    component: () => ui,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [`/ain/app/v/${IDS.venture}/c/abc`] }),
  });
  await act(async () => {
    render(
      <QueryClientProvider client={testQueryClient()}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await router.load();
  });
  return router;
}

describe('evidenceKindLabel', () => {
  it('says where a passage comes from by its source, not by its kind alone', () => {
    const label = (item: Parameters<typeof evidenceKindLabel>[0]) =>
      evidenceKindLabel(item, "Corin's vEIR").label;
    expect(label({ kind: 'chunk', source: { id: SOURCE, scope: 'venture' } })).toBe('Venture document');
    // A program handbook passage is a chunk too: it is never called a venture document.
    expect(label({ kind: 'chunk', source: { id: SOURCE, scope: 'program' } })).toBe('Program guidance');
    expect(label({ kind: 'chunk', source: { id: SOURCE, scope: 'public' } })).toBe('Program guidance');
    expect(label({ kind: 'doctrine', source: { id: SOURCE, scope: 'persona' } })).toBe(
      "Corin's vEIR’s library",
    );
    expect(label({ kind: 'doctrine' })).toBe("Corin's vEIR’s library");
    expect(label({ kind: 'chunk', source: null })).toBe('Passage');
    expect(label({ kind: 'memory' })).toBe('Venture memory');
  });
});

describe('EvidenceItemCard', () => {
  it('opens a venture document passage in the viewer, at the cited passage, over the same page', async () => {
    const router = await renderOnPage(
      <EvidenceItemCard
        item={makeEvidence({
          key: 'E2',
          kind: 'chunk',
          refId: PASSAGE,
          title: 'exam-week-interviews.md — Findings',
          source: { id: SOURCE, scope: 'venture' },
        })}
        venture={venture}
      />,
    );
    expect(screen.getByText('Venture document')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('link', { name: 'Open document' }));
    expect(router.state.location.pathname).toBe(`/ain/app/v/${IDS.venture}/c/abc`);
    expect(router.state.location.search).toEqual({ src: SOURCE, passage: PASSAGE });
    // Opened in the app: Back (or Close) returns to the conversation.
    expect(router.state.location.state.documentViewer).toBe(true);
  });

  it('opens program material in the viewer too', async () => {
    const router = await renderOnPage(
      <EvidenceItemCard
        item={makeEvidence({
          key: 'E5',
          kind: 'chunk',
          refId: PASSAGE,
          title: 'Program handbook — Interviews',
          source: { id: SOURCE, scope: 'program' },
        })}
        venture={venture}
      />,
    );
    await userEvent.setup().click(screen.getByRole('link', { name: 'Read source' }));
    expect(router.state.location.search).toEqual({ src: SOURCE, passage: PASSAGE });
  });

  it('links a vEIR library passage (read in the studio) to its row in Evidence', async () => {
    await renderWithRouter(
      <EvidenceItemCard
        item={makeEvidence({
          key: 'E3',
          kind: 'doctrine',
          title: 'exam-week-interviews.md',
          source: { id: SOURCE, scope: 'persona' },
        })}
        veirName="Corin's vEIR"
        venture={venture}
      />,
    );
    expect(screen.getByText("Corin's vEIR’s library")).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open document' })).toBeNull();
    expect(screen.getByRole('link', { name: 'See in Evidence' })).toHaveAttribute(
      'href',
      `/ain/app/v/${IDS.venture}/knowledge?view=evidence&source=${SOURCE}`,
    );
  });

  it('links nothing for memory or a passage of unknown source', async () => {
    await renderWithRouter(
      <>
        <EvidenceItemCard item={makeEvidence({ key: 'E1' })} venture={venture} />
        <EvidenceItemCard item={makeEvidence({ key: 'E4', kind: 'chunk', source: null })} venture={venture} />
      </>,
    );
    expect(screen.queryAllByRole('link')).toEqual([]);
  });
});
