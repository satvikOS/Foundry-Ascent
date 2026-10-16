import type { CallSummary, EscalationView, MemoryObjectView } from '@foundry/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CallEnded } from '@/lib/realtime/call-engine';
import { IDS } from '@/lib/realtime/testing';

import { CallSummaryPanel } from './call-summary';
import { json, renderWithRouter, sentJson, stubFetch, urlOf } from './testing';
import type { CallVeir } from './use-call-veir';

const VEIR: CallVeir = {
  name: "Corin's vEIR",
  shortName: 'Corin',
  kind: 'eir_persona',
  disclosure: 'AI',
  portraitUrl: null,
  provider: 'builtin',
};
const NOW = '2026-10-01T12:00:00.000Z';
const PERSON = { id: IDS.persona, displayName: 'Maya Example', title: null, synthetic: true };

function memory(overrides: Partial<MemoryObjectView> = {}): MemoryObjectView {
  return {
    id: IDS.memory,
    ventureId: IDS.venture,
    type: 'insight',
    title: 'Noise is the top complaint',
    content: 'Two librarians named noise first.',
    contentLength: 'Two librarians named noise first.'.length,
    attributes: {},
    status: 'proposed',
    visibility: 'venture',
    confidence: 0.6,
    sourceRefs: [],
    origin: 'ai',
    createdBy: PERSON,
    approvedBy: null,
    approvedAt: null,
    version: 1,
    supersedesId: null,
    pinned: false,
    expiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const escalation: EscalationView = {
  id: IDS.escalation,
  ventureId: IDS.venture,
  ventureName: 'QuietQuad',
  sessionId: IDS.session,
  turnId: null,
  category: 'legal',
  priority: 'P2',
  status: 'awaiting_consent',
  requestedRole: 'eir',
  packet: null,
  sharingConsentAt: null,
  assignee: null,
  dueAt: null,
  resolution: null,
  createdBy: PERSON,
  createdAt: NOW,
  updatedAt: NOW,
};

function ended(summary: Partial<CallSummary> | null, overrides: Partial<CallEnded> = {}): CallEnded {
  return {
    reason: 'user',
    durationSeconds: 252,
    turnCount: 3,
    summary:
      summary === null
        ? null
        : {
            turnCount: 3,
            durationSeconds: 252,
            memoryProposalIds: [],
            nextActions: [],
            escalationIds: [],
            ...summary,
          },
    summaryError: null,
    ...overrides,
  };
}

function renderSummary(value: CallEnded, canWrite = true) {
  const callbacks = { back: vi.fn(), again: vi.fn(), leave: vi.fn() };
  renderWithRouter(
    <CallSummaryPanel
      tenant="ain"
      ventureId={IDS.venture}
      veir={VEIR}
      ended={value}
      canWrite={canWrite}
      onBackToConversation={callbacks.back}
      onCallAgain={callbacks.again}
      onLeave={callbacks.leave}
    />,
  );
  return callbacks;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CallSummaryPanel', () => {
  it('shows the call, asks before keeping anything and records Keep / Not now', async () => {
    const fetchMock = stubFetch();
    const second = memory({ id: IDS.turn, title: 'Pilot with one library' });
    fetchMock.mockImplementation((input, init) => {
      const url = urlOf(input);
      if (url.endsWith(`/memory/${IDS.memory}`) && init?.method === 'PATCH') {
        return Promise.resolve(json(memory({ status: 'confirmed' })));
      }
      if (url.endsWith(`/memory/${IDS.turn}`) && init?.method === 'PATCH') {
        return Promise.resolve(json({ ...second, status: 'rejected' }));
      }
      if (url.endsWith(`/memory/${IDS.memory}`)) return Promise.resolve(json(memory()));
      if (url.endsWith(`/memory/${IDS.turn}`)) return Promise.resolve(json(second));
      if (url.endsWith('/escalations')) return Promise.resolve(json({ items: [escalation] }));
      return Promise.resolve(json({}, 404));
    });
    const callbacks = renderSummary(
      ended({
        memoryProposalIds: [IDS.memory, IDS.turn],
        nextActions: [{ owner: 'Maya', action: 'Interview two more librarians', target_date: null }],
        escalationIds: [IDS.escalation],
      }),
    );

    expect(await screen.findByRole('heading', { name: 'Call ended' })).toHaveFocus();
    expect(screen.getByText(/4 minutes 12 seconds/)).toBeInTheDocument();
    expect(screen.getByText(/3 exchanges/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Corin would like to remember' })).toBeInTheDocument();
    expect(await screen.findByText('Noise is the top complaint')).toBeInTheDocument();
    expect(screen.getByText('Interview two more librarians')).toBeInTheDocument();
    expect(await screen.findByText('Legal')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute(
      'href',
      `/ain/app/v/${IDS.venture}/help`,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Keep: Noise is the top complaint' }));
    await waitFor(() => {
      expect(screen.getByText('Kept')).toBeInTheDocument();
    });
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(sentJson(patch?.[1])).toEqual({ action: 'approve' });

    await userEvent.click(await screen.findByRole('button', { name: 'Not now: Pilot with one library' }));
    await waitFor(() => {
      expect(screen.getByText('Not kept')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Back to conversation' }));
    expect(callbacks.back).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Call again' }));
    expect(callbacks.again).toHaveBeenCalled();
  });

  it('says when there is nothing to review', async () => {
    stubFetch().mockResolvedValue(json({ items: [] }));
    renderSummary(ended({}));
    expect(await screen.findByText('Nothing new to review from this call.')).toBeInTheDocument();
  });

  it('keeps the call over when its summary could not load', async () => {
    stubFetch();
    renderSummary(ended(null, { summaryError: 'Can’t reach Foundry Ascent.', reason: 'timeout' }));
    expect(await screen.findByText(/The summary couldn’t load/)).toBeInTheDocument();
    expect(screen.getByText('The call reached its time limit.')).toBeInTheDocument();
  });

  it('shows proposals without Keep / Not now to someone who cannot decide', async () => {
    stubFetch().mockImplementation((input) =>
      Promise.resolve(urlOf(input).includes('/memory/') ? json(memory()) : json({ items: [] })),
    );
    renderSummary(ended({ memoryProposalIds: [IDS.memory] }), false);
    expect(await screen.findByText('Noise is the top complaint')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Keep/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Call again' })).toBeDisabled();
  });
});
