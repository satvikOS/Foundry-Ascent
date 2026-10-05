import type { EscalationView, MemoryObjectView } from '@foundry/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IDS, makeMemory } from '@/features/coach/testing';
import { memoryQueryOptions } from '@/lib/api/hooks/memory';

import { ConsentForm } from './consent-form';

const escalation: EscalationView = {
  id: IDS.ref,
  ventureId: IDS.venture,
  ventureName: 'QuietQuad',
  sessionId: null,
  turnId: null,
  category: 'legal',
  priority: 'P2',
  status: 'awaiting_consent',
  requestedRole: 'eir',
  packet: {
    founderQuestion: 'Can we use the university logo?',
    desiredDecision: null,
    sharedFacts: [],
    evidenceConsidered: [],
    conflictingSignals: [],
    unknowns: [],
    reason: 'Founder request',
    urgency: 'normal',
    proposedNextStep: null,
    sessionSummary: null,
    aiGenerated: true,
  },
  sharingConsentAt: null,
  assignee: null,
  dueAt: null,
  resolution: null,
  createdBy: { id: IDS.principal, displayName: 'Maya', title: null, synthetic: true },
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
};

function renderWith(items: MemoryObjectView[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(memoryQueryOptions(IDS.venture, { status: 'confirmed' }).queryKey, {
    items,
    nextCursor: null,
  });
  render(
    <QueryClientProvider client={client}>
      <ConsentForm escalation={escalation} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

describe('ConsentForm', () => {
  it('never offers founder-only memory for sharing (finding 1: packets are read by the team and the reviewer)', () => {
    renderWith([
      makeMemory({
        id: IDS.memory,
        title: 'Exam weeks drive demand',
        status: 'confirmed',
        visibility: 'team',
      }),
      makeMemory({
        id: IDS.memory2,
        title: 'Personal runway is two months',
        status: 'confirmed',
        visibility: 'founder_private',
      }),
    ]);
    expect(screen.getByText('Exam weeks drive demand')).toBeInTheDocument();
    expect(screen.queryByText('Personal runway is two months')).not.toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });
});
