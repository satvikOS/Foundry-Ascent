import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/features/admin/shared/test-utils';

import { RecordControl, RecordingMark, recordingClock } from './record-control';
import { acknowledgeRecordingNotice } from './recording-notice-store';
import type { RecordingSession, RecordingState } from './recording-session';

function fakeSession(initial: RecordingState = { status: 'idle' }) {
  let state = initial;
  const listeners = new Set<() => void>();
  const start = vi.fn(() => {
    state = { status: 'recording', callId: 'c', startedAt: Date.now() - 65_000 };
    for (const listener of [...listeners]) listener();
  });
  const stop = vi.fn(() => Promise.resolve());
  const session = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    start,
    stop,
  } as unknown as RecordingSession;
  return { session, start, stop };
}

describe('RecordControl', () => {
  it('asks once before the first recording, then records and offers Stop with its time', async () => {
    const user = userEvent.setup();
    const { session, start, stop } = fakeSession();
    renderWithProviders(
      <>
        <RecordControl session={session} blocker={null} principalId="p-first" name="Thomas" video />
        <RecordingMark session={session} />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Record' }));
    const notice = await screen.findByRole('alertdialog', { name: 'Record this call?' });
    expect(notice).toHaveTextContent('Both voices, Thomas’s AI avatar and the captions are recorded.');
    expect(notice).toHaveTextContent('Only you can watch it.');
    expect(start).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(start).toHaveBeenCalledOnce();
    const stopButton = await screen.findByRole('button', {
      name: /^Stop recording, 1 minute 5 seconds recorded$/,
    });
    expect(stopButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('recording-indicator')).toHaveTextContent('REC1:05');
    await user.click(stopButton);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('records at once once the notice was read', async () => {
    acknowledgeRecordingNotice('p-again');
    const user = userEvent.setup();
    const { session, start } = fakeSession();
    renderWithProviders(
      <RecordControl session={session} blocker={null} principalId="p-again" name="Thomas" video={false} />,
    );
    await user.click(screen.getByRole('button', { name: 'Record' }));
    expect(start).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('keeps the control on a private call, disabled, with the reason', async () => {
    const user = userEvent.setup();
    const { session, start } = fakeSession();
    renderWithProviders(
      <RecordControl
        session={session}
        blocker="private"
        principalId="p-private"
        name="Thomas"
        video={false}
      />,
    );
    const record = screen.getByRole('button', { name: 'Record' });
    expect(record).toHaveAttribute('aria-disabled', 'true');
    expect(record).toHaveAccessibleDescription('Private calls aren’t recorded.');
    await user.click(record);
    expect(start).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('recordingClock', () => {
  it('writes a length as m:ss, or h:mm:ss past an hour', () => {
    expect(recordingClock(0)).toBe('0:00');
    expect(recordingClock(65.9)).toBe('1:05');
    expect(recordingClock(3_725)).toBe('1:02:05');
  });
});
