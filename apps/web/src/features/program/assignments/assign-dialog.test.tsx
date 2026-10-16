import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderWithProviders, sentJson, stubFetch } from '@/features/admin/shared/test-utils';
import { eirProfile, GUIDE, IDS, persona, RUTH } from '@/features/eir/personas/test-fixtures';
import type { ProgramVenture } from '@/lib/api/hooks/program';

import { AssignDialog } from './assign-dialog';

const QUIETQUAD: ProgramVenture = {
  id: IDS.venture,
  name: 'QuietQuad',
  stage: 'discovery',
  domain: 'consumer',
  status: 'active',
  memberCount: 2,
  personaName: "Corin's vEIR",
  personaId: IDS.corin,
  reviewingEir: { id: IDS.corinEir, displayName: 'Corin Halvorsen' },
  assignedAt: '2026-10-16T09:00:00.000Z',
  createdAt: '2026-10-01T09:00:00.000Z',
};

const SUSPENDED = persona({
  id: '11111111-2222-4333-8444-555555555555',
  name: "Noor's vEIR",
  status: 'suspended',
});

const PROFILES = [
  eirProfile(IDS.corinEir, 'Corin Halvorsen'),
  eirProfile(IDS.ruthEir, 'Ruth Abernathy-Song'),
];

function renderDialog(onClose = vi.fn()) {
  renderWithProviders(
    <AssignDialog
      venture={QUIETQUAD}
      personas={[GUIDE, persona(), RUTH, SUSPENDED]}
      eirProfiles={PROFILES}
      onClose={onClose}
    />,
  );
  return onClose;
}

describe('AssignDialog (vEIRs & assignments)', () => {
  it('starts on the current vEIR, lists only assignable ones and has nothing to save', async () => {
    const user = userEvent.setup();
    renderDialog();
    const veir = screen.getByRole('combobox', { name: 'vEIR' });
    expect(veir).toHaveTextContent("Corin's vEIR");
    expect(screen.getByText('Corin Halvorsen, the EIR it’s built from.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Assign' })).toBeDisabled();
    await user.click(veir);
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Foundry Guide', "Corin's vEIR", "Ruth's vEIR"]);
  });

  it('assigns another vEIR with its own EIR as reviewer', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse({ ...QUIETQUAD, personaId: IDS.ruth, personaName: "Ruth's vEIR", reviewingEir: null }),
    );
    const user = userEvent.setup();
    const onClose = renderDialog();
    await user.click(screen.getByRole('combobox', { name: 'vEIR' }));
    await user.click(screen.getByRole('option', { name: "Ruth's vEIR" }));
    expect(screen.getByText('Ruth Abernathy-Song, the EIR it’s built from.')).toBeVisible();
    expect(screen.getByText("Open conversations with Corin's vEIR end at their next message.")).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Assign' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/ventures/${IDS.venture}/assignment`);
    expect(init?.method).toBe('POST');
    expect(sentJson(init)).toEqual({ personaId: IDS.ruth, eirProfileId: IDS.ruthEir });
  });

  it('warns that a reviewer-only change also ends open conversations', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AssignDialog
        venture={{
          ...QUIETQUAD,
          personaId: IDS.guide,
          personaName: 'Foundry Guide',
          reviewingEir: { id: IDS.ruthEir, displayName: 'Ruth Abernathy-Song' },
        }}
        personas={[GUIDE, persona(), RUTH]}
        eirProfiles={PROFILES}
        onClose={vi.fn()}
      />,
    );
    const warning = 'Open conversations with Foundry Guide end at their next message.';
    expect(screen.queryByText(warning)).toBeNull();
    await user.click(screen.getByRole('combobox', { name: 'Reviewed by' }));
    await user.click(screen.getByRole('option', { name: 'Corin Halvorsen' }));
    expect(screen.getByText(warning)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Assign' })).toBeEnabled();
  });

  it('lets the program guide be reviewed by a chosen EIR or by nobody', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ ...QUIETQUAD, personaId: IDS.guide, reviewingEir: null }));
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('combobox', { name: 'vEIR' }));
    await user.click(screen.getByRole('option', { name: 'Foundry Guide' }));
    const reviewer = screen.getByRole('combobox', { name: 'Reviewed by' });
    expect(reviewer).toHaveTextContent('Corin Halvorsen');
    await user.click(reviewer);
    await user.click(screen.getByRole('option', { name: 'Nobody' }));
    await user.click(screen.getByRole('button', { name: 'Assign' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(sentJson(fetchMock.mock.calls[0]?.[1])).toEqual({ personaId: IDS.guide, eirProfileId: null });
  });

  it('shows why an assignment was refused', async () => {
    stubFetch().mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          code: 'conflict',
          detail: 'Only an active persona can be assigned',
          requestId: 'req-9',
        }),
        { status: 409, headers: { 'content-type': 'application/problem+json' } },
      ),
    );
    const user = userEvent.setup();
    const onClose = renderDialog();
    await user.click(screen.getByRole('combobox', { name: 'vEIR' }));
    await user.click(screen.getByRole('option', { name: "Ruth's vEIR" }));
    await user.click(screen.getByRole('button', { name: 'Assign' }));
    expect(await screen.findByText('Not assigned')).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });
});
