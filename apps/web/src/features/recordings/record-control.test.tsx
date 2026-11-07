import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/features/admin/shared/test-utils';

import { RecordControl, RecordingMark } from './record-control';
import { acknowledgeRecordingNotice } from './recording-notice-store';
import type { RecordingSession, RecordingState } from './recording-session';

function fakeSession(initial: RecordingState = { status: 'idle' }, options: { limited?: boolean } = {}) {
  let state = initial;
  const listeners = new Set<() => void>();
  const start = vi.fn(() => {
    state = {
      status: 'recording',
      callId: 'c',
      startedAt: Date.now() - 65_000,
      capture: 'screen',
      note: null,
    };
    for (const listener of [...listeners]) listener();
  });
  const stop = vi.fn(() => Promise.resolve());
  const session = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    limitReached: () => options.limited ?? false,
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
    // jsdom cannot share a screen: the call view is recorded, as on a phone.
    expect(notice).toHaveTextContent(
      'The call view is recorded: Thomas’s AI avatar, the conversation and both voices.',
    );
    expect(notice).toHaveTextContent('Only you can watch it.');
    expect(start).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(start).toHaveBeenCalledOnce();
    // Its name is what it shows (label in name, WCAG 2.5.3); the time is described in words.
    const stopButton = await screen.findByRole('button', { name: /^1:0\d ?Stop recording$/ });
    expect(stopButton).toHaveAccessibleDescription(/^1 minute \d seconds? recorded$/);
    expect(stopButton).toHaveTextContent(/^1:0\d Stop/);
    expect(stopButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('recording-indicator')).toHaveTextContent(/^REC1:0\d/);
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

  it('says the tab is recorded where the browser can share it, and cancels while the browser asks', async () => {
    // A browser that can share this tab and tell it is this tab once shared (Chromium, Edge).
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia: vi.fn(), setCaptureHandleConfig: vi.fn() },
    });
    try {
      const user = userEvent.setup();
      const { session, start } = fakeSession();
      const first = renderWithProviders(
        <RecordControl session={session} blocker={null} principalId="p-screen" name="Thomas" video={false} />,
      );
      await user.click(screen.getByRole('button', { name: 'Record' }));
      expect(await screen.findByRole('alertdialog', { name: 'Record this call?' })).toHaveTextContent(
        'This tab is recorded as you see it, with both voices. Minimized, only the call view is. Your browser asks you to share the tab first.',
      );
      await user.click(screen.getByRole('button', { name: 'Not now' }));
      expect(start).not.toHaveBeenCalled();

      first.unmount();
      const asking = fakeSession({ status: 'starting' });
      renderWithProviders(
        <RecordControl
          session={asking.session}
          blocker={null}
          principalId="p-screen"
          name="Thomas"
          video={false}
        />,
      );
      // Cancel: nothing has started, and nothing will (a prompt left unanswered never holds Record).
      const control = screen.getByRole('button', { name: 'Cancel the recording' });
      expect(control).not.toHaveAttribute('aria-disabled');
      expect(control).toHaveTextContent('Cancel');
      await user.click(control);
      expect(asking.stop).toHaveBeenCalledOnce();
      expect(asking.start).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(navigator, 'mediaDevices');
    }
  });

  it('says the call view is recorded where the browser shares windows and screens but never just this tab', async () => {
    // Firefox and Safari: getDisplayMedia, but no way to tell a capture of this tab, so no screen is asked for.
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia: vi.fn() },
    });
    try {
      const user = userEvent.setup();
      const { session } = fakeSession();
      renderWithProviders(
        <RecordControl session={session} blocker={null} principalId="p-window" name="Thomas" video={false} />,
      );
      await user.click(screen.getByRole('button', { name: 'Record' }));
      expect(await screen.findByRole('alertdialog', { name: 'Record this call?' })).toHaveTextContent(
        'The call view is recorded: the call’s sphere, the conversation and both voices.',
      );
    } finally {
      Reflect.deleteProperty(navigator, 'mediaDevices');
    }
  });

  it('waits for a take whose save failed to be saved or discarded before another starts', async () => {
    acknowledgeRecordingNotice('p-unsaved');
    const user = userEvent.setup();
    const { session, start } = fakeSession({
      status: 'failed',
      title: 'The recording wasn’t saved',
      message: 'The connection dropped while it was saving.',
      canRetry: true,
    });
    renderWithProviders(
      <RecordControl session={session} blocker={null} principalId="p-unsaved" name="Thomas" video={false} />,
    );
    const record = screen.getByRole('button', { name: 'Record' });
    expect(record).toHaveAttribute('aria-disabled', 'true');
    expect(record).toHaveAccessibleDescription('Save or discard the last recording first.');
    await user.click(record);
    expect(start).not.toHaveBeenCalled();
  });

  it('offers no Record once today’s recordings are used up', async () => {
    acknowledgeRecordingNotice('p-limited');
    const user = userEvent.setup();
    const { session, start } = fakeSession({ status: 'idle' }, { limited: true });
    renderWithProviders(
      <RecordControl session={session} blocker={null} principalId="p-limited" name="Thomas" video={false} />,
    );
    const record = screen.getByRole('button', { name: 'Record' });
    expect(record).toHaveAttribute('aria-disabled', 'true');
    expect(record).toHaveAccessibleDescription('You’ve saved as many recordings as you can today.');
    await user.click(record);
    expect(start).not.toHaveBeenCalled();
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
