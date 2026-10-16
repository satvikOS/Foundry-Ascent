import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders, stubFetch } from '@/features/admin/shared/test-utils';

import { ResumePersonaDialog } from './persona-controls';
import { persona } from './test-fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

const REVOKED_REASON =
  'Consent was revoked. Record a new consent that covers doctrine before this vEIR can coach again.';

function consentRefused(): Response {
  return new Response(
    JSON.stringify({
      type: 'urn:foundry-ascent:problem:forbidden',
      title: 'Forbidden',
      status: 403,
      code: 'forbidden',
      detail: 'An EIR persona needs a valid consent record before it can run',
      requestId: 'req-1',
      errors: [{ path: 'consent', message: REVOKED_REASON }],
    }),
    { status: 403, headers: { 'content-type': 'application/problem+json' } },
  );
}

describe('ResumePersonaDialog', () => {
  it('does not offer to resume a vEIR whose consent was revoked, and says why', async () => {
    const fetchMock = stubFetch();
    const onOpenConsent = vi.fn();
    const suspended = persona({ status: 'suspended', suspendedReason: 'consent revoked', hasConsent: false });
    renderWithProviders(
      <ResumePersonaDialog persona={suspended} open onOpenChange={vi.fn()} onOpenConsent={onOpenConsent} />,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/Consent was revoked/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Resume coaching' })).toBeDisabled();
    expect(within(dialog).queryByText(/don’t have access/)).toBeNull();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Open Consent' }));
    expect(onOpenConsent).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names who records consent when the viewer can’t', () => {
    stubFetch();
    const suspended = persona({
      status: 'suspended',
      suspendedReason: 'consent revoked',
      hasConsent: false,
      canManageConsent: false,
    });
    renderWithProviders(
      <ResumePersonaDialog persona={suspended} open onOpenChange={vi.fn()} onOpenConsent={vi.fn()} />,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/Only Corin Halvorsen can record it\./)).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Open Consent' })).toBeNull();
  });

  it('shows the server’s consent reason when the resume is refused, not “no access”', async () => {
    // The page still showed consent in force (it was revoked elsewhere meanwhile).
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(() => Promise.resolve(consentRefused()));
    const suspended = persona({ status: 'suspended', suspendedReason: 'Reviewing doctrine' });
    renderWithProviders(<ResumePersonaDialog persona={suspended} open onOpenChange={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Resume coaching' }));

    expect(await within(dialog).findByText(REVOKED_REASON)).toBeVisible();
    expect(within(dialog).queryByText(/don’t have access/)).toBeNull();
    expect(within(dialog).queryByText(/Ask a program lead/)).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Resume coaching' })).toBeDisabled();
  });
});
