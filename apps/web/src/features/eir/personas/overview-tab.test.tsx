import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders, stubFetch } from '@/features/admin/shared/test-utils';

import { OverviewTab } from './overview-tab';
import { IDS, persona, RELEASE } from './test-fixtures';

const withDraft = (canCurate: boolean) =>
  persona({
    canCurate,
    canManageConsent: canCurate,
    releases: [
      ...persona().releases,
      { id: IDS.lesson, version: 2, status: 'draft', approvedAt: null, createdAt: RELEASE.createdAt },
    ],
  });

function renderOverview(canCurate: boolean) {
  // The library and lesson counts stay loading: only the Releases tile matters here.
  stubFetch().mockReturnValue(new Promise<Response>(() => undefined));
  renderWithProviders(
    <OverviewTab persona={withDraft(canCurate)} tenant="ain" canSeeAssignments={false} onOpenTab={vi.fn()} />,
  );
}

describe('OverviewTab', () => {
  it('counts the drafts waiting for approval for the vEIR’s curators', () => {
    renderOverview(true);
    expect(screen.getByRole('button', { name: /Releases/ })).toHaveTextContent('1 draft to approve');
  });

  it('does not count drafts for people who can’t review them', () => {
    renderOverview(false);
    const tile = screen.getByRole('button', { name: /Releases/ });
    expect(tile).toHaveTextContent('v1 active');
    expect(tile).not.toHaveTextContent(/draft/);
  });
});
