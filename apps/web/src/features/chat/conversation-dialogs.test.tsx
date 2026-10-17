import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/features/admin/shared/test-utils';

import { IDS } from '../coach/testing';
import { DeleteConversationDialog } from './conversation-dialogs';

describe('DeleteConversationDialog', () => {
  it('says plainly what deleting erases, and that memory the founder edited stays', async () => {
    renderWithProviders(
      <DeleteConversationDialog
        session={{ id: IDS.session, ventureId: IDS.venture }}
        open
        onOpenChange={vi.fn()}
      />,
    );
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this conversation?' });
    // The server erases what the vEIR drew only from this conversation, never what a person edited or kept:
    // the dialog promises no more than that.
    expect(dialog).toHaveAccessibleDescription(
      'Erases its messages, summary and anything remembered only from it. Memory you edited stays. This can’t be undone.',
    );
  });
});
