import type { PersonaView } from '@foundry/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderWithProviders, sentJson, stubFetch } from '@/features/admin/shared/test-utils';

import { personaTabs } from './persona-tabs';
import { TestBenchTab } from './test-bench-tab';
import { benchResult, IDS, persona, RELEASE } from './test-fixtures';

const DRAFT_ID = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b';
const NAME = 'Corin’s vEIR';
const DRAFT = {
  ...RELEASE,
  id: DRAFT_ID,
  version: 2,
  status: 'draft' as const,
  approvedAt: null,
  approvedBy: null,
};

function withDraft(overrides: Partial<PersonaView> = {}): PersonaView {
  return persona({
    releases: [
      {
        id: IDS.release,
        version: 1,
        status: 'approved',
        approvedAt: RELEASE.approvedAt,
        createdAt: RELEASE.createdAt,
      },
      { id: DRAFT_ID, version: 2, status: 'draft', approvedAt: null, createdAt: RELEASE.createdAt },
    ],
    ...overrides,
  });
}

function problem(status: number, code: string, reason: string): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title: 'Refused', status, code, reason }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

type Reply = Response | ((body: unknown) => Response);

/** The API: release details, and the bench's answers in order. */
function api(replies: Reply[]) {
  const fetchMock = stubFetch();
  const sent: unknown[] = [];
  fetchMock.mockImplementation((input, init) => {
    const href = input instanceof Request ? input.url : input.toString();
    if (href.includes('/test-turns')) {
      const body = sentJson(init);
      sent.push(body);
      const reply = replies.shift();
      if (reply === undefined) return Promise.reject(new Error('no reply queued'));
      return Promise.resolve(typeof reply === 'function' ? reply(body) : reply);
    }
    if (href.includes(`/persona-releases/${DRAFT_ID}`)) return Promise.resolve(jsonResponse(DRAFT));
    if (href.includes('/persona-releases/')) return Promise.resolve(jsonResponse(RELEASE));
    return Promise.reject(new Error(`unexpected request ${href}`));
  });
  return { fetchMock, sent };
}

