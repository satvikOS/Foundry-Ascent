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

  it('shows the rating the person gave before (kept by the server) instead of the thumbs', () => {
    const { unmount } = renderWithProviders(
      <MessageActions turnId={IDS.turn} copyText="Answer" canRate pinned myRating={5} />,
    );
    expect(screen.getByRole('img', { name: 'You rated this a good answer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Good answer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bad answer' })).toBeNull();
    unmount();

    renderWithProviders(<MessageActions turnId={IDS.turn} copyText="Answer" canRate pinned myRating={1} />);
    expect(screen.getByRole('img', { name: 'You rated this a bad answer' })).toBeInTheDocument();
  });

  it('offers the thumbs for an answer not rated yet, and none to people who cannot rate', () => {
    const { unmount } = renderWithProviders(
      <MessageActions turnId={IDS.turn} copyText="Answer" canRate pinned myRating={null} />,
    );
    expect(screen.getByRole('button', { name: 'Good answer' })).toBeInTheDocument();
    unmount();
    renderWithProviders(
      <MessageActions turnId={IDS.turn} copyText="Answer" canRate={false} pinned myRating={5} />,
    );
    expect(screen.queryByRole('img', { name: /You rated/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Good answer' })).toBeNull();
  });
});
