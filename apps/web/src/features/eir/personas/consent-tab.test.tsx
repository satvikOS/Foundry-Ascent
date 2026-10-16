import type { ConsentView } from '@foundry/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { jsonResponse, renderWithProviders, sentJson, stubFetch } from '@/features/admin/shared/test-utils';

import { consentStatus, consentToForm, formToConsent } from './consent-form';
import { ConsentTab } from './consent-tab';
import { IDS, persona } from './test-fixtures';

const CONSENT: ConsentView = {
  id: 'd2e3f405-a6b7-4c8d-9e0f-1a2b3c4d5e6f',
  subjectPrincipalId: IDS.corinEir,
  assetTypes: ['doctrine', 'style', 'voice'],
  approvedUses: ['veir_coaching'],
  audiences: ['program_founders'],
  evidenceRef: 'SYN-CH-2026-01',
  grantedAt: '2026-10-16T09:00:00.000Z',
  expiresAt: null,
  revokedAt: null,
  personas: [{ id: IDS.corin, name: "Corin's vEIR", status: 'active' }],
};

describe('consent form', () => {
  it('maps the form to the request in canonical order, with empty values as null', () => {
    const values = { ...consentToForm(null), assetTypes: ['voice', 'doctrine'] as ConsentView['assetTypes'] };
    expect(formToConsent({ ...values, approvedUses: 'coaching, calls,coaching', evidenceRef: ' ' })).toEqual({
      assetTypes: ['doctrine', 'voice'],
      approvedUses: ['coaching', 'calls'],
      audiences: [],
      evidenceRef: null,
      expiresAt: null,
    });
  });

  it('tells consent in force from revoked and expired', () => {
    const now = Date.parse('2026-10-20T00:00:00Z');
    expect(consentStatus(CONSENT, now)).toBe('in_force');
    expect(consentStatus({ ...CONSENT, revokedAt: '2026-10-18T00:00:00Z' }, now)).toBe('revoked');
    expect(consentStatus({ ...CONSENT, expiresAt: '2026-10-19T00:00:00Z' }, now)).toBe('expired');
  });
});

describe('ConsentTab', () => {
  it('shows what the consent covers and who relies on it, and revokes after naming the vEIRs suspended', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((_url, init) =>
      Promise.resolve(
        init?.method === 'POST'
          ? jsonResponse({
              consent: { ...CONSENT, revokedAt: '2026-10-17T00:00:00Z' },
              suspendedPersonaIds: [IDS.corin],
            })
          : jsonResponse({ items: [CONSENT] }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ConsentTab persona={persona()} />);
    const list = await screen.findByRole('list', { name: 'Consent records' });
    expect(within(list).getByText('In force')).toBeVisible();
    expect(within(list).getByText('Voice')).toBeVisible();
    expect(within(list).getByText("Corin's vEIR")).toBeVisible();

    await user.click(within(list).getByRole('button', { name: 'Revoke…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Revoke this consent?' });
    expect(
      within(dialog).getByText(/Corin's vEIR is suspended at once, pausing coaching for 2 ventures/),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Revoke consent' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
    });
    expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[0]).toBe(
      `/api/v1/consents/${CONSENT.id}/revoke`,
    );
  });

  it('records a new consent from the one in force', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((_url, init) =>
      Promise.resolve(
        init?.method === 'POST' ? jsonResponse(CONSENT, 201) : jsonResponse({ items: [CONSENT] }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ConsentTab persona={persona()} />);
    await user.click(await screen.findByRole('button', { name: 'Record consent' }));
    const dialog = screen.getByRole('dialog', { name: 'Record Corin Halvorsen’s consent' });
    // Prefilled from the consent in force.
    expect(within(dialog).getByRole('checkbox', { name: 'Voice' })).toBeChecked();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Likeness' }));
    await user.click(within(dialog).getByRole('button', { name: 'Record consent' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
    });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe(`/api/v1/personas/${IDS.corin}/consents`);
    expect(sentJson(post?.[1])).toEqual({
      assetTypes: ['doctrine', 'style', 'voice', 'likeness'],
      approvedUses: ['veir_coaching'],
      audiences: ['program_founders'],
      evidenceRef: 'SYN-CH-2026-01',
      expiresAt: null,
    });
  });

  it('never asks for records the viewer may not see, and hides actions they may not take', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ items: [CONSENT] }));
    const first = renderWithProviders(
      <ConsentTab persona={persona({ canCurate: false, canManageConsent: false })} />,
    );
    expect(screen.getByText('Only Corin Halvorsen and program leads see consent records.')).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    first.unmount();

    renderWithProviders(<ConsentTab persona={persona({ canManageConsent: false })} />);
    expect(await screen.findByText('Only Corin Halvorsen can record or revoke their consent.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Record consent' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke…' })).toBeNull();
  });
});
