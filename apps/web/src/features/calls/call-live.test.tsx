import type { CallView } from '@foundry/contracts';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { createRef, type ComponentProps, type RefObject } from 'react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CallSnapshot } from '@/lib/realtime/call-engine';

import { IDS } from '@/lib/realtime/testing';

import { callStatusLabel, CallLive, END_UNDO_MS } from './call-live';
import { fakeEngine, LIVE, renderWithRouter } from './testing';
import type { CallFaceController } from './use-call-face';
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
  name: 'Thomas',
  shortName: 'Thomas',
  kind: 'eir_persona',
  presentation: 'mentor',
  eirFirstName: 'Corin',
  firstPerson: true,
  eirSeesWork: true,
  disclosure: "You are talking with Corin's vEIR, an AI coach. It is not a person.",
  portraitUrl: null,
  provider: 'builtin',
};

/** The call screen's heading, as CallScreen's header renders it. */
function Heading({ headingRef }: { headingRef: RefObject<HTMLHeadingElement | null> }) {
  return (
    <h2 ref={headingRef} tabIndex={-1}>
      Thomas
    </h2>
  );
}

function renderLive(
  snapshot: Partial<CallSnapshot> = {},
  props: Partial<
    Pick<ComponentProps<typeof CallLive>, 'kind' | 'onSwitchKind' | 'videoBlocked' | 'face' | 'veir'>
  > = {},
) {
  const { engine, asEngine } = fakeEngine();
  let switched = 0;
  const headingRef = createRef<HTMLHeadingElement>();
  renderWithRouter(
    <>
      <Heading headingRef={headingRef} />
      <CallLive
        tenant="ain"
        engine={asEngine}
        snapshot={{ ...LIVE, ...snapshot }}
        veir={VEIR}
        headingRef={headingRef}
        onSwitchToChat={() => {
          switched += 1;
        }}
        {...props}
      />
    </>,
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
      expect(callStatusLabel({ ...LIVE, activity, audioBlocked: true })).toBe('Sound is off');
    }
  });
});

