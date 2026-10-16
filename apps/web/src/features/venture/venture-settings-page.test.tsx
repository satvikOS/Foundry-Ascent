import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { bodyOf, json, renderWithRouter, stubFetch } from '@/features/knowledge/test-utils';
import { IDS, makeVenture } from '@/features/knowledge/testing';

import { VentureProfileCard } from './venture-settings-page';

let fetchMock: ReturnType<typeof stubFetch>;

beforeEach(() => {
  fetchMock = stubFetch();
});

function problem(status: number, code: string, detail: string, errors?: { path: string; message: string }[]) {
  return new Response(
    JSON.stringify({
      type: `urn:foundry-ascent:problem:${code}`,
      title: 'Conflict',
      status,
      code,
      detail,
      requestId: 'req-1',
      ...(errors ? { errors } : {}),
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

const TAKEN = 'Another venture in this program already uses this name.';

async function rename(to: string) {
  await renderWithRouter(<VentureProfileCard venture={makeVenture()} editable />);
  const user = userEvent.setup();
  const name = screen.getByRole('textbox', { name: /Name/ });
  await user.clear(name);
  await user.type(name, to);
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  return name;
}

describe('VentureProfileCard', () => {
  it('shows a name that is already taken on the Name field, not as a stale-page alert', async () => {
    fetchMock.mockResolvedValue(problem(409, 'conflict', TAKEN, [{ path: 'name', message: TAKEN }]));
    const name = await rename('SoleSignal');

    expect(await screen.findByText(TAKEN)).toBeVisible();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ name: 'SoleSignal' });
    // One message, on the field: nothing tells the founder to refresh (that would only drop the edit).
    expect(screen.queryByText(/Refresh and try again/)).toBeNull();
    expect(screen.queryByText('Couldn’t save the venture')).toBeNull();
  });

  it('keeps the form-level alert for a failure that names no field', async () => {
    fetchMock.mockResolvedValue(problem(409, 'conflict', 'The venture changed.'));
    await rename('QuietQuad Labs');

    expect(await screen.findByText('Couldn’t save the venture')).toBeVisible();
    expect(screen.getByText('This changed since you loaded it. Refresh and try again.')).toBeVisible();
  });

  it('clears the field-level refusal once a save goes through', async () => {
    fetchMock
      .mockResolvedValueOnce(problem(409, 'conflict', TAKEN, [{ path: 'name', message: TAKEN }]))
      .mockResolvedValueOnce(json(makeVenture({ id: IDS.venture, name: 'QuietQuad Study' })));
    const name = await rename('SoleSignal');
    expect(await screen.findByText(TAKEN)).toBeVisible();

    const user = userEvent.setup();
    await user.clear(name);
    await user.type(name, 'QuietQuad Study');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(screen.queryByText(TAKEN)).toBeNull();
    });
    expect(screen.queryByText('Couldn’t save the venture')).toBeNull();
  });
});
