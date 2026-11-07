import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CallRecorder, canRecordCalls, pickFormat, type RecordingAudio } from './call-recorder';

describe('pickFormat', () => {
  it('takes webm where it is recorded (Chromium, Firefox), mp4 on Safari, and sound only without a canvas', () => {
    const chromium = (type: string) => type.startsWith('video/webm') || type.startsWith('audio/webm');
    expect(pickFormat(chromium, true)).toEqual({
      recorderType: 'video/webm;codecs=vp8,opus',
      mimeType: 'video/webm',
    });
    const safari = (type: string) => type === 'video/mp4' || type === 'audio/mp4';
    expect(pickFormat(safari, true)).toEqual({ recorderType: 'video/mp4', mimeType: 'video/mp4' });
    expect(pickFormat(safari, false)).toEqual({ recorderType: 'audio/mp4', mimeType: 'audio/mp4' });
    expect(pickFormat(() => false, true)).toBeNull();
    expect(
      pickFormat(() => {
        throw new Error('unsupported');
      }, true),
    ).toBeNull();
  });

  it('says a browser without MediaRecorder cannot record calls', () => {
    expect(canRecordCalls({ MediaRecorder: undefined })).toBe(false);
  });
});

describe('CallRecorder', () => {
  // jsdom has no MediaStream (the recorder checks a face's element source against it).
  beforeEach(() => {
    vi.stubGlobal(
      'MediaStream',
      class FakeMediaStream {
        readonly active = true;
      },
    );
  });

  /** A recorder on fake browser objects: sound only (the canvas cannot be captured), the mic's gate observable. */
  function fakeRecorder(microphoneOpen: boolean) {
    const gates: { gain: { value: number }; connect: () => void; disconnect: () => void }[] = [];
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    const context = {
      createGain: vi.fn(() => {
        const gate = { gain: { value: 1 }, ...node() };
        gates.push(gate);
        return gate;
      }),
      createMediaStreamSource: vi.fn(node),
      createMediaStreamDestination: vi.fn(() => ({
        ...node(),
        stream: { getAudioTracks: () => [], getTracks: () => [] },
      })),
    };
    class FakeMediaRecorder {
      static isTypeSupported = (type: string) => type.startsWith('audio/webm');
      state = 'inactive';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      start() {
        this.state = 'recording';
      }
    }
    const microphone = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;
    const audio = {
      context: context as unknown as RecordingAudio['context'],
      veir: null,
      microphone,
      microphoneOpen,
    };
    const recorder = new CallRecorder(
      { audio, name: 'Thomas', level: () => 0, picture: () => ({ media: null, stream: null }) },
      {
        MediaRecorder: FakeMediaRecorder as unknown as typeof MediaRecorder,
        createCanvas: () => ({}) as HTMLCanvasElement,
        createStream: () => ({}) as MediaStream,
        playStream: () => ({}) as HTMLVideoElement,
        now: () => 0,
        setInterval: () => 0,
        clearInterval: () => undefined,
      },
    );
    return { recorder, audio, gates };
  }

  it('records the microphone only while the call hears it: push to talk released is silent', () => {
    // Push to talk, not held: the track is live (only mute disables it) but nothing of it reaches the recording.
    const { recorder, audio, gates } = fakeRecorder(false);
    recorder.start();
    expect(gates).toHaveLength(1);
    expect(gates[0]?.gain.value).toBe(0);
    // Held to talk: heard, and recorded.
    recorder.sync({ ...audio, microphoneOpen: true });
    expect(gates[0]?.gain.value).toBe(1);
    // Released again (or muted, or on hold).
    recorder.sync({ ...audio, microphoneOpen: false });
    expect(gates[0]?.gain.value).toBe(0);
    // The same microphone is never tapped twice.
    expect(gates).toHaveLength(1);
  });

  it('records the microphone at once in hands-free', () => {
    const { recorder, gates } = fakeRecorder(true);
    recorder.start();
    expect(gates[0]?.gain.value).toBe(1);
  });
});