describe('CallLive', () => {
  it('shows the vEIR as a call tile, its state and named controls, and no disclaimer line', async () => {
    const { engine } = renderLive();
    // The call screen's header names the vEIR (and takes focus); nothing under the sphere repeats it.
    const heading = await screen.findByRole('heading', { name: 'Thomas' });
    expect(heading).toHaveFocus();
    expect(document.querySelector('[data-slot="call-name-tag"]')).toBeNull();
    expect(screen.queryByText(/vEIR/)).toBeNull();
    expect(screen.queryByText(/Live voice/)).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Listening');
    expect(screen.queryByRole('note', { name: 'AI disclosure' })).toBeNull();
    const tile = document.querySelector('[data-slot="call-tile"]');

    const controls = screen.getByRole('toolbar', { name: 'Call controls' });
    const names = within(controls)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    // As in the reference: the microphone and End only; the rarer controls live in the call settings.
    expect(names).toEqual(['Mute', 'End call']);
    expect(screen.getByRole('button', { name: 'Call settings' })).toBeInTheDocument();
    // The sphere is the default presence.
    expect(tile).toHaveAttribute('data-face', 'presence');
    expect(document.querySelector('.fa-sphere')).not.toBeNull();

    await userEvent.click(within(controls).getByRole('button', { name: 'Mute' }));
    expect(engine.setMuted).toHaveBeenCalledWith(true);
    // End silences the call at once and offers Undo; a second press ends it now.
    await userEvent.click(within(controls).getByRole('button', { name: 'End call' }));
    expect(engine.end).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Call ended' })).toBeInTheDocument();
    await userEvent.click(within(controls).getByRole('button', { name: 'End call' }));
    expect(engine.end).toHaveBeenCalledWith('user');
  });

  it('ends a few seconds after End unless Undo is pressed, and Undo gives the call back as it was', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      const { engine } = renderLive({ activity: 'speaking' });
      const end = await screen.findByRole('button', { name: 'End call' });
      await user.click(end);
      // Silent at once: the reply stops and the microphone mutes; the status says it ended.
      expect(engine.interrupt).toHaveBeenCalled();
      expect(engine.setMuted).toHaveBeenLastCalledWith(true);
      expect(screen.getAllByRole('status')[0]).toHaveTextContent('Call ended');
      const undo = within(screen.getByRole('group', { name: 'Call ended' })).getByRole('button', {
        name: 'Undo',
      });
      expect(undo).toHaveFocus();
      await user.click(undo);
      expect(engine.setMuted).toHaveBeenLastCalledWith(false);
      expect(screen.queryByRole('group', { name: 'Call ended' })).toBeNull();
      expect(end).toHaveFocus();
      act(() => {
        vi.advanceTimersByTime(END_UNDO_MS + 100);
      });
      expect(engine.end).not.toHaveBeenCalled();

      await user.click(end);
      act(() => {
        vi.advanceTimersByTime(END_UNDO_MS - 100);
      });
      expect(engine.end).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(engine.end).toHaveBeenCalledWith('user');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends at once when the screen goes while Undo is offered (minimized, closed)', async () => {
    const { engine, asEngine } = fakeEngine();
    const view = renderWithRouter(
      <CallLive
        tenant="ain"
        engine={asEngine}
        snapshot={LIVE}
        veir={VEIR}
        onSwitchToChat={() => undefined}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'End call' }));
    expect(engine.end).not.toHaveBeenCalled();
    view.unmount();
    expect(engine.end).toHaveBeenCalledWith('user');
  });

  it('keeps captions, push to talk, typing and switching to chat in the call settings, with their state', async () => {
    const { engine, switched } = renderLive({ talkMode: 'push_to_talk' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Call settings' }));
    const settings = await screen.findByRole('dialog', { name: 'Call settings' });
    expect(within(settings).getByRole('button', { name: /^Captions/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(settings).getByRole('button', { name: /^Push to talk/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(settings).getByRole('button', { name: /^Push to talk/ }));
    expect(engine.setTalkMode).toHaveBeenCalledWith('hands_free');
    await user.click(within(settings).getByRole('button', { name: 'Switch to chat' }));
    expect(switched()).toBe(1);
  });

  it('shows the sphere on a voice call, with no drawn character to choose (owner, round 3)', async () => {
    renderLive();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Call settings' }));
    expect(document.querySelector('[data-slot="call-tile"]')).toHaveAttribute('data-face', 'presence');
    const settings = await screen.findByRole('dialog', { name: 'Call settings' });
    expect(within(settings).queryByRole('group', { name: 'Presentation' })).toBeNull();
    expect(within(settings).queryByRole('button', { name: 'AI avatar' })).toBeNull();
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
    expect(captions).toHaveTextContent('Thomas: Twelve is a good start.');
    expect(captions).toHaveTextContent('YouWe interviewed twelve');
  });

  it('interrupts the vEIR while it speaks', async () => {
    const { engine } = renderLive({ activity: 'speaking' });
    await userEvent.click(await screen.findByRole('button', { name: 'Interrupt' }));
    expect(engine.interrupt).toHaveBeenCalled();
  });

  it('continues by typing when there is no voice input, and says why', async () => {
    const { engine } = renderLive({ input: 'typed', typedReason: 'mic_denied' });
    const line = await screen.findByRole('textbox', { name: 'Reply to Thomas' });
    expect(line).toHaveFocus();
    // Said once, not three times: the status does not repeat "type".
    expect(screen.getByText(/Microphone blocked/)).toBeInTheDocument();
    expect(screen.queryAllByText(/type/i).map((el) => el.textContent)).toEqual([
      'Microphone blocked. Allow it in site settings, or type.',
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
    const line = await screen.findByRole('textbox', { name: 'Reply to Thomas' });
    expect(line).toHaveFocus();
    expect(screen.getByText('Microphone disconnected. Reconnect it, or type.')).toHaveAttribute(
      'role',
      'status',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect microphone' }));
    expect(engine.reconnectMicrophone).toHaveBeenCalledTimes(1);
  });

  it('offers no microphone to a call that started typed', async () => {
    renderLive({ input: 'typed', typedReason: 'mic_denied', call: { ...CALL, inputMode: 'typed' } });
    await screen.findByRole('textbox', { name: 'Reply to Thomas' });
    expect(screen.queryByRole('button', { name: 'Reconnect microphone' })).toBeNull();
  });

  it('opens a typed line during a voice call', async () => {
    const { engine } = renderLive();
    await userEvent.click(await screen.findByRole('button', { name: 'Call settings' }));
    await userEvent.click(await screen.findByRole('button', { name: /^Type instead/ }));
    const line = screen.getByRole('textbox', { name: 'Reply to Thomas' });
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
    expect(within(alert).getByRole('link', { name: 'View your request for support' })).toHaveAttribute(
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
    expect(screen.getByRole('status')).toHaveTextContent('Sound is off');
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
    expect(await screen.findByText('Voice replies are unavailable.')).toBeInTheDocument();
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
      await screen.findByText('Voice paused for this call. Replies continue as text.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Voice replies are unavailable.')).toBeNull();
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
    // Large: the type scale's 24 px step.
    expect(line?.className).toMatch(/\btext-2xl\b/);
    expect(liveText()).toContain('Thomas: Twelve is a good start.');
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
    expect(liveText()).toContain('Thomas: Twelve is a good start.');
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
    expect(liveText()).toContain('Thomas: Twelve is a good start.');
    await userEvent.click(screen.getByRole('button', { name: 'Call settings' }));
    expect(await screen.findByRole('button', { name: /^Captions/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('disables the controls until the call is live', async () => {
    renderLive({ phase: 'starting', activity: 'connecting' });
    expect(await screen.findByRole('button', { name: 'Mute' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'End call' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('Connecting…');
  });

  it('switches a voice call to video and back from the corner beside the settings', async () => {
    const onSwitchKind = vi.fn();
    renderLive({}, { kind: 'voice', onSwitchKind });
    await userEvent.click(await screen.findByRole('button', { name: 'Switch to video' }));
    expect(onSwitchKind).toHaveBeenLastCalledWith('video');
  });

  it('says why a voice call cannot turn video on, and does nothing', async () => {
    const onSwitchKind = vi.fn();
    renderLive({}, { kind: 'voice', onSwitchKind, videoBlocked: 'Video can’t restart in this call.' });
    const blocked = await screen.findByRole('button', {
      name: 'Switch to video: Video can’t restart in this call.',
    });
    expect(blocked).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(blocked);
    expect(onSwitchKind).not.toHaveBeenCalled();
  });

  it('offers a video call the way back to voice whatever the face', async () => {
    const onSwitchKind = vi.fn();
    renderLive({}, { kind: 'video', onSwitchKind, videoBlocked: 'Video can’t restart in this call.' });
    await userEvent.click(await screen.findByRole('button', { name: 'Switch to voice' }));
    expect(onSwitchKind).toHaveBeenLastCalledWith('voice');
  });

  /** A face this call asked for that is not shown (the controller's view of it). */
  function faceNotShown(hadVideo: boolean): CallFaceController {
    const presence = { status: 'presence' } as const;
    return {
      subscribe: () => () => undefined,
      getSnapshot: () => presence,
      hasAsked: () => true,
      hadVideo: () => hadVideo,
      request: vi.fn(),
    } as unknown as CallFaceController;
  }

  it('says when video could not start and offers a voice call, never switching by itself', async () => {
    const onSwitchKind = vi.fn();
    renderLive(
      { call: CALL },
      { kind: 'video', onSwitchKind, face: faceNotShown(false), veir: { ...VEIR, provider: 'heygen' } },
    );
    expect(await screen.findByText('Video couldn’t start. You can carry on as a voice call.')).toBeVisible();
    // The tile says it too, in place of the face (never the sphere as a stand-in).
    expect(document.querySelector('[data-slot="call-tile"]')).toHaveAttribute(
      'data-face',
      'video-unavailable',
    );
    expect(onSwitchKind).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Voice call' }));
    expect(onSwitchKind).toHaveBeenLastCalledWith('voice');
  });

  it('says the video stopped once a face that showed is gone', async () => {
    renderLive(
      { call: CALL },
      {
        kind: 'video',
        onSwitchKind: vi.fn(),
        face: faceNotShown(true),
        veir: { ...VEIR, provider: 'heygen' },
      },
    );
    expect(await screen.findByText('Video stopped. You can carry on as a voice call.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Voice call' })).toBeVisible();
  });
});
