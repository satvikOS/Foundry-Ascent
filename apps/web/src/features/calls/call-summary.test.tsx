import type { CallSummary, EscalationView, MemoryObjectView } from '@foundry/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CallEnded } from '@/lib/realtime/call-engine';
import { IDS } from '@/lib/realtime/testing';

import { CallSummaryPanel } from './call-summary';
import { json, renderWithRouter, stubFetch, urlOf } from './testing';
import type { CallVeir } from './use-call-veir';

const VEIR: CallVeir = {
  name: "Corin's vEIR",
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
    blocked: null,
    ...overrides,
  };
}

function renderSummary(
  value: CallEnded,
  canWrite = true,
  privacy: 'standard' | 'ephemeral' | null = 'standard',
) {
  const callbacks = { back: vi.fn(), again: vi.fn(), leave: vi.fn() };
  renderWithRouter(
    <CallSummaryPanel
      tenant="ain"
      ventureId={IDS.venture}
      veir={VEIR}
      ended={value}
      canWrite={canWrite}
      privacy={privacy}
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
  it('shows the call and says quietly what was saved to Knowledge, with nothing to keep or decline', async () => {
    const fetchMock = stubFetch();
    const second = memory({ id: IDS.turn, title: 'Pilot with one library', status: 'confirmed' });
    fetchMock.mockImplementation((input) => {
      const url = urlOf(input);
      if (url.endsWith(`/memory/${IDS.memory}`))
        return Promise.resolve(json(memory({ status: 'confirmed' })));
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
    // The summary carries the vEIR's actions, so it carries the AI disclosure too.
    expect(screen.getAllByRole('note', { name: 'AI disclosure' })).toHaveLength(1);
    expect(screen.getByText(/4 minutes 12 seconds/)).toBeInTheDocument();
    expect(screen.getByText(/3 exchanges/)).toBeInTheDocument();
    // A quiet "Remembered" and what the call saved: no Keep, no Not now, nothing waiting for the founder.
    expect(screen.getByTestId('call-remembered')).toBeInTheDocument();
    const saved = await screen.findByTestId('memory-saved');
    expect(saved).toHaveTextContent('Saved to Knowledge: 2 items');
    expect(within(saved).getByRole('link', { name: '2 items' })).toHaveAttribute(
      'href',
      `/ain/app/v/${IDS.venture}/knowledge`,
    );
    expect(screen.queryByText(/would like to remember/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Keep/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Not now/ })).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST' || init?.method === 'PATCH')).toBe(
      false,
    );
    expect(screen.getByText('Interview two more librarians')).toBeInTheDocument();
    expect(await screen.findByText('Legal')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute(
      'href',
      `/ain/app/v/${IDS.venture}/help`,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Back to conversation' }));
    expect(callbacks.back).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Call again' }));
    expect(callbacks.again).toHaveBeenCalled();
  });

  it('links the one thing a call saved straight to it in Knowledge', async () => {
    stubFetch().mockImplementation((input) =>
      Promise.resolve(urlOf(input).includes('/memory/') ? json(memory()) : json({ items: [] })),
    );
    renderSummary(ended({ memoryProposalIds: [IDS.memory] }));
    const link = await screen.findByRole('link', { name: 'Noise is the top complaint' });
    expect(link).toHaveAttribute('href', `/ain/app/v/${IDS.venture}/knowledge?m=${IDS.memory}`);
  });

  it('never claims something was saved that was forgotten or replaced since', async () => {
    const statuses: Record<string, MemoryObjectView['status']> = {
      [IDS.memory]: 'deleted',
      [IDS.turn]: 'rejected',
      [IDS.session]: 'superseded',
    };
    stubFetch().mockImplementation((input) => {
      const id = Object.keys(statuses).find((key) => urlOf(input).endsWith(`/memory/${key}`));
      return Promise.resolve(
        id
          ? json(memory({ id, title: `Item ${id.slice(0, 4)}`, status: statuses[id] }))
          : json({ items: [] }),
      );
    });
    renderSummary(ended({ memoryProposalIds: Object.keys(statuses) }));
    expect(await screen.findByRole('heading', { name: 'Call ended' })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('memory-saved')).toBeNull();
  });

  it('says a private call keeps nothing, and asks the server for none of its memory', async () => {
    const fetchMock = stubFetch().mockResolvedValue(json({ items: [] }));
    renderSummary(ended({ memoryProposalIds: [IDS.memory] }), true, 'ephemeral');
    expect(await screen.findByTestId('call-private')).toHaveTextContent('Private: nothing is remembered.');
    expect(screen.queryByTestId('call-remembered')).toBeNull();
    expect(screen.queryByTestId('memory-saved')).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => urlOf(input).includes('/memory/'))).toBe(false);
  });

  it('keeps the crisis support of a call that ended while it was shown, above the summary', async () => {
    stubFetch().mockResolvedValue(json({ items: [] }));
    const callbacks = renderSummary(
      ended(
        {},
        {
          reason: 'timeout',
          blocked: {
            reason: 'crisis_support',
            escalationId: IDS.escalation,
            supportMessage: 'Call or text **988** any time.',
          },
        },
      ),
    );
    const support = await screen.findByTestId('blocked-panel');
    expect(support).toHaveTextContent('You deserve support from a person');
    expect(support).toHaveTextContent('Call or text 988 any time.');
    expect(within(support).getByRole('link', { name: 'View your request' })).toHaveAttribute(
      'href',
      `/ain/app/v/${IDS.venture}/help?id=${IDS.escalation}`,
    );
    // First on the page and where focus lands, before the summary of the call.
    const heading = screen.getByRole('heading', { name: 'Call ended' });
    expect(support.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Support' })).toHaveFocus();
    expect(screen.getByText('The call reached its time limit.')).toBeInTheDocument();
    // It stays until the founder leaves it.
    await userEvent.click(within(support).getByRole('link', { name: 'View your request' }));
    expect(callbacks.leave).toHaveBeenCalled();
  });

  it('says nothing about memory under crisis support: what was said then is never remembered', async () => {
    const fetchMock = stubFetch().mockImplementation((input) =>
      Promise.resolve(urlOf(input).includes('/memory/') ? json(memory()) : json({ items: [] })),
    );
    renderSummary(
      ended(
        { memoryProposalIds: [IDS.memory] },
        {
          blocked: {
            reason: 'crisis_support',
            escalationId: null,
            supportMessage: 'Call or text **988** any time.',
          },
        },
      ),
    );
    expect(await screen.findByTestId('blocked-panel')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('call-remembered')).toBeNull();
    expect(screen.queryByTestId('memory-saved')).toBeNull();
    expect(screen.queryByText(/Remembered|pick up from this call/)).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => urlOf(input).includes('/memory/'))).toBe(false);
  });

  it('links what the vEIR kept by itself, and following the link leaves the call behind', async () => {
    stubFetch().mockImplementation((input) =>
      Promise.resolve(
        urlOf(input).includes('/memory/')
          ? json(memory({ status: 'confirmed', title: 'Per-library pricing' }))
          : json({ items: [] }),
      ),
    );
    const callbacks = renderSummary(ended({ memoryKeptIds: [IDS.memory], memoryProposalIds: [] }));
    const link = await screen.findByRole('link', { name: 'Per-library pricing' });
    expect(link).toHaveAttribute('href', `/ain/app/v/${IDS.venture}/knowledge?m=${IDS.memory}`);
    expect(callbacks.leave).not.toHaveBeenCalled();
    // Off to Knowledge: the ended call is forgotten, so no "Call ended" bar follows the founder there.
    await userEvent.click(link);
    expect(callbacks.leave).toHaveBeenCalledTimes(1);
  });

  it('says quietly that the call is remembered, even before anything is saved to Knowledge', async () => {
    stubFetch().mockResolvedValue(json({ items: [] }));
    renderSummary(ended({}));
    expect(await screen.findByTestId('call-remembered')).toHaveTextContent('Remembered for next time.');
    expect(screen.queryByTestId('memory-saved')).toBeNull();
    expect(screen.queryByText(/to review/)).toBeNull();
  });

  it('claims nothing remembered for a call where nothing was said', async () => {
    stubFetch().mockResolvedValue(json({ items: [] }));
    renderSummary(ended({ turnCount: 0 }, { turnCount: 0 }));
    expect(await screen.findByRole('heading', { name: 'Call ended' })).toBeInTheDocument();
    expect(screen.getByText(/Nothing was said\./)).toBeInTheDocument();
    expect(screen.queryByTestId('call-remembered')).toBeNull();
  });

  it('keeps the call over when its summary could not load', async () => {
    stubFetch();
    renderSummary(ended(null, { summaryError: 'Can’t reach Foundry Ascent.', reason: 'timeout' }));
    expect(await screen.findByText(/The summary couldn’t load/)).toBeInTheDocument();
    expect(screen.getByText('The call reached its time limit.')).toBeInTheDocument();
  });

  it('says calmly why the budget ended the call: today’s AI allowance, which pauses typed chat too', async () => {
    stubFetch().mockImplementation((input) =>
      Promise.resolve(
        urlOf(input).endsWith('/call-config')
          ? json(callConfig({ remainingMinutesToday: 24 }))
          : json({ items: [] }),
      ),
    );
    renderSummary(ended(null, { reason: 'budget' }));
    const line = await screen.findByText(/AI allowance is used up/);
    expect(line).toHaveTextContent('Chat pauses too until midnight UTC');
    expect(line).toHaveTextContent('Your conversation is saved.');
    expect(screen.queryByText(/went wrong|error/i)).toBeNull();
  });

  it('says when the budget that ended the call was today’s call minutes', async () => {
    stubFetch().mockImplementation((input) =>
      Promise.resolve(
        urlOf(input).endsWith('/call-config')
          ? json(callConfig({ remainingMinutesToday: 0 }))
          : json({ items: [] }),
      ),
    );
    renderSummary(ended(null, { reason: 'budget' }));
    expect(
      await screen.findByText('Today’s call minutes are used up. Chat still works.'),
    ).toBeInTheDocument();
  });

  it('shows no saved line to someone who cannot open the venture’s memory', async () => {
    const fetchMock = stubFetch().mockImplementation((input) =>
      Promise.resolve(urlOf(input).includes('/memory/') ? json(memory()) : json({ items: [] })),
    );
    renderSummary(ended({ memoryProposalIds: [IDS.memory] }), false);
    expect(await screen.findByRole('heading', { name: 'Call ended' })).toBeInTheDocument();
    expect(screen.queryByTestId('memory-saved')).toBeNull();
    expect(screen.queryByTestId('call-remembered')).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => urlOf(input).includes('/memory/'))).toBe(false);
    expect(screen.getByRole('button', { name: 'Call again' })).toBeDisabled();
  });
});

function callConfig(overrides: { remainingMinutesToday: number }) {
  return {
    veir: {
      personaId: IDS.persona,
      name: "Corin's vEIR",
      shortName: 'Corin',
      kind: 'eir_persona',
      eirDisplayName: 'Corin Halvorsen',
      tagline: null,
      disclosure: 'AI',
      embodiment: {
        provider: 'builtin',
        voiceId: null,
        portraitUrl: null,
        voiceConsented: false,
        likenessConsented: false,
      },
    },
    provider: 'builtin',
    maxMinutes: 20,
    remainingMinutesToday: overrides.remainingMinutesToday,
    aiEnabled: true,
    callsEnabled: true,
  };
}
