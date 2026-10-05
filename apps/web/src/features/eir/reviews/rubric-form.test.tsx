import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/features/admin/shared/test-utils';
import type { SubmitReviewInput } from '@/lib/api/hooks/eir';

import { RUBRIC_CRITERIA } from './rubric';
import { RubricForm } from './rubric-form';

/*
 * These tests drive the form with synchronous DOM events instead of user-event. user-event waits a
 * macrotask between actions and re-checks `pointer-events` up the tree with getComputedStyle on every
 * click and keystroke, which made this file take ~14 s (and time out) on a loaded CI runner. Radix radios
 * select on `click`; react-hook-form validates asynchronously on submit, so each submit is awaited inside
 * `act` until the resolver has settled. No timers and no polling: the assertions are unchanged.
 */

function setup() {
  const onSubmit = vi.fn<(review: SubmitReviewInput) => void>();
  renderWithProviders(<RubricForm onSubmit={onSubmit} />);
  const submitButton = screen.getByRole('button', { name: /Submit review/ });
  const submit = async () => {
    await act(async () => {
      fireEvent.click(submitButton);
      // react-hook-form's handleSubmit awaits the zod resolver; flush it before React commits.
      await new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      });
    });
  };
  return { onSubmit, submit };
}

function group(label: string) {
  return screen.getByRole('radiogroup', { name: label });
}

function score(label: string, value: number) {
  act(() => {
    fireEvent.click(within(group(label)).getByRole('radio', { name: new RegExp(`^${String(value)} `) }));
  });
}

function notes() {
  return screen.getByLabelText(/Notes/);
}

describe('RubricForm validation', () => {
  it('requires every criterion and reports each missing score on its group', async () => {
    const { submit, onSubmit } = setup();
    await submit();

    expect(await screen.findByRole('alert')).toHaveTextContent('Score the 6 remaining criteria to submit.');
    for (const criterion of RUBRIC_CRITERIA) {
      const radios = group(criterion.label);
      expect(radios).toHaveAttribute('aria-invalid', 'true');
      const message = `Score ${criterion.label.toLowerCase()} from 1 to 5.`;
      expect(screen.getByText(message)).toBeVisible();
      // The error is referenced from the fieldset, so it is read with the group.
      const fieldset = radios.closest('fieldset');
      const errorId = screen.getByText(message).closest('p')?.id ?? 'missing';
      expect(fieldset?.getAttribute('aria-describedby')).toContain(errorId);
    }
    expect(onSubmit).not.toHaveBeenCalled();
    // Focus moves to the first invalid criterion.
    expect(within(group('Correctness')).getByRole('radio', { name: /^1 / })).toHaveFocus();
  });

  it('clears an error as soon as that criterion is scored', async () => {
    const { submit } = setup();
    await submit();
    expect(await screen.findByText('Score rigor from 1 to 5.')).toBeVisible();

    score('Rigor', 4);
    expect(await screen.findByRole('alert')).toHaveTextContent('Score the 5 remaining criteria to submit.');
    expect(screen.queryByText('Score rigor from 1 to 5.')).not.toBeInTheDocument();
  });

  it('submits all six scores with notes trimmed, or null when empty', async () => {
    const { submit, onSubmit } = setup();
    const scores = {
      correctness: 5,
      rigor: 4,
      specificity: 3,
      teachability: 2,
      personaFit: 1,
      escalation: 4,
    } as const;
    for (const criterion of RUBRIC_CRITERIA) score(criterion.label, scores[criterion.key]);

    await submit();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ scores, notes: null });

    fireEvent.change(notes(), { target: { value: '  Missed the IP risk.  ' } });
    await submit();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith({ scores, notes: 'Missed the IP risk.' });
  });

  it('labels each option with its number and anchor word', () => {
    setup();
    const options = within(group('Escalation')).getAllByRole('radio');
    expect(options).toHaveLength(5);
    expect(options[0]).toHaveAccessibleName('1 Poor');
    expect(options[4]).toHaveAccessibleName('5 Excellent');
  });

  it('rejects notes over 2,000 characters', async () => {
    const { submit, onSubmit } = setup();
    for (const criterion of RUBRIC_CRITERIA) score(criterion.label, 3);
    fireEvent.change(notes(), { target: { value: 'x'.repeat(2001) } });

    await submit();
    expect(await screen.findByText('Keep notes to 2,000 characters.')).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
