import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InspectorProvider } from '@/components/shell/inspector';
import { TooltipProvider } from '@/components/ui/tooltip';
import { jsonResponse, stubFetch } from '@/features/admin/shared/test-utils';
import { awaitingDigest, useSession } from '@/lib/api/hooks/sessions';
import { queryKeys } from '@/lib/api/query-keys';

import { IDS, makeSession } from '../coach/testing';
import { DigestView } from './digest-view';
import { PanelStateProvider } from './panel-state';

function Harness() {
  const detail = useSession(IDS.session);
  if (!detail.data) return null;
  return (
    <DigestView session={detail.data.session} personaName="Corin" canEdit memoryItems={[]} escalations={[]} />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DigestView', () => {
  it('says the summary was deleted, never that it is being written again, and stops waiting for it', async () => {
    const withDigest = makeSession({
      status: 'ended',
      endedAt: new Date(Date.now() - 10_000).toISOString(),
      digest: {
        summary: 'We planned five interviews.',
        topics: [],
        commitments: [],
        openQuestions: [],
        generatedAt: new Date().toISOString(),
      },
    });
    const without = { ...withDigest, digest: null };
    let deleted = false;
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((_input, init) => {
      if (init?.method === 'DELETE') {
        deleted = true;
        return Promise.resolve(jsonResponse(without));
      }
      return Promise.resolve(jsonResponse({ session: deleted ? without : withDigest, turns: [] }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.session.detail(IDS.session), { session: withDigest, turns: [] });
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <InspectorProvider>
            <PanelStateProvider>
              <Harness />
            </PanelStateProvider>
          </InspectorProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText('We planned five interviews.')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Delete summary' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.queryByText('We planned five interviews.')).not.toBeInTheDocument();
    });
    expect(screen.getByText('You deleted the summary. Corin won’t write it again.')).toBeInTheDocument();
    expect(screen.queryByText(/is writing a summary/)).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn’t be written/)).not.toBeInTheDocument();
    // Nothing is polled for a digest that will never come.
    expect(awaitingDigest(without)).toBe(false);
  });
});
