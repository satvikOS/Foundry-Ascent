import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '@/features/admin/shared/test-utils';

import { IDS } from '../coach/testing';
import { MessageActions } from './message-actions';

describe('MessageActions', () => {
  it('starts every "What was wrong?" report empty, however the last one was closed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MessageActions turnId={IDS.turn} copyText="Answer" canRate pinned />);

    await user.click(screen.getByRole('button', { name: 'Bad answer' }));
    let dialog = screen.getByRole('dialog', { name: 'What was wrong?' });
    await user.click(within(dialog).getByRole('button', { name: 'Too generic' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Details' }), 'Missed the pilot');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Bad answer' }));
    dialog = screen.getByRole('dialog', { name: 'What was wrong?' });
    expect(within(dialog).getByRole('button', { name: 'Too generic' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(within(dialog).getByRole('textbox', { name: 'Details' })).toHaveValue('');
  });
});
