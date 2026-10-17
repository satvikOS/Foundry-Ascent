import type { CallView } from '@foundry/contracts';
import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CallSnapshot } from '@/lib/realtime/call-engine';

import { IDS } from '@/lib/realtime/testing';

import { callStatusLabel, CallLive } from './call-live';
import { fakeEngine, LIVE, renderWithRouter } from './testing';
import type { CallVeir } from './use-call-veir';

const CALL: CallView = {
  id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c01',
  sessionId: IDS.session,
  ventureId: IDS.venture,
  personaId: IDS.persona,
  status: 'live',
  provider: 'builtin',
  inputMode: 'transcribe',
  startedAt: '2026-10-01T12:00:00.000Z',
  endedAt: null,
  endReason: null,
  maxSeconds: 1200,
  durationSeconds: null,
};

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

function renderLive(snapshot: Partial<CallSnapshot> = {}) {
  const { engine, asEngine } = fakeEngine();
  let switched = 0;
  renderWithRouter(
    <CallLive
      tenant="ain"
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

/** What the call's polite live regions say now. */
function liveText(): string[] {
  return [...document.querySelectorAll('[aria-live="polite"]')].map((element) => element.textContent);
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
    expect(callStatusLabel({ ...LIVE, activity: 'speaking', voice: 'captions' })).toBe('Replying on screen');
    expect(callStatusLabel({ ...LIVE, muted: true, held: true })).toBe('On hold');
    expect(callStatusLabel({ ...LIVE, input: 'typed' })).toBe('Your turn');
    expect(callStatusLabel({ ...LIVE, talkMode: 'push_to_talk' })).toBe('Hold to talk');
    expect(callStatusLabel({ ...LIVE, talkMode: 'push_to_talk', talking: true })).toBe('Listening');
    expect(callStatusLabel(LIVE)).toBe('Listening');
    expect(callStatusLabel({ ...LIVE, phase: 'ending' })).toBe('Ending…');
    // Audio the browser keeps silent (no gesture yet, an iOS interruption) is not "Speaking" or "Listening".
    for (const activity of ['speaking', 'listening'] as const) {
      expect(callStatusLabel({ ...LIVE, activity, audioBlocked: true })).toBe(
        'Sound is off. Turn on sound to hear replies.',
      );
    }
  });
});