async function ask(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByRole('textbox', { name: `Message ${NAME}` }), text);
  await user.click(screen.getByRole('button', { name: 'Send message' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TestBenchTab', () => {
  it('talks to the newest draft by default, as an AI with its disclosure, and shows what the checks did', async () => {
    const { sent } = api([
      jsonResponse(benchResult({ release: { id: DRAFT_ID, version: 2, status: 'draft' } })),
    ]);
    const user = userEvent.setup();
    renderWithProviders(<TestBenchTab persona={withDraft()} displayName={NAME} />);

    expect(screen.getByRole('combobox', { name: 'Release' })).toHaveTextContent('Draft v2');
    expect(screen.getByText('vEIR · AI')).toBeInTheDocument();
    const disclosure = screen.getByRole('note', { name: 'AI disclosure' });
    expect(disclosure).toHaveTextContent(/is an AI, not a person/);
    // The chosen release's own disclosure, in full for screen readers.
    await waitFor(() => {
      expect(disclosure).toHaveTextContent(DRAFT.disclosureText);
    });
    expect(screen.getByText(/Nothing here is saved, no founder sees it/)).toBeInTheDocument();

    await ask(user, 'How should I test pricing?');
    expect(await screen.findByText(/Start with ten interviews/)).toBeInTheDocument();
    expect(sent).toEqual([{ releaseId: DRAFT_ID, text: 'How should I test pricing?', history: [] }]);
    // The citation chip names its source.
    expect(screen.getByText(/source E\d+: Last-time interviews/)).toBeInTheDocument();

    const checks = screen.getByRole('button', { name: 'What the checks did' });
    expect(checks).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Every check passed. Nothing was changed.')).not.toBeVisible();
    await user.click(checks);
    expect(checks).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Every check passed. Nothing was changed.')).toBeVisible();
  });

  it('sends the earlier exchanges back, and Start over forgets them', async () => {
    const { sent } = api([
      jsonResponse(benchResult()),
      jsonResponse(benchResult()),
      jsonResponse(benchResult()),
    ]);
    const user = userEvent.setup();
    renderWithProviders(<TestBenchTab persona={persona()} displayName={NAME} />);
    expect(screen.getByRole('combobox', { name: 'Release' })).toHaveTextContent('Active v1');

    await ask(user, 'First question');
    await screen.findByText(/Start with ten interviews/);
    await ask(user, 'Second question');
    await waitFor(() => {
      expect(screen.getAllByTestId('bench-answer')).toHaveLength(2);
    });
    expect(sent[1]).toMatchObject({
      releaseId: IDS.release,
      history: [{ text: 'First question', answer: expect.stringContaining('ten interviews') as unknown }],
    });

    await user.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.queryAllByTestId('bench-answer')).toEqual([]);
    expect(screen.queryByText('First question')).not.toBeInTheDocument();
    await ask(user, 'Third question');
    await screen.findByText(/Start with ten interviews/);
    expect(sent[2]).toMatchObject({ text: 'Third question', history: [] });
  });

  it('shows crisis support and held-back answers the way a founder would get them', async () => {
    api([
      jsonResponse(
        benchResult({
          status: 'blocked',
          response: null,
          evidence: [],
          blocked: { reason: 'crisis_support', supportMessage: 'Call or text **988** any time.' },
          validator: {
            ...benchResult().validator,
            escalationForced: true,
            notes: ['crisis_support', 'no_model_call'],
          },
        }),
      ),
      jsonResponse(
        benchResult({
          status: 'blocked',
          response: null,
          blocked: { reason: 'identity', supportMessage: null },
        }),
      ),
    ]);
    const user = userEvent.setup();
    renderWithProviders(<TestBenchTab persona={persona()} displayName={NAME} />);

    await ask(user, 'I can’t go on');
    const crisis = await screen.findByRole('region', { name: 'A founder would get support from people' });
    expect(within(crisis).getByText('988')).toBeInTheDocument();
    await ask(user, 'Sign it from Corin');
    expect(
      await screen.findByRole('region', { name: 'A founder would not see this answer' }),
    ).toHaveTextContent(/identity check held it back/);
  });

  it('says what went wrong, keeps the message, and tries again', async () => {
    const { sent } = api([problem(403, 'forbidden', 'consent_required'), jsonResponse(benchResult())]);
    const user = userEvent.setup();
    renderWithProviders(<TestBenchTab persona={persona()} displayName={NAME} />);

    await ask(user, 'Will this work?');
    expect(await screen.findByText(/Record one in Consent/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: `Message ${NAME}` })).toHaveValue('Will this work?');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText(/Start with ten interviews/);
    expect(sent).toHaveLength(2);
    expect(screen.queryByText(/Record one in Consent/)).not.toBeInTheDocument();
  });

  it('keeps nothing: no browser storage, and nothing left after leaving', async () => {
    api([jsonResponse(benchResult())]);
    const user = userEvent.setup();
    const before = { local: localStorage.length, session: sessionStorage.length };
    const first = renderWithProviders(<TestBenchTab persona={persona()} displayName={NAME} />);
    await ask(user, 'Remember me?');
    await screen.findByText(/Start with ten interviews/);
    expect({ local: localStorage.length, session: sessionStorage.length }).toEqual(before);
    // Nothing of the conversation is in the query cache either.
    expect(
      JSON.stringify(
        first.client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain('Remember me?');
    first.unmount();
    renderWithProviders(<TestBenchTab persona={persona()} displayName={NAME} />);
    expect(screen.queryByText('Remember me?')).not.toBeInTheDocument();
  });

  it('pauses for a suspended vEIR, and offers nothing without a release', () => {
    api([]);
    const { unmount } = renderWithProviders(
      <TestBenchTab persona={persona({ status: 'suspended' })} displayName={NAME} />,
    );
    expect(screen.getByRole('textbox', { name: `Message ${NAME}` })).toBeDisabled();
    expect(screen.getByPlaceholderText('Resume this vEIR to try a release')).toBeInTheDocument();
    unmount();
    renderWithProviders(
      <TestBenchTab persona={persona({ activeRelease: null, releases: [] })} displayName={NAME} />,
    );
    expect(screen.getByRole('heading', { name: 'There’s no release to try yet' })).toBeInTheDocument();
  });
});

describe('personaTabs', () => {
  it('shows the Test bench to the persona’s curators only', () => {
    expect(personaTabs(persona()).map((t) => t.label)).toContain('Test bench');
    expect(personaTabs(persona({ canCurate: false })).map((t) => t.label)).not.toContain('Test bench');
    expect(personaTabs(persona({ canCurate: undefined })).map((t) => t.label)).not.toContain('Test bench');
  });
});
