import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bodyOf, json, renderWithRouter, stubFetch, testQueryClient } from '@/features/knowledge/test-utils';
import { queryKeys } from '@/lib/api/query-keys';

import { IntakeCard } from './intake-card';
import { EMPTY_INTAKE, intakeOf } from './intake-form';
import { makeIntake, makePath, PATH_IDS } from './testing';

const V = PATH_IDS.venture;

async function renderCard(path: ReturnType<typeof makePath> | null, enabled = true) {
  const client = testQueryClient();
  client.setQueryData(queryKeys.venture.path(V), path);
  return renderWithRouter(
    <>
      <textarea aria-label="Message Thomas" />
      <IntakeCard ventureId={V} personaName="Thomas" enabled={enabled} />
    </>,
    client,
  );
}

let fetchMock: ReturnType<typeof stubFetch>;
beforeEach(() => {
  window.localStorage.clear();
  fetchMock = stubFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('IntakeCard', () => {
  it('asks once, in one row: six short fields behind Start, never taking focus or the composer', async () => {
    await renderCard(makePath({ intake: null }));
    const card = screen.getByRole('region', { name: 'About you' });
    expect(card).toHaveTextContent('Help Thomas plan with you.');
    expect(document.activeElement).toBe(document.body);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Start' }));
    const labels = [...card.querySelectorAll('label, [id$="-experience"]')].map((label) => label.textContent);
    expect(labels).toEqual([
      'Your idea, in a sentence',
      'Who it is for',
      'What you study',
      'Building a venture',
      'Hours a week',
      'Next deadline',
    ]);
    // Typing to the mentor goes on as ever.
    await user.type(screen.getByRole('textbox', { name: 'Message Thomas' }), 'Hello');
    expect(screen.getByRole('textbox', { name: 'Message Thomas' })).toHaveValue('Hello');
  });

  it('saves what was filled in, the rest left empty', async () => {
    fetchMock.mockResolvedValue(json(makePath({ intake: makeIntake() })));
    await renderCard(makePath({ intake: null }));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await user.type(screen.getByRole('textbox', { name: 'Your idea, in a sentence' }), 'Reagent tracking');
    await user.click(screen.getByRole('button', { name: 'First time' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
        expectedVersion: 7,
        intake: { ...EMPTY_INTAKE, idea: 'Reagent tracking', experience: 'first_time' },
      });
    });
    expect(await screen.findByText('Saved. Edit it in Your path.')).toBeInTheDocument();
  });

  it('Skip puts it away for good in this browser and saves nothing', async () => {
    const { unmount } = await renderCard(makePath({ intake: null }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Skip' }));
    expect(screen.queryByRole('region', { name: 'About you' })).toBeNull();
    unmount();
    await renderCard(makePath({ intake: null }));
    expect(screen.queryByRole('region', { name: 'About you' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not ask again once there is an intake, without a path, or where it does not belong', async () => {
    const first = await renderCard(makePath());
    expect(screen.queryByRole('region', { name: 'About you' })).toBeNull();
    first.unmount();
    const second = await renderCard(null);
    expect(screen.queryByRole('region', { name: 'About you' })).toBeNull();
    second.unmount();
    await renderCard(makePath({ intake: null }), false);
    expect(screen.queryByRole('region', { name: 'About you' })).toBeNull();
  });
});

describe('intakeOf', () => {
  const draft = {
    ...EMPTY_INTAKE,
    hours: '',
    deadlineWhat: '',
    deadlineOn: '',
  };

  it('takes a deadline whole or not at all, and hours within a week', () => {
    expect(intakeOf(draft)).toEqual({ intake: EMPTY_INTAKE });
    expect(intakeOf({ ...draft, deadlineWhat: 'Pitch night' })).toEqual({ error: 'deadline' });
    expect(intakeOf({ ...draft, deadlineOn: '2026-12-10' })).toEqual({ error: 'deadline' });
    expect(intakeOf({ ...draft, hours: '90' })).toEqual({ error: 'hours' });
    expect(intakeOf({ ...draft, hours: '8', deadlineWhat: 'Pitch night', deadlineOn: '2026-12-10' })).toEqual(
      {
        intake: { ...EMPTY_INTAKE, hoursPerWeek: 8, deadline: { what: 'Pitch night', on: '2026-12-10' } },
      },
    );
  });
});