describe('CallLive', () => {
  it('shows the vEIR as a call tile with its name tag, its state and named controls, and no disclaimer line', async () => {
    const { engine } = renderLive();
    const tag = await screen.findByRole('heading', { name: /Corin/ });
    expect(tag).toHaveFocus();
    // Like a video call's name tag: the EIR's first name and the vEIR badge, no "AI · Live voice" chip.
    expect(tag).toHaveTextContent(/^CorinvEIR$/);
    expect(tag.closest('[data-slot="call-tile"]')).not.toBeNull();
    expect(within(tag).getByRole('button', { name: 'vEIR: what is Corin · vEIR?' })).toBeInTheDocument();
    expect(screen.queryByText(/Live voice/)).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Listening');
    expect(screen.queryByRole('note', { name: 'AI disclosure' })).toBeNull();

    const controls = screen.getByRole('toolbar', { name: 'Call controls' });
    const names = within(controls)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    // A calm row: the rarer controls live under More.
    expect(names).toEqual(['Mute', 'Captions', 'More call controls', 'End call']);
    expect(within(controls).getByRole('button', { name: 'Captions' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await userEvent.click(within(controls).getByRole('button', { name: 'Mute' }));
    expect(engine.setMuted).toHaveBeenCalledWith(true);
    await userEvent.click(within(controls).getByRole('button', { name: 'End call' }));
    expect(engine.end).toHaveBeenCalledWith('user');
  });

  it('keeps push to talk, typing and switching to chat under More, with their state', async () => {
    const { engine, switched } = renderLive({ talkMode: 'push_to_talk' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More call controls' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Push to talk/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: /Push to talk/ }));
    expect(engine.setTalkMode).toHaveBeenCalledWith('hands_free');
    await user.click(screen.getByRole('button', { name: 'More call controls' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Switch to chat' }));
    expect(switched()).toBe(1);
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
    expect(captions).toHaveTextContent('Corin · vEIR: Twelve is a good start.');
    expect(captions).toHaveTextContent('YouWe interviewed twelve');
  });

  it('interrupts the vEIR while it speaks', async () => {
    const { engine } = renderLive({ activity: 'speaking' });
    await userEvent.click(await screen.findByRole('button', { name: 'Interrupt' }));
    expect(engine.interrupt).toHaveBeenCalled();
  });

  it('continues by typing when there is no voice input, and says why', async () => {
    const { engine } = renderLive({ input: 'typed', typedReason: 'mic_denied' });
    const line = await screen.findByRole('textbox', { name: 'Reply to Corin · vEIR' });
    expect(line).toHaveFocus();
    // Said once, not three times: the status does not repeat "type".
    expect(screen.getByText(/microphone is blocked/)).toBeInTheDocument();
    expect(screen.queryAllByText(/type/i).map((el) => el.textContent)).toEqual([
      'Your microphone is blocked. Allow it in the browser’s site settings, or type instead.',
    ]);
    expect(screen.queryByRole('button', { name: 'Mute' })).toBeNull();
    await userEvent.type(line, 'We interviewed twelve clinics{Enter}');
    expect(engine.sendText).toHaveBeenCalledWith('We interviewed twelve clinics');
    expect(line).toHaveValue('');
  });

  it('says plainly when the microphone disconnected, and offers to reconnect it or type', async () => {
    const { engine } = renderLive({
      input: 'typed',
      typedReason: 'mic_lost',
      call: { ...CALL, inputMode: 'transcribe' },
    });
    const line = await screen.findByRole('textbox', { name: 'Reply to Corin · vEIR' });
    expect(line).toHaveFocus();
    expect(screen.getByText('Your microphone disconnected. Reconnect it, or type instead.')).toHaveAttribute(
      'role',
      'status',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect microphone' }));
    expect(engine.reconnectMicrophone).toHaveBeenCalledTimes(1);
  });

  it('offers no microphone to a call that started typed', async () => {
    renderLive({ input: 'typed', typedReason: 'mic_denied', call: { ...CALL, inputMode: 'typed' } });
    await screen.findByRole('textbox', { name: 'Reply to Corin · vEIR' });
    expect(screen.queryByRole('button', { name: 'Reconnect microphone' })).toBeNull();
  });

  it('opens a typed line during a voice call', async () => {
    const { engine } = renderLive();
    await userEvent.click(await screen.findByRole('button', { name: 'More call controls' }));
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Type instead/ }));
    const line = screen.getByRole('textbox', { name: 'Reply to Corin · vEIR' });
    // The closing menu returns focus a moment later (a timer): it must not take it back to More.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
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

  it('lets go of push-to-talk when the window loses focus or the page is hidden', async () => {
    const { engine } = renderLive({ talkMode: 'push_to_talk' });
    await screen.findByRole('button', { name: 'Hold to talk' });
    fireEvent.keyDown(document.body, { code: 'Space' });
    expect(engine.pushToTalk).toHaveBeenLastCalledWith(true);
    // Space released in another app never reaches the page.
    fireEvent.blur(window);
    expect(engine.pushToTalk).toHaveBeenLastCalledWith(false);

    fireEvent.keyDown(document.body, { code: 'Space' });
    expect(engine.pushToTalk).toHaveBeenLastCalledWith(true);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    try {
      fireEvent(document, new Event('visibilitychange'));
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
    expect(engine.pushToTalk).toHaveBeenLastCalledWith(false);
  });

  it('puts the support of a held-back turn first, with the drafted request', async () => {
    const result = renderLive({
      muted: true,
      blocked: {
        reason: 'crisis_support',
        escalationId: IDS.escalation,
        supportMessage: 'Call or text **988** any time.',
      },
      captions: { veir: 'Earlier words', founder: null, founderLive: false },
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You deserve support from a person');
    expect(alert).toHaveTextContent('Call or text 988 any time.');
    expect(within(alert).getByRole('link', { name: 'View your support request' })).toHaveAttribute(
      'href',
      `/ain/app/v/${IDS.venture}/help?id=${IDS.escalation}`,
    );
    // The support replaces the captions and the presence while it is shown.
    expect(screen.queryByRole('region', { name: 'Captions' })).toBeNull();
    expect(document.querySelector('[data-slot="call-stage"]')).toBeNull();
    await userEvent.click(within(alert).getByRole('button', { name: 'Switch to chat' }));
    expect(result.switched()).toBe(1);
  });

  it('keeps the support on screen while a call ends during it', async () => {
    renderLive({
      phase: 'ending',
      activity: 'connecting',
      muted: false,
      blocked: { reason: 'crisis_support', escalationId: null, supportMessage: 'Call or text **988**.' },
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Call or text 988.');
    expect(screen.getByRole('status')).toHaveTextContent('Ending…');
    // Nothing to switch from any more: the summary, with the support above it, comes next.
    expect(within(alert).queryByRole('button', { name: 'Switch to chat' })).toBeNull();
  });

  it('adds the emergency line when a safety block has no support message', async () => {
    renderLive({ blocked: { reason: 'safety_wellbeing', escalationId: null, supportMessage: null } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/local emergency number/);
  });

  it('offers Turn on sound when the browser kept the call silent, and says so instead of Speaking', async () => {
    const { engine } = renderLive({ audioBlocked: true, activity: 'speaking' });
    const button = await screen.findByRole('button', { name: 'Turn on sound' });
    // The status line is announced: a screen reader hears why nothing can be heard, not "Speaking".
    expect(screen.getByRole('status')).toHaveTextContent('Sound is off. Turn on sound to hear replies.');
    await userEvent.click(button);
    expect(engine.resumeAudio).toHaveBeenCalled();
  });

  it('resumes a call that was put on hold', async () => {
    const { engine } = renderLive({ held: true, muted: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Resume call' }));
    expect(screen.getByText('On hold')).toBeInTheDocument();
    expect(engine.resume).toHaveBeenCalled();
  });

  it('keeps saying the voice is unavailable while replies are on screen only', async () => {
    renderLive({
      activity: 'speaking',
      voice: 'captions',
      captions: { veir: 'Twelve is a good start.', founder: null, founderLive: false },
    });
    expect(await screen.findByText('Spoken replies are unavailable right now.')).toBeInTheDocument();
    expect(screen.getByText('Replying on screen')).toBeInTheDocument();
  });

  it('says calmly that the voice is paused for the rest of the call when its speech budget ran out', async () => {
    renderLive({
      activity: 'speaking',
      voice: 'captions',
      voicePaused: true,
      captions: { veir: 'Twelve is a good start.', founder: null, founderLive: false },
    });
    expect(
      await screen.findByText('Voice is paused for the rest of this call. Replies continue as text.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Spoken replies are unavailable right now.')).toBeNull();
    // Not an error: the call goes on.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'End call' })).toBeInTheDocument();
  });

  it('suggests push-to-talk after repeated false interruptions', async () => {
    const { engine } = renderLive({
      notice: { kind: 'barge_hint', message: 'Sound around you keeps pausing the reply.' },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Use push to talk' }));
    expect(engine.setTalkMode).toHaveBeenCalledWith('push_to_talk');
    expect(window.localStorage.getItem('fa.call.talk-mode')).toBe('push_to_talk');
  });

  it('shows a large Interrupt while the microphone is closed in half duplex', async () => {
    const { engine } = renderLive({ activity: 'speaking', halfDuplex: true });
    const interrupt = await screen.findByRole('button', { name: 'Interrupt' });
    // One Interrupt, as a full button (not the inline link a full-duplex call shows).
    expect(screen.getAllByRole('button', { name: 'Interrupt' })).toHaveLength(1);
    expect(interrupt).toHaveAttribute('data-slot', 'button');
    await userEvent.click(interrupt);
    expect(engine.interrupt).toHaveBeenCalled();
  });

  it('sizes captions and lets a screen reader follow them when asked', async () => {
    window.localStorage.setItem('fa.call.caption-size', 'lg');
    window.localStorage.setItem('fa.call.announce-captions', '1');
    renderLive({
      activity: 'speaking',
      captions: { veir: 'Twelve is a good start.', founder: null, founderLive: false },
    });
    const line = (await screen.findByRole('region', { name: 'Captions' })).querySelector('p');
    expect(line?.className).toMatch(/1\.5rem/);
    expect(liveText()).toContain('Corin · vEIR: Twelve is a good start.');
  });

  it('does not read the captions over the vEIR’s voice unless asked', async () => {
    renderLive({
      activity: 'speaking',
      captions: { veir: 'Twelve is a good start.', founder: null, founderLive: false },
    });
    expect(await screen.findByRole('region', { name: 'Captions' })).toHaveTextContent(
      'Twelve is a good start.',
    );
    expect(liveText().some((text) => text.includes('Twelve'))).toBe(false);
  });

  it('reads the vEIR’s replies to a screen reader when they are on screen only', async () => {
    renderLive({
      activity: 'speaking',
      voice: 'captions',
      captions: { veir: 'Twelve is a good start.', founder: null, founderLive: false },
    });
    await screen.findByText('Replying on screen');
    // No voice to talk over: each line is announced, without a setting to find first.
    expect(liveText()).toContain('Corin · vEIR: Twelve is a good start.');
  });

  it('shows the vEIR’s reply when it is on screen only, even with captions turned off', async () => {
    window.localStorage.setItem('fa.call.captions', '0');
    renderLive({
      activity: 'speaking',
      voice: 'captions',
      captions: { veir: 'Twelve is a good start.', founder: 'What about price?', founderLive: false },
    });
    const captions = await screen.findByRole('region', { name: 'Captions' });
    expect(captions).toHaveTextContent('Twelve is a good start.');
    // Only the reply: the founder chose not to see their own words.
    expect(captions).not.toHaveTextContent('What about price?');
    expect(liveText()).toContain('Corin · vEIR: Twelve is a good start.');
    expect(screen.getByRole('button', { name: 'Captions' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('disables the controls until the call is live', async () => {
    renderLive({ phase: 'starting', activity: 'connecting' });
    expect(await screen.findByRole('button', { name: 'Mute' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'End call' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('Connecting…');
  });
});
