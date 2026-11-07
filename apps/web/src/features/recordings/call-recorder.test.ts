import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CallRecorder,
  canRecordCalls,
  pickFormat,
  requestScreen,
  type RecordingAudio,
  type RecorderBrowser,
} from './call-recorder';

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

describe('requestScreen', () => {
  it('asks for this tab, without its sound, at a bounded size and frame rate', async () => {
    const stream = {} as MediaStream;
    const getDisplayMedia = vi.fn(() => Promise.resolve(stream));
    await expect(requestScreen({ getDisplayMedia })).resolves.toBe(stream);
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: {
        displaySurface: 'browser',
        frameRate: { ideal: 15, max: 15 },
        width: { max: 1920 },
        height: { max: 1080 },
      },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
      systemAudio: 'exclude',
      monitorTypeSurfaces: 'exclude',
    });
  });

  it('is null where a screen cannot be shared (iOS Safari, most phones)', () => {
    expect(requestScreen({})).toBeNull();
    // jsdom, like an insecure page, has no mediaDevices at all.
    expect(requestScreen()).toBeNull();
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

  /** A video track that stops, and says it ended as a browser does when sharing stops. */
  function fakeTrack(kind: 'video' | 'audio' = 'video') {
    const ended = new Set<() => void>();
    return {
      kind,
      readyState: 'live',
      contentHint: '',
      stop: vi.fn(),
      addEventListener: (_type: string, listener: () => void) => ended.add(listener),
      removeEventListener: (_type: string, listener: () => void) => ended.delete(listener),
      end: () => {
        for (const listener of [...ended]) listener();
      },
    };
  }

  /**
   * A recorder on fake browser objects, its mic's gate observable. `video` false: sound only (the browser records no
   * video); `canvas`: the composed view can be captured; `display`: a screen was shared.
   */
  function fakeRecorder(
    microphoneOpen: boolean,
    options: { video?: boolean; canvas?: boolean; display?: MediaStream | null } = {},
  ) {
    const gates: { gain: { value: number }; connect: () => void; disconnect: () => void }[] = [];
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    const mixed = fakeTrack('audio');
    const context = {
      createGain: vi.fn(() => {
        const gate = { gain: { value: 1 }, ...node() };
        gates.push(gate);
        return gate;
      }),
      createMediaStreamSource: vi.fn(node),
      createMediaStreamDestination: vi.fn(() => ({
        ...node(),
        stream: { getAudioTracks: () => [mixed], getTracks: () => [mixed] },
      })),
    };
    const recorded: { tracks: unknown[]; options: MediaRecorderOptions | undefined }[] = [];
    const video = options.video ?? false;
    class FakeMediaRecorder {
      static isTypeSupported = (type: string) =>
        type.startsWith('audio/webm') || (video && type.startsWith('video/webm'));
      state = 'inactive';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;
      constructor(stream: { tracks: unknown[] }, recorderOptions?: MediaRecorderOptions) {
        recorded.push({ tracks: stream.tracks, options: recorderOptions });
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.onstop?.(new Event('stop'));
      }
    }
    const canvasTrack = fakeTrack();
    const canvases: { width: number; height: number }[] = [];
    const drawn: string[] = [];
    const microphone = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;
    const audio = {
      context: context as unknown as RecordingAudio['context'],
      veir: null,
      microphone,
      microphoneOpen,
    };
    const browser: RecorderBrowser = {
      MediaRecorder: FakeMediaRecorder as unknown as typeof MediaRecorder,
      createCanvas: (width, height) => {
        canvases.push({ width, height });
        if (!options.canvas) return {} as HTMLCanvasElement;
        const gradient = { addColorStop: vi.fn() };
        const ctx = new Proxy(
          {
            measureText: (text: string) => ({ width: text.length * 10 }),
            fillText: (text: string) => drawn.push(text),
          },
          {
            get: (target, key) =>
              key in target
                ? target[key as keyof typeof target]
                : key === 'createLinearGradient' || key === 'createRadialGradient'
                  ? () => gradient
                  : vi.fn(),
            set: () => true,
          },
        );
        return {
          width,
          height,
          getContext: () => ctx,
          captureStream: () => ({ getVideoTracks: () => [canvasTrack] }),
        } as unknown as HTMLCanvasElement;
      },
      createStream: (tracks) => ({ tracks }) as unknown as MediaStream,
      playStream: () => ({}) as HTMLVideoElement,
      now: () => 0,
      setInterval: () => 0,
      clearInterval: () => undefined,
    };
    const recorder = new CallRecorder(
      {
        audio,
        name: 'Thomas',
        founderName: 'Maya',
        level: () => 0,
        picture: () => ({ media: null, stream: null }),
        transcript: () => [
          { speaker: 'veir', text: 'What changed this week?', live: false },
          { speaker: 'founder', text: 'We ran the pilot', live: true },
        ],
        display: options.display ?? null,
      },
      browser,
    );
    return { recorder, audio, gates, recorded, canvases, canvasTrack, mixed, drawn };
  }

  /** A shared screen: one live video track, no sound. */
  function sharedScreen() {
    const track = fakeTrack();
    const stream = {
      getVideoTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    return { track, stream };
  }

  it('records the shared screen with the call’s own sound, and no canvas', () => {
    const screen = sharedScreen();
    const { recorder, recorded, canvases, mixed } = fakeRecorder(true, {
      video: true,
      display: screen.stream,
    });
    recorder.start();
    expect(recorder.capture).toBe('screen');
    expect(canvases).toEqual([]);
    // One picture (the screen, kept sharp for its text) and one sound (the call's mix): nothing heard twice.
    expect(recorded[0]?.tracks).toEqual([screen.track, mixed]);
    expect(screen.track.contentHint).toBe('detail');
    expect(recorded[0]?.options).toMatchObject({
      mimeType: 'video/webm;codecs=vp8,opus',
      videoBitsPerSecond: 1_500_000,
    });
  });

  it('stops when the person stops sharing from the browser, and lets the screen go when it stops', async () => {
    const screen = sharedScreen();
    const { recorder } = fakeRecorder(true, { video: true, display: screen.stream });
    const ended = vi.fn();
    recorder.onScreenEnded = ended;
    recorder.start();
    screen.track.end();
    expect(ended).toHaveBeenCalledOnce();
    await expect(recorder.stop()).rejects.toThrow('Nothing was recorded.');
    expect(screen.track.stop).toHaveBeenCalled();
  });

  it('composes the call view when no screen was shared: face or presence, its name and time, the conversation', () => {
    const { recorder, recorded, canvases, canvasTrack, mixed, drawn } = fakeRecorder(true, {
      video: true,
      canvas: true,
    });
    recorder.start();
    expect(recorder.capture).toBe('view');
    expect(canvases).toEqual([{ width: 1280, height: 720 }]);
    expect(recorded[0]?.tracks).toEqual([canvasTrack, mixed]);
    // The first frame: who, how long, and both speakers' lines under their names.
    expect(drawn).toEqual(
      expect.arrayContaining([
        'AI voice',
        'Thomas',
        '0:00',
        'What changed this week?',
        'Maya',
        'We ran the pilot',
      ]),
    );
  });

  it('records sound only where no picture can be recorded, and does not keep a screen shared for it', () => {
    const screen = sharedScreen();
    const { recorder, recorded, mixed } = fakeRecorder(true, { video: false, display: screen.stream });
    recorder.start();
    expect(recorder.capture).toBe('sound');
    expect(recorded[0]?.tracks).toEqual([mixed]);
    expect(screen.track.stop).toHaveBeenCalled();
  });

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
