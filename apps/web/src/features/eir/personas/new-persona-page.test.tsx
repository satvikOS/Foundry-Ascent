import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { jsonResponse, renderWithProviders, sentJson, stubFetch } from '@/features/admin/shared/test-utils';

import { NewPersonaPage } from './new-persona-page';
import { eirProfile, GUIDE, IDS, persona, RUTH } from './test-fixtures';

const NOOR_EIR = '22222222-3333-4444-8555-666666666666';
const NOOR = '33333333-4444-4555-8666-777777777777';

function mockApi() {
  const fetchMock = stubFetch();
  fetchMock.mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (init?.method === 'POST') {
      return Promise.resolve(
        jsonResponse(
          persona({
            id: NOOR,
            name: "Noor's vEIR",
            status: 'draft',
            activeRelease: null,
            hasConsent: false,
          }),
          201,
        ),
      );
    }
    if (url === '/api/v1/eir/profiles') {
      return Promise.resolve(
        jsonResponse({
          items: [
            eirProfile(IDS.corinEir, 'Corin Halvorsen'),
            eirProfile(IDS.ruthEir, 'Ruth Abernathy-Song'),
            eirProfile(NOOR_EIR, 'Noor Example'),
          ],
        }),
      );
    }
    return Promise.resolve(jsonResponse({ items: [GUIDE, persona(), RUTH] }));
  });
  const rootRoute = createRootRoute({ component: () => <NewPersonaPage tenant="ain" /> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  renderWithProviders(<RouterProvider router={router} />);
  return { fetchMock, router };
}

describe('NewPersonaPage (program lead)', () => {
  it('builds a draft vEIR from an EIR without one, then opens its consent section', async () => {
    const { fetchMock, router } = mockApi();
    const user = userEvent.setup();

    // Only Noor can get a vEIR; the standard name is suggested.
    const eir = await screen.findByRole('combobox', { name: 'EIR' });
    await user.click(eir);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Noor Example']);
    await user.click(screen.getByRole('option', { name: 'Noor Example' }));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue("Noor's vEIR");
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Doctrine & style, with a disclosure that says it's an AI built from Noor's material.
    expect(await screen.findByRole('heading', { level: 1, name: "Noor's vEIR" })).toBeVisible();
    expect(screen.getByRole('textbox', { name: /^Disclosure/ })).toHaveDisplayValue(
      /an AI coach built from Noor Example's approved frameworks/,
    );
    // Pasted, not typed key by key: the test stays fast on a loaded machine.
    const fill = async (name: RegExp, value: string) => {
      await user.click(screen.getByRole('textbox', { name }));
      await user.paste(value);
    };
    await fill(/^Summary/, 'Hardware founders prove manufacturability before scale.');
    await fill(/^Evidence standard/, 'A working prototype and a quote from a supplier.');
    await fill(/^Red lines/, 'Never claim to be Noor.');
    await fill(/^Escalation topics/, 'Safety certification');
    await fill(/^Feedback structure/, 'Risk first, then one next step.');
    await user.click(screen.getByRole('button', { name: 'Create vEIR' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/ain/app/eir/personas/${NOOR}`);
    });
    expect(router.state.location.search).toEqual({ tab: 'consent' });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe('/api/v1/personas');
    expect(sentJson(post?.[1])).toMatchObject({
      eirProfileId: NOOR_EIR,
      name: "Noor's vEIR",
      doctrine: { summary: 'Hardware founders prove manufacturability before scale.' },
      allowedModes: ['diagnose', 'challenge', 'coach', 'teach', 'rehearse', 'route'],
    });
  });

  it('refuses a name founders could take for the EIR in person', async () => {
    const { fetchMock } = mockApi();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: 'EIR' }));
    await user.click(screen.getByRole('option', { name: 'Noor Example' }));
    const name = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.paste('Noor Example');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      screen.getByText("Include “vEIR” so founders never take it for Noor, e.g. Noor's vEIR."),
    ).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'New vEIR' })).toBeVisible();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});
