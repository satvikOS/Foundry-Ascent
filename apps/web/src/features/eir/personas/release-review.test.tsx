import type { PersonaReleaseView } from '@foundry/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderWithProviders, stubFetch } from '@/features/admin/shared/test-utils';

import { ReleaseReview } from './persona-detail-page';

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
    renderWithProviders(<ReleaseReview releaseId={RELEASE_ID} blocker={null} onApprove={onApprove} />);

    expect(await screen.findByText('Draft v3 — ready for review')).toBeVisible();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/persona-releases/${RELEASE_ID}`);
    expect(screen.getByText(/drafted by Corin Halvorsen/)).toBeVisible();
    expect(screen.getByText('Push for customer evidence before building.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /Approve/ }));
    expect(onApprove).toHaveBeenCalledWith(draft);
  });

  it('keeps approval disabled while consent is missing', async () => {
    stubFetch().mockResolvedValue(jsonResponse(draft));
    renderWithProviders(
      <ReleaseReview releaseId={RELEASE_ID} blocker="Consent needed" onApprove={vi.fn()} />,
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
    renderWithProviders(<ReleaseReview releaseId={RELEASE_ID} blocker={null} onApprove={vi.fn()} />);
    expect(await screen.findByText('No access')).toBeVisible();
    expect(screen.queryByText('Push for customer evidence before building.')).toBeNull();
  });
});
