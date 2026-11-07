import type { RecordingView } from '@foundry/contracts';
import type * as Router from '@tanstack/react-router';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/features/admin/shared/test-utils';

import { RecordingSaveStatus } from './recording-save-status';
import type { RecordingSession, RecordingState } from './recording-session';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof Router>()),
  useNavigate: () => navigate,
}));

function fakeSession(initial: RecordingState) {
  let state = initial;
  const listeners = new Set<() => void>();
  const set = (next: RecordingState) => {
    act(() => {
      state = next;
      for (const listener of [...listeners]) listener();
    });
  };
  const retry = vi.fn(() => {
    set({ status: 'saving', percent: 0 });
    return Promise.resolve();
  });
  const dismiss = vi.fn(() => {
    set({ status: 'idle' });
  });
  const session = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    retry,
    dismiss,
  } as unknown as RecordingSession;
  return { session, set, retry, dismiss };
}

const SAVED = {
  id: '55555555-5555-4555-8555-555555555555',
  ventureId: '33333333-3333-4333-8333-333333333333',
} as RecordingView;

describe('RecordingSaveStatus (in the call screen, never a toast over it)', () => {
  it('shows nothing while idle or recording, then the save with its progress', () => {
    const { session, set } = fakeSession({ status: 'idle' });
    const { container } = renderWithProviders(<RecordingSaveStatus session={session} tenant="ain" />);
    expect(container).toBeEmptyDOMElement();
    set({ status: 'recording', callId: 'c', startedAt: 0 });
    expect(container).toBeEmptyDOMElement();
    set({ status: 'saving', percent: 42 });
    expect(screen.getByText(/Saving the recording…/)).toHaveTextContent('Saving the recording… 42%');
  });

  it('Watch opens the saved recording in Recordings and clears the notice', async () => {
    const user = userEvent.setup();
    const { session, dismiss } = fakeSession({ status: 'saved', recording: SAVED });
    renderWithProviders(<RecordingSaveStatus session={session} tenant="ain" />);
    expect(screen.getByRole('group', { name: 'Recording saved' })).toHaveTextContent(
      'Only you can watch it.',
    );
    await user.click(screen.getByRole('button', { name: 'Watch' }));
    expect(navigate).toHaveBeenCalledWith({
      to: '/$tenant/app/v/$ventureId/recordings',
      params: { tenant: 'ain', ventureId: SAVED.ventureId },
      search: { r: SAVED.id },
    });
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('a failed save offers Try again and Discard; a failure with nothing to save only Dismiss', async () => {
    const user = userEvent.setup();
    const { session, set, retry, dismiss } = fakeSession({
      status: 'failed',
      title: 'The recording wasn’t saved',
      message: 'The connection dropped while it was saving.',
      canRetry: true,
    });
    renderWithProviders(<RecordingSaveStatus session={session} tenant="ain" />);
    expect(screen.getByRole('group', { name: 'The recording wasn’t saved' })).toHaveTextContent(
      'The connection dropped while it was saving.',
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
    set({ status: 'failed', title: 'The recording wasn’t saved', message: 'x', canRetry: true });
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(dismiss).toHaveBeenCalledOnce();
    set({
      status: 'failed',
      title: 'The recording didn’t start',
      message: 'The call isn’t live.',
      canRetry: false,
    });
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(dismiss).toHaveBeenCalledTimes(2);
  });
});
