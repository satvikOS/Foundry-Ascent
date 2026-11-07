import type { RecordingView } from '@foundry/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { RecordedCall } from '@/lib/api/hooks/recordings';
import { ApiError } from '@/lib/api/errors';
import { IDLE_CALL, type CallSnapshot } from '@/lib/realtime/call-state';

import type { CallRecorderInput } from './call-recorder';
import { RecordingSession, saveFailure, type RecordedEngine } from './recording-session';

const CALL = {
  id: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  ventureId: '33333333-3333-4333-8333-333333333333',
  personaId: '44444444-4444-4444-8444-444444444444',
  status: 'live' as const,
  provider: 'builtin' as const,
  inputMode: 'typed' as const,
  startedAt: '2026-11-06T12:00:00.000Z',
  endedAt: null,
  endReason: null,
  maxSeconds: 1800,
  durationSeconds: null,
};

function fakeEngine() {
  let snapshot: CallSnapshot = { ...IDLE_CALL, phase: 'live', call: CALL };
  const listeners = new Set<() => void>();
  const audio = {
    context: { createGain: vi.fn(), createMediaStreamSource: vi.fn() },
    veir: null,
    microphone: null,
  };
  const engine: RecordedEngine = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    recordingSources: () => audio,
    levels: () => ({ veir: 0, founder: 0 }),
  };
  return {
    engine,
    set(patch: Partial<CallSnapshot>) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of [...listeners]) listener();
    },
    listeners,
  };
}

function setup(
  save = vi.fn((recorded: RecordedCall) =>
    Promise.resolve({ id: 'r1', callId: recorded.callId } as RecordingView),
  ),
) {
  let now = 1_000_000;
  const recorder = {
    start: vi.fn(),
    sync: vi.fn(),
    onLimit: null as (() => void) | null,
    stop: vi.fn(() =>
      Promise.resolve({
        media: new Blob(['x'.repeat(10)], { type: 'video/webm' }),
        mimeType: 'video/webm' as const,
        durationMs: 9_000,
      }),
    ),
  };
  const inputs: CallRecorderInput[] = [];
  const call = fakeEngine();
  const session = new RecordingSession(call.engine, {
    createRecorder: (input) => {
      inputs.push(input);
      return recorder;
    },
    save,
    now: () => now,
  });
  session.attach({ veirName: 'Thomas', founderName: 'Maya', face: null });
  return { session, recorder, call, save, inputs, tick: (ms: number) => (now += ms) };
}

describe('RecordingSession', () => {
  it('records the live call with its captions, and saves it when stopped', async () => {
    const { session, recorder, call, save, tick } = setup();
    const onSaved = vi.fn();
    session.onSaved = onSaved;
    session.start();
    expect(recorder.start).toHaveBeenCalledOnce();
    expect(session.getSnapshot()).toMatchObject({
      status: 'recording',
      callId: CALL.id,
      startedAt: 1_000_000,
    });
    tick(1_000);
    call.set({ captions: { veir: 'What changed this week?', founder: null, founderLive: false } });
    tick(3_000);
    call.set({ captions: { veir: null, founder: 'We ran the pilot.', founderLive: false } });
    expect(recorder.sync).toHaveBeenCalled();
    await session.stop();
    expect(save).toHaveBeenCalledOnce();
    const recorded = save.mock.calls[0]?.[0];
    expect(recorded).toMatchObject({ callId: CALL.id, mimeType: 'video/webm', durationMs: 9_000 });
    expect(recorded?.captions?.cues).toBe(2);
    expect(recorded?.captions?.vtt).toContain('<v.veir Thomas>What changed this week?');
    expect(recorded?.captions?.vtt).toContain('<v.founder Maya>We ran the pilot.');
    expect(session.getSnapshot()).toMatchObject({ status: 'saved', recording: { id: 'r1' } });
    expect(onSaved).toHaveBeenCalledOnce();
    // Nothing listens to the call once it stopped.
    expect(call.listeners.size).toBe(0);
  });

  it('stops and saves when the call ends (hanging up)', async () => {
    const { session, call, save } = setup();
    session.start();
    call.set({ phase: 'ending' });
    await vi.waitFor(() => {
      expect(save).toHaveBeenCalledOnce();
    });
    expect(save.mock.calls[0]?.[0].captions).toBeNull();
  });

  it('keeps a recording whose save failed, to try again', async () => {
    const save = vi
      .fn<(recorded: RecordedCall) => Promise<RecordingView>>()
      .mockRejectedValueOnce(new ApiError({ status: 0, code: 'network_error', title: 'Upload failed' }))
      .mockResolvedValueOnce({ id: 'r2' } as RecordingView);
    const { session } = setup(save);
    session.start();
    await session.stop();
    expect(session.getSnapshot()).toEqual({
      status: 'failed',
      message: 'The connection dropped while it was saving.',
      canRetry: true,
    });
    await session.retry();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[0]).toBe(save.mock.calls[0]?.[0]);
    expect(session.getSnapshot()).toMatchObject({ status: 'saved' });
    session.dismiss();
    expect(session.getSnapshot()).toEqual({ status: 'idle' });
  });

  it('refuses to start when the call is not live, and stops by itself near the size limit', async () => {
    const { session, call, recorder, save } = setup();
    call.set({ phase: 'starting' });
    expect(() => {
      session.start();
    }).toThrow('The call isn’t live.');
    call.set({ phase: 'live' });
    session.start();
    recorder.onLimit?.();
    await vi.waitFor(() => {
      expect(save).toHaveBeenCalledOnce();
    });
  });
});

describe('saveFailure', () => {
  it('says what went wrong in a recording’s words', () => {
    expect(
      saveFailure(
        new ApiError({ status: 409, code: 'conflict', title: 'Conflict', reason: 'recording_private_call' }),
      ),
    ).toBe('Private calls aren’t recorded.');
    expect(saveFailure(new ApiError({ status: 409, code: 'conflict', title: 'Conflict' }))).toBe(
      'The recording didn’t finish uploading.',
    );
  });
});
