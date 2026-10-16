import type { PersonaReleaseView } from '@foundry/contracts';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderWithProviders, stubFetch } from '@/features/admin/shared/test-utils';

import { WithdrawReleaseDialog } from './release-history';
import { ReleaseReview, ReleasesTab } from './releases-tab';
import { persona, RELEASE } from './test-fixtures';

const RELEASE_ID = '5a1e2b3c-4d5e-4f60-8a71-b2c3d4e5f607';
const PERSONA_ID = '6b2f3c4d-5e6f-4a71-8b82-c3d4e5f60718';

const draft: PersonaReleaseView = {
  id: RELEASE_ID,
  personaId: PERSONA_ID,
  version: 3,
  doctrine: {
    summary: 'Push for customer evidence before building.',
    frameworks: [{ name: 'Jobs to be done', whenToUse: 'Early discovery', keyQuestions: ['Who hires it?'] }],
    evidenceStandard: 'Two independent sources.',
    typicalQuestions: ['What did customers say?'],
    redLines: ['Never give legal advice.'],
    escalationTopics: ['IP ownership'],
    referralDestinations: ['Tech transfer office'],
    teachingPrinciples: ['Ask before telling.'],
  },
  style: {
    directness: 'direct',
    warmth: 'warm',
    pace: 'measured',
    vocabulary: [],
    feedbackStructure: 'Observation, impact, next step.',
    avoid: [],
  },
  disclosureText:
    'You are working with Foundry Guide, an AI coach. It is not a person, and no human EIR authored or approved these responses.',
  allowedModes: ['diagnose', 'coach'],
  status: 'draft',
  createdBy: { id: PERSONA_ID, displayName: 'Corin Halvorsen', title: null, synthetic: true },
  approvedBy: null,
  approvedAt: null,
  createdAt: '2026-10-05T09:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ReleaseReview (EIR studio)', () => {
  it('loads the full draft from GET /persona-releases/:id and approves exactly that release', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(draft));
    const onApprove = vi.fn();
    renderWithProviders(
      <ReleaseReview persona={persona()} releaseId={RELEASE_ID} blocker={null} onApprove={onApprove} />,
    );

    expect(await screen.findByText('Draft v3 — ready for review')).toBeVisible();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/persona-releases/${RELEASE_ID}`);
    expect(screen.getByText(/drafted by Corin Halvorsen/)).toBeVisible();
    expect(screen.getByText('Push for customer evidence before building.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /Approve/ }));
    expect(onApprove).toHaveBeenCalledWith(draft);
  });

  it('shows a draft older than the active release as outdated, with no way to approve it', async () => {
    stubFetch().mockResolvedValue(jsonResponse({ ...draft, version: 2 }));
    const active = persona({ activeRelease: { ...RELEASE, version: 3 } });
    renderWithProviders(
      <ReleaseReview persona={active} releaseId={RELEASE_ID} blocker={null} onApprove={vi.fn()} />,
    );
    expect(await screen.findByText('Draft v2 · outdated')).toBeVisible();
    expect(screen.getByText('Older than the active v3, so it can’t be approved.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  });

  it('offers to withdraw a superseded release to its curators, and confirms what that does', async () => {
    const superseded = { ...draft, version: 2, status: 'superseded' as const };
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((_input, init) =>
      Promise.resolve(
        jsonResponse(init?.method === 'POST' ? { ...superseded, status: 'withdrawn' } : superseded),
      ),
    );
    const active = persona({ activeRelease: { ...RELEASE, version: 3 } });
    const onWithdraw = vi.fn();
    renderWithProviders(
      <ReleaseReview persona={active} releaseId={RELEASE_ID} blocker={null} onWithdraw={onWithdraw} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Withdraw…' }));
    expect(onWithdraw).toHaveBeenCalledWith(superseded);

    renderWithProviders(
      <WithdrawReleaseDialog persona={active} release={{ id: RELEASE_ID, version: 2 }} onClose={vi.fn()} />,
    );
    expect(
      screen.getByText(/Conversations still on v2 move to the active v3 at their next message\./),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Withdraw release' }));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe(`/api/v1/persona-releases/${RELEASE_ID}/withdraw`);
  });

  it('never offers to withdraw the release without a curator, or a draft', async () => {
    stubFetch().mockResolvedValue(jsonResponse({ ...draft, status: 'superseded' }));
    renderWithProviders(<ReleaseReview persona={persona()} releaseId={RELEASE_ID} blocker={null} />);
    expect(await screen.findByText(/Release v3/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Withdraw…' })).toBeNull();
  });

  it('keeps approval disabled while consent is missing', async () => {
    stubFetch().mockResolvedValue(jsonResponse(draft));
    renderWithProviders(
      <ReleaseReview
        persona={persona()}
        releaseId={RELEASE_ID}
        blocker="Consent needed"
        onApprove={vi.fn()}
      />,
    );
    expect(await screen.findByRole('button', { name: /Approve/ })).toBeDisabled();
  });

  it('explains a refused draft (not the persona’s EIR) instead of showing content', async () => {
    stubFetch().mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          code: 'forbidden',
          requestId: 'req-1',
        }),
        { status: 403, headers: { 'content-type': 'application/problem+json' } },
      ),
    );
    renderWithProviders(
      <ReleaseReview persona={persona()} releaseId={RELEASE_ID} blocker={null} onApprove={vi.fn()} />,
    );
    expect(await screen.findByText('No access')).toBeVisible();
    expect(screen.queryByText('Push for customer evidence before building.')).toBeNull();
  });
});

describe('ReleasesTab', () => {
  const V3 = '0f1e2d3c-4b5a-4968-8776-655443322110';
  const V2 = '1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9';
  // v3 was approved over an older v2 draft that was never approved.
  const withStaleDraft = persona({
    activeRelease: { ...RELEASE, id: V3, version: 3 },
    releases: [
      {
        id: V3,
        version: 3,
        status: 'approved',
        approvedAt: RELEASE.approvedAt,
        createdAt: RELEASE.createdAt,
      },
      { id: V2, version: 2, status: 'draft', approvedAt: null, createdAt: RELEASE.createdAt },
      {
        id: RELEASE.id,
        version: 1,
        status: 'superseded',
        approvedAt: RELEASE.approvedAt,
        createdAt: RELEASE.createdAt,
      },
    ],
  });

  it('never opens a draft older than the active release for approval', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ ...draft, id: V2, version: 2 }));
    renderWithProviders(<ReleasesTab persona={withStaleDraft} />);
    const history = screen.getByRole('list', { name: 'Releases' });
    expect(screen.getByText('Outdated')).toBeVisible();
    expect(history).not.toHaveTextContent(/Review v2/);
    // Nothing opens by default: there is no draft newer than v3.
    expect(fetchMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /^View\s*v2$/ }));
    expect(await screen.findByText('Draft v2 · outdated')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  });

  it('opens only published releases for people who don’t curate the vEIR (drafts are refused to them)', async () => {
    const V4 = '2b3c4d5e-6f70-4182-93a4-b5c6d7e8f9a0';
    const reader = persona({
      canCurate: false,
      canManageConsent: false,
      activeRelease: { ...RELEASE, id: V3, version: 3 },
      releases: [
        { id: V4, version: 4, status: 'draft', approvedAt: null, createdAt: RELEASE.createdAt },
        {
          id: V3,
          version: 3,
          status: 'approved',
          approvedAt: RELEASE.approvedAt,
          createdAt: RELEASE.createdAt,
        },
        { id: V2, version: 2, status: 'withdrawn', approvedAt: null, createdAt: RELEASE.createdAt },
        {
          id: RELEASE.id,
          version: 1,
          status: 'superseded',
          approvedAt: RELEASE.approvedAt,
          createdAt: RELEASE.createdAt,
        },
      ],
    });
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ ...draft, id: RELEASE.id, version: 1, status: 'superseded' }));
    renderWithProviders(<ReleasesTab persona={reader} />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    // The draft is listed, but nothing opens it: GET /persona-releases/:id would answer 403.
    const history = screen.getByRole('list', { name: 'Releases' });
    expect(history).toHaveTextContent('v4');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Review\s*v4/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /View\s*v2/ })).toBeNull();
    expect(screen.queryByText('No access')).toBeNull();

    // A superseded release is published history, so it still opens.
    await userEvent.click(screen.getByRole('button', { name: /^View\s*v1$/ }));
    expect(await screen.findByText(/Release v1/)).toBeVisible();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`/api/v1/persona-releases/${RELEASE.id}`]);
  });
});
