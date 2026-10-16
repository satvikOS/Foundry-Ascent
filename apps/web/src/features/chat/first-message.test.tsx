import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TurnStreamState } from '@/lib/api/hooks/turn-stream';
import type { CreateTurnBody } from '@/lib/api/sse';

import { modeToSend } from './composer';
import {
  hasPendingFirstMessage,
  newConversationRequest,
  rememberComposerMode,
  rememberedComposerMode,
  setPendingFirstMessage,
  takePendingFirstMessage,
  useFirstMessageHandoff,
} from './first-message';

const SESSION = '0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';

type Outcome = TurnStreamState['status'];

function setup({
  canSend = true,
  ready = true,
  outcome = 'completed',
}: { canSend?: boolean; ready?: boolean; outcome?: Outcome } = {}) {
  const send = vi.fn<(body: CreateTurnBody) => Promise<Outcome>>().mockResolvedValue(outcome);
  const restore = vi.fn<(text: string) => void>();
  const setCounterpart = vi.fn<(value: string) => void>();
  const hook = renderHook(
    (props: { ready: boolean; canSend: boolean }) => {
      useFirstMessageHandoff({ sessionId: SESSION, send, restore, setCounterpart, ...props });
    },
    { initialProps: { ready, canSend } },
  );
  return { send, restore, setCounterpart, hook };
}

async function flush() {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

describe('Auto mode', () => {
  afterEach(() => {
    rememberComposerMode(SESSION, 'auto');
  });

  it('is never sent: the turn omits mode so the vEIR picks', () => {
    expect(modeToSend('auto')).toBeUndefined();
    expect(modeToSend('challenge')).toBe('challenge');
  });

  it('is the default for every conversation and persists across follow-ups', () => {
    expect(rememberedComposerMode(SESSION)).toBe('auto');
    rememberComposerMode(SESSION, 'rehearse');
    expect(rememberedComposerMode(SESSION)).toBe('rehearse');
    rememberComposerMode(SESSION, 'auto');
    expect(rememberedComposerMode(SESSION)).toBe('auto');
  });

  it('carries the New chat choice into the conversation', () => {
    setPendingFirstMessage(SESSION, { text: 'Hello', mode: 'teach' });
    expect(rememberedComposerMode(SESSION)).toBe('teach');
    takePendingFirstMessage(SESSION);
    setPendingFirstMessage(SESSION, { text: 'Hello again' });
    expect(rememberedComposerMode(SESSION)).toBe('auto');
    takePendingFirstMessage(SESSION);
  });
});

describe('useFirstMessageHandoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    takePendingFirstMessage(SESSION);
    vi.useRealTimers();
  });

  it('sends the first message once the conversation is ready, without a mode for Auto', async () => {
    setPendingFirstMessage(SESSION, { text: 'Which assumption first?' });
    const { send, restore, hook } = setup({ ready: false });
    await flush();
    expect(send).not.toHaveBeenCalled();
    hook.rerender({ ready: true, canSend: true });
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ text: 'Which assumption first?' });
    expect(hasPendingFirstMessage(SESSION)).toBe(false);
    // Sent once: re-renders don't send it again.
    hook.rerender({ ready: true, canSend: true });
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
  });

  it('sends a chosen mode and the rehearsal counterpart', async () => {
    setPendingFirstMessage(SESSION, {
      text: 'Let me practise my pitch',
      mode: 'rehearse',
      rehearsalCounterpart: 'Seed investor',
    });
    const { send, setCounterpart } = setup();
    await flush();
    expect(setCounterpart).toHaveBeenCalledWith('Seed investor');
    expect(send).toHaveBeenCalledWith({
      text: 'Let me practise my pitch',
      mode: 'rehearse',
      rehearsalCounterpart: 'Seed investor',
    });
  });

  it('gives the text back when the founder stops the first answer', async () => {
    setPendingFirstMessage(SESSION, { text: 'Stop me' });
    const { send, restore } = setup({ outcome: 'cancelled' });
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith('Stop me');
  });

  it('puts the text in the composer instead of sending when the conversation cannot take messages', async () => {
    setPendingFirstMessage(SESSION, { text: 'AI is paused right now' });
    const { send, restore } = setup({ canSend: false });
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledWith('AI is paused right now');
    expect(hasPendingFirstMessage(SESSION)).toBe(false);
  });

  it('leaves a failed first message on screen with its retry (nothing is lost, nothing duplicated)', async () => {
    setPendingFirstMessage(SESSION, { text: 'This one fails' });
    const { restore } = setup({ outcome: 'failed' });
    await flush();
    expect(restore).not.toHaveBeenCalled();
  });

  it('does nothing without a waiting message', async () => {
    const { send, restore } = setup();
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });
});

describe('newConversationRequest', () => {
  it('never names the conversation after the message, so a blocked first message is never a title', () => {
    for (const privacy of ['standard', 'ephemeral'] as const) {
      expect(newConversationRequest({ mode: undefined, privacy })).not.toHaveProperty('title');
      expect(newConversationRequest({ mode: 'challenge', privacy })).not.toHaveProperty('title');
    }
  });

  it('sends no mode for Auto and the chosen privacy', () => {
    expect(newConversationRequest({ mode: undefined, privacy: 'standard' })).toEqual({ privacy: 'standard' });
    expect(newConversationRequest({ mode: 'rehearse', privacy: 'ephemeral' })).toEqual({
      mode: 'rehearse',
      privacy: 'ephemeral',
    });
  });
});
