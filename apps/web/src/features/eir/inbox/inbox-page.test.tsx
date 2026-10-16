import type { EscalationView } from '@foundry/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/api/query-keys';

import { InboxPage } from './inbox-page';

const PERSON = {
  id: '00000000-0000-4000-8000-000000000009',
  displayName: 'Maya Example',
  title: null,
  synthetic: true,
};

function escalation(id: string, ventureName: string, priority: EscalationView['priority']): EscalationView {
  return {
    id,
    ventureId: '00000000-0000-4000-8000-000000000002',
    ventureName,
    sessionId: null,
    turnId: null,
    category: 'ip_licensing',
    priority,
    status: 'routed',
    requestedRole: 'eir',
    packet: null,
    sharingConsentAt: '2026-10-01T12:00:00.000Z',
    assignee: null,
    dueAt: null,
    resolution: null,
    createdBy: PERSON,
    createdAt: '2026-10-01T11:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
  };
}

const ITEMS = [
  escalation('00000000-0000-4000-8000-000000000011', 'QuietQuad', 'P1'),
  escalation('00000000-0000-4000-8000-000000000012', 'EmberLoop', 'P2'),
];

function Harness() {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  return (
    <InboxPage
      selectedId={selectedId}
      filter="open"
      onSelect={setSelectedId}
      onFilterChange={() => undefined}
    />
  );
}

function renderInbox() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  client.setQueryData(queryKeys.inbox.escalations(), { items: ITEMS });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <Harness />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('InboxPage (EIR studio → Escalation inbox)', () => {
  it('marks the open escalation with the selection cue, not with a fill alone', async () => {
    renderInbox();
    const list = screen.getByRole('navigation', { name: 'Open escalations' });
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(2);
    const [first, second] = rows as [HTMLElement, HTMLElement];
    // The most urgent request opens first.
    expect(first).toHaveTextContent('QuietQuad');
    expect(first).toHaveAttribute('aria-current', 'true');
    expect(first).toHaveAttribute('data-selected');
    expect(first).toHaveClass('before:bg-selected-cue');
    expect(second).not.toHaveAttribute('data-selected');
    expect(second).toHaveClass('hover:bg-accent/50');

    await userEvent.click(second);
    expect(second).toHaveAttribute('aria-current', 'true');
    expect(second).toHaveClass('before:bg-selected-cue');
    expect(first).not.toHaveAttribute('aria-current');
    expect(first).not.toHaveClass('before:bg-selected-cue');
  });
});
