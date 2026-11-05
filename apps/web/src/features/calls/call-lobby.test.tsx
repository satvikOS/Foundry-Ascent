import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CALL_ELSEWHERE_MESSAGE } from '@/lib/realtime/call-api';

import { CallLobby } from './call-lobby';
import { fakeEngine, renderWithRouter } from './testing';
import type { CallVeir } from './use-call-veir';

const VEIR: CallVeir = {
  name: 'Corin · vEIR',
  shortName: 'Corin',
  badge: 'vEIR',
  kind: 'eir_persona',
  eirFirstName: 'Corin',
  firstPerson: true,
  eirSeesWork: true,
  disclosure: "You are talking with Corin's vEIR, an AI coach. It is not a person.",
  portraitUrl: null,
  provider: 'builtin',
};

describe('CallLobby', () => {
  it('asks before moving a call that is live in another conversation, and never offers Try again', async () => {
    const { asEngine } = fakeEngine();
    const onMoveHere = vi.fn();
    const onClose = vi.fn();
    const onRetry = vi.fn();
    renderWithRouter(
      <CallLobby
        engine={asEngine}
        veir={VEIR}
        config={undefined}
        blocker={null}
        failure={{ message: CALL_ELSEWHERE_MESSAGE, retry: false, elsewhere: true }}
        busy={false}
        voiceNotice={false}
        welcome={null}
        privacy={null}
        onStart={vi.fn()}
        onRetry={onRetry}
        onMoveHere={onMoveHere}
        onClose={onClose}
      />,
    );
    expect(await screen.findByRole('heading', { name: 'You’re already in a call' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Move it here?');
    const move = screen.getByRole('button', { name: 'Move here, ending the other call' });
    expect(move).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await userEvent.click(move);
    expect(onMoveHere).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    // No disclaimer line: the tile's name tag carries the vEIR badge.
    expect(screen.queryByRole('note', { name: 'AI disclosure' })).toBeNull();
    expect(screen.getByRole('button', { name: 'vEIR: what is Corin · vEIR?' })).toBeInTheDocument();
  });

  it('says what a vEIR is before a first meeting, beside how voice is handled', async () => {
    const { asEngine } = fakeEngine();
    renderWithRouter(
      <CallLobby
        engine={asEngine}
        veir={VEIR}
        config={undefined}
        blocker={null}
        failure={null}
        busy={false}
        voiceNotice
        welcome={{
          title: 'Meet Corin’s vEIR',
          lines: [
            'Corin’s digital twin: an AI built with Corin’s consent from how Corin coaches.',
            'Corin sees what you work on here.',
          ],
        }}
        privacy={null}
        onStart={vi.fn()}
        onRetry={vi.fn()}
        onMoveHere={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const welcome = await screen.findByTestId('veir-welcome-inline');
    expect(welcome).toHaveTextContent('Corin’s digital twin: an AI built with Corin’s consent');
    expect(welcome).toHaveTextContent('Corin sees what you work on here.');
    expect(screen.getByTestId('voice-notice')).toHaveTextContent('Amazon Transcribe');
  });

  it('offers Remember (preselected) or Private before a call that starts a new conversation', async () => {
    const { asEngine } = fakeEngine();
    const onChange = vi.fn();
    const onStart = vi.fn();
    renderWithRouter(
      <CallLobby
        engine={asEngine}
        veir={VEIR}
        config={undefined}
        blocker={null}
        failure={null}
        busy={false}
        voiceNotice
        welcome={null}
        privacy={{ value: 'standard', onChange }}
        onStart={onStart}
        onRetry={vi.fn()}
        onMoveHere={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const group = await screen.findByRole('group', { name: 'Memory for this call' });
    const remember = within(group).getByRole('radio', { name: 'Remember this call' });
    expect(remember).toBeChecked();
    expect(group).toHaveAccessibleDescription('Remembered for next time.');
    await userEvent.click(within(group).getByRole('radio', { name: 'Private, a one-off' }));
    expect(onChange).toHaveBeenCalledWith('ephemeral');
  });

  it('offers no choice for a call in an existing conversation, which keeps its own', async () => {
    const { asEngine } = fakeEngine();
    renderWithRouter(
      <CallLobby
        engine={asEngine}
        veir={VEIR}
        config={undefined}
        blocker={null}
        failure={null}
        busy={false}
        voiceNotice={false}
        welcome={null}
        privacy={null}
        onStart={vi.fn()}
        onRetry={vi.fn()}
        onMoveHere={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByRole('heading', { name: 'Call Corin · vEIR' })).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});
