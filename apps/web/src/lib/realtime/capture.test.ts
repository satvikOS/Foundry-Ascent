import { describe, expect, it, vi } from 'vitest';

import workletSource from '../../../public/worklets/pcm-capture.js?raw';
import { MicCapture, MicrophoneError, requestMicrophone, type CaptureAudio } from './capture';
import { FakeAudioContext } from './testing';

interface Posted {
  pcm: ArrayBuffer;
  rms: number;
}

/** Loads the shipped worklet file with stand-ins for the AudioWorkletGlobalScope. */
function loadWorklet(contextRate: number) {
  const registered: Record<string, new (options: unknown) => { process(inputs: Float32Array[][]): boolean }> =
    {};
  const posted: Posted[] = [];
  class AudioWorkletProcessor {
    readonly port = {
      postMessage: (message: Posted) => {
        posted.push(message);
      },
    };
  }
  const registerProcessor = (name: string, processor: (typeof registered)[string]) => {
    registered[name] = processor;
  };
  // The worklet is plain JavaScript evaluated in its own global scope; this mirrors that scope.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const evaluate = new Function(
    'AudioWorkletProcessor',
    'registerProcessor',
    'sampleRate',
    workletSource,
  ) as (processorBase: unknown, register: unknown, rate: number) => void;
  evaluate(AudioWorkletProcessor, registerProcessor, contextRate);
  const Processor = registered['pcm-capture'];
  if (!Processor) throw new Error('pcm-capture was not registered');
  return {
    processor: new Processor({ processorOptions: { targetSampleRate: 16000, frameMs: 50 } }),
    posted,
  };
}

function quanta(sample: number, count: number, size = 128): Float32Array[][] {
  return Array.from({ length: count }, () => [new Float32Array(size).fill(sample)]);
}

describe('pcm-capture worklet', () => {
  it('downsamples 48 kHz to 16 kHz frames of 50 ms with their RMS', () => {
    const { processor, posted } = loadWorklet(48_000);
    // 50 ms at 48 kHz is 2400 samples: 18.75 render quanta of 128.
    for (const quantum of quanta(0.5, 19)) expect(processor.process([quantum])).toBe(true);
    expect(posted).toHaveLength(1);
    const frame = new Int16Array(posted[0]?.pcm ?? new ArrayBuffer(0));
    expect(frame.length).toBe(800);
    expect(frame[0]).toBe(Math.round(0.5 * 0x7fff));
    expect(posted[0]?.rms).toBeCloseTo(0.5, 5);
  });

  it('handles a fractional ratio (44.1 kHz) and clamps out-of-range samples', () => {
    const { processor, posted } = loadWorklet(44_100);
    for (const quantum of quanta(-2, 40)) processor.process([quantum]);
    expect(posted.length).toBeGreaterThanOrEqual(2);
    const frame = new Int16Array(posted[0]?.pcm ?? new ArrayBuffer(0));
    expect(frame.length).toBe(800);
    expect(frame.every((s) => s === -0x8000)).toBe(true);
  });

  it('mixes stereo to mono and keeps running without input', () => {
    const { processor, posted } = loadWorklet(16_000);
    expect(processor.process([])).toBe(true);
    for (let i = 0; i < 7; i++) {
      processor.process([[new Float32Array(128).fill(0.2), new Float32Array(128).fill(-0.2)]]);
    }
    expect(posted).toHaveLength(1);
    expect(new Int16Array(posted[0]?.pcm ?? new ArrayBuffer(0)).every((s) => s === 0)).toBe(true);
  });
});

describe('requestMicrophone', () => {
  it('asks for an echo-cancelled mono microphone', async () => {
    const stream = {} as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    await expect(requestMicrophone(getUserMedia)).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  });

  it('tells a refusal from a missing device', async () => {
    const denied = Object.assign(new Error('no'), { name: 'NotAllowedError' });
    await expect(requestMicrophone(vi.fn().mockRejectedValue(denied))).rejects.toMatchObject({
      reason: 'denied',
    });
    const missing = Object.assign(new Error('none'), { name: 'NotFoundError' });
    await expect(requestMicrophone(vi.fn().mockRejectedValue(missing))).rejects.toBeInstanceOf(
      MicrophoneError,
    );
  });
});

describe('MicCapture', () => {
  function fakeStream() {
    const track = { enabled: true, stop: vi.fn() };
    return {
      track,
      stream: { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream,
    };
  }

  it('loads the static worklet once, forwards frames and stops cleanly', async () => {
    const context = new FakeAudioContext();
    const audio = {
      context,
      getUserMedia: vi.fn(),
      createWorkletNode: () => context.createWorkletNode(),
    } as unknown as CaptureAudio;
    const { stream, track } = fakeStream();
    const capture = await MicCapture.start(audio, stream);
    await MicCapture.start(audio, fakeStream().stream);
    expect(context.modules).toEqual(['/worklets/pcm-capture.js']);

    const frames: [number, number][] = [];
    capture.onFrame((pcm, rms) => frames.push([pcm.length, rms]));
    context.worklets[0]?.emit(new Int16Array(800), 0.1);
    expect(frames).toEqual([[800, 0.1]]);

    capture.setEnabled(false);
    expect(track.enabled).toBe(false);
    capture.stop();
    expect(track.stop).toHaveBeenCalled();
    context.worklets[0]?.emit(new Int16Array(800), 0.1);
    expect(frames).toHaveLength(1);
  });
});
