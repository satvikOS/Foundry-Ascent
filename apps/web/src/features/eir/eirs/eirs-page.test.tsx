import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { jsonResponse, renderWithProviders, sentJson, stubFetch } from '@/features/admin/shared/test-utils';
import { eirProfile, GUIDE, IDS, persona, RUTH } from '@/features/eir/personas/test-fixtures';

import { eirVeirState } from './eir-veir';
import { EirsPage } from './eirs-page';

const NOOR_EIR = '22222222-3333-4444-8555-666666666666';
const NOOR = '33333333-4444-4555-8666-777777777777';
const INES = '44444444-5555-4666-8777-888888888888';

const urlOf = (input: RequestInfo | URL) => (input instanceof Request ? input.url : input.toString());

function problem(status: number, code: string, errors: { path: string; message: string }[]): Response {
  return new Response(
    JSON.stringify({
      type: `urn:foundry-ascent:problem:${code}`,
      title: 'Refused',
      status,
      code,
      detail: errors[0]?.message ?? 'Refused',
      requestId: 'req-1',
      errors,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

type Handler = (url: string, init: RequestInit | undefined) => Response | undefined;

function mockApi(handler: Handler = () => undefined) {
  const fetchMock = stubFetch();
  fetchMock.mockImplementation((input, init) => {
    const url = urlOf(input);
    const handled = handler(url, init);
    if (handled) return Promise.resolve(handled);
    if (url === '/api/v1/eir/profiles') {
      return Promise.resolve(
        jsonResponse({
          items: [
            {
              ...eirProfile(IDS.corinEir, 'Corin Halvorsen'),
              title: 'Go-to-market EIR',
              expertiseTags: ['b2b-sales', 'pricing'],
            },
            eirProfile(NOOR_EIR, 'Noor Haddad'),
            eirProfile(IDS.ruthEir, 'Ruth Abernathy-Song'),
          ],
        }),
      );
    }
    if (url === '/api/v1/eir/candidates') {
      return Promise.resolve(
        jsonResponse({
          items: [{ id: INES, displayName: 'Ines Okoro', title: 'Investor', synthetic: false }],
        }),
      );
    }
    // Corin's vEIR has consent on file; Ruth's waits for it; Noor has none.
    return Promise.resolve(jsonResponse({ items: [GUIDE, persona(), { ...RUTH, hasConsent: false }] }));
  });
  const rootRoute = createRootRoute({ component: () => <EirsPage tenant="ain" canCreateVeir /> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  renderWithProviders(<RouterProvider router={router} />);
  return fetchMock;
}

describe('eirVeirState', () => {
  it('finds the EIR’s live vEIR and whether its consent is on file', () => {
    const retired = persona({
      id: NOOR,
      status: 'retired',
      eirProfile: { id: NOOR_EIR, displayName: 'Noor Haddad', synthetic: false, expertiseTags: [] },
    });
    expect(eirVeirState(NOOR_EIR, [retired])).toEqual({ kind: 'no_veir' });
    expect(eirVeirState(IDS.corinEir, [persona()])).toMatchObject({ kind: 'consent_on_file' });
    expect(eirVeirState(IDS.ruthEir, [{ ...RUTH, hasConsent: false }])).toMatchObject({
      kind: 'consent_needed',
    });
  });
});

describe('EirsPage (EIR studio → EIRs)', () => {
  it('lists each EIR with where they stand with their vEIR: consent comes before release', async () => {
    mockApi();
    const table = await screen.findByRole('table', { name: 'EIRs' });
    const row = (name: string) => within(table).getByRole('row', { name: new RegExp(name) });

    const corin = row('Corin Halvorsen');
    expect(within(corin).getByText('Go-to-market EIR')).toBeVisible();
    expect(within(corin).getByText('b2b sales')).toBeVisible();
    expect(within(corin).getByRole('link', { name: "Corin's vEIR" })).toHaveAttribute(
      'href',
      `/ain/app/eir/personas/${IDS.corin}`,
    );
    expect(within(corin).getByText('Consent on file')).toBeVisible();

    const ruth = row('Ruth Abernathy-Song');
    expect(within(ruth).getByRole('link', { name: "Ruth's vEIR" })).toHaveAttribute(
      'href',
      `/ain/app/eir/personas/${IDS.ruth}?tab=consent`,
    );
    expect(within(ruth).getByText('Consent needed before a vEIR can be released')).toBeVisible();

    const noor = row('Noor Haddad');
    expect(within(noor).getByText('No vEIR yet')).toBeVisible();
    expect(within(noor).getByText('Consent needed before a vEIR can be released')).toBeVisible();
    expect(within(noor).getByRole('link', { name: 'New vEIR for Noor Haddad' })).toHaveAttribute(
      'href',
      `/ain/app/eir/personas/new?eir=${NOOR_EIR}`,
    );
  });

  it('adds an EIR linked to a person with the EIR role, suggesting their name and title', async () => {
    let created: unknown;
    const fetchMock = mockApi((url, init) => {
      if (url === '/api/v1/eir/profiles' && init?.method === 'POST') {
        created = sentJson(init);
        return jsonResponse({ ...eirProfile('55555555-6666-4777-8888-999999999999', 'Ines Okoro') }, 201);
      }
      return undefined;
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add EIR' }));
    const form = await screen.findByRole('form', { name: 'Add EIR' });
    expect(within(form).getByText(/Consent needed before a vEIR can be released/)).toBeVisible();
    await user.click(within(form).getByRole('combobox', { name: /Person/ }));
    await user.click(await screen.findByRole('option', { name: 'Ines Okoro' }));
    expect(within(form).getByRole('textbox', { name: /^Name/ })).toHaveValue('Ines Okoro');
    expect(within(form).getByRole('textbox', { name: /^Title/ })).toHaveValue('Investor');
    await user.type(
      within(form).getByRole('textbox', { name: /^Areas of expertise/ }),
      'Climate Tech, pricing',
    );
    await user.type(within(form).getByRole('textbox', { name: /^Bio/ }), 'Built a grid-storage company.');
    await user.click(within(form).getByRole('button', { name: 'Add EIR' }));

    await waitFor(() => {
      expect(screen.queryByRole('form', { name: 'Add EIR' })).toBeNull();
    });
    expect(created).toEqual({
      principalId: INES,
      displayName: 'Ines Okoro',
      title: 'Investor',
      expertiseTags: ['climate-tech', 'pricing'],
      bio: 'Built a grid-storage company.',
    });
    // The list and the people left to add are read again.
    const reads = fetchMock.mock.calls.map(([input]) => urlOf(input));
    expect(reads.filter((url) => url === '/api/v1/eir/profiles').length).toBeGreaterThanOrEqual(2);
  });

  it('shows the server’s refusals on their fields', async () => {
    mockApi((url, init) => {
      if (url === '/api/v1/eir/profiles' && init?.method === 'POST') {
        return problem(409, 'conflict', [
          { path: 'principalId', message: 'Ines Okoro already has an EIR profile.' },
        ]);
      }
      return undefined;
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add EIR' }));
    const form = await screen.findByRole('form', { name: 'Add EIR' });
    // Nothing chosen yet: the form says so before sending anything.
    await user.click(within(form).getByRole('button', { name: 'Add EIR' }));
    expect(await within(form).findByText('Choose the person.')).toBeVisible();

    await user.click(within(form).getByRole('combobox', { name: /Person/ }));
    await user.click(await screen.findByRole('option', { name: 'Ines Okoro' }));
    // An area of one letter is refused by the contract before it is sent, at the field.
    await user.type(within(form).getByRole('textbox', { name: /^Areas of expertise/ }), 'x');
    await user.click(within(form).getByRole('button', { name: 'Add EIR' }));
    const areas = within(form).getByRole('textbox', { name: /^Areas of expertise/ });
    await waitFor(() => {
      expect(areas).toHaveAccessibleDescription(/Use 2 to 40 characters for each area/);
    });
    await user.clear(areas);
    await user.click(within(form).getByRole('button', { name: 'Add EIR' }));
    expect(await within(form).findByText('Ines Okoro already has an EIR profile.')).toBeVisible();
    expect(within(form).getByRole('combobox', { name: /Person/ })).toHaveAttribute('aria-invalid', 'true');
  });

  it('says when no one is left to add', async () => {
    mockApi((url) => (url === '/api/v1/eir/candidates' ? jsonResponse({ items: [] }) : undefined));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add EIR' }));
    const form = await screen.findByRole('form', { name: 'Add EIR' });
    expect(await within(form).findByText('No one to add yet')).toBeVisible();
    expect(within(form).getByRole('button', { name: 'Add EIR' })).toBeDisabled();
  });

  it('edits an EIR’s title, expertise and bio', async () => {
    let patch: unknown;
    mockApi((url, init) => {
      if (url === `/api/v1/eir/profiles/${IDS.corinEir}` && init?.method === 'PATCH') {
        patch = sentJson(init);
        return jsonResponse({ ...eirProfile(IDS.corinEir, 'Corin Halvorsen'), title: 'GTM EIR' });
      }
      return undefined;
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit Corin Halvorsen' }));
    const form = await screen.findByRole('form', { name: 'Edit EIR' });
    const title = within(form).getByRole('textbox', { name: /^Title/ });
    expect(title).toHaveValue('Go-to-market EIR');
    expect(within(form).getByRole('textbox', { name: /^Areas of expertise/ })).toHaveValue(
      'b2b-sales, pricing',
    );
    await user.clear(title);
    await user.type(title, 'GTM EIR');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('form', { name: 'Edit EIR' })).toBeNull();
    });
    expect(patch).toEqual({
      displayName: 'Corin Halvorsen',
      title: 'GTM EIR',
      expertiseTags: ['b2b-sales', 'pricing'],
      bio: null,
    });
  });
});
