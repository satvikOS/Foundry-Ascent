import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CallSnapshot } from '@/lib/realtime/call-engine';

import { callStatusLabel, CallLive } from './call-live';
import { fakeEngine, LIVE, renderWithRouter } from './testing';
import type { CallVeir } from './use-call-veir';

const VEIR: CallVeir = {
  name: "Corin's vEIR",
  shortName: 'Corin',
  kind: 'eir_persona',
  disclosure: "You are talking with Corin's vEIR, an AI coach. It is not a person.",
  portraitUrl: null,
  provider: 'builtin',
};

function renderLive(snapshot: Partial<CallSnapshot> = {}) {
  const { engine, asEngine } = fakeEngine();
  let switched = 0;
  renderWithRouter(
    <CallLive
      engine={asEngine}
      snapshot={{ ...LIVE, ...snapshot }}
      veir={VEIR}
      onSwitchToChat={() => {
        switched += 1;
      }}
    />,
  );
  return { engine, switched: () => switched };
}

beforeEach(() => {
  window.localStorage.clear();
  // jsdom has no pointer capture; the hold-to-talk button captures the pointer while held.
  if (!('setPointerCapture' in Element.prototype)) {
    Object.defineProperty(Element.prototype, 'setPointerCapture', { writable: true, value: () => undefined });
  }
});

describe('callStatusLabel', () => {
  it('says what the call is doing in words', () => {
    expect(callStatusLabel({ ...LIVE, phase: 'starting' })).toBe('Connecting…');
    expect(callStatusLabel({ ...LIVE, reconnecting: true })).toBe('Reconnecting…');
    expect(callStatusLabel({ ...LIVE, muted: true })).toBe('Muted');
    expect(callStatusLabel({ ...LIVE, activity: 'thinking' })).toBe('Thinking…');
    expect(callStatusLabel({ ...LIVE, activity: 'speaking' })).toBe('Speaking');
    expect(callStatusLabel({ ...LIVE, input: 'typed' })).toBe('Type your reply');
    expect(callStatusLabel({ ...LIVE, talkMode: 'push_to_talk' })).toBe('Hold to talk');
    expect(callStatusLabel({ ...LIVE, talkMode: 'push_to_talk', talking: true })).toBe('Listening');
    expect(callStatusLabel(LIVE)).toBe('Listening');
    expect(callStatusLabel({ ...LIVE, phase: 'ending' })).toBe('Ending…');
  });
});

describe('CallLive', () => {
  it('shows the vEIR, its state, one AI disclosure and named controls', async () => {
    const { engine } = renderLive();
    expect(await screen.findByRole('heading', { name: /Corin/ })).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Listening');
    expect(screen.getAllByRole('note', { name: 'AI disclosure' })).toHaveLength(1);

    const controls = screen.getByRole('toolbar', { name: 'Call controls' });
    const names = within(controls)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['Mute', 'Push to talk', 'Captions', 'Type instead', 'Switch to chat', 'End call']);
    expect(within(controls).getByRole('button', { name: 'Captions' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await userEvent.click(within(controls).getByRole('button', { name: 'Mute' }));
    expect(engine.setMuted).toHaveBeenCalledWith(true);
    await userEvent.click(within(controls).getByRole('button', { name: 'End call' }));
    expect(engine.end).toHaveBeenCalledWith('user');
  });

  it('has keyboard shortcuts for mute, push-to-talk and captions', async () => {
    const { engine } = renderLive();
    await screen.findByRole('toolbar', { name: 'Call controls' });
    await userEvent.keyboard('m');
    expect(engine.setMuted).toHaveBeenCalledWith(true);
    await userEvent.keyboard('p');
    expect(engine.setTalkMode).toHaveBeenCalledWith('push_to_talk');
    await userEvent.keyboard('c');
    expect(screen.queryByRole('region', { name: 'Captions' })).toBeNull();
    expect(window.localStorage.getItem('fa.call.captions')).toBe('0');
  });

  it('shows live captions for both sides', async () => {
    renderLive({
      activity: 'speaking',
      captions: { veir: 'Twelve is a good start.', founder: 'We interviewed twelve', founderLive: true },
    });
    const captions = await screen.findByRole('region', { name: 'Captions' });
    expect(captions).toHaveTextContent('Corin: Twelve is a good start.');
    expect(captions).toHaveTextContent('YouWe interviewed twelve');
  });

  it('interrupts the vEIR while it speaks', async () => {
    const { engine } = renderLive({ activity: 'speaking' });
    await userEvent.click(await screen.findByRole('button', { name: 'Interrupt' }));
    expect(engine.interrupt).toHaveBeenCalled();
  });

  it('continues by typing when there is no voice input, and says why', async () => {
    const { engine } = renderLive({ input: 'typed', typedReason: 'mic_denied' });
    const line = await screen.findByRole('textbox', { name: 'Reply to Corin' });
    expect(line).toHaveFocus();
    expect(screen.getByText(/microphone is blocked/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mute' })).toBeNull();
    await userEvent.type(line, 'We interviewed twelve clinics{Enter}');
    expect(engine.sendText).toHaveBeenCalledWith('We interviewed twelve clinics');
    expect(line).toHaveValue('');
  });

  it('opens a typed line during a voice call', async () => {
    const { engine } = renderLive();
    await userEvent.click(await screen.findByRole('button', { name: 'Type instead' }));
    const line = screen.getByRole('textbox', { name: 'Reply to Corin' });
    expect(line).toHaveFocus();
    await userEvent.type(line, 'Quick note{Enter}');
    expect(engine.sendText).toHaveBeenCalledWith('Quick note');
  });

  it('holds to talk in push-to-talk mode', async () => {
    const { engine } = renderLive({ talkMode: 'push_to_talk' });
    const hold = await screen.findByRole('button', { name: 'Hold to talk' });
    fireEvent.pointerDown(hold, { pointerId: 1 });
    expect(engine.pushToTalk).toHaveBeenLastCalledWith(true);
    fireEvent.pointerUp(hold, { pointerId: 1 });
    expect(engine.pushToTalk).toHaveBeenLastCalledWith(false);
    fireEvent.keyDown(hold, { key: ' ' });
    expect(engine.pushToTalk).toHaveBeenLastCalledWith(true);
    fireEvent.keyUp(hold, { key: ' ' });
    expect(engine.pushToTalk).toHaveBeenLastCalledWith(false);
  });

  it('puts support first when a turn was blocked', async () => {
    const result = renderLive({
      notice: {
        kind: 'blocked',
        message: 'I can’t help with this on a call. Please look at the support below.',
        supportMessage: 'Call or text **988** any time.',
      },
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Call or text 988 any time.');
    await userEvent.click(within(alert).getByRole('button', { name: 'Switch to chat' }));
    expect(result.switched()).toBe(1);
  });

  it('disables the controls until the call is live', async () => {
    renderLive({ phase: 'starting', activity: 'connecting' });
    expect(await screen.findByRole('button', { name: 'Mute' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'End call' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('Connecting…');
  });
});
