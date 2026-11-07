import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CallRecorder,
  canRecordCalls,
  canShareScreen,
  pickFormat,
  requestScreen,
  sharesThisTab,
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
    const setCaptureHandleConfig = vi.fn();
    await expect(requestScreen({ getDisplayMedia, setCaptureHandleConfig })).resolves.toBe(stream);
    // The page marks itself first, so a capture of it can be told from any other.
    expect(setCaptureHandleConfig).toHaveBeenCalledWith({
      handle: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      exposeOrigin: false,
      permittedOrigins: [window.location.origin],
    });
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

  it('is null where a screen cannot be shared (iOS Safari, most phones) or this tab could not be told apart', () => {
    expect(requestScreen({})).toBeNull();
    // jsdom, like an insecure page, has no mediaDevices at all.
    expect(requestScreen()).toBeNull();
    expect(canShareScreen()).toBe(false);
    // Firefox and Safari: windows and screens, never just this tab. Nothing is asked for.
    const getDisplayMedia = vi.fn(() => Promise.resolve({} as MediaStream));
    expect(canShareScreen({ getDisplayMedia })).toBe(false);
    expect(requestScreen({ getDisplayMedia })).toBeNull();
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });
});

describe('sharesThisTab', () => {
  /** What was shared: its surface and the capture handle it carries. */
  function shared(displaySurface: string, handle: string | null) {
    const track = {
      getSettings: () => ({ displaySurface }),
      getCaptureHandle: () => (handle === null ? null : { handle }),
    };
    return { getVideoTracks: () => [track] } as unknown as MediaStream;
  }

  it('accepts only a browser tab that carries this page’s capture handle', async () => {
    let handle = '';
    await requestScreen({
      getDisplayMedia: () => Promise.resolve({} as MediaStream),
      setCaptureHandleConfig: (config) => {
        handle = config.handle;
      },
    });
    expect(sharesThisTab(shared('browser', handle))).toBe(true);
    // Another tab, a window, a whole screen.
    expect(sharesThisTab(shared('browser', 'another-page'))).toBe(false);
    expect(sharesThisTab(shared('browser', null))).toBe(false);
    expect(sharesThisTab(shared('window', handle))).toBe(false);
    expect(sharesThisTab(shared('monitor', handle))).toBe(false);
    expect(sharesThisTab({ getVideoTracks: () => [] } as unknown as MediaStream)).toBe(false);
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
  function fakeTrack(kind: 'video' | 'audio' = 'video', size: { width?: number; height?: number } = {}) {
    const ended = new Set<() => void>();
    return {
      kind,
      readyState: 'live',
      contentHint: '',
      getSettings: () => size,
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
    options: {
      video?: boolean;
      canvas?: boolean;
      display?: MediaStream | null;
      onScreen?: () => boolean;
      now?: () => number;
    } = {},
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
    /** What each drawImage drew (the shared tab's element, or a face). */
    const images: unknown[] = [];
    /** The shared tab as it plays (ready to be drawn). */
    const tab = { videoWidth: 1280, videoHeight: 720, readyState: 4, srcObject: null as unknown };
    const frames: (() => void)[] = [];
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
            drawImage: (image: unknown) => images.push(image),
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
      playStream: () => tab as unknown as HTMLVideoElement,
      now: options.now ?? (() => 0),
      setInterval: (callback) => frames.push(callback),
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
        onScreen: options.onScreen ?? (() => true),
      },
      browser,
    );
    /** Draws the next frame, as the browser's timer would. */
    const frame = () => {
      for (const draw of frames) draw();
    };
    return { recorder, audio, gates, recorded, canvases, canvasTrack, mixed, drawn, images, tab, frame };
  }

  /** A shared tab: one live video track of its size, no sound. */
  function sharedScreen(size: { width?: number; height?: number } = { width: 1280, height: 720 }) {
    const track = fakeTrack('video', size);
    const stream = {
      getVideoTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    return { track, stream };
  }

  it('records the shared tab through one canvas at its size, with the call’s own sound', () => {
    const screen = sharedScreen();
    const { recorder, recorded, canvases, canvasTrack, mixed, images, tab } = fakeRecorder(true, {
      video: true,
      canvas: true,
      display: screen.stream,
    });
    recorder.start();
    expect(recorder.capture).toBe('screen');
    expect(canvases).toEqual([{ width: 1280, height: 720 }]);
    // One picture (the canvas the tab is drawn on, kept sharp for its text) and one sound (the call's mix): nothing
    // heard twice, and the tab's own track never reaches the recording.
    expect(recorded[0]?.tracks).toEqual([canvasTrack, mixed]);
    expect(canvasTrack.contentHint).toBe('detail');
    expect(images).toEqual([tab]);
    expect(recorded[0]?.options).toMatchObject({
      mimeType: 'video/webm;codecs=vp8,opus',
      videoBitsPerSecond: 1_500_000,
    });
  });

  it('records the call view, never the tab, while the call is minimized; the tab again a moment after it opens', () => {
    let open = true;
    let now = 0;
    const screen = sharedScreen();
    const { recorder, images, tab, drawn, frame } = fakeRecorder(true, {
      video: true,
      canvas: true,
      display: screen.stream,
      onScreen: () => open,
      now: () => now,
    });
    recorder.start();
    expect(images).toEqual([tab]);
    // Minimized: the tab shows other pages (a private chat, say), and none of it is drawn.
    open = false;
    images.length = 0;
    drawn.length = 0;
    for (let i = 0; i < 5; i += 1) {
      now += 66;
      frame();
    }
    expect(images).toEqual([]);
    expect(drawn).toEqual(expect.arrayContaining(['Thomas', 'What changed this week?', 'We ran the pilot']));
    // Opened again: the tab's late frames may still show that page, so the call view stays a moment longer.
    open = true;
    now += 66;
    frame();
    now += 400;
    frame();
    expect(images).toEqual([]);
    now += 100;
    frame();
    expect(images).toEqual([tab]);
  });

  it('draws a large tab scaled down to 1080p, and a tab of unknown size at 1080p', () => {
    const large = fakeRecorder(true, {
      video: true,
      canvas: true,
      display: sharedScreen({ width: 3840, height: 2400 }).stream,
    });
    large.recorder.start();
    expect(large.canvases).toEqual([{ width: 1728, height: 1080 }]);
    const unknown = fakeRecorder(true, { video: true, canvas: true, display: sharedScreen({}).stream });
    unknown.recorder.start();
    expect(unknown.canvases).toEqual([{ width: 1920, height: 1080 }]);
  });

  it('stops when the person stops sharing from the browser, and lets the screen go when it stops', async () => {
    const screen = sharedScreen();
    const { recorder, tab } = fakeRecorder(true, { video: true, canvas: true, display: screen.stream });
    const ended = vi.fn();
    recorder.onScreenEnded = ended;
    recorder.start();
    screen.track.end();
    expect(ended).toHaveBeenCalledOnce();
    await expect(recorder.stop()).rejects.toThrow('Nothing was recorded.');
    expect(screen.track.stop).toHaveBeenCalled();
    expect(tab.srcObject).toBeNull();
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
    // Fewer bits than a shared tab: a phone holds the whole take in memory.
    expect(recorded[0]?.options).toMatchObject({ videoBitsPerSecond: 1_000_000 });
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
