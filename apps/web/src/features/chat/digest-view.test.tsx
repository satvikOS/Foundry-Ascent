import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InspectorProvider } from '@/components/shell/inspector';
import { TooltipProvider } from '@/components/ui/tooltip';
import { jsonResponse, stubFetch } from '@/features/admin/shared/test-utils';
import { awaitingDigest, useSession } from '@/lib/api/hooks/sessions';
import { queryKeys } from '@/lib/api/query-keys';

import { renderWithRouter } from '@/features/knowledge/test-utils';

import { IDS, makeMemory, makeSession } from '../coach/testing';
import { DigestView } from './digest-view';
import { PanelStateProvider } from './panel-state';

function Harness() {
  const detail = useSession(IDS.session);
  if (!detail.data) return null;
  return (
    <DigestView
      session={detail.data.session}
      personaName="Corin"
      tenant="ain"
      canEdit
      memoryItems={[]}
      escalations={[]}
    />
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
    expect(screen.getByText('Summary deleted. It won’t be rewritten.')).toBeInTheDocument();
    expect(screen.queryByText(/is writing a summary/)).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn’t be written/)).not.toBeInTheDocument();
    // Nothing is polled for a digest that will never come.
    expect(awaitingDigest(without)).toBe(false);
  });

  it('says so after a reload too: the server reports the deleted digest', async () => {
    const deleted = makeSession({
      id: IDS.ref,
      status: 'ended',
      endedAt: new Date(Date.now() - 10_000).toISOString(),
      digest: null,
      digestDeleted: true,
    });
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ session: deleted, turns: [] }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.session.detail(IDS.ref), { session: deleted, turns: [] });
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <InspectorProvider>
            <PanelStateProvider>
              <DigestView
                session={deleted}
                personaName="Corin"
                tenant="ain"
                canEdit
                memoryItems={[]}
                escalations={[]}
              />
            </PanelStateProvider>
          </InspectorProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Summary deleted. It won’t be rewritten.')).toBeInTheDocument();
    expect(screen.queryByText(/is writing a summary/)).not.toBeInTheDocument();
    expect(awaitingDigest(deleted)).toBe(false);
  });

  it('says quietly what the conversation saved to Knowledge, with nothing to review', async () => {
    stubFetch().mockResolvedValue(jsonResponse({ items: [] }));
    const ended = makeSession({
      status: 'ended',
      endedAt: new Date(Date.now() - 10_000).toISOString(),
      digestDeleted: true,
      recap: {
        diagnosis: { stage: 'Discovery', immediate_constraint: 'Access', riskiest_assumption: 'Repeat use' },
        evidence: [],
        challenge: '',
        next_actions: [],
        escalation: { required: false, reason: null, category: null, priority: null, requested_role: null },
        memory_candidate_ids: [IDS.memory, IDS.memory2],
        generated_at: new Date().toISOString(),
      },
    });
    await renderWithRouter(
      <DigestView
        session={ended}
        personaName="Corin"
        tenant="ain"
        canEdit
        memoryItems={[
          makeMemory({ status: 'confirmed' }),
          makeMemory({ id: IDS.memory2, title: 'Forgotten one', status: 'deleted' }),
        ]}
        escalations={[]}
      />,
    );
    // Only what is still in Knowledge is named; there is no review button anywhere.
    expect(screen.getByTestId('memory-saved')).toHaveTextContent(
      'Saved to Knowledge: Exam weeks drive demand',
    );
    expect(screen.queryByRole('button', { name: /to remember|Review/ })).toBeNull();
  });

  it('ends a private chat saying nothing was kept', async () => {
    stubFetch().mockResolvedValue(jsonResponse({ items: [] }));
    const ended = makeSession({ status: 'ended', privacy: 'ephemeral', endedAt: new Date().toISOString() });
    await renderWithRouter(
      <DigestView
        session={ended}
        personaName="Corin"
        tenant="ain"
        canEdit
        memoryItems={[]}
        escalations={[]}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Private chat ended' })).toBeInTheDocument();
    expect(screen.getByText('Nothing from it was kept.')).toBeInTheDocument();
  });
});
