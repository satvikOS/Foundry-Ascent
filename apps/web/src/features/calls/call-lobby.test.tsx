import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CALL_ELSEWHERE_MESSAGE } from '@/lib/realtime/call-api';

import { CallLobby } from './call-lobby';
import { fakeEngine, renderWithRouter } from './testing';
import type { CallVeir } from './use-call-veir';

const VEIR: CallVeir = {
  name: "Corin's vEIR",
  kind: 'eir_persona',
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
        onStart={vi.fn()}
        onRetry={onRetry}
        onMoveHere={onMoveHere}
        onClose={onClose}
      />,
    );
    expect(await screen.findByRole('heading', { name: 'You’re already in a call' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Move it here?');
    const move = screen.getByRole('button', { name: 'Move the call here' });
    expect(move).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await userEvent.click(move);
    expect(onMoveHere).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    // The disclosure travels with every call view.
    expect(screen.getByRole('note', { name: 'AI disclosure' })).toHaveTextContent("Corin's vEIR is an AI");
  });
});
