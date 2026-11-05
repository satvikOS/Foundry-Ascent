import type { CallConfigResponse } from '@foundry/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CALL_ELSEWHERE_MESSAGE } from '@/lib/realtime/call-api';
import { IDS } from '@/lib/realtime/testing';

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

const CONFIG = {
  veir: {
    personaId: IDS.persona,
    name: "Corin's vEIR",
    shortName: 'Corin',
    kind: 'eir_persona',
    eirDisplayName: 'Corin Halvorsen',
    tagline: null,
    disclosure: 'AI',
    embodiment: {
      provider: 'builtin',
      voiceId: null,
      portraitUrl: null,
      voiceConsented: false,
      likenessConsented: false,
    },
  },
  provider: 'builtin',
  maxMinutes: 20,
  remainingMinutesToday: 14.6,
  aiEnabled: true,
  callsEnabled: true,
} as unknown as CallConfigResponse;

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
    // Not now is the screen's chevron (top left, CallScreen): nothing here but the one way forward.
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
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

  it('is the idle voice surface: the sphere, one status line, and Start call in the microphone’s place', async () => {
    const { asEngine } = fakeEngine();
    const onStart = vi.fn();
    renderWithRouter(
      <CallLobby
        engine={asEngine}
        veir={VEIR}
        config={CONFIG}
        blocker={null}
        failure={null}
        busy={false}
        voiceNotice={false}
        welcome={null}
        privacy={null}
        onStart={onStart}
        onRetry={vi.fn()}
        onMoveHere={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const start = await screen.findByRole('button', { name: 'Start call' });
    expect(start).toHaveFocus();
    expect(document.querySelector('[data-slot="call-stage"]')).toHaveAttribute('data-state', 'idle');
    expect(screen.getByRole('status')).toHaveTextContent('Up to 20 min · 14 left today');
    // No separate "Call Corin" page: the name tag under the sphere names the call, as during it.
    expect(screen.queryByRole('heading')).toBeNull();
    expect(document.querySelector('[data-slot="call-name-tag"]')).toHaveTextContent('CorinvEIR');
    expect(screen.getByRole('button', { name: 'Call settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
    await userEvent.click(start);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('offers Remember (preselected) or Private in the settings, and says which under the status', async () => {
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
    const memory = await screen.findByRole('button', {
      name: 'Remembered: change memory for this call',
    });
    expect(memory).toHaveTextContent('Remembered');
    await userEvent.click(memory);
    const settings = await screen.findByRole('dialog', { name: 'Call settings' });
    const group = within(settings).getByRole('group', { name: 'Memory for this call' });
    const remember = within(group).getByRole('radio', { name: 'Remember this call' });
    expect(remember).toBeChecked();
    expect(group).toHaveAccessibleDescription('Conversation saved. Memory needs approval.');
    await userEvent.click(within(group).getByRole('radio', { name: 'Private, a one-off' }));
    expect(onChange).toHaveBeenCalledWith('ephemeral');
    // Closing the settings returns to the line that opened them.
    await userEvent.keyboard('{Escape}');
    expect(memory).toHaveFocus();
    expect(onStart).not.toHaveBeenCalled();
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
    expect(await screen.findByRole('button', { name: 'Start call' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /: change memory for this call$/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Call settings' }));
    const settings = await screen.findByRole('dialog', { name: 'Call settings' });
    expect(within(settings).queryByRole('radio')).toBeNull();
    // Before the call: no live-only controls in the settings.
    expect(within(settings).queryByRole('button', { name: 'Switch to chat' })).toBeNull();
    expect(within(settings).getByRole('button', { name: /^Push to talk/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});
