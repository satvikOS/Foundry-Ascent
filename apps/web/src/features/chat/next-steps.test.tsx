import type { NextAction } from '@foundry/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { NextStepList, type NextActionControls } from './next-steps';

const ACTIONS: NextAction[] = [
  { owner: 'founder', action: 'Ask three buyers for a paid commitment.', target_date: '2026-10-23' },
];

describe('NextStepList', () => {
  it('hands keyboard focus to "In actions" when Add to actions succeeds', async () => {
    const onAdd = vi.fn();
    const controls = (saved: number[]): NextActionControls => ({
      saved: new Set(saved),
      savingIndex: null,
      onAdd,
    });
    const { rerender } = render(<NextStepList actions={ACTIONS} controls={controls([])} />);
    const user = userEvent.setup();
    screen.getByRole('button', { name: 'Add to actions' }).focus();
    await user.keyboard('{Enter}');
    expect(onAdd).toHaveBeenCalledWith(ACTIONS[0], 0);
    rerender(<NextStepList actions={ACTIONS} controls={controls([0])} />);
    expect(screen.getByText('In actions').closest('span')).toHaveFocus();
  });

  it('never takes focus for a step already in actions when the page loads', () => {
    render(<NextStepList actions={ACTIONS} controls={{ saved: new Set([0]), savingIndex: null }} />);
    expect(screen.getByText('In actions').closest('span')).not.toHaveFocus();
  });
});
