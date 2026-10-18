import type { DigitalTwinView } from '@foundry/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { jsonResponse, renderWithProviders, sentJson, stubFetch } from '@/features/admin/shared/test-utils';

import { DigitalTwinSection } from './digital-twin-section';
import { IDS, persona } from './test-fixtures';

const CONSENT_ID = 'd2e3f405-a6b7-4c8d-9e0f-1a2b3c4d5e6f';

const TWIN: DigitalTwinView = {
  personaId: IDS.corin,
  consentId: CONSENT_ID,
  scopes: { likeness: false, voice: true, firstPerson: true },
  face: null,
  voice: {
    kind: 'voice',
    vendor: 'elevenlabs',
    vendorRef: 'VoiceClone01',
    status: 'ready',
    updatedAt: '2026-10-17T12:00:00.000Z',
  },
  facesEnabled: false,
  clonedVoiceEnabled: true,
};

/** The `index`-th item of a list (fails the test when there is none). */
function rowOf(list: HTMLElement, index: number): HTMLElement {
  const row = within(list).getAllByRole('listitem')[index];
  if (!row) throw new Error(`no row ${String(index)}`);
  return row;
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

describe('DigitalTwinSection', () => {
  it('shows each scope and the vendor IDs, and records a face ID as pending', async () => {
    const fetchMock = stubFetch();
    let twin = TWIN;
    fetchMock.mockImplementation((input, init) => {
      if (init?.method === 'PATCH') {
        const body = sentJson(init) as { vendorRef: string; status: 'pending' | 'ready' };
        twin = {
          ...twin,
          face: {
            kind: 'face',
            vendor: 'heygen',
            vendorRef: body.vendorRef,
            status: body.status,
            updatedAt: '2026-10-17T12:05:00.000Z',
          },
        };
      }
      expect(urlOf(input)).toMatch(/\/personas\/.+\/twin/);
      return Promise.resolve(jsonResponse(twin));
    });
    const user = userEvent.setup();
    renderWithProviders(
      <DigitalTwinSection persona={persona({ canCurate: true, canManageConsent: true })} />,
    );

    const scopes = await screen.findByRole('list', { name: 'Consent scopes' });
    expect(
      within(scopes)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['LikenessNot granted', 'VoiceGrantedWithdraw…', 'First-person twinGrantedWithdraw…']);
    // The platform switch is plain to see.
    expect(screen.getByText(/Faces are off in Settings/)).toBeVisible();
    const ids = screen.getByRole('list', { name: 'Vendor IDs' });
    const faceRow = rowOf(ids, 0);
    const voiceRow = rowOf(ids, 1);
    expect(within(voiceRow).getByRole('textbox')).toHaveValue('VoiceClone01');
    expect(voiceRow.querySelector('[data-slot="badge"]')).toHaveTextContent('Ready');

    // A face without likeness consent: the form says so, and the ID can be kept as pending.
    const faceInput = within(faceRow).getByRole('textbox');
    await user.type(faceInput, 'not valid!');
    expect(within(faceRow).getByText('Use the ID exactly as shown there.')).toBeVisible();
    await user.clear(faceInput);
    await user.type(faceInput, 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a');
    expect(within(faceRow).getByText(/Needs this scope in the consent first/)).toBeVisible();
    await user.click(within(faceRow).getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Pending' }));
    await user.click(within(faceRow).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const row = within(screen.getByRole('list', { name: 'Vendor IDs' })).getAllByRole('listitem')[0];
      expect(row?.querySelector('[data-slot="badge"]')).toHaveTextContent('Pending');
    });
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(urlOf(patch?.[0] ?? '')).toMatch(/\/twin\/face$/);
    expect(sentJson(patch?.[1])).toEqual({
      vendorRef: 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a',
      status: 'pending',
    });
  });

  it('withdraws one scope after saying what changes, and nothing else', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((input, init) => {
      if (init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            consent: {
              id: 'e3f40516-b7c8-4d9e-8f01-2b3c4d5e6f70',
              subjectPrincipalId: IDS.corinEir,
              assetTypes: ['doctrine', 'style', 'first_person'],
              approvedUses: [],
              audiences: [],
              evidenceRef: null,
              grantedAt: '2026-10-17T12:10:00.000Z',
              expiresAt: null,
              revokedAt: null,
            },
            previousConsentId: CONSENT_ID,
          }),
        );
      }
      return Promise.resolve(jsonResponse(urlOf(input).includes('/twin') ? TWIN : { items: [] }));
    });
    const user = userEvent.setup();
    renderWithProviders(
      <DigitalTwinSection persona={persona({ canCurate: true, canManageConsent: true })} />,
    );
    const scopes = await screen.findByRole('list', { name: 'Consent scopes' });
    const voice = rowOf(scopes, 1);
    await user.click(within(voice).getByRole('button', { name: 'Withdraw…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Withdraw voice?' });
    expect(within(dialog).getByText(/standard voice takes over at once/)).toBeVisible();
    expect(within(dialog).getByText(/rest stays in force/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(urlOf(post?.[0] ?? '')).toMatch(new RegExp(`/consents/${CONSENT_ID}/withdraw-scope$`));
    expect(sentJson(post?.[1])).toEqual({ assetType: 'voice' });
  });

  it('lets a curator who cannot change consent record IDs only, and shows nothing to anyone else', async () => {
    stubFetch().mockResolvedValue(jsonResponse(TWIN));
    const view = renderWithProviders(
      <DigitalTwinSection persona={persona({ canCurate: true, canManageConsent: false })} />,
    );
    await screen.findByRole('list', { name: 'Consent scopes' });
    expect(screen.queryByRole('button', { name: 'Withdraw…' })).toBeNull();
    view.unmount();
    const hidden = renderWithProviders(<DigitalTwinSection persona={persona({ canCurate: false })} />);
    expect(hidden.container).toBeEmptyDOMElement();
  });
});
